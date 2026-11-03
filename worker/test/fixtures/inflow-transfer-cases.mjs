import { cases as priorCases } from './fastloop-batch2-cases.mjs';
import { evidence } from '../../../test/fixtures/fastloop-money/input.mjs';

// Development-only synthetic envelopes. Expected membership lives separately.
export const cases = [
  'clean', 'ambiguous-out', 'ambiguous-in', 'cent', 'outside-window',
  'edge-before', 'edge-after', 'boundary-before', 'boundary-after',
  'boundary-competition', 'uncovered', 'duplicate-mask', 'unknown-kind',
  'refund', 'unmatched-credit', 'same-account', 'two-pairs', 'scoped',
  'bare-equal', 'one-direction', 'external-payee', 'pending-out', 'investment', 'generic-payees',
].map(id => ({ ...priorCases.find(c => c.id === 'D9/combined'), id: `INFLOW/${id}`,
  family: 'INFLOW', question: ['uncovered', 'scoped'].includes(id)
    ? 'How much came in September 2026 for account 5353?'
    : 'How much came in September 2026?' }));

export function snapshotFor(c) {
  const s = evidence('typed');
  const row = (id, account, date, direction, cents, description, payee = null) => ({
    id, uid: `inflow-${id}`, account, date, direction, cents: String(cents), description, payee, pending: 0,
  });
  s.rows = [
    row(101, 'cash', '2026-09-12', 'outflow', 12500, 'Transfer to savings 5353'),
    row(102, 'reserve', '2026-09-13', 'inflow', 12500, 'Transfer from checking 3131'),
    row(103, 'cash', '2026-09-14', 'inflow', 24681, 'Outside receipt', 'Outside Payer'),
  ];
  const [out, incoming] = s.rows;
  switch (c.id.split('/')[1]) {
    case 'ambiguous-out': s.rows.push({ ...out, id: 104, uid: 'extra-out' }); break;
    case 'ambiguous-in': s.rows.push({ ...incoming, id: 104, uid: 'extra-in' }); break;
    case 'cent': out.cents = '12501'; break;
    case 'outside-window': out.date = '2026-09-09'; break;
    case 'edge-before': out.date = '2026-09-10'; break;
    case 'edge-after': out.date = '2026-09-16'; break;
    case 'boundary-before': out.date = '2026-08-29'; incoming.date = '2026-09-01'; break;
    case 'boundary-after': out.date = '2026-10-03'; incoming.date = '2026-09-30'; break;
    case 'boundary-competition':
      out.date = '2026-08-29'; incoming.date = '2026-09-01';
      s.rows.push({ ...incoming, id: 104, uid: 'padding-competitor', date: '2026-08-26' }); break;
    case 'uncovered': s.accounts[0].coverage = 'partial'; break;
    case 'duplicate-mask': s.accounts[2].mask = '5353'; break;
    case 'unknown-kind': s.accounts[1].kind = 'other'; s.accounts[1].role = 'neither'; break;
    case 'refund': incoming.description = 'Refund from checking 3131'; incoming.payee = 'Store Unit'; break;
    case 'unmatched-credit': s.rows.shift(); break;
    case 'same-account': incoming.account = 'cash'; break;
    case 'two-pairs':
      s.rows.push(row(201, 'cash', '2026-09-20', 'outflow', 8000, 'Transfer to savings 5353'),
        row(202, 'reserve', '2026-09-21', 'inflow', 8000, 'Transfer from checking 3131')); break;
    case 'bare-equal': out.description = incoming.description = 'Transfer'; break;
    case 'one-direction': incoming.description = 'Unclassified credit'; break;
    case 'external-payee': incoming.payee = 'Outside Payer'; break;
    case 'pending-out': out.pending = 1; break;
    case 'investment':
      s.accounts[0].kind = 'investment'; s.accounts[0].role = 'neither';
      incoming.description = 'Transfer from investment 3131'; break;
    case 'generic-payees': out.payee = 'Online transfer'; incoming.payee = 'Transfer'; break;
  }
  return s;
}
