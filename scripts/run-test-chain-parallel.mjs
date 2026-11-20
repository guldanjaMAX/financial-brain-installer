#!/usr/bin/env node
/**
 * Parallel runner for the ordered `npm test` chain (scripts/run-test-chain.mjs).
 *
 * WHY. The serial chain runs ~714 commands one after another: about 100 minutes
 * on a quiet Windows box and 4-5 hours on a loaded laptop. Most commands are
 * independent, so a many-core machine can run them side by side, but only if the
 * pass/fail set stays IDENTICAL to the serial chain. Everything here serves that.
 *
 * HOW.
 *   1. Read the exact ordered command list from <root>/scripts/run-test-chain.mjs
 *      and validate every command with that module's own parser.
 *   2. Split it into a PARALLEL part and a SERIAL part. SERIAL_RULES (below) name
 *      the test files that must run alone, each with its reason. A command is
 *      serial when any of its test files is named there.
 *   3. Run the parallel part in N worker slots, longest-first when a timings file
 *      is given. Each parallel command gets its own TMPDIR/TEMP/TMP and a private
 *      HOME/USERPROFILE seeded with copies of the real home's .gitconfig/.npmrc.
 *   4. Then run the serial part one command at a time, in chain order, with the
 *      unmodified serial-chain environment (no private temp or home).
 *   5. Record exit code, signal, duration and the last 60 output lines of every
 *      failure; print the serial chain's own summary lines plus wall time; write
 *      results.json; optionally diff the pass/fail set against a serial log.
 *
 * It never edits the checkout, never pushes, and makes no network or Brain calls
 * of its own. Tests that write inside the checkout still do so; the end-of-run
 * audit lists any residue they leave.
 *
 * Usage (from the checkout under test, so npm sets npm_execpath and PATH exactly
 * as `npm test` would):
 *   npm exec -c "node scripts/run-test-chain-parallel.mjs --workers 20"
 * Or with the runner kept outside the checkout:
 *   node run-test-chain-parallel.mjs --root C:\lanes\par-chain\repo --workers 20
 * Plan only:     node scripts/run-test-chain-parallel.mjs --plan
 * Compare only:  node scripts/run-test-chain-parallel.mjs --compare serial.log --against results.json
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const OUTPUT_TAIL_LINES = 60;
export const RESULTS_SCHEMA = "parallel-test-chain-v1";

/**
 * Test files whose commands must run alone, after the parallel part. Matching is
 * by test file path, so a flag change on the command line keeps the rule. A rule
 * that matches no command is reported (the chain drifted); the node:test file
 * asserts every rule matches the current chain.
 */
export const SERIAL_RULES = Object.freeze([
  // Wall-clock budgets asserted as upper bounds. Load from neighbours can push
  // them over (11-09: 102.959 ms against a 100 ms budget at load 66 restarted a
  // 4-5 h release chain).
  { file: "worker/test/documents-summary-scale.test.mjs", kind: "timing", reason: "asserts hot summary statements finish in <= 100 ms" },
  { file: "worker/test/source-inventory-scale.test.mjs", kind: "timing", reason: "asserts per-document millisecond budgets on full-size SQLite scans" },
  { file: "worker/test/money-query.test.mjs", kind: "timing", reason: "asserts duplicate query < 10 s and caller/snapshot < 5 s; its MCP pair spawns children with 5-8 s timeouts" },
  { file: "test/setup-secrets-write-timeout.test.mjs", kind: "timing", reason: "asserts the secret-write timeout path ends in < 5 s" },
  { file: "test/vector-delete-outbox.test.mjs", kind: "timing", reason: "asserts backlog and readiness reads < 1 s on a 1.15M-row fixture" },
  { file: "test/d1-family-inventory-index.test.mjs", kind: "timing+checkout-write", reason: "250k-row benchmark that writes .lane-d1inv/benchmark.json inside the checkout" },
  // Whole-checkout inventories. Parallel tests create untracked scratch inside
  // the checkout (.machine-prep-*, .tmp-mcp-search-*), which these would see.
  { file: "test/package-privacy.test.mjs", kind: "package+checkout-scan", reason: "npm pack --dry-run plus a content scan of every tracked and untracked non-ignored file in the checkout" },
  { file: "test/test-chain-complete.test.mjs", kind: "checkout-scan", reason: "git ls-files --others over the checkout must see only real candidate test files" },
  // Real npm package builds and installs, or a real frontend build.
  { file: "test/package-bundle-verifier.test.mjs", kind: "package", reason: "real npm pack of the checkout plus npm-cache bundle verification" },
  { file: "test/packed-fresh-setup.test.mjs", kind: "package", reason: "real npm pack and install of the checkout with spawn timeouts" },
  { file: "test/upgrade-verify.test.mjs", kind: "package+timing", reason: "real npm pack/install against a 60 s reviewed baseline; process.chdir; elapsed diagnostics" },
  { file: "test/cloudflare-recovery-adapter.test.mjs", kind: "package", reason: "real npm pack of the checkout; asserts the exact archive name and entry count" },
  { file: "test/recovery-adapter-multipart-run-1114.test.mjs", kind: "package", reason: "imports cloudflare-recovery-adapter.test.mjs, so it repeats that real npm pack" },
  { file: "test/provenance-target-brain-adapter.test.mjs", kind: "package", reason: "npm pack --dry-run inventory of the checkout must equal the runtime inventory" },
  { file: "test/frontend-build-idempotence.test.mjs", kind: "build", reason: "real Vite build of the frontend with a 300 s timeout; byte-identical bundle check" },
  { file: "test/windows-keyring-real.test.mjs", kind: "package", reason: "opt-in gate that runs a real npm install and the OS credential store" },
]);

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

