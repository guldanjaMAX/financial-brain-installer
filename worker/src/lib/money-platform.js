import { normalizeLedgerText } from './money-analysis.js';

export const PLATFORM_NAMES = Object.freeze(['stripe','square','paypal','shopify','etsy','ebay','doordash']);
const names = '(?:' + PLATFORM_NAMES.join('|') + ')';
const prefix = `(?:(${names})(?: inc| payments)? )?`;
const liability = new Set(['card','loan','line_of_credit']);
const trusted = row => row.provenance === 'feed' || row.category_basis_state === 'confirmed';
const recordedPlatforms=new Map(PLATFORM_NAMES.flatMap(name=>[name,name+' inc',name+' payments'].map(label=>[label,name])));
const descriptors=PLATFORM_NAMES.map(name=>({name,
  movement:new RegExp(`^(?:ach credit )?${name}(?: inc| payments)? (?:payout|transfer|refunds?|dispute|chargeback|reserve|rolling reserve)(?: |$)`),
  deposit:new RegExp(`^${name} inc deposit(?: |$)`),
  origin:new RegExp(`^orig co name ${name} orig id [a-z0-9]+ .* co entry descr (?:transfer|payout)(?: |$)`)}));

// Adapters persist the provider's detailed category (primary as fallback) in
// fin_transactions.category. Readers of provider-shaped rows use that same order.
export const platformCategory = row => normalizeLedgerText(row.category_detailed || row.category_primary || row.category);
export function platformIdentity(row) {
  const raw = String(row.payee || '');
  const payee=normalizeLedgerText(raw);
  const recorded = recordedPlatforms.get(payee) || (/[.,]/.test(raw)?recordedPlatforms.get(normalizeLedgerText(raw.replace(/[.,]/g,''))):null);
  if(recorded)return recorded;
  const text = normalizeLedgerText(row.description);
  return descriptors.find(p=>p.movement.test(text)||p.deposit.test(text)||p.origin.test(text)||text==='transfer from '+p.name ||
    p.name==='square' && /^square inc sq\d{6} [a-z0-9]+$/.test(text))?.name || null;
}
export const accountProcessor = account => PLATFORM_NAMES.find(name =>
  [account,...(account?.members || [])].some(a => [a?.label,a?.institution].some(v =>
    (' '+normalizeLedgerText(v)+' ').includes(' '+name+' ')))) || null;

const id = '(?:batch|id|ref|no|po|py|tr|st|adj|adjustments?|[a-z]{0,4}\\d[\\p{L}\\p{N}]*|\\d+)';
const returns = '(?:refunds?|refund adjustments?|chargebacks?|disputes?)';
const annotation = new RegExp(`^(${prefix}(?:payouts?|transfer|deposit|settlement)(?: ${id})*) ` +
  `(?:net of|less|minus|after|excluding|excl|including|incl|includes|with) (?:(?:customer|client) )?${returns}` +
  `(?: (?:and|or) (?:${returns}|fees?|adjustments?))?((?: ${id})*)$`,'u');
export function payoutAnnotation(row, accounts) {
  if (row.direction !== 'inflow' || liability.has(accounts.get(row.effective_account_slug)?.account_kind || row.account_kind)) return null;
  const m = annotation.exec(normalizeLedgerText(row.description));
  if (!m || /\b(?:refunds?|reversals?|chargebacks?|disputes?|returned)\b/.test(platformCategory(row))) return null;
  const identity = platformIdentity(row), named = m[2];
  if (!identity && !named || named && identity && named !== identity) return null;
  return { description: (m[1]+m[3]).trim(), platform: identity || named };
}

