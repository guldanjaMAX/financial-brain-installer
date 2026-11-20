// Sharding and ordering logic of scripts/run-test-chain-parallel.mjs.
// Lives one folder below test/ on purpose: it tests a developer runner, not the
// product, and test-chain-complete only requires top-level test files in the
// ordered chain. Run it directly: node --test test/parallel-chain/
import assert from "node:assert/strict";
import test from "node:test";
import { TEST_COMMANDS } from "../../scripts/run-test-chain.mjs";
import {
  SERIAL_RULES, classifyCommands, commandFiles, compareOutcomes, executePlan, outcomesFrom,
  parseArguments, parseChainLog, parseSerialFile, planSchedule, runPool, tailLines, timingsFrom,
} from "../../scripts/run-test-chain-parallel.mjs";

const CHAIN = [
  "node --test test/a.test.mjs",
  "node --no-warnings --test worker/test/slow-scale.test.mjs",
  "node test/b.test.mjs",
  "node --test test/c.test.mjs test/d.test.mjs",
  "npm run test:eval",
  "node test/e.test.mjs",
];
const RULES = [
  { file: "worker/test/slow-scale.test.mjs", kind: "timing", reason: "budget" },
  { file: "test/d.test.mjs", kind: "package", reason: "npm pack" },
  { file: "test/not-in-chain.test.mjs", kind: "timing", reason: "stale" },
];

test("commandFiles reads module paths and maps the npm script", () => {
  assert.deepEqual(commandFiles("node --no-warnings --test worker/test/x.test.mjs test/y.test.mjs"), ["worker/test/x.test.mjs", "test/y.test.mjs"]);
  assert.deepEqual(commandFiles("node test/z.test.mjs"), ["test/z.test.mjs"]);
  assert.deepEqual(commandFiles("npm run test:eval"), ["npm:run test:eval"]);
});

test("a command is serial when any of its files is named, and stale rules are reported", () => {
  const { rows, unmatchedRules } = classifyCommands(CHAIN, RULES);
  assert.deepEqual(rows.filter((row) => row.serial).map((row) => row.index), [1, 3]);
  assert.match(rows[3].reasons[0], /^test\/d\.test\.mjs: npm pack$/);
  assert.deepEqual(unmatchedRules, ["test/not-in-chain.test.mjs"]);
});

test("parallel part runs longest first with chain-order ties; serial part keeps chain order", () => {
  const timings = new Map([
    [CHAIN[0], 5_000],
    [CHAIN[2], 90_000],
    [CHAIN[1], 400_000],
    // A flag change must not lose the estimate: matched by file set.
    ["node --no-warnings test/e.test.mjs", 70_000],
  ]);
  const plan = planSchedule(CHAIN, { rules: RULES, timings });
  // Unknown estimates use the median of the known ones (here 90 s), so the npm
  // command ties with index 2 and chain order breaks the tie.
  assert.deepEqual(plan.parallel.map((row) => row.index), [2, 4, 5, 0]);
  assert.equal(plan.parallel.find((row) => row.index === 5).estimateMs, 70_000);
  assert.deepEqual([plan.parallel.find((row) => row.index === 4).estimated, plan.parallel.find((row) => row.index === 4).estimateMs], [true, 90_000]);
  assert.deepEqual(plan.serial.map((row) => row.index), [1, 3]);
  assert.equal(plan.selected, CHAIN.length);
  const subset = planSchedule(CHAIN, { rules: RULES, only: /test\/[ab]\./ });
  assert.deepEqual([subset.parallel.map((r) => r.index), subset.serial.map((r) => r.index)], [[0, 2], []]);
  assert.equal(subset.total, CHAIN.length);
});

test("no timings means pure chain order in the parallel part", () => {
  const plan = planSchedule(CHAIN, { rules: RULES });
  assert.deepEqual(plan.parallel.map((row) => row.index), [0, 2, 4, 5]);
});

