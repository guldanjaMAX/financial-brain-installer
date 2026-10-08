import assert from 'node:assert/strict';
import { test } from 'node:test';

// This goes through the production bridge; a missing artifact must reach the
// pin decision and must not acquire a compile or helper-execution capability.
test('the unshipped Desktop helper fails closed at the pin boundary', async () => {
  const { runQuickBooksDesktop } = await import('../operations/quickbooks-desktop-bridge.mjs');
  let launches = 0;
  let compiles = 0;
  const stages = [];
  const result = runQuickBooksDesktop({ operation: 'probe' }, {
    platform: 'win32',
    onStage: (stage) => stages.push(stage),
    spawnSync: () => { launches++; throw new Error('unexpected helper launch'); },
    compile: () => { compiles++; throw new Error('unexpected compile'); },
  });
  assert.equal(result.code, 'QB_HELPER_UNAVAILABLE');
  assert.deepEqual(result.frames, []);
  assert.ok(stages.includes('helper_pin'));
  assert.equal(launches, 0);
  assert.equal(compiles, 0);
});

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QBD_CONTRACT, QBD_EXIT_CODES, QBD_LIMITS, decodeQbdFrames, encodeQbdFrame,
  qbdPlan, qbdRequests, resolveQbdProcessor, runQuickBooksDesktop, validateQbdResult,
} from '../operations/quickbooks-desktop-bridge.mjs';
import { QBD_ENVIRONMENT, QBD_HELPERS, inspectQuickBooksDesktopHelper } from '../operations/quickbooks-desktop-signed.mjs';
import { checkQbdContract, checkQbdSource, checkQbdIl } from '../scripts/qbd-helper-il-check.mjs';
import { fakeQbdFrames } from './fixtures/qbd-fake-helper.mjs';

const directory = mkdtempSync(join(process.env.HOME, 'qbd-test-'));
const exe = join(directory, 'quickbooks-desktop-helper.exe');
writeFileSync(exe, 'synthetic inert test artifact');
const artifact = { path: exe, sha256: createHash('sha256').update(readFileSync(exe)).digest('hex') };
const clock = new Date('2026-10-07T12:00:00Z');
const input = { operation: 'snapshot', historySince: '2024-10-07T00:00:00Z', accountListIds: ['AA-12'], storedTxnIds: ['BB-13'] };
const plan = qbdPlan(input, clock);
const source = readFileSync(new URL('../operations/quickbooks-desktop-helper.cs', import.meta.url), 'utf8');
const fixture = fileURLToPath(new URL('./fixtures/qbd-fake-helper.mjs', import.meta.url));
const clone = (value) => structuredClone(value);
const stream = (frames) => Buffer.concat(frames.map((frame) => encodeQbdFrame(frame)));
const identity = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 2, size: 4096, mtimeMs: 100, ctimeMs: 100 };
const processorPath = 'C:\\Program Files (x86)\\Common Files\\Intuit\\QBXMLRP2.dll';
function harness({ mode = 'complete', registration = 'x86', serverPath = processorPath, processorSigned = true,
  helperSigned = true, signatureStatus = 0, artifacts = { x86: artifact, x64: null }, raw, exit = 0 } = {}) {
  const calls = { launches: 0, compiles: 0, registry: [], signatures: [], stages: [], argv: null, environment: null };
  const dependencies = {
    platform: 'win32', artifacts, now: () => clock,
    environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\Owner', BRAIN_ADMIN_KEY: 'ENV_SENTINEL' },
    onStage: (stage) => calls.stages.push(stage),
    processorFs: { lstatSync: () => identity, realpathSync: (path) => path },
    registryRun: (command, args, options) => {
      calls.registry.push(args);
      assert.match(command, /reg\.exe$/);
      assert.equal(options.shell, false);
      assert.ok(!Object.hasOwn(options.env, 'BRAIN_ADMIN_KEY'));
      const view = args.at(-1);
      if (registration === 'none' || (registration === 'x86' && view !== '/reg:32') || (registration === 'x64' && view !== '/reg:64')) return { status: 1, stdout: '' };
      return { status: 0, stdout: `\n    (Default)    REG_SZ    ${args[1].endsWith('InprocServer32') ? serverPath : '{01234567-89AB-CDEF-0123-456789ABCDEF}'}\n` };
    },
    signatureRun: (command, args, options) => {
      calls.signatures.push(options.input);
      assert.match(command, /powershell\.exe$/);
      assert.ok(args.includes('-NonInteractive'));
      assert.match(args.at(-1), /Get-AuthenticodeSignature/);
      assert.match(args.at(-1), /Status -ne 'Valid'/);
      assert.match(args.at(-1), options.input === processorPath ? /O=Intuit/ : /O=Financial Brain LLC/);
      assert.equal(options.shell, false);
      assert.ok(!Object.hasOwn(options.env, 'BRAIN_ADMIN_KEY'));
      return { status: options.input === processorPath ? (processorSigned ? 0 : 1) : (helperSigned ? signatureStatus : 1), stdout: Buffer.alloc(0) };
    },
    spawnSync: (path, args, options) => {
      calls.launches++; calls.argv = args; calls.environment = options.env;
      assert.equal(path, artifacts[registration === 'x64' ? 'x64' : 'x86'].path);
      assert.equal(options.shell, false);
      assert.equal(options.stdio[2], 'ignore');
      assert.ok(Number(args[1]) < options.timeout);
      assert.deepEqual(decodeQbdFrames(options.input), [qbdPlan({ ...input, operation: args[0] }, clock)]);
      if (raw) return { status: exit, stdout: Buffer.from(raw), stderr: Buffer.from('SENTINEL_ERROR') };
      return spawnSync(process.execPath, [fixture, '--fake', mode, args[0]], { ...options });
    },
    compile: () => { calls.compiles++; throw new Error('compile forbidden'); },
  };
  return { calls, dependencies, run: (request = input) => runQuickBooksDesktop(request, dependencies) };
}