// Type words are anchored; a vendor called "Refund Services" or chargeback
// protection is still a purchase. Unstructured type evidence is always likely.
const tail = '(?: (?:for|on|of|order|charge|payment|ref|id|no|debit|withdrawal|hold|held|withheld|withholding|adjustment|principal|amount|case|txn|transaction|ch|py|re|dp|du|[a-z]{0,4}\\d[\\p{L}\\p{N}]*|\\d+))*';
const debitType = new RegExp(`^${prefix}(?:(?:customer|client) )?(refunds?|disputes?|chargebacks?|(?:rolling )?reserves?)${tail}$`,'u');
const releaseType = new RegExp(`^${prefix}(?:rolling )?reserves? (?:release|released|return|returned|payout)${tail}$`,'u');
const recoveryType = new RegExp(`^${prefix}(?:chargeback|dispute) (?:reversal|reversed|won|recovery)(?: .*)?$`,'u');
export function platformTransaction(row, accounts) {
  const source = accounts.get(row.effective_account_slug);
  if (liability.has(source?.account_kind || row.account_kind)) return null;
  const text = normalizeLedgerText(row.description), category = platformCategory(row);
  const merchant = ['merchant','point_of_sale'].includes(source?.account_kind);
  const match = (row.direction === 'outflow' ? debitType : releaseType).exec(text);
  const identity = platformIdentity(row) || (merchant ? accountProcessor(source) : null);
  if (match && (identity || merchant) && !(match[1] && identity && match[1] !== identity)) {
    const type = row.direction === 'inflow' ? 'reserve_release' : /reserve/.test(match[2]) ? 'reserve' : 'return';
    return {type, platform:identity, confirmed:trusted(row) && /^(?:(?:customer|client) )?(?:refunds?|chargebacks?|disputes?)(?: debits?)?$/.test(category)};
  }
  // A provider transaction type is stronger than a descriptive memo. This also
  // covers merchant feeds that omit the processor from their refund descriptor.
  if (row.direction === 'outflow' && trusted(row) && /^(?:(?:customer|client) )?(?:refunds?|chargebacks?|disputes?)(?: debits?)?$/.test(category))
    return {type:'return',platform:identity,confirmed:true};
  if (row.direction === 'inflow' && recoveryType.test(text)) return {type:'recovery',platform:identity,confirmed:trusted(row) && /(?:chargeback|dispute) (?:recovery|reversal)/.test(category)};
  // Generic returned-sales descriptors need no guessed processor identity; they
  // remain estimated until the provider confirms the transaction type.
  if (row.direction === 'outflow' && /^(?:refund (?:to (?:customer|client)|order)\b|chargeback\b|dispute withdrawal\b)/.test(text) &&
      !/\b(?:fees?|protection|service|insurance|alert)\b/.test(text)) return {type:'return',platform:identity,confirmed:false};
  return null;
}

export function matchPlatformReserves(rows, decisions, accounts) {
  const byId = new Map(rows.map(r=>[r.id,r])), capacity = new Map();
  for (const d of decisions.filter(d=>['processor_reserve_held','processor_reserve_release_counted'].includes(d.estimate_reason)).sort((a,b)=>String(byId.get(a.id).posted_on).localeCompare(String(byId.get(b.id).posted_on)) ||
      (byId.get(a.id).direction==='outflow'?-1:1)-(byId.get(b.id).direction==='outflow'?-1:1) || a.id-b.id)) {
    const row=byId.get(d.id), type=platformTransaction(row,accounts);
    if (!type) continue;
    const key=JSON.stringify([row.tenant_id,row.entity,row.currency,type.platform || row.account_identity]);
    const held=capacity.get(key)||0n;
    if (d.estimate_reason==='processor_reserve_held') capacity.set(key,held+BigInt(row.amount_minor));
    if (d.estimate_reason==='processor_reserve_release_counted' && BigInt(row.amount_minor)<=held) {
      capacity.set(key,held-BigInt(row.amount_minor));
      Object.assign(d,{classification:'unknown',money_kind:'processor_reserve',estimate_reason:'processor_reserve_returned',uncertain_kind:null});
    }
  }
}
