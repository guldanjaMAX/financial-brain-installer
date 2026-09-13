import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifiedNpmCliPath } from "../operations/npm-cli-runtime.mjs";

export { verifiedNpmCliPath } from "../operations/npm-cli-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Keep ordinary audit regressions bounded at five minutes. The disposable
// recovery adapter is intentionally heavier: it exercises the exact 6,001-row
// replay and cryptographically bound recovery fixture, and a hosted macOS
// Node 22 run completed normally just under the ordinary ceiling. The exact
// current candidate also passed this proof earlier in the same hosted
// macOS/Node 24 job and in its concurrent exact-SHA push run, while the later
// isolated duplicate reached its exact ten-minute parent ceiling.
// Give only that exact proof a reviewed fifteen-minute ceiling; a lookalike
// path does not inherit the exception.
export const DEFAULT_REGRESSION_TIMEOUT_MS = 300_000;
export const CLOUDFLARE_RECOVERY_ADAPTER_REGRESSION_TIMEOUT_MS = 900_000;
const CLOUDFLARE_RECOVERY_ADAPTER_REGRESSION = "test/cloudflare-recovery-adapter.test.mjs";

function regressionTimeoutMs(path) {
  return path === CLOUDFLARE_RECOVERY_ADAPTER_REGRESSION
    ? CLOUDFLARE_RECOVERY_ADAPTER_REGRESSION_TIMEOUT_MS
    : DEFAULT_REGRESSION_TIMEOUT_MS;
}

// A RELEASE MAY DECLARE ITS SCOPE. IT MAY NOT DECLARE ITSELF EXEMPT.
//
// Requiring every incident ever opened to carry field evidence before ANY
// release made the gate unsatisfiable, and an unsatisfiable gate teaches people
// to walk past it: v0.3.6 was published 69 seconds before its own CI reported
// failure, and a partner audit then found 22 defects. So an incident may be
// deferred for ONE named version, in writing, on its own row.
//
// These three cannot be deferred at all, because their acceptance is a property
// of the release MECHANISM rather than of the product: what gets published
// (UPDATE-010), whether the published bytes are the bytes that were tested
// (UPDATE-026), and whether a brain reports its own executable, package,
// manifest, Worker and D1 versions honestly (UPDATE-014). Deferring one of
// those does not defer evidence about a feature; it defers the ability to trust
// any other deferral, any receipt, and any claim about which bytes are running.
// A gate waivable by the process it governs is not a gate.
export const UNDEFERRABLE_INCIDENTS = ["UPDATE-010", "UPDATE-014", "UPDATE-026"];
const UNDEFERRABLE = new Set(UNDEFERRABLE_INCIDENTS);

// A CLOSED enum, the same shape as allowedDispositions in
// scripts/scan-git-history-privacy.mjs. Every value names a reason the evidence
// CANNOT YET EXIST, not a reason nobody collected it. There is deliberately no
// value meaning "no time", "low risk", "CI is flaky" or "it is scheduled":
// a deferral that fits none of these is not a deferral, it is an unfinished
// gate. Adding a value is a reviewed code change plus a test change.
export const DEFERRAL_CAUSES = new Set(["physical_hardware_unavailable", "live_third_party_account_required"]);
const DEFERRAL_FIELDS = new Set(["version", "blocked_on", "reason", "unproven", "review"]);
// A bare list of IDs is not reviewable, and neither is the word "hardware".
const MIN_REASON = 80;
const MIN_UNPROVEN = 40;

// EVIDENCE IS A RECORD OF PROOF, NOT A POINTER AT THE RULES OR AT A TEST.
//
// `verified` is the other way an incident stops blocking, and until now it was
// the CHEAPER and QUIETER one: one word plus any existing path under
// test/, scripts/ or docs/. Both of these passed and exited 0 with all 26
// incidents "closed", including the three that may never be deferred:
//   evidence: ["test/update-audit.test.mjs"]   a local test, when this very
//                                              gate prints "Local tests are not
//                                              field recovery proof"
//   evidence: ["docs/update-incidents.json"]   the registry citing itself
// So a mechanism that made deferral written, scoped, expiring and published
// would have left the softer path untouched beside it, and a maintainer under
// pressure picks the cheap lie. Two rules, both enforcing text that
// docs/UPDATE-AUDIT.md step 8 already states: evidence is "a reviewed,
// sanitized evidence file under docs/", and a document that says what must be
// proven cannot be the record of having proven it.
const GATE_DOCUMENTS = new Set(["docs/RELEASE-GATE.md", "docs/UPDATE-AUDIT.md", "docs/PLAID-RELEASE-GATE.md",
  "docs/MAINTAINER.md", "docs/update-incidents.json"]);

