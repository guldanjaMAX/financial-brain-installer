import test from 'node:test';
import assert from 'node:assert/strict';
import { answerText } from '../../frontend/src/lib/answer-render.js';
import { cfoFixture, ask, inventoryReads, scopeReads, ENTITY } from './cfo-fixture.mjs';

test('populated owner reaches scoped tax evidence checklist through Worker fetch', async t => {
  const f = await cfoFixture(t);
  const { status, body } = await ask(f);
  assert.equal(status, 200);
  assert.ok(scopeReads(f) > 0, 'business scope decision reached');
  assert.equal(body.workflow?.kind, 'tax_readiness', 'pinned route must return the readiness envelope');
  assert.ok(inventoryReads(f) > 0, `real scoped inventory read reached (${body.gaps?.map(gap => gap.type).join(',')})`);
  assert.deepEqual(body.entity_scope, { entity_slug: ENTITY, applied: true });
  assert.equal(body.workflow.tax_year, 2025);
  assert.ok(body.workflow.checklist.some(item => item.state === 'present'));
  assert.equal(body.financial_authority, false);
  assert.match(body.answer, /Tax amounts and filing readiness are not checked/);
  assert.match(answerText(body), /Tax evidence checklist/);
  assert.match(answerText(body), /2026-10-10T12:00:00.000Z/, 'the existing Ask renderer must show the dated checklist');
  assert.equal(body.workflow.tax_checks.length, 32);
  assert.ok(body.workflow.tax_checks.every(rule => rule.status === 'not_checked'));
  assert.equal(f.calls.model, 0);
});

const codes = body => body.gaps?.map(gap => gap.type) || [];
const reset = f => { f.seen.sql.length = 0; f.seen.binds.length = 0; };
async function green(f) {
  reset(f);
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.some(item => item.state === 'present'));
}

test('missing map is distinct from stale map and neither guesses population', async t => {
  const f = await cfoFixture(t, { map: false });
  const { mapReads, activateMap } = await import('./cfo-fixture.mjs');
  const missing = await ask(f);
  assert.ok(mapReads(f) > 0); assert.equal(inventoryReads(f), 0);
  assert.ok(codes(missing.body).includes('tax_map_missing'));
  await activateMap(f); await green(f);
  f.raw("UPDATE fin_entities SET display_label='Changed entity' WHERE entity_slug=?", ENTITY);
  reset(f);
  const stale = await ask(f);
  assert.ok(mapReads(f) > 0); assert.equal(inventoryReads(f), 0);
  assert.ok(codes(stale.body).includes('tax_map_stale'));
  f.raw("UPDATE fin_entities SET display_label='Synthetic entity' WHERE entity_slug=?", ENTITY);
  await green(f);
});

test('map read failure differs from missing map', async t => {
  const f = await cfoFixture(t);
  f.control.failOn = /FROM owner_financial_map_snapshots/;
  const result = await ask(f);
  assert.ok(f.seen.sql.some(sql => /FROM owner_financial_map_snapshots/.test(sql)));
  assert.ok(codes(result.body).includes('tax_map_unavailable'));
  assert.equal(inventoryReads(f), 0);
  f.control.failOn = null; await green(f);
});

test('unmapped year reaches identity assessment and does not read a nearby year', async t => {
  const f = await cfoFixture(t);
  const result = await ask(f, { q: 'Check tax readiness for 2024.' });
  assert.ok(result.body.workflow.stages.includes('identity'));
  assert.ok(codes(result.body).includes('tax_year_unassigned'));
  assert.equal(inventoryReads(f), 0);
  await green(f);
});

