/** Local scheduling evidence only. A source's ingest receipt remains authoritative. */
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { restrictWindowsFileToCurrentUser, restrictWindowsDirectoryToCurrentUser } from './current-user-file.mjs';

const KEYS = new Set(['quickbooks', 'quickbooks_desktop']);
const invalid = () => Object.assign(new Error('QuickBooks schedule state is unsafe or invalid'), { code: 'QB_SCHEDULE_STATE_INVALID' });
function checked(path, directory = false) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) ||
      (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) throw invalid();
  return info;
}
function location(plan, source, options) {
  if (!/^v1-[a-f0-9]+$/u.test(plan?.identity?.id || '') || !KEYS.has(source?.key) ||
      !/^sha256:[a-f0-9]{64}$/u.test(source?.configuration_hash || '')) throw invalid();
  const home = resolve(options.home || homedir());
  const paths = [join(home, '.brain'), join(home, '.brain', 'quickbooks-schedule'), join(home, '.brain', 'quickbooks-schedule', plan.identity.id)];
  for (const path of paths) {
    if (!checked(path, true)) mkdirSync(path, { mode: 0o700 });
  }
  const directory = paths.at(-1);
  if ((options.platform || process.platform) === 'win32') (options.protectDirectory || restrictWindowsDirectoryToCurrentUser)(directory, options);
  else chmodSync(directory, 0o700);
  return join(directory, `${source.key}.json`);
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['schema_version', 'configuration_hash', 'last_complete_snapshot_at', 'last_run_failed'].includes(k)) ||
      value.schema_version !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(value.configuration_hash || '') ||
      typeof value.last_run_failed !== 'boolean' ||
      (value.last_complete_snapshot_at !== null && (typeof value.last_complete_snapshot_at !== 'string' ||
        !Number.isFinite(Date.parse(value.last_complete_snapshot_at)) || new Date(value.last_complete_snapshot_at).toISOString() !== value.last_complete_snapshot_at))) throw invalid();
  return value;
}
export function readQuickBooksScheduleState(plan, source, options = {}) {
  const path = location(plan, source, options);
  const prior = checked(path);
  if (!prior) return null;
  if (prior.size > 2048) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = fstatSync(fd);
    if (actual.ino !== prior.ino || actual.dev !== prior.dev || actual.nlink !== 1) throw invalid();
    let value;
    try { value = validate(JSON.parse(readFileSync(fd, 'utf8'))); } catch { throw invalid(); }
    return value.configuration_hash === source.configuration_hash ? value : null;
  } finally { closeSync(fd); }
}
/** Call only while holding the Brain lifecycle lease, shared with every writer. */
export function writeQuickBooksScheduleState(plan, source, state, options = {}) {
  const value = validate({ schema_version: 1, configuration_hash: source.configuration_hash,
    last_complete_snapshot_at: state.last_complete_snapshot_at, last_run_failed: state.last_run_failed });
  const path = location(plan, source, options); checked(path);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if ((options.platform || process.platform) === 'win32') (options.protectFile || restrictWindowsFileToCurrentUser)(temporary, options);
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return value;
}
export function quickBooksScheduleState(options = {}) {
  return { read: (plan, source) => readQuickBooksScheduleState(plan, source, options),
    write: (plan, source, value) => writeQuickBooksScheduleState(plan, source, value, options) };
}
