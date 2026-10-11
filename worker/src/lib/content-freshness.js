import { parseCanonicalEvidenceDate } from './query-intent.js';

// Explicit document labels only. An arbitrary date, quoted email, deadline or
// file mtime must not turn old material into current evidence.
export function explicitContentDate({ title = '', content = '' } = {}) {
  const dates = [];
  for (const match of String(content).matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(?:Last updated|Updated|As of)(?:\*\*)?[ \t]*:?[ \t]*(?:\*\*)?(\d{4}-\d{2}-\d{2})(?:\*\*)?[ \t]*[.!]?[ \t]*$/gim)) {
    dates.push(parseCanonicalEvidenceDate(match[1]));
  }
  for (const match of String(title).matchAll(/\((?:started|updated)[ \t]+(\d{4}-\d{2}-\d{2})\)/gi)) {
    dates.push(parseCanonicalEvidenceDate(match[1]));
  }
  const valid = dates.filter(value => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

const FILE_DATE_SOURCES = new Set([null, undefined, '', 'none', 'filename', 'path', 'content']);
export function contentFreshness({ title, content, date = null, dateSource = null } = {}) {
  if (!FILE_DATE_SOURCES.has(dateSource)) return null;
  const explicit = explicitContentDate({ title, content });
  if (explicit === null) return null;
  // Only a filename competes with explicit freshness. A directory date or
  // inferred body date is not evidence that the document itself was updated.
  const filename = String(title || '').match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const filenameDates = filename.map(parseCanonicalEvidenceDate).filter(value => value !== null);
  const prior = dateSource === 'filename' && Number.isFinite(date) ? [date] : [];
  const value = Math.max(explicit, ...filenameDates, ...prior);
  return { value, source: 'content', reliable: true };
}

export function withContentFreshness(envelope) {
  const fresh = contentFreshness({ title: envelope.title, content: envelope.content,
    date: parseCanonicalEvidenceDate(envelope.occurred_at), dateSource: envelope.date_source });
  return fresh ? { ...envelope, occurred_at: new Date(fresh.value).toISOString(),
    date_source: fresh.source, date_reliable: true } : envelope;
}