// Kept deliberately independent of validateIncidents so that releaseBlockers is
// safe on its own: an unvalidated or hand-built registry cannot smuggle a
// deferral past it. Everything that would make a deferral invalid also makes it
// non-current here, and the safe direction is always "still blocking".
function currentlyDeferred(item, version) {
  const deferral = item?.deferral;
  if (!version || !deferral || typeof deferral !== "object" || Array.isArray(deferral)) return false;
  if (UNDEFERRABLE.has(item.id) || item.status === "verified") return false;
  if (Object.keys(deferral).some((key) => !DEFERRAL_FIELDS.has(key))) return false;
  return deferral.version === version && DEFERRAL_CAUSES.has(deferral.blocked_on) &&
    typeof deferral.reason === "string" && deferral.reason.trim().length >= MIN_REASON &&
    typeof deferral.unproven === "string" && deferral.unproven.trim().length >= MIN_UNPROVEN;
}

// Mirrors evaluateStrictRelease's stale-disposition handling: a reviewed
// exception that no longer describes reality FAILS the gate rather than being
// quietly ignored, so the list shrinks instead of accreting. Because a deferral
// lives ON the incident it excuses, the "names an ID that does not exist" class
// is structurally impossible; what remains is a deferral naming a version
// nobody is cutting, one on an incident that has since been verified, and one
// on an incident that must never be deferred. All three are fatal.
function validateDeferral(item, version) {
  const deferral = item.deferral;
  if (deferral === undefined) return;
  if (!deferral || typeof deferral !== "object" || Array.isArray(deferral)) throw new Error(`${item.id}: deferral must be an object`);
  for (const key of Object.keys(deferral)) {
    // A mistyped `versoin` must not silently degrade into "no expiry".
    if (!DEFERRAL_FIELDS.has(key)) throw new Error(`${item.id}: unknown deferral field ${key}`);
  }
  if (typeof deferral.version !== "string" || !/^\d+\.\d+\.\d+$/.test(deferral.version)) throw new Error(`${item.id}: deferral must name one exact release version`);
  if (!DEFERRAL_CAUSES.has(deferral.blocked_on)) throw new Error(`${item.id}: deferral blocked_on must name a reviewed cause`);
  if (typeof deferral.reason !== "string" || deferral.reason.trim().length < MIN_REASON) throw new Error(`${item.id}: deferral needs a written reason`);
  if (typeof deferral.unproven !== "string" || deferral.unproven.trim().length < MIN_UNPROVEN) throw new Error(`${item.id}: deferral must state what ships unproven`);
  if (UNDEFERRABLE.has(item.id)) throw new Error(`${item.id}: this incident governs the release mechanism and cannot be deferred`);
  if (item.status === "verified") throw new Error(`${item.id}: a verified incident must not carry a deferral`);
  if (version !== null && deferral.version !== version) throw new Error(`${item.id}: deferral names ${deferral.version} but package.json is ${version}`);
}

export function validateIncidents(cases, exists = (p) => existsSync(resolve(root, p)), version = null) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("incident registry is missing or empty");
  const ids = new Set();
  for (const item of cases) {
    if (!/^UPDATE-\d{3}$/.test(item.id) || ids.has(item.id)) throw new Error("invalid or duplicate incident ID");
    ids.add(item.id);
    if (!["open", "local-only", "verified"].includes(item.status)) throw new Error(`${item.id}: invalid status`);
    if (!item.title || !item.acceptance || !Array.isArray(item.scopes) || !item.scopes.length ||
        item.scopes.some((s) => !["fresh", "upgrade", "recovery"].includes(s))) throw new Error(`${item.id}: missing scope or acceptance`);
    if (!Array.isArray(item.tests) || !item.tests.length) throw new Error(`${item.id}: no regression command`);
    if (item.testPlatform && !["win32", "darwin", "linux"].includes(item.testPlatform)) throw new Error(`${item.id}: invalid test platform`);
    validateDeferral(item, version);
    for (const path of [...item.tests, ...(item.reproductions ?? []), ...(item.evidence ?? []),
      ...(item.deferral?.review ? [item.deferral.review] : [])]) {
      const allowedPath = /^(test|worker\/test|scripts|docs)\/[\w/.-]+$/.test(path) ||
        /^frontend\/test\/browser\/[\w.-]+\.browser\.mjs$/.test(path);
      if (!allowedPath || path.split("/").includes("..") || !exists(path)) {
        throw new Error(`${item.id}: missing or unsafe evidence/test path`);
      }
    }
    for (const path of item.evidence ?? []) {
      // A test path is never evidence. The gate's own closing line says so.
      if (!path.startsWith("docs/")) throw new Error(`${item.id}: evidence must be a reviewed document under docs/, not ${path}`);
      if (GATE_DOCUMENTS.has(path) || path.startsWith("docs/decisions/")) {
        throw new Error(`${item.id}: ${path} defines the gate and cannot be evidence that the gate was met`);
      }
    }
    if (item.status === "verified" && !item.evidence?.length) throw new Error(`${item.id}: verified requires reviewed evidence`);
  }
  return cases;
}

