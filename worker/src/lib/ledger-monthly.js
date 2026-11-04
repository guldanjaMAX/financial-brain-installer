import { moneyAccount } from './money-format.js';
import { plainRouterLimitation } from './ledger-wording.js';
import { ledgerDay } from './ledger-question.js';
import { effectivePeriodCovered } from './ledger-reader.js';

const money = cents => `${cents < 0 ? '-' : ''}$${Math.floor(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const monthNames = 'January February March April May June July August September October November December'.split(' ');

// Each month uses the existing reader and its expense/ownership rules. A
// whole-period coverage hole must not erase other independently covered months.
export async function monthlyLedgerAnswer(intent, accounts, readMonth) {
  const months = [], citations = [];
  for (let day = `${intent.from.slice(0, 7)}-01`; day <= intent.to;) {
    const year = Number(day.slice(0, 4)), month = Number(day.slice(5, 7));
    const end = ledgerDay(Date.UTC(year, month, 0));
    const from = day < intent.from ? intent.from : day, to = end > intent.to ? intent.to : end;
    const label = `${monthNames[month - 1]} ${year}`;
    const covered = accounts.every(account => effectivePeriodCovered(account, from, to));
    const fullMonth = from === day && to === end && covered;
    const part = covered ? await readMonth({ ...intent, from, to, monthlyBreakdown: false }) : null;
    const ledger = part?.ledger;
    const complete = Boolean(ledger && ledger.complete !== false && ledger.coverage?.complete !== false &&
      !ledger.classification_uncertain && !ledger.attribution_incomplete && !ledger.selector_unresolved);
    const both = intent.kind === 'totals' && !intent.inflowOnly;
    const total = !complete || both ? null : intent.kind === 'totals' ? ledger.combined_inflow_minor
      : intent.kind === 'expense_summary' ? ledger.expense_total_minor : ledger.lead_total_minor ?? ledger.total_minor;
    const measures = complete && both ? {
      inflow_minor: ledger.lead_accounts.reduce((sum, account) => sum + account.credits_minor, 0),
      outflow_minor: ledger.lead_accounts.reduce((sum, account) => sum + account.debits_minor, 0),
    } : null;
    const values = measures ? Object.values(measures) : [total];
    const available = values.every(Number.isSafeInteger) && (fullMonth || values.every(value => value !== 0));
    const refs = available ? part.citations.map(ref => ({ ...ref, n: citations.length + ref.n })) : [];
    citations.push(...refs);
    months.push({ month: day.slice(0, 7), label, from, to, complete: available,
      total_minor: available ? total : null, ...(available && measures ? measures : {}),
      citations: refs.map(ref => ref.n),
      // An absent literal payee may become zero only if another month proves
      // that exact payee and this entire month is covered, with no candidates.
      emptyVendor: Boolean(fullMonth && intent.kind === 'merchant' && ledger?.match_basis === 'none' &&
        ledger.excluded_own_movement_count === 0),
      exactVendor: Boolean(ledger?.match_basis === 'exact') });
    day = ledgerDay(Date.UTC(year, month, 1));
  }
  const knownVendor = months.some(month => month.exactVendor);
  const rows = months.map(({ emptyVendor, exactVendor, ...month }) =>
    emptyVendor && knownVendor ? { ...month, total_minor: 0, complete: true } : month);
  const complete = rows.every(month => month.complete);
  const scopedAccounts = accounts.map(account => ({ account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
    covered_from: account.covered_from || null, covered_to: account.covered_to || null }));
  return { answer: `By calendar month (${intent.presentation.period(intent.from, intent.to)}; partial calendar months use only the labeled dates):\n` +
    rows.map(month => !month.complete ? `${month.label}: ${plainRouterLimitation('reading_unavailable')}`
      : `${month.label}: ${month.inflow_minor !== undefined
        ? `money in ${money(month.inflow_minor)}; money out ${money(month.outflow_minor)}` : money(month.total_minor)}${month.citations.length ? ` ${month.citations.map(n => `[${n}]`).join(' ')}` : ''}.`).join('\n') +
    `\nAccounts: ${scopedAccounts.map(account => moneyAccount({ mask: account.account_mask })).join('; ')}.` +
    (intent.kind === 'totals' ? '\nRecorded money in is not established income; money out is not accounting profit or cash flow.' : ''),
    citations, ledger: { kind: intent.kind, from: intent.from, to: intent.to, months: rows, complete,
      accounts: scopedAccounts, coverage: { complete }, ...(complete ? {} : { partial_reason: 'ledger_partial_coverage' }) } };
}
