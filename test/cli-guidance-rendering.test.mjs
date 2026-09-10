import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  brainCliPrefix,
  commandPath,
  renderCliCommands,
  renderDiagnosis,
  renderLoadReport,
} from "../brain.mjs";
import { printGuidance, resetCliPrefixCache } from "../operations/cli-guidance.mjs";
import { renderReportHtml } from "../report-html.mjs";
import {
  renderTechnicianPlan,
  technicianPlan,
} from "../operations/technician-setup.mjs";
import {
  renderSupportRecovery,
  supportRecovery,
} from "../support-recovery.mjs";

// PATH and existsSync are pinned, not inherited. Every expectation built on
// this fixture is the ABSOLUTE form, and a developer machine that happened to
// carry a `brain.cmd` would otherwise flip it to the short one under them.
const windows = {
  platform: "win32",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  scriptPath: "C:\\Users\\client\\AppData\\Local\\FinancialBrain\\node_modules\\brain-installer\\brain.mjs",
  env: { PATH: "" },
  existsSync: () => false,
};
const prefix = brainCliPrefix(windows);
const productRoot = new URL("../", import.meta.url);

/*
 * The command vocabulary is READ FROM THE RENDERER, never written out here.
 *
 * This used to be a hand-written list of eleven subcommands against a renderer
 * that knows forty. `zone`, `devices`, `load`, `connect`, `sources`, `grant`,
 * `check`, `secrets`, `reindex` and twenty others were therefore unpoliced
 * everywhere in this suite: a bare `brain devices <manifest> --revoke ...`
 * could not fail any assertion in this file, and did not. Deriving the list
 * means the checks below can never cover less than the renderer claims to.
 */
const guidanceSource = readFileSync(new URL("operations/cli-guidance.mjs", productRoot), "utf8");
const alternation = guidanceSource.match(/const COMMAND = \/\\bbrain\(\?=\\s\+\(\?:([^)]+)\)\\b\)\//)?.[1];
assert.ok(alternation, "operations/cli-guidance.mjs no longer exposes a readable command alternation");
const SUBCOMMANDS = alternation.split("|");
const bareCommand = new RegExp(String.raw`\bbrain\s+(?:${alternation})\b`);
for (const covered of ["setup", "doctor", "update", "drain", "support", "technician", "eval", "grants", "forget", "mcp-config", "assistant-repair", "tools"]) {
  assert.ok(SUBCOMMANDS.includes(covered), `the renderer stopped covering \`brain ${covered}\``);
}