/** Test files a chain command runs. The npm command maps to its script name. */
export function commandFiles(command) {
  const words = String(command).split(" ");
  if (words[0] === "npm") return [`npm:${words.slice(1).join(" ")}`];
  return words.slice(1).filter((word) => !word.startsWith("--"));
}

export function classifyCommands(commands, rules = SERIAL_RULES) {
  const used = new Set();
  const rows = commands.map((command, index) => {
    const files = commandFiles(command);
    const matched = rules.filter((rule) => files.includes(rule.file));
    for (const rule of matched) used.add(rule.file);
    return Object.freeze({
      index, command, files,
      serial: matched.length > 0,
      reasons: Object.freeze(matched.map((rule) => `${rule.file}: ${rule.reason}`)),
    });
  });
  return Object.freeze({
    rows: Object.freeze(rows),
    unmatchedRules: Object.freeze(rules.filter((rule) => !used.has(rule.file)).map((rule) => rule.file)),
  });
}

/** Map command -> duration ms from our results.json or an array of {command, ms|durationMs}. */
export function timingsFrom(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : [];
  const out = new Map();
  for (const row of rows) {
    const ms = Number.isFinite(row?.durationMs) ? row.durationMs : Number.isFinite(row?.ms) ? row.ms : null;
    if (typeof row?.command === "string" && ms !== null && ms >= 0) out.set(row.command, ms);
  }
  return out;
}

const fileKey = (command) => commandFiles(command).slice().sort().join(" ");

/**
 * Parallel part: longest estimate first (classic LPT, which bounds the makespan
 * by the longest single command when there are enough slots); ties and unknown
 * estimates keep chain order. Serial part: chain order, so any dependency the
 * serial chain has between two serial commands is preserved.
 */
export function planSchedule(commands, { rules = SERIAL_RULES, timings = new Map(), only = null } = {}) {
  const { rows, unmatchedRules } = classifyCommands(commands, rules);
  const byFiles = new Map();
  for (const [command, ms] of timings) byFiles.set(fileKey(command), ms);
  const known = [];
  const estimateOf = (command) => {
    if (timings.has(command)) return timings.get(command);
    const key = fileKey(command);
    return byFiles.has(key) ? byFiles.get(key) : null;
  };
  for (const row of rows) {
    const estimate = estimateOf(row.command);
    if (estimate !== null) known.push(estimate);
  }
  known.sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 0;
  const selected = rows
    .filter((row) => !only || only.test(row.command))
    .map((row) => {
      const estimate = estimateOf(row.command);
      return Object.freeze({ ...row, estimateMs: estimate ?? fallback, estimated: estimate === null });
    });
  const parallel = selected.filter((row) => !row.serial)
    .sort((a, b) => (b.estimateMs - a.estimateMs) || (a.index - b.index));
  const serial = selected.filter((row) => row.serial).sort((a, b) => a.index - b.index);
  return Object.freeze({
    total: commands.length,
    selected: selected.length,
    parallel: Object.freeze(parallel),
    serial: Object.freeze(serial),
    unmatchedRules,
  });
}