test('complete fake helper reaches registry, signatures, spawn and returns the full planned set', () => {
  const h = harness(); const result = h.run();
  assert.equal(result.ok, true);
  assert.equal(h.calls.launches, 1);
  assert.equal(h.calls.compiles, 0);
  assert.equal(h.calls.signatures.length, 2);
  assert.equal(h.calls.registry.length, 3);
  assert.equal(result.frames.at(-1).requests.length, qbdRequests('snapshot', plan).length);
  assert.deepEqual(h.calls.argv, ['snapshot', '30000']);
  assert.ok(Object.keys(h.calls.environment).every((key) => QBD_ENVIRONMENT.includes(key)));
  assert.ok(!JSON.stringify(h.calls.environment).includes('ENV_SENTINEL'));
  assert.equal(QBD_HELPERS.x86.sha256, null);
  assert.equal(QBD_HELPERS.x64, null);
});

test('probe and probe2 remain distinct one-session operations', () => {
  // The attended probe now includes the complete bounded account identity read.
  for (const [operation, count] of [['probe', 4], ['probe2', 1]]) {
    const h = harness(); const result = h.run({ operation });
    assert.equal(result.ok, true); assert.equal(h.calls.launches, 1);
    assert.equal(result.frames.at(-1).requests.length, count);
  }
});

for (const mode of ['missing', 'remaining', 'warn']) test(`fake helper ${mode} cannot deliver a partial snapshot`, () => {
  const h = harness({ mode }); const result = h.run();
  assert.equal(h.calls.launches, 1); assert.equal(result.code, 'QB_PARTIAL_VIEW'); assert.deepEqual(result.frames, []);
  assert.equal(harness().run().ok, true);
});

test('timeout is bounded and probe2 classifies repeated consent separately', () => {
  for (const operation of ['snapshot', 'probe2']) {
    const h = harness({ mode: 'timeout' });
    h.dependencies.timeoutMs = 1000; h.dependencies.requestTimeoutMs = 100;
    const result = h.run(operation === 'snapshot' ? input : { operation });
    assert.equal(h.calls.launches, 1);
    assert.equal(result.code, operation === 'probe2' ? 'QB_GRANT_PROMPTS' : 'QB_BUSY');
    assert.deepEqual(result.frames, []);
  }
  assert.equal(harness().run().ok, true);
});

test('every numeric helper failure maps once and delivers no earlier data', () => {
  assert.equal(Object.keys(QBD_EXIT_CODES).length, 14);
  assert.equal(new Set(Object.values(QBD_EXIT_CODES)).size, 14);
  for (const [code, expected] of Object.entries(QBD_EXIT_CODES)) {
    const h = harness({ raw: stream(fakeQbdFrames('snapshot', plan)), exit: Number(code) });
    const result = h.run(); assert.equal(h.calls.launches, 1);
    assert.equal(result.code, expected); assert.deepEqual(result.frames, []);
  }
  const unknown = harness({ raw: stream(fakeQbdFrames('snapshot', plan)), exit: 999 });
  assert.equal(unknown.run().code, 'QB_PARTIAL_VIEW'); assert.equal(unknown.calls.launches, 1);
  assert.equal(harness().run().ok, true);
});

