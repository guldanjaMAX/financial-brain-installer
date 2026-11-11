// Independent facts and obligations. This module is never loaded by a replay child.
import { goldFor } from '../fastloop-money/gold.mjs';

const ledger = (id, extra = {}) => ({ ...goldFor(id), judge: 'ledger', ...extra });
const fact = (id, source, text, evidence) => ({ id, source, text, evidence: evidence || text });
const docs = (answerability, facts, extra = {}) => ({ judge: 'evidence', answerability, facts, ...extra });
const rank = () => ledger('M08', { repayment: '40000', gross_ids: [8, 1, 2, 3, 4],
  gross_cents: ['40000', '6000', '5000', '4000', '3000'] });

export const GOLD = {
  Q1: ledger('M01', { answerability: 'answer' }),
  Q2: ledger('M04', { answerability: 'partial' }),
  Q3: ledger('M05', { answerability: 'answer' }),
  Q4: ledger('M17', { answerability: 'answer', total: '6000', ids: [1] }),
  Q5: { ...rank(), answerability: 'answer' },
  Q6: ledger('M09', { answerability: 'answer' }),
  Q7: ledger('M10', { answerability: 'answer' }),
  Q8: ledger('M06', { answerability: 'partial' }),
  Q9: { judge: 'recurring', answerability: 'partial', ids: [19, 20, 21], cents: '1299',
    required_obligations: ['detected-monthly-cadence', 'not-confirmed', 'three-posted-sources'] },
  Q10: docs('answer', [
    fact('meeting', 'gcal:weekly-review', 'review meeting on 2026-10-30 at 14:00', 'The owner has a review meeting on 2026-10-30 at 14:00.'),
    fact('followup', 'zoom:review-followup', 'revised outline by 2026-10-31', 'The owner owes the partner a revised outline by 2026-10-31.')
  ]),
  Q11: docs('answer', [fact('call-detail', 'zoom:invoice-call', 'invoice needs a revised description')]),
  Q12: docs('partial', [
    fact('mail-waiter', 'gmail:reply-request', 'partner is waiting for the outline as of 2026-10-30', 'The partner asked the owner for the outline on 2026-10-30. No later reply is recorded.'),
    fact('call-waiter', 'zoom:reply-call', 'store owner', 'The store owner asked the owner to confirm a review time. No later confirmation is recorded.')
  ]),
  Q13: docs('answer', [
    fact('promise', 'zoom:promise', 'promised an outline on 2026-10-29', 'On 2026-10-29 the owner promised the partner an outline.'),
    fact('completion', 'gmail:completion', 'completed outline was sent on 2026-10-30', 'On 2026-10-30 the owner sent the completed outline to the partner.')
  ]),
  Q14: docs('answer', [fact('policy', 'drive:policy', 'POLICY-17', 'The property insurance policy is document POLICY-17.')]),
  Q15: docs('partial', [fact('last-recorded-call', 'zoom:latest-call', 'latest recorded call with the store owner was on 2026-10-30 about the storefront review')]),
  Q16: ledger('M11/exact', { answerability: 'scoped none' }),
  Q17: ledger('M12', { answerability: 'partial' }),
  Q18: docs('partial', [fact('correct-year', 'drive:recent-decision', '2026-10-30, not 2024', 'The violet protocol was chosen on 2026-10-30.')]),
  Q19: docs('partial', [
    fact('version', 'status:snapshot', 'version is 0.4.22', 'version 0.4.22'),
    fact('mail-freshness', 'status:snapshot', 'gmail synced 2026-10-29', 'gmail synced 2026-10-29'),
    fact('calendar-freshness', 'status:snapshot', 'gcal 2026-10-30', 'gcal synced 2026-10-30'),
    fact('documents-freshness', 'status:snapshot', 'drive 2026-10-28', 'drive synced 2026-10-28'),
    fact('snapshot-limit', 'status:snapshot', 'Current runtime freshness cannot be verified from this snapshot', 'This snapshot cannot verify current runtime freshness.')
  ]),
  D01: ledger('M01/supported', { answerability: 'answer' }),
  D02: ledger('M06/typed', { answerability: 'answer' }),
  D03: ledger('M05/shorthand', { answerability: 'answer' }),
  D04: { ...rank(), answerability: 'answer' },
  D05: ledger('M10/on', { answerability: 'answer' }),
  D06: ledger('M20/incomplete', { answerability: 'honest refusal' }),
  D07: docs('answer', [fact('time', 'gcal:review-time', 'review meeting is on 2026-10-30 at 14:00')]),
  D08: docs('answer', [fact('room', 'gcal:workshop-room', 'workshop is in room Cedar')]),
  D09: docs('answer', [fact('agenda', 'gcal:agenda-owner', 'partner owns the review agenda')]),
  D10: docs('answer', [fact('format', 'gmail:requested-format', 'outline in plain text')]),
  D11: docs('answer', [fact('reply-date', 'gmail:draft-reply', 'replied to the draft request on 2026-10-30')]),
  D12: docs('partial', [fact('open-subject', 'gmail:open-subject', 'storefront review subject needs a reply as of 2026-10-30', 'The open subject is storefront review. No reply is recorded as of 2026-10-30.')]),
  D13: docs('answer', [fact('color', 'drive:protocol-color', 'protocol color is violet')]),
  D14: docs('answer', [fact('permission', 'drive:protocol-permission', 'protocol release is not authorized')]),
  D15: docs('answer', [fact('identifier', 'drive:policy-id', 'policy identifier is POLICY-17')]),
  D16: docs('answer', [fact('custodian', 'drive:checklist-custodian', 'store owner maintains the checklist')]),
  D17: docs('answer', [fact('version', 'status:recorded-version', '2026-10-30 snapshot records version 0.4.22')]),
  D18: docs('answer', [fact('sync-date', 'status:mail-freshness', 'mail last synced on 2026-10-29')]),
  D19: docs('honest refusal', [fact('health-limit', 'status:health-limit', 'cannot certify current runtime health')]),
  D20: docs('answer', [fact('cancelled', 'gcal:workshop-cancellation', 'workshop was cancelled on 2026-10-30')]),
  R01: ledger('M17/outside-only', { answerability: 'answer' }),
  R02: ledger('M05/gross', { answerability: 'answer', ordinary_totals: true, ordinary_excluded: [], ordinary_debits: '101000' }),
  R03: docs('answer', [fact('duration', 'gcal:inspection-duration', 'inspection lasts forty minutes')]),
  R04: docs('answer', [fact('material', 'gcal:session-material', 'bring the site sketch')]),
  R05: docs('answer', [fact('channel', 'gmail:delivery-channel', 'delivery through the portal')]),
  R06: docs('answer', [fact('revision', 'gmail:accepted-revision', 'accepted revision seven')]),
  R07: docs('answer', [fact('panel', 'drive:panel-material', 'panel material is recycled glass')]),
  R08: docs('answer', [fact('retention', 'drive:draft-retention', 'retained for sixty days')]),
  R09: docs('partial', [
    fact('backlog', 'status:index-backlog', 'three pending index operations'),
    fact('limit', 'status:index-backlog', 'Retrieval completion is not certified')
  ]),
  R10: docs('answer', [fact('paused', 'status:paused-source', 'calendar source as paused')]),
};
export function goldForCase(id) {
  const gold = GOLD[id];
  if (!gold || !['answer', 'partial', 'scoped none', 'honest refusal'].includes(gold.answerability)) throw Error('UNBOUND_DAY3_GOLD');
  return structuredClone(gold);
}
