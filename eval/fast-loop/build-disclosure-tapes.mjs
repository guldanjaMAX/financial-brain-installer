// Explicit offline authoring from synthetic SQLite inputs. Replays never record
// missing calls, and every preexisting request and response remains exact.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, loadTapes } from './day3-bench.mjs';
import { replayRoute } from './route-replay.mjs';
import { BASE_CASES, CONTROLS } from '../../test/fixtures/fastloop-money/input.mjs';
import { DOCUMENT_CASES, CLOCK_CASES } from '../../test/fixtures/fastloop-route/input.mjs';
import { workingTreeSources } from './ledger-sources.mjs';
import { sha } from './money-replay.mjs';
import { searchDisclosureTapes } from './search-disclosure-tapes.mjs';

// S7's pending reader retains the account lifecycle predicates.
const pendingSql = 'c27e481664b7f00c82d93f2ad6ebb1dee85da861fc18beef01845dba793cdad1';
const previousPendingSql = '3db04990951913cfcc75273fa1c136f3dcf822a73300d448561bcd68667af97e';
const untype = ([kind, value]) => kind === 'object' ? Object.fromEntries(value.map(([key, item]) => [key, untype(item)]))
  : kind === 'array' ? value.map(untype) : kind === 'number' ? Number(value) : kind === 'null' ? null : kind === 'boolean' ? value === 'true' : value;
const withoutOccurrence = entry => ({ ...entry, input: { ...entry.input, occurrence: 0 } });
// SQLite BM25 differs at its final binary digit on Windows. Only comparison
// of tiny search scores uses this precision; authored bytes remain untouched.
const comparable = value => JSON.parse(JSON.stringify(value, (key, item) =>
  key === 'score' && typeof item === 'number' && Math.abs(item) < 0.00001
    ? Number(item.toPrecision(14)) : item));
export function buildDisclosureTapes() {
  const previous = loadTapes({ disclosure: false }).candidate;
  const run = replayRoute({ cases: CASES, capture: true, sourceOverrides: workingTreeSources() });
  return pendingPatch(previous, run, CASES);
}
function pendingPatch(previous, run, cases) {
  assert.equal(run.provider_calls, 0); assert.equal(run.production_writes, 0);
  assert.ok(run.observations.every(row => row.execution_status === 'complete'));
  const changes = [];
  // Compare against the already reviewed search projection without rewriting
  // its historical tape. Replay applies that same overlay after this one.
  const reviewed = searchDisclosureTapes(previous);
  for (const { id } of cases) {
    const before = reviewed[id], after = run.tapes[id];
    assert.deepEqual(after.model, before.model, 'frozen model inputs and outputs');
    assert.deepEqual(after.provider, before.provider, 'frozen provider inputs and outputs');
    assert.equal(after.identity, before.identity);
    let oldIndex = 0, additions = 0, replacements = 0;
    for (const entry of after.d1) {
      const request = untype(entry.input.request);
      const prior = before.d1[oldIndex];
      const priorRequest = prior && untype(prior.input.request);
      if (request.method === 'batch' && request.statements.length === 2 && sha(request.statements[1].sql) === pendingSql &&
          priorRequest?.method === 'batch' && priorRequest.statements.length === 2 &&
          sha(priorRequest.statements[1].sql) === previousPendingSql) {
        // Both exact templates are independently reviewed. Only SQL changes;
        // binds, inventory, occurrence and the full response must stay exact.
        const projected = structuredClone(entry);
        const fields = projected.input.request[1].find(([key]) => key === 'statements')[1][1][1][1];
        const sqlField = fields.find(([key]) => key === 'sql');
        assert.equal(sha(sqlField[1][1]), pendingSql);
        sqlField[1][1] = priorRequest.statements[1].sql;
        assert.deepEqual(comparable(withoutOccurrence(projected)), comparable(withoutOccurrence(prior)));
        oldIndex++; replacements++;
      } else if (request.method === 'batch' && request.statements.length === 2 && sha(request.statements[1].sql) === pendingSql &&
          (!before.d1[oldIndex] || sha(withoutOccurrence(entry)) !== sha(withoutOccurrence(before.d1[oldIndex])))) {
        const [inventory, pending] = request.statements;
        assert.match(inventory.sql, /^SELECT a.id,a.account_slug/);
        assert.deepEqual(inventory.binds, ['primary', 201]);
        assert.equal(pending.binds.length, 6); assert.equal(pending.binds[1], 'primary'); assert.equal(pending.binds[4], null);
        assert.equal(pending.binds[5], 5001);
        assert.ok(entry.output[1].results.every(row => row.posted_on >= pending.binds[2] && row.posted_on <= pending.binds[3]));
        assert.equal(entry.error, undefined);
        additions++;
      } else {
        assert.ok(before.d1[oldIndex], JSON.stringify({ id, oldIndex, method: request.method,
          statement_hashes: request.statements?.map(statement => sha(statement.sql)) }));
        assert.deepEqual(comparable(withoutOccurrence(entry)), comparable(withoutOccurrence(before.d1[oldIndex++])), 'all prior D1 inputs and outputs stay exact except final BM25 digits');
      }
    }
    assert.equal(oldIndex, before.d1.length, 'no frozen reads disappear');
    if (additions || replacements) changes.push({ id, before_sha256: sha(previous[id]), tape: after, additions });
    else assert.deepEqual(comparable(after), comparable(before));
  }
  assert.ok(changes.length > 0);
  return { schema: 1, version: 'pending-disclosure-v1', base_sha256: sha(previous), changes };
}
export function buildRouteDisclosureTapes() {
  const previous = JSON.parse(readFileSync(new URL('../../test/fixtures/fastloop-route/tapes.json', import.meta.url), 'utf8'));
  const cases = [...BASE_CASES, ...CONTROLS, ...DOCUMENT_CASES, ...CLOCK_CASES];
  const run = replayRoute({ cases, capture: true });
  return pendingPatch(previous, run, cases);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const patch = buildDisclosureTapes(), bytes = JSON.stringify(patch, null, 2) + '\n';
  writeFileSync(new URL('../../test/fixtures/fastloop-day3/candidate-disclosure-v1.json', import.meta.url), bytes);
  const route = buildRouteDisclosureTapes(), routeBytes = JSON.stringify(route, null, 2) + '\n';
  writeFileSync(new URL('../../test/fixtures/fastloop-route/disclosure-v1.json', import.meta.url), routeBytes);
  console.log(JSON.stringify({ route_cases: route.changes.length, route_sha256: sha(routeBytes) }));
  console.log(JSON.stringify({ cases: patch.changes.length, added_reads: patch.changes.reduce((n, c) => n + c.additions, 0), sha256: sha(bytes), provider_calls: 0, production_writes: 0 }));
}
