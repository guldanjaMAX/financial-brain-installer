import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STEP_SCHEMA, validateStep, collectStep, compareOracle, parseReportCsv,
  assertPrivate, captureStep, writeBundle, buildReceipt, runKit,
} from '../scripts/qbd-field-acceptance.mjs';
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
  assert.deepEqual(Object.keys(STEP_SCHEMA), ['A0', 'A1', 'A2', 'A3', 'A4', 'B1', 'S1', 'E1', 'E2', 'E3', 'N1', 'W1', 'W2', 'R1', 'T1', 'I1', 'X1']);
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
  assert.equal(good.observationCount, 17); assert.equal(good.observationsComplete, true);
  assert.equal(good.status, 'NOT_READY'); assert.ok(good.blockers.includes('PACKET07_MAPPING_UNAVAILABLE'));
  assert.equal(good.proposals.applied, false);
  assert.deepEqual(good.proposals.signTypes.desktop, []);
  for (const step of Object.keys(STEP_SCHEMA)) {
    const incomplete = observations(); delete incomplete[step];
    const result = buildReceipt({ observations: incomplete, captures: [] }, { now });
    assert.equal(result.observationCount, 16); assert.equal(result.observationsComplete, false);
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
