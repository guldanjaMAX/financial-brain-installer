// A bounded bank question still has usable operands when a trailing phrase
// needs evidence the ledger does not carry. Keep those operands and disclose
// the unapplied phrase; never invent refund subtraction or an account selector.
export function ledgerReadingQualification(question) {
  // Replace only a temporal span. Account locators, named payees and the
  // surrounding request must survive verbatim for the ordinary intent guards.
  const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const temporal = new RegExp(`\\b(?:at|in|during|over|for|throughout|within|across|around|near|toward|towards)\\s+(?:the\\s+)?((?:beginning|start|end|middle)\\s+of|(?:first|last)\\s+week\\s+of)\\s+(${months})\\s+(\\d{4})\\b`, 'i').exec(question || '');
  if (temporal) {
    const [, restriction, month, year] = temporal;
    return { question: question.slice(0, temporal.index) + `in ${month} ${year}` + question.slice(temporal.index + temporal[0].length),
      unapplied: temporal[0],
      detail: `Time restriction not applied: '${temporal[0]}' was read as the full month of ${month} ${year}; no ${restriction.replace(/\s+of$/, '').replace(/\s+/g, '-')} cutoff was inferred.`,
      missing: 'The intended restricted dates or cutoff.' };
  }
  const typo = /\b(in|during|for)\s+Sepx\s+(\d{4})\b/i.exec(question || '');
  if (typo) return { question: question.slice(0, typo.index) + `${typo[1]} September ${typo[2]}` + question.slice(typo.index + typo[0].length),
    unapplied: `Sepx ${typo[2]}`,
    detail: `Date interpretation: read 'Sepx ${typo[2]}' as September ${typo[2]}. The intended month is unconfirmed.`,
    missing: 'Confirmation of the intended month.' };
  const suffix = /\s+(after (?:investment returns|receiving store credit|shopping at refund))([?.!]*)$/i.exec(question || '');
  if (!suffix) return { question, unapplied: null };
  let core = question.slice(0, suffix.index);
  if (!/\b(?:spending|spend|spent)\b/i.test(core) ||
      !/\b(?:this|last|current|previous) month\b/i.test(core)) return { question, unapplied: null };
  if (/^after shopping at refund$/i.test(suffix[1]) && !/\bat\s+\S/i.test(core)) {
    core = core.replace(/\b((?:this|current) month)\b/i, 'at refund $1');
  }
  return { question: core + suffix[2], unapplied: suffix[1] };
}
