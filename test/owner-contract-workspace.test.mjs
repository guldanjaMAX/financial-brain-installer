import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as workspace from "../operations/claude-workspace.mjs";
import * as cli from "../brain.mjs";
import { reviewedSkillContent } from "../operations/claude-skill.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const BEGIN = '<!-- BEGIN Financial Brain answer rules (written by Financial Brain setup and update; running either again replaces this section and keeps your "My accounts" lines) -->';
const END = "<!-- END Financial Brain answer rules -->";
const CODEX = "<!-- financial-brain-installer:codex-workspace:v1 -->";
const PLACEHOLDER = "- ****NNNN = (business | personal), (checking | savings | card | loan | investment), (owner's name for it)";
const ACCOUNTS = ["- ****0001 = business checking", "- ****0002 = personal card"];
const ACCOUNT_HEADING = "## My accounts (fill in once, after the owner confirms)";
const SAVE_HEADING = "## Financial Brain: at the end of a working session";
const hashes = {
  "answer-contract-v1.md": "09f579cfd5a6fbbbb87af184779126c4c0381ac7351b145adc91c14de625dcba",
  "money-rules-v2.md": "a7b1fef5818ba27c5db9c7236e50f024ddf812494d6591fe7b41f7d47040cffd",
  "money-rules-v2-windows.md": "f1af893b702318671f4dcaa4ef64e468386c95561547521266b956c5b6693de7",
};
const options = { brainCliPath: resolve("/fixture/brain.mjs"), nodePath: process.execPath };
const count = (text, part) => text.split(part).length - 1;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const template = (name) => readFileSync(new URL(`../templates/owner-contract/${name}`, import.meta.url), "utf8");
const writers = [
  ["claude", "CLAUDE.md", workspace.CLAUDE_WORKSPACE_MARKER, (...args) => workspace.writeClaudeWorkspaceGuide(...args)],
  ["codex", "AGENTS.md", CODEX, (...args) => workspace.writeCodexWorkspaceGuide(...args)],
];
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-owner-contract-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, manifest: join(root, "brain.manifest.json") };
}
function moneyInner(name) {
  const lines = template(name).split("\n");
  const begin = lines.findIndex((line) => line.startsWith("<!-- BEGIN Financial Brain money-question rules"));
  const end = lines.indexOf("<!-- END Financial Brain money-question rules -->");
  assert.ok(begin >= 0 && end > begin, "the input marker decision was reached");
  return lines.slice(begin + 1, end).join("\n") + "\n";
}
function assertPrivateClean(root, target) {
  assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
}

test("a: verbatim inputs, platform control, assistant substitution and one session-save rule", () => {
  for (const [name, expected] of Object.entries(hashes)) assert.equal(sha(template(name)), expected);
  assert.equal(workspace.OWNER_RULES_BEGIN, BEGIN);
  assert.equal(workspace.OWNER_RULES_END, END);
  assert.equal(workspace.CODEX_WORKSPACE_MARKER, CODEX);
  for (const platformName of ["darwin", "linux", "win32"]) {
    const text = workspace.renderOwnerRulesSection({ platformName });
    const inner = moneyInner(platformName === "win32" ? "money-rules-v2-windows.md" : "money-rules-v2.md");
    assert.equal(text, `${BEGIN}\n${template("answer-contract-v1.md")}\n${inner}${END}\n`);
    assert.equal(text.includes("ls -d ~/.financial-brain-v0.4."), platformName !== "win32");
    const codex = workspace.renderOwnerRulesSection({ platformName, assistant: "codex" });
    assert.equal(codex, text.replace("in this CLAUDE.md", "in this AGENTS.md"));
    assert.equal(count(codex, "in this AGENTS.md"), 1);
    assert.equal(count(text, SAVE_HEADING), 1);
    assert.equal(count(codex, SAVE_HEADING), 1);
  }
});