const supportText = renderCliCommands(
  renderSupportRecovery(supportRecovery("HEALTH_CHECK_FAILED")),
  windows,
);
assert.match(supportText, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(supportText, bareCommand);

const plan = technicianPlan("C:\\Users\\client\\Financial Brain\\brain.manifest.json", {
  existsSync: () => false,
  cli: { command: "/synthetic/node", args: ["/synthetic/brain.mjs"] },
});
const technicianText = renderCliCommands(renderTechnicianPlan(plan), windows);
assert.match(technicianText, /'--run' 'tools'/);
assert.equal(technicianText, renderTechnicianPlan(plan), 'existing structured technician commands remain byte-stable');
assert.doesNotMatch(technicianText, bareCommand);

const output = [];
const originalLog = console.log;
try {
  console.log = (...parts) => output.push(parts.join(" "));
  renderDiagnosis({
    totals: { documents: 1, chunks: 1, sources: 1 },
    findings: [{
      area: "integrity",
      severity: "crit",
      title: "Synthetic backlog",
      detail: "Fixture only",
      action: "Run brain drain C:\\fixture\\brain.manifest.json, then brain health C:\\fixture\\brain.manifest.json.",
    }],
    summary: { crit: 1, warn: 0 },
    verdict: "critical",
  }, windows);
} finally {
  console.log = originalLog;
}
assert.match(output.join("\n"), /Synthetic backlog/);
assert.doesNotMatch(output.join("\n"), bareCommand);

const incompleteOutput = [];
try {
  console.log = (...parts) => incompleteOutput.push(parts.join(" "));
  renderDiagnosis({
    complete: false,
    totals: { documents: 12, chunks: null, sources: 1 },
    findings: [{
      area: "meta", severity: "warn", observable: false,
      title: "The bounded chunk audit did not finish",
      action: "Run brain diagnose C:\\fixture\\brain.manifest.json again.",
    }],
    summary: { crit: 0, warn: 1, info: 0, ok: 0 },
    verdict: "usable_with_gaps",
  }, windows);
} finally {
  console.log = originalLog;
}
const incompleteText = incompleteOutput.join("\n");
assert.match(incompleteText, /not verified\s+chunks/);
assert.match(incompleteText, /did not finish.*cannot say the brain is clear/s);
assert.doesNotMatch(incompleteText, /nothing is missing, nothing is stored wrong/);

const optionalOutput = [];
try {
  console.log = (...parts) => optionalOutput.push(parts.join(" "));
  renderDiagnosis({
    complete: true,
    totals: { documents: 12, chunks: 12, sources: 1 },
    findings: [{
      area: "efficiency", severity: "info", observable: false,
      title: "Exact outlier measurement is not observable at this scale",
    }],
    summary: { crit: 0, warn: 0, info: 1, ok: 0 },
    verdict: "healthy",
  }, windows);
} finally {
  console.log = originalLog;
}
assert.match(optionalOutput.join("\n"), /not a claim that every efficiency check ran/);
assert.doesNotMatch(optionalOutput.join("\n"), /nothing is missing, nothing is stored wrong/);

const gapOutput = [];
try {
  console.log = (...parts) => gapOutput.push(parts.join(" "));
  renderDiagnosis({
    complete: true,
    totals: { documents: 12, chunks: 12, sources: 1 },
    findings: [{
      area: "integrity", severity: "warn",
      title: "Some meaning-search work is still settling",
    }],
    summary: { crit: 0, warn: 1, info: 0, ok: 0 },
    verdict: "usable_with_gaps",
  }, windows);
} finally {
  console.log = originalLog;
}
assert.match(gapOutput.join("\n"), /Some gaps can make answers incomplete/);
assert.doesNotMatch(gapOutput.join("\n"), /Nothing here makes an answer wrong/);

// These assertions bind the pure renderer checks above to the actual human
// output branches. Structured JSON deliberately stays byte-stable.
// Normalised, so a CRLF checkout cannot make the "\n"-anchored structural
// assertions below silently match nothing and report a table as missing.
// .gitattributes also pins this file to LF; this is the belt to that brace.
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(source, /: renderCliCommands\(renderSupportRecovery\(recovery\)\)\)/);
assert.match(source, /else console\.log\(renderCliCommands\(renderTechnicianPlan\(plan\)\)\)/);
assert.match(source, /if \(flags\.json\) console\.log\(JSON\.stringify\(plan, null, 2\)\)/);
assert.ok(!/node brain\.mjs forget/.test(source), "forget guidance cannot depend on a checkout working directory");
assert.ok(!/\$\{(?:x|item)\.fix\.split\("\\n"\)/.test(source), "doctor fixes must render Windows executable guidance");
assert.ok(!/\$\{f\.action\}/.test(source), "diagnose actions must render Windows executable guidance");

console.log("CLI guidance rendering: Windows human commands are executable and JSON stays canonical");

const unusual = { ...windows, nodePath: "C:\\Owner's $& folder\\node.exe", scriptPath: "C:\\$` and $' folder\\brain.mjs" };
const exact = brainCliPrefix(unusual);
assert.equal(renderCliCommands("brain update <manifest>", unusual), `${exact} update <manifest>`);
assert.equal(renderCliCommands(renderCliCommands("brain check <manifest>", unusual), unusual), `${exact} check <manifest>`);
assert.equal(renderCliCommands("brain update <manifest>", { platform: "darwin" }), "brain update <manifest>");
assert.equal(renderCliCommands("The brain stores records.", windows), "The brain stores records.");
assert.throws(() => brainCliPrefix({ ...windows, scriptPath: "bad\npath" }), /safe to display/);

const manifestWithMetacharacters = "C:\\Owner's $HOME folder\\brain.manifest.json";
assert.equal(commandPath(manifestWithMetacharacters, { platform: "win32" }), "'C:\\Owner''s $HOME folder\\brain.manifest.json'");
assert.equal(commandPath("owner's $HOME folder/brain.manifest.json", { platform: "darwin" }), "'owner'\"'\"'s $HOME folder/brain.manifest.json'");
assert.equal(commandPath("brain.manifest.json"), "brain.manifest.json");
for (const platform of ["darwin", "win32"]) {
  for (const value of ["bad\npath", "bad\rpath", "bad\tpath", "bad\u0000path", "bad\u007fpath"]) {
    assert.throws(() => commandPath(value, { platform }), /safe to display/);
  }
}

// Exercise the actual no-network CLI branch, rather than only its formatter.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "brain-guidance-path-")));
try {
  const directory = join(fixtureRoot, "Owner's $HOME folder");
  mkdirSync(directory, { mode: 0o700 });
  const manifest = join(directory, "brain.manifest.json");
  writeFileSync(manifest, "{}\n", { mode: 0o600 });
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: fixtureRoot, USERPROFILE: fixtureRoot, NO_COLOR: "1" });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../brain.mjs", import.meta.url)), "eval", manifest, "--init"], { cwd: fixtureRoot, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // The child runs in the canonical fixture root, so its copyable command
  // must use this exact relative target on every host, with shell metacharacters literal.
  const expected = renderCliCommands(`brain eval ${commandPath(join("Owner's $HOME folder", "brain.manifest.json"))}`);
  assert.ok(result.stdout.includes(expected), result.stdout);
  assert.ok(!/brain (?:forget|eval) \$\{(?:manifestPath|relative\()/.test(source), "concrete forget and eval paths must pass through commandPath");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

/* ==================================================== the dispatch contract */
/*
 * Every command the CLI can actually run must be a command the renderer knows.
 *
 * A subcommand missing from the alternation is invisible twice over: the
 * renderer walks past it, and so does every assertion in this file, so its
 * guidance ships bare on Windows with nothing to catch it. `reconcile` is the
 * standing example. Five user-facing strings name it and it is in neither the
 * alternation nor the dispatch table, so today it is unreachable dead code.
 * The day someone wires it up, this fails instead of shipping five bare
 * commands the same afternoon.
 */
const dispatchBlock = source.match(/\nconst commands = \{\n([\s\S]*?)\n\};\n/);
assert.ok(dispatchBlock, "brain.mjs no longer exposes a readable command dispatch table");
const dispatched = [...dispatchBlock[1].matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z][\w-]*)):/gm)].map((m) => m[1] ?? m[2]);
assert.ok(dispatched.length >= 39, `only ${dispatched.length} dispatch entries parsed from brain.mjs`);
for (const command of dispatched) {
  assert.ok(
    SUBCOMMANDS.includes(command),
    `\`brain ${command}\` is dispatchable but missing from the alternation in operations/cli-guidance.mjs, so its guidance ships bare on Windows`,
  );
}

