import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const kit = path.resolve(process.env.PRACTICE_TIME_KIT || path.join(root, 'practice-run-1125'));
const { main, context, summary: show } = await import(pathToFileURL(path.join(kit, 'mark.mjs')));
const { draftSummary, validateSummary } = await import(pathToFileURL(path.join(kit, 'summary.mjs')));
const scratch = path.join(root, '.lane-scratch');
fs.mkdirSync(scratch, { recursive: true });
const MIN = Date.parse('2020-01-01T00:00:00.000Z');
const MAX = Date.parse('2099-12-31T23:59:59.999Z');
function run(round = 'B') {
  const dir = fs.mkdtempSync(path.join(scratch, 'time-'));
  main(['--dir', dir, '--init', '--machine', 'mac', '--round', round]);
  const file = path.join(dir, 'LOCAL-NEVER-SHARE', 'TIMES.tsv');
  let writes = 0;
  return { dir, file, get writes() { return writes; },
    mark(ms, event, ...words) {
      const old = process.env.MARK_NOW_MS;
      process.env.MARK_NOW_MS = String(ms);
      try { main(['--dir', dir, round === 'A' ? 'A0' : '1', event, ...words]); writes++; }
      finally { if (old === undefined) delete process.env.MARK_NOW_MS; else process.env.MARK_NOW_MS = old; }
    },
    output() {
      const lines = [], log = console.log;
      console.log = line => lines.push(line);
      try { show(dir); } finally { console.log = log; }
      assert.ok(lines.length > 0, 'real show reached');
      return lines[0];
    },
    step() {
      const value = draftSummary(dir);
      assert.equal(validateSummary(value), value, 'summary validation reached');
      return value.steps.find(s => s.id === (round === 'A' ? 'A0' : '1'));
    },
  };
}
function display(recovery, failed = 'none', terminal = 'pending') {
  return `round B row 1 recovery seconds: ${recovery}; step seconds: pending; failed owner attempt seconds: ${failed}; Terminal recovery seconds: ${terminal}`;
}
test('R1 inclusive endpoints and midrange reach mark/context and draft validation', () => {
  for (const ms of [MIN, Date.parse('2034-06-01T00:00:00.000Z'), MAX]) {
    const r = run('A'); r.mark(ms, 'start'); r.mark(ms, 'done');
    assert.equal(r.writes, 2); assert.equal(context(r.dir).rows.length, 2);
    assert.equal(r.step().started_at, new Date(ms).toISOString());
  }
});
for (const ms of [MIN - 1, MAX + 1]) test(`R1 rejected adjacent ${ms} reaches marker and context`, () => {
    const r = run('A'); r.mark(MIN, 'start');
    assert.equal(r.writes, 1, 'valid green write control');
    const candidate = draftSummary(r.dir);
    candidate.steps[0].started_at = new Date(ms).toISOString();
    let validationReached = 0;
    assert.throws(() => { validationReached++; validateSummary(candidate); });
    assert.equal(validationReached, 1, 'adjacent summary rejection reached');
    const before = fs.readFileSync(r.file, 'utf8');
    let reached = 0;
    assert.throws(() => { reached++; r.mark(ms, 'done'); });
    assert.equal(reached, 1); assert.equal(fs.readFileSync(r.file, 'utf8'), before);
    const edited = before.split('\n');
    const cells = edited[1].split('\t'); cells[0] = new Date(ms).toISOString(); cells[1] = String(ms);
    edited[1] = cells.join('\t'); fs.writeFileSync(r.file, edited.join('\n'));
    assert.throws(() => context(r.dir));
});
test('R2 progress then failure retains full owner duration in show and export', () => {
  const r = run(); r.mark(MIN, 'start'); r.mark(MIN, 'stop'); r.mark(MIN, 'again');
  r.mark(MIN + 1000, 'back');
  assert.equal(r.output(), display('1'), 'progress-only green control');
  assert.deepEqual(r.step().recovery_attempts, [{ kind: 'OWNER', result: 'PROGRESS', progress_ms: 1000, duration_ms: 1000 }]);
  r.mark(MIN + 2000, 'note', 'owner-failed');
  const exported = r.step();
  assert.equal(exported.recovery_attempts[0].duration_ms, 2000, 'producer reached before show assertion');
  assert.equal(r.output(), display('1', '2'));
  assert.deepEqual(exported.recovery_attempts, [{ kind: 'OWNER', result: 'FAILED', progress_ms: 1000, duration_ms: 2000 }]);
});
for (const iteration of [0, 1]) test(`R3 large exact milliseconds and repeated owner/terminal attempts ${iteration}`, () => {
  const terminalMs = iteration ? 5678 : 1234;
  const r = run(); r.mark(MIN, 'start'); r.mark(MIN, 'stop'); r.mark(MIN, 'again');
  r.mark(MIN + 1234, 'back'); r.mark(MIN + 2000, 'again');
  r.mark(MIN + 604799999, 'back'); r.mark(MIN + 604800000, 'note', 'owner-failed');
  r.mark(MIN + 604800001, 'note', 'terminal-again'); r.mark(MIN + 604800001 + terminalMs, 'note', 'terminal-back');
  assert.deepEqual(r.step().recovery_attempts, [
    { kind: 'OWNER', result: 'PROGRESS', progress_ms: 1234, duration_ms: 1234 },
    { kind: 'OWNER', result: 'FAILED', progress_ms: 604797999, duration_ms: 604798000 },
    { kind: 'TERMINAL', result: 'PROGRESS', progress_ms: terminalMs, duration_ms: terminalMs },
  ]);
  assert.equal(r.output(), display('1.234, 604797.999', '604798', String(terminalMs / 1000)));
});
test('R3 reversed and invalid clocks reach append decision without changing bytes', () => {
  const r = run(); r.mark(MIN + 1, 'start'); assert.equal(r.writes, 1);
  for (const ms of [MIN, 'invalid', MIN + 1.5, Number.MAX_SAFE_INTEGER]) {
    const before = fs.readFileSync(r.file, 'utf8'); let reached = 0;
    assert.throws(() => { reached++; r.mark(ms, 'done'); });
    assert.equal(reached, 1); assert.equal(fs.readFileSync(r.file, 'utf8'), before);
  }
  r.mark(MIN + 2, 'done'); assert.equal(r.step().duration_ms, 1);
});
