import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STEP_SCHEMA, validateStep, collectStep, compareOracle, parseReportCsv,
  assertPrivate, captureStep, writeBundle, buildReceipt, runKit,
} from '../scripts/qbd-field-acceptance.mjs';
import * as kit from '../scripts/qbd-field-acceptance.mjs';
import { desktopFixture, desktopBridge, SNAPSHOT } from './fixtures/quickbooks-desktop-qbxml.mjs';
import { createQuickBooksGuardForTest, PROVEN_SIGN_TYPES } from '../connectors/quickbooks-guard.mjs';
import { QBD_CONTRACT } from '../operations/quickbooks-desktop-bridge.mjs';
import { createHash } from 'node:crypto';
import { fakeQbdFrames } from './fixtures/qbd-fake-helper.mjs';
import { qbdPlan, runQuickBooksDesktop } from '../operations/quickbooks-desktop-bridge.mjs';

const now = () => new Date('2026-10-07T12:00:00.000Z');
const identities = { user: 'SENTINEL_OPERATOR', machine: 'SENTINEL_WORKSTATION' };
const input = { operation: 'snapshot', historySince: '2024-10-07T00:00:00Z', accountListIds: ['AA-12'], storedTxnIds: [] };
const frames = () => fakeQbdFrames('snapshot', qbdPlan(input, now()));
const values = (step) => Object.fromEntries(Object.entries(STEP_SCHEMA[step]).map(([key, type]) =>
  [key, Array.isArray(type) ? type[0] : type === 'boolean' ? true : 1]));
