import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brainCliPrefix,
  commandPath,
  renderCliCommands,
  renderDiagnosis,
} from "../brain.mjs";
import {
  renderTechnicianPlan,
  technicianPlan,
} from "../operations/technician-setup.mjs";
import {
  renderSupportRecovery,
  supportRecovery,
} from "../support-recovery.mjs";

const windows = {
  platform: "win32",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  scriptPath: "C:\\Users\\client\\AppData\\Local\\FinancialBrain\\node_modules\\brain-installer\\brain.mjs",
};
const prefix = brainCliPrefix(windows);
const bareCommand = /\bbrain\s+(?:setup|doctor|update|drain|support|technician|eval|grants|forget|mcp-config|tools)\b/;

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

// These assertions bind the pure renderer checks above to the actual human
// output branches. Structured JSON deliberately stays byte-stable.
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
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
const fixtureRoot = mkdtempSync(join(tmpdir(), "brain-guidance-path-"));
try {
  const directory = join(fixtureRoot, "Owner's $HOME folder");
  mkdirSync(directory, { mode: 0o700 });
  const manifest = join(directory, "brain.manifest.json");
  writeFileSync(manifest, "{}\n", { mode: 0o600 });
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: fixtureRoot, USERPROFILE: fixtureRoot, NO_COLOR: "1" });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../brain.mjs", import.meta.url)), "eval", manifest, "--init"], { cwd: fixtureRoot, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const expected = renderCliCommands(`brain eval ${commandPath(manifest)}`);
  assert.ok(result.stdout.includes(expected), result.stdout);
  assert.ok(!/brain (?:forget|eval) \$\{(?:manifestPath|relative\()/.test(source), "concrete forget and eval paths must pass through commandPath");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