// docs/UPDATE-AUDIT.md step 8 already says what an evidence document is: a
// reviewed, sanitized file that records the tested commit, package SHA-256,
// platform, commands and results for THAT incident. Existence of a path proved
// none of it, so an unrelated document that happened to be in docs/ closed an
// incident. Two mechanical properties of that written rule, deliberately the
// only two: the document names the incident it closes, and it carries a
// package digest. The reviewer still has to read it; this only stops a pointer
// at a file that was never about this incident at all.
export function assertEvidenceDocuments(cases, read = (path) => readFileSync(resolve(root, path), "utf8")) {
  for (const item of cases) {
    for (const path of item.evidence ?? []) {
      let text;
      try { text = read(path); } catch { throw new Error(`${item.id}: evidence ${path} could not be read`); }
      if (!text.includes(item.id)) throw new Error(`${item.id}: evidence ${path} never names ${item.id}`);
      if (!/\b[0-9a-f]{64}\b/.test(text)) throw new Error(`${item.id}: evidence ${path} records no tested package SHA-256`);
    }
  }
  return cases;
}

// Deleting UPDATE-010 must not silently empty its own protection. Run against
// the real registry by the CLI and by test/update-audit.test.mjs; fixtures in
// that test are deliberately too small to satisfy it.
export function assertUndeferrableRegistered(cases) {
  const ids = new Set(cases.map((item) => item.id));
  for (const id of UNDEFERRABLE_INCIDENTS) {
    if (!ids.has(id)) throw new Error(`undeferrable incident ${id} is missing from the registry`);
  }
  return cases;
}

// The pinned contract is unchanged with one argument: no version supplied means
// no deferral is honoured and every non-verified incident blocks. That is also
// the safe default an older copy of this script falls back to, so a registry
// from the future can never unblock an older gate.
export function releaseBlockers(cases, version = null) {
  return cases.filter((item) => item.status !== "verified" && !currentlyDeferred(item, version));
}

// Every incident lands in exactly one of the three, and all three are printed.
// `closed` exists so that the visibility guarantee is a tested property of the
// adjudication rather than a habit of the print loop.
export function releaseAdjudication(cases, version) {
  return {
    held: releaseBlockers(cases, version),
    deferred: cases.filter((item) => currentlyDeferred(item, version)),
    closed: cases.filter((item) => item.status === "verified"),
  };
}

export const SOURCE_INVENTORY_V3_MINIMUM_PACKAGE_VERSION = "0.4.8";

/** Prevent the v3 inventory contract from reusing a published or retired candidate identity. */
export function assertSourceInventoryV3ReleaseVersion(version) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
    if (!match) throw new Error("package.json does not name an exact release version");
    return match.slice(1).map(Number);
  };
  const candidate = parse(version);
  const minimum = parse(SOURCE_INVENTORY_V3_MINIMUM_PACKAGE_VERSION);
  for (let index = 0; index < candidate.length; index++) {
    if (candidate[index] > minimum[index]) return version;
    if (candidate[index] < minimum[index]) break;
  }
  if (candidate.every((part, index) => part === minimum[index])) return version;
  if (version === "0.4.7") {
    throw new Error(
      "source inventory contract v3 cannot reuse retired held candidate identity 0.4.7; " +
      "that candidate was never public or live, but its identity remains bound to its earlier evidence; " +
      `the package version must be ${SOURCE_INVENTORY_V3_MINIMUM_PACKAGE_VERSION} or newer`,
    );
  }
  throw new Error(
    `source inventory contract v3 cannot ship under already-live package ${version}; ` +
    `the package version must be ${SOURCE_INVENTORY_V3_MINIMUM_PACKAGE_VERSION} or newer`,
  );
}