for (const variant of ['missing', 'unpinned', 'invalid-signature', 'wrong-subject']) test(`${variant} artifact never spawns or compiles`, () => {
  const h = harness({ artifacts: { x86: variant === 'missing' ? { ...artifact, path: join(directory, 'absent.exe') } :
    variant === 'unpinned' ? { ...artifact, sha256: '0'.repeat(64) } : artifact, x64: null },
    helperSigned: !['invalid-signature', 'wrong-subject'].includes(variant) });
  const result = h.run();
  assert.equal(result.code, 'QB_HELPER_UNAVAILABLE'); assert.deepEqual(result.frames, []);
  assert.equal(h.calls.launches, 0); assert.equal(h.calls.compiles, 0);
  assert.ok(h.calls.stages.includes(['missing', 'unpinned'].includes(variant) ? 'helper_pin' : 'helper_signature'));
  if (['invalid-signature', 'wrong-subject'].includes(variant)) assert.ok(h.calls.signatures.includes(exe));
  assert.equal(harness().run().ok, true);
});

test('helper identities refuse links, hard links, ancestor redirects, changes and oversized files', () => {
  const fields = [
    { isSymbolicLink: () => true }, { nlink: 2 }, { size: 5 * 1024 * 1024 }, { isFile: () => false },
  ];
  for (const override of fields) {
    let inspected = 0;
    const result = inspectQuickBooksDesktopHelper(artifact, {
      lstatSync: () => { inspected++; return { ...identity, ...override }; },
      realpathSync: (path) => path, readFileSync,
    });
    assert.equal(inspected, 1); assert.equal(result.ok, false);
  }
  let resolves = 0;
  assert.equal(inspectQuickBooksDesktopHelper(artifact, {
    lstatSync: () => identity, realpathSync: () => { resolves++; return '/different/helper.exe'; }, readFileSync,
  }).ok, false);
  assert.equal(resolves, 1);
  const h = harness(); let reads = 0;
  h.dependencies.helperFs = { readFileSync, realpathSync: (path) => path, lstatSync: () => Object.assign(lstatSync(exe), { ino: ++reads > 2 ? 999 : 1 }) };
  assert.equal(h.run().code, 'QB_HELPER_UNAVAILABLE'); assert.equal(h.calls.launches, 0); assert.ok(reads >= 3);
  assert.equal(harness().run().ok, true);
});

for (const [label, options, stage] of [
  ['HKCU only', { registration: 'none' }, 'processor_registry'],
  ['outside Program Files', { serverPath: 'C:\\Users\\Owner\\processor.dll' }, 'processor_registry'],
  ['path traversal', { serverPath: 'C:\\Program Files\\..\\processor.dll' }, 'processor_registry'],
  ['unsigned COM server', { processorSigned: false }, 'processor_signature'],
]) test(`${label} is refused before helper activation`, () => {
  const h = harness(options); const result = h.run();
  assert.equal(result.code, 'QB_PROCESSOR_UNTRUSTED'); assert.equal(h.calls.launches, 0);
  assert.ok(h.calls.stages.includes(stage)); assert.ok(h.calls.registry.length > 0);
  assert.ok(h.calls.registry.every((args) => args[1].startsWith('HKLM\\SOFTWARE\\Classes\\')));
  assert.equal(harness().run().ok, true);
});

test('registry views select x86 and withhold unadopted x64', () => {
  const x86 = harness(); assert.equal(x86.run().ok, true); assert.equal(x86.calls.launches, 1);
  assert.ok(x86.calls.registry.some((args) => args.at(-1) === '/reg:32'));
  assert.ok(x86.calls.registry.some((args) => args.at(-1) === '/reg:64'));
  const x64 = harness({ registration: 'x64' });
  assert.equal(x64.run().code, 'QB_HELPER_UNAVAILABLE'); assert.equal(x64.calls.launches, 0);
  assert.ok(x64.calls.stages.includes('processor_signature'));
});