/** Run items with at most `workers` in flight. runOne(item, slot) returns a promise. */
export async function runPool(items, { workers, runOne, shouldStop = () => false }) {
  if (!Number.isInteger(workers) || workers < 1) throw new TypeError("workers must be a positive integer");
  const results = new Array(items.length);
  let next = 0;
  const freeSlots = Array.from({ length: Math.min(workers, items.length) }, (_, slot) => slot);
  await new Promise((resolveAll, rejectAll) => {
    let running = 0;
    const launch = () => {
      while (freeSlots.length && next < items.length && !shouldStop()) {
        const position = next++;
        const slot = freeSlots.shift();
        running++;
        Promise.resolve()
          .then(() => runOne(items[position], slot))
          .then((result) => {
            results[position] = result;
            running--;
            freeSlots.push(slot);
            launch();
          }, rejectAll);
      }
      if (running === 0) resolveAll();
    };
    launch();
  });
  return results;
}

/** Parallel part on N slots, then serial part on one slot. */
export async function executePlan(plan, { workers, runOne, shouldStop = () => false }) {
  const parallel = await runPool(plan.parallel, { workers, shouldStop, runOne: (row, slot) => runOne(row, { phase: "parallel", slot }) });
  const serial = await runPool(plan.serial, { workers: 1, shouldStop, runOne: (row) => runOne(row, { phase: "serial", slot: 0 }) });
  return { parallel: parallel.filter(Boolean), serial: serial.filter(Boolean) };
}

export function tailLines(text, count = OUTPUT_TAIL_LINES) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
}

export function failureLabel({ code, signal, timedOut, spawnError }) {
  if (timedOut) return `timeout${signal ? ` ${signal}` : ""}`;
  if (spawnError) return "could not start";
  if (signal) return `signal ${signal}`;
  return `exit ${code}`;
}

const FAIL_LINE = /(?:^|\s)test (\d+)\/(\d+) failed \((.+?)\): ((?:node|npm) .+)$/;
const DONE_OK = /test chain complete: (\d+)\/(\d+) commands passed/;
const DONE_FAIL = /test chain failed: (\d+) of (\d+) attempted commands failed/;
const CONFIG_ERROR = /test chain configuration error: (.*)$/;

/** Read a serial `npm test` log (or this runner's own stdout). */
export function parseChainLog(text) {
  const failures = new Map();
  let total = null;
  let summary = null;
  let configError = null;
  let lastIndex = 0;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      const index = Number(fail[1]) - 1;
      total = Number(fail[2]);
      lastIndex = Math.max(lastIndex, index + 1);
      failures.set(index, { command: fail[4], label: fail[3] });
      continue;
    }
    const ok = DONE_OK.exec(line);
    if (ok) { summary = { attempted: Number(ok[1]), total: Number(ok[2]), failed: 0 }; continue; }
    const bad = DONE_FAIL.exec(line);
    if (bad) { summary = { attempted: Number(bad[2]), failed: Number(bad[1]), total: null }; continue; }
    const config = CONFIG_ERROR.exec(line);
    if (config) configError = config[1];
  }
  if (summary && summary.total === null) summary.total = total;
  return Object.freeze({
    complete: Boolean(summary) && !configError,
    configError,
    attempted: summary?.attempted ?? null,
    total: summary?.total ?? total,
    lastFailedPosition: lastIndex,
    failures,
  });
}

/**
 * Outcomes as Map(command -> "pass" | "fail") from a serial log, this runner's
 * results.json, or an array of {command, status} rows. Returns notes about
 * coverage so a partial baseline is never mistaken for a full one.
 */