for (const [assistant, filename, marker, write] of writers) {
  for (const platformName of ["darwin", "win32"]) {
    test(`b/h: six setup and update reruns preserve bytes, mtime and workspace (${assistant}, ${platformName})`, (t) => {
      const { root, manifest } = fixture(t);
      const target = join(root, filename);
      for (const existingOnly of [false, true]) {
        if (existingOnly) {
          writeFileSync(target, `${marker}\n# Older guide\n\n${workspace.renderOwnerRulesSection({ platformName, assistant, accountLines: ACCOUNTS })}`);
        }
        let bytes, mtime;
        for (let i = 0; i < 6; i++) {
          const result = write(manifest, { ...options, platformName, existingOnly });
          assert.equal(result.workspace, root);
          assert.equal(result.path, target);
          assert.equal(result.status, i === 0 ? "written" : "verified");
          assert.equal(result.changed, i === 0);
          const content = readFileSync(target, "utf8");
          if (i === 0) { bytes = content; mtime = statSync(target).mtimeMs; }
          assert.equal(content, bytes);
          assert.equal(statSync(target).mtimeMs, mtime);
          assertPrivateClean(root, target);
          if (existingOnly) for (const line of ACCOUNTS) assert.equal(count(content, line), 1);
          if (assistant === "claude") assert.ok(content.length < 40_000);
          else assert.ok(Buffer.byteLength(content) <= 32_768);
        }
      }
    });
  }
  test(`c: account lines survive with and without the placeholder; legacy guides gain it (${assistant})`, (t) => {
    const { root, manifest } = fixture(t);
    const target = join(root, filename);
    for (const keepPlaceholder of [true, false]) {
      writeFileSync(target, `${marker}\n# Older guide\n\n${workspace.renderOwnerRulesSection({ assistant })}`.replace(
        PLACEHOLDER, [...ACCOUNTS, ...(keepPlaceholder ? [PLACEHOLDER] : [])].join("\n"),
      ));
      assert.equal(count(readFileSync(target, "utf8"), ACCOUNTS[0]), 1, "account-preservation decision receives owner lines");
      for (let i = 0; i < 6; i++) {
        assert.equal(write(manifest, options).status, i === 0 ? "written" : "verified");
        const content = readFileSync(target, "utf8");
        for (const line of ACCOUNTS) assert.equal(count(content, line), 1);
        assert.ok(content.indexOf(ACCOUNTS[0]) < content.indexOf(ACCOUNTS[1]));
        assert.equal(content.includes(PLACEHOLDER), false);
      }
    }
    writeFileSync(target, `${marker}\n# Pre-section guide\n`);
    assert.equal(write(manifest, options).status, "written");
    assert.equal(count(readFileSync(target, "utf8"), PLACEHOLDER), 1);
  });
  test(`d: damaged sections preserve all bytes, with a well-formed control (${assistant})`, (t) => {
    const { root, manifest } = fixture(t);
    const target = join(root, filename);
    const section = `${BEGIN}\n${ACCOUNT_HEADING}\n${PLACEHOLDER}\n${END}\n`;
    const damaged = [
      section.replace(`${END}\n`, ""), section.replace(`${BEGIN}\n`, ""),
      `${BEGIN}\n${section}`, `${END}\n${BEGIN}\n`,
      section.replace(PLACEHOLDER, "owner account note without a mask"),
      section.replace(PLACEHOLDER, `${ACCOUNTS[0]}\u0001`),
    ];
    for (const existingOnly of [false, true]) for (const bad of damaged) {
      const bytes = `${marker}\r\n# Older guide\r\n${bad}`;
      writeFileSync(target, bytes);
      assert.ok(readFileSync(target, "utf8").startsWith(marker), "managed-file decision reached");
      const result = write(manifest, { ...options, existingOnly });
      assert.equal(result.status, "preserved_damaged_section");
      assert.equal(result.changed, false);
      assert.equal(result.workspace, root);
      assert.equal(readFileSync(target, "utf8"), bytes);
      assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
      writeFileSync(target, `${marker}\n${section}`);
      assert.equal(write(manifest, { ...options, existingOnly }).status, "written");
    }
  });
  test(`e/f/h: unrelated, symlink and hard link stay intact; update missing is skipped (${assistant})`, (t) => {
    const { root, manifest } = fixture(t);
    const target = join(root, filename);
    const skipped = write(manifest, { ...options, existingOnly: true });
    assert.equal(skipped.status, "skipped_missing");
    assert.equal(skipped.workspace, root);
    assert.equal(existsSync(target), false);
    assert.equal(write(manifest, options).status, "written", "setup is the missing-file green control");
    rmSync(target);
    for (const kind of ["unrelated", "symlink", "dangling-symlink", "hard-link"]) {
      const source = join(root, `source-${kind}`);
      const bytes = kind === "unrelated" ? "owner instructions\r\n" : `${marker}\n# Old managed guide\n`;
      if (kind === "unrelated") writeFileSync(target, bytes);
      else {
        if (kind !== "dangling-symlink") writeFileSync(source, bytes);
        if (kind === "hard-link") linkSync(source, target);
        else symlinkSync(source, target);
      }
      const stat = lstatSync(target);
      assert.ok(kind === "unrelated" || stat.isSymbolicLink() || stat.nlink > 1, "unsafe-file decision receives the intended fixture");
      for (const existingOnly of [false, true]) {
        const result = write(manifest, { ...options, existingOnly });
        assert.equal(result.status, kind === "unrelated" ? "preserved_unrelated_existing_file" : "preserved_unsafe_existing_file");
        assert.equal(result.changed, false);
        assert.equal(result.workspace, root);
        assert.equal(lstatSync(target).ino, stat.ino);
        if (kind === "dangling-symlink") assert.equal(existsSync(source), false);
        else assert.equal(readFileSync(target, "utf8"), bytes);
      }
      rmSync(target);
    }
  });
}

