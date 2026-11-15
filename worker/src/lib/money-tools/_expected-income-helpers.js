import { searchKeyword } from '../store-d1.js';
import { DEFAULT_TENANT } from '../fin-d1.js';

export const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const dollars = n => {
  // Dividing a safe integer by 100 can still round away a cent near its upper
  // bound. Format the integer dollars and the remainder independently.
  const cents = BigInt(n), magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}$${(magnitude / 100n).toLocaleString('en-US')}.${String(magnitude % 100n).padStart(2, '0')}`;
};
export const add = (a, b) => {
  if (!Number.isSafeInteger(a + b)) throw new RangeError('amount overflow');
  return a + b;
};
export const total = rows => rows.reduce((sum, row) => add(sum, row.amount_minor), 0);

// Only memo evidence assigns an invoice period. A bank payer alone cannot
// distinguish an overdue invoice from this month's obligation.
export function invoicePeriod(row) {
  const text = row.description || '';
  if (!/\binvoice\b/i.test(text)) {
    // A newly starting expectation permits an ordinary deposit memo, not an
    // arbitrary description that might allocate the money elsewhere.
    const memo = text.trim().toLowerCase();
    return ['', 'deposit', 'bank deposit', 'client deposit', 'company deposit',
      `${String(row.payee || '').trim().toLowerCase()} deposit`].includes(memo) ? null : false;
  }
  // Amount annotations and allocation language require verified allocations.
  // A period label alone cannot prove that the whole deposit paid that invoice.
  if (/\b(?:USD|partial|balance|allocation|allocated|unallocated)\b|\$|\d+[.,]\d{2}\b/i.test(text)) return false;
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  // Allow only periods attached to "invoice". Processing/receipt dates elsewhere
  // in the bank memo cannot certify an obligation's settlement.
  const period = `(?:${months.join('|')})(?:\\s+20\\d{2})?|\\d{4}-\\d{2}(?:-\\d{2})?`;
  const before = new RegExp(`\\b(${period})\\s+invoice\\b`, 'gi');
  const after = new RegExp(`\\binvoice(?:\\s*:\\s*|\\s+)(?:for\\s+)?(${period})\\b`, 'gi');
  const clauses = [...text.matchAll(before), ...text.matchAll(after)];
  // Certify only a complete single-clause memo. Unclassified text may carry
  // another allocation even when it never repeats the word invoice.
  const remainder = clauses.length === 1 ? text.replace(clauses[0][0], '').trim() : '';
  const clearRemainder = /^(?:payment|paid)?(?:\s*processed\s+\d{4}-\d{2}-\d{2})?\.?$/i.test(remainder);
  const found = clauses.map(match => {
    const value = match[1].toLowerCase();
    if (/^\d/.test(value)) return value.slice(0, 7);
    const month = months.indexOf(value.split(/\s/)[0]) + 1;
    const explicitYear = value.match(/20\d{2}/);
    const year = explicitYear ? Number(explicitYear[0]) : Number(row.posted_on.slice(0, 4)) - (month > Number(row.posted_on.slice(5, 7)) ? 1 : 0);
    return `${year}-${String(month).padStart(2, '0')}`;
  });
  // Invoice wording with an unsupported or conflicting period is evidence we
  // cannot allocate, never absent evidence that can settle a new obligation.
  // null is reserved for plain deposit memos with no invoice evidence.
  return !clearRemainder || [...text.matchAll(/\binvoice\b/gi)].length !== 1 || new Set(found).size !== 1 ? false : found[0];
}

// Month-only evidence cannot distinguish dues outside a partial query window.
export function invoiceMonthCovered(period, from, to) {
  const start = `${period}-01`;
  if (!day(start) || from > start) return false;
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return to >= end.toISOString().slice(0, 10);
}

// The existing charge detector requires three outflows. Income deliberately
// accepts two adjacent months, retaining its own evidence and likely label.
export function recurringDeposits(history, rows, expectations, from, to, normalize, possibleName) {
  const groups = new Map();
  for (const row of history) {
    if (!row.payee || row.amount_minor <= 0) continue;
    const key = normalize(row.payee);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = [];
  for (const [identity, evidence] of groups) {
    evidence.sort((a, b) => a.posted_on.localeCompare(b.posted_on));
    const last = evidence.at(-1), prior = evidence.at(-2);
    if (!prior || expectations.some(e => e.confirmed_by_owner && normalize(e.client) === identity)) continue;
    const gap = (Date.parse(last.posted_on) - Date.parse(prior.posted_on)) / 86400000;
    const monthIndex = d => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    const delta = BigInt(last.amount_minor) - BigInt(prior.amount_minor);
    if (gap < 25 || gap > 35 || monthIndex(last.posted_on) - monthIndex(prior.posted_on) !== 1 ||
        (delta < 0n ? -delta : delta) * 10n > BigInt(prior.amount_minor) || monthIndex(from) - monthIndex(last.posted_on) !== 1) continue;
    const dates = occurrences({ start_on: last.posted_on, cadence: 'monthly' }, from, to);
    for (const due_on of dates) {
      const deposits = rows.filter(r => normalize(r.payee) === identity && r.posted_on.slice(0, 7) === due_on.slice(0, 7));
      const received = total(deposits);
      result.push({ payee: last.payee, due_on, amount_minor: last.amount_minor,
        possible_contract_overlap: expectations.some(e => e.confirmed_by_owner && possibleName(last, e)),
        remaining_minor: Math.max(0, last.amount_minor - received), deposits, evidence: [prior, last],
        pattern: `monthly since ${prior.posted_on.slice(0, 7)}, days ${prior.posted_on.slice(8)}-${last.posted_on.slice(8)}, two months running` });
    }
  }
  return result;
}

// Calendar anniversaries stay anchored to the original day. Clamping February
// must not move a January-31 contract to March 28.
export function occurrences(e, from, to) {
  const result = [];
  const start = new Date(`${e.start_on}T00:00:00Z`);
  const end = e.end_on && e.end_on < to ? e.end_on : to;
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[e.cadence];
  if (e.cadence === 'once') return e.start_on >= from && e.start_on <= end ? [e.start_on] : [];
  // Skip directly to the requested period; an old contract cannot exhaust a
  // fixed iteration limit and quietly hide current obligations.
  let n = e.cadence === 'weekly' ? Math.max(0, Math.floor((Date.parse(from) - start.getTime()) / 604800000)) :
    Math.max(0, Math.floor(((Number(from.slice(0, 4)) - start.getUTCFullYear()) * 12 + Number(from.slice(5, 7)) - 1 - start.getUTCMonth()) / months));
  for (;; n++) {
    let date;
    if (e.cadence === 'weekly') date = new Date(start.getTime() + n * 604800000);
    else {
      const first = new Date(start); first.setUTCDate(1); first.setUTCMonth(start.getUTCMonth() + n * months);
      const last = new Date(first); last.setUTCMonth(first.getUTCMonth() + 1); last.setUTCDate(0);
      first.setUTCDate(Math.min(start.getUTCDate(), last.getUTCDate())); date = first;
    }
    const on = date.toISOString().slice(0, 10);
    if (on > end) break;
    if (on >= from) result.push(on);
  }
  return result;
}

// v1 recognizes one complete terms block or one unambiguous fixed-fee clause
// per search hit. Multiple fees and conditional clauses need manual review.
export function parseContract(hit) {
  if (!/\b(contract|agreement|retainer)\b/i.test(`${hit.title} ${hit.text}`)) return null;
  if (!hit.date_reliable || /\b(if|unless|subject to|conditional|up to|cancelled|canceled|terminated)\b/i.test(hit.text)) return null;
  const fields = {};
  for (const line of String(hit.text).split(/\r?\n/)) {
    const match = line.match(/^\s*(Client|Amount|Cadence|Start|End):\s*(.*?)\s*$/i);
    if (match) {
      const key = match[1].toLowerCase();
      if (key in fields) return null;
      fields[key] = match[2];
    }
  }
  if (!Object.keys(fields).length) {
    const clauses = [...String(hit.text).matchAll(/^\s*([^\r\n:]{1,200}?)\s+(?:will|shall|agrees to)\s+pay\s+(?:USD\s+|\$)(\d+\.\d{2})\s+(?:per\s+(week|month|quarter|year)|(weekly|monthly|quarterly|yearly))\s+(?:from|starting|beginning)\s+(\d{4}-\d{2}-\d{2})\s+(?:through|until|to|ending)\s+(\d{4}-\d{2}-\d{2})[.!]?\s*$/gim)];
    if (clauses.length !== 1 || /\b(CAD|AUD|EUR|GBP)\b/i.test(hit.text)) return null;
    const [, client, amount, period, cadence, start, end] = clauses[0];
    Object.assign(fields, { client: client.trim(), amount: `USD ${amount}`,
      cadence: cadence?.toLowerCase() || { week: 'weekly', month: 'monthly', quarter: 'quarterly', year: 'yearly' }[period.toLowerCase()], start, end });
  }
  const amount = fields.amount?.match(/^USD ([0-9]+)\.([0-9]{2})$/);
  if (!amount || !fields.client || fields.client.length > 200 || !day(fields.start) ||
      !['once', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(fields.cadence) ||
      !fields.end || fields.end !== 'none' && (!day(fields.end) || fields.end < fields.start) ||
      !hit.doc_uid || !hit.title || !Number.isFinite(hit.document_date)) return null;
  const amountMinor = Number(amount[1]) * 100 + Number(amount[2]);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return { client: fields.client, amount_minor: amountMinor, cadence: fields.cadence,
    start_on: fields.start, end_on: fields.end === 'none' ? null : fields.end,
    source_document_id: hit.doc_uid, source_title: hit.title,
    source_date: new Date(hit.document_date).toISOString().slice(0, 10), confirmed_by_owner: 0 };
}

export async function proposeExpectations(env, { query = 'contract agreement retainer' } = {}) {
  const hits = await searchKeyword(env, query, { limit: 101 });
  const proposals = [], left_out = [];
  const tenant = env.BANK_FEED_TENANT || DEFAULT_TENANT;
  const seen = new Set();
  for (const hit of hits.slice(0, 100)) {
    const proposal = parseContract(hit);
    if (!proposal) { left_out.push({ document_id: hit.doc_uid, reason: 'Terms need owner review; no expectation was inferred.' }); continue; }
    const key = JSON.stringify([tenant, proposal]);
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const id = `expectation-${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')}`;
    const columns = Object.keys(proposal);
    await env.DB.prepare(`INSERT INTO fin_expectations (id,tenant_id,${columns.join(',')})
      VALUES (?, ?, ${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`)
      .bind(id, tenant, ...Object.values(proposal)).run();
    const stored = await env.DB.prepare('SELECT * FROM fin_expectations WHERE id=? AND tenant_id=?').bind(id, tenant).first();
    // Confirmation can only come from a separate owner action. A replay may
    // observe that action but must never reset it or report an unverified write.
    if (!stored || columns.some(c => c !== 'confirmed_by_owner' && stored[c] !== proposal[c])) throw new Error('expectation readback failed');
    proposals.push(stored);
  }
  if (hits.length > 100) left_out.push({ reason: 'More contract matches remain; search a narrower group to continue.' });
  return { proposals, left_out, complete: hits.length <= 100,
    say: ['Contract terms were saved as proposals. An owner must confirm them before they enter likely income.'] };
}