test('non-Windows refuses without any native runner', () => {
  const h = harness(); h.dependencies.platform = 'darwin';
  assert.equal(h.run().code, 'QB_NOT_INSTALLED'); assert.equal(h.calls.launches, 0); assert.equal(h.calls.registry.length, 0);
  assert.equal(harness().run().ok, true);
});

test('stdin identities and history bound are strict with no one-sided normalization', () => {
  for (const id of [' aa-12', 'aa-12', 'AA-12 ', 'AA-12\n', '<InvoiceAddRq/>', 'AA', 'A'.repeat(17) + '-12']) {
    assert.throws(() => qbdPlan({ ...input, accountListIds: [id] }, clock), /QB_PARTIAL_VIEW/);
  }
  assert.throws(() => qbdPlan({ ...input, storedTxnIds: ['BB-13', 'BB-13'] }, clock));
  for (const historySince of ['2026-02-30T00:00:00Z', '2027-01-01T00:00:00Z', '2024-10-07', ' 2024-10-07T00:00:00Z']) {
    assert.throws(() => qbdPlan({ ...input, historySince }, clock), /QB_PARTIAL_VIEW/);
  }
  assert.deepEqual(qbdPlan(input, clock).accountListIds, ['AA-12']);
});

test('framing bounds, trailing bytes, row counts and the exact terminal request set fail closed', () => {
  const complete = fakeQbdFrames('snapshot', plan);
  assert.equal(validateQbdResult(stream(complete), 'snapshot', plan).ok, true);
  const variants = [
    (f) => { f.at(-1).requests.pop(); },
    (f) => { f.at(-1).requests[1] = clone(f.at(-1).requests[0]); },
    (f) => { f.at(-1).requests[0].rowCount++; },
    (f) => { f.at(-1).requests[0].requestCount = 0; },
    (f) => { f.at(-1).requests.at(-1).matchedCount = -1; },
    (f) => { f.splice(0, 1); },
    (f) => { f[0].request = 'Unknown'; },
    (f) => { f.push(f[0]); },
    (f) => { f[0].entity = 'VendorRet'; },
  ];
  for (const change of variants) {
    const frames = clone(complete); change(frames);
    const result = validateQbdResult(stream(frames), 'snapshot', plan);
    assert.equal(result.code, 'QB_PARTIAL_VIEW'); assert.deepEqual(result.frames, []);
  }
  const over = Buffer.alloc(4); over.writeUInt32BE(QBD_LIMITS.frameBytes + 1);
  for (const bytes of [over, Buffer.from([0, 0]), stream(complete).subarray(0, -1), Buffer.concat([stream(complete), Buffer.from([0])])]) {
    assert.equal(validateQbdResult(bytes, 'snapshot', plan).code, 'QB_PARTIAL_VIEW');
  }
});

test('private sentinel fields and status text never cross the real bridge', () => {
  const h = harness({ mode: 'private' }); const result = h.run();
  assert.equal(h.calls.launches, 1); assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL|ENV_SENTINEL/);
  assert.equal(result.frames.find((f) => f.entity === 'AccountRet').rows[0].Balance, '12.34');
  for (const ret of QBD_CONTRACT.returns) for (const field of ret.fields) assert.doesNotMatch(field, /VendorTaxIdent|BankNumber|AccountNumber|CreditCardInfo|Notes|Desc|SSN|EIN/);
});

test('broad and unknown grants cannot pass a complete transport', () => {
  for (const [field, value, code] of [
    ['CurrentAppAccessRights.IsAutomaticLoginAllowed', 'true', 'QB_GRANT_TOO_BROAD'],
    ['CurrentAppAccessRights.IsReadOnly', 'false', 'QB_GRANT_TOO_BROAD'],
    ['CurrentAppAccessRights.IsPersonalDataAccessAllowed', 'true', 'QB_GRANT_TOO_BROAD'],
    ['CurrentAppAccessRights.IsReadOnly', undefined, 'QB_PARTIAL_VIEW'],
  ]) {
    const frames = fakeQbdFrames('snapshot', plan);
    const preferences = frames.find((frame) => frame.entity === 'PreferencesRet');
    if (value === undefined) delete preferences.rows[0][field]; else preferences.rows[0][field] = value;
    const h = harness({ raw: stream(frames) }); const result = h.run();
    assert.equal(h.calls.launches, 1); assert.equal(result.code, code); assert.deepEqual(result.frames, []);
  }
  assert.equal(harness().run().ok, true);
});

