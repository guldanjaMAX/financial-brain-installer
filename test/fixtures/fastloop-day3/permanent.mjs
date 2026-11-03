import { money, knowledge, record } from './builders.mjs';

const lastMonth = money('Q5', 'What were my 5 biggest expenses last month?', 'PREV');
lastMonth.snapshot.rows = lastMonth.snapshot.rows.map(r => ({ ...r,
  date: r.date.startsWith('2026-10') ? r.date.replace('2026-10', '2026-09').replace('-31', '-30') : r.date }));
const monthly = money('Q9', 'What do I pay for every month?', 'NONE');
monthly.snapshot.rows.push(...['2026-08-15', '2026-09-15', '2026-10-15'].map((date, i) => ({
  id: 19 + i, uid: `synthetic-monthly-${i}`, account: 'cash', date, cents: '1299',
  direction: 'outflow', payee: 'Monthly Service', description: 'Monthly Service', pending: 0,
})));

export const PERMANENT = [
  money('Q1', 'How much do I have in the bank right now?', 'NOW'),
  money('Q2', 'How much came in last month?', 'PREV'),
  money('Q3', 'What did I spend this month, and on what?', 'MTD'),
  money('Q4', 'How much did I spend at Store One in the last 3 months?', 'THREE'),
  lastMonth,
  money('Q6', 'Show me my last 10 transactions.', 'RECENT'),
  money('Q7', 'Did a payment of $177.77 come in around October 12, 2026?', 'AROUND'),
  money('Q8', 'What are my expenses?', 'NONE', 'other'),
  monthly,
  knowledge('Q10', 'calendar', 'What meetings do I have this week, and what follow-ups do I owe?', [
    record('calendar', 'weekly-review', 'The owner has a review meeting on 2026-10-30 at 14:00.'),
    record('calls', 'review-followup', 'The owner owes the partner a revised outline by 2026-10-31.')
  ], 'The owner has a review meeting on 2026-10-30 at 14:00 [1].'),
  knowledge('Q11', 'calls', 'What did the partner say about the invoice on our last call?', [
    record('calls', 'invoice-call', 'On 2026-10-30 the partner said the invoice needs a revised description.')
  ], 'On 2026-10-30 the partner said the invoice needs a revised description [1].'),
  knowledge('Q12', 'messages', "Who's waiting on a reply from me?", [
    record('mail', 'reply-request', 'The partner asked the owner for the outline on 2026-10-30. No later reply is recorded.'),
    record('calls', 'reply-call', 'The store owner asked the owner to confirm a review time. No later confirmation is recorded.')
  ], 'The partner is waiting for the outline as of 2026-10-30 [1].'),
  knowledge('Q13', 'calls', 'What did I promise the partner, and is it done?', [
    record('calls', 'promise', 'On 2026-10-29 the owner promised the partner an outline.'),
    record('mail', 'completion', 'On 2026-10-30 the owner sent the completed outline to the partner.')
  ], 'The owner promised an outline on 2026-10-29 [1]. The completed outline was sent on 2026-10-30 [2].'),
  knowledge('Q14', 'documents', 'Find the property insurance policy the broker sent me.', [
    record('documents', 'policy', 'The property insurance policy is document POLICY-17. The broker sent it on 2026-10-30.')
  ], 'The property insurance policy is document POLICY-17, sent by the broker on 2026-10-30 [1].'),
  knowledge('Q15', 'calls', 'When did I last talk to the store owner, and about what?', [
    record('calls', 'latest-call', 'The latest recorded call with the store owner was on 2026-10-30 about the storefront review.')
  ], 'The latest recorded call with the store owner was on 2026-10-30 about the storefront review [1].'),
  money('Q16', 'How much did I spend at Absent Store last month?', 'PREV'),
  money('Q17', 'What will my bank balance be next month?', 'FUTURE'),
  knowledge('Q18', 'documents', 'What did we decide in 2024 about the violet protocol?', [
    record('documents', 'recent-decision', 'The violet protocol was chosen on 2026-10-30. No decision from 2024 is in this record.')
  ], 'This record dates the violet protocol decision to 2026-10-30, not 2024 [1].'),
  knowledge('Q19', 'status', 'Is my Brain up to date?', [
    record('status', 'snapshot', 'Status snapshot at 2026-10-30T00:00:00Z: version 0.4.22; gmail synced 2026-10-29; gcal synced 2026-10-30; drive synced 2026-10-28. This snapshot cannot verify current runtime freshness.')
  ], 'As of the 2026-10-30 snapshot, version is 0.4.22; gmail synced 2026-10-29, gcal 2026-10-30, and drive 2026-10-28. Current runtime freshness cannot be verified from this snapshot [1].'),
];
