import { money, knowledge, record } from './builders.mjs';

export const DEVELOPMENT = [
  money('D01', 'What are my account balances?', 'NOW'),
  money('D02', 'What is my spending this month?', 'MTD'),
  money('D03', 'Spend this month', 'MTD'),
  money('D04', 'What were my five biggest expenses this month?', 'MTD'),
  money('D05', 'Did the payment from Payer Unit arrive on October 12, 2026?', 'AROUND'),
  money('D06', 'What were my expenses last month?', 'PREV', 'empty-partial'),
  knowledge('D07', 'calendar', 'When is the review meeting?', [
    record('calendar', 'review-time', 'The review meeting is on 2026-10-30 at 14:00.')
  ], 'The review meeting is on 2026-10-30 at 14:00 [1].'),
  knowledge('D08', 'calendar', 'Where is the workshop?', [
    record('calendar', 'workshop-room', 'The workshop is in room Cedar.')
  ], 'The workshop is in room Cedar [1].'),
  knowledge('D09', 'calendar', 'Who owns the review agenda?', [
    record('calendar', 'agenda-owner', 'The partner owns the review agenda.')
  ], 'The partner owns the review agenda [1].'),
  knowledge('D10', 'messages', 'What did the partner request in the message?', [
    record('mail', 'requested-format', 'The partner requested the outline in plain text.')
  ], 'The partner requested the outline in plain text [1].'),
  knowledge('D11', 'messages', 'Did the owner reply to the draft request?', [
    record('mail', 'draft-reply', 'The owner replied to the draft request on 2026-10-30.')
  ], 'The owner replied to the draft request on 2026-10-30 [1].'),
  knowledge('D12', 'messages', 'What subject needs a reply?', [
    record('mail', 'open-subject', 'The open subject is storefront review. No reply is recorded as of 2026-10-30.')
  ], 'The storefront review subject needs a reply as of 2026-10-30 [1].'),
  knowledge('D13', 'documents', 'Which color is the protocol?', [
    record('documents', 'protocol-color', 'The protocol color is violet.')
  ], 'The protocol color is violet [1].'),
  knowledge('D14', 'documents', 'Is the protocol release authorized?', [
    record('documents', 'protocol-permission', 'The protocol release is not authorized.')
  ], 'The protocol release is not authorized [1].'),
  knowledge('D15', 'documents', 'Which policy identifier is recorded?', [
    record('documents', 'policy-id', 'The recorded policy identifier is POLICY-17.')
  ], 'The recorded policy identifier is POLICY-17 [1].'),
  knowledge('D16', 'documents', 'Who maintains the checklist?', [
    record('documents', 'checklist-custodian', 'The store owner maintains the checklist.')
  ], 'The store owner maintains the checklist [1].'),
  knowledge('D17', 'status', 'Which version does the status snapshot record?', [
    record('status', 'recorded-version', 'The 2026-10-30 snapshot records version 0.4.22.')
  ], 'The 2026-10-30 snapshot records version 0.4.22 [1].'),
  knowledge('D18', 'status', 'When was mail last synced in the snapshot?', [
    record('status', 'mail-freshness', 'The snapshot records mail last synced on 2026-10-29.')
  ], 'The snapshot records mail last synced on 2026-10-29 [1].'),
  knowledge('D19', 'status', 'Can this snapshot certify current runtime health?', [
    record('status', 'health-limit', 'This historical snapshot cannot certify current runtime health.')
  ], 'This historical snapshot cannot certify current runtime health [1].'),
  knowledge('D20', 'calendar', 'Is the workshop cancelled?', [
    record('calendar', 'workshop-cancellation', 'The workshop was cancelled on 2026-10-30.')
  ], 'The workshop was cancelled on 2026-10-30 [1].'),
];