test('source request property rejects every write family and allows the shipped closed set', () => {
  const control = checkQbdSource(source, QBD_CONTRACT);
  assert.equal(control.requestSets, 17); assert.equal(control.returnTypes, 16);
  for (const request of QBD_CONTRACT.requests) assert.match(request.request, /QueryRq$/);
  for (const forbidden of ['InvoiceAddRq', 'AccountModRq', 'TxnDelRq', 'TxnVoidRq', 'DataExtAddRq', 'UnknownQueryRq']) {
    for (let index = 0; index < QBD_CONTRACT.requests.length; index++) {
      const contract = clone(QBD_CONTRACT); contract.requests[index].request = forbidden;
      assert.throws(() => checkQbdSource(source, contract), /QB_HELPER_STATIC_REFUSAL/);
    }
  }
  for (const ret of QBD_CONTRACT.returns) {
    const contract = clone(QBD_CONTRACT); contract.returns.find((item) => item.name === ret.name).fields.push('AccountNumber');
    assert.throws(() => checkQbdContract(contract), /QB_HELPER_STATIC_REFUSAL/);
  }
});

for (const fixtureSource of ['System.Net.Http.HttpClient', 'Process.Start("tool")', 'XmlDocument.Load("http://example.invalid")',
  'Type.GetTypeFromProgID(variable)', 'Type.GetTypeFromCLSID(variable)', 'Sockets.Socket']) test(`forbidden source API ${fixtureSource.split(/[.(]/)[0]}`, () => {
  assert.equal(checkQbdSource(source, QBD_CONTRACT).requestSets, 17);
  assert.throws(() => checkQbdSource(source + '\n' + fixtureSource, QBD_CONTRACT), /QB_HELPER_STATIC_REFUSAL/);
});

test('metadata gate checks actual referenced types, members and native imports against allowlists', () => {
  const metadata = { format: 'qbd-metadata-v1', assemblies: ['mscorlib', 'System.Xml'], types: ['System.String', 'System.Xml.XmlDocument'],
    members: [{ type: 'System.String', name: 'get_Length' }], pinvokes: [
      'advapi32.dll::RegOpenKeyExW', 'advapi32.dll::RegOverridePredefKey', 'advapi32.dll::RegCloseKey',
      'ole32.dll::CoEnableCallCancellation', 'ole32.dll::CoDisableCallCancellation', 'ole32.dll::CoCancelCall', 'kernel32.dll::GetCurrentThreadId',
    ] };
  assert.equal(checkQbdIl(metadata).native, 7);
  for (const type of ['System.Net.Http.HttpClient', 'System.Diagnostics.Process', 'System.Xml.XmlUrlResolver', 'System.Net.Sockets.Socket']) {
    const bad = clone(metadata); bad.types.push(type);
    assert.throws(() => checkQbdIl(bad), /QB_HELPER_STATIC_REFUSAL/);
  }
  const load = clone(metadata); load.members.push({ type: 'System.Reflection.Assembly', name: 'LoadFrom' });
  assert.throws(() => checkQbdIl(load), /QB_HELPER_STATIC_REFUSAL/);
  const native = clone(metadata); native.pinvokes[0] = 'wininet.dll::InternetOpen';
  assert.throws(() => checkQbdIl(native), /QB_HELPER_STATIC_REFUSAL/);
  assert.throws(() => checkQbdIl({ ...metadata, members: [] }), /QB_HELPER_STATIC_REFUSAL/);
});

