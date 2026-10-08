/** Offline field notebook for invented Desktop books. No manifest or network API.
 * Captures use the existing pinned bridge. This revision cannot certify a release:
 * packet 07 is absent and the helper omits several fields required by the oracle.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { performance } from 'node:perf_hooks';
import {
  QBD_CONTRACT, QBD_EXIT_CODES, encodeQbdFrame, qbdPlan, validateQbdResult,
  resolveQbdProcessor, runQuickBooksDesktop,
} from '../operations/quickbooks-desktop-bridge.mjs';
import { QBD_HELPERS } from '../operations/quickbooks-desktop-signed.mjs';

const freeze = (value) => { Object.values(value).forEach((v) => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(value); };
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
class KitError extends Error {}
const fail = (code) => { throw new KitError(code); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REPORTS = ['balance_sheet', 'ar_aging', 'ap_aging', 'customer_balance', 'vendor_balance'];
const OBSERVED = ['yes', 'no', 'not_tested'];

/** Closed typed fields: the operator can select choices but cannot add notes. */
export const STEP_SCHEMA = freeze({
  A0: { permissionScreen: 'boolean', readOnlyShown: 'boolean', publisherShown: 'boolean', confirmationScreens: 'count', clicks: 'count', singleUserRequired: 'boolean' },
  A1: { tested: 'boolean', promptAppeared: 'boolean' },
  A2: { tested: 'boolean', failedQueries: 'count', reducedQueries: 'count', completenessRefused: 'boolean',
    ...Object.fromEntries(QBD_CONTRACT.requests.filter((request) => request.mode !== 'postdated').map((request) =>
      [`${request.key}Outcome`, ['same', 'fewer', 'refused', 'not_tested']])) },
  A3: { tested: 'boolean', automaticLoginFieldVisible: 'boolean', automaticLoginAllowed: 'boolean', broadGrantRefused: 'boolean' },
  A4: { tested: 'boolean', probe2Blocked: 'boolean', promptAppeared: 'boolean' },
  B1: { tested: 'boolean', view32Registered: 'boolean', view64Registered: 'boolean', signerValid: 'boolean' },
  S1: { tested: 'boolean', elapsedHours: 'count', certificate: ['valid', 'expired', 'unknown'], reprompted: 'boolean' },
  E1: { tested: 'boolean', leastPrivilegeFailed: 'boolean', elevationDetected: 'boolean' },
  E2: { tested: 'boolean', requestBlocked: 'boolean', blockedMs: 'milliseconds', sessionRecovered: 'boolean' },
  E3: { simulated: 'boolean', joinedSessionAffected: OBSERVED },
  N1: { tested: 'boolean', joined: 'boolean', otherUserStayedConnected: 'boolean', fileLocked: 'boolean' },
  W1: { tested: 'boolean', sacEnforced: 'boolean', helperRan: 'boolean' },
  W2: { windows11: ['conhost_headless', 'signed_launcher', 'neither', 'not_tested'], windows10: ['conhost_headless', 'signed_launcher', 'neither', 'not_tested'] },
  R1: { tested: 'boolean', addDecisionReached: 'boolean', addRefused: 'boolean', readControlSucceeded: 'boolean' },
  T1: { tested: 'boolean', years: 'count', snapshotMs: 'milliseconds', responsive: 'boolean' },
  I1: { tested: 'boolean', accountsPayableUndeletable: OBSERVED, accountsReceivableUndeletable: OBSERVED, retainedEarningsUndeletable: OBSERVED, openingBalanceEquityUndeletable: OBSERVED },
  X1: { tested: 'boolean', outboundBlocked: 'boolean', readSucceeded: 'boolean' },
});