test("merge uses whole marker lines, preserves surroundings, normalizes CRLF and refuses damage before render", () => {
  let renders = 0;
  const render = ({ accountLines }) => { renders++; return workspace.renderOwnerRulesSection({ accountLines }); };
  const old = `prefix\r\n${BEGIN}\r\n${ACCOUNT_HEADING}\r\n${ACCOUNTS.join("\r\n")}\r\n${END}\r\nsuffix\r\n`;
  const merged = workspace.mergeOwnerRules(old, render);
  assert.equal(renders, 1);
  assert.equal(merged.status, "merged");
  assert.equal(merged.content, `prefix\n${workspace.renderOwnerRulesSection({ accountLines: ACCOUNTS })}suffix\n`);
  const broken = workspace.mergeOwnerRules(`${BEGIN}\n`, render);
  assert.equal(broken.status, "damaged");
  assert.equal(broken.content, `${BEGIN}\n`);
  assert.equal(renders, 1, "damaged marker path must stop before rendering");
  const legacy = workspace.mergeOwnerRules(`prefix with ${BEGIN} inline\n`, render);
  assert.equal(renders, 2);
  assert.equal(legacy.content, `prefix with ${BEGIN} inline\n\n${workspace.renderOwnerRulesSection()}`);
});

test("g: session folder classifier uses cloud precedence, platform case and path boundaries", () => {
  const home = "/Users/owner";
  const brainFolder = `${home}/Financial Brain`;
  const risky = [
    ["Desktop", "desktop"], ["desktop/x", "desktop"], ["Downloads/y", "downloads"],
    ["Library/Mobile Documents/com~apple~CloudDocs/z", "synced"],
    ["Library/CloudStorage/GoogleDrive-a/My Drive", "synced"], ["Dropbox/b", "synced"],
    ["Library/Application Support/CloudDocs", "synced"], ["Library/FileProvider/x", "synced"],
    ["Library/Containers/com.apple.CloudDocs/x", "synced"], ["iCloud Drive/x", "synced"],
    ["Desktop/Box/x", "synced"],
  ];
  for (const [path, kind] of risky) assert.deepEqual(workspace.classifySessionFolder(`${home}/${path}`, { home, platform: "darwin", brainFolder }), { kind });
  for (const folder of [brainFolder, `${brainFolder}/sub`, `${home}/work`, home, `${home}/Desktop-other`]) {
    assert.equal(workspace.classifySessionFolder(folder, { home, platform: "darwin", brainFolder }), null);
  }
  assert.equal(workspace.classifySessionFolder(`${home}/Desktop/Brain/sub`, { home, platform: "darwin", brainFolder: `${home}/Desktop/Brain` }), null);
  assert.equal(workspace.classifySessionFolder(`${home}/desktop/x`, { home, platform: "linux", brainFolder }), null);
  const windows = { home: "C:\\Users\\o", platform: "win32", brainFolder: "C:\\Users\\o\\Financial Brain" };
  for (const [folder, kind] of [["OneDrive\\Desktop", "synced"], ["OneDrive - Business\\x", "synced"], ["Downloads", "downloads"]]) {
    assert.deepEqual(workspace.classifySessionFolder(win32.join(windows.home, folder), windows), { kind });
  }
  assert.equal(workspace.classifySessionFolder("c:/users/O/FINANCIAL BRAIN/sub", windows), null);
});

