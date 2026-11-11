import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { fixture } from './ledger-review-fixture.mjs';

export const now = Date.parse('2026-11-03T12:00:00Z');
export const context = { now, timeZone: 'UTC' };
export const intent = (kind = 'expense_summary', extra = {}) => ({ kind, direction: kind === 'totals' ? 'inflow' : kind === 'transfers' ? null : 'outflow',
  count: null, vendor_text: null, account_hint: null, amount_text: null, date_text: null, period: { type: 'none' }, ...extra });
export const raw = (...intents) => ({ ambiguous: false, unanswered_part: null, intents });
export function setup(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = fixture(t);
  for (const [slug, label, kind] of [['store','Store Unit','business'],['supply','Supply Unit','business'],['owner','Owner','person']]) {
    f.raw(`INSERT INTO fin_entities (entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,'active','owned','owner_stated','confirmed','2026-11-03')`, slug, label, label, kind);
  }
  for (const [slug, entity, kind, mask, label] of [['main','store','checking','1111','Operating'],['reserve','store','savings','2222','Reserve'],
    ['supply-main','supply','checking','3333','Supply Operating'],['personal','owner','checking','4444','Owner Checking']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'asset',?,?,'manual','owner_stated','confirmed','2026-11-03')`, slug, entity, kind, mask, label);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-11-03','2026-11-03','owner_stated','confirmed','2026-11-03')`, slug);
  }
  let serial = 0;
  f.add = (account, date, cents, direction = 'outflow', description = 'Supplies', payee = 'Store Vendor') => f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,category,category_basis_state,provenance,basis_state,recorded_at)
    VALUES (?,?,?,?,?,?,?,'SUPPLIES','confirmed','owner_stated','confirmed','2026-11-03')`, `row-${++serial}`, account, date, cents, direction, description, payee);
  f.add('main','2026-10-10',1200); f.add('main','2026-09-10',700);
  f.add('supply-main','2026-10-10',300); f.add('personal','2026-10-10',200);
  f.add('main','2026-10-15',5000,'inflow','Client payment','Client Unit');
  f.add('main','2026-08-15',2000,'inflow','Client payment','Client Unit');
  f.env.ANTHROPIC_API_KEY = randomBytes(12).toString('hex');
  return f;
}
export async function ask(f, question, reply, api = withLedgerAnswer, extra = {}) {
  let extraction = 0, documents = 0;
  const start = f.calls.length;
  const response = await api({ env: f.env, question, now, grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => { extraction++; return { content: [{ type: 'text', text: JSON.stringify(reply) }] }; }, ...extra },
    async () => { documents++; return Response.json({ route: 'documents', answer: null, gaps: [] }); });
  return { body: await response.json(), extraction, documents, sql: f.calls.slice(start) };
}
