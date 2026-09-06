/**
 * Every tracked test file is actually in the test chain.
 *
 * WHY THIS EXISTS. `npm test` uses an explicit ordered command graph rather
 * than discovery. That preserves per-file Node flags and dependency order, but
 * a test file that exists, is committed, and is NOT in the graph is invisible.
 * It can fail for weeks and every run stays green.
 *
 * That is not hypothetical. `test/report-html.test.mjs` was tracked, was
 * failing, and was missing from the chain. It was found only because an agent
 * happened to run it directly. Nothing in the suite could have surfaced it,
 * because the suite did not know it existed.
 *
 * So this file asserts the one property the chain cannot assert about itself:
 * that it is complete. A new test file now either joins the chain or turns this
 * red on the next run.
 *
 * If you are here because this failed: add the named file to TEST_COMMANDS in
 * scripts/run-test-chain.mjs, in a position that matches what it depends on.
 * Do NOT add it to the ignore list below to make this pass. That is the same
 * defect this file exists to end, with an extra step.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_COMMANDS, parseTestCommand } from "../scripts/run-test-chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Files that are deliberately not in the chain, each with the reason it is
 * exempt. An entry here is a claim that the file is not a test of this package.
 * There are none today; the list exists so a legitimate exemption has somewhere
 * to go WITH its justification, rather than being silently dropped.
 */
const EXEMPT = new Map([
  // ["test/example.test.mjs", "why this is not run by npm test"],
]);

let fail = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + detail));
  if (!ok) fail++;
};

const packageTest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts?.test || "";
check("package.json uses the short test launcher", packageTest === "node scripts/run-test-chain.mjs", packageTest);
check("the ordered test graph is nonempty", TEST_COMMANDS.length > 0);
const scheduled = new Set(TEST_COMMANDS.flatMap((command) => {
  const parsed = parseTestCommand(command);
  return parsed.kind === "node" ? parsed.args.filter((arg) => !arg.startsWith("--")) : [];
}));

// Include new candidate tests before commit as well as tracked tests. A dirty
// candidate must not pass by leaving its new regression outside the chain.
const tracked = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => /(^|\/)(test|worker\/test)\/[^/]*\.test\.mjs$/.test(f)))];

check("git listed the tracked test files", tracked.length > 0, `found ${tracked.length}`);

// Exact paths prevent one suite from satisfying a different same-name suite.
const missing = tracked.filter((f) => {
  if (EXEMPT.has(f)) return false;
  return !scheduled.has(f);
});

check(
  "every tracked or new candidate test file is in the npm test chain",
  missing.length === 0,
  missing.length
    ? `${missing.length} orphaned and therefore never run: ${missing.join(", ")}`
    : "",
);

// The inverse, which catches the other way this drifts: an exemption for a file
// that no longer exists is stale bookkeeping and hides the next real one.
const staleExemptions = [...EXEMPT.keys()].filter((f) => !tracked.includes(f));
check(
  "no exemption names a file that is not tracked",
  staleExemptions.length === 0,
  staleExemptions.join(", "),
);

console.log(
  fail
    ? `\n${fail} FAILURE(S)`
    : `\ntest chain complete: all ${tracked.length} tracked or new candidate test files are in the chain` +
      (EXEMPT.size ? ` (${EXEMPT.size} exempt)` : ""),
);
process.exit(fail ? 1 : 0);