test('failed, measured empty and populated reads remain distinguishable', async t => {
  const f = await cfoFixture(t, { evidence: false });
  const { seedEvidence } = await import('./cfo-fixture.mjs');
  let result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.equal(result.body.workflow.checklist.find(item => item.section === 'tax_returns').state, 'measured_empty');
  reset(f); f.control.failOn = /FROM fin_documents f/;
  result = await ask(f);
  assert.ok(inventoryReads(f) > 0, 'failed database reader was invoked');
  const failed = result.body.workflow.checklist.find(item => item.section === 'tax_returns');
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.observed_records, null);
  assert.doesNotMatch(JSON.stringify(result.body), /fixture database unavailable|SELECT|stack/);
  f.control.failOn = null; seedEvidence(f, { count: 3 }); await green(f);
});

test('unreadable originals have a reached distinct state and readable sibling', async t => {
  const f = await cfoFixture(t);
  f.raw("UPDATE fin_documents SET readable=0, unreadable_reason='Synthetic unreadable'");
  f.raw('UPDATE documents SET text_reliable=0');
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.equal(result.body.workflow.checklist.find(item => item.section === 'tax_returns').state, 'unreadable');
  assert.ok(codes(result.body).includes('tax_tax_returns_unreadable'));
  f.raw('UPDATE fin_documents SET readable=1'); f.raw('UPDATE documents SET text_reliable=1');
  await green(f);
});

test('mixed stored years never widen the requested year', async t => {
  const f = await cfoFixture(t);
  const { seedEvidence } = await import('./cfo-fixture.mjs');
  seedEvidence(f, { year: 2024, count: 6 });
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.stages.includes('identity'));
  assert.equal(result.body.workflow.tax_year, 2025);
  assert.equal(result.body.workflow.checklist.find(item => item.section === 'tax_returns').observed_records, 1);
  assert.equal(result.body.workflow.checklist.find(item => item.section === 'evidence').observed_records, 3);
  assert.equal(result.body.evidence_gate.complete, false);
});

for (const assessment of ['unknown', 'ambiguous']) test(`${assessment} filing unit has its own next step`, async t => {
  const f = await cfoFixture(t, { changeMap(snapshot) {
    const year = snapshot.entities[0].tax_years[0];
    if (assessment === 'unknown') year.filing_units.assessment = 'unknown';
    else {
      const second = { map_id: `ofmf_${'4'.repeat(32)}`, label: 'Second unit', assessment: 'confirmed' };
      snapshot.filing_units.push(second); year.filing_units.refs.push(second.map_id);
    }
  } });
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.stages.includes('identity'));
  assert.ok(codes(result.body).includes(assessment === 'unknown' ? 'tax_filing_unit_unassigned' : 'tax_filing_unit_ambiguous'));
  assert.equal(result.body.evidence_gate.complete, false);
});

test('positive inputs still show every unchecked family and absent official prerequisites', async t => {
  const f = await cfoFixture(t, { changeMap(snapshot) {
    snapshot.entities[0].tax_years[0].expected_sources = {
      assessment: 'confirmed', items: [{ map_id: `ofms_${'5'.repeat(32)}`, label: 'Evidence source', kind: 'tax', assessment: 'confirmed' }],
    };
  } });
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.filter(item => item.state === 'present').length >= 4);
  assert.equal(result.body.workflow.tax_checks.length, 32);
  assert.equal(result.body.workflow.tax_checks.filter(rule => rule.implemented).length, 14);
  assert.equal(result.body.workflow.compared_families, 0);
  assert.equal(codes(result.body).includes('tax_expected_sources_unknown'), false);
  for (const code of ['tax_form_unknown', 'tax_role_unknown', 'tax_jurisdiction_unsupported', 'tax_official_map_missing', 'tax_field_review_missing']) assert.ok(codes(result.body).includes(code));
  assert.deepEqual(result.body.citations, []);
  assert.deepEqual(result.body.results, []);
  assert.ok(codes(result.body).includes('tax_original_citations_unresolved'));
  assert.ok(result.body.workflow.tax_checks.every(rule => rule.source_value === null && rule.return_value === null && rule.difference === null && rule.transfer === null));
  assert.doesNotMatch(result.body.answer, /\$|tax ready|ready to file|tax correct|Synthetic evidence/);
  assert.equal(result.body.financial_authority, false);
  assert.ok(result.body.notice.includes('2026-10-10'));
});