test("timingsFrom accepts this runner's results and the per-command array format", () => {
  assert.equal(timingsFrom({ results: [{ command: "node test/a.test.mjs", durationMs: 12 }] }).get("node test/a.test.mjs"), 12);
  assert.equal(timingsFrom([{ command: "node test/b.test.mjs", ms: 34 }, { command: "x" }]).size, 1);
});

const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

test("runPool never exceeds its slot count and runs every item exactly once", async () => {
  let inFlight = 0; let peak = 0; const seen = [];
  const items = Array.from({ length: 23 }, (_, i) => i);
  const results = await runPool(items, { workers: 4, runOne: async (item, slot) => {
    inFlight++; peak = Math.max(peak, inFlight);
    assert.ok(slot >= 0 && slot < 4);
    for (let i = 0; i < (item % 3) + 1; i++) await tick();
    inFlight--; seen.push(item);
    return item * 10;
  } });
  assert.equal(peak, 4);
  assert.deepEqual(seen.slice().sort((a, b) => a - b), items);
  assert.deepEqual(results, items.map((i) => i * 10));
  assert.deepEqual(await runPool([], { workers: 3, runOne: () => assert.fail("no items") }), []);
  await assert.rejects(runPool([1], { workers: 0, runOne: async () => 1 }), /positive integer/);
});

test("serial commands start only after every parallel command ended, one at a time, in chain order", async () => {
  const plan = planSchedule(CHAIN, { rules: RULES, timings: new Map([[CHAIN[2], 9]]) });
  const events = []; let inFlight = 0;
  const executed = await executePlan(plan, { workers: 3, runOne: async (row, { phase }) => {
    inFlight++;
    events.push({ type: "start", phase, index: row.index, inFlight });
    await tick(); await tick();
    inFlight--;
    events.push({ type: "end", phase, index: row.index });
    return { index: row.index, phase };
  } });
  const lastParallelEnd = events.findLastIndex((e) => e.type === "end" && e.phase === "parallel");
  const firstSerialStart = events.findIndex((e) => e.type === "start" && e.phase === "serial");
  assert.ok(firstSerialStart > lastParallelEnd);
  for (const event of events.filter((e) => e.type === "start" && e.phase === "serial")) assert.equal(event.inFlight, 1);
  assert.deepEqual(executed.serial.map((r) => r.index), [1, 3]);
  assert.equal(executed.parallel.length, 4);
});

test("a stop request launches nothing new", async () => {
  let stop = false; const ran = [];
  await runPool([1, 2, 3, 4], { workers: 1, shouldStop: () => stop, runOne: async (item) => { ran.push(item); stop = true; } });
  assert.deepEqual(ran, [1]);
});

const SERIAL_PASS_LOG = "noise\ntest chain complete: 6/6 commands passed\n";
const SERIAL_FAIL_LOG = [
  "TAP version 13",
  "test 3/6 failed (exit 1): node test/b.test.mjs",
  "test 6/6 failed (signal SIGKILL): node test/e.test.mjs\r",
  "test chain failed: 2 of 6 attempted commands failed",
  "  3. node test/b.test.mjs (exit 1)",
].join("\n");

test("parseChainLog reads the serial chain's own failure and summary lines", () => {
  const ok = parseChainLog(SERIAL_PASS_LOG);
  assert.deepEqual([ok.complete, ok.attempted, ok.total, ok.failures.size], [true, 6, 6, 0]);
  const bad = parseChainLog(SERIAL_FAIL_LOG);
  assert.deepEqual([bad.complete, bad.attempted, bad.total], [true, 6, 6]);
  assert.deepEqual([...bad.failures.keys()], [2, 5]);
  assert.equal(bad.failures.get(5).label, "signal SIGKILL");
  assert.equal(parseChainLog("test 3/6 failed (exit 1): node test/b.test.mjs\n").complete, false);
  assert.equal(parseChainLog("test chain configuration error: npm_execpath is required\n").complete, false);
});

test("an unfinished or config-error serial log is refused instead of compared", () => {
  assert.throws(() => outcomesFrom("test 3/6 failed (exit 1): node test/b.test.mjs\n", CHAIN), /did not finish/);
  assert.throws(() => outcomesFrom("test chain configuration error: npm_execpath is required\n", CHAIN), /configuration error/);
});