/** Pure shape check. Missing and unknown fields are counted, never defaulted. */
export function validateStep(step, values) {
  const schema = Object.hasOwn(STEP_SCHEMA, step) ? STEP_SCHEMA[step] : null;
  if (!schema || !plain(values)) return { ok: false, checked: 1, missing: schema ? Object.keys(schema) : [], invalid: ['STEP'] };
  const missing = [], invalid = [];
  for (const [key, type] of Object.entries(schema)) {
    if (!Object.hasOwn(values, key)) { missing.push(key); continue; }
    const value = values[key];
    if (!(Array.isArray(type) ? type.includes(value) : type === 'boolean' ? typeof value === 'boolean' :
      Number.isSafeInteger(value) && value >= 0 && value <= (type === 'milliseconds' ? 86_400_000 : 100_000))) invalid.push(key);
  }
  for (const key of Object.keys(values)) if (!Object.hasOwn(schema, key)) invalid.push('UNKNOWN_FIELD');
  return { ok: !missing.length && !invalid.length, checked: Object.keys(schema).length, missing, invalid };
}

/** Ask once per fixed field. Invalid input stops without echoing operator text. */
export async function collectStep(step, ask) {
  if (!Object.hasOwn(STEP_SCHEMA, step)) fail('KIT_STEP_INVALID');
  const result = {};
  for (const [key, type] of Object.entries(STEP_SCHEMA[step])) {
    const choices = Array.isArray(type) ? type.map((value, i) => `${i + 1}=${value}`).join(', ') :
      type === 'boolean' ? 'yes/no' : 'whole number, 0 if not observed';
    const answer = await ask(`${step}.${key} (${choices}): `);
    if (typeof answer !== 'string') fail('KIT_ANSWER_INVALID');
    const text = answer.trim().toLowerCase();
    if (type === 'boolean') {
      if (!['yes', 'no'].includes(text)) fail('KIT_ANSWER_INVALID');
      result[key] = text === 'yes';
    } else {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(text)) fail('KIT_ANSWER_INVALID');
      result[key] = Array.isArray(type) ? type[Number(text) - 1] : Number(text);
    }
    if (validateStep(step, { ...Object.fromEntries(Object.entries(STEP_SCHEMA[step]).map(([k, t]) =>
      [k, Array.isArray(t) ? t[0] : t === 'boolean' ? false : 0])), ...result }).invalid.length) fail('KIT_ANSWER_INVALID');
  }
  return result;
}

/** Scan literal identity substrings, not regular expressions; never echo a match.
 * JSON decoding also catches escaped identities before a fixture is persisted.
 */
