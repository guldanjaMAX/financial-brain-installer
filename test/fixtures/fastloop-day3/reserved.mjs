// Separate fact families, frozen before comparison. No tuning consumes this set.
import { money, knowledge, record } from './builders.mjs';

export const RESERVED = [
  money('R01', 'How much did I pay to Outside Lender this month?', 'MTD', 'outside-only'),
  money('R02', 'How much money came in and went out this month?', 'MTD'),
  knowledge('R03', 'calendar', 'How long is the inspection?', [
    record('calendar', 'inspection-duration', 'The inspection lasts forty minutes.')
  ], 'The inspection lasts forty minutes [1].'),
  knowledge('R04', 'calendar', 'What should the owner bring to the session?', [
    record('calendar', 'session-material', 'The owner should bring the site sketch to the session.')
  ], 'The owner should bring the site sketch to the session [1].'),
  knowledge('R05', 'messages', 'What delivery channel did the store owner request?', [
    record('mail', 'delivery-channel', 'The store owner requested delivery through the portal.')
  ], 'The store owner requested delivery through the portal [1].'),
  knowledge('R06', 'messages', 'Which revision did the partner accept?', [
    record('mail', 'accepted-revision', 'The partner accepted revision seven.')
  ], 'The partner accepted revision seven [1].'),
  knowledge('R07', 'documents', 'Which material is specified for the panel?', [
    record('documents', 'panel-material', 'The panel material is recycled glass.')
  ], 'The panel material is recycled glass [1].'),
  knowledge('R08', 'documents', 'What is the retention rule for draft notes?', [
    record('documents', 'draft-retention', 'Draft notes are retained for sixty days.')
  ], 'Draft notes are retained for sixty days [1].'),
  knowledge('R09', 'status', 'What does the snapshot say about index work?', [
    record('status', 'index-backlog', 'The 2026-10-30 snapshot records three pending index operations. Retrieval completion is not certified.')
  ], 'The 2026-10-30 snapshot records three pending index operations. Retrieval completion is not certified [1].'),
  knowledge('R10', 'status', 'Which source was paused in the snapshot?', [
    record('status', 'paused-source', 'The 2026-10-30 snapshot records the calendar source as paused.')
  ], 'The 2026-10-30 snapshot records the calendar source as paused [1].'),
];
