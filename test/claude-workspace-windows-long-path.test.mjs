import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_WORKSPACE_MARKER,
  windowsWorkspaceAttributesSafe,
  writeClaudeWorkspaceGuide,
} from "../operations/claude-workspace.mjs";

const windowsOnly = { skip: process.platform !== "win32" ? "requires native Windows PowerShell attributes" : false };

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-wp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function nestedFolder(root, minimumLength) {
  let folder = root;
  while (folder.length < minimumLength) folder = join(folder, "workspace-" + "x".repeat(30));
  mkdirSync(folder, { recursive: true });
  return folder;
}

function pathsThroughRoot(file, root) {
  const paths = [file];
  while (paths.at(-1) !== root) {
    const parent = dirname(paths.at(-1));
    assert.notEqual(parent, paths.at(-1), "the fixture path must stay under its temporary root");
    paths.push(parent);
  }
  return paths;
}

test("Windows attribute script covers drive, UNC, long and already-prefixed path classes", () => {
  const rows = [
    { name: "short drive path", path: String.raw`C:\Owner\Brain\CLAUDE.md` },
    { name: "long drive path", path: `C:\\Owner\\${"workspace-x\\".repeat(30)}CLAUDE.md` },
    { name: "UNC path", path: String.raw`\\server\share\Owner\Brain\CLAUDE.md` },
    { name: "prefixed drive path", path: String.raw`\\?\C:\Owner\Brain\CLAUDE.md` },
    { name: "prefixed UNC path", path: String.raw`\\?\UNC\server\share\Owner\Brain\CLAUDE.md` },
  ];
  for (const row of rows) {
    let call = null;
    const accepted = windowsWorkspaceAttributesSafe([row.path], {
      environment: { SystemRoot: String.raw`C:\Windows` },
      run(command, args, options) {
        call = { command, args, input: JSON.parse(options.input) };
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.match(script, /\$attributePath/u, `${row.name} derives a native attribute path`);
        assert.match(script, /StartsWith\('[^']+'\)/u, `${row.name} preserves an existing extended prefix`);
        assert.match(script, /UNC/u, `${row.name} has the UNC conversion branch`);
        assert.match(script, /Substring\(2\)/u, `${row.name} removes only the leading UNC slashes`);
        assert.match(script, /GetAttributes\(\$attributePath\)/u,
          `${row.name} reads attributes through the normalized path`);
        return { status: 0, error: null, signal: null, stdout: Buffer.from("safe"), stderr: Buffer.alloc(0) };
      },
    });
    assert.equal(accepted, true, `${row.name} keeps the successful native-read control`);
    assert.deepEqual(call?.input, { paths: [row.path] }, `${row.name} reaches the PowerShell decision unchanged`);
  }
});

test("Windows workspace attributes accept a short real path", windowsOnly, t => {
  const root = fixture(t), file = join(root, "guide.md");
  writeFileSync(file, "synthetic guide\n");
  assert.ok(file.length < 260, "short-path control must stay below MAX_PATH");
  assert.equal(windowsWorkspaceAttributesSafe(pathsThroughRoot(file, root)), true);
});

test("Windows workspace attributes accept a real path longer than 260 characters", windowsOnly, t => {
  const root = fixture(t), folder = nestedFolder(root, 270), file = join(folder, "guide.md");
  // Node creates the real long path; only the production PowerShell probe reads attributes.
  writeFileSync(file, "synthetic guide\n");
  assert.ok(file.length > 260, "the regression must exceed MAX_PATH");
  const paths = pathsThroughRoot(file, root);
  assert.ok(paths.length > 2, "the file and its real parent folders are checked together");
  assert.equal(windowsWorkspaceAttributesSafe(paths), true);
});

test("Windows workspace attributes preserve an existing extended-length prefix", windowsOnly, t => {
  const root = fixture(t), folder = nestedFolder(root, 270), file = join(folder, "guide.md");
  writeFileSync(file, "synthetic guide\n");
  assert.equal(windowsWorkspaceAttributesSafe(pathsThroughRoot(file, root).map(toNamespacedPath)), true);
});

test("Windows workspace attributes still refuse a junction in the parent list", windowsOnly, t => {
  const root = fixture(t), regular = join(root, "regular"), linked = join(root, "junction");
  mkdirSync(regular);
  writeFileSync(join(regular, "guide.md"), "synthetic guide\n");
  symlinkSync(regular, linked, "junction");
  const completions = [];
  const run = (...args) => {
    const completion = spawnSync(...args);
    completions.push(completion);
    return completion;
  };
  assert.equal(windowsWorkspaceAttributesSafe(pathsThroughRoot(join(regular, "guide.md"), root), { run }), true,
    "the same real target is safe without a junction");
  assert.equal(windowsWorkspaceAttributesSafe(pathsThroughRoot(join(linked, "guide.md"), root), { run }), false);
  assert.equal(completions.length, 2, "both the safe control and junction refusal reached the native decision");
  assert.deepEqual(completions.map((result) => result.error), [undefined, undefined]);
  assert.deepEqual(completions.map((result) => result.signal), [null, null]);
  assert.deepEqual(completions.map((result) => result.status), [0, 1],
    "the junction arm proves the specific PowerShell reparse refusal");
});

for (const long of [false, true]) {
  test(`Windows managed Claude guide refresh writes in a ${long ? "long" : "short"} workspace`, windowsOnly, t => {
    const root = fixture(t), workspace = long ? nestedFolder(root, 140) : root;
    const manifest = join(workspace, "brain.manifest.json"), target = join(workspace, "CLAUDE.md");
    const id = "00000000-0000-4000-8000-000000000000";
    const deepest = join(`${target}.financial-brain-retained-${id}`, `CLAUDE.md.financial-brain-pending-${id}`);
    assert.equal(deepest.length > 260, long, "the controls must straddle the retained-file MAX_PATH boundary");
    if (long) assert.ok(workspace.length > 118);
    writeFileSync(manifest, "{}\n");
    const previous = `${CLAUDE_WORKSPACE_MARKER}\n# Older managed guide\n`;
    writeFileSync(target, previous, { mode: 0o600 });
    const result = writeClaudeWorkspaceGuide(manifest, {
      brainCliPath: join(root, "brain.cmd"),
      existingOnly: true,
      // Keep native ancestry and attribute checks; profile restrictions remain visible.
      ownership: { profile: root },
    });
    assert.equal(result.status, "written");
    assert.equal(result.changed, true);
    assert.ok(readFileSync(target, "utf8").startsWith(CLAUDE_WORKSPACE_MARKER));
    assert.match(readFileSync(target, "utf8"), /brain_remember/);
    assert.equal(readFileSync(result.recoveryPath, "utf8"), previous);
  });
}