export function assertPrivate(value, identities, onStage = () => {}) {
  onStage('privacy');
  if (!plain(identities) || !['user', 'machine'].every((key) => typeof identities[key] === 'string' && identities[key].trim())) fail('KIT_IDENTITY_REQUIRED');
  const normalize = (text) => text.normalize('NFKC').toLowerCase();
  const needles = Object.values(identities).map(normalize);
  const visit = (item, depth = 0) => {
    if (depth > 40) fail('KIT_INPUT_INVALID');
    if (typeof item === 'string') {
      if (needles.some((needle) => normalize(item).includes(needle))) fail('KIT_PRIVACY_REFUSED');
      if (/^[\s]*[\[{\"]/.test(item)) {
        let decoded;
        try { decoded = JSON.parse(item); } catch { return; }
        visit(decoded, depth + 1);
      }
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) { visit(key, depth + 1); visit(child, depth + 1); }
    }
  };
  visit(value);
}

const cents = (value) => {
  if (typeof value !== 'string' || !/^-?\d{1,24}\.\d{2}$/.test(value)) return null;
  return BigInt(value.replace('.', ''));
};
const identity = (row) => JSON.stringify([row.report, row.key, row.currency]);
const validAmount = (row) => plain(row) && REPORTS.includes(row.report) && typeof row.key === 'string' &&
  row.key.length > 0 && row.key.length <= 500 && /^[A-Z]{3}$/.test(row.currency) && cents(row.amount) !== null;

/** Exact cents against explicitly selected report cells, with no sign conversion.
 * This is a comparison primitive, not proof of packet 07 mapping or answer coverage.
 */
export function compareOracle({ rendered = [], expected = [], withheld = [] } = {}) {
  const matches = [], mismatches = [], issues = [];
  if (![rendered, expected, withheld].every(Array.isArray) || rendered.length + expected.length + withheld.length > 100_000) fail('KIT_ORACLE_INVALID');
  const index = new Map(); let checked = 0, compared = 0;
  for (const row of expected) {
    checked++;
    if (!validAmount(row)) { issues.push('INVALID_REPORT_AMOUNT'); continue; }
    const key = identity(row);
    if (index.has(key)) issues.push('DUPLICATE_REPORT_IDENTITY');
    else index.set(key, row);
  }
  const seen = new Set();
  for (const row of rendered) {
    checked++;
    if (!validAmount(row) || !['opening', 'answer'].includes(row.surface) || !/^P(?:[1-9]|1[0-6])$/.test(row.posting)) { issues.push('INVALID_RENDERED_AMOUNT'); continue; }
    const key = identity(row), surfaceKey = JSON.stringify([row.surface, row.posting, key]);
    if (seen.has(surfaceKey)) { issues.push('DUPLICATE_RENDERED_AMOUNT'); continue; }
    seen.add(surfaceKey);
    if (!index.has(key)) { issues.push('REPORT_AMOUNT_MISSING'); continue; }
    compared++;
    const difference = cents(row.amount) - cents(index.get(key).amount);
    const comparison = { ...row, expected: index.get(key).amount, differenceCents: difference.toString() };
    (difference === 0n ? matches : mismatches).push(comparison);
  }
  for (const row of withheld) {
    checked++;
    if (!plain(row) || !/^[a-z]+:[A-Z0-9-]+$/.test(row.record) || !/^[A-Z][A-Z0-9_]{1,80}$/.test(row.reason) || !/^P(?:[1-9]|1[0-6])$/.test(row.posting) ||
        Object.keys(row).some((key) => !['record', 'reason', 'posting'].includes(key))) issues.push('INVALID_WITHHOLD');
  }
  if (!compared) issues.push('NO_COMPARISONS');
  return { ok: !issues.length && !mismatches.length, checked, compared, expectedCount: expected.length, matches, mismatches, withheld, issues };
}

/** RFC-style quoted CSV with exact header selection. Unknown layouts stop; the
 * operator must preserve the original and supply a reviewed table-only export.
 */
export function parseReportCsv(csv, { report, keyColumn, currencyColumn, amountColumn } = {}) {
  if (typeof csv !== 'string' || csv.length > 16 * 1024 * 1024 || !REPORTS.includes(report)) fail('KIT_CSV_INVALID');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ''; closed = false; };
  const endRow = () => { endCell(); if (row.some((value) => value !== '')) rows.push(row); row = []; };
  const text = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === ',') endCell();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else if (char === '"' && cell === '' && !closed) quoted = true;
    else { if (closed || char === '"') fail('KIT_CSV_INVALID'); cell += char; }
  }
  if (quoted) fail('KIT_CSV_INVALID');
  if (cell || row.length || closed) endRow();
  const header = rows.shift();
  if (!header || new Set(header).size !== header.length || ![keyColumn, currencyColumn, amountColumn].every((key) => typeof key === 'string' && header.includes(key)) ||
      new Set([keyColumn, currencyColumn, amountColumn]).size !== 3 || !rows.length) fail('KIT_CSV_INVALID');
  return rows.map((cells) => {
    if (cells.length !== header.length) fail('KIT_CSV_INVALID');
    let amount = cells[header.indexOf(amountColumn)].trim();
    if (/^\((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)$/.test(amount)) amount = `-${amount.slice(1, -1)}`;
    if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/.test(amount)) fail('KIT_CSV_INVALID');
    const result = { report, key: cells[header.indexOf(keyColumn)], currency: cells[header.indexOf(currencyColumn)], amount: amount.replaceAll(',', '') };
    if (!validAmount(result)) fail('KIT_CSV_INVALID');
    return result;
  });
}

/** Privacy-check the entire bundle before even creating its directory. Existing
 * evidence is never overwritten; interrupted new bundles remain for inspection.
 */
