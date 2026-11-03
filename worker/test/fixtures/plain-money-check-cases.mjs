export const checks = [
  ['ambiguous_boundary', v => { v.answer += '\0'; }, "It is unclear which words belong together, so the amount is unconfirmed."],
  ['document_coverage', v => { v.answer = 'Nothing is due [1].'; }, "A document excerpt does not prove that every payment was checked or that none are missing."],
  ['missing_citation', v => { v.answer = 'Card ending 4242 charged USD 120.00.'; }, "The amount has no source reference beside it."],
  ['unreliable_date', v => { v.question = 'What was charged?'; v.docs[0].date_reliable = false; }, "The supporting record has no reliable date."],
  ['ineligible_support', v => { v.docs[0].lineage.kind = 'agent_derived'; }, "The cited material is not an original record I can use to confirm money."],
  ['span_mismatch', v => { v.answer = v.answer.replace('120.00', '121.00'); }, "The amount, account, or month does not match the cited words."],
  ['citation_outside_window', v => { v.docs[0].ts = '2026-07-01'; }, "The supporting record is outside the dates you asked about."],
  ['claim_outside_window', v => { v.question = 'Did the payment arrive in the last 30 days?'; v.answer = 'The payment of USD 120.00 arrived on 2026-09-01 [1].'; v.docs[0].snippet = 'The payment of USD 120.00 arrived on 2026-09-01.'; }, "The payment date in the record is outside the dates you asked about."],
  ['incomplete_claim', v => { v.answer += ' Payment status is unconfirmed.'; }, "Some payment details are still unknown in the records checked."],
  ['claim_date_unknown', v => { v.question = 'Did the payment arrive in the last 30 days?'; v.answer = 'The payment of USD 120.00 arrived [1].'; v.docs[0].snippet = 'The payment of USD 120.00 arrived.'; }, "The record does not say when the payment arrived, was completed, or became due."],
].map(([rule, mutate, why]) => ({ rule, mutate, expected: `I can help review the source, but ${['incomplete_claim','claim_date_unknown'].includes(rule) ? 'some money details are still unconfirmed' : 'this money claim is unconfirmed'}. ${why}\nWant to check the original record?` }));
export const evidenceInput = () => ({
  now: Date.parse('2026-10-12T12:00:00Z'), question: 'What was charged in the last 60 days?',
  answer: 'Card ending 4242 charged USD 120.00 [1].',
  evidenceGate: { supported: true, complete: true, evidence: [1], reason: 'approved upstream' },
  docs: [{ n: 1, ts: '2026-10-10', date_reliable: true, text_source: 'native', text_reliable: true,
    title: 'Card record', authority: { tier: 'T1', eligible: true }, lineage: { status: 'known', kind: 'source_record' },
    snippet: 'Card ending 4242 charged USD 120.00.' }],
});