test('broken fake-helper stdout records session cleanup before exit', async () => {
  const marker = join(directory, 'lifecycle.txt');
  const child = spawn(process.execPath, [fixture, '--fake', 'broken-pipe', 'snapshot', marker], {
    env: { HOME: process.env.HOME, BRAIN_NO_WRANGLER_LOGIN: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = once(child, 'exit');
  child.stdin.end(encodeQbdFrame(plan));
  await once(child.stdout, 'data');
  child.stdout.destroy();
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'EndSession\nCloseConnection\n');
  assert.equal(harness().run().ok, true);
});

test('source gate also rejects an aliased process type', () => {
  assert.equal(checkQbdSource(source, QBD_CONTRACT).requestSets, 17);
  assert.throws(() => checkQbdSource(source + '\nusing Runner = System.Diagnostics.Process;', QBD_CONTRACT), /QB_HELPER_STATIC_REFUSAL/);
});

test('timed session acquisition retains the ticket for cleanup even after its deadline', () => {
  assert.ok(/ticket = call\(delegate \{ ticket = processor\.Begin\(\); return ticket; \}\)/.test(source));
  assert.match(source, /if \(ticket != null\) call\(delegate \{ processor\.End\(ticket\)/);
});

test('signing workflow gates source, compiled metadata, stub lifecycle and RFC 3161 before artifact adoption', () => {
  const workflow = readFileSync(new URL('../.github/workflows/quickbooks-desktop-helper-signing.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m);
  assert.match(workflow, /if: github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)];
  assert.ok(actions.length >= 5);
  for (const [, ref] of actions) assert.match(ref, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i);
  assert.match(workflow, /\/platform:x86/);
  assert.doesNotMatch(workflow, /\/platform:x64|secrets\.|client-secret/);
  for (const required of ['qbd-helper-il-check.mjs --il', '/main:QbdHelperTests', 'ReflectionOnlyLoadFrom',
    'ReflectionOnlyAssemblyResolve', 'Get-AuthenticodeSignature', 'TimeStamperCertificate',
    'Get-FileHash -Algorithm SHA256', 'O=Financial Brain LLC', "1.3.6.1.4.1.311.3.3.1"]) assert.ok(workflow.includes(required), required);
  assert.match(workflow, /SignedCms/);
  assert.match(workflow, /UnsignedAttributes/);
  assert.match(source, /EntryPoint = "RegOpenKeyExW", ExactSpelling = true/);
  assert.ok(workflow.indexOf('qbd-helper-il-check.mjs --il') < workflow.indexOf('uses: azure/login'));
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!packageJson.files.includes('operations/quickbooks-desktop-helper.exe'));
});

test('helper throws and overflow errors cannot disclose native text or staged frames', () => {
  for (const failure of ['throw', 'ENOBUFS']) {
    const h = harness();
    h.dependencies.spawnSync = () => {
      h.calls.launches++;
      if (failure === 'throw') throw new Error('SENTINEL_RECORD C:\\SENTINEL_COMPANY\\data.qbw');
      return { status: 0, error: { code: 'ENOBUFS', message: 'SENTINEL_RECORD' }, stdout: stream(fakeQbdFrames('snapshot', plan)) };
    };
    const result = h.run();
    assert.equal(h.calls.launches, 1); assert.equal(result.code, 'QB_PARTIAL_VIEW'); assert.deepEqual(result.frames, []);
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
  }
  assert.equal(harness().run().ok, true);
});

test('Authenticode fixed script distinguishes the exact organization from an embedded name', () => {
  for (const [status, subject, expected] of [
    ['Valid', 'CN=Code\nO=Financial Brain LLC\nC=US', true],
    ['Valid', 'O=Other\nCN=Financial Brain LLC', false],
    ['Valid', 'O=Financial Brain LLC Extra', false],
    ['UnknownError', 'O=Financial Brain LLC', false],
    ['NotSigned', 'O=Financial Brain LLC', false],
  ]) {
    const h = harness(); const native = h.dependencies.signatureRun;
    let checks = 0;
    h.dependencies.signatureRun = (command, args, options) => {
      if (options.input !== exe) return native(command, args, options);
      checks++;
      const script = args.at(-1);
      const match = script.match(/-cnotmatch '\(\?m\)([^']+)'/);
      assert.ok(match); assert.match(script, /Status -ne 'Valid'/);
      const valid = status === 'Valid' && new RegExp(match[1], 'm').test(subject);
      return { status: valid ? 0 : 1 };
    };
    const result = h.run();
    assert.equal(checks, 1); assert.equal(result.ok, expected); assert.equal(h.calls.launches, expected ? 1 : 0);
    assert.equal(h.calls.compiles, 0);
  }
});

test('snapshot cannot skip a zero-row request batch or accept a malformed metadata count', () => {
  const control = fakeQbdFrames('snapshot', plan);
  const empty = control.find((frame) => frame.entity === 'VendorRet');
  assert.equal(empty.rows.length, 0);
  const missing = clone(control).filter((frame) => frame.request !== empty.request);
  assert.equal(validateQbdResult(stream(missing), 'snapshot', plan).code, 'QB_PARTIAL_VIEW');
  const metadata = clone(control); metadata.at(-1).requests.at(-1).matchedCount = '2';
  assert.equal(validateQbdResult(stream(metadata), 'snapshot', plan).code, 'QB_PARTIAL_VIEW');
  assert.equal(validateQbdResult(stream(control), 'snapshot', plan).ok, true);
});
