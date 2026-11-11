// Explicit offline authoring only. Ordinary replay never captures a missing
// call. Preserve historical tapes and bind each replacement to exact bytes.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { CASES, loadTapes } from './day3-bench.mjs';
import { replayRoute } from './route-replay.mjs';
import { workingTreeSources } from './ledger-sources.mjs';
import { sha } from './money-replay.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidence } from '../../test/fixtures/fastloop-money/input.mjs';
import { decode, reviewedStatement } from './search-disclosure-tape-review.mjs';

function untyped(value) {
  const [kind, payload] = value;
  if (kind === 'object') return Object.fromEntries(payload.map(([key, item]) => [key, untyped(item)]));
  if (kind === 'array') return payload.map(untyped);
  if (kind === 'null') return null;
  return kind === 'number' ? Number(payload) : kind === 'boolean' ? payload === 'true' : payload;
}
const inventoryFields = Object.freeze({ entity_kind: 'business', entity_label: 'Synthetic owner',
  institution_status: null, backfill_state: null, status: 'open', opened_on: null, closed_on: null });

export function tapeChanges(before, after, path = [], roles = new Map()) {
  if (path.length === 2 && path[0] === 'd1' &&
      JSON.stringify(before.input).includes('FROM chunks_fts') &&
      JSON.stringify(after.input).includes('WITH keyword_candidates AS MATERIALIZED')) {
    reviewedStatement(decode(before.input.request), decode(after.input.request), before.output, after.output);
    return [{ path, before_sha256: sha(before), value: after }];
  }
  if (path.length === 1 && path[0] === 'd1' && after.length === before.length + 1) {
    const added = after.at(-1), request = untyped(added.input.request);
    assert.equal(request.method, 'batch');
    assert.deepEqual(request.statements.map(s => sha(s.sql)), [
      '1d26a6017bc13b2b6bbe6c5bc4d1b43c4f8e763c3c40985be0dcc683185df417',
      'c27e481664b7f00c82d93f2ad6ebb1dee85da861fc18beef01845dba793cdad1']);
    assert.equal(request.statements[1].binds.length, 6);
    assert.equal(request.statements[1].binds[1], 'primary');
    assert.equal(request.statements[1].binds[5], 5001);
    assert.equal(added.input.occurrence, after.length);
    assert.equal(added.error, undefined);
    return [...tapeChanges(before, after.slice(0, -1), path, roles),
      { path: [...path, before.length], missing: true, value: added }];
  }
  // Replace inventory rows as whole records: snapshot admission compares exact
  // serialized mappings, so field order must match the newly captured batch.
  if (before && !Array.isArray(before) && before.account_slug && !Object.hasOwn(before, 'status') && after.status === 'open') {
    for (const key of Object.keys(before)) {
      assert.ok(Object.hasOwn(after, key));
      assert.deepEqual(after[key], before[key], 'existing inventory fields stay exact');
    }
    for (const key of Object.keys(after).filter(key => !Object.hasOwn(before, key))) {
      assert.ok(Object.hasOwn(inventoryFields, key));
      assert.equal(after[key], inventoryFields[key]);
    }
    return [{ path, before_sha256: sha(before), value: after }];
  }
  if (typeof before === 'object' && before !== null) {
    assert.equal(Array.isArray(before), Array.isArray(after));
    if (Array.isArray(before)) assert.equal(before.length, after.length);
    const changes = [];
    for (const key of Object.keys(before)) {
      assert.ok(Object.hasOwn(after, key), 'no frozen field may disappear');
      changes.push(...tapeChanges(before[key], after[key], [...path, key], roles));
    }
    for (const key of Object.keys(after).filter(key => !Object.hasOwn(before, key))) {
      assert.ok(Object.hasOwn(inventoryFields, key));
      assert.equal(before.entity_slug, 'owner');
      assert.equal(after[key], inventoryFields[key], 'the synthetic seed explicitly declares this field');
      changes.push({ path: [...path, key], missing: true, value: after[key] });
    }
    return changes;
  }
  if (before === after) return [];
  // Preserve frozen FTS score bytes across one-bit host arithmetic differences.
  if (path.length === 6 && path[0] === 'd1' && path[2] === 'output' && path[3] === 'results' && path[5] === 'score' &&
      Number.isFinite(before) && Number.isFinite(after) &&
      Math.abs(before - after) <= Number.EPSILON * Math.max(Math.abs(before), Math.abs(after))) return [];
  // Exact tapes encode bindings as typed arrays. Only the selected-account
  // mapping gains a role, derived from the independent fixture's account facts.
  if (path[0] === 'd1' && path[2] === 'input' && path[3] === 'request' &&
      typeof before === 'string' && before.startsWith('[{"slug":')) {
    const prior = JSON.parse(before), current = JSON.parse(after);
    assert.ok(prior.length > 0, 'balance mapping decision reached');
    assert.equal(current.length, prior.length);
    for (const [index, row] of current.entries()) {
      const { role, status, opened_on, closed_on, ...preserved } = row;
      if (Object.hasOwn(row, 'status')) {
        assert.equal(status, 'open'); assert.equal(opened_on, null); assert.equal(closed_on, null);
      }
      assert.deepEqual(preserved, prior[index], 'every existing balance binding stays exact');
      if (Object.hasOwn(row, 'role')) {
        assert.ok(roles.has(row.effective), 'effective account belongs to the independent synthetic seed');
        assert.equal(role, roles.get(row.effective), 'reviewed role matches the independent seed');
      }
    }
    return [{ path, before_sha256: sha(before), value: after }];
  }
  if (typeof before === 'string' && sha(before) === '75a8b53f9dd622790714fac513fd4d5f38797b9a7f7667bf5967b80891223c7d' &&
      typeof after === 'string' && sha(after) === '70edb519f5008a4d644c9e1baf1871a4ca41baefcc27d2c3981e626c0a4b6d71')
    return [{ path, before_sha256: sha(before), value: after }];
  // Author only the reviewed schema identity, inventory and balance query.
  // Model requests, figures and all other response fields stay exact.
  assert.ok((path.at(-1) === 'schema_version' && before === 57 && [58, 59, 61].includes(after)) ||
    (typeof before === 'string' && sha(before) === '511315a8f707696def73f2bcdf1759704fa16b1f636dabc5c983a4fdc562f3a6' &&
      // Current admission additionally checks SimpleFIN proof versions.
      // Historical arms and every unrelated binding stay exact below.
      ['085a3cb746a3831a3f0a640f08a0ffbd57297d917c3e1dfe483d8d581d74efa6',
        '0560a90893bdbca03eb46f39580b9d0e6fd87070fe7c3560a58d12de0a571b2e',
        '9835ead2939be8882776ae37a0b65b11ffd5bb758d575c727b56b7f3d7e08475',
        '0239a5f64276273f4ed309067a6f6832060381e5dcfb9e5ffd4384e0f94fe4ff', '1d26a6017bc13b2b6bbe6c5bc4d1b43c4f8e763c3c40985be0dcc683185df417'].includes(sha(after))) ||
    (typeof before === 'string' && sha(before) === 'e29880643e5fdfd0101290335d6e28395a1858558d043ca18de061e2f8b97fcd' &&
      sha(after) === '9fd1565b305eed1ed63e8436e7474a597176ef1ae2ad1dbdc655f7830b758924'),
  `unreviewed tape change at ${path.join('/')}`);
  return [{ path, before_sha256: sha(before), value: after }];
}