/* ============================================ no unrendered emission, ever */
/*
 * Everything above is an allowlist: it proves the handful of renderers someone
 * remembered to name here are correct. Every defect this section was written
 * after was somewhere else - a raw console.log sitting beside a rendered
 * sibling, in cmdSupport, cmdGrant, cmdDevices, cmdMcpConfig, cmdCheck,
 * cmdTest, the setup completion screen and the crash remedy. An allowlist
 * cannot find those. This is the inverse: walk every emission the product
 * makes and fail on any that hands the reader an instruction they cannot run.
 *
 * Directories skipped, each with the reason it is not a CLI surface:
 * node_modules is not ours; frontend runs in a browser; evidence holds
 * captured artifacts; test fixtures carry bare commands deliberately; and
 * worker/ runs in Cloudflare, where its strings reach a terminal only through
 * the CLI printers pinned below.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "frontend", "evidence", "test", "worker"]);
const EMITTERS = /\bconsole\.(?:log|error|warn|info)\s*\(|\bprocess\.(?:stdout|stderr)\.write\s*\(/g;
const RENDERED = /renderCliCommands|brainCliPrefix|renderCopyableCommand/;

/** Blank comments in place, so a commented-out example is never read as code. */
function blankComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) { out += src[i] === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let nesting = 0;
      out += ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") { nesting++; out += "${"; i += 2; continue; }
        if (quote === "`" && nesting > 0 && src[i] === "}") { nesting--; out += "}"; i++; continue; }
        if (src[i] === quote && nesting === 0) { out += quote; i++; break; }
        out += src[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The whole argument expression of the call whose "(" sits at openIndex.
 *
 * Template-expression aware on purpose. A naive scanner treats the backtick in
 * `${c.bold(`...`)}` as a closing quote, runs past the end of the call, and
 * reports the wrong emitter - which is how a leak hides in plain sight.
 */
function callArgument(src, openIndex) {
  let i = openIndex;
  let depth = 0;
  const stack = [];
  while (i < src.length) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (ch === "\\") { i += 2; continue; }
      if (ch === top) stack.pop();
      i++;
      continue;
    }
    if (top === "`") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "$" && src[i + 1] === "{") { stack.push("${"); i += 2; continue; }
      if (ch === "`") stack.pop();
      i++;
      continue;
    }
    if (top === "${") {
      if (ch === "}") { stack.pop(); i++; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { stack.push(ch); i++; continue; }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { stack.push(ch); i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return src.slice(openIndex + 1, i); }
    i++;
  }
  return null;
}

/** Emission sites in one module that carry a command and never render it. */
function unrenderedEmissions(moduleSource, label = "<source>") {
  const code = blankComments(moduleSource);
  const found = [];
  let parsed = 0;
  for (const match of code.matchAll(EMITTERS)) {
    const argument = callArgument(code, match.index + match[0].length - 1);
    if (argument === null) continue;
    parsed++;
    if (!bareCommand.test(argument) || RENDERED.test(argument)) continue;
    found.push(`${label}:${code.slice(0, match.index).split("\n").length}  ${argument.replace(/\s+/g, " ").slice(0, 140)}`);
  }
  return { found, parsed };
}

// The detector is checked against known answers first. A sweep that silently
// stopped seeing anything would otherwise report a clean tree forever, which is
// a worse failure than the defect it is looking for.
assert.equal(unrenderedEmissions('console.log("Run brain doctor <manifest> next.");').found.length, 1, "the sweep must see a bare command");
assert.equal(unrenderedEmissions('console.log(renderCliCommands("Run brain doctor <manifest> next."));').found.length, 0, "the sweep must accept a rendered command");
assert.equal(unrenderedEmissions('// console.log("Run brain doctor <manifest> next.");').found.length, 0, "the sweep must ignore commented-out code");
assert.equal(unrenderedEmissions('console.log("The brain is live and the brain has answers.");').found.length, 0, "the sweep must not read prose as an instruction");
assert.equal(unrenderedEmissions('console.log(`${c.bold(`x`)}`); console.log("Run brain doctor now.");').found.length, 1, "the sweep must survive a nested template literal");

const productDirectory = fileURLToPath(productRoot);
const moduleFiles = [];
(function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.m?js$/.test(full)) moduleFiles.push(full);
  }
})(productDirectory);
assert.ok(moduleFiles.length > 50, `only ${moduleFiles.length} product modules were walked`);