test('extra inventory pages are followed and hard bound stays visibly partial', async t => {
  const f = await cfoFixture(t, { evidence: false });
  const { seedEvidence } = await import('./cfo-fixture.mjs');
  seedEvidence(f, { count: 101 });
  let result = await ask(f);
  let section = result.body.workflow.checklist.find(item => item.section === 'evidence');
  assert.equal(section.observed_records, 101); assert.equal(section.traversal, 'finished');
  assert.ok(f.seen.binds.some(params => params.at(-1) === 100), 'nonzero cursor offset reached D1');
  f.raw(`INSERT INTO fin_documents (tenant_id,fin_doc_uid,entity_slug,doc_kind,title,tax_year,period_start,period_end,custody_class,availability,filed_at,readable,restricted,provenance,source_feed,basis_state,recorded_at)
    SELECT tenant_id,'more-'||fin_doc_uid,entity_slug,doc_kind,title,tax_year,period_start,period_end,custody_class,availability,filed_at,readable,restricted,provenance,source_feed,basis_state,recorded_at FROM fin_documents`);
  reset(f); result = await ask(f);
  section = result.body.workflow.checklist.find(item => item.section === 'evidence');
  assert.ok(inventoryReads(f) > 0);
  assert.equal(section.observed_records, 200); assert.equal(section.traversal, 'partial');
  assert.ok(codes(result.body).includes('tax_evidence_partial'));
  assert.ok(result.body.workflow.pages_read <= 14);
  assert.equal(result.body.evidence_gate.complete, false);
});

for (const change of ['source', 'map', 'session']) test(`${change} change after first authorized read withholds checklist on final recheck`, async t => {
  const f = await cfoFixture(t);
  await green(f); reset(f);
  const batch = f.DB.batch;
  let changed = false;
  f.DB.batch = async statements => {
    const result = await batch(statements);
    if (!changed && statements.some(stmt => /FROM fin_documents f/.test(stmt.sql))) {
      changed = true;
      if (change === 'source') f.raw("UPDATE sources SET status='error' WHERE name='fixture-source'");
      if (change === 'map') f.raw("UPDATE fin_entities SET display_label='Changed entity' WHERE entity_slug=?", ENTITY);
      if (change === 'session') f.raw('UPDATE install_state SET session_generation=session_generation+1');
    }
    return result;
  };
  const result = await ask(f);
  assert.equal(changed, true); assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.stages.includes('recheck'));
  assert.ok(codes(result.body).includes(change === 'source' ? 'tax_evidence_changed' : change === 'map' ? 'tax_map_changed' : 'cfo_owner_required'));
  assert.deepEqual(result.body.workflow.checklist, []);
  assert.deepEqual(result.body.citations, []);
});

