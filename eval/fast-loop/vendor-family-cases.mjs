import { BASE_CASES, evidence } from '../../test/fixtures/fastloop-money/input.mjs';

// Synthetic development inputs only. No private replay or held-out material.
const make = (id, vendor = 'Vendorwave') => ({ ...BASE_CASES[0], id: `vendor-family/${id}`,
  base: false, family: 'vendor-family', question: `How much did I spend at ${vendor} last month?`,
  clock: { now_utc: '2026-11-02T19:00:00Z', owner_time_zone: 'America/Phoenix' },
  period: { rule: 'previous complete owner calendar month', from: '2026-10-01', to: '2026-10-31' },
  period_id: 'PREV' });
export const cases = [
  make('products'), make('exact-family'), make('exact'), make('short', 'Cloud'),
  make('short-exact', 'Cloud'), make('embedded'), make('alias', 'Google'),
  make('alias-boundary', 'Google'), make('bank-only'), make('mixed'),
  make('refund'), make('owned'), make('partial'), make('many'), make('spelling'),
];

export function snapshotFor(c) {
  const snapshot = evidence();
  const row = (id, cents, payee, extra = {}) => ({ id, uid: `vendor-family-${id}`, account: 'cash',
    date: '2026-10-05', cents: String(cents), direction: 'outflow', payee,
    description: 'Card purchase', pending: 0, ...extra });
  const products = [row(1, 1201, 'Vendorwave Cloud'), row(2, 2302, 'VENDORWAVE *WORKSPACE'),
    row(3, 3497, 'Vendorwave / Media')];
  const exact = row(4, 501, 'Vendorwave');
  const key = c.id.split('/')[1];
  const matrices = {
    products,
    'exact-family': [exact, ...products],
    exact: [exact],
    short: [row(1, 1700, 'Cloud Cafe'), row(2, 2300, 'Cloud Parts')],
    'short-exact': [row(4, 501, 'Cloud'), row(1, 1700, 'Cloud Cafe'), row(2, 2300, 'Cloud Parts')],
    embedded: [row(1, 9900, 'Supervendorwave Cloud'), row(2, 8800, 'Vendorwaveworks')],
    alias: [row(1, 1201, 'GOOG *CLOUD'), row(2, 9900, 'Goog Kitchen'), row(3, 8800, 'Googlet *Cloud')],
    'alias-boundary': [row(1, 9900, 'Goog Kitchen'), row(2, 8800, 'Googlet *Cloud')],
    'bank-only': [row(1, 9900, null, { description: 'VENDORWAVE *CLOUD' })],
    mixed: [products[0], row(2, 9900, null, { description: 'VENDORWAVE *WORKSPACE' })],
    refund: [products[0], row(2, 201, 'Vendorwave Cloud', { direction: 'inflow', description: 'Refund' })],
    owned: [products[0], row(2, 5000, 'Vendorwave Reserve', { description: 'TRANSFER TO account 5353' }),
      row(3, 5000, null, { account: 'reserve', direction: 'inflow', description: 'TRANSFER FROM account 3131' })],
    partial: [...products, row(4, 99999, 'Vendorwave Other', { account: 'reserve' })],
    many: Array.from({ length: 8 }, (_, i) => row(i + 1, 101 + i, `Vendorwave Product ${i + 1}`)),
    spelling: [products[0], row(2, 2302, 'VENDORWAVE CLOUD')],
  };
  snapshot.rows = matrices[key];
  if (!snapshot.rows) throw Error('UNKNOWN_VENDOR_FAMILY_CASE');
  if (key === 'owned') snapshot.accounts.find(a => a.slug === 'reserve').label = 'Vendorwave Reserve';
  if (key === 'partial') snapshot.accounts.find(a => a.slug === 'reserve').from = '2026-10-15';
  return snapshot;
}