export function outcomesFrom(source, chainCommands) {
  const notes = [];
  const outcomes = new Map();
  let parsed = null;
  try { parsed = JSON.parse(source); } catch { parsed = null; }
  if (parsed && (Array.isArray(parsed) || Array.isArray(parsed.results))) {
    const rows = Array.isArray(parsed) ? parsed : parsed.results;
    let skipped = 0;
    for (const row of rows) {
      if (typeof row?.command !== "string") continue;
      if (row.outcome === "pass" || row.outcome === "fail") outcomes.set(row.command, row.outcome);
      else if (Number.isInteger(row.status)) outcomes.set(row.command, row.status === 0 ? "pass" : "fail");
      else if (Number.isInteger(row.code) || row.signal) outcomes.set(row.command, row.code === 0 && !row.signal ? "pass" : "fail");
      else skipped++;
    }
    if (skipped) notes.push(`${skipped} row(s) had no outcome (not run) and were left out`);
    return { outcomes, notes, kind: "json" };
  }
  const log = parseChainLog(source);
  if (log.configError) throw new Error(`the serial log ended in a configuration error: ${log.configError}`);
  if (!log.complete) {
    throw new Error(`the serial log has no final summary line, so the chain did not finish (last failure reported at test ${log.lastFailedPosition}/${log.total ?? "?"})`);
  }
  const sameChain = log.total === chainCommands.length;
  for (const [index, failure] of log.failures) {
    if (sameChain && chainCommands[index] !== failure.command) {
      notes.push(`serial position ${index + 1} names a different command than this chain: ${failure.command}`);
    }
    outcomes.set(failure.command, "fail");
  }
  const attempted = log.attempted ?? 0;
  let covered;
  if (sameChain) {
    covered = chainCommands.slice(0, attempted);
    if (attempted < chainCommands.length) notes.push(`the serial run attempted only ${attempted}/${chainCommands.length} commands (stopped early without --continue-on-failure); only those are compared`);
  } else if (attempted === log.total) {
    covered = chainCommands;
    notes.push(`the serial log covers a ${log.total}-command chain and this chain has ${chainCommands.length}; failures are matched by command text and every other command of this chain is read as a serial pass, including commands that chain may not have had`);
  } else {
    covered = [];
    notes.push(`the serial log covers a different ${log.total}-command chain and stopped after ${attempted}; its positions cannot be mapped, so only its ${log.failures.size} failure(s) are compared`);
  }
  for (const command of covered) if (!outcomes.has(command)) outcomes.set(command, "pass");
  return { outcomes, notes, kind: "serial-log", attempted, total: log.total };
}

export function compareOutcomes(baseline, candidate) {
  const newFailures = [];
  const newPasses = [];
  const onlyBaseline = [];
  const onlyCandidate = [];
  let common = 0;
  for (const [command, outcome] of baseline) {
    if (!candidate.has(command)) { onlyBaseline.push(command); continue; }
    common++;
    const other = candidate.get(command);
    if (outcome === "pass" && other === "fail") newFailures.push(command);
    if (outcome === "fail" && other === "pass") newPasses.push(command);
  }
  for (const command of candidate.keys()) if (!baseline.has(command)) onlyCandidate.push(command);
  return Object.freeze({
    common,
    identical: newFailures.length === 0 && newPasses.length === 0,
    newFailures, newPasses, onlyBaseline, onlyCandidate,
  });
}

export function parseArguments(argv) {
  const options = {
    root: null, workers: Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 4),
    plan: false, compare: null, against: null, timings: null, out: null, scratch: null,
    home: "private", serialFile: null, only: null, commandTimeoutMinutes: 45, keepTemp: false,
    failFast: false, npmExecPath: null, changedSince: null, areas: null,
  };
  const value = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} needs a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--root": options.root = resolve(value(i, flag)); i++; break;
      case "--workers": {
        const n = Number(value(i, flag)); i++;
        if (!Number.isInteger(n) || n < 1 || n > 256) throw new TypeError("--workers must be an integer from 1 to 256");
        options.workers = n; break;
      }
      case "--plan": options.plan = true; break;
      case "--compare": options.compare = resolve(value(i, flag)); i++; break;
      case "--against": options.against = resolve(value(i, flag)); i++; break;
      case "--timings": options.timings = resolve(value(i, flag)); i++; break;
      case "--out": options.out = resolve(value(i, flag)); i++; break;
      case "--scratch": options.scratch = resolve(value(i, flag)); i++; break;
      case "--home": {
        const mode = value(i, flag); i++;
        if (!["private", "real"].includes(mode)) throw new TypeError("--home must be private or real");
        options.home = mode; break;
      }
      case "--serial-file": options.serialFile = resolve(value(i, flag)); i++; break;
      case "--changed-since": options.changedSince = value(i, flag); i++; break;
      case "--areas": options.areas = resolve(value(i, flag)); i++; break;
      case "--only": options.only = new RegExp(value(i, flag)); i++; break;
      case "--command-timeout": {
        const minutes = Number(value(i, flag)); i++;
        if (!Number.isFinite(minutes) || minutes < 0) throw new TypeError("--command-timeout must be minutes >= 0 (0 = none)");
        options.commandTimeoutMinutes = minutes; break;
      }
      case "--keep-temp": options.keepTemp = true; break;
      case "--fail-fast": options.failFast = true; break;
      case "--continue-on-failure": break; // accepted for drop-in use; the parallel runner always continues
      case "--npm-execpath": options.npmExecPath = resolve(value(i, flag)); i++; break;
      default: throw new TypeError(`unknown option: ${flag}`);
    }
  }
  if (options.against && !options.compare) throw new TypeError("--against needs --compare <baseline>");
  if (options.changedSince !== null && (!options.changedSince || options.changedSince.startsWith("-"))) throw new TypeError("--changed-since needs a git reference");
  if (options.changedSince && (options.only || options.against)) throw new TypeError("cannot combine --changed-since with --only or --against");
  if (options.areas && !options.changedSince) throw new TypeError("--areas needs --changed-since");
  return Object.freeze(options);
}