// Q7 now reads the whole bounded window so nearby amounts remain observable.
// Author just its amount bind and result membership from the frozen input;
// inventory edits still pass through the existing strict authoring guard.
function payerWindowEdits(before, after, input) {
  assert.equal(after.d1.length, before.d1.length);
  const index = before.d1.length - 1;
  const inventoryOnly = structuredClone(after);
  const request = inventoryOnly.d1[index].input.request;
  const statementsIndex = request[1].findIndex(([key]) => key === 'statements');
  const statements = request[1][statementsIndex][1][1];
  const transactionIndex = statements.length - 1;
  const fields = statements[transactionIndex][1];
  const bindsIndex = fields.findIndex(([key]) => key === 'binds');
  const binds = fields[bindsIndex][1][1];
  assert.deepEqual(binds[4], ['null']);
  const amountPath = ['d1', index, 'input', 'request', 1, statementsIndex, 1, 1,
    transactionIndex, 1, bindsIndex, 1, 1, 4];
  const resultsPath = ['d1', index, 'output', 1, 'results'];
  const originalRows = before.d1[index].output[1].results;
  const rows = after.d1[index].output[1].results;
  assert.deepEqual(rows.filter(row => row.amount_minor === 17777 && row.direction === 'inflow'), originalRows);
  const projection = rows.map(row => [row.id, row.posted_on, String(row.amount_minor), row.direction, row.description, row.payee]);
  const wanted = input.snapshot.rows.filter(row => !row.pending && row.date >= '2026-10-05' && row.date <= '2026-10-19')
    .sort((a, b) => b.date.localeCompare(a.date) || a.id - b.id)
    .map(row => [row.id, row.date, row.cents, row.direction, row.description, row.payee]);
  assert.deepEqual(projection, wanted, 'widened membership comes from frozen synthetic facts');
  binds[4] = ['number', '17777'];
  inventoryOnly.d1[index].output[1].results = structuredClone(originalRows);
  return { inventoryOnly, edits: [
    { path: amountPath, before_sha256: sha(binds[4]), value: ['null'] },
    { path: resultsPath, before_sha256: sha(originalRows), value: rows },
  ] };
}