const leaks = [];
let emissionSites = 0;
for (const file of moduleFiles) {
  const swept = unrenderedEmissions(readFileSync(file, "utf8"), file.slice(productDirectory.length));
  emissionSites += swept.parsed;
  leaks.push(...swept.found);
}
assert.ok(emissionSites > 300, `only ${emissionSites} emission sites were parsed; the sweep has gone blind`);
assert.deepEqual(
  leaks,
  [],
  `these emissions hand a Windows reader a command that is not on their PATH.\nRoute each through say/sayErr/ok/info/warn, or printGuidance in operations/, rather than console directly:\n${leaks.join("\n")}`,
);

/* ============================ what a literal scan structurally cannot see */
/*
 * The emitters themselves are the floor everything else stands on.
 *
 * The sweep reads the ARGUMENT of a console call. If `say` quietly stopped
 * rendering, every one of its call sites would still look clean, because the
 * command text lives in the caller and the argument is just `s`. Nothing else
 * in this file would notice either.
 */
for (const emitter of ["ok", "info", "warn", "say", "sayErr"]) {
  const definition = source.match(new RegExp(`^const ${emitter} = \\(s\\) => [^\\n]*$`, "m"));
  assert.ok(definition, `brain.mjs no longer defines the \`${emitter}\` emitter`);
  assert.match(definition[0], /renderCliCommands\(s\)/, `the \`${emitter}\` emitter stopped rendering; the sweep cannot see this, because its call sites keep the command text`);
}

// A constant from doctor.mjs, so no scan of brain.mjs string literals sees it.
// It is the sentence that tells the owner how to re-enter a rejected token,
// which the code's own comment calls the most common install-day mistake.
assert.match(source, /sayErr\("  " \+ CF_TOKEN_REJECTED_REMEDY/, "the rejected-token remedy names `brain update` and an interactive terminal, so it must render");

/*
 * The printers that carry their command text in from somewhere else - the
 * connectors, acceptance.mjs, operations/check-run.mjs and the Worker - so no
 * scan of this repository's string literals can see what they emit. Each is
 * pinned at its own site, the same way doctor `fix` and diagnose `action` are.
 */
assert.match(source, /\n  say\(report\.text\);\n/, "brain check must render the report it prints: operations/check-run.mjs puts `brain zone` in it");
assert.match(source, /say\(`    \$\{mark\}  \$\{r\.name\}/, "brain test must render acceptance details: acceptance.mjs and the Worker put commands in them");
assert.match(source, /const log = \(line\) => emit\(renderCliCommands\(line\)\);/, "renderLoadReport must render every line: the per-source `fix:` text names real commands");
assert.match(source, /c\.dim\(renderCliCommands\(f\.detail, renderOptions\)\)/, "diagnose details must render, not only diagnose actions");

/**
 * Run something with the process reporting Windows, then put it back.
 *
 * PATH is blanked for the duration, and the shim cache is cleared on the way in
 * and on the way out. Both matter: the renderers exercised below reach
 * `brainCliPrefix()` through their own DEFAULT arguments, so without this they
 * would read whatever PATH this host happens to have, and a developer machine
 * carrying an unrelated `brain.cmd` would silently swap the expected absolute
 * form for the short one. Blank PATH means no directory is ever probed, so the
 * absolute form is exercised on every host.
 */
function underWindows(run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const path = { PATH: process.env.PATH, Path: process.env.Path };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = "";
  delete process.env.Path;
  resetCliPrefixCache();
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
    if (path.PATH === undefined) delete process.env.PATH; else process.env.PATH = path.PATH;
    if (path.Path === undefined) delete process.env.Path; else process.env.Path = path.Path;
    resetCliPrefixCache();
  }
}
const hostPrefix = underWindows(() => brainCliPrefix({ env: { PATH: "" }, existsSync: () => false }));
assert.notEqual(hostPrefix, "brain", "the platform seam did not take effect");
assert.ok(hostPrefix.startsWith("& "), `the host guard must exercise the absolute form, got: ${hostPrefix}`);
assert.equal(
  hostPrefix,
  underWindows(() => brainCliPrefix()),
  "the injected guard and the default path this suite actually drives must agree",
);

// renderLoadReport, driven through its real default path rather than an
// injected renderer, with the fix strings the connectors actually produce.
const loadLines = [];
underWindows(() => renderLoadReport([
  { key: "google-drive", label: "Google Drive", status: "skipped", reason: "not connected yet",
    fix: "brain connect google --scopes drive,gmail,calendar" },
  { key: "imessage", label: "iMessage", status: "unavailable", reason: "not available on this platform",
    fix: "load the history from an unencrypted iPhone backup instead: brain ingest <manifest> --from iphone-backup" },
  { key: "notes", label: "Notes", status: "partial", summary: "12 documents", elapsed_ms: 900, legs: [1, 2], legFailures: [1] },
  { key: "mail", label: "Mail", status: "failed", reason: "the mailbox refused the connection",
    fix: "brain connect imap <manifest>" },
], { dryRun: false, totals: { line: "12 documents in the brain" }, log: (line) => loadLines.push(line) }));
const loadText = loadLines.join("\n");
assert.ok(loadText.includes(hostPrefix), "renderLoadReport did not render any command for Windows");
assert.doesNotMatch(loadText, bareCommand, `renderLoadReport left a bare command:\n${loadText}`);

// renderDiagnosis carrying BOTH fields. The fixture above sets only `action`,
// which is why the sibling `detail` line leaked for as long as it did.
const diagnosisLines = [];
const realLog = console.log;
try {
  console.log = (...parts) => diagnosisLines.push(parts.join(" "));
  renderDiagnosis({
    totals: { documents: 3, chunks: 4, sources: 1 },
    findings: [{
      area: "integrity",
      severity: "crit",
      title: "Documents with no owning source",
      detail: "They exist in the brain but no source owns them, so `brain forget` cannot remove them.",
      action: "Run brain sources C:\\fixture\\brain.manifest.json to review the registered sources.",
    }],
    summary: { crit: 1, warn: 0 },
    verdict: "critical",
  }, windows);
} finally {
  console.log = realLog;
}
const diagnosisText = diagnosisLines.join("\n");
assert.match(diagnosisText, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(diagnosisText, bareCommand, `renderDiagnosis left a bare command:\n${diagnosisText}`);

/* ============================ the artifacts that outlive the terminal */
// The report the client keeps names the one command that makes its promise of
// self-service true, and nothing renders an HTML file after this function.
const reportHtml = underWindows(() => renderReportHtml({}));
assert.doesNotMatch(reportHtml, bareCommand, "the HTML report offers the client a command they cannot run");
assert.match(reportHtml, /<span class="cmd">&amp; /, "the HTML report command is neither rendered nor escaped");

// The technician skill is copied onto the machine byte for byte and then read
// by the owner's own assistant, which runs what it names in the owner's shell.
const skillSource = readFileSync(new URL("skills/financial-brain-technician/SKILL.md", productRoot), "utf8");
/*
 * Detection here is deliberately INDEPENDENT of the alternation.
 *
 * Deriving both sides from the renderer makes this vacuous: drop a token and
 * the check stops looking for it, so it passes by going blind. Instead, read
 * what the skill tells the assistant to type - backtick-quoted and fenced
 * command lines - and require each one to be a token the renderer knows.
 * `brain --version` is the live example: it is named here, it is a real
 * invocation, and it was outside the alternation.
 */
const skillCommands = new Set([
  ...[...skillSource.matchAll(/`brain ((?:--)?[a-z][a-z-]*)/g)].map((m) => m[1]),
  ...[...skillSource.matchAll(/^\s*brain ((?:--)?[a-z][a-z-]*)/gm)].map((m) => m[1]),
]);
assert.ok(skillCommands.size >= 5, `only ${skillCommands.size} commands were read out of the technician skill`);
for (const command of skillCommands) {
  assert.ok(
    SUBCOMMANDS.includes(command),
    `the technician skill tells the owner's assistant to run \`brain ${command}\`, which the renderer does not know, so it reaches a Windows owner bare`,
  );
}
assert.doesNotMatch(renderCliCommands(skillSource, windows), bareCommand, "the installed technician skill still carries a bare command");
const skillCopier = readFileSync(new URL("operations/claude-skill.mjs", productRoot), "utf8");
assert.match(skillCopier, /return renderCliCommands\(content, options\);/, "the installed technician skill must be rendered for the machine it lands on");