/** Extra serial rules from a file: one test path per line, optional "# reason". */
export function parseSerialFile(text) {
  const rules = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const [file, ...reason] = line.split("#");
    rules.push({ file: file.trim(), kind: "extra", reason: reason.join("#").trim() || "listed in --serial-file" });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Process and filesystem plumbing

function setEnv(env, key, value) {
  if (process.platform === "win32") {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
  }
  env[key] = value;
}

function getEnv(env, key) {
  if (process.platform !== "win32") return env[key];
  const found = Object.keys(env).find((existing) => existing.toUpperCase() === key.toUpperCase());
  return found ? env[found] : undefined;
}

function resolveNpmExecPath(explicit) {
  if (explicit) return explicit;
  if (process.env.npm_execpath && isAbsolute(process.env.npm_execpath)) return process.env.npm_execpath;
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) if (existsSync(candidate)) return resolve(candidate);
  return null;
}

/** npm prepends every ancestor's node_modules/.bin for scripts; mirror it when launched directly. */
function npmLikePath(root, currentPath) {
  const bins = [];
  let dir = resolve(root);
  for (;;) {
    bins.push(join(dir, "node_modules", ".bin"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const separator = process.platform === "win32" ? ";" : ":";
  return [...bins, currentPath].filter(Boolean).join(separator);
}

function readTail(path, count = OUTPUT_TAIL_LINES) {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return tailLines(buffer.toString("utf8"), count);
  } catch {
    return [];
  }
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Bounded listing: relative path -> "size:mtime". */
function snapshotTree(root, { limit = 5000, depth = 8 } = {}) {
  const entries = new Map();
  if (!root || !existsSync(root)) return entries;
  const walk = (dir, level) => {
    if (entries.size >= limit || level > depth) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (entries.size >= limit) return;
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      entries.set(relative(root, path), stat.isDirectory() ? "dir" : `${stat.size}:${Math.round(stat.mtimeMs)}`);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, level + 1);
    }
  };
  walk(root, 0);
  return entries;
}

function diffSnapshots(before, after, cap = 50) {
  const added = []; const changed = []; const removed = [];
  for (const [path, value] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== value && value !== "dir") changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { added: added.slice(0, cap), changed: changed.slice(0, cap), removed: removed.slice(0, cap),
    counts: { added: added.length, changed: changed.length, removed: removed.length } };
}

function gitResidue(root) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return new Set(result.stdout.split("\0").filter(Boolean));
}

function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function defaultLockRoot() {
  if (process.env.BRAIN_LIFECYCLE_LOCK_ROOT) return null; // injected; not machine-wide
  if (process.platform === "win32") {
    const programData = getEnv(process.env, "ProgramData");
    return programData ? join(programData, "FinancialBrain", "locks") : null;
  }
  return "/tmp/financial-brain-lifecycle-v1";
}

const HOME_SEED_FILES = Object.freeze([".gitconfig", ".npmrc"]);