// Run independently: a failed auth test must not prevent the recovery tests
// from running. No shell, no output pipes, no inherited success from a later
// command. A signal, timeout, or spawn error is a failure too.
export function regressionEnvironment(env = process.env) {
  const keys = ["PATH", "HOME", "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "CI"];
  const clean = Object.fromEntries(keys.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]));
  // Packed install tests invoke npm through Node, so a Windows timeout cannot
  // leave a shell's npm grandchild holding the disposable prefix open.
  const npmCli = verifiedNpmCliPath(env.npm_execpath);
  if (npmCli) clean.npm_execpath = npmCli;
  return clean;
}

export function runRegressions(cases, run = (path, timeout) => spawnSync(process.execPath,
  ["--no-warnings", path], { cwd: root, env: regressionEnvironment(), stdio: "inherit", timeout }), platform = process.platform) {
  const results = [];
  for (const path of new Set(cases.flatMap((item) => item.tests))) {
    const runnable = cases.some((item) => item.tests.includes(path) && (!item.testPlatform || item.testPlatform === platform));
    if (!runnable) {
      results.push({ path, passed: null, skipped: true });
      console.log(`SKIP audit regression: ${path} requires another host platform`);
      continue;
    }
    const result = run(path, regressionTimeoutMs(path));
    results.push({ path, passed: result.status === 0 && !result.error && !result.signal });
    console.log(`${results.at(-1).passed ? "PASS" : "FAIL"} audit regression: ${path}`);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? "--release";
    if (!["--release", "--regressions", "--check"].includes(mode) || process.argv.length > 3) throw new Error("usage: audit-updates.mjs [--release|--regressions|--check]");
    // The only thing a deferral can be scoped to is the version being cut, and
    // the only way to change that is to edit package.json, which release.yml
    // already pins to the tag. No flag, no environment override.
    const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package.json does not name an exact release version");
    if (mode === "--release") assertSourceInventoryV3ReleaseVersion(version);
    const cases = assertEvidenceDocuments(assertUndeferrableRegistered(
      validateIncidents(JSON.parse(readFileSync(resolve(root, "docs/update-incidents.json"), "utf8")), undefined, version)));
    if (mode === "--check") console.log("ADVISORY MODE: --check never fails. The release gate is --release.");
    const results = mode === "--regressions" ? runRegressions(cases) : [];
    // Nothing that changes the verdict may be invisible. A deferral was already
    // printed in full; a `verified` row used to vanish silently, which made the
    // quieter path the one that left no trace in the receipt. Both are stated.
    const { held, deferred, closed } = releaseAdjudication(cases, version);
    for (const item of held) {
      console.log(`HELD ${item.id} [${item.scopes.join(",")}]: ${item.title} (${item.status})`);
      if (UNDEFERRABLE.has(item.id)) console.log("    undeferrable: this incident governs the release mechanism and cannot be scoped out");
    }
    if (deferred.length) {
      console.log(`\nDEFERRED for ${version}, not verified, shipping unproven:`);
      for (const item of deferred) {
        console.log(`  ${item.id} [${item.scopes.join(",")}]: ${item.title} (${item.status})`);
        console.log(`    blocked on: ${item.deferral.blocked_on}`);
        console.log(`    why: ${item.deferral.reason}`);
        console.log(`    unproven: ${item.deferral.unproven}`);
        if (item.deferral.review) console.log(`    review: ${item.deferral.review}`);
      }
    }
    if (closed.length) {
      console.log(`\nCLOSED on reviewed evidence, each document named here and shipped in the package:`);
      for (const item of closed) {
        console.log(`  ${item.id} [${item.scopes.join(",")}]: ${item.title}`);
        console.log(`    evidence: ${item.evidence.join(", ")}`);
        if (UNDEFERRABLE.has(item.id)) console.log("    this incident governs the release mechanism; read its evidence before trusting any other verdict");
      }
    }
    console.log(`\nIncident audit for ${version}: ${cases.length} tracked; ${held.length} awaiting closure; ` +
      `${deferred.length} deferred for ${version} and NOT verified; ${closed.length} closed on reviewed evidence.`);
    if (deferred.length) {
      // The mechanical form of RELEASE-GATE.md section 4: the receipt says what
      // it did NOT cover, without anyone hand-writing that section.
      console.log(`\nThis release does NOT cover:`);
      for (const item of deferred) console.log(`  - ${item.id} ${item.title} (${item.deferral.blocked_on})`);
    }
    console.log("Local tests are not field recovery proof. Deferred is not verified.");
    process.exitCode = results.some((r) => r.passed === false) || (mode === "--release" && held.length) ? 1 : 0;
  } catch (error) {
    console.error(`Incident audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