// MCP tool failures surface inside the AI tool, not a terminal, and the
// runtime's remedies name `brain secrets` and `brain mcp-config`.
const mcpServer = readFileSync(new URL("components/brain-mcp.mjs", productRoot), "utf8");
assert.match(mcpServer, /text: renderCliCommands\(`brain error in \$\{params\?\.name\}/, "MCP tool errors must render the commands they name");

// One emitter for the scheduler daemons, instead of a seventh private copy
// that quietly drops the renderer the way the previous six did.
assert.match(guidanceSource, /export function printGuidance\(/, "operations/cli-guidance.mjs must expose the shared scheduler emitter");
const guidanceLines = [];
printGuidance("Review the exact safe record with: brain support --preview", { write: (line) => guidanceLines.push(line), ...windows });
assert.doesNotMatch(guidanceLines.join("\n"), bareCommand, "printGuidance did not render");
for (const scheduler of ["folder", "drive", "imessage", "whatsapp-drain", "curated-sync", "provider"]) {
  const text = readFileSync(new URL(`operations/${scheduler}-scheduler.mjs`, productRoot), "utf8");
  assert.match(text, /printGuidance\(/, `operations/${scheduler}-scheduler.mjs still prints support guidance without the renderer`);
}

/* ======================================= the whole thing, actually running */
// One live run of the real binary, because every assertion above reads source
// or calls an exported function. This is the path a stuck owner takes: `brain
// support` is what a failing command tells them to run next.
const supportRoot = realpathSync(mkdtempSync(join(tmpdir(), "brain-guidance-support-")));
try {
  const preload = join(supportRoot, "windows.mjs");
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "win32", configurable: true });\n', { mode: 0o600 });
  // Node resolves --import as a module SPECIFIER, not as a path. A POSIX
  // absolute path happens to resolve; the same file on Windows is spelled
  // `C:\...`, which parses as the URL scheme `c:` and the child never starts
  // (ERR_UNSUPPORTED_ESM_URL_SCHEME), so this whole live run failed on the one
  // platform it exists to cover. A file URL is the portable spelling, the same
  // way test/eval-init-privacy.test.mjs already passes its isolation hook.
  const preloadSpecifier = pathToFileURL(preload).href;
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: supportRoot, USERPROFILE: supportRoot, NO_COLOR: "1" });
  const run = spawnSync(
    process.execPath,
    ["--import", preloadSpecifier, fileURLToPath(new URL("brain.mjs", productRoot)), "support"],
    { cwd: supportRoot, env, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const printed = `${run.stdout}${run.stderr}`;
  assert.match(printed, /Review exact shareable bytes/, printed);
  assert.doesNotMatch(printed, bareCommand, `a live \`brain support\` run left a bare command:\n${printed}`);
} finally {
  rmSync(supportRoot, { recursive: true, force: true });
}

/* ==================== the same defect, seen from the test side instead */
/*
 * The sweep above walks product code and deliberately skips `test/`, because a
 * fixture carrying a bare command is normal. But a TEST may also assert on the
 * macOS spelling of a command the product renders per platform, and that
 * assertion cannot fail here: on posix `renderCliCommands` is the identity
 * function, so a full green local run says nothing about it. It fails only on a
 * Windows runner, twenty-five minutes later.
 *
 * That happened five times in one night. The discriminator between a bug and a
 * legitimate fixture is narrow and specific: a bare command inside a literal
 * that is being compared against CAPTURED TERMINAL OUTPUT. A broad scan of every
 * assertion flags ~113 legitimate fixtures and is useless; this rule measured
 * zero false positives on the real tree.
 *
 * Deliberately NOT flagged, because these must stay byte-stable:
 *   - test descriptions and check() labels
 *   - assertions on pre-render structured fields (err.message, f.action, remedy)
 *   - fixture inputs, which are supposed to carry the bare form
 */
const OUTPUT_IDENT = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
// An identifier is "output-like" only if some segment names captured process
// output. `manifest.text` is not output; `run.stdout` and `printed` are.
const OUTPUT_SEGMENT = /(?:^|\.)(?:output|stdout|stderr|printed|combined|logs?|terminal|rendered|text|body)$/i;
// Both forms are anchored on their OPEN PAREN, so callArgument can balance from
// it. Anchoring the assert form on its comma instead silently yields nothing,
// which is the failure mode this rule exists to prevent, so it is covered by a
// known answer below.
const METHOD_ON_OUTPUT = new RegExp(
  String.raw`(${OUTPUT_IDENT})\s*\.\s*(?:includes|match|indexOf|search|startsWith|endsWith|contains)\s*\(`, "g");
const ASSERT_CALL = /assert\s*\.\s*(?:match|doesNotMatch|equal|strictEqual|notEqual|deepEqual|ok)\s*\(/g;

// Split a balanced argument list at its first top-level comma.
function firstArgument(list) {
  let depth = 0, quote = null;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && list[i + 1] !== "/" && list[i + 1] !== "*") {
      // A regex literal: skip to its unescaped closing slash.
      let j = i + 1;
      for (; j < list.length; j++) {
        if (list[j] === "\\") { j++; continue; }
        if (list[j] === "[") { while (j < list.length && list[j] !== "]") { if (list[j] === "\\") j++; j++; } continue; }
        if (list[j] === "/") break;
      }
      i = j; continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) return { head: list.slice(0, i), rest: list.slice(i + 1) };
  }
  return { head: list, rest: "" };
}