async function capture(run) {
  const messages = [];
  const previous = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(previous)) console[name] = (...parts) => messages.push(parts.join(" "));
  try { await run(); } finally { Object.assign(console, previous); }
  return messages.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}
async function setup(t, wired, extra = {}) {
  const { root } = fixture(t);
  const manifest = join(root, "Financial Brain", "brain.manifest.json");
  const events = [];
  const keyPath = join(root, "fixture-admin-key");
  writeFileSync(keyPath, "fixture-only-value", { mode: 0o600 });
  const output = await capture(() => cli.cmdSetup(manifest, {
    flags: { name: "Fixture Brain", slug: "fixture-brain" },
    platform: "darwin", home: root, sessionFolder: join(root, extra.risky ? "Desktop" : "work"),
    setupWorkerScriptExists: async () => false,
    ask: async (question, fallback) => /folder to load/i.test(question) ? "" : (fallback || ""),
    doctorRunAll: async () => [],
    listCloudflareAccounts: async () => [{ id: "a".repeat(32), name: "Owner account" }],
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "generated", value: readFileSync(keyPath, "utf8"), plan: { backend: "file", path: keyPath } }),
    cmdVerify: async () => events.push("verify"),
    cmdProvision: async (path) => {
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.infrastructure.cloudflare.d1_database_id = "fixture-d1";
      writeFileSync(path, JSON.stringify(value));
    },
    cmdMigrate: async () => {},
    cmdDeploy: async (path) => {
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.brain.domain = "brain.example.invalid";
      writeFileSync(path, JSON.stringify(value));
    },
    cmdSecrets: async () => {}, cmdDrain: async () => {}, cmdHealth: async () => {},
    wireAgents: async () => { events.push("wire"); return { wired, failures: [] }; },
    backlogCount: async () => 0,
    installedManifestOptions: { home: root, stateDirectory: join(root, "installed-state") },
    ...options, ...extra,
  }));
  assert.deepEqual(events, ["verify", "wire"], "setup must reach assistant wiring");
  return { output, root: dirname(manifest), manifest };
}

