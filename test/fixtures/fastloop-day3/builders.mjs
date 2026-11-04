import { CLOCK, PERIODS, evidence } from '../fastloop-money/input.mjs';

export const BANK_VERSION = 'route-day3-v1';
export function money(id, question, period, profile = 'typed', extra = {}) {
  return { schema: 1, id, base: id.startsWith('Q'), family: id, category: 'money',
    privacy: 'synthetic', split: id.startsWith('R') ? 'reserved' : 'development',
    bank_version: BANK_VERSION, clock: CLOCK, period: PERIODS[period], profile,
    principal: { kind: 'owner', all: true }, required_for_gate: true,
    fixture_types: ['money'], snapshot: evidence(profile), question, ...extra };
}
export function record(kind, slug, text, date = '2026-10-30T00:00:00Z') {
  const sources = { calls: 'zoom', mail: 'gmail', calendar: 'gcal', documents: 'drive', status: 'status' };
  const source = sources[kind];
  if (!source) throw Error('INVALID_RECORD_TYPE');
  return { kind, source, title: `${kind} record ${slug}`, doc_uid: `${source}:${slug}`,
    chunk_uid: `${source}:${slug}#0`, index: 0, revision: 'synthetic-1', date, text };
}
export function knowledge(id, category, question, documents, answer, extra = {}) {
  return { ...money(id, question, 'NONE'), category, fixture_types: [...new Set(documents.map(d => d.kind))],
    documents, vectorIds: documents.map(d => d.chunk_uid),
    modelOutputs: [answer, JSON.stringify({ supported: true, complete: true,
      evidence: documents.map((_, i) => i + 1), reason: 'The cited synthetic records state the answer.' })], ...extra };
}
export function validateBank(cases) {
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw Error('INVALID_BANK_SET');
  for (const c of cases) {
    if (c.schema !== 1 || c.privacy !== 'synthetic' || !['development', 'reserved'].includes(c.split) ||
      !c.question || !c.clock?.now_utc || !c.clock?.owner_time_zone || !c.period?.rule ||
      !c.principal?.all || !c.snapshot?.accounts?.length || !c.fixture_types?.length ||
      !['money', 'calendar', 'messages', 'documents', 'status', 'calls'].includes(c.category)) throw Error('INVALID_BANK_CASE');
    for (const d of c.documents || []) if (!d.kind || !d.date || !d.chunk_uid || !d.text) throw Error('INVALID_TYPED_RECORD');
  }
  return cases;
}
