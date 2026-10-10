/** Private local company identity. Never serialize this record into an envelope. */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { QBD_ID } from '../operations/quickbooks-desktop-bridge.mjs';
import { restrictWindowsFileToCurrentUser, restrictWindowsDirectoryToCurrentUser } from '../operations/current-user-file.mjs';
import { desktopUtc } from './quickbooks-desktop-map.mjs';
import { assertSingleQuickBooksSource } from './quickbooks-edition-guard.mjs';
import { buildOneShotTask } from '../operations/daily-refresh-scheduler.mjs';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { qbdEnvironment } from '../operations/quickbooks-desktop-signed.mjs';

const MESSAGES = Object.freeze({
  QB_ELEVATED: "Untick Run as administrator in the QuickBooks shortcut's Properties, then reopen QuickBooks normally.",
  QB_GRANT_TOO_BROAD: 'In Edit > Preferences > Integrated Applications > Company Preferences, remove the always-access grant. Reconnect and choose Yes, whenever this company file is open.',
  QB_GRANT_PROMPTS: 'In Edit > Preferences > Integrated Applications > Company Preferences, replace prompt-each-time access with access while the company file is open.',
  QB_WRONG_COMPANY: 'Open the connected company file. Switching companies requires the reviewed disconnect and removal first.',
  QB_NOT_OPEN: 'Open QuickBooks with the company file on this PC.',
  QB_NOT_INSTALLED: 'QuickBooks Desktop needs the same Windows PC. Use report uploads for Mac or hosted Desktop.',
  QB_HELPER_UNAVAILABLE: 'The reviewed signed helper is unavailable. Stop for package repair.',
  QB_BINDING_RECOVERY_REQUIRED: 'The local binding is missing while stored books remain. Review their company identity before reconnecting.',
});
export function qbdOwnerMessage(code) {
  const safe = typeof code === 'string' && /^QB_[A-Z_]{1,48}$/.test(code) ? code : 'QB_OPERATION_FAILED';
  return `${safe}${MESSAGES[safe] ? `: ${MESSAGES[safe]}` : ''}`;
}
export const qbdFailure = code => Object.assign(new Error(qbdOwnerMessage(code)), { code });
export function desktopCompanyIdentity(accounts) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.some(row => !QBD_ID.test(row.ListID || '') || !desktopUtc(row.TimeCreated)) ||
      new Set(accounts.map(row => row.ListID)).size !== accounts.length) throw qbdFailure('QB_PARTIAL_VIEW');
  const first = [...accounts].sort((a, b) => Date.parse(a.TimeCreated) - Date.parse(b.TimeCreated) || (a.ListID < b.ListID ? -1 : a.ListID > b.ListID ? 1 : 0))[0];
  // FIELD-VERIFY: no undeletable special account is proven yet. Retain the raw
  // tuple for the specified v1 hash, and record the fallback choice explicitly.
  return { list_id: first.ListID, time_created: first.TimeCreated, selection: 'earliest_created_account',
    fingerprint: createHash('sha256').update(`quickbooks-desktop-company-v1:${first.ListID}|${first.TimeCreated}`).digest('hex') };
}
export function makeDesktopBinding({ accounts, country, edition = 'desktop' }) {
  const identity = desktopCompanyIdentity(accounts);
  return { schema_version: 1, ...identity, edition, country, grant_mode: 'attended_read_only',
    last_complete_snapshot_at: null, previous_counts: {}, previous_max_time_modified: null,
    previous_file_write_at: null, freshness: 'unverified', pending_removals: null };
}
function validate(value) {
  const keys = ['schema_version', 'list_id', 'time_created', 'selection', 'fingerprint', 'edition', 'country', 'grant_mode',
    'last_complete_snapshot_at', 'previous_counts', 'previous_max_time_modified', 'previous_file_write_at', 'freshness', 'pending_removals'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) ||
      value.schema_version !== 1 || value.edition !== 'desktop' || !/^[A-Z]{2}$/.test(value.country || '') ||
      value.selection !== 'earliest_created_account' || value.grant_mode !== 'attended_read_only' || value.freshness !== 'unverified' ||
      desktopCompanyIdentity([{ ListID: value.list_id, TimeCreated: value.time_created }]).fingerprint !== value.fingerprint ||
      !value.previous_counts || Array.isArray(value.previous_counts) || Object.entries(value.previous_counts).some(([key, n]) =>
        !['Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'CreditMemo', 'BillPayment', 'Payment'].includes(key) || !Number.isSafeInteger(n) || n < 0) ||
      ['last_complete_snapshot_at', 'previous_max_time_modified', 'previous_file_write_at'].some(key => value[key] !== null && desktopUtc(value[key]) !== value[key])) throw qbdFailure('QB_BINDING_INVALID');
  const pending = value.pending_removals;
  if (pending !== null && (!pending || Object.keys(pending).some(k => !['fingerprint', 'company_fingerprint', 'source_ids'].includes(k)) ||
      !/^[a-f0-9]{64}$/.test(pending.fingerprint || '') || pending.company_fingerprint !== value.fingerprint || !Array.isArray(pending.source_ids) ||
      pending.source_ids.length > 100000 || pending.source_ids.some(id => !/^(?:account|customer|vendor|invoice|bill|creditmemo|billpayment|payment):[0-9A-F]{1,16}-[0-9]{1,12}$/.test(id)))) throw qbdFailure('QB_BINDING_INVALID');
  return value;
}
function checked(path, directory = false) {
  let st; try { st = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1 || st.size > 8 * 1024 * 1024) ||
      (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid()))) throw qbdFailure('QB_BINDING_INVALID');
  return st;
}
export function desktopBindingStore(options = {}) {
  const home = resolve(options.home || homedir()); const directory = join(home, '.brain'); const path = join(directory, 'quickbooks-desktop.json');
  const protect = (p, dir = false) => {
    if ((options.platform || process.platform) === 'win32') (dir ? options.protectDirectory || restrictWindowsDirectoryToCurrentUser : options.protectFile || restrictWindowsFileToCurrentUser)(p, options);
    else chmodSync(p, dir ? 0o700 : 0o600);
  };
  const read = () => {
    if (!checked(directory, true)) return null;
    const before = checked(path); if (!before) return null;
    protect(path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const st = fstatSync(fd);
      if (st.ino !== before.ino || st.dev !== before.dev || st.nlink !== 1) throw qbdFailure('QB_BINDING_INVALID');
      return validate(JSON.parse(readFileSync(fd, 'utf8')));
    } catch { throw qbdFailure('QB_BINDING_INVALID'); } finally { closeSync(fd); }
  };
  return { read, write(value) {
    validate(value);
    if (!checked(directory, true)) mkdirSync(directory, { mode: 0o700 }); protect(directory, true); checked(path);
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { protect(temporary); renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (JSON.stringify(read()) !== JSON.stringify(value)) throw qbdFailure('QB_BINDING_INVALID');
    return value;
  }, remove() {
    if (read()) unlinkSync(path);
    if (read()) throw qbdFailure('QB_BINDING_INVALID');
  } };
}

/** Native boundary has no shell interpolation and no credential-bearing env.
 * A unique name avoids adopting another task. Register disabled, verify every
 * requested leaf plus action/principal/trigger counts, then enable and start.
 */
export function startDesktopConnectTask(task, { run = spawnSync, environment = process.env } = {}) {
  const env = qbdEnvironment(environment);
  if (!/^[A-Za-z]:\\Windows$/i.test(env.SystemRoot || '')) throw qbdFailure('QB_CONNECT_TASK_FAILED');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$p = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    "$folder = '\\Financial Brain\\'",
    '$name = $p.name.Substring($folder.Length)',
    'if (Get-ScheduledTask -TaskPath $folder -TaskName $name -ErrorAction SilentlyContinue) { exit 2 }',
    '[xml]$wanted = $p.serialized',
    "$wanted.Task.Settings.Enabled = 'false'",
    'Register-ScheduledTask -TaskPath $folder -TaskName $name -Xml $wanted.OuterXml | Out-Null',
    '[xml]$actual = Export-ScheduledTask -TaskPath $folder -TaskName $name',
    "foreach ($leaf in $wanted.SelectNodes('//*[not(*)]')) {",
    "  $parts = @(); $n = $leaf; while ($n.NodeType -eq 'Element') { $parts = @(('*[local-name()=' + [char]39 + $n.LocalName + [char]39 + ']')) + $parts; $n = $n.ParentNode }",
    "  $nodes = $actual.SelectNodes('/' + ($parts -join '/')); if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne $leaf.InnerText) { exit 3 }",
    '}',
    "foreach ($section in @('Actions','Principals','Triggers')) { if ($actual.Task.$section.ChildNodes.Count -ne 1) { exit 4 } }",
    'Enable-ScheduledTask -TaskPath $folder -TaskName $name | Out-Null',
    'if ((Get-ScheduledTask -TaskPath $folder -TaskName $name).Settings.Enabled -ne $true) { exit 5 }',
    'Start-ScheduledTask -TaskPath $folder -TaskName $name',
  ].join('\n');
  const result = run(win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env, input: JSON.stringify(task), encoding: null, shell: false, windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'], timeout: 30000,
    });
  if (result?.status !== 0 || result.error || result.signal) throw qbdFailure('QB_CONNECT_TASK_FAILED');
  return { started: true, verified: true };
}

