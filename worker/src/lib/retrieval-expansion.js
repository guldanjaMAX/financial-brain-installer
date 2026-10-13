import { reliableDocumentTime } from './query-intent.js';

const HISTORY = /\b(?:history|historical|previous|prior|earlier|before|backups?|versions?|compare|changes?|changed)\b|\b(?:as of|during|in)\s+(?:19|20)\d{2}\b/i;
const FILE = /\.(?:md|txt|pdf|docx?|xlsx?|csv|pptx?)$/i;
export function titleFamily(row) {
  const title = String(row?.title || '');
  if (!FILE.test(title) || /^(?:gmail|imap|email|calendar|zoom|imessage)$/i.test(row?.source_kind || '')) return null;
  const backup = /^(?:copy of\s+)|\(backup\b|\bBACKUP\s+\d{4}|\(\d+\)(?=\.[^.]+$)/i.test(title);
  const normalized = title.replace(/^copy of\s+/i, '')
    .replace(/\s*\(backup[^)]*\)/gi, '')
    .replace(/\s+BACKUP\s+\d{4}-\d{2}-\d{2}(?:-\d{4,6})?/gi, '')
    .replace(/\s*\(\d+\)(?=\.[^.]+$)/g, '')
    .replace(/\s*[-_( ]*\d{4}-\d{2}-\d{2}\)?(?=\.[^.]+$)/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized.replace(FILE, '').trim()) return null;
  // Never merge one client's similarly titled file with another's, or merge
  // across source/folder boundaries. This is ranking only, never deletion.
  return { key: JSON.stringify([row.source, row.entity_slug, row.client, row.top_folder, normalized]), backup };
}

export function collapseTitleFamilies(rows, query) {
  if (HISTORY.test(String(query || ''))) return rows;
  const groups = new Map();
  for (const row of rows) {
    const family = titleFamily(row);
    if (!family) continue;
    const prior = groups.get(family.key);
    const time = reliableDocumentTime(row) ?? -Infinity;
    if (!prior || (prior.backup && !family.backup) || (prior.backup === family.backup && time > prior.time)) {
      groups.set(family.key, { row, backup: family.backup, time });
    }
  }
  const seen = new Set(), canonical = [], backups = [];
  for (const row of rows) {
    const family = titleFamily(row);
    if (!family) { canonical.push(row); continue; }
    if (seen.has(family.key)) continue;
    seen.add(family.key);
    const best = groups.get(family.key);
    (best.backup ? backups : canonical).push(best.row);
  }
  return [...canonical, ...backups];
}

const DOMAINS = [
  // Candidate recall only. Existing scoped SQL and the money verifier still
  // decide whether a sales record answers this exact revenue question.
  { pattern: /\brevenue breakdown\b/i, terms: ['sales', 'gross', 'turnover'] },
  { pattern: /\bbloodwork\b/i, terms: ['labs', 'lab results', 'blood test', 'panel'] },
  { pattern: /\bp\s*&\s*l\b/i, terms: ['profit and loss', 'revenue', 'income', 'expenses'] },
  { pattern: /\bsales opportunities\b/i, terms: ['prospects', 'pipeline', 'proposal', 'install', 'deal'] },
];
export function domainExpansion(query) {
  return DOMAINS.filter(entry => entry.pattern.test(String(query))).flatMap(entry => entry.terms);
}

const NON_NAMES = new Set(('What When Where Which Who Whose Why How Show List Tell Find Give Please Current Latest All Owner Workspace Project History Bloodwork Sales Opportunities').toLowerCase().split(' '));
export function queryNames(query) {
  return [...new Set(String(query || '').match(/\b[A-Z][a-z]{3,}\b/g) || [])]
    .filter(word => !NON_NAMES.has(word.toLowerCase())).slice(0, 2);
}
export function oneEditApart(left, right) {
  const a = left.toLowerCase(), b = right.toLowerCase();
  if (a === b || Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) === 1;
}
function metadataNames(row) {
  let meta = row?.authority_meta || row?.meta || {};
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  const values = [row?.title, row?.client, meta.sender, meta.from, meta.attendees, meta.participants];
  return [...new Set(values.flatMap(value => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))
    .match(/\b[A-Z][a-z]{3,}\b/g) || []))];
}
export function metadataNameVariant(name, rows) {
  const candidates = [...new Set(rows.flatMap(metadataNames))];
  if (candidates.some(candidate => candidate.toLowerCase() === name.toLowerCase())) return null;
  const variants = candidates.filter(candidate => oneEditApart(name, candidate));
  // Ambiguity is not identity. Do not silently choose one of several people.
  const distinct = [...new Map(variants.map(value => [value.toLowerCase(), value])).values()];
  return distinct.length === 1 ? { requested: name, matched: distinct[0], method: 'metadata_edit_distance_1' } : null;
}
export function containsName(row, name) {
  const words = `${row?.title || ''} ${row?.text || row?.snippet || ''} ${metadataNames(row).join(' ')}`.toLowerCase().match(/[a-z]+/g) || [];
  return words.includes(name.toLowerCase());
}
