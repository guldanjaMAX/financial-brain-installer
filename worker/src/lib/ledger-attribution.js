// One request-local identity registry and one attribution decision per inflow.
// Bank metadata never registers an identity. Every spelling uses this same key.
export const normalizeMerchantText = value => (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+|&/gu) || []).join(" ");

export function payerRegistry(identities) {
  const index = new Map();
  for (const identity of identities) for (const label of [identity.legal_name, identity.display_label]) {
    const key = normalizeMerchantText(label);
    if (!key) continue;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(identity.entity_slug);
  }
  return index;
}

export function lookupPayer(label, registry) {
  const slugs = registry.get(normalizeMerchantText(label));
  if (!slugs) return { state: 'missing' };
  return slugs.size === 1 ? { state: 'unique', slug: slugs.values().next().value }
    : { state: 'ambiguous' };
}

const senderLabel = String.raw`(?:from|by|orig\s+co\s+name|originator(?:\s+name)?|sender(?:\s+name)?)`;
const senderChannel = String.raw`(?:(?:ach|eft|wire|zelle|bank)(?:\s+(?:credit|transfer|payment|deposit))?|payment|deposit|receipt|transfer)`;
const delimiters = String.raw`;,|\n`;
const senderOpening = new RegExp(String.raw`^(?:${senderChannel}\s+)?(?:(${senderLabel}\s*:)\s*|(?:from|by)\s+)([\s\S]+)$`, 'i');
// Labelled metadata and bare FROM/BY clauses share the delimiter set. Parse
// all fields, including those after REF, before accepting any sender.
const statementField = new RegExp(String.raw`(?:^|[\s${delimiters}])(${senderLabel}|orig\s+id|co\s+id|company\s+id|desc\s+date|co\s+entry\s+descr|entry\s+descr|sec|trace|beneficiary|invoice|memo|reference|ref)\s*(?:#\s*:?|:)\s*|[${delimiters}]\s*(?:${senderChannel}\s+)?(from|by)\s+`, 'gi');
const isSenderLabel = new RegExp(`^${senderLabel}$`, 'i');
const trailingDelimiter = new RegExp(String.raw`[\s${delimiters}]+$`);
const shorthandSuffixes = ['deposit', 'payment', 'receipt', 'payroll', 'settlement']
  .flatMap(type => ['', 'ach ', 'eft ', 'wire ', 'zelle '].map(channel => channel + type));

function decision(readings, source) {
  const resolved = readings.filter(r => r.payer.state === 'unique');
  const slugs = new Set(resolved.map(r => r.payer.slug));
  const evidence = { source, ambiguous: slugs.size > 1 || readings.some(r => r.payer.state === 'ambiguous'),
    candidates: readings.map(r => r.identity) };
  if (resolved.length !== readings.length || slugs.size !== 1)
    return { state: 'unknown', entity_slug: null, reading: null, evidence };
  // Distinct aliases of a single entity do not create competing payers.
  const reading = readings.find(r => !r.suffix) || readings[0];
  return { state: reading.suffix ? 'assumed' : 'confirmed', entity_slug: reading.payer.slug,
    reading: { identity: reading.identity, ...(reading.suffix ? { suffix: reading.suffix } : {}) }, evidence };
}

export function attributeInflow(row, registry) {
  const exact = (identity, source) => decision([{ identity, payer: lookupPayer(identity, registry) }], source);
  if (row.payee) return exact(row.payee, 'payee');
  const description = String(row.description || '').trim();
  const directed = description.match(senderOpening);
  if (directed) {
    const value = directed[2], fields = [...value.matchAll(statementField)];
    const full = lookupPayer(description, registry);
    if (full.state === 'ambiguous') return exact(description, 'description');
    // A bare From/By opening can also be a whole registered name. Consider
    // both registered readings: aliases agree by slug, distinct entities do not.
    if (!directed[1] && !fields.length && full.state === 'unique') {
      const parsed = lookupPayer(value, registry);
      return decision([{ identity: description, payer: full },
        ...(parsed.state === 'missing' ? [] : [{ identity: value, payer: parsed }])], 'description');
    }
    if (lookupPayer(value, registry).state === 'ambiguous') return exact(value, 'sender');
    const labels = [value.slice(0, fields[0]?.index ?? value.length).replace(trailingDelimiter, '')];
    for (const [i, field] of fields.entries()) if (field[2] || isSenderLabel.test(field[1]))
      labels.push(value.slice(field.index + field[0].length, fields[i + 1]?.index ?? value.length).replace(trailingDelimiter, ''));
    const readings = labels.map(identity => ({ identity, payer: lookupPayer(identity, registry) }));
    if (fields.length || directed[1] || readings[0].payer.state !== 'missing') return decision(readings, 'sender');
    // Supported legacy prose has a complete trailing value, never an arbitrary
    // split on a word that could be part of the sender's name.
    const prose = labels[0].match(/^(.+?)\s+(?:(?:reference|ref|for\s+invoice)\s+\d[\d ./-]*|for\s+.+\s+invoice)$/i);
    return exact(prose ? prose[1] : labels[0], 'sender');
  }
  const text = description.normalize('NFKC').replace(/\s+/g, ' ');
  const readings = [];
  for (const suffix of shorthandSuffixes) {
    if (!text.toLowerCase().endsWith(` ${suffix}`)) continue;
    const identity = text.slice(0, -suffix.length - 1), payer = lookupPayer(identity, registry);
    if (payer.state !== 'missing') readings.push({ identity, suffix, payer });
  }
  const full = lookupPayer(description, registry);
  if (full.state !== 'missing' || !readings.length) readings.push({ identity: description, payer: full });
  return decision(readings, 'description');
}

// Only a confirmed row can eliminate a payer. An assumption supports a
// positive figure for its own entity, with a note, and no other decision.
export function selectAttributedInflows(rows, attributions, { wanted, amountMinor = null, exactNamesOnly = false }) {
  const matched = [], unattributed = [];
  for (const row of rows) {
    const attribution = attributions.get(row.id);
    const same = wanted.state === 'unique' && attribution.entity_slug === wanted.slug;
    const amountMatches = amountMinor === null || amountMinor === row.amount_minor;
    if (wanted.state === 'ambiguous' || attribution.state === 'unknown' ||
        (attribution.state === 'assumed' && (!same || exactNamesOnly || row.amount_minor <= 0 || !amountMatches)))
      unattributed.push(row);
    else if (same && amountMatches) matched.push(row);
  }
  return { matched, unattributed };
}

// This scope-wide proof governs every exact payer figure, including optional
// transfer totals on a group. A confirmed group does not confirm other rows.
export function inflowScopeConfirmed(rows, attributions) {
  return rows.filter(row => row.direction === 'inflow').every(row => attributions.get(row.id)?.state === 'confirmed');
}

// A displayed payer subtotal of zero is still a zero claim. Use the same
// guard for gross groups, partial subtotals, lead figures and transfer flips.
export function payerAmount(total, scopeConfirmed) {
  return total === 0 && !scopeConfirmed ? null : total;
}