test("a stop-at-first-failure serial log only covers the commands it attempted", () => {
  const early = "test 3/6 failed (exit 1): node test/b.test.mjs\ntest chain failed: 1 of 3 attempted commands failed\n";
  const { outcomes, notes } = outcomesFrom(early, CHAIN);
  assert.deepEqual([...outcomes], [[CHAIN[2], "fail"], [CHAIN[0], "pass"], [CHAIN[1], "pass"]]);
  assert.match(notes.join("\n"), /attempted only 3\/6/);
});

test("a log from a different-length chain is matched by command text and says so", () => {
  const full = outcomesFrom("test 2/9 failed (exit 1): node test/b.test.mjs\ntest chain failed: 1 of 9 attempted commands failed\n", CHAIN);
  assert.equal(full.outcomes.size, CHAIN.length);
  assert.equal(full.outcomes.get("node test/b.test.mjs"), "fail");
  assert.match(full.notes.join("\n"), /9-command chain .* read as a serial pass/);
  const early = outcomesFrom("test 2/9 failed (exit 1): node test/b.test.mjs\ntest chain failed: 1 of 2 attempted commands failed\n", CHAIN);
  assert.deepEqual([...early.outcomes], [["node test/b.test.mjs", "fail"]]);
  assert.match(early.notes.join("\n"), /cannot be mapped/);
});

test("compare finds new failures, new passes and coverage gaps", () => {
  const baseline = outcomesFrom(SERIAL_FAIL_LOG, CHAIN).outcomes;
  const same = outcomesFrom(JSON.stringify({ results: CHAIN.map((command, i) => ({ command, outcome: [2, 5].includes(i) ? "fail" : "pass" })) }), CHAIN).outcomes;
  assert.equal(compareOutcomes(baseline, same).identical, true);
  const changed = new Map(same); changed.set(CHAIN[0], "fail"); changed.set(CHAIN[5], "pass"); changed.delete(CHAIN[4]);
  const diff = compareOutcomes(baseline, changed);
  assert.deepEqual([diff.identical, diff.newFailures, diff.newPasses, diff.onlyBaseline], [false, [CHAIN[0]], [CHAIN[5]], [CHAIN[4]]]);
  const windowsRows = outcomesFrom(JSON.stringify([{ command: CHAIN[0], status: 0 }, { command: CHAIN[1], status: "not-run" }]), CHAIN);
  assert.deepEqual([...windowsRows.outcomes], [[CHAIN[0], "pass"]]);
  assert.match(windowsRows.notes[0], /1 row\(s\) had no outcome/);
});

test("tails keep the last lines without a trailing blank", () => {
  assert.deepEqual(tailLines("a\nb\r\nc\n\n", 2), ["b", "c"]);
  assert.equal(tailLines(Array.from({ length: 100 }, (_, i) => i).join("\n")).length, 60);
});

test("arguments are validated and extra serial files parse", () => {
  assert.equal(parseArguments(["--workers", "20", "--continue-on-failure"]).workers, 20);
  assert.throws(() => parseArguments(["--workers", "0"]), /1 to 256/);
  assert.throws(() => parseArguments(["--bogus"]), /unknown option/);
  assert.throws(() => parseArguments(["--against", "x.json"]), /needs --compare/);
  assert.deepEqual(parseSerialFile("# header\ntest/x.test.mjs # flaky lock\n\nworker/test/y.test.mjs\n").map((r) => [r.file, r.reason]),
    [["test/x.test.mjs", "flaky lock"], ["worker/test/y.test.mjs", "listed in --serial-file"]]);
});

test("every built-in serial rule names a file the real chain runs", () => {
  const { unmatchedRules, rows } = classifyCommands(TEST_COMMANDS, SERIAL_RULES);
  assert.deepEqual(unmatchedRules, []);
  assert.ok(rows.filter((row) => row.serial).length >= SERIAL_RULES.length);
  for (const rule of SERIAL_RULES) assert.ok(rule.reason.length > 10, rule.file);
});