test('populated workflow has no financial or corpus writes and no provider/model calls', async t => {
  const f = await cfoFixture(t);
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  assert.ok(result.body.workflow.checklist.some(item => item.state === 'present'));
  const writes = f.seen.sql.filter(sql => /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
  assert.ok(writes.every(sql => /passkey_security_events/.test(sql)), 'only existing authentication audit writes allowed');
  assert.equal(f.calls.model, 0); assert.equal(f.calls.provider, 0);
  assert.equal(f.seen.vectorQueries.length, 0); assert.equal(f.seen.vectorDeletes.length, 0);
});

test('excluded entity reaches identity decision with no guessed population', async t => {
  const f = await cfoFixture(t, { changeMap(snapshot) { snapshot.entities[0].disposition = 'excluded'; } });
  const result = await ask(f);
  assert.ok(result.body.workflow.stages.includes('identity'));
  assert.ok(codes(result.body).includes('tax_entity_unassigned'));
  assert.equal(inventoryReads(f), 0);
});

test('wrong inventory scope is unavailable and never echoed as measured evidence', async t => {
  const f = await cfoFixture(t);
  const { financialPictureInventory } = await import('../src/lib/financial-picture.js');
  const { taxReadiness } = await import('../src/lib/cfo-tax-evidence.js');
  let readerCalls = 0;
  const context = { intent: { taxYear: 2025 }, entityScope: { entity_slug: ENTITY, applied: true }, asOf: '2026-10-10T12:00:00.000Z', reauthorize: async () => true };
  const result = await taxReadiness(context, { env: f.env, inventory: async request => {
    readerCalls++;
    const result = await financialPictureInventory(f.env, request, { capturedAt: context.asOf });
    result.body.sections[request.sections[0]].applied_filters.entity_slug = 'another-entity';
    return result;
  } });
  assert.ok(readerCalls > 0); assert.ok(inventoryReads(f) > 0);
  assert.ok(result.metadata.checklist.every(item => item.state === 'unavailable'));
  const sibling = await taxReadiness(context, { env: f.env });
  assert.ok(sibling.metadata.checklist.some(item => item.state === 'present'));
});

test('failed source custody is unavailable even when ledger rows exist', async t => {
  const f = await cfoFixture(t);
  f.raw("UPDATE sources SET status='error' WHERE name='fixture-source'");
  const result = await ask(f);
  assert.ok(inventoryReads(f) > 0);
  const row = result.body.workflow.checklist.find(item => item.section === 'tax_returns');
  assert.equal(row.state, 'unavailable'); assert.ok(row.observed_records > 0);
  assert.ok(codes(result.body).includes('tax_tax_returns_restricted'));
  f.raw("UPDATE sources SET status='ready' WHERE name='fixture-source'");
  await green(f);
});

test('same labels never substitute for exact ledger entity identity in the map', async t => {
  const f = await cfoFixture(t, { map: false });
  const { activateMap } = await import('./cfo-fixture.mjs');
  const { readOwnerFinancialMapState } = await import('../src/lib/owner-financial-map.js');
  f.raw(`INSERT INTO fin_entities (tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,holds,ownership_bp,tax_class,provenance,basis_state,recorded_at)
    SELECT tenant_id,'fixture-other',legal_name,display_label,kind,status,relationship,holds,ownership_bp,tax_class,provenance,basis_state,recorded_at FROM fin_entities WHERE entity_slug=?`, ENTITY);
  const before = await readOwnerFinancialMapState(f.env, { entitySlug: 'fixture-other' });
  await activateMap(f, snapshot => {
    snapshot.entities.find(entity => entity.ledger_ref === before.selected_entity_ref).disposition = 'excluded';
  });
  await green(f); reset(f);
  const denied = await ask(f, { entity_slug: 'fixture-other' });
  assert.ok(scopeReads(f) > 0);
  assert.ok(denied.body.workflow.stages.includes('identity'));
  assert.ok(codes(denied.body).includes('tax_entity_unassigned'));
  assert.equal(inventoryReads(f), 0);
  const spaced = await readOwnerFinancialMapState(f.env, { entitySlug: ` ${ENTITY}` });
  assert.equal(spaced.selected_entity_ref, null);
});

test('unsupported map backend is unavailable rather than a measured missing map', async t => {
  const f = await cfoFixture(t);
  const { taxReadiness } = await import('../src/lib/cfo-tax-evidence.js');
  let mapCalls = 0;
  const context = { intent: { taxYear: 2025 }, entityScope: { entity_slug: ENTITY, applied: true }, asOf: '2026-10-10T12:00:00.000Z', reauthorize: async () => true };
  const result = await taxReadiness(context, { env: f.env, readMap: async () => { mapCalls++; return null; } });
  assert.equal(mapCalls, 1);
  assert.ok(codes(result).includes('tax_map_unavailable'));
  assert.equal(inventoryReads(f), 0);
  await green(f);
});
