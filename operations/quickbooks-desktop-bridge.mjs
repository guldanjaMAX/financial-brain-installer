import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  QBD_HELPERS, inspectQuickBooksDesktopHelper, qbdEnvironment,
  sameQbdIdentity, verifyQbdAuthenticode, verifyQuickBooksDesktopHelper,
} from './quickbooks-desktop-signed.mjs';

export const QBD_CONTRACT = JSON.parse(readFileSync(new URL('./quickbooks-desktop-requests.json', import.meta.url), 'utf8'));
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
freeze(QBD_CONTRACT);
export const QBD_EXIT_CODES = freeze(Object.fromEntries(QBD_CONTRACT.exits.map(({ value, code }) => [value, code])));
export const QBD_LIMITS = freeze({ frameBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, planBytes: 1024 * 1024, frames: 20_000, ids: 10_000 });
// FIELD-VERIFY: real ListID/TxnID shape across supported US editions. Do not
// normalize only one side of an identity or admit arbitrary qbXML fragments.
export const QBD_ID = /^[0-9A-F]{1,16}-[0-9]{1,12}$/;
export const QBD_PROGID = 'QBXMLRP2.RequestProcessor';
const refuse = (code = 'QB_PARTIAL_VIEW') => ({ ok: false, code, frames: [] });
const plain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const validCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000;

