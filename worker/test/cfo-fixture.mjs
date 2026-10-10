// Install the outbound/process tripwire before loading any product module.
import '../../test/fixtures/cli-side-effect-tripwire.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createProductFixture, seedOwnedEntity } from './product-contract-fixture.mjs';
import { makeCredential, signAssertion } from './webauthn-fixtures.mjs';

export const ENTITY = 'fixture-entity';
export const NOW = Date.parse('2026-10-10T12:00:00Z');
export const QUESTION = 'Check tax readiness for 2025.';
export const inventoryReads = f => f.seen.sql.filter(sql => /FROM fin_documents f/.test(sql)).length;
export const mapReads = f => f.seen.sql.filter(sql => /FROM owner_financial_map_snapshots/.test(sql)).length;
export const scopeReads = f => f.seen.sql.filter(sql => /FROM fin_entities/.test(sql)).length;
export const ask = (f, body = {}, headers = f.headers) => f.post('/api/rag/think', {
  workflow: 'tax_evidence_checklist', entity: ENTITY, year: 2025, ...body,
}, headers).then(async response => ({ status: response.status, body: await response.json() }));

export function seedEvidence(f, { count = 1, year = 2025, readable = 1 } = {}) {
  f.raw(`INSERT OR IGNORE INTO sources (name,kind,status,created_at,last_ingest_at,document_count)
    VALUES ('fixture-source','upload','ready','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1)`);
  for (let i = 0; i < count; i++) {
    const id = `fixture-${year}-${i}`;
    const hash = 'a'.repeat(64);
    const meta = JSON.stringify({ evidence_lineage: { version: 1, kind: 'source_record', root_ids: [`fixture-source:${id}`] },
      provenance_receipt: { version: 1, status: 'complete', reason: 'lineage_and_text_recorded', root_ids: [`fixture-source:${id}`] } });
    f.raw(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta,entity_slug,text_source,text_reliable)
      VALUES (?,'fixture-source',?,'Synthetic evidence',?,?,?,?,'native',?)`, id, id, NOW, hash, meta, ENTITY, readable);
    f.raw(`INSERT INTO fin_documents (tenant_id,fin_doc_uid,entity_slug,doc_kind,title,tax_year,period_start,period_end,
      custody_class,availability,filed_at,corpus_doc_uid,content_hash,readable,restricted,provenance,source_feed,basis_state,recorded_at)
      VALUES ('primary',?,?,?,'Synthetic evidence',?,?,?,'reference','have_it','2026-01-01',?,?,?,0,'feed','fixture-source','confirmed','2026-01-01T00:00:00Z')`,
    `ledger-${id}`, ENTITY, ['tax_return', 'profit_and_loss', 'estimated_payment_receipt'][i % 3], year,
    `${year}-01-01`, `${year}-12-31`, id, hash, readable);
  }
}

export async function activateMap(f, change = () => {}) {
  const read = await (await f.post('/api/admin/brain/financial-map/read', {}, f.admin())).json();
  const unit = { map_id: `ofmf_${'1'.repeat(32)}`, label: 'Filing unit', assessment: 'confirmed' };
  const snapshot = {
    version: 1, scope: { tenant_id: 'primary', kind: 'whole_owner_financial_picture' },
    tax_year_horizon: { start: 2025, end: 2025 }, population_state: 'owner_asserted_complete', filing_units: [unit],
    accounts: [], entities: read.current_inventory.entities.map(entity => ({
      map_id: entity.suggested_map_id, ledger_ref: entity.entity_ref, label: 'Entity', disposition: 'included',
      fields: Object.fromEntries(Object.entries(entity.fields).map(([key, value]) => [key, {
        assessment: key === 'parent' ? 'not_applicable' : 'confirmed', owner_value: value.current_value,
      }])),
      tax_years: [{ tax_year: 2025, state: 'included', filing_units: { assessment: 'confirmed', refs: [unit.map_id] },
        required_returns: { assessment: 'confirmed', items: [{ map_id: `ofmr_${'2'.repeat(32)}`, label: 'Federal return', assessment: 'confirmed' }] },
        required_forms: { assessment: 'not_applicable', items: [] }, k1_roles: { assessment: 'not_applicable', items: [] },
        books: { assessment: 'confirmed', bookkeeping_company: { map_id: `ofmb_${'3'.repeat(32)}`, label: 'Books company', assessment: 'confirmed' } },
        payroll: { assessment: 'not_applicable' }, expected_sources: { assessment: 'unknown', items: [] } }],
    })),
  };
  change(snapshot);
  const preview = await f.post('/api/admin/brain/financial-map/preview', { snapshot }, f.admin());
  assert.equal(preview.status, 200, 'real map preview must succeed');
  const credential = await makeCredential({ rpId: 'brain.invalid' });
  const jwk = await crypto.subtle.exportKey('jwk', credential.pair.publicKey);
  f.raw(`INSERT INTO owner_passkeys (credential_id,public_key_jwk,alg,sign_count,nickname,created_at)
    VALUES (?,?,-7,0,'Synthetic passkey',?)`, credential.credentialId, JSON.stringify(jwk), NOW);
  f.headers = await f.ownerHeaders({ credentialId: credential.credentialId });
  const review = await (await f.post('/api/owner/financial-map/review', {}, f.headers)).json();
  const options = await (await f.post('/api/owner/financial-map/passkey/options', { review_id: review.review_id }, f.headers)).json();
  const assertion = await signAssertion({ pair: credential.pair, rpId: 'brain.invalid', origin: 'https://brain.invalid', challenge: options.challenge, counter: 1 });
  const activated = await f.post('/api/owner/financial-map/activate', {
    review_id: review.review_id, request_id: 'fixture-map-activation', credentialId: credential.credentialId, ...assertion,
  }, f.headers);
  assert.equal(activated.status, 200, 'real map activation must succeed');
}

export async function cfoFixture(t, { map = true, evidence = true, changeMap } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = await createProductFixture();
  t.after(() => f.close());
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cfo-fixture-')));
  const keyPath = join(root, 'admin-fixture');
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  f.env.ADMIN_KEY = readFileSync(keyPath, 'utf8');
  f.admin = () => ({ 'X-Admin-Key': readFileSync(keyPath, 'utf8') });
  seedOwnedEntity(f, ENTITY, 'Synthetic entity');
  f.raw("UPDATE fin_entities SET holds='Operating activity', ownership_bp=10000, tax_class='corporation' WHERE entity_slug=?", ENTITY);
  if (evidence) seedEvidence(f, { count: 3 });
  if (map) await activateMap(f, changeMap);
  else f.headers = await f.ownerHeaders();
  f.calls = { model: 0, provider: 0 };
  for (const method of ['query', 'upsert', 'deleteByIds', 'describe']) {
    const original = f.env.VECTORIZE[method];
    f.env.VECTORIZE[method] = async (...args) => { f.calls.provider++; return original(...args); };
  }
  f.env.AI = { async run() { f.calls.model++; throw new Error('unexpected model call'); } };
  f.seen.sql.length = 0; f.seen.binds.length = 0;
  return f;
}