const observations = () => Object.fromEntries(Object.keys(STEP_SCHEMA).map((step) => [step, values(step)]));
const folder = (t) => {
  const directory = mkdtempSync(join(process.env.HOME, 'qbd-kit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const expected = [{ report: 'balance_sheet', key: 'Checking', currency: 'USD', amount: '1000.00' }];
const rendered = [{ ...expected[0], surface: 'opening', posting: 'P1' }];

test('cent oracle compares real rows: green control and deliberate one-cent mismatch', () => {
  const good = compareOracle({ rendered, expected, withheld: [] });
  assert.equal(good.compared, 1); assert.equal(good.ok, true); assert.equal(good.matches.length, 1);
  const bad = compareOracle({ rendered: [{ ...rendered[0], amount: '1000.01' }], expected, withheld: [] });
  assert.equal(bad.compared, 1); assert.equal(bad.ok, false);
  assert.equal(bad.mismatches[0].differenceCents, '1');
});

test('oracle uses exact signed cents, preserves withholds and refuses empty coverage', () => {
  const huge = '999999999999999999999999.99';
  const rows = [{ ...rendered[0], amount: huge }];
  assert.equal(compareOracle({ rendered: rows, expected: [{ ...expected[0], amount: huge }] }).ok, true);
  const sign = compareOracle({ rendered: [{ ...rendered[0], amount: '-1000.00' }], expected });
  assert.equal(sign.compared, 1); assert.equal(sign.mismatches[0].differenceCents, '-200000');
  const withheld = [{ record: 'bill:BB-13', reason: 'OPEN_AMOUNT_ABSENT', posting: 'P3' }];
  const result = compareOracle({ rendered: [], expected, withheld });
  assert.equal(result.expectedCount, 1); assert.equal(result.ok, false);
  assert.deepEqual(result.withheld, withheld);
  assert.equal(compareOracle({ rendered, expected }).ok, true);
});

test('oracle refuses duplicate report identity, missing match, extra precision and currency drift', () => {
  assert.equal(compareOracle({ rendered, expected }).ok, true);
  for (const change of [
    { expected: [...expected, ...expected] },
    { expected: [] },
    { rendered: [{ ...rendered[0], amount: '1000.001' }] },
    { expected: [{ ...expected[0], currency: 'EUR' }] },
    { expected: [{ ...expected[0], key: ' Checking' }] },
  ]) {
    const result = compareOracle({ rendered, expected, ...change });
    assert.ok(result.checked > 0); assert.equal(result.ok, false);
  }
});

test('CSV reader accepts quoted commas, escaped quotes and parentheses without float rounding', () => {
  const csv = '\uFEFFAccount,Currency,Balance\r\n"Checking, main",USD,"1,000.00"\r\n"Card ""one""",USD,(123.45)\r\n';
  const result = parseReportCsv(csv, { report: 'balance_sheet', keyColumn: 'Account', currencyColumn: 'Currency', amountColumn: 'Balance' });
  assert.equal(result.length, 2); assert.equal(result[0].amount, '1000.00');
  assert.equal(result[1].amount, '-123.45'); assert.equal(result[1].key, 'Card "one"');
  assert.throws(() => parseReportCsv('Account,Currency,Balance\nChecking,USD,"1,00.00"', {
    report: 'balance_sheet', keyColumn: 'Account', currencyColumn: 'Currency', amountColumn: 'Balance',
  }), /KIT_CSV_INVALID/);
});

test('every required step and every field is typed, missing fields never pass', () => {
  assert.deepEqual(Object.keys(STEP_SCHEMA), ['A0', 'A1', 'A2', 'A3', 'A4', 'B1', 'S1', 'E1', 'E2', 'E3', 'N1', 'W1', 'W2', 'R1', 'T1', 'I1', 'F1', 'X1']);
  for (const step of Object.keys(STEP_SCHEMA)) {
    const control = values(step);
    assert.equal(validateStep(step, control).ok, true);
    for (const key of Object.keys(control)) {
      const missing = { ...control }; delete missing[key];
      const result = validateStep(step, missing);
      assert.ok(result.checked > 0); assert.equal(result.ok, false); assert.ok(result.missing.includes(key));
    }
    const extra = validateStep(step, { ...control, notes: 'not accepted' });
    assert.ok(extra.checked > 0); assert.equal(extra.ok, false);
  }
});

test('prompts record typed selections only and reject free-text without echoing it', async () => {
  const asked = [];
  const result = await collectStep('A0', async (prompt) => { asked.push(prompt); return prompt.includes('yes/no') ? 'yes' : '3'; });
  assert.equal(asked.length, Object.keys(STEP_SCHEMA.A0).length);
  assert.equal(validateStep('A0', result).ok, true);
  let badAsked = 0;
  await assert.rejects(collectStep('A0', async () => { badAsked++; return identities.user; }), /KIT_ANSWER_INVALID/);
  assert.equal(badAsked, 1);
});

test('privacy scan rejects both sentinels, case variants and JSON-escaped values before any write', (t) => {
  const directory = folder(t);
  assert.doesNotThrow(() => assertPrivate(frames(), identities));
  for (const sentinel of [identities.user.toLowerCase(), identities.machine]) {
    const bad = frames(); bad[0].rows[0].ProductName = sentinel;
    const stages = [];
    assert.throws(() => writeBundle(join(directory, 'refused'), { 'frames.json': bad }, {
      identities, onStage: (stage) => stages.push(stage),
    }), /KIT_PRIVACY_REFUSED/);
    assert.ok(stages.includes('privacy')); assert.deepEqual(readdirSync(directory), []);
  }
  const encoded = '{"value":"\\u0053ENTINEL_OPERATOR"}';
  assert.throws(() => assertPrivate(encoded, identities), /KIT_PRIVACY_REFUSED/);
  assert.throws(() => assertPrivate(frames(), { user: '', machine: identities.machine }), /KIT_IDENTITY_REQUIRED/);
  const receipt = writeBundle(join(directory, 'good'), { 'frames.json': frames() }, { identities });
  assert.equal(receipt.files.length, 1); assert.match(receipt.files[0].sha256, /^[a-f0-9]{64}$/);
});

test('capture uses the bridge result and terminal validation, with no partial fixture write', (t) => {
  const directory = folder(t); let reads = 0;
  const deps = { identities, now, monotonic: (() => { let n = 0; return () => (n += 25); })(),
    platform: 'win32', architecture: 'x64', bridge: (request) => {
      reads++; assert.deepEqual(request, input); return { ok: true, code: null, frames: frames() };
    } };
  const control = captureStep({ step: 'T1', input, inventedOnly: true, out: join(directory, 'good') }, deps);
  assert.equal(reads, 1); assert.equal(control.capture.ok, true); assert.equal(control.capture.elapsedMs, 25);
  assert.equal(JSON.parse(readFileSync(join(directory, 'good', 'frames.json'))).at(-1).type, 'terminal');
  const stages = [];
  const failed = captureStep({ step: 'T1', input, inventedOnly: true, out: join(directory, 'partial') }, {
    ...deps, onStage: (stage) => stages.push(stage), bridge: () => { reads++; return { ok: true, frames: frames().slice(0, -1) }; },
  });
  assert.equal(reads, 2); assert.ok(stages.includes('terminal'));
  assert.equal(failed.capture.ok, false); assert.equal(failed.capture.code, 'QB_PARTIAL_VIEW');
  assert.ok(!readdirSync(join(directory, 'partial')).includes('frames.json'));
});

test('capture refuses ARM, missing fixture attestation and write operations before bridge use', (t) => {
  const directory = folder(t); let reads = 0;
  const deps = { identities, now, platform: 'win32', architecture: 'x64', bridge: () => {
    reads++; return { ok: true, frames: frames(), code: null };
  } };
  captureStep({ step: 'T1', input, inventedOnly: true, out: join(directory, 'good') }, deps);
  assert.equal(reads, 1);
  for (const arm of [
    { options: { inventedOnly: false } }, { dependencies: { architecture: 'arm64' } },
    { options: { input: { operation: 'add' } } }, { options: { step: 'R1' } },
  ]) {
    const stages = [];
    assert.throws(() => captureStep({ step: 'T1', input, inventedOnly: true, out: join(directory, 'bad'), ...arm.options }, {
      ...deps, ...arm.dependencies, onStage: (stage) => stages.push(stage),
    }), /KIT_/);
    assert.ok(stages.includes('preflight')); assert.equal(reads, 1);
  }
});

test('receipt counts all steps, rejects missing data and never equates synthetic proof with field approval', () => {
  const good = buildReceipt({ observations: observations(), captures: [], oracle: compareOracle({ rendered, expected }) }, { now });
  assert.equal(good.observationCount, 18); assert.equal(good.observationsComplete, true);
  assert.equal(good.status, 'NOT_READY'); assert.ok(good.blockers.includes('PRODUCTION_FRESHNESS_IMPLEMENTATION_REQUIRED'));
  assert.equal(good.proposals.applied, false);
  assert.deepEqual(good.proposals.signTypes.desktop, []);
  for (const step of Object.keys(STEP_SCHEMA)) {
    const incomplete = observations(); delete incomplete[step];
    const result = buildReceipt({ observations: incomplete, captures: [] }, { now });
    assert.equal(result.observationCount, 17); assert.equal(result.observationsComplete, false);
    assert.ok(result.invalidSteps.includes(step));
  }
});

test('new output directory is mandatory, and existing evidence is preserved', (t) => {
  const directory = folder(t); const target = join(directory, 'receipt');
  writeBundle(target, { 'receipt.json': { count: 1 } }, { identities });
  let stage = '';
  assert.throws(() => writeBundle(target, { 'receipt.json': { count: 2 } }, { identities, onStage: (s) => { stage = s; } }), /KIT_OUTPUT_EXISTS/);
  assert.equal(stage, 'write'); assert.equal(JSON.parse(readFileSync(join(target, 'receipt.json'))).count, 1);
});

test('CLI exposes typed observe, rejects unknown options and sanitizes all thrown errors', async (t) => {
  const directory = folder(t); const output = []; let asked = 0;
  const deps = { identities, now, output: (value) => output.push(value), ask: async (prompt) => {
    asked++; return prompt.includes('yes/no') ? 'yes' : '1';
  } };
  const status = await runKit(['observe', '--step', 'A0', '--out', join(directory, 'observe')], deps);
  assert.equal(status, 0); assert.ok(asked > 0);
  const observation = JSON.parse(readFileSync(join(directory, 'observe', 'observation.json')));
  assert.equal(validateStep('A0', observation.values).ok, true);
  const rejected = await runKit(['observe', '--step', 'A0', '--out', join(directory, 'other'), '--unknown', identities.user], deps);
  assert.equal(rejected, 1); assert.ok(!output.join('').includes(identities.user));
  const failed = await runKit(['observe', '--step', 'A0', '--out', join(directory, 'failure')], {
    ...deps, ask: async () => { throw new Error(identities.machine); },
  });
  assert.equal(failed, 1); assert.ok(!output.join('').includes(identities.machine));
});

test('every step writes its typed observation through the CLI', async (t) => {
  const directory = folder(t);
  for (const step of Object.keys(STEP_SCHEMA)) {
    let prompts = 0;
    const status = await runKit(['observe', '--step', step, '--out', join(directory, step)], {
      identities, now, output: () => {}, ask: async (prompt) => { prompts++; return prompt.includes('yes/no') ? 'no' : '1'; },
    });
    assert.equal(prompts, Object.keys(STEP_SCHEMA[step]).length); assert.equal(status, 0);
    const record = JSON.parse(readFileSync(join(directory, step, 'observation.json')));
    assert.equal(record.step, step); assert.equal(validateStep(step, record.values).ok, true);
  }
});

test('CSV inputs flow through compare CLI with both green and one-cent failing controls', async (t) => {
  const directory = folder(t); const source = join(directory, 'input.json'); const output = [];
  const csv = { report: 'balance_sheet', csv: 'Account,Currency,Balance\nChecking,USD,1000.00\n', keyColumn: 'Account', currencyColumn: 'Currency', amountColumn: 'Balance' };
  for (const [label, amount, status] of [['match', '1000.00', 0], ['mismatch', '1000.01', 2]]) {
    writeFileSync(source, JSON.stringify({ inventedOnly: true, rendered: [{ ...rendered[0], amount }], reports: [csv] }));
    assert.equal(await runKit(['compare', '--input', source, '--out', join(directory, label)], { identities, now, output: (value) => output.push(value) }), status);
    const result = JSON.parse(readFileSync(join(directory, label, 'oracle.json')));
    assert.equal(result.compared, 1); assert.equal(result.mappingVerified, false);
    assert.equal(result.fieldAcceptance, 'NOT_READY');
  }
  assert.equal(output.length, 2);
});

test('errors cannot smuggle private text through a forged code property', async (t) => {
  const directory = folder(t); const output = []; let calls = 0;
  const status = await runKit(['observe', '--step', 'A0', '--out', join(directory, 'bad')], {
    identities, now, output: (value) => output.push(value), ask: async () => {
      calls++; throw Object.assign(new Error('private'), { kitCode: identities.user });
    },
  });
  assert.equal(calls, 1); assert.equal(status, 1); assert.ok(!output.join('').includes(identities.user));
  assert.deepEqual(readdirSync(directory), []);
  let questions = 0;
  assert.equal(await runKit(['observe', '--step', 'A0', '--out', join(directory, 'good')], {
    identities, now, output: () => {}, ask: async (prompt) => { questions++; return prompt.includes('yes/no') ? 'yes' : '1'; },
  }), 0);
  assert.ok(questions > 0);
});

test('B1 captures resolved registry views and signer without invoking a helper', (t) => {
  const directory = folder(t); let registries = 0, launches = 0;
  const result = captureStep({ step: 'B1', input: { operation: 'registry' }, inventedOnly: true, out: join(directory, 'registry') }, {
    identities, now, platform: 'win32', architecture: 'x64', environment: {}, bridge: () => { launches++; },
    registry: () => { registries++; return { ok: true, registrations: [{ architecture: 'x86', path: 'C:\\Program Files (x86)\\Intuit\\processor.dll', clsid: '{01234567-89AB-CDEF-0123-456789ABCDEF}' }] }; },
  });
  assert.equal(result.capture.ok, true); assert.equal(registries, 1); assert.equal(launches, 0);
  const evidence = JSON.parse(readFileSync(join(directory, 'registry', 'registry.json')));
  assert.deepEqual(evidence.viewsQueried, [32, 64]); assert.equal(evidence.signer, 'Intuit');
});

test('capture checks existing output before it can open a native session', (t) => {
  const directory = folder(t); const out = join(directory, 'capture'); let reads = 0;
  const deps = { identities, now, platform: 'win32', architecture: 'x64', environment: {}, bridge: () => {
    reads++; return { ok: true, code: null, frames: frames() };
  } };
  captureStep({ step: 'T1', input, inventedOnly: true, out }, deps);
  assert.equal(reads, 1); const stages = [];
  assert.throws(() => captureStep({ step: 'T1', input, inventedOnly: true, out }, {
    ...deps, onStage: (stage) => stages.push(stage),
  }), /KIT_OUTPUT_EXISTS/);
  assert.ok(stages.includes('output_preflight')); assert.equal(reads, 1);
});

test('current production bridge reaches the unadopted pin boundary without any native launch', (t) => {
  const directory = folder(t); let native = 0; const stages = [];
  const deps = { identities, now, platform: 'win32', architecture: 'x64', environment: {}, onStage: (stage) => stages.push(stage),
    bridge: (request, dependencies) => runQuickBooksDesktop(request, {
      ...dependencies, platform: 'win32', spawnSync: () => { native++; },
      registryRun: () => { native++; }, signatureRun: () => { native++; },
    }),
  };
  const result = captureStep({ step: 'T1', input, inventedOnly: true, out: join(directory, 'unpinned') }, deps);
  assert.equal(result.capture.ok, false); assert.equal(result.capture.code, 'QB_HELPER_UNAVAILABLE');
  assert.ok(stages.includes('helper_pin')); assert.equal(native, 0);
  assert.deepEqual(readdirSync(join(directory, 'unpinned')), ['capture.json']);
  let fakeReads = 0;
  const control = captureStep({ step: 'T1', input, inventedOnly: true, out: join(directory, 'control') }, {
    ...deps, bridge: () => { fakeReads++; return { ok: true, frames: frames(), code: null }; },
  });
  assert.equal(fakeReads, 1); assert.equal(control.capture.ok, true);
});

// Round 2 probes use the actual connector fixtures and mapper, without native calls.
async function replayInput() {
  const rows = desktopFixture();
  const bridge = desktopBridge(rows);
  const request = { operation: 'snapshot', historySince: '2024-10-07T12:00:00Z', accountListIds: ['AA-12'], storedTxnIds: [] };
  const contractSha256 = createHash('sha256').update(JSON.stringify(QBD_CONTRACT)).digest('hex');
  const fixture = async operation => ({ schema: 2, operation, capturedAt: SNAPSHOT, contractSha256,
    plan: qbdPlan(operation === 'probe' ? { operation } : request, now()), frames: (await bridge(operation === 'probe' ? { operation } : request)).frames });
  return { inventedOnly: true, probe: await fixture('probe'), snapshot: await fixture('snapshot') };
}

test('replay CLI runs real mapping and connector; emitted fixtures keep the production hold', async t => {
  const directory = folder(t); const source = join(directory, 'input.json');
  writeFileSync(source, JSON.stringify(await replayInput())); const output = [];
  const status = await runKit(['replay', '--input', source, '--out', join(directory, 'replay')], { identities, now, output: value => output.push(value) });
  assert.equal(status, 0);
  const replay = JSON.parse(readFileSync(join(directory, 'replay', 'replay.json')));
  assert.equal(replay.records.length, 9); assert.equal(replay.connector.documents.length, 9);
  assert.equal(replay.connector.code, 'QB_FRESHNESS_UNVERIFIED');
  assert.ok(replay.cells.some(cell => cell.surface === 'money' && cell.amount === '75.00'));
  assert.ok(replay.records.find(record => record.record === 'account:AA-12').refusalReasons.includes('QB_SHARED_GUARD'));
  assert.deepEqual(PROVEN_SIGN_TYPES.desktop, []);
  assert.ok(!output.join('').includes('Customer One'));
});

test('mapped oracle covers every emitted cell; one cent, omissions and duplicate selectors refuse', async () => {
  const replay = await kit.replayFixtures(await replayInput());
  const selections = replay.cells.map((cell, i) => ({ cell: cell.id, posting: 'P5', report: 'ar_aging', key: String(i) }));
  const expected = replay.cells.map((cell, i) => ({ report: 'ar_aging', key: String(i), currency: cell.currency, amount: cell.amount }));
  const good = kit.compareReplay({ replay, selections, expected });
  assert.equal(good.ok, true); assert.equal(good.compared, replay.cells.length); assert.ok(good.compared > 10);
  for (const change of [
    { expected: expected.map((row, i) => i ? row : { ...row, amount: '0.01' }) },
    { selections: selections.slice(1) }, { selections: [...selections, selections[0]] },
  ]) {
    const bad = kit.compareReplay({ replay, selections, expected, ...change });
    assert.ok(bad.checked > 0); assert.equal(bad.ok, false);
  }
});

test('captured fixtures replay through the connector test seam; corrupt terminal and plan reach refusal', async () => {
  const fixture = await replayInput();
  const seam = { guardRecord: createQuickBooksGuardForTest({ desktopSignTypes: ['Bank'], desktopFreshnessVerified: true }) };
  const good = await kit.replayFixtures(fixture, seam);
  assert.equal(good.connector.complete, true); assert.equal(good.connector.documents.length, 9);
  assert.ok(good.cells.some(cell => cell.surface === 'balance' && cell.amount === '1201.00'));
  for (const mutate of [
    value => value.snapshot.frames.pop(),
    value => { value.snapshot.plan.accountListIds = []; },
    value => { value.snapshot.contractSha256 = '0'.repeat(64); },
    value => { value.probe.frames.find(frame => frame.entity === 'AccountRet').rows[0].ListID = 'AF-90'; },
  ]) {
    const bad = structuredClone(fixture); mutate(bad); const stages = [];
    await assert.rejects(kit.replayFixtures(bad, { ...seam, onStage: stage => stages.push(stage) }), /KIT_REPLAY_/);
    assert.ok(stages.includes('fixture_validation'));
  }
});

test('P08 typed controls discriminate a source discovery pass from guessed paths and untested variants', () => {
  const control = { tested: true, source: 'session_api', openFileBound: true, fingerprintMatched: true, renameStable: true,
    switchDetected: true, sameFingerprintCopyDetected: true, restoreDetected: true, closedFileRefused: true,
    statBeforeAfterMatched: true, writeTimeAdvanced: true, networkFileVerified: true, leastPrivilege: true,
    noPathPersisted: true, noNetwork: true };
  assert.equal(validateStep('F1', control).ok, true);
  assert.equal(kit.evaluateFreshnessDiscovery(control).ok, true);
  for (const key of ['source', 'sameFingerprintCopyDetected', 'statBeforeAfterMatched', 'closedFileRefused']) {
    const result = kit.evaluateFreshnessDiscovery({ ...control, [key]: key === 'source' ? 'none' : false });
    assert.ok(result.checked > 0); assert.equal(result.ok, false);
  }
});


test('bill open-item comparison actually reaches the matching renderer request', async () => {
  const replay = await kit.replayFixtures(await replayInput());
  const bill = replay.records.find(record => record.ret === 'BillRet');
  assert.ok(bill.row.Balance, 'the real mapped bill has an open balance');
  assert.match(bill.surfaces.open_items, /we owe USD 25.00/);
  assert.ok(replay.cells.some(cell => cell.record === bill.record && cell.surface === 'open_items'));
});

test('field inventory distinguishes helper-uncapturable currency flag from observed provider data', async () => {
  const fixture = await replayInput();
  fixture.snapshot.frames.find(frame => frame.entity === 'CurrencyRet').rows[0].IsUserDefined = 'true';
  const replay = await kit.replayFixtures(fixture);
  const unsupported = replay.fieldCoverage.find(row => row.ret === 'CurrencyRet' && row.field === 'IsUserDefined');
  const control = replay.fieldCoverage.find(row => row.ret === 'CurrencyRet' && row.field === 'CurrencyCode');
  assert.equal(control.observedRows, 1); assert.equal(control.transport, 'supported');
  assert.equal(unsupported.observedRows, 0); assert.equal(unsupported.transport, 'uncapturable');
  assert.ok(replay.blockers.includes('HELPER_FIELD_UNCAPTURABLE'));
  assert.equal(replay.fieldAcceptance, 'NOT_READY');
});


test('mapped comparison CLI catches exactly one cent and retains complete replay evidence', async t => {
  const directory = folder(t); const source = join(directory, 'input.json');
  const fixture = await replayInput(); const replay = await kit.replayFixtures(fixture);
  const selections = replay.cells.map((cell, i) => ({ cell: cell.id, report: 'transaction_detail', key: `cell-${i}`, posting: cell.record.startsWith('account:') ? 'P1' : 'P5' }));
  const invoice = replay.records.find(row => row.ret === 'InvoiceRet');
  assert.match(invoice.surfaces.opening, /total USD 75.00, open balance USD 75.00/);
  for (const [label, delta, expectedStatus] of [['control', 0n, 0], ['cent', 1n, 2]]) {
    const amounts = replay.cells.map(cell => cell.amount);
    const changed = BigInt(amounts[0].replace('.', '')) + delta;
    amounts[0] = `${changed / 100n}.${String(changed % 100n).padStart(2, '0')}`;
    const csv = 'Record,Currency,Amount\n' + replay.cells.map((cell, i) => `cell-${i},${cell.currency},${amounts[i]}`).join('\n') + '\n';
    writeFileSync(source, JSON.stringify({ ...fixture, selections, reports: [{ report: 'transaction_detail', csv,
      keyColumn: 'Record', currencyColumn: 'Currency', amountColumn: 'Amount' }] }));
    const output = [];
    const status = await runKit(['mapped-compare', '--input', source, '--out', join(directory, label)], { identities, now, output: text => output.push(text) });
    assert.equal(status, expectedStatus);
    const oracle = JSON.parse(readFileSync(join(directory, label, 'oracle.json')));
    assert.equal(oracle.compared, replay.cells.length); assert.ok(oracle.compared > 10);
    assert.equal(oracle.mismatches.length, Number(delta));
    if (delta) assert.equal(oracle.mismatches[0].differenceCents, '-1');
    assert.ok(oracle.blockers.includes('HELPER_FIELD_UNCAPTURABLE'));
    if (!delta) assert.equal(oracle.signCandidates[0].type, 'Bank');
    else assert.equal(oracle.signCandidates.length, 0, 'a mismatched raw sign cannot be proposed');
    assert.equal(oracle.idPatterns.TxnID.observed, oracle.idPatterns.TxnID.conforming);
    const saved = JSON.parse(readFileSync(join(directory, label, 'connector-fixture.json')));
    assert.equal((await kit.replayFixtures(saved)).records.length, 9);
    assert.ok(!output.join('').includes('Customer One'));
  }
});

test('real captures create schema-2 fixtures the replay can consume without edits', async t => {
  const directory = folder(t); const fixture = await replayInput(); let captures = 0;
  for (const [step, which] of [['A0', 'probe'], ['P', 'snapshot']]) {
    const part = fixture[which];
    const request = which === 'probe' ? { operation: 'probe' } : { operation: 'snapshot', historySince: part.plan.historySince, accountListIds: part.plan.accountListIds, storedTxnIds: [] };
    const result = captureStep({ step, input: request, inventedOnly: true, out: join(directory, which) }, {
      identities, now, platform: 'win32', architecture: 'x64', environment: {}, bridge: () => { captures++; return { ok: true, frames: part.frames }; },
    });
    assert.equal(result.capture.ok, true);
    fixture[which] = JSON.parse(readFileSync(join(directory, which, 'fixture.json')));
  }
  assert.equal(captures, 2);
  assert.equal((await kit.replayFixtures(fixture)).connector.documents.length, 9);
});

test('fake fixture flags never select the connector proof seam through the CLI', async t => {
  const directory = folder(t), source = join(directory, 'input.json');
  const fixture = { ...await replayInput(), guardRecord: { desktopFreshnessVerified: true }, desktopSignTypes: ['Bank'], usSingleCurrencyBinding: true };
  writeFileSync(source, JSON.stringify(fixture));
  assert.equal(await runKit(['replay', '--input', source, '--out', join(directory, 'held')], { identities, now, output: () => {} }), 0);
  const replay = JSON.parse(readFileSync(join(directory, 'held', 'replay.json')));
  assert.deepEqual(replay.connector.calls, ['probe', 'snapshot']);
  assert.equal(replay.connector.code, 'QB_FRESHNESS_UNVERIFIED');
  assert.deepEqual(PROVEN_SIGN_TYPES.desktop, []);
  assert.ok(!replay.cells.some(cell => cell.surface === 'balance'));
  const control = await kit.replayFixtures(fixture, { guardRecord: createQuickBooksGuardForTest({ desktopSignTypes: ['Bank'], desktopFreshnessVerified: true }) });
  assert.ok(control.cells.some(cell => cell.surface === 'balance'));
});

test('capture inventory identifies only the known transport gap and covers bounded repeated links', async t => {
  const directory = folder(t);
  assert.equal(await runKit(['plan', '--out', join(directory, 'plan')], { identities, output: () => {} }), 0);
  const plan = JSON.parse(readFileSync(join(directory, 'plan', 'field-plan.json')));
  assert.ok(Object.values(plan.fields).flat().length > 80);
  const replay = await kit.replayFixtures(await replayInput());
  assert.deepEqual(replay.fieldCoverage.filter(row => row.transport === 'uncapturable').map(row => `${row.ret}.${row.field}`), ['CurrencyRet.IsUserDefined']);
  assert.equal(replay.fieldCoverage.find(row => row.ret === 'BillPaymentCheckRet' && row.field === 'AppliedToTxnRet.TxnID').observedRows, 1);
  const mappedNames = readFileSync(new URL('../connectors/quickbooks-desktop-map.mjs', import.meta.url), 'utf8');
  const fields = new Set([...Object.values(plan.fields).flat(), ...plan.contexts.commonReads, 'AppliedToTxnRet']);
  for (const match of mappedNames.matchAll(/input(?:\.([A-Za-z]+)|\['([^']+)'\])/g)) assert.ok(fields.has(match[1] || match[2]), 'every direct mapper input read is inventoried');
});

test('SAC, elevation and certificate behavioral failures cannot hide inside complete typed observations', () => {
  const observed = observations();
  Object.assign(observed.A1, { promptAppeared: false });
  Object.assign(observed.N1, { fileLocked: false });
  Object.assign(observed.S1, { elapsedHours: 72 });
  Object.assign(observed.T1, { years: 3 });
  const good = kit.evaluateFieldSteps(observed);
  for (const step of ['W1', 'E1', 'S1', 'N1', 'T1', 'R1']) assert.equal(good[step].ok, true);
  for (const [step, field, value] of [['W1', 'sacEnforced', false], ['E1', 'beforeConsent', false], ['S1', 'certificate', 'expired'], ['N1', 'fileLocked', true], ['R1', 'addDecisionReached', false]]) {
    const bad = structuredClone(observed); bad[step][field] = value;
    assert.equal(validateStep(step, bad[step]).ok, true);
    const result = kit.evaluateFieldSteps(bad)[step];
    assert.ok(result.checked > 0); assert.equal(result.ok, false);
    assert.ok(buildReceipt({ observations: bad }, { now }).blockers.includes(`${step}_PASS_BAR_UNMET`));
  }
});


test('raw sign matches never propose a permanently excluded account type', async () => {
  for (const type of ['Bank', 'Income', 'OtherIncome', 'Expense', 'OtherExpense', 'CostOfGoodsSold', 'NonPosting']) {
    const fixture = await replayInput();
    fixture.snapshot.frames.find(frame => frame.entity === 'AccountRet').rows[0].AccountType = type;
    const replay = await kit.replayFixtures(fixture);
    assert.equal(replay.records.filter(record => record.ret === 'AccountRet').length, 1);
    const selections = replay.cells.map((cell, i) => ({ cell: cell.id, report: 'balance_sheet', key: String(i), posting: 'P1' }));
    const expected = replay.cells.map((cell, i) => ({ report: 'balance_sheet', key: String(i), currency: cell.currency, amount: cell.amount }));
    const oracle = kit.compareReplay({ replay, selections, expected });
    assert.equal(oracle.ok, true); assert.ok(oracle.compared > 0);
    assert.equal(oracle.signCandidates.length, type === 'Bank' ? 1 : 0);
  }
});