export async function connectQuickBooksDesktop({ manifestPath, flags = {} }, deps) {
  if (deps.platform !== 'win32') throw qbdFailure('QB_NOT_INSTALLED');
  let inventory;
  await assertSingleQuickBooksSource({ targetSource: 'quickbooks_desktop', listQuickBooksSources: async () => {
    inventory = await deps.listQuickBooksSources(); return inventory;
  } });
  const signature = await deps.verifyHelper(); if (signature?.ok !== true) throw qbdFailure('QB_HELPER_UNAVAILABLE');
  if (await deps.hasElevation()) throw qbdFailure('QB_ELEVATED');
  if (!flags['attended-probe']) {
    const task = buildOneShotTask({ name: `QuickBooks connect ${randomBytes(12).toString('hex')}`,
      args: [deps.brainPath, 'connect', 'quickbooks-desktop', manifestPath, '--attended-probe'], expiresMinutes: 15 },
    { nodePath: deps.nodePath, principal: deps.principal, now: deps.now() });
    const started = await deps.startTask(task);
    if (!started?.started || !started.verified) throw qbdFailure('QB_CONNECT_TASK_FAILED');
    return { status: 'pending', code: 'QB_CONNECT_STARTED' };
  }
  deps.log('Waiting for QuickBooks: open it as the QuickBooks Admin user with your company file. Use normal Windows privileges.');
  const began = deps.monotonic(); let open = false;
  for (let attempt = 0; attempt <= 120 && deps.monotonic() - began <= 600000; attempt++) {
    if ((await deps.listProcesses()).some(name => /^QBW[^\\/]*\.exe$/i.test(name))) { open = true; break; }
    if (attempt === 120) break;
    await deps.sleep(5000);
  }
  if (!open) throw qbdFailure('QB_NOT_OPEN');
  const { desktopRows } = await import('./quickbooks-desktop.mjs');
  const { encodeQbdFrame, qbdPlan, validateQbdResult } = await import('../operations/quickbooks-desktop-bridge.mjs');
  const probe = async operation => {
    const raw = await deps.bridge({ operation });
    if (!raw?.ok) throw qbdFailure(/^QB_[A-Z_]+$/.test(raw?.code || '') ? raw.code : 'QB_PARTIAL_VIEW');
    const result = validateQbdResult(Buffer.concat(raw.frames.map(frame => encodeQbdFrame(frame))), operation, qbdPlan({ operation }));
    if (!result.ok) throw qbdFailure(result.code);
    return result;
  };
  const observed = await probe('probe');
  const hosts = desktopRows(observed, 'HostRet'); const companies = desktopRows(observed, 'CompanyRet');
  if (companies.length !== 1 || companies[0].IsSampleCompanyFile !== 'false') throw qbdFailure('QB_SAMPLE_COMPANY');
  if (hosts.length !== 1 || !/^[A-Z]{2}$/.test(hosts[0].Country || '')) throw qbdFailure('QB_UNSUPPORTED_EDITION');
  await probe('probe2');
  const intended = makeDesktopBinding({ accounts: desktopRows(observed, 'AccountRet'), country: hosts[0].Country });
  const prior = await deps.bindingStore.read();
  // A local hash reconstructed from a new file cannot prove which company
  // owns old Worker families. The existing family inventory has no company
  // metadata readback. Retain them for reviewed recovery, never adopt them.
  if (!prior && inventory.some(row => row.name === 'quickbooks_desktop' && row.family_count > 0)) throw qbdFailure('QB_BINDING_RECOVERY_REQUIRED');
  if (prior && prior.fingerprint !== intended.fingerprint) {
    // No normal reconnect may silently adopt a new company. The explicit
    // disconnect ceremony must finish its guarded forget before retrying.
    throw qbdFailure('QB_WRONG_COMPANY');
  }
  const binding = prior || intended;
  deps.assertOwned?.(); await deps.bindingStore.write(binding);
  if ((await deps.bindingStore.read())?.fingerprint !== binding.fingerprint) throw qbdFailure('QB_BINDING_INVALID');
  const manifest = await deps.readManifest(manifestPath);
  const configuration = manifest.corpora?.quickbooks_desktop;
  if (configuration?.source && configuration.source !== 'quickbooks_desktop') throw qbdFailure('QB_SOURCE_INVALID');
  deps.assertOwned?.();
  await deps.writeManifest(manifestPath, { ...manifest, corpora: { ...manifest.corpora, quickbooks_desktop: { enabled: true, source: 'quickbooks_desktop' } } });
  await deps.registerSource({ source: 'quickbooks_desktop', kind: 'quickbooks', expected_refresh_seconds: 86400 });
  const schedule = await deps.reregister(manifestPath);
  if (!schedule?.verified) throw qbdFailure('QB_SCHEDULE_UNVERIFIED');
  const snapshot = await deps.runSnapshot();
  if (!snapshot?.enumeration_complete) throw qbdFailure(snapshot?.code || 'QB_PARTIAL_VIEW');
  return { status: 'connected', code: snapshot.code || 'QB_READY', counts: snapshot.tally,
    notice: binding.country !== 'US' ? 'Connected, but money answers are US-only in this version.' : 'Desktop money answers are unavailable until file freshness is verified.',
    summary: ['Reads happen while QuickBooks is open on this PC.', 'Answers go stale after a day without QuickBooks open.', 'Use a Windows login only you sign into.'] };
}

