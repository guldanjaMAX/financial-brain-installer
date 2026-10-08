import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuickBooksScheduleState, writeQuickBooksScheduleState } from '../operations/quickbooks-schedule-state.mjs';
const plan = { identity: { id: 'v1-0123456789abcdef' } };
const source = { key: 'quickbooks', configuration_hash: `sha256:${'a'.repeat(64)}` };
const value = { last_complete_snapshot_at: '2026-07-01T14:00:00.000Z', last_run_failed: false };

test('snapshot state is private, bound to configuration, atomic and content-free', () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-state-'));
  const options = { home, platform: 'darwin' };
  assert.equal(readQuickBooksScheduleState(plan, source, options), null);
  writeQuickBooksScheduleState(plan, source, value, options);
  const path = join(home, '.brain', 'quickbooks-schedule', plan.identity.id, 'quickbooks.json');
  assert.ok(existsSync(path));
  // POSIX mode bits do not describe a Windows DACL; its separate ACL test
  // exercises protection failure before commit.
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readQuickBooksScheduleState(plan, source, options).last_complete_snapshot_at, value.last_complete_snapshot_at);
  assert.equal(readQuickBooksScheduleState(plan, { ...source, configuration_hash: `sha256:${'b'.repeat(64)}` }, options), null);
  assert.deepEqual(readdirSync(join(home, '.brain', 'quickbooks-schedule', plan.identity.id)), ['quickbooks.json']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['configuration_hash', 'last_complete_snapshot_at', 'last_run_failed', 'schema_version']);
});

test('malformed state is refused at an existing file, with a valid control', () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-state-refusal-'));
  const options = { home, platform: 'darwin' };
  writeQuickBooksScheduleState(plan, source, value, options);
  const path = join(home, '.brain', 'quickbooks-schedule', plan.identity.id, 'quickbooks.json');
  const bytes = readFileSync(path, 'utf8'); assert.ok(bytes.length > 0);
  writeFileSync(path, '{}');
  assert.throws(() => readQuickBooksScheduleState(plan, source, options), { code: 'QB_SCHEDULE_STATE_INVALID' });
  writeFileSync(path, bytes);
  assert.equal(readQuickBooksScheduleState(plan, source, options).last_run_failed, false);
});

test('Windows state refuses failed protection before committing a file, with successful ACL control', () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-state-acl-'));
  let directories = 0; let files = 0;
  const options = { home, platform: 'win32', protectDirectory() { directories++; }, protectFile() { files++; throw new Error('fixture ACL refusal'); } };
  assert.throws(() => writeQuickBooksScheduleState(plan, source, value, options), /fixture ACL refusal/u);
  assert.equal(directories, 1); assert.equal(files, 1);
  const folder = join(home, '.brain', 'quickbooks-schedule', plan.identity.id);
  assert.deepEqual(readdirSync(folder), []);
  writeQuickBooksScheduleState(plan, source, value, { ...options, protectFile() { files++; } });
  assert.equal(files, 2); assert.equal(readQuickBooksScheduleState(plan, source, options).last_run_failed, false);
});


test('POSIX world-readable state is refused with a private-file control', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'qb-state-mode-'));
  const options = { home, platform: 'darwin' };
  writeQuickBooksScheduleState(plan, source, value, options);
  const path = join(home, '.brain', 'quickbooks-schedule', plan.identity.id, 'quickbooks.json');
  assert.ok(readFileSync(path, 'utf8').length > 0);
  chmodSync(path, 0o644);
  assert.throws(() => readQuickBooksScheduleState(plan, source, options), { code: 'QB_SCHEDULE_STATE_INVALID' });
  chmodSync(path, 0o600);
  assert.equal(readQuickBooksScheduleState(plan, source, options).last_run_failed, false);
});