export function buildRouterTapes({ disclosure = true } = {}) {
  const previous = loadTapes({ router: false }).candidate;
  const sources = workingTreeSources();
  const run = replayRoute({ cases: CASES, capture: true, sourceOverrides: sources });
  assert.equal(run.observations.length, CASES.length);
  assert.ok(run.observations.every(o => o.execution_status === 'complete'));
  assert.equal(run.provider_calls, 0);
  assert.equal(run.production_writes, 0);
  assert.ok(Object.values(run.tapes).every(tape => ['d1','provider','model']
    .every(channel => tape[channel].every(entry => !entry.error))));
  const changes = CASES.flatMap(({ id, snapshot, profile }) => {
    assert.deepEqual(run.tapes[id].model, previous[id].model, 'model tapes stay frozen');
    assert.deepEqual(run.tapes[id].provider, previous[id].provider, 'provider tapes stay frozen');
    const roles = new Map((snapshot || evidence(profile)).accounts.map(account => [account.slug, account.role]));
    const authored = id === 'Q7' ? payerWindowEdits(previous[id], run.tapes[id], CASES.find(input => input.id === id))
      : { inventoryOnly: run.tapes[id], edits: [] };
    const edits = [...tapeChanges(previous[id], authored.inventoryOnly, [], roles), ...authored.edits];
    return edits.length ? [{ id, before_sha256: sha(previous[id]), edits }] : [];
  });
  assert.ok(changes.length > 0, 'the reviewed inventory change must reach the tape');
  // Pending reads belong to the separately pinned disclosure overlay. The
  // full authoring result remains available for the round-trip proof; the CLI
  // writes only this layer so those reads cannot be applied twice.
  // These three synthetic cases already carried pending reads in the reviewed
  // router layer; only later additions belong to the disclosure overlay.
  const routerPendingCases = new Set(['Q1', 'Q17', 'D01']);
  if (!disclosure) for (const change of changes) change.edits = change.edits.filter(edit => {
    if (routerPendingCases.has(change.id)) return true;
    if (!(edit.missing === true && edit.path.length === 2 && edit.path[0] === 'd1')) return true;
    const request = untyped(edit.value.input.request);
    assert.equal(request.method, 'batch');
    assert.equal(request.statements.length, 2);
    assert.equal(sha(request.statements[1].sql), '3db04990951913cfcc75273fa1c136f3dcf822a73300d448561bcd68667af97e');
    return false;
  });
  return { schema: 1, version: 'router-inventory-v1', base_sha256: sha(previous),
    source_sha256: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])),
    changes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const patch = buildRouterTapes({ disclosure: false });
  const bytes = JSON.stringify(patch, null, 2) + '\n';
  writeFileSync(new URL('../../test/fixtures/fastloop-day3/candidate-router-v1.json', import.meta.url), bytes);
  console.log(JSON.stringify({ cases: patch.changes.length, sha256: sha(bytes),
    provider_calls: 0, production_writes: 0 }));
}