export function encodeQbdFrame(value, max = QBD_LIMITS.frameBytes) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length < 2 || bytes.length > max) throw new Error('QB_PARTIAL_VIEW');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
export function decodeQbdFrames(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > QBD_LIMITS.totalBytes) throw new Error('QB_PARTIAL_VIEW');
  const frames = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 4 || frames.length >= QBD_LIMITS.frames) throw new Error('QB_PARTIAL_VIEW');
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (length < 2 || length > QBD_LIMITS.frameBytes || length > bytes.length - offset) throw new Error('QB_PARTIAL_VIEW');
    const value = JSON.parse(decoder.decode(bytes.subarray(offset, offset + length)));
    if (!plain(value)) throw new Error('QB_PARTIAL_VIEW');
    frames.push(value); offset += length;
  }
  return frames;
}
function checkedIds(ids) {
  if (!Array.isArray(ids) || ids.length > QBD_LIMITS.ids || ids.some((id) => typeof id !== 'string' || !QBD_ID.test(id)) || new Set(ids).size !== ids.length) throw new Error('QB_PARTIAL_VIEW');
  return [...ids];
}
export function qbdPlan(input, now = new Date()) {
  if (!plain(input) || !['probe', 'probe2', 'snapshot'].includes(input.operation)) throw new Error('QB_PARTIAL_VIEW');
  if (input.operation !== 'snapshot') return { historySince: '', accountListIds: [], storedTxnIds: [], postdatedFrom: '' };
  const historySince = input.historySince;
  if (typeof historySince !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(historySince) ||
      !Number.isFinite(Date.parse(historySince)) || new Date(historySince).toISOString() !== historySince.replace('Z', '.000Z') || Date.parse(historySince) > now.getTime()) throw new Error('QB_PARTIAL_VIEW');
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const postdatedFrom = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, '0'), String(tomorrow.getDate()).padStart(2, '0')].join('-');
  return { historySince, accountListIds: checkedIds(input.accountListIds ?? []), storedTxnIds: checkedIds(input.storedTxnIds ?? []), postdatedFrom };
}
export function qbdRequests(operation, plan) {
  const requests = QBD_CONTRACT.requests.filter((entry) => operation === 'probe2' ? entry.key === 'Host' :
    operation === 'probe' ? entry.mode === 'base' : entry.mode !== 'postdated').map((entry) => ({ ...entry, id: entry.key }));
  if (operation === 'snapshot') {
    const postdated = QBD_CONTRACT.requests.find((entry) => entry.key === 'Postdated');
    for (let i = 0; i < plan.accountListIds.length; i++) requests.push({ ...postdated, id: `Postdated:${i}` });
  }
  return requests;
}
function projectRows(rows, entity) {
  const fields = QBD_CONTRACT.returns.find((ret) => ret.name === entity)?.fields;
  if (!fields || !Array.isArray(rows) || rows.length > 500) throw new Error('QB_PARTIAL_VIEW');
  return rows.map((row) => {
    if (!plain(row)) throw new Error('QB_PARTIAL_VIEW');
    const result = {};
    for (const field of fields) {
      if (!Object.hasOwn(row, field)) continue;
      const value = row[field];
      if (field === 'SupportedQBXMLVersion' && Array.isArray(value) && value.length <= 64 && value.every((s) => typeof s === 'string' && /^\d{1,2}\.\d{1,2}$/.test(s))) result[field] = [...value];
      else if (typeof value === 'string' && value.length <= 4096) result[field] = value;
      else throw new Error('QB_PARTIAL_VIEW');
    }
    return result;
  });
}
export function validateQbdResult(bytes, operation, plan) {
  try {
    const raw = decodeQbdFrames(bytes);
    const expected = qbdRequests(operation, plan);
    if (expected.length === 0) return refuse();
    const terminal = raw.at(-1);
    if (terminal.type !== 'terminal' || terminal.protocol !== 1 || !Array.isArray(terminal.requests) || terminal.requests.length !== expected.length) return refuse();
    const requests = new Map(expected.map((entry) => [entry.id, entry]));
    const counts = new Map(expected.map((entry) => [entry.id, 0]));
    const batchSeen = new Set();
    const frames = [];
    for (const frame of raw.slice(0, -1)) {
      const request = requests.get(frame.request);
      if (frame.type !== 'batch' || frame.protocol !== 1 || !request || frame.entity !== request.ret || request.mode === 'postdated') return refuse();
      const rows = projectRows(frame.rows, frame.entity);
      batchSeen.add(frame.request);
      counts.set(frame.request, counts.get(frame.request) + rows.length);
      frames.push({ protocol: 1, type: 'batch', request: frame.request, entity: frame.entity, rows });
    }
    const seen = new Set();
    const cleanTerminal = [];
    for (const receipt of terminal.requests) {
      const request = requests.get(receipt.id);
      if (!request || seen.has(receipt.id) || receipt.iteratorRemainingCount !== 0 || receipt.statusCode !== 0 ||
          receipt.statusSeverity !== 'Info' || !validCount(receipt.rowCount) || !validCount(receipt.requestCount) || receipt.requestCount < 1 ||
          (request.mode !== 'postdated' && (!batchSeen.has(receipt.id) || receipt.rowCount !== counts.get(receipt.id))) ||
          (request.mode === 'postdated' && receipt.rowCount !== 0)) return refuse();
      if (request.mode === 'postdated' && !validCount(receipt.matchedCount)) return refuse();
      seen.add(receipt.id);
      cleanTerminal.push({ id: receipt.id, iteratorRemainingCount: 0, statusCode: 0, statusSeverity: 'Info',
        rowCount: receipt.rowCount, requestCount: receipt.requestCount,
        ...(request.mode === 'postdated' ? { matchedCount: receipt.matchedCount } : {}) });
    }
    // A valid transport is not permission to accept an unattended or unknown grant.
    if (operation !== 'probe2') {
      const preferences = frames.filter((frame) => frame.entity === 'PreferencesRet').flatMap((frame) => frame.rows);
      if (preferences.length !== 1) return refuse();
      const rights = preferences[0];
      if (rights['CurrentAppAccessRights.IsAutomaticLoginAllowed'] === 'true' || rights['CurrentAppAccessRights.IsReadOnly'] === 'false' || rights['CurrentAppAccessRights.IsPersonalDataAccessAllowed'] === 'true') return refuse('QB_GRANT_TOO_BROAD');
      if (rights['CurrentAppAccessRights.IsAutomaticLoginAllowed'] !== 'false' || rights['CurrentAppAccessRights.IsReadOnly'] !== 'true' || rights['CurrentAppAccessRights.IsPersonalDataAccessAllowed'] !== 'false') return refuse();
    }
    frames.push({ protocol: 1, type: 'terminal', requests: cleanTerminal });
    return { ok: true, code: null, frames };
  } catch { return refuse(); }
}
function registryValue(result) {
  if (result?.status !== 0 || result.error || result.signal) return null;
  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout;
  if (typeof output !== 'string' || output.length > 8192) return null;
  const matches = [...output.matchAll(/^\s+[^\r\n]*?\s+REG_SZ\s+([^\r\n]+?)\s*$/gm)];
  return matches.length === 1 ? matches[0][1] : null;
}
export function resolveQbdProcessor({ environment = {}, run = spawnSync, signatureRun = spawnSync,
  fs = { lstatSync, realpathSync }, onStage = () => {} } = {}) {
  try {
    const env = qbdEnvironment(environment);
    if (!/^[A-Za-z]:\\Windows$/i.test(env.SystemRoot || '')) return refuse('QB_PROCESSOR_UNTRUSTED');
    const query = (key, view) => registryValue(run(win32.join(env.SystemRoot, 'System32', 'reg.exe'),
      ['query', `HKLM\\SOFTWARE\\Classes\\${key}`, '/ve', `/reg:${view}`], {
        env, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 8192,
      }));
    const registrations = [];
    for (const [view, architecture] of [[32, 'x86'], [64, 'x64']]) {
      onStage('processor_registry');
      const clsid = query(`${QBD_PROGID}\\CLSID`, view);
      if (!clsid) continue;
      if (!/^\{[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}\}$/.test(clsid)) return refuse('QB_PROCESSOR_UNTRUSTED');
      const path = query(`CLSID\\${clsid}\\InprocServer32`, view);
      const root = win32.parse(env.SystemRoot).root;
      const allowed = [win32.join(root, 'Program Files'), win32.join(root, 'Program Files (x86)')];
      if (!path || /["\r\n%]/.test(path) || !path.toLowerCase().endsWith('.dll') || win32.normalize(path) !== path ||
          !allowed.some((base) => path.toLowerCase().startsWith(`${base.toLowerCase()}\\`))) return refuse('QB_PROCESSOR_UNTRUSTED');
      const before = fs.lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(path).toLowerCase() !== path.toLowerCase()) return refuse('QB_PROCESSOR_UNTRUSTED');
      onStage('processor_signature');
      if (!verifyQbdAuthenticode(path, 'processor', { environment: env, run: signatureRun })) return refuse('QB_PROCESSOR_UNTRUSTED');
      const after = fs.lstatSync(path);
      if (!['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]) || fs.realpathSync(path).toLowerCase() !== path.toLowerCase()) return refuse('QB_PROCESSOR_UNTRUSTED');
      registrations.push({ architecture, path, clsid });
    }
    return registrations.length ? { ok: true, registrations } : refuse('QB_PROCESSOR_UNTRUSTED');
  } catch { return refuse('QB_PROCESSOR_UNTRUSTED'); }
}

/** Internal dependency injection is for tests, never manifest configuration. */
export function runQuickBooksDesktop(input, dependencies = {}) {
  const { platform = process.platform, environment = process.env, artifacts = QBD_HELPERS,
    spawnSync: run = spawnSync, registryRun = spawnSync, signatureRun = spawnSync,
    helperFs, processorFs, now = () => new Date(), onStage = () => {}, timeoutMs = 300_000, requestTimeoutMs = 30_000 } = dependencies;
  try {
    if (platform !== 'win32') return refuse('QB_NOT_INSTALLED');
    const plan = qbdPlan(input, now());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000 ||
        !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs >= timeoutMs) return refuse();
    const stdin = encodeQbdFrame(plan, QBD_LIMITS.planBytes);
    onStage('helper_pin');
    if (!Object.values(artifacts).some((artifact) => inspectQuickBooksDesktopHelper(artifact, helperFs).ok)) return refuse('QB_HELPER_UNAVAILABLE');
    const processor = resolveQbdProcessor({ environment, run: registryRun, signatureRun, fs: processorFs, onStage });
    if (!processor.ok) return processor;
    const registration = processor.registrations.find((entry) => artifacts[entry.architecture]);
    if (!registration) return refuse('QB_HELPER_UNAVAILABLE');
    const artifact = artifacts[registration.architecture];
    onStage('helper_signature');
    const helper = verifyQuickBooksDesktopHelper(artifact, { environment, run: signatureRun, fs: helperFs });
    if (!helper.ok) return refuse('QB_HELPER_UNAVAILABLE');
    if (!sameQbdIdentity(helper, inspectQuickBooksDesktopHelper(artifact, helperFs))) return refuse('QB_HELPER_UNAVAILABLE');
    onStage('helper_spawn');
    const result = run(helper.path, [input.operation, String(requestTimeoutMs)], {
      env: qbdEnvironment(environment), input: stdin, encoding: null, shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs,
      maxBuffer: QBD_LIMITS.totalBytes, killSignal: 'SIGKILL',
    });
    try {
      if (result?.error?.code === 'ETIMEDOUT') return refuse(input.operation === 'probe2' ? 'QB_GRANT_PROMPTS' : 'QB_BUSY');
      if (result?.error || result?.signal) return refuse();
      if (result?.status !== 0) return refuse(QBD_EXIT_CODES[result?.status] || 'QB_PARTIAL_VIEW');
      return validateQbdResult(result.stdout, input.operation, plan);
    } finally {
      if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
      if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
      stdin.fill(0);
    }
  } catch { return refuse(); }
}
