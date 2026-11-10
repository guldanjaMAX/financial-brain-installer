import { moneyAccount } from './money-format.js';
import { paymentExclusionLines, plainRouterLimitation } from './ledger-wording.js';
import { ledgerDay } from './ledger-question.js';
import { partialPeriodScopeLine, periodAccountScope } from './ledger-period-scope.js';

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
    const scope = periodAccountScope(accounts, { from, to });
    const covered = scope.coverage.complete;
    const fullMonth = from === day && to === end && scope.available;
    // Each month delegates the same subset policy to the ordinary reader.
    // Keep read failures local so another month's evidence remains usable.
    let part;
    try { part = scope.available ? await readMonth({ ...intent, from, to, monthlyBreakdown: false, paymentCitationDetails: true, refundPeriodLabel: label }) : null; }
    catch { part = { reason: 'ledger_unavailable' }; }
    const ledger = part?.ledger;
    const readable = Boolean(ledger && (ledger.complete !== false || ledger.partial_reason === 'ledger_partial_coverage') &&
      !ledger.classification_uncertain && !ledger.attribution_incomplete && !ledger.selector_unresolved);
    // Coverage cannot certify all payer income. A proven matched receipt is
    // still useful, with its own citations and an explicit subtotal label.
    const attributedSubtotal = intent.kind === 'merchant' && intent.direction === 'inflow' && intent.match &&
      ledger?.attribution_incomplete && !ledger.classification_uncertain && !ledger.selector_unresolved &&
      ledger.amount_citations?.length && Number.isSafeInteger(ledger.lead_attributed_subtotal_minor)
      ? ledger.lead_attributed_subtotal_minor : null;
    const both = intent.kind === 'totals' && !intent.inflowOnly;
    const total = !readable || both ? null : intent.kind === 'totals' ? ledger.combined_inflow_minor ?? ledger.covered_inflow_subtotal_minor
      : intent.kind === 'expense_summary' ? ledger.expense_total_minor : ledger.lead_total_minor ?? ledger.total_minor;
    // A refused month (e.g. money out withheld) states no per-account figures,
    // even when its coverage label is partial.
    const measures = readable && both && Array.isArray(ledger.lead_accounts) ? {
      inflow_minor: ledger.lead_accounts.reduce((sum, account) => sum + account.credits_minor, 0),
      outflow_minor: ledger.lead_accounts.reduce((sum, account) => sum + account.debits_minor, 0),
    } : null;
    const values = measures ? Object.values(measures) : [total];
    // Coverage certifies the requested dates, including a partial calendar
    // month. Calendar boundaries cannot turn an observed zero into a gap.
    const available = scope.available && values.every(Number.isSafeInteger);
    const citationOffset = citations.reduce((max, ref) => Math.max(max, ref.n), 0);
    const childPayments = ledger?.payment_exclusions;
    const childNotPayments = ledger?.not_payments;
    const notPaymentNumbers = new Set((childNotPayments?.rows || []).map(row => row.n));
    // Money out may count a disclosed posting (included_in_total); spending
    // never does. Only an included posting can be an amount operand. An
    // owner-category conflict line is evidence, never a separate operand.
    const possibleRepayments = [...(ledger?.possible_payments || []), ...(ledger?.possible_transfers || [])];
    const movementConflicts = ledger?.own_movement_conflicts || [];
    const possibleRepaymentNumbers = new Set([...possibleRepayments, ...movementConflicts].map(row => row.n));
    const uncountedRepaymentNumbers = new Set([...possibleRepayments.filter(row => !row.included_in_total), ...movementConflicts].map(row => row.n));
    const identities = ledger?.possible_identity_members || [];
    const identityNumbers = new Set(identities.flatMap(member => member.citations || []));
    const possibleAttribution = /possible/.test(ledger?.match_basis || '') ||
      (childPayments?.rows || []).some(row => row.match_basis === 'possible');
    const paymentNumbers = new Set((childPayments?.rows || []).map(row => row.n));
    const possibleNumbers = ledger?.possible_citations && new Set(ledger.possible_citations);
    const possibleRefs = possibleAttribution ? (part.citations || []).filter(ref =>
      possibleNumbers ? possibleNumbers.has(ref.n) : !paymentNumbers.has(ref.n)) : [];
    const refs = available || attributedSubtotal !== null || childPayments || childNotPayments || possibleAttribution || identityNumbers.size || ledger?.refund_disclosure || possibleRepaymentNumbers.size
      ? part.citations.filter(ref => available || childPayments || childNotPayments || possibleAttribution || identityNumbers.has(ref.n) || possibleRepaymentNumbers.has(ref.n) || ledger.amount_citations?.includes(ref.n) || ledger?.refund_disclosure)
        .map(ref => ({ ...ref, n: citationOffset + ref.n })) : [];
    // Unavailable named totals still retain qualified posting membership. The
    // parent guard checks each reference against its captured selector evidence.
    const attribution = possibleAttribution ? {
      match_basis: /possible/.test(ledger.match_basis || '') ? ledger.match_basis
        : ledger.match_basis === 'exact' ? 'exact_and_possible' : 'possible',
      possible_citations: possibleRefs.map(ref => citationOffset + ref.n),
      ...(Number.isSafeInteger(ledger.possible_subtotal_minor) ? { possible_subtotal_minor: ledger.possible_subtotal_minor } : {}),
    } : {};
    // Child payment references use local citation numbers. Preserve their
    // amounts and kinds while rebasing each posting into the composed answer.
    const paymentExclusions = childPayments ? {
      ...childPayments,
      rows: childPayments.rows.map(row => ({ ...row, n: citationOffset + row.n })),
    } : null;
    // Unavailable payer attribution cannot erase independently proved
    // excluded credits. These amounts remain separate from payer operands.
    const notPayments = childNotPayments ? {
      ...childNotPayments,
      rows: childNotPayments.rows.map(row => ({ ...row, n: citationOffset + row.n })),
    } : null;
    // Receipts and refunds are separate from spending and from each other.
    // Keep the child's exact membership while rebasing its local references.
    const receipts = available && Number.isSafeInteger(ledger?.inflows_received_minor) ? {
      inflows_received_minor: ledger.inflows_received_minor,
      refunds_received_minor: ledger.refunds_received_minor,
      inflow_rows: (ledger.inflow_rows || []).map(row => ({ ...row, n: citationOffset + row.n })),
      refund_rows: (ledger.refund_rows || []).map(row => ({ ...row, n: citationOffset + row.n })),
    } : null;
    // The month pool retains all evidence, but each amount uses only the
    // postings selected for that measure, never an excluded payment appendix.
    const rebase = numbers => (numbers || []).map(n => citationOffset + n);
    // Identity review citations remain evidence for bank text, never an
    // operand of a monthly amount. Keep their local membership when rebasing.
    const identityMembers = identities.map(member => ({ ...member, citations: rebase(member.citations) }));
    const receiptNumbers = new Set([...(ledger?.inflow_rows || []), ...(ledger?.refund_rows || [])].map(row => row.n));
    const amountCitations = rebase((ledger?.amount_citations ?? (part?.citations || [])
      .filter(ref => !paymentNumbers.has(ref.n) && !receiptNumbers.has(ref.n)).map(ref => ref.n))
      .filter(n => !identityNumbers.has(n) && !uncountedRepaymentNumbers.has(n) && !notPaymentNumbers.has(n)));
    const refundCitations = (receipts?.refund_rows || []).map(row => row.n);
    const otherReceiptCitations = (receipts?.inflow_rows || []).filter(row => !refundCitations.includes(row.n)).map(row => row.n);
    citations.push(...refs);
    const reason = available ? null : !scope.available ? 'period_outside_coverage'
      : part?.reason || ledger?.reason || (ledger?.match_basis === 'none' ? 'merchant_no_exact_match'
        : ledger?.match_basis === 'possible' ? 'merchant_possible_matches' : 'reading_unavailable');
    months.push({ month: day.slice(0, 7), label, from, to, complete: available && covered, available,
      total_minor: available && covered ? total : null, subtotal_minor: available && !covered ? total : null,
      ...(available && measures ? covered ? measures : {
        inflow_subtotal_minor: measures.inflow_minor, outflow_subtotal_minor: measures.outflow_minor,
      } : {}), reason, coverage: scope.coverage,
      ...(covered ? {} : { scope_detail: partialPeriodScopeLine(scope, { ...intent, from, to }) }),
      citations: refs.map(ref => ref.n),
      ...(ledger?.refund_disclosure ? { refund_disclosure: ledger.refund_disclosure,
        possible_refunds: (ledger.possible_refunds || []).map(candidate => ({ ...candidate,
          n: candidate.n + citations.length - refs.length })) } : {}),
      ...(possibleRepayments.length ? { possible_payments: possibleRepayments.map(row => ({ ...row, n: citationOffset + row.n })) } : {}),
      ...(movementConflicts.length ? { own_movement_conflicts: movementConflicts.map(row => ({ ...row, n: citationOffset + row.n })) } : {}),
      amount_citations: amountCitations,
      ...(identityMembers.length ? { possible_identity_members: identityMembers } : {}),
      payment_citations: rebase((childPayments?.rows || []).map(row => row.n)),
      refund_citations: refundCitations, other_receipt_citations: otherReceiptCitations,
      ...(measures ? { inflow_citations: rebase(ledger.inflow_citations), outflow_citations: rebase(ledger.outflow_citations) } : {}),
      ...attribution,
      ...(attributedSubtotal !== null ? { attributed_subtotal_minor: attributedSubtotal, attribution_incomplete: true } : {}),
      ...(paymentExclusions ? { payment_exclusions: paymentExclusions } : {}),
      ...(notPayments ? { not_payments: notPayments } : {}),
      ...(receipts || {}),
      // An absent literal payee may become zero only if another month proves
      // that exact payee and this entire month is covered, with no candidates.
      emptyVendor: Boolean(fullMonth && intent.kind === 'merchant' && ledger?.match_basis === 'none' && !possibleAttribution && !ledger.possible_match_count && !identityMembers.length &&
        ledger.excluded_own_movement_count === 0),
      exactVendor: Boolean(ledger?.match_basis === 'exact') });
    day = ledgerDay(Date.UTC(year, month, 1));
  }
  const knownVendor = months.some(month => month.exactVendor);
  const rows = months.map(({ emptyVendor, exactVendor, ...month }) =>
    emptyVendor && knownVendor ? { ...month, total_minor: month.coverage.complete ? 0 : null,
      subtotal_minor: month.coverage.complete ? null : 0, complete: month.coverage.complete, available: true, reason: null } : month);
  const complete = rows.every(month => month.complete);
  const possibleIdentities = rows.flatMap(month => month.possible_identity_members || []);
  const scopedAccounts = accounts.map(account => ({ account_mask: /^\d{1,4}$/.test(account.mask || '') ? account.mask : null,
    covered_from: account.covered_from || null, covered_to: account.covered_to || null }));
  return { answer: `By calendar month (${intent.presentation.period(intent.from, intent.to)}; partial calendar months use only the labeled dates):\n` +
    rows.map(month => {
      const reasons = {
        period_outside_coverage: 'No account has bank history covering every requested date.',
        merchant_no_exact_match: 'No exact payee match; no store total is confirmed.',
        merchant_possible_matches: 'Possible payee mentions only; no store total is confirmed.',
        ledger_unavailable: 'The bank data could not be read.',
        payment_membership_unconfirmed: 'A possible card or loan payment has no confirmed payment code or owned-account endpoint; confirm its classification before using this month.',
        payment_expense_category_conflict: 'Spending is withheld because bank payment text conflicts with a confirmed category; review its classification.',
        loan_payment_mixed_components: 'Spending is withheld because a loan payment mixes repayment and charges; no components have been split.',
        owned_movement_unconfirmed: 'A possible own-account movement or card payment has unconfirmed ownership or payment role; this month is withheld.',
        own_movement_mixed_components: 'Spending is withheld because a possible transfer to your own account also names a fee, charge or second amount; no components have been split.',
        own_movement_category_conflict: month.own_movement_conflicts?.some(row => row.identity_unconfirmed)
          ? 'An outflow you confirmed as an expense also names a transfer with an unconfirmed destination; this month is not certified.'
          : 'An outflow you confirmed as an expense also names a possible transfer to your own account; this month is not certified.',
        own_movement_identity_unconfirmed: 'A transfer destination could name an outside party or your own account; spending for this month is withheld.',
        money_out_destination_unconfirmed: 'A possible payment or transfer could have gone to one of your own connected accounts; money out for this month is withheld.',
      };
      const refsFor = numbers => numbers.length ? ` ${numbers.map(n => `[${n}]`).join(' ')}` : '';
      const figures = month.inflow_minor !== undefined ? `money in ${money(month.inflow_minor)}${refsFor(month.inflow_citations)}; money out ${money(month.outflow_minor)}${refsFor(month.outflow_citations)}`
        : month.inflow_subtotal_minor !== undefined ? `money in ${money(month.inflow_subtotal_minor)}${refsFor(month.inflow_citations)}; money out ${money(month.outflow_subtotal_minor)}${refsFor(month.outflow_citations)}`
          : `${money(month.complete ? month.total_minor : month.subtotal_minor)}${refsFor(month.amount_citations)}`;
      const identityLine = month.possible_identity_members?.length
        ? '\nPossible vendor matches, not included in the confirmed total: ' + month.possible_identity_members
          .map(member => `"${member.payee}" ${member.citations.map(n => `[${n}]`).join(' ')}`).join('; ') + '.' : '';
      const payments = month.payment_exclusions;
      const notPayments = month.not_payments;
      const notPaymentLine = notPayments ? '\nNot counted as payments to you: ' + money(notPayments.total_minor) + ' (' +
        notPayments.rows.map(row => `${row.reason} ${money(row.amount_minor)} [${row.n}]`).join('; ') + ').' : '';
      const refunds = month.refunds_received_minor;
      const otherReceipts = (month.inflows_received_minor || 0) - (refunds || 0);
      const receiptLine = (refunds > 0 ? ` Refunds received: ${money(refunds)} ${month.refund_citations.map(n => `[${n}]`).join(' ')}.` : '') +
        (otherReceipts > 0 ? ` Other money received: ${money(otherReceipts)} ${month.other_receipt_citations.map(n => `[${n}]`).join(' ')}.` : '');
      const possiblePayments = payments?.rows.filter(row => row.match_basis === 'possible') || [];
      const paymentLines = payments ? paymentExclusionLines(payments, intent.presentation).split('\n') : [];
      const paymentLine = payments ? ` ${paymentLines[0]}` +
        (possiblePayments.length ? ` Includes ${money(possiblePayments.reduce((sum, row) => sum + row.amount_minor, 0))} in possible vendor-description matches ${possiblePayments.map(row => `[${row.n}]`).join(' ')}; payee attribution remains unconfirmed.` : '') +
        `\n${paymentLines.slice(1).join('\n')}` : '';
      return `${month.label}: ${month.available
        ? `${month.complete ? '' : 'Covered-account subtotal: '}${figures}.`
        : Number.isSafeInteger(month.attributed_subtotal_minor)
          ? `At least ${money(month.attributed_subtotal_minor)}${refsFor(month.amount_citations)} (matched subtotal); full payer income remains unconfirmed.`
          : `${plainRouterLimitation('reading_unavailable')} ${reasons[month.reason] || ''}`}${notPaymentLine}${receiptLine}${paymentLine}${identityLine}${month.possible_payments?.length ? '\n' + month.possible_payments.map(row => `${row.label || `possible ${row.destination ? `transfer to your own ${row.destination}` : `${row.payment_kind} payment`}, not counted as spending`}: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, bank text quoted: "${row.bank_text}" [${row.n}].`).join('\n') : ''}${month.own_movement_conflicts?.length ? '\n' + month.own_movement_conflicts.map(row => `confirmed as ${row.category} but the bank text names ${row.identity_unconfirmed ? 'a transfer with an unconfirmed destination' : `a possible transfer to your own ${row.destination}`}: ${money(row.amount_minor)} on ${intent.presentation.date(row.posted_on)}, bank text quoted: "${row.bank_text}" [${row.n}].`).join('\n') : ''}${month.scope_detail ? `\n${month.scope_detail}` : ''}`;
    }).map((line, index) => line + (rows[index].possible_refunds?.length ? '\n' + rows[index].possible_refunds.map(candidate =>
      `possible refund, not subtracted: ${money(candidate.amount_minor)} on ${intent.presentation.date(candidate.posted_on)}, ${moneyAccount({ mask: candidate.account_mask })}, "${candidate.bank_text}" [${candidate.n}]`).join('\n') : '')).join('\n') +
    `\nAccounts: ${scopedAccounts.map(account => moneyAccount({ mask: account.account_mask })).join('; ')}.` +
    (intent.kind === 'totals' ? '\nRecorded money in is not established income; money out is not accounting profit or cash flow.' : ''),
    citations, ledger: { kind: intent.kind, from: intent.from, to: intent.to, months: rows, complete, available: rows.some(month => month.available),
      ...(possibleIdentities.length ? { possible_identity_members: possibleIdentities, possible_identity_count: possibleIdentities.length } : {}),
      accounts: scopedAccounts, coverage: { complete }, ...(complete ? {} : { partial_reason: 'ledger_partial_coverage' }) } };
}