test("f/g: Codex-only setup writes AGENTS and names its home; dual setup is the green control and warns once", async (t) => {
  const solo = await setup(t, ["Codex"]);
  const agents = readFileSync(join(solo.root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(CODEX));
  assert.equal(count(agents, "in this AGENTS.md"), 1);
  assert.equal(count(agents, "in this CLAUDE.md"), 0);
  assert.equal(existsSync(join(solo.root, "CLAUDE.md")), false);
  assert.ok(solo.output.includes(`For Brain conversations, open Codex in this folder: ${cli.displayPathForTesting(solo.root, process.cwd())}`));
  assert.equal(count(solo.output, "This conversation is running in"), 0);
  const both = await setup(t, ["Claude Code", "Codex"], { risky: true });
  for (const file of ["CLAUDE.md", "AGENTS.md"]) assert.ok(existsSync(join(both.root, file)));
  assert.equal(count(both.output, "This conversation is running in your Desktop folder"), 1);
  assert.equal(count(both.output, "For Brain conversations, open Claude Code in this folder:"), 1);
  const safe = await setup(t, ["Claude Code", "Codex"]);
  assert.equal(count(safe.output, "This conversation is running in"), 0);
});

test("setup warns without failing for a damaged guide and every preserved or failed Codex write", async (t) => {
  for (const status of ["preserved_damaged_section", "preserved_unrelated_existing_file", "preserved_unsafe_existing_file", "throw"]) {
    let writes = 0;
    const result = await setup(t, ["Codex"], {
      writeCodexWorkspaceGuide: (manifest) => {
        writes++;
        if (status === "throw") throw new Error("synthetic write failure");
        return { status, path: join(dirname(manifest), "AGENTS.md"), workspace: dirname(manifest) };
      },
    });
    assert.equal(writes, 1, "the Codex write decision must be reached");
    assert.match(result.output, /AGENTS\.md/);
    assert.equal(count(result.output, "Codex owner workspace ready"), 0);
    if (status === "preserved_damaged_section") assert.match(result.output, /nothing was changed.*My accounts.*BEGIN.*END.*rerun.*setup/is);
  }
  const good = await setup(t, ["Codex"]);
  assert.equal(count(good.output, "Codex owner workspace ready"), 1);
});

async function update(t, { wired = ["Codex"], risky = false, createGuide = false } = {}) {
  const { root } = fixture(t);
  const brainFolder = join(root, "Financial Brain");
  mkdirSync(brainFolder);
  const manifest = join(brainFolder, "brain.manifest.json");
  const events = [], finish = [], messages = [], writes = [];
  writeFileSync(manifest, JSON.stringify({
    client: { slug: "fixture" }, brain: { version: "0.4.7", domain: "brain.example.invalid" },
    infrastructure: { cloudflare: { account_id: "a".repeat(32), auth_profile: `financial-brain-${"b".repeat(24)}`, storage: "d1", d1_database_id: "11111111-2222-4333-8444-555555555555" } },
  }));
  if (createGuide) for (const [, file, marker] of writers) writeFileSync(join(brainFolder, file), `${marker}\n# Earlier guide\n`);
  const result = await cli.cmdUpdate(manifest, {
    lifecycleLockHeld: true, home: root, platform: "darwin",
    sessionFolder: join(root, risky ? "Desktop" : "work"),
    installedManifestOptions: { home: root, stateDirectory: join(root, "installed-state") },
    discoverInstalledManifest: () => ({ path: manifest, source: "explicit" }),
    readUpdateBacklog: async () => { events.push("backlog"); return { pending: 0 }; },
    adoptCloudflareAuthProfile: async () => {},
    withCloudflareControl: async (run) => run(),
    cmdVerify: async () => events.push("verify"),
    cmdUpgrade: async () => { events.push("upgrade"); return { updated: true }; },
    reconcileExistingOwnerAgents: async () => { events.push("wire"); return { wired, failures: [] }; },
    resolveUpdateAgentBaseUrl: async () => "https://brain.example.invalid",
    writeClaudeWorkspaceGuideAfterUpdate: (path, opts) => { writes.push(["claude", opts]); return workspace.writeClaudeWorkspaceGuide(path, opts); },
    writeCodexWorkspaceGuideAfterUpdate: (path, opts) => { writes.push(["codex", opts]); return workspace.writeCodexWorkspaceGuide(path, opts); },
    installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
    reportAgentRefreshOk: () => {}, reportAgentRefreshInfo: () => {}, reportAgentRefreshWarning: (m) => messages.push(m),
    reportWorkspaceGuideRefreshOk: (m) => messages.push(m), reportWorkspaceGuideRefreshInfo: (m) => messages.push(m), reportWorkspaceGuideRefreshWarning: (m) => messages.push(m),
    reportSkillRefreshOk: () => {}, reportSkillRefreshWarning: (m) => messages.push(m),
    reportUpdateFinish: (message) => finish.push(message), ...options,
  });
  assert.deepEqual(result, { updated: true });
  assert.deepEqual(events, ["backlog", "verify", "upgrade", "wire"], "update reaches verified assistant reconciliation");
  return { root: brainFolder, writes, finish, messages };
}

test("f/g: update refresh is gated on assistant proof, skips missing AGENTS, and only risky closing gains one line", async (t) => {
  const missing = await update(t);
  assert.deepEqual(missing.writes.map(([agent]) => agent), ["codex"]);
  assert.equal(missing.writes[0][1].existingOnly, true);
  assert.equal(existsSync(join(missing.root, "AGENTS.md")), false);
  const control = await update(t, { wired: ["Claude Code", "Codex"], createGuide: true, risky: true });
  assert.deepEqual(control.writes.map(([agent]) => agent), ["claude", "codex"]);
  for (const [, file] of writers) assert.ok(readFileSync(join(control.root, file), "utf8").includes(BEGIN));
  assert.equal(control.messages.filter((m) => /CLAUDE\.md refreshed/i.test(m)).length, 1);
  assert.equal(control.messages.filter((m) => /AGENTS\.md refreshed/i.test(m)).length, 1);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const unchangedClosing = `Done. Your Brain is now on version ${version} and passed its checks.\n` +
    "One last step: quit Claude Code (and Codex, if you use it) and open it again, so it connects to the updated Brain.\n" +
    "In Claude Code type /exit, then claude --continue.\nThen ask: check my Brain.";
  assert.deepEqual(missing.finish, [unchangedClosing]);
  assert.deepEqual(control.finish, [unchangedClosing + `\nNext time, open Claude Code (or Codex) in your Financial Brain folder, ${cli.displayPathForTesting(control.root, process.cwd())}. This conversation runs in your Desktop folder, which can be tidied away or synced.`]);
  const unverified = await update(t, { wired: [], createGuide: true });
  assert.equal(unverified.writes.length, 0);
  assert.equal(readFileSync(join(unverified.root, "AGENTS.md"), "utf8"), `${CODEX}\n# Earlier guide\n`);
});

test("i: skill insertion is exact, bounded and inert under Windows command rendering", () => {
  const skillPath = new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url);
  const skill = readFileSync(skillPath, "utf8");
  assert.equal(count(skill, "## Answer from the Brain\n"), 1);
  const section = skill.slice(skill.indexOf("## Answer from the Brain\n"), skill.indexOf("## Credential boundary\n"));
  assert.equal(sha(section), "1d81f55099c6f2d4f853eb2e48915963fd708901995d2a8ba1cf7432d315e528");
  assert.ok(Buffer.byteLength(skill) <= 65_000);
  for (const platform of ["darwin", "win32"]) {
    const rendering = { platform, nodePath: "C:\\Runtime\\node.exe", scriptPath: "C:\\Brain\\brain.mjs", env: {}, existsSync: () => false };
    assert.equal(renderCliCommands(section, rendering), section);
    assert.ok(reviewedSkillContent(skillPath, rendering).includes(section));
    if (platform === "win32") assert.notEqual(renderCliCommands("brain doctor", rendering), renderCliCommands("brain doctor", { platform: "darwin" }), "Windows rendering control actually rewrites commands");
  }
});