export function writeBundle(out, files, { identities, onStage = () => {} } = {}) {
  if (typeof out !== 'string' || !out || !plain(files) || !Object.keys(files).length ||
      Object.keys(files).some((name) => !/^[a-z][a-z0-9-]*\.json$/.test(name))) fail('KIT_OUTPUT_INVALID');
  const encoded = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]));
  assertPrivate(encoded, identities, onStage);
  onStage('write');
  try { mkdirSync(out, { mode: 0o700 }); } catch (error) { fail(error.code === 'EEXIST' ? 'KIT_OUTPUT_EXISTS' : 'KIT_OUTPUT_INVALID'); }
  const inventory = [];
  for (const [name, bytes] of Object.entries(encoded)) {
    try {
      const path = join(out, name);
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      if (!readFileSync(path).equals(Buffer.from(bytes))) fail('KIT_READBACK_FAILED');
    } catch (error) { fail(error instanceof KitError ? error.message : 'KIT_WRITE_FAILED'); }
    inventory.push({ name, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) });
  }
  return { files: inventory };
}

const CAPTURE_OPERATIONS = freeze({ A0: 'probe', A1: 'probe2', A2: 'snapshot', A3: 'probe', A4: 'probe2', B1: 'registry',
  S1: 'probe', E1: 'probe', E2: 'probe', E3: 'probe', N1: 'snapshot', W1: 'probe', W2: 'probe', T1: 'snapshot', X1: 'snapshot' });

function outputPreflight(out, onStage) {
  onStage('output_preflight');
  if (typeof out !== 'string' || !out) fail('KIT_OUTPUT_INVALID');
  try {
    lstatSync(out);
    fail('KIT_OUTPUT_EXISTS');
  } catch (error) {
    if (error instanceof KitError) throw error;
    if (error.code !== 'ENOENT') fail('KIT_OUTPUT_INVALID');
  }
  try { if (!lstatSync(dirname(resolve(out))).isDirectory()) fail('KIT_OUTPUT_INVALID'); }
  catch { fail('KIT_OUTPUT_INVALID'); }
}

/** The only native entry point; injected runners are internal test dependencies.
 * Production always uses the pinned bridge. R1 cannot send an Add through here.
 */
export function captureStep({ step, input, inventedOnly, out }, {
  identities, platform = process.platform, architecture = process.arch, environment = process.env,
  bridge = runQuickBooksDesktop, registry = resolveQbdProcessor, now = () => new Date(),
  monotonic = () => performance.now(), onStage = () => {},
} = {}) {
  onStage('preflight');
  if (inventedOnly !== true) fail('KIT_INVENTED_DATA_REQUIRED');
  if (platform !== 'win32' || architecture !== 'x64' || /arm/i.test(environment.PROCESSOR_ARCHITEW6432 || environment.PROCESSOR_ARCHITECTURE || '')) fail('KIT_X64_WINDOWS_REQUIRED');
  if (!plain(input) || !Object.hasOwn(CAPTURE_OPERATIONS, step) || input.operation !== CAPTURE_OPERATIONS[step] ||
      Object.keys(input).some((key) => !['operation', 'historySince', 'accountListIds', 'storedTxnIds'].includes(key))) fail('KIT_OPERATION_INVALID');
  assertPrivate(input, identities, onStage);
  // Refuse a known output collision before spending an authorization/session.
  // mkdir with exclusive file creation below still guards a later race.
  outputPreflight(out, onStage);
  const stamp = now(), started = monotonic();
  let result, plan = null;
  if (step === 'B1') result = registry({ environment, onStage });
  else {
    try { plan = qbdPlan(input, stamp); } catch { fail('KIT_PLAN_INVALID'); }
    result = bridge(input, { environment, now: () => stamp, onStage });
    onStage('terminal');
    // Fake frames and future bridge changes must pass the same completeness gate.
    if (result?.ok) {
      assertPrivate(result.frames, identities, onStage);
      try { result = validateQbdResult(Buffer.concat(result.frames.map((frame) => encodeQbdFrame(frame))), input.operation, plan); }
      catch { result = { ok: false, code: 'QB_PARTIAL_VIEW', frames: [] }; }
    }
  }
  const elapsedMs = Math.max(0, Math.round(monotonic() - started));
  const code = Object.values(QBD_EXIT_CODES).includes(result?.code) ? result.code : 'QB_PARTIAL_VIEW';
  const capture = { schema: 1, step, operation: input.operation, capturedAt: stamp.toISOString(), elapsedMs,
    ok: result?.ok === true, code: result?.ok === true ? null : code,
    helperPins: Object.fromEntries(Object.entries(QBD_HELPERS).map(([arch, artifact]) => [arch, artifact?.sha256 ?? null])),
    contractSha256: sha256(JSON.stringify(QBD_CONTRACT)), fixtureOnly: true, fieldAcceptance: 'NOT_READY' };
  const files = { 'capture.json': capture };
  if (capture.ok && step === 'B1') files['registry.json'] = { registrations: result.registrations, signer: 'Intuit', signature: 'Valid', viewsQueried: [32, 64] };
  else if (capture.ok) {
    files['frames.json'] = result.frames;
    files['fixture.json'] = { schema: 1, operation: input.operation, plan, frames: result.frames, captureSha256: sha256(JSON.stringify(capture)), reviewRequired: true };
  }
  return { capture, ...writeBundle(out, files, { identities, onStage }) };
}

