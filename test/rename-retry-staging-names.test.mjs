import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertStagingSurvives } from "./fixtures/rename-retry-staging.mjs";

const driveUrl = new URL("../operations/drive-scheduler.mjs", import.meta.url).href;
const daemonUrl = new URL("../operations/whatsapp-daemon.mjs", import.meta.url).href;
const verifierUrl = new URL("../scripts/verify-package-bundles.mjs", import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if ([driveUrl, daemonUrl].includes(url)) return { ...loaded, source: `${loaded.source}\nexport { stageAtomicWrite };\n` };
  if (url !== verifierUrl) return loaded;
  const source = String(loaded.source).replaceAll("\r\n", "\n");
  const marker = "main(process.argv.slice(2)).catch((error) => {";
  assert.equal(source.split(marker).length, 2);
  return { ...loaded, source: source.slice(0, source.indexOf(marker)) + "\nexport { writeManifest };\n" };
} });
const drive = await import(driveUrl);
const daemon = await import(daemonUrl);
const verifier = await import(verifierUrl);
const { saveCaptureState } = await import("../connectors/imessage.mjs");
const { persistReceiptArtifacts } = await import("../scripts/field-prepare.mjs");
const { buildDailyRefreshDefinition, createNativeDailyRefreshAdapter } = await import("../operations/daily-refresh-scheduler.mjs");

const sites = [
  { name: "message capture", write(path) { saveCaptureState(path, { version: 1, last_rowid: 0, sessionizer: [] }); } },
  { name: "source scheduler", write(path) { const staged = drive.stageAtomicWrite(path, "synthetic definition\n"); staged.commit(); } },
  { name: "capture daemon", write(path) { const staged = daemon.stageAtomicWrite(path, "synthetic definition\n"); staged.commit(); } },
  { name: "field receipt", fixed: true, write(path) {
    persistReceiptArtifacts({ status: "running" }, { receiptPath: path, checklistPath: join(dirname(path), "checklist.md") }, { final: true });
  } },
  { name: "bundle manifest", fixed: true, write(path) { verifier.writeManifest(path, { schema_version: 1, bundles: [] }, true); } },
];

for (const site of sites) for (const residue of [false, true]) {
  test(`${site.name} staging name: ${residue ? "retained legacy residue" : "empty directory"}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-staging-residue-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const path = join(root, "state.json");
    const now = Date.now;
    Date.now = () => 1700000000000;
    const stale = site.fixed ? `${path}.tmp` : `${path}.tmp-${process.pid}-${Date.now()}`;
    const bytes = Buffer.from("retained earlier attempt\n");
    if (residue) fs.writeFileSync(stale, bytes, { flag: "wx", mode: 0o600 });
    const identity = residue ? fs.lstatSync(stale, { bigint: true }) : null;
    try { site.write(path); }
    finally { Date.now = now; }
    assert.ok(fs.existsSync(path));
    if (residue) assertStagingSurvives(stale, identity, bytes);
  });
}

for (const platform of ["darwin", "win32"]) for (const residue of [false, true]) {
  test(`${platform} daily native staging name: ${residue ? "retained legacy residue" : "empty directory"}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-daily-native-residue-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = { id: "v1-0123456789abcdef", principal: platform === "win32" ? "S-1-5-21-1000" : "uid:501" };
    const plan = { identity, manifest_path: platform === "win32" ? "C:\\Fixture\\manifest.json" : "/fixture/manifest.json",
      manifest_path_hash: "sha256:path", manifest_content_hash: "sha256:content", source_plan_hash: "sha256:sources",
      cron: "0 9 * * *", timezone: "America/Phoenix", max_runtime_minutes: 45, enabled: true, ready: true, sources: [] };
    const definition = buildDailyRefreshDefinition(plan, { platform,
      nodePath: platform === "win32" ? "C:\\Fixture\\node.exe" : "/fixture/node",
      brainPath: platform === "win32" ? "C:\\Fixture\\brain.mjs" : "/fixture/brain.mjs",
      runnerPath: platform === "win32" ? "C:\\Fixture\\daily-refresh-run.mjs" : "/fixture/daily-refresh-run.mjs" });
    const stale = platform === "darwin"
      ? join(root, "Library", "LaunchAgents", `com.financialbrain.daily.${identity.id}.plist.tmp-${process.pid}`)
      : join(root, ".brain", "schedules", `daily-${identity.id}-${process.pid}.xml`);
    fs.mkdirSync(dirname(stale), { recursive: true });
    const bytes = Buffer.from("retained earlier attempt\n");
    if (residue) fs.writeFileSync(stale, bytes, { flag: "wx", mode: 0o600 });
    const previous = residue ? fs.lstatSync(stale, { bigint: true }) : null;
    let installs = 0;
    const adapter = createNativeDailyRefreshAdapter({ platform, home: root, uid: 501,
      spawn(_command, args) {
        if (platform === "win32") {
          if (args.includes("/Create")) { installs++; return { status: 0 }; }
          if (args.includes("/FO")) return { status: 0, stdout: '"\\Other\\Task","N/A","Ready"\r\n' };
          return { status: 1, stdout: "", stderr: "synthetic missing task" };
        }
        if (args[0] === "bootstrap") installs++;
        return { status: args[0] === "print" ? 113 : 0, stdout: "" };
      },
    });
    adapter.install(definition);
    assert.equal(installs, 1);
    if (residue) assertStagingSurvives(stale, previous, bytes);
  });
}