function seedPrivateHome(home, realHome) {
  mkdirSync(home, { recursive: true });
  const seeded = [];
  for (const name of HOME_SEED_FILES) {
    const source = realHome ? join(realHome, name) : null;
    if (source && existsSync(source) && statSync(source).isFile()) {
      copyFileSync(source, join(home, name));
      seeded.push(name);
    }
  }
  return seeded;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// CLI

async function loadChain(root) {
  const modulePath = join(root, "scripts", "run-test-chain.mjs");
  if (!existsSync(modulePath)) throw new Error(`no serial chain at ${modulePath}`);
  const chain = await import(pathToFileURL(modulePath).href);
  if (!Array.isArray(chain.TEST_COMMANDS) || typeof chain.parseTestCommand !== "function") {
    throw new Error("the serial chain module does not export TEST_COMMANDS and parseTestCommand");
  }
  for (const command of chain.TEST_COMMANDS) chain.parseTestCommand(command);
  return chain;
}

function compareAndReport(baselinePath, candidateSource, commands, log) {
  const baseline = outcomesFrom(readFileSync(baselinePath, "utf8"), commands);
  const candidate = outcomesFrom(candidateSource, commands);
  const diff = compareOutcomes(baseline.outcomes, candidate.outcomes);
  log(`compare: baseline ${basename(baselinePath)} (${baseline.kind}, ${baseline.outcomes.size} commands) vs candidate (${candidate.kind}, ${candidate.outcomes.size} commands)`);
  for (const note of [...baseline.notes.map((n) => `baseline: ${n}`), ...candidate.notes.map((n) => `candidate: ${n}`)]) log(`compare note: ${note}`);
  log(`compare: ${diff.common} commands in both; ${diff.identical ? "IDENTICAL pass/fail set" : "DIFFERENT pass/fail set"}`);
  for (const command of diff.newFailures) log(`  fails only in candidate: ${command}`);
  for (const command of diff.newPasses) log(`  passes only in candidate: ${command}`);
  if (diff.onlyBaseline.length) log(`  ${diff.onlyBaseline.length} command(s) only in baseline${diff.onlyBaseline.length <= 10 ? `: ${diff.onlyBaseline.join(" | ")}` : ""}`);
  if (diff.onlyCandidate.length) log(`  ${diff.onlyCandidate.length} command(s) only in candidate${diff.onlyCandidate.length <= 10 ? `: ${diff.onlyCandidate.join(" | ")}` : ""}`);
  return diff;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(options.root || HERE_ROOT);
  const chain = await loadChain(root);
  const commands = chain.TEST_COMMANDS;
  const total = commands.length;

  if (options.against) {
    const diff = compareAndReport(options.compare, readFileSync(options.against, "utf8"), commands, console.log);
    process.exitCode = diff.identical ? 0 : 1;
    return;
  }

  const rules = [...SERIAL_RULES, ...(options.serialFile ? parseSerialFile(readFileSync(options.serialFile, "utf8")) : [])];
  const timings = options.timings ? timingsFrom(JSON.parse(readFileSync(options.timings, "utf8"))) : new Map();
  let areas;
  if (options.areas) {
    try { areas = JSON.parse(readFileSync(options.areas, "utf8")); } catch { areas = null; }
  }
  const { pickChangedTests, selectionMatcher } = options.changedSince ? await import("../ci/pick-tests.mjs") : {};
  const selection = options.changedSince ? await pickChangedTests({ root, ref: options.changedSince, areas }) : null;
  if (selection) {
    console.log("section run, not a release verdict");
    for (const note of selection.notes) console.log(`picker: ${note}`);
  }
  const plan = planSchedule(commands, { rules, timings, only: selection ? selectionMatcher(selection) : options.only });

  if (options.plan) {
    console.log(`plan: ${plan.selected}/${total} commands; ${plan.parallel.length} parallel on ${options.workers} workers, ${plan.serial.length} serial after`);
    for (const row of plan.parallel) console.log(`  P ${String(row.index + 1).padStart(3)} ~${formatDuration(row.estimateMs)}${row.estimated ? "?" : ""} ${row.command}`);
    for (const row of plan.serial) console.log(`  S ${String(row.index + 1).padStart(3)} ~${formatDuration(row.estimateMs)}${row.estimated ? "?" : ""} ${row.command}\n        ${row.reasons.join("\n        ")}`);
    if (plan.unmatchedRules.length) console.log(`plan: serial rules matching no command: ${plan.unmatchedRules.join(", ")}`);
    return;
  }

  // Environment: exactly what `npm test` gives the serial chain, plus the two
  // chain variables from the chain's own isolatedTestEnvironment().
  const launchedByNpm = Boolean(process.env.npm_execpath && process.env.npm_command);
  const npmExecPath = resolveNpmExecPath(options.npmExecPath);
  const needsNpm = plan.parallel.concat(plan.serial).some((row) => row.command.startsWith("npm "));
  if (needsNpm && !npmExecPath) throw new Error("npm_execpath is required for the npm test:eval command; launch through `npm exec -c` or pass --npm-execpath");
  const baseEnv = { ...process.env };
  if (npmExecPath) setEnv(baseEnv, "npm_execpath", npmExecPath);
  if (!launchedByNpm) setEnv(baseEnv, "PATH", npmLikePath(root, getEnv(baseEnv, "PATH")));
  const serialEnv = typeof chain.isolatedTestEnvironment === "function"
    ? { ...chain.isolatedTestEnvironment(baseEnv) }
    : { ...baseEnv, BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_CHAIN: "1" };
  const realHome = os.homedir();

  // Per-command temp and home folders stay short (<scratch>\fbpXXXX\NNN\t) so
  // Windows path-length behaviour stays close to the serial chain's own TEMP.
  const scratch = options.scratch || os.tmpdir();
  const runName = `fbp${Math.random().toString(16).slice(2, 6)}`;
  const runDir = join(scratch, runName);
  const outDir = options.out || join(scratch, `${runName}-out`);
  const logDir = join(outDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const timeoutMs = options.commandTimeoutMinutes > 0 ? options.commandTimeoutMinutes * 60_000 : 0;

  const audit = {
    lockRoot: defaultLockRoot(),
    homeBrain: join(realHome, ".brain"),
  };
  const before = {
    residue: gitResidue(root),
    lockRoot: snapshotTree(audit.lockRoot),
    homeBrain: snapshotTree(audit.homeBrain),
  };

  const running = new Set();
  let stopping = false;
  let anyFailure = false;
  const started = Date.now();
  const phaseTimes = { parallel: [null, null], serial: [null, null] };
  const onSignal = (signal) => {
    stopping = true;
    console.error(`parallel chain: ${signal}; stopping ${running.size} running command(s)`);
    for (const child of running) killTree(child);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log(`parallel chain: ${plan.selected}/${total} commands from ${root}${options.only ? ` (filter ${options.only})` : ""}`);
  if (resolve(root) === resolve(HERE_ROOT)) {
    // scripts/ is in the package allowlist, so this file is itself an
    // unreviewed package file to test/package-privacy.test.mjs.
    console.log("parallel chain: note: this runner sits inside the checkout under test, so package-privacy reports it as an unreviewed package file; for a candidate comparison keep the runner outside and pass --root <pristine checkout>");
  }
  console.log(`parallel chain: ${plan.parallel.length} parallel on ${options.workers} workers, then ${plan.serial.length} serial; home ${options.home}; logs ${logDir}`);

  const runOne = (row, { phase, slot }) => new Promise((resolveRun) => {
    if (!phaseTimes[phase][0]) phaseTimes[phase][0] = Date.now();
    const parsed = chain.parseTestCommand(row.command);
    const args = parsed.kind === "node" ? [...parsed.args] : [npmExecPath, ...parsed.args];
    const position = String(row.index + 1).padStart(3, "0");
    const logPath = join(logDir, `${position}.log`);
    let env = serialEnv;
    let commandDir = null;
    let seeded = [];
    if (phase === "parallel") {
      commandDir = join(runDir, position);
      const temp = join(commandDir, "t");
      mkdirSync(temp, { recursive: true });
      env = { ...serialEnv };
      for (const key of ["TMPDIR", "TEMP", "TMP"]) setEnv(env, key, temp);
      if (options.home === "private") {
        const home = join(commandDir, "h");
        seeded = seedPrivateHome(home, realHome);
        // Windows: os.homedir() reads USERPROFILE. HOME is replaced only when the
        // serial environment already has one, so no new variable appears.
        if (process.platform === "win32") {
          setEnv(env, "USERPROFILE", home);
          if (getEnv(env, "HOME") !== undefined) setEnv(env, "HOME", home);
        } else {
          setEnv(env, "HOME", home);
        }
      }
    }
    const fd = openSync(logPath, "w");
    const begin = Date.now();
    let child;
    let timedOut = false;
    let timer = null;
    let settled = false;
    const finish = ({ code = null, signal = null, spawnError = null }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      running.delete(child);
      const end = Date.now();
      const ok = !spawnError && !timedOut && code === 0 && !signal;
      let homeWrites = [];
      if (commandDir && options.home === "private") {
        homeWrites = [...snapshotTree(join(commandDir, "h"), { limit: 200 }).keys()]
          .filter((path) => !seeded.includes(path)).slice(0, 20);
      }
      if (commandDir && !options.keepTemp) {
        try { rmSync(commandDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* reported by residue audit if it matters */ }
      }
      const result = {
        index: row.index, command: row.command, phase, slot,
        serialReasons: row.reasons, estimateMs: row.estimateMs,
        startMs: begin - started, endMs: end - started, durationMs: end - begin,
        code, signal, timedOut, spawnError: spawnError ? String(spawnError.code || spawnError.message) : null,
        outcome: ok ? "pass" : "fail",
        label: ok ? null : failureLabel({ code, signal, timedOut, spawnError }),
        log: logPath,
        tail: ok ? [] : readTail(logPath),
        homeWrites,
      };
      if (!ok) {
        anyFailure = true;
        console.error(`test ${row.index + 1}/${total} failed (${result.label}): ${row.command}`);
      }
      resolveRun(result);
    };
    try {
      child = spawn(process.execPath, args, {
        cwd: root, env, stdio: ["ignore", fd, fd], shell: false, windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      closeSync(fd);
      finish({ spawnError: error });
      return;
    }
    closeSync(fd);
    running.add(child);
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.once("error", (error) => finish({ spawnError: error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  }).then((result) => {
    phaseTimes[phase][1] = Date.now();
    return result;
  });

  const executed = await executePlan(plan, {
    workers: options.workers,
    runOne,
    shouldStop: () => stopping || (options.failFast && anyFailure),
  });
  const wallMs = Date.now() - started;
  const results = [...executed.parallel, ...executed.serial].sort((a, b) => a.index - b.index);
  const failures = results.filter((result) => result.outcome === "fail");

  const after = {
    residue: gitResidue(root),
    lockRoot: snapshotTree(audit.lockRoot),
    homeBrain: snapshotTree(audit.homeBrain),
  };
  const residue = before.residue && after.residue ? [...after.residue].filter((entry) => !before.residue.has(entry)) : null;
  const span = ([a, b]) => (a && b ? b - a : 0);
  const report = {
    schema: RESULTS_SCHEMA,
    ...(selection ? { certifies: false, mode: "section", selection } : {}),
    root, head: gitHead(root), node: process.version, platform: process.platform, arch: process.arch,
    cpus: os.availableParallelism?.() ?? os.cpus().length, workers: options.workers,
    startedAt: new Date(started).toISOString(), wallMs,
    parallelMs: span(phaseTimes.parallel), serialMs: span(phaseTimes.serial),
    env: { launchedByNpm, npmExecPath, scratch, home: options.home, commandTimeoutMinutes: options.commandTimeoutMinutes },
    total, selected: plan.selected, attempted: results.length,
    passed: results.length - failures.length, failed: failures.length,
    serialRules: rules, serialRulesUnmatched: plan.unmatchedRules,
    audit: {
      checkoutResidue: residue,
      lockRoot: audit.lockRoot ? { path: audit.lockRoot, ...diffSnapshots(before.lockRoot, after.lockRoot) } : null,
      realHomeBrain: { path: audit.homeBrain, ...diffSnapshots(before.homeBrain, after.homeBrain) },
      privateHomeWriters: results.filter((r) => r.homeWrites.length).map((r) => ({ index: r.index, command: r.command, homeWrites: r.homeWrites })),
    },
    results,
  };
  const resultsPath = join(outDir, "results.json");
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.keepTemp) {
    try { rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* scratch only */ }
  }

  // Same summary shape as scripts/run-test-chain.mjs.
  if (!failures.length && results.length === plan.selected) {
    console.log(`test chain complete: ${results.length}/${plan.selected} commands passed`);
  } else {
    console.error(`test chain failed: ${failures.length} of ${results.length} attempted commands failed`);
    for (const failure of failures) console.error(`  ${failure.index + 1}. ${failure.command} (${failure.label})`);
  }
  console.log(`wall time: ${formatDuration(wallMs)} (parallel ${formatDuration(report.parallelMs)} on ${options.workers} workers for ${plan.parallel.length} commands, serial ${formatDuration(report.serialMs)} for ${plan.serial.length} commands)`);
  if (residue?.length) console.log(`audit: ${residue.length} new untracked/modified path(s) left in the checkout: ${residue.slice(0, 10).join(" | ")}`);
  if (report.audit.lockRoot?.counts.added) console.log(`audit: ${report.audit.lockRoot.counts.added} new entr(ies) in the machine lifecycle lock root ${audit.lockRoot}`);
  if (report.audit.realHomeBrain.counts.added || report.audit.realHomeBrain.counts.changed) console.log(`audit: the real ${audit.homeBrain} changed (${JSON.stringify(report.audit.realHomeBrain.counts)})`);
  if (report.audit.privateHomeWriters.length) console.log(`audit: ${report.audit.privateHomeWriters.length} command(s) wrote into their private home (see results.json audit.privateHomeWriters)`);
  console.log(`results: ${resultsPath}`);

  let compareExit = 0;
  if (options.compare) {
    const diff = compareAndReport(options.compare, JSON.stringify(report), commands, console.log);
    compareExit = diff.identical ? 0 : 1;
  }
  process.exitCode = failures.length || compareExit ? 1 : 0;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`test chain configuration error: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 2;
  });
}
