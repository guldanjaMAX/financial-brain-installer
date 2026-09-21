import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileIdentityRule } from "../scripts/privacy-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const POSITION_SCRIPT = resolve(ROOT, "scripts/scan-privacy-positions.mjs");
const HISTORY_SCRIPT = resolve(ROOT, "scripts/scan-git-history-privacy.mjs");

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("position output locates only a synthetic row without exposing its term", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-position-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const term = "ZQWYZQWY";
  const rule = compileIdentityRule("synthetic", "word", false, term);
  const rulesPath = join(dir, "rules.json");
  const filePath = join(dir, "probe.txt");
  writeFileSync(rulesPath, JSON.stringify([rule]));
  writeFileSync(filePath, `ordinary line\n    ${term} appears here\n`);

  for (const prefixLength of [8, 12]) {
    const result = runNode(POSITION_SCRIPT, [
      "--file", filePath, "--rules-json", rulesPath,
      "--format", "position",
      ...(prefixLength === 8 ? [] : ["--hash-prefix", String(prefixLength)]),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${basename(filePath)}:2:5 ${rule.sha.slice(0, prefixLength)}\n`);
    for (const character of new Set(term.toLowerCase())) {
      assert.equal(result.stdout.toLowerCase().includes(character), false);
    }
  }
});

test("source columns survive punctuation and CRLF, while cross-line matches fail closed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-position-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rule = compileIdentityRule("synthetic", "word", false, "ZQWYZQWY NPNR");
  const rulesPath = join(dir, "rules.json");
  const filePath = join(dir, "probe.txt");
  writeFileSync(rulesPath, JSON.stringify([rule]));
  writeFileSync(filePath, "ordinary line\r\n\t(!) ZQWYZQWY NPNR,\r\n");
  const positioned = runNode(POSITION_SCRIPT, ["--file", filePath, "--rules-json", rulesPath]);
  assert.equal(positioned.status, 0, positioned.stderr);
  assert.equal(positioned.stdout, `probe.txt:2:6 ${rule.sha.slice(0, 8)}\n`);

  writeFileSync(filePath, "ZQWYZQWY\r\nNPNR\r\n");
  const spanning = runNode(POSITION_SCRIPT, ["--file", filePath, "--rules-json", rulesPath]);
  assert.equal(spanning.status, 1);
  assert.equal(spanning.stdout, "");
  assert.equal(spanning.stderr, "position scan could not safely locate the selected file's findings\n");
});

test("the existing history summary mode remains the default and unchanged", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  assert.equal(git("init", "-q").status, 0);
  writeFileSync(join(dir, "empty.txt"), "\n");
  assert.equal(git("add", "empty.txt").status, 0);
  assert.equal(git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
    "commit", "-q", "-m", "synthetic commit").status, 0);

  const args = ["--repo", dir, "--ref", "HEAD"];
  const defaultResult = runNode(HISTORY_SCRIPT, args);
  const explicitResult = runNode(HISTORY_SCRIPT, [...args, "--format", "summary"]);
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(defaultResult.stdout, explicitResult.stdout);
  assert.match(explicitResult.stdout, /^history inventory: 1 public refs, 1 commits, 3 objects\n/);
  assert.match(explicitResult.stdout, /^sanitized findings: 0 objects across 0 categories$/m);
});