/** Compile a held receipt. No field value here can lift missing integration gates.
 * In particular an all-withheld or manually supplied oracle is not release proof.
 */
export function buildReceipt({ observations = {}, captures = [], oracle = null } = {}, { now = () => new Date() } = {}) {
  if (!plain(observations) || !Array.isArray(captures) || Object.keys(observations).some((key) => !Object.hasOwn(STEP_SCHEMA, key))) fail('KIT_RECEIPT_INVALID');
  const steps = Object.keys(STEP_SCHEMA);
  const invalidSteps = steps.filter((step) => !validateStep(step, observations[step]).ok);
  const blockers = ['PACKET07_MAPPING_UNAVAILABLE', 'HELPER_FIELD_COVERAGE_INCOMPLETE', 'R1_PROBE_UNAVAILABLE', 'RENDERED_ANSWER_COVERAGE_UNPROVEN'];
  if (!QBD_HELPERS.x86?.sha256) blockers.push('SIGNED_HELPER_UNADOPTED');
  if (invalidSteps.length) blockers.push('STEP_FIELDS_MISSING_OR_INVALID');
  if (!oracle?.ok || !oracle.compared) blockers.push('ORACLE_NOT_PASSING');
  for (const step of steps) if (observations[step]?.tested === false) blockers.push(`${step}_NOT_TESTED`);
  if (!(observations.S1?.elapsedHours >= 72)) blockers.push('S1_72_HOURS_NOT_MET');
  if (!observations.R1?.addDecisionReached || !observations.R1?.addRefused || !observations.R1?.readControlSucceeded) blockers.push('R1_REFUSAL_UNPROVEN');
  if (observations.T1?.years < 3 || !observations.T1?.responsive) blockers.push('T1_BUDGET_UNPROVEN');
  if (!captures.length) blockers.push('CAPTURES_MISSING');
  return { schema: 1, generatedAt: now().toISOString(), status: 'NOT_READY', releaseEvidence: false,
    observationCount: steps.filter((step) => Object.hasOwn(observations, step)).length,
    observationsComplete: !invalidSteps.length, invalidSteps, observations, captures, oracle, blockers,
    proposals: {
      applied: false, reviewRequired: true,
      signTypes: { desktop: [], evidence: [], status: 'awaiting_mapped_oracle' },
      fieldMeanings: { OpenAmount: 'unproven', CreditRemaining: 'unproven', AppliedAmount: 'unproven', creditMemoTax: 'unproven' },
      idPatterns: { ListID: 'unproven', TxnID: 'unproven' },
      qbxmlMinimum: { candidate: QBD_CONTRACT.minimumVersion, status: 'unproven' },
      bitness: observations.B1 ?? null,
      certificate: { observation: observations.S1 ?? null, decision: 'review_required' },
      windowless: observations.W2 ?? null,
      hardTimeBudget: { observedSnapshotMs: observations.T1?.snapshotMs ?? null, proposedMs: null },
      clicks: { observed: observations.A0?.clicks ?? null, source: 'A0', scope: 'authorization_only_connector_flow_unavailable' },
    } };
}