function hardcodedOutputExpectations(moduleSource, label = "<source>") {
  const code = blankComments(moduleSource);
  const found = [];
  let parsed = 0;
  const record = (index, expectation) => {
    parsed++;
    if (!bareCommand.test(expectation) || RENDERED.test(expectation)) return;
    found.push(`${label}:${code.slice(0, index).split("\n").length}  ${expectation.replace(/\s+/g, " ").slice(0, 140)}`);
  };
  for (const match of code.matchAll(METHOD_ON_OUTPUT)) {
    if (!OUTPUT_SEGMENT.test(match[1])) continue;
    const argument = callArgument(code, match.index + match[0].length - 1);
    if (argument !== null) record(match.index, argument);
  }
  for (const match of code.matchAll(ASSERT_CALL)) {
    const list = callArgument(code, match.index + match[0].length - 1);
    if (list === null) continue;
    const { head, rest } = firstArgument(list);
    if (!OUTPUT_SEGMENT.test(head.trim()) || !rest.trim()) continue;
    // The message argument of an assert is prose about the failure, not the
    // expectation, so only the second argument is judged.
    record(match.index, firstArgument(rest).head);
  }
  return { found, parsed };
}

/* KNOWN-ANSWER FIXTURES BEGIN */
// Known answers first, same discipline as the sweep above: a rule that silently
// stopped matching would report a clean tree forever.
const t = (src) => hardcodedOutputExpectations(src).found.length;
// True positives, both in the exact spelling the real defects had before repair.
assert.equal(t('assert.ok(stalled.output.includes("Do NOT run `brain drain` while paused"));'), 1,
  "the rule must see a bare command asserted against captured output");
assert.equal(t('assert.match(printed, /brain forget <manifest> --yes/);'), 1,
  "the rule must see a bare command in a regex asserted against output");
assert.equal(t('const printed = `${run.stdout}`; assert.ok(printed.includes("run brain doctor now"));'), 1,
  "the rule must see a bare command through a combined-output identifier");
