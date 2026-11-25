import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// The override selects scratch mutants only; production has no identity override.
const kit = path.resolve(process.env.PRACTICE_TEST_KIT || path.join(root, 'practice-run-1125'));
const producer = await import(pathToFileURL(path.join(kit, 'summary.mjs')).href);
const marks = await import(pathToFileURL(path.join(kit, 'mark.mjs')).href);
const evidence = await import(pathToFileURL(path.join(kit, 'local-evidence.mjs')).href);
const scratch = path.join(root, '.lane-scratch');
fs.mkdirSync(scratch, { recursive: true });
const marker = [731, 842, 953].join('.');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(scratch, 'version-run-'));
  const local = evidence.localRoot(dir);
  const oldClock = process.env.MARK_NOW_MS;
  t.after(() => {
    if (oldClock === undefined) delete process.env.MARK_NOW_MS;
    else process.env.MARK_NOW_MS = oldClock;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  marks.main(['--dir', dir, '--init', '--machine', 'mac', '--round', 'A']);
  process.env.MARK_NOW_MS = String(Date.UTC(2026, 0, 2, 3, 4, 5));
  marks.appendMark(local, 'A0', 'start', true);
  process.env.MARK_NOW_MS = String(Date.UTC(2026, 0, 2, 3, 4, 6));
  marks.appendMark(local, 'A0', 'done');
  const draft = producer.draftSummary(dir);
  assert.equal(draft.steps[0].counts.marks, 2, 'anchored marks reached the real draft');
  assert.equal(draft.steps[0].duration_ms, 1000);
  return { dir, local, draft, output: path.join(dir, 'SUMMARY.json') };
}

function exportCandidate(run, candidate) {
  fs.writeFileSync(path.join(run.local, 'SUMMARY-INPUT.json'), JSON.stringify(candidate));
  const previous = process.cwd(), log = console.log;
  let validationReached = 0, error;
  try {
    process.chdir(run.dir);
    console.log = text => { if (text === 'Summary validation reached.') validationReached++; };
    try { producer.main([]); } catch (caught) { error = caught; }
  } finally { process.chdir(previous); console.log = log; }
  assert.equal(validationReached, 1, 'validationReached=1 through the real exporter main');
  return error;
}

function pinned(run) { return { ...run.draft, tool_version: expected }; }

test('green control: pinned version exports only the validated summary', t => {
  const run = fixture(t);
  const privateText = ['local', 'unshared', 'observation'].join(' ');
  fs.writeFileSync(path.join(run.local, 'raw.log'), privateText);
  fs.writeFileSync(path.join(run.local, 'screen.png'), privateText);
  const candidate = pinned(run);
  assert.equal(exportCandidate(run, candidate), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(run.output, 'utf8')), candidate);
  assert.deepEqual(fs.readdirSync(run.dir).sort(), ['LOCAL-NEVER-SHARE', 'SUMMARY.json']);
  assert.ok(!fs.readFileSync(run.output, 'utf8').includes(privateText));
  assert.equal(producer.validateSummary(candidate), candidate);
});

test('R1: editable dotted version reaches validation and cannot be exported', t => {
  const run = fixture(t), control = pinned(run);
  const candidate = { ...control, tool_version: marker };
  assert.equal(producer.validateSummary(control), control, 'matching pinned control validates');
  const error = exportCandidate(run, candidate);
  t.diagnostic(`validationReached=1; outputExists=${fs.existsSync(run.output)}; editedVersionExported=${fs.existsSync(run.output) && JSON.parse(fs.readFileSync(run.output, 'utf8')).tool_version === marker}`);
  assert.equal(error?.code, 'SUMMARY_TOOL_VERSION', 'R1 must reject the editable version');
  assert.equal(fs.existsSync(run.output), false, 'R1 rejected version writes no summary');
});

test('R2: draft uses the module-pinned package across cwd and environment changes', async t => {
  const run = fixture(t);
  const before = run.draft.tool_version;
  fs.writeFileSync(path.join(run.dir, 'package.json'), JSON.stringify({ name: 'brain-installer', version: marker }));
  const previous = process.cwd();
  const overrides = { npm_package_version: marker, TOOL_VERSION: marker, tool_version: marker, INIT_CWD: run.dir };
  const old = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const tool = fs.mkdtempSync(path.join(scratch, 'identity-tool-'));
  t.after(() => fs.rmSync(tool, { recursive: true, force: true }));
  const copyKit = path.join(tool, 'practice-run-1125');
  fs.mkdirSync(copyKit);
  const copied = [];
  for (const name of fs.readdirSync(kit)) {
    if (!/\.(mjs|json)$/.test(name)) continue;
    const bytes = fs.readFileSync(path.join(kit, name));
    const target = path.join(copyKit, name);
    fs.writeFileSync(target, bytes);
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    const hash = sha256(bytes);
    assert.equal(sha256(fs.readFileSync(target)), hash, 'fresh producer copy keeps exact source bytes');
    copied.push({ file: name, sha256: hash });
  }
  const packageBytes = fs.readFileSync(path.join(root, 'package.json'));
  fs.writeFileSync(path.join(tool, 'package.json'), packageBytes);
  copied.push({ file: 'package.json', sha256: createHash('sha256').update(packageBytes).digest('hex') });
  t.diagnostic(`fresh import source hashes=${JSON.stringify(copied)}`);
  let changed;
  try {
    Object.assign(process.env, overrides);
    process.chdir(run.dir);
    const fresh = await import(pathToFileURL(path.join(copyKit, 'summary.mjs')).href);
    changed = fresh.draftSummary(run.dir).tool_version;
  } finally {
    process.chdir(previous);
    for (const key of Object.keys(overrides)) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
  assert.equal(before, expected, 'R2 initial draft must derive the pinned tool version');
  assert.equal(changed, expected, 'R2 cwd/environment cannot replace tool identity');
  assert.equal(exportCandidate(run, pinned(run)), undefined, 'matching control still exports');
});

test('R3: rejected version cannot create partial shareable output', t => {
  const run = fixture(t);
  const error = exportCandidate(run, { ...pinned(run), tool_version: marker });
  assert.equal(fs.existsSync(run.output), false, 'R3 version check must precede all final writes');
  assert.equal(error?.code, 'SUMMARY_TOOL_VERSION');
  assert.deepEqual(fs.readdirSync(run.dir), ['LOCAL-NEVER-SHARE']);
  assert.equal(exportCandidate(run, pinned(run)), undefined, 'green control exports after rejection');
});

test('R3: existing summary stays byte-identical and remains write-once', t => {
  const run = fixture(t), control = pinned(run);
  assert.equal(exportCandidate(run, control), undefined);
  const bytes = fs.readFileSync(run.output);
  const error = exportCandidate(run, { ...control, tool_version: marker });
  assert.deepEqual(fs.readFileSync(run.output), bytes, 'rejected metadata preserves existing bytes');
  assert.equal(error?.code, 'SUMMARY_TOOL_VERSION');
  assert.equal(exportCandidate(run, control)?.code, 'EEXIST', 'matching second export is still write-once');
  assert.deepEqual(fs.readFileSync(run.output), bytes);
});

test('R3: schema-invalid metadata stays local with a pinned-version green control', t => {
  const run = fixture(t), control = pinned(run);
  const error = exportCandidate(run, { ...control, raw_logs: ['local', 'only'].join(' ') });
  assert.equal(error?.code, 'SUMMARY_INVALID');
  assert.equal(fs.existsSync(run.output), false, 'schema failure cannot publish a partial file');
  assert.equal(exportCandidate(run, control), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(run.output, 'utf8')), control);
});