function readJson(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) fail('KIT_INPUT_INVALID');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { fail('KIT_INPUT_INVALID'); }
}
const HELP = 'QuickBooks Desktop field notebook (held, no release approval).\n' +
  'observe --step ID --out NEW_DIRECTORY\n' +
  'capture --step ID --input LOCAL_JSON --out NEW_DIRECTORY\n' +
  'compare --input LOCAL_JSON --out NEW_DIRECTORY\n' +
  'receipt --input LOCAL_JSON --out NEW_DIRECTORY\n' +
  'See docs/runbooks/quickbooks-desktop-field-acceptance.md.\n';

/** Parsed CLI with injected prompt/output for offline tests. No raw errors escape. */
export async function runKit(argv, { identities, environment = process.env, ask, output = (text) => process.stdout.write(text), now = () => new Date(), ...dependencies } = {}) {
  try {
    if (!Array.isArray(argv)) fail('KIT_ARGUMENTS_INVALID');
    if (!argv.length || (argv.length === 1 && ['help', '--help'].includes(argv[0]))) { output(HELP); return 0; }
    const [command, ...args] = argv;
    const required = { observe: ['step', 'out'], capture: ['step', 'input', 'out'], compare: ['input', 'out'], receipt: ['input', 'out'] };
    if (!Object.hasOwn(required, command) || args.length !== required[command].length * 2) fail('KIT_ARGUMENTS_INVALID');
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !required[command].includes(key) || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('KIT_ARGUMENTS_INVALID');
      options[key] = args[i + 1];
    }
    const privacy = identities ?? { user: environment.USERNAME, machine: environment.COMPUTERNAME };
    let result;
    if (command === 'observe') {
      if (typeof ask !== 'function') fail('KIT_INTERACTIVE_REQUIRED');
      const values = await collectStep(options.step, ask);
      result = writeBundle(options.out, { 'observation.json': { schema: 1, step: options.step, values, observedAt: now().toISOString() } }, { identities: privacy });
    } else {
      const input = readJson(options.input);
      assertPrivate(input, privacy);
      if (command === 'capture') result = captureStep({ step: options.step, input: input.request, inventedOnly: input.inventedOnly, out: options.out }, { ...dependencies, identities: privacy, environment, now });
      else if (command === 'compare') {
        if (input.inventedOnly !== true) fail('KIT_INVENTED_DATA_REQUIRED');
        if (!Array.isArray(input.reports) || !input.reports.length || Object.hasOwn(input, 'expected')) fail('KIT_ORACLE_INVALID');
        const expected = input.reports.flatMap((report) => parseReportCsv(report.csv, report));
        const oracle = compareOracle({ rendered: input.rendered, withheld: input.withheld, expected });
        result = { oracle, ...writeBundle(options.out, { 'oracle.json': { ...oracle, mappingVerified: false, fieldAcceptance: 'NOT_READY' } }, { identities: privacy }) };
      } else {
        const receipt = buildReceipt(input, { now });
        result = { receipt, ...writeBundle(options.out, { 'receipt.json': receipt }, { identities: privacy }) };
      }
    }
    const code = result.capture?.ok === false ? result.capture.code : 'KIT_LOCAL_RECORD_WRITTEN';
    output(`${JSON.stringify({ code, fileCount: result.files.length, fieldAcceptance: 'NOT_READY', ...(result.oracle ? { comparisons: result.oracle.compared, matches: result.oracle.matches.length, mismatches: result.oracle.mismatches.length } : {}) })}\n`);
    return result.capture?.ok === false || result.oracle?.ok === false || result.receipt ? 2 : 0;
  } catch (error) { output(`${JSON.stringify({ code: error instanceof KitError ? error.message : 'KIT_FAILED' })}\n`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let terminal;
  const ask = async (question) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('KIT_INTERACTIVE_REQUIRED');
    terminal ??= createInterface({ input: process.stdin, output: process.stdout });
    return terminal.question(question);
  };
  try { process.exitCode = await runKit(process.argv.slice(2), { ask }); }
  finally { terminal?.close(); }
}