// True negatives, every one of which must stay bare.
assert.equal(t('assert.ok(output.includes(renderCliCommands("brain drain")));'), 0,
  "the rule must accept an expectation built through the renderer");
assert.equal(t('check("scheduled run invokes brain ingest manifest --from drive", ok);'), 0,
  "the rule must not read a test description as an expectation");
assert.equal(t('assert.equal(err.message, "brain doctor <manifest> failed");'), 0,
  "the rule must not flag a pre-render structured field");
assert.equal(t('const fixture = "run brain doctor <manifest>"; writeFileSync(p, fixture);'), 0,
  "the rule must not flag a fixture input");
assert.equal(t('// assert.ok(output.includes("brain drain"));'), 0,
  "the rule must ignore commented-out code");
assert.equal(t('assert.ok(manifest.text.includes("brain"));'), 0,
  "the rule must not read prose without a subcommand as an instruction");
/* KNOWN-ANSWER FIXTURES END */

const testDirectories = [join(productDirectory, "test"), join(productDirectory, "worker", "test")];
const testFiles = [];
for (const directory of testDirectories) {
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.m?js$/.test(full)) testFiles.push(full);
    }
  })(directory);
}
assert.ok(testFiles.length > 100, `only ${testFiles.length} test modules were walked`);

// This file's own known-answer cases are test code held inside string literals,
// so the rule correctly sees them. They are fenced and blanked, and the fence is
// asserted to exist exactly once so the exemption cannot quietly widen to cover
// a real defect written below it.
const FENCE = /\/\* KNOWN-ANSWER FIXTURES BEGIN \*\/[\s\S]*?\/\* KNOWN-ANSWER FIXTURES END \*\//g;
function withoutKnownAnswerFixtures(text, file) {
  if (!file.endsWith("cli-guidance-rendering.test.mjs")) return text;
  const fences = text.match(FENCE) || [];
  assert.equal(fences.length, 1, "the known-answer fixture fence must appear exactly once");
  return text.replace(FENCE, (block) => block.replace(/[^\n]/g, " "));
}

const hardcoded = [];
let expectationSites = 0;
for (const file of testFiles) {
  const swept = hardcodedOutputExpectations(
    withoutKnownAnswerFixtures(readFileSync(file, "utf8"), file),
    file.slice(productDirectory.length),
  );
  expectationSites += swept.parsed;
  hardcoded.push(...swept.found);
}
// Measured at 161 on the real tree. The floor is set below that with room for
// tests to come and go, but high enough that a rule which stopped matching
// cannot pass as a clean sweep.
assert.ok(expectationSites > 120, `only ${expectationSites} output expectations were parsed; the rule has gone blind`);
assert.deepEqual(
  hardcoded,
  [],
  `these tests assert the macOS spelling of a command the product renders per platform.\n` +
  `They pass here and fail only on Windows CI. Build the expectation through renderCliCommands(...) instead:\n${hardcoded.join("\n")}`,
);

console.log(`CLI guidance sweep: ${emissionSites} emission sites across ${moduleFiles.length} modules, none bare on Windows`);
console.log(`CLI expectation rule: ${expectationSites} output expectations across ${testFiles.length} test modules, none hardcoded to posix`);

/* ============================ the short form a worried reader can retype */
/*
 * Rendering is not finished when the command is merely executable.
 *
 * One field health failure printed four copies of
 *   & 'C:\Program Files\nodejs\node.exe' 'C:\Users\<name>\...\brain.mjs' drain
 * on a screen the runbook itself says may be shared, so each of the four also
 * published the owner's Windows username. npm writes a `brain.cmd` shim into
 * the install prefix, one level above node_modules, and that shim runs exactly
 * the same code.
 *
 * The short form is only safe when it is also CORRECT, and correctness is a
 * property of PATH, not of the filesystem. A --prefix install is routinely NOT
 * on PATH while a stale copy of the package IS: run A's operator ran 0.3.5
 * against a brain installed at 0.4.0 for exactly that reason. Printing the bare
 * word there would hand the reader a command that runs the OTHER install
 * against a client's brain, which is strictly worse than a long correct one.
 *
 * So the rule below is the shell's own rule: walk PATH in order, take the FIRST
 * shim, and use the short form only when that shim belongs to this install.
 * Everything else falls back to the absolute invocation.
 */
const shimPrefix = "C:\\Users\\client\\AppData\\Local\\FinancialBrain";
const absolute = "& 'C:\\Program Files\\nodejs\\node.exe' " +
  "'C:\\Users\\client\\AppData\\Local\\FinancialBrain\\node_modules\\brain-installer\\brain.mjs'";
const shimAt = (...directories) => {
  const wanted = new Set(directories.map((d) => `${d}\\brain.cmd`));
  return (candidate) => wanted.has(candidate);
};

// (a) The shim of THIS install is the first one PATH finds: the bare word runs
// the code the reader is being told to run, so it is safe to print.
resetCliPrefixCache();
const inPrefix = {
  ...windows,
  env: { PATH: `C:\\Windows\\system32;${shimPrefix};C:\\Windows` },
  existsSync: shimAt(shimPrefix),
};
assert.equal(brainCliPrefix(inPrefix), "brain.cmd", "this install's shim, first on PATH, must render as the short form");
assert.equal(renderCliCommands("brain drain <manifest>", inPrefix), "brain.cmd drain <manifest>");