export async function disconnectQuickBooksDesktop({ manifestPath, flags = {} }, deps) {
  const binding = await deps.bindingStore.read();
  if (!binding) throw qbdFailure('QB_NOT_CONNECTED');
  const preview = await deps.previewForget({ source: 'quickbooks_desktop', companyFingerprint: binding.fingerprint });
  const fingerprint = createHash('sha256').update(JSON.stringify({ source: 'quickbooks_desktop', company: binding.fingerprint, preview })).digest('hex');
  if (flags['approve-removals'] !== fingerprint) return { status: 'refused', code: 'QB_REMOVAL_APPROVAL_REQUIRED', fingerprint, documents: preview.documents };
  deps.assertOwned?.();
  const forgotten = await deps.forget({ source: 'quickbooks_desktop', companyFingerprint: binding.fingerprint, preview });
  if (forgotten?.sourceUnregistered !== true || !Number.isSafeInteger(forgotten.removed) || forgotten.removed < 0) throw qbdFailure('QB_REMOVAL_UNVERIFIED');
  const manifest = await deps.readManifest(manifestPath);
  await deps.writeManifest(manifestPath, { ...manifest, corpora: { ...manifest.corpora,
    quickbooks_desktop: { ...manifest.corpora?.quickbooks_desktop, enabled: false, source: 'quickbooks_desktop' } } });
  const schedule = await deps.reregister(manifestPath);
  if (!schedule?.verified) throw qbdFailure('QB_SCHEDULE_UNVERIFIED');
  // Retain the binding on failure so the company cannot be silently changed.
  deps.assertOwned?.(); await deps.bindingStore.remove();
  return { status: 'disconnected', removed: forgotten.removed,
    notice: 'Remove the grant in QuickBooks: Edit > Preferences > Integrated Applications > Company Preferences.' };
}
