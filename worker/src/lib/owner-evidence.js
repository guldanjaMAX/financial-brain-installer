// Presentation only. Canonical scores and their reasons remain available to
// calibration, evidence gates and receipts; hiding a badge cannot change them.
// Translate generated compatibility metadata, never source quotations. Keep
// the specific account/date/movement gaps beside this plain evidence limit.
const evidenceWording = new Map([
  ['The compatibility ledger reading has no money-tool confidence assessment.',
    'The older money reading has not been checked against connected accounts, synced dates, missing periods and uncertain movements.'],
  ['Other query shapes need their own reviewed proof before High confidence.',
    'Other query shapes still need their own reviewed evidence checks.'],
  ['the SQL is outside the explicit High-confidence allow-list.',
    'this query has not passed the required evidence checks.'],
  ['Resolve each contributing party, verify its SQL grouping, and read and reconcile its complete history before using High confidence.',
    'Resolve each contributing party, verify its SQL grouping, and read and reconcile its complete history before treating these figures as verified.'],
]);
const metadataWording = text => text.split(/(?<=\n)/).map(line => /\[\d+\]/.test(line) ? line
  : [...evidenceWording].reduce((value, [internal, owner]) => value.replaceAll(internal, owner), line)).join('');

export function ownerEvidenceNote(confidence, answer = '') {
  if (confidence?.percent === 100 && Array.isArray(confidence.missing) && confidence.missing.length === 0) return '';
  // Compare prose on both sides, ignoring presentation punctuation, so the
  // five-part answer keeps its exact facts without a repeated assessment panel.
  const comparable = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const shown = comparable(String(answer));
  const seen = new Set();
  const remaining = values => (Array.isArray(values) ? values : []).filter(value => typeof value === 'string')
    .map(value => ownerOutputText(metadataWording(value))
      .trim().replace(/[.!?;\s]+$/, ''))
    .filter(value => {
      const key = comparable(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return !` ${shown} `.includes(` ${key} `);
    });
  const list = values => Array.isArray(values) ? values : [];
  const reasons = remaining([...list(confidence?.basis), ...list(confidence?.reasons)]);
  const missing = remaining(confidence?.missing);
  if (!reasons.length && !missing.length && seen.size) return '';
  const detail = [reasons.join('; '), missing.length ? `Still needed: ${missing.join('; ')}` : ''].filter(Boolean).join('; ');
  return detail ? `${detail}; this answer may be incomplete.`
    : 'Some supporting evidence is still missing, so this answer may be incomplete.';
}

// The only removable answer format is the standalone server score line from
// money-confidence.js:confidenceText and money-query-confidence.js:moneyConfidence.
// Frozen money baselines preserve that same format in line/display fields.
// Document ownerConfidenceLine appends Why/Missing on the same line: preserve
// that entire line, because removing any part could erase evidence. Model
// labels, tables and split blocks deliberately remain outside this boundary.
export function ownerOutputText(answer) {
  if (typeof answer !== 'string') return answer;
  const serverLine = /^Confidence: (?:High|Medium|Low) \((?:100|[1-9]?\d)%\)$/;
  const isServerLine = line => {
    // Normalize only the comparison copy. Kept lines, including their original
    // whitespace and terminators, must never be rewritten or trimmed.
    const plain = line.trim()
      .replace(/^(?:(?:>[ \t]*|[-+*][ \t]+|\d+[.)][ \t]+))*/, '')
      .replace(/[*_]/g, '').trim();
    return serverLine.test(plain);
  };
  return answer.split(/(?<=\n)/).filter(line => !isServerLine(line)).join('');
}

// Compatibility export; every consumer uses the same whole-line boundary.
export const hideConfidenceLine = ownerOutputText;