// The whole point of the short form: nothing about the owner reaches the screen.
const shortForm = renderCliCommands("Run brain drain <manifest>, then brain health <manifest>.", inPrefix);
assert.equal(shortForm, "Run brain.cmd drain <manifest>, then brain.cmd health <manifest>.");
assert.ok(!shortForm.includes("Users"), `the short form still carries a user-profile path:\n${shortForm}`);
assert.ok(!shortForm.includes(shimPrefix), `the short form still carries the install prefix:\n${shortForm}`);
// It must also not read as unrendered, or the sweep above would flag every
// Windows line the product prints once this lands.
assert.doesNotMatch(shortForm, bareCommand, "the short form must not read as a bare command");
assert.equal(renderCliCommands(shortForm, inPrefix), shortForm, "a second render of the short form is inert");

// Whichever way PATH is spelled in the environment block.
for (const key of ["PATH", "Path"]) {
  resetCliPrefixCache();
  const spelled = { ...windows, env: { [key]: `C:\\Windows;"${shimPrefix}\\"` }, existsSync: shimAt(shimPrefix) };
  assert.equal(brainCliPrefix(spelled), "brain.cmd", `this install's shim on %${key}% must render as the short form`);
}

// (b) THE REGRESSION. The shim exists in the install prefix, but an older copy
// of the package sits earlier on PATH. `brain.cmd` would resolve to that other
// install, so the reader must be given the invocation that cannot be mistaken.
resetCliPrefixCache();
const stalePrefix = "C:\\Users\\client\\AppData\\Roaming\\npm";
const shadowed = {
  ...windows,
  env: { PATH: `${stalePrefix};${shimPrefix}` },
  existsSync: shimAt(stalePrefix, shimPrefix),
};
assert.equal(
  brainCliPrefix(shadowed),
  absolute,
  "a DIFFERENT install's shim earlier on PATH must force the absolute form: `brain.cmd` would run that one",
);
assert.equal(
  renderCliCommands("brain drain <manifest>", shadowed),
  `${absolute} drain <manifest>`,
  "the shadowed case must not print a command that runs another install against this brain",
);

// (c) The shim exists in the install prefix, but the prefix is not on PATH at
// all — the documented default layout for a --prefix install. There is no
// `brain.cmd` for the reader's shell to find, so the bare word is unrunnable.
resetCliPrefixCache();
const prefixOffPath = {
  ...windows,
  env: { PATH: "C:\\Windows\\system32;C:\\Windows" },
  existsSync: shimAt(shimPrefix),
};
assert.equal(
  brainCliPrefix(prefixOffPath),
  absolute,
  "an install prefix that is not on PATH must render the absolute form, however real its shim is",
);
// An empty PATH is the same case with nothing to walk.
resetCliPrefixCache();
assert.equal(brainCliPrefix({ ...windows, env: {}, existsSync: shimAt(shimPrefix) }), absolute);

// (d) No shim resolvable anywhere: the absolute invocation is still the
// fallback, because an unrunnable short command is worse than a long runnable
// one.
resetCliPrefixCache();
const noShim = { ...windows, env: { PATH: `C:\\Windows\\system32;${shimPrefix}` }, existsSync: () => false };
assert.equal(brainCliPrefix(noShim), absolute, "without a shim the reader must still get something they can run");
assert.equal(renderCliCommands("brain drain <manifest>", noShim), `${absolute} drain <manifest>`);

// (e) The resolution is memoised. This sits behind every ok/info/warn/say line
// the product prints, and the shim-less box is the expensive one: one probe per
// PATH entry, per printed line, on a machine that will never have a shim.
resetCliPrefixCache();
let probes = 0;
const counted = {
  ...windows,
  env: { PATH: "C:\\a;C:\\b;C:\\c;C:\\d;C:\\e" },
  existsSync: (candidate) => { probes++; return false; },
};
assert.equal(brainCliPrefix(counted), absolute);
const afterFirst = probes;
assert.ok(afterFirst > 0, "the first resolution must actually probe PATH");
renderCliCommands("Run brain drain <manifest>, then brain health <manifest>.", counted);
assert.equal(brainCliPrefix(counted), absolute);
assert.equal(probes, afterFirst, `repeated renders re-probed the filesystem: ${probes - afterFirst} extra calls`);
// The cache is keyed, not blind: a different PATH must be resolved afresh.
const movedOntoPath = { ...counted, env: { PATH: `C:\\a;${shimPrefix}` }, existsSync: shimAt(shimPrefix) };
assert.equal(brainCliPrefix(movedOntoPath), "brain.cmd", "a different PATH must not read a stale answer");
resetCliPrefixCache();

// posix is unchanged, shim or no shim: `brain` is already the short form there.
assert.equal(brainCliPrefix({ ...inPrefix, platform: "darwin" }), "brain");
assert.equal(renderCliCommands("brain drain <manifest>", { ...inPrefix, platform: "darwin" }), "brain drain <manifest>");
assert.equal(brainCliPrefix({ ...noShim, platform: "linux" }), "brain");

console.log("CLI guidance rendering: the Windows short form is printed only when PATH resolves it to THIS install");