test("renderer validates kit markers, placeholder and the single Codex substitution with valid controls", () => {
  const originalRead = fs.readFileSync;
  const valid = template("money-rules-v2.md");
  const lines = valid.split("\n");
  const begin = lines[0], end = lines.at(-2);
  const invalid = [
    valid.replace(begin, ""), valid.replace(end, ""), `${begin}\n${valid}`,
    `${end}\n${valid.replace(end, "")}`, valid.replace(PLACEHOLDER, ""),
    valid.replace(PLACEHOLDER, `${PLACEHOLDER}\n${PLACEHOLDER}`),
    valid.replace("in this CLAUDE.md", "in this document"),
    valid.replace("in this CLAUDE.md", "in this CLAUDE.md and in this CLAUDE.md"),
  ];
  for (const text of invalid) {
    let reads = 0;
    const replacement = mock.method(fs, "readFileSync", (path, ...args) => {
      if (String(path).endsWith("/money-rules-v2.md")) { reads++; return text; }
      return originalRead(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => workspace.renderOwnerRulesSection({ platformName: "darwin", assistant: "codex" }));
      assert.equal(reads, 1, "invalid template must reach the actual template reader");
    } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(workspace.renderOwnerRulesSection({ platformName: "darwin", assistant: "codex" }).includes("in this AGENTS.md"));
  }
});

test("atomic writer cleans its temporary file after write, fsync and rename failures with success controls", (t) => {
  const { root, manifest } = fixture(t);
  for (const [, filename, , write] of writers) for (const method of ["writeFileSync", "fsyncSync", "renameSync"]) {
    const target = join(root, filename);
    let reached = 0;
    const replacement = mock.method(fs, method, () => { reached++; throw new Error("synthetic atomic failure"); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => write(manifest, options), /synthetic atomic failure/);
      assert.equal(reached, 1, "the injected atomic failure point was reached");
      assert.equal(existsSync(target), false);
      assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
    } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(write(manifest, options).status, "written");
    assertPrivateClean(root, target);
    rmSync(target);
  }
});

test("Windows absolute locators retain their native spelling in the shared invocation", () => {
  const manifest = "C:\\Users\\owner\\Financial Brain\\brain.manifest.json";
  const brainCliPath = "C:\\Program Files\\Brain\\brain.mjs";
  const nodePath = "C:\\Program Files\\Node\\node.exe";
  const guide = workspace.renderClaudeWorkspaceGuide(manifest, { platformName: "win32", brainCliPath, nodePath });
  assert.ok(guide.includes(`${JSON.stringify(nodePath)} ${JSON.stringify(brainCliPath)}`));
  assert.ok(guide.includes(manifest));
  assert.throws(() => workspace.renderClaudeWorkspaceGuide(manifest, { brainCliPath: "/fixture/unsafe\npath" }));
});

test("atomic cleanup still removes the temporary file when closing it fails", (t) => {
  const { root, manifest } = fixture(t);
  const originalClose = fs.closeSync;
  let closes = 0;
  const replacement = mock.method(fs, "closeSync", (fd) => {
    closes++;
    originalClose(fd);
    throw new Error("synthetic close failure");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => workspace.writeClaudeWorkspaceGuide(manifest, options));
    assert.ok(closes > 0, "the temporary-file close decision was reached");
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(workspace.writeClaudeWorkspaceGuide(manifest, options).status, "written");
  assertPrivateClean(root, join(root, "CLAUDE.md"));
});

test("both update refreshers report damage without changing bytes and refresh legacy controls", (t) => {
  const { root, manifest } = fixture(t);
  for (const [assistant, filename, marker, write] of writers) {
    const target = join(root, filename);
    const refresh = assistant === "codex" ? cli.refreshCodexWorkspaceGuideAfterUpdate : cli.refreshClaudeWorkspaceGuideAfterUpdate;
    const optionName = assistant === "codex" ? "writeCodexWorkspaceGuide" : "writeClaudeWorkspaceGuide";
    let reached = 0;
    const warnings = [], good = [];
    const refreshOptions = {
      ...options, platformName: "win32",
      [optionName]: (path, opts) => {
        reached++;
        assert.equal(opts.existingOnly, true);
        assert.equal(opts.platformName, "win32");
        return write(path, opts);
      },
      reportWarning: (m) => warnings.push(m), reportOk: (m) => good.push(m), reportInfo: () => {},
    };
    const damaged = `${marker}\n${BEGIN}\n`;
    writeFileSync(target, damaged);
    assert.equal(refresh(manifest, refreshOptions).status, "preserved_damaged_section");
    assert.equal(reached, 1, "update reaches the managed-section decision");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /nothing was changed.*My accounts.*BEGIN.*END.*rerun setup/is);
    assert.equal(readFileSync(target, "utf8"), damaged);
    writeFileSync(target, `${marker}\n# Pre-section guide\n`);
    assert.equal(refresh(manifest, refreshOptions).status, "written");
    assert.equal(reached, 2);
    assert.equal(good.length, 1);
    assert.equal(count(readFileSync(target, "utf8"), PLACEHOLDER), 1);
    assert.equal(readFileSync(target, "utf8").includes("ls -d ~/.financial-brain-v0.4."), false);
  }
});

test("Claude setup names a damaged section and continues; a managed guide is the green control", async (t) => {
  let writes = 0;
  const result = await setup(t, ["Claude Code"], {
    writeClaudeWorkspaceGuide: (manifest) => {
      writes++;
      return { status: "preserved_damaged_section", path: join(dirname(manifest), "CLAUDE.md") };
    },
  });
  assert.equal(writes, 1);
  assert.match(result.output, /CLAUDE\.md.*nothing was changed.*My accounts.*BEGIN.*END.*rerun setup/is);
  assert.equal(count(result.output, "Claude Code owner workspace ready"), 0);
  const good = await setup(t, ["Claude Code"]);
  assert.equal(count(good.output, "Claude Code owner workspace ready"), 1);
});

test("merge ignores exactly one trailing CR on marker lines, with a valid CRLF control", () => {
  let renders = 0;
  const render = ({ accountLines }) => { renders++; return workspace.renderOwnerRulesSection({ accountLines }); };
  const damaged = `${BEGIN}\r\n${ACCOUNT_HEADING}\r\n${PLACEHOLDER}\r\n${END}\r\r\n`;
  assert.equal(workspace.mergeOwnerRules(damaged, render).status, "damaged");
  assert.equal(renders, 0, "a missing exact END marker must stop before render");
  assert.equal(workspace.mergeOwnerRules(damaged.replace(`${END}\r\r\n`, `${END}\r\n`), render).status, "merged");
  assert.equal(renders, 1);
});


test("merge retains the rendered section's final newline when the older END had none", () => {
  let renders = 0;
  const render = ({ accountLines }) => { renders++; return workspace.renderOwnerRulesSection({ accountLines }); };
  const old = `${BEGIN}\n${ACCOUNT_HEADING}\n${PLACEHOLDER}\n${END}`;
  const expected = workspace.renderOwnerRulesSection();
  assert.equal(workspace.mergeOwnerRules(old, render).content, expected);
  assert.equal(renders, 1, "replacement reached the renderer");
  assert.equal(workspace.mergeOwnerRules(`${old}\n`, render).content, expected);
  assert.equal(renders, 2);
});
