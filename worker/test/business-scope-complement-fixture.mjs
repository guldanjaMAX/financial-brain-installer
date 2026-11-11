import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { headOracleUrl } from './business-scope-role-only-loader.mjs';
// The independent oracle is a clean checkout of the pinned current HEAD.
// Its location is injected by the offline lane, never an instance default.
const headUrl = process.env.BUSINESS_ROLE_ONLY_HEAD_URL || headOracleUrl;
assert.ok(headUrl, 'clean pinned HEAD oracle URL supplied');
const { withLedgerAnswer: base } = await import(headUrl);
function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t); f.env.ANTHROPIC_API_KEY = f.env.ADMIN_KEY;
  for (const table of ['fin_transactions', 'fin_balance_snapshots', 'fin_account_coverage', 'fin_accounts', 'fin_entities']) f.raw(`DELETE FROM ${table}`);
  for (const [slug, role, mask, cents, label] of [
    ['operating', 'business', '8101', 100, 'Reserve in Motion'],
    ['reserve', 'business', '8102', 200, 'Reserve'],
    ['private', 'person', '8103', 400, 'Private'],
    ['unknown', 'investment', '8104', 800, 'Unassigned'],
  ]) {
    f.owner(slug);
    f.raw('UPDATE fin_entities SET kind=?,display_label=? WHERE entity_slug=?', role, slug === 'operating' ? 'Company Unit' : `Unit ${slug}`, slug);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
      VALUES (?,?,'checking','asset',?,?,'manual','owner_stated','confirmed',?)`, slug, slug, mask, label, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'owner_stated','confirmed',?)`, slug, cents, NOW);
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES (?,?,'2026-09-20',?,'outflow','Office supplies','owner_stated','confirmed',?)`, slug, slug, cents, NOW);
  }
  return f;
}
async function ask(reader, f, question, kind = 'balance', hint = null, vendor = null) {
  const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
  let provider = 0, fallback = 0;
  const response = await reader({ env: f.env, question, now: Date.parse(NOW), grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => {
      provider++;
      return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null, intents: [{
        kind, direction: kind === 'balance' || kind === 'transfers' ? null : 'outflow', count: null, vendor_text: vendor,
        account_hint: hint, amount_text: null, date_text: null, period: { type: kind === 'balance' ? 'none' : 'last_month' },
      }] }) }] };
    },
  }, async gap => { fallback++; return Response.json({ answer: null, gaps: gap ? [gap] : [] }); });
  const sql = f.calls.slice(before);
  const reached = { provider, fallback, inventory: sql.filter(q => /JOIN fin_entities e/.test(q)).length,
    disclosure: sql.filter(q => /LEFT JOIN fin_entities e/.test(q)).length,
    // Inventory checks coverage existence, but returns no money records. Count
    // only statements that project transaction or balance observations.
    facts: sql.filter(q => /(?:SELECT t\.id,t\.account_slug AS source_account_slug|WITH observations AS)/.test(q)).length };
  assert.ok(provider || reached.inventory, 'parser or account decision reached');
  assert.equal(f.first('SELECT total_changes() n').n, changes, 'answer is read-only');
  const text = await response.text();
  return { text, body: JSON.parse(text), reached };
}

export { fixture, ask, base };
