import { goldFor, GOLD_VERSION } from '../../test/fixtures/fastloop-money/gold.mjs';
import { evidence } from '../../test/fixtures/fastloop-money/input.mjs';
import { displayFigures, formatMinor, same, total, ORACLE_VERSION } from './money-oracle.mjs';
import { sha } from './money-replay.mjs';
import { readFileSync } from 'node:fs';

export const SCORING_IDENTITY = sha(['./money-score.mjs', './money-oracle.mjs',
  '../../test/fixtures/fastloop-money/gold.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')));

export const VERDICTS = ['correct', 'partly', 'wrong figure', 'missing source', 'honest refusal', 'over-refusal'];
const rowId = citation => Number(/^ledger:transaction:(\d+)$/.exec(citation?.ref || '')?.[1]);
export function scoreObservation(observation, input, gold = goldFor(input.id)) {
  const result = { id: input.id, base: input.base, execution_status: observation?.execution_status || 'missing',
    verdict: null, safety_failures: [], reasons: [], checks: [], figure_results: [], figure_checks: 0, source_checks: 0,
    required_obligations: [...gold.required_obligations],
    required_facts_met: 0, required_facts_total: gold.required_obligations.length, utility: 0, document_answer_tested: false };
  if (result.execution_status !== 'complete') return result;
  const body = observation.body, ledger = body?.ledger, answer = body?.answer || '';
  const snapshot = evidence(input.profile), rows = new Map(snapshot.rows.map(r => [r.id, r]));
  const check = (id, ok, failure = 'missing_fact') => {
    result.checks.push({ id, ok: Boolean(ok), failure: ok ? null : failure });
    if (!ok) result.reasons.push(id);
    if (!ok && ['wrong_figure', 'unsupported_claim', 'scope', 'ownership'].includes(failure)) result.safety_failures.push(`${failure}:${id}`);
  };
  const finish = () => {
    result.required_facts_total = gold.required_obligations.length;
    result.required_facts_met = gold.required_obligations.filter(id => result.checks.some(c => c.id === id && c.ok)).length;
    result.utility = result.required_facts_met / result.required_facts_total;
    return result;
  };
  const figure = (id, actual, expected) => {
    result.figure_checks++;
    result.figure_results.push({ id, actual: String(actual), expected: String(expected), ok: String(actual) === String(expected) });
    check(id, String(actual) === String(expected), 'wrong_figure');
  };
  if (!observation.trace?.parsed_intents?.length || observation.trace.fixture_accounts < 1) {
    result.execution_status = 'invalid_witness'; return result;
  }
  const shown = displayFigures(answer);
  const citations = body.citations || [];
  const unresolvedRefs = [...answer.matchAll(/\[(\d+)\]/g)].filter(m => !citations.some(c => c.n === Number(m[1])));
  if (unresolvedRefs.length) check('all-displayed-references-resolve', false, 'missing_source');
  check('no-invented-pending-zero', !/\b(?:no|zero) pending|pending (?:charges|activity)(?: are| is|:)? (?:zero|0|none)/i.test(answer), 'unsupported_claim');
  check('no-invented-payment-split', !/\bprincipal\b|interest (?:portion|amount|split)/i.test(answer), 'unsupported_claim');
  for (const citation of citations) {
    result.source_checks++;
    const account = snapshot.accounts.find(a => a.mask === citation.account_mask);
    const row = rows.get(rowId(citation));
    const balance = String(citation.ref || '').startsWith('ledger:balance:');
    check(`citation:${citation.n}`, Boolean(account) && (balance
      ? citation.posted_on === account.observed && String(citation.amount_minor) === account.balance
      : Boolean(row) && !row.pending && row.date === citation.posted_on && row.account === account.slug &&
        String(citation.amount_minor) === row.cents), 'missing_source');
    const amounts = displayFigures(citation.title);
    figure(`citation-display:${citation.n}`, amounts.length === 1 ? amounts[0].cents : null,
      balance ? account?.balance : row?.cents);
  }
  if (!ledger) {
    // The adapter records only a ledger attempt. Its empty document sentinel
    // cannot earn a tested document answer or a successful forecast refusal.
    check('ledger-attempt-returned-supported-facts', false);
    check('no-amount-without-ledger', shown.length === 0, 'wrong_figure');
    if (answer) check(`unexecuted-document-claim:${sha(answer)}`, false, 'unsupported_claim');
    const refusedCoverage = gold.contract === 'refuse-coverage' &&
      body.gaps?.some(g => g.reason === 'period_outside_coverage') &&
      observation.trace.dependencies.includes('inventory');
    if (refusedCoverage) {
      result.checks = result.checks.filter(c => c.id !== 'ledger-attempt-returned-supported-facts');
      result.reasons = [];
      check('coverage-refusal-reached', true);
      result.verdict = 'honest refusal';
    } else result.verdict = shown.length ? 'wrong figure' : 'over-refusal';
    return finish();
  }
  check('real-fact-read', observation.trace.dependencies.some(d => ['transactions', 'balances'].includes(d)));
  if (input.period.from) check('period', ledger.from === input.period.from && ledger.to === input.period.to, 'scope');
  if (gold.classification_uncertain) check('unknown-classification-is-not-complete', ledger.complete !== true, 'ownership');

  const ids = list => (list || []).map(rowId);
  const primaryIds = gold.contract === 'ranking' ? ids(ledger.lead_rows)
    : gold.contract === 'transactions' || gold.contract === 'payment' || gold.contract === 'vendor' ? ids(citations) : null;
  const expense = gold.contract === 'expense' || gold.contract === 'repayment';
  const uncertainExpense = expense && gold.classification_uncertain && ledger.classification_complete === false &&
    ledger.complete === false && ledger.expense_total_minor === null && ledger.total_minor === null;
  const retainedIds = uncertainExpense ? [...new Set([...gold.included, ...gold.repayment_ids])] : gold.included || [];
  const retainedTotal = total(retainedIds.map(id => rows.get(id).cents));
  if (expense) {
    if (uncertainExpense) {
      // Withholding a classification never earns its required expense or
      // repayment fact. The disclosed retained subtotal is checked separately.
      check('expense-total', false);
      check('whole-repayment', false);
    } else {
      figure('expense-total', ledger.expense_total_minor, gold.total);
      figure('whole-repayment', ledger.own_account_payments?.total_minor, gold.repayment);
    }
    check('expense-row-count', !uncertainExpense && ledger.row_count === gold.included.length,
      uncertainExpense ? 'missing_fact' : 'wrong_figure');
    const included = new Set(gold.included);
    check('expense-evidence-membership', !uncertainExpense && (!included.size || citations.length > 0) && citations.every(c => included.has(rowId(c))),
      uncertainExpense ? 'missing_fact' : citations.length ? 'ownership' : 'missing_source');
    if (gold.require_posted_disclosure) check('posted-record-limitation', /\bposted\b/i.test(answer) && /\bpending\b/i.test(answer));
    check('whole-payment-no-invented-split', !/\bprincipal\b|interest (?:portion|amount|split)/i.test(answer), 'unsupported_claim');
    check('visible-expense-period', answer.includes(`Period: ${input.period.from} through ${input.period.to}.`), 'scope');
  } else if (gold.contract === 'ranking') {
    check('eligible-ranking-before-limit', same(primaryIds, gold.ids), 'wrong_figure');
    check('ranked-cents', same((ledger.lead_rows || []).map(r => String(r.amount_minor)), gold.cents), 'wrong_figure');
    if (gold.gross_ids) check('original-gross-ranking', same(ids(ledger.rows), gold.gross_ids), 'wrong_figure');
  } else if (gold.contract === 'transactions') {
    check('transaction-order', same(primaryIds, gold.ids), 'wrong_figure');
    check('transaction-dates', same((ledger.rows || []).map(r => r.posted_on), gold.dates), 'wrong_figure');
    check('posted-list-complete', ledger.complete === true);
    check('transaction-heading-count', answer.startsWith(`Newest ${gold.ids.length} transactions:`), 'wrong_figure');
  } else if (gold.contract === 'balance' || gold.contract === 'forecast') {
    for (const balance of gold.balances) {
      const actual = ledger.accounts?.find(a => a.account_mask === balance.mask);
      figure(`balance:${balance.mask}`, actual?.current_minor, balance.cents);
      check(`balance-date:${balance.mask}`, actual?.as_of === gold.observed);
    }
    if (gold.require_roles) check('cash-and-liability-roles', /\bliabilit|\bdebt\b|\bloan\b/i.test(answer) && /\bcash\b|\basset\b/i.test(answer));
    if (gold.contract === 'forecast') check('withhold-future', /cannot|can.t|unavailable|unsupported/i.test(answer), 'unsupported_claim');
  } else if (gold.contract === 'receipts') {
    for (const [mask, cents] of Object.entries(gold.receipts)) {
      figure(`receipts:${mask}`, ledger.lead_accounts?.find(a => a.account_mask === mask)?.credits_minor, cents);
    }
    if (gold.require_combined) check('combined-scoped-receipts', answer.includes(formatMinor(gold.combined)));
    check('uncertain-credit-not-income', !/\b(?:earned|revenue|profit)\b/i.test(answer), 'unsupported_claim');
  } else if (gold.contract === 'payment') {
    check('exact-payment-row', same(primaryIds, gold.ids), citations.length ? 'wrong_figure' : 'missing_source');
    check('arrival-window', ledger.from === gold.from && ledger.to === gold.to, 'scope');
    check('positive-arrival', ledger.found === true);
  } else if (gold.contract === 'absence') {
    check('scoped-exact-absence', ledger.found === false && ledger.match_basis === 'none' && ledger.total_minor === null &&
      /exact vendor spend in the covered window/.test(answer) && ledger.coverage?.complete === true);
    check('no-global-absence', !/never used|never paid|no spending anywhere/i.test(answer), 'unsupported_claim');
  } else if (gold.contract === 'vendor') {
    figure('outside-payment-retained', ledger.total_minor, gold.total);
    check('outside-payment-row', same(primaryIds, gold.ids), citations.length ? 'ownership' : 'missing_source');
    check('vendor-exact', ledger.match_basis === 'exact');
  } else if (gold.contract === 'gross') {
    figure('gross-outflow', total((ledger.accounts || []).map(a => String(a.debits_minor))), gold.debits);
    figure('gross-inflow', total((ledger.accounts || []).map(a => String(a.credits_minor))), gold.credits);
  } else if (gold.contract === 'coverage' || gold.contract === 'refuse-coverage') {
    check('coverage-cannot-be-complete', ledger.complete === false, 'unsupported_claim');
    check('coverage-does-not-certify-zero', shown.length === 0, 'wrong_figure');
    check('coverage-gap-disclosed', /partial|incomplete|unproven|not certified/i.test(answer));
  } else { result.execution_status = 'unbound_contract'; return result; }

  if (gold.contract === 'ranking') {
    // Presence is an obligation of the frozen key. Traversing only fields or
    // figures that happen to survive in output cannot detect a missing answer.
    const ordinaryDisplay = answer.split('\nWith everything counted:')[0];
    const displayed = [...ordinaryDisplay.matchAll(/^(-?\$[\d,]+\.\d{2}) on (\d{4}-\d{2}-\d{2}) in account \*{4}(\d{4}): .+ \[(\d+)\]$/gm)]
      .map(m => ({ id: rowId(citations.find(c => c.n === Number(m[4]))),
        cents: displayFigures(m[1])[0].cents, date: m[2], mask: m[3] }));
    const expected = gold.ids.map((id, i) => ({ id, cents: gold.cents[i], date: rows.get(id)?.date,
      mask: snapshot.accounts.find(a => a.slug === rows.get(id)?.account)?.mask }));
    check('displayed-ranking', same(displayed, expected));
    if (gold.repayment) {
      figure('whole-repayment', ledger.own_account_payments?.total_minor, gold.repayment);
      const repaymentLines = answer.split('\n').filter(line => line.startsWith('Payments to your own loan/card accounts:'));
      check('displayed-whole-repayment', repaymentLines.length === 1 &&
        same(displayFigures(repaymentLines[0]).map(a => a.cents), [gold.repayment]));
    }
  }

  // Check every monetary structured field, including conditionals and notes.
  // Expected side is independently evaluated from the declared gold membership.
  const windowRows = [...rows.values()].filter(r => !r.pending && r.date >= (input.period.from || '0000') && r.date <= input.period.to);
  const accountSum = (mask, direction) => total(windowRows.filter(r =>
    r.account === snapshot.accounts.find(a => a.mask === mask)?.slug && r.direction === direction).map(r => r.cents));
  if (ledger) {
    // Counts and scope are facts too. Their expected side comes from frozen
    // membership and input coverage, never another output count or its prose.
    const selectedAccounts = snapshot.accounts.filter(a => gold.contract !== 'receipts' || a.mask in gold.receipts)
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const coveredAccounts = selectedAccounts.filter(a => a.coverage === 'complete' &&
      (!input.period.from || a.from <= input.period.from) && a.to >= input.period.to);
    const covered = coveredAccounts.length, selected = selectedAccounts.length;
    const included = retainedIds.map(id => rows.get(id));
    const repaymentCount = uncertainExpense ? 0 : (gold.repayment_ids || []).length;
    const groups = new Map();
    for (const row of included) {
      const label = row.payee.toLowerCase();
      groups.set(label, (groups.get(label) || 0) + 1);
    }
    const cited = Math.min(included.length, 5), omitted = included.length - cited;
    const factual = (id, actual, expected) => check(id, expected !== undefined && same(actual, expected), 'unsupported_claim');
    const counters = (value, path = '') => {
      for (const [name, item] of Object.entries(value || {})) {
        const p = path ? `${path}.${name}` : name;
        if (name === 'count' || /_(?:count|pairs)$/.test(name)) {
          let expected;
          if (p === 'own_account_payments.count') expected = repaymentCount;
          else if (name === 'transaction_count') expected = windowRows.filter(r =>
            r.account === snapshot.accounts.find(a => a.mask === value.account_mask)?.slug).length;
          else if (path.startsWith('groups.') && name === 'count') expected = groups.get(value.merchant);
          else if (path.startsWith('category_groups.') && name === 'count') expected = value.category === 'Unsorted' ? included.length : undefined;
          else if (p === 'row_count') expected = expense ? included.length : (gold.ids || []).length;
          else if (p === 'cited_row_count') expected = cited;
          else if (p === 'omitted_row_count') expected = expense ? omitted : Math.max(0, (gold.ids || []).length - 5);
          else if (p === 'group_count') expected = groups.size;
          else if (p === 'omitted_group_count') expected = Math.max(0, groups.size - 10);
          else if (p === 'category_group_count') expected = included.length ? 1 : 0;
          else if (p === 'omitted_category_group_count') expected = 0;
          else if (p === 'coverage.candidate_account_count') expected = selected;
          else if (p === 'coverage.covered_account_count') expected = covered;
          else if (p === 'coverage.omitted_account_count') expected = selected - covered;
          else if (p === 'coverage.contributing_account_count') expected = new Set((gold.ids || []).map(id => rows.get(id)?.account)).size;
          else if (['matched_transfer_count', 'candidate_transfer_count', 'excluded_own_movement_count'].includes(p) ||
            /^default_exclusions\.(?:own_transfer_pairs|withdrawal_count|loan_proceeds_count)$/.test(p)) expected = 0;
          factual(`count:${p}`, item, expected);
        } else if (item && typeof item === 'object') counters(item, p);
      }
    };
    counters(ledger);
    if (ledger.accounts) {
      factual('scope:account-membership', ledger.accounts.map(a => a.account_mask).sort(), selectedAccounts.map(a => a.mask).sort());
      for (const account of ledger.accounts) {
        const source = selectedAccounts.find(a => a.mask === account.account_mask);
        if (Object.hasOwn(account, 'covered_to')) factual(`scope:covered-to:${account.account_mask}`, account.covered_to, source?.to);
        if (Object.hasOwn(account, 'last_synced_at')) factual(`scope:synced:${account.account_mask}`, account.last_synced_at, null);
      }
    }
    if (ledger.coverage && expense) {
      factual('scope:coverage-complete', ledger.coverage.complete, covered === selected);
      factual('scope:coverage-status', ledger.coverage.status, covered === selected ? 'full' : 'partial');
    }
    for (const line of answer.split('\n')) {
      let m;
      if ((m = /^Payments to your own loan\/card accounts: .+ across (\d+) payments?\.$/.exec(line)))
        factual('display-count:repayments', Number(m[1]), repaymentCount);
      else if ((m = /^(.+): -?\$[\d,]+\.\d{2} across (\d+) rows?/.exec(line)))
        factual(`display-count:group:${m[1]}`, Number(m[2]), m[1] === 'Unsorted' ? included.length : groups.get(m[1]));
      else if (line.startsWith('Evidence:')) factual('display-count:evidence', line,
        `Evidence: ${cited} of ${included.length} expense rows cited${omitted ? `, and ${omitted} more rows` : ''}.`);
      else if (line.startsWith('Coverage: full,')) factual('display-scope:coverage', line,
        `Coverage: full, all ${covered} selected accounts cover ${input.period.from} through ${input.period.to}.`);
      else if (line.startsWith('Period:')) factual('display-scope:period', line,
        `Period: ${input.period.from} through ${input.period.to}.`);
      else if (line.startsWith('Accounts:')) factual('display-scope:accounts', line,
        `Accounts: ${selectedAccounts.map(a => `account ****${a.mask}`).join(', ')}; ${input.period.from} through ${input.period.to}; ` +
        `${selectedAccounts.map(a => `account ****${a.mask}: covered through ${a.to}`).join('; ')}.`);
      else if (line.startsWith('Coverage: requested')) factual('display-scope:vendor', line,
        `Coverage: requested ${input.period.from} through ${input.period.to}; ` +
        `${new Set((gold.ids || []).map(id => rows.get(id)?.account)).size} contributing, ${covered} fully covered, ` +
        `${selected - covered} omitted account${selected - covered === 1 ? '' : 's'}; ` +
        selectedAccounts.map(a => `account ****${a.mask} covered through ${a.to}`).join('; ') + '.');
    }
  }
  const fieldCheck = (value, path = '', parent = null) => {
    for (const [name, item] of Object.entries(value || {})) {
      const p = path ? `${path}.${name}` : name;
      if (/_minor$/.test(name) && item !== null && typeof item !== 'object') {
        let expected;
        if (name === 'amount_minor') expected = rows.get(rowId(value.ref ? value : citations.find(c => c.n === value.n)))?.cents;
        else if (name === 'current_minor') expected = gold.balances?.find(b => b.mask === value.account_mask)?.cents;
        else if (name === 'credits_minor' || name === 'debits_minor') expected = accountSum(value.account_mask, name === 'credits_minor' ? 'inflow' : 'outflow');
        else if (/^(?:default_exclusions\.|excluded_own_transfer_minor$|excluded_own_movement_minor$)/.test(p)) expected = '0';
        else if (p.startsWith('own_account_payments.')) expected = uncertainExpense || name === 'card_minor' ? '0' : gold.repayment;
        else if (p === 'retained_outflow_minor' && uncertainExpense) expected = retainedTotal;
        else if (/^(?:expense_total_minor|total_minor)$/.test(p)) expected = gold.total;
        else if (p.startsWith('groups.') && expense) {
          const ids = gold.included.filter(id => rows.get(id)?.payee?.toLowerCase() === value.merchant);
          expected = total(ids.map(id => rows.get(id).cents));
        } else if (p.startsWith('category_groups.') && expense) expected = gold.total;
        else if (name === 'total_minor' && gold.contract === 'ranking') expected = total(gold.gross_cents || gold.cents);
        else if (['vendor', 'absence'].includes(gold.contract) &&
          /(?:total_minor|unsorted_minor)$/.test(name)) expected = gold.total;
        figure(`field:${p}`, item, expected ?? 'UNSUPPORTED');
      } else if (item && typeof item === 'object') fieldCheck(item, p, value || parent);
    }
  };
  fieldCheck(ledger);

  const lines = answer.split('\n');
  let seenDisplay = 0;
  let grossRanking = false;
  for (const line of lines) {
    if (line === 'With everything counted:') grossRanking = true;
    const amounts = displayFigures(line);
    if (!amounts.length) continue;
    seenDisplay += amounts.length;
    for (const match of line.matchAll(/account \*{4}(\d{4})/g)) {
      const permitted = gold.contract === 'receipts' ? Object.keys(gold.receipts) : snapshot.accounts.map(a => a.mask);
      check(`display-account-scope:${seenDisplay}:${match[1]}`, permitted.includes(match[1]), 'scope');
    }
    const d = '-?\\$[\\d,]+\\.\\d{2}', day = '\\d{4}-\\d{2}-\\d{2}', ref = '\\[\\d+\\]';
    const allowedMoneyLine = [
      `^Recorded outgoing subtotal: ${d}\\.$`,
      `^You spent ${d} (?:this month|last month|today|yesterday|this week|${day} through ${day})\\.$`,
      `^You spent ${d} at [A-Za-z ]+ (?:this month|in [A-Za-z]+ \\d{4})\\. ${ref}(?: ${ref})*\\.$`,
      `^[a-zA-Z ]+: ${d} across \\d+ rows?(?: ${ref})*\\.$`,
      `^Payments to your own loan/card accounts: ${d} across \\d+ payments?\\.$`,
      `^[A-Za-z ]+ \\(account \\*{4}\\d{4}\\): ${d} as of ${day}; feed synced (?:${day}|unavailable) ${ref}\\.$`,
      `^${day}: [A-Za-z ]+, ${d}, [A-Za-z ]+ \\(account \\*{4}\\d{4}\\) ${ref}\\.$`,
      `^${d} on ${day} in account \\*{4}\\d{4}: [A-Za-z0-9 .]+ ${ref}$`,
      `^Found a deposit of ${d} posted ${day} in account \\*{4}\\d{4}: [A-Za-z ]+ ${ref}\\.$`,
      `^account \\*{4}\\d{4}, ${day} through ${day}: credits ${d}; debits ${d} (?:${ref}(?: ${ref})*|\\(no posted income or expenses in the covered period\\))\\.$`,
    ].some(pattern => new RegExp(pattern).test(line));
    if (!allowedMoneyLine) check(`unreviewed-money-prose:${sha(line)}`, false, 'unsupported_claim');
    let expected = null;
    if (expense) {
      if (/^Recorded outgoing subtotal:/.test(line) && uncertainExpense) expected = [retainedTotal];
      else if (/^(?:You spent|Covered-account expense subtotal|Unsorted:)/.test(line)) expected = [gold.total];
      else if (/^Payments to your own loan\/card accounts:/.test(line)) expected = [gold.repayment];
      else {
        const merchant = line.split(':')[0];
        const groupIds = gold.included.filter(id => rows.get(id)?.payee?.toLowerCase() === merchant);
        if (groupIds.length) expected = [total(groupIds.map(id => rows.get(id).cents))];
      }
    } else if (gold.contract === 'balance') {
      const mask = /\*{4}(\d{4})/.exec(line)?.[1];
      const balance = gold.balances.find(b => b.mask === mask);
      if (balance) expected = [balance.cents];
      check(`display-balance-date:${mask}`, line.includes(`as of ${gold.observed};`), 'scope');
      check(`display-balance-sync:${mask}`, /; feed synced unavailable /.test(line), 'scope');
    } else if (gold.contract === 'ranking' && /^Payments to your own loan\/card accounts:/.test(line)) {
      expected = [gold.repayment];
    } else if (gold.contract === 'ranking' || gold.contract === 'transactions' || gold.contract === 'payment') {
      const ref = /\[(\d+)\]/.exec(line)?.[1];
      const cite = citations.find(c => c.n === Number(ref)) || ledger.lead_rows?.find(c => c.n === Number(ref)) ||
        (gold.contract === 'transactions' && ref ? { ref: `ledger:transaction:${gold.ids[Number(ref) - 1]}` } : null);
      const id = rowId(cite), allowed = (grossRanking && gold.contract === 'ranking' ? gold.gross_ids || gold.ids : gold.ids).includes(id), row = rows.get(id);
      if (allowed && row) expected = [gold.contract === 'transactions' && row.direction === 'outflow' ? `-${row.cents}` : row.cents];
      check(`display-row-date:${seenDisplay}`, Boolean(row) && line.includes(row.date), 'scope');
    } else if (gold.contract === 'vendor') expected = [gold.total];
    else if (gold.contract === 'receipts' || gold.contract === 'gross') {
      const mask = /\*{4}(\d{4})/.exec(line)?.[1];
      if (mask && /credits|money in/.test(line)) expected = [accountSum(mask, 'inflow'), accountSum(mask, 'outflow')];
      check(`display-period:${seenDisplay}`, line.includes(`${input.period.from} through ${input.period.to}`), 'scope');
    }
    figure(`display:${seenDisplay}`, JSON.stringify(amounts.map(a => a.cents)), JSON.stringify(expected));
  }
  // This slice has a deterministic renderer, not a model-prose adjudicator.
  // Unrecognized factual prose is held for review, never silently approved.
  for (const line of lines.filter(line => line && !displayFigures(line).length)) {
    if (['Figures use recorded posted rows. Pending activity is not assessed here.',
      'Note: payments to your own loan/card accounts are shown separately from expenses.',
      'With everything counted:'].includes(line)) continue;
    if (uncertainExpense && line === 'Expense classification is uncertain; this subtotal may include payments between your own accounts.') continue;
    const known = /^(?:Your latest synced balances are below\.|Merchant groups:|Category groups:|Period: \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\.|Evidence: \d+ of \d+ expense rows cited(?:, and \d+ more rows)?\.|Coverage: full, all \d+ selected accounts cover \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\.|Newest \d+ transactions?:|Possible transfers are included in income and spend; no rows were removed as transfers\.|Accounts: account \*{4}\d{4}.*\.|Coverage: requested \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2};.*\.|Partial: No transactions were found for .+ as exact vendor spend in the covered window, \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\. .+)$/;
    if (!known.test(line)) check(`unreviewed-prose:${sha(line)}`, false, 'unsupported_claim');
  }
  check('display-extraction-complete', seenDisplay === shown.length);
  if (shown.length && !citations.length && gold.total !== '0') check('figures-have-sources', false, 'missing_source');
  const wrong = result.safety_failures.some(f => /wrong_figure|ownership|scope/.test(f));
  const missingSource = result.checks.some(c => c.failure === 'missing_source');
  result.verdict = wrong ? 'wrong figure' : missingSource ? 'missing source'
    : result.checks.every(c => c.ok) ? 'correct' : 'partly';
  return finish();
}

export function scoreRun(run, inputs) {
  if (run?.mode !== 'real-ledger-synthetic-sqlite' || run.provider_calls !== 0 || run.production_writes !== 0 ||
    !run.node_version || !run.source_files || !Object.keys(run.source_files).length ||
    ['source_digest', 'migration_digest', 'harness_digest', 'input_set_digest', 'observation_digest']
      .some(key => !/^[a-f0-9]{64}$/.test(run[key] || ''))) throw Error('INVALID_RUN_IDENTITY');
  if (!run || run.observation_digest !== sha(run.observations) || run.observations.length !== inputs.length ||
    new Set(run.observations.map(o => o.id)).size !== inputs.length ||
    !same(run.observations.map(o => o.id), inputs.map(c => c.id))) throw Error('RUN_SET_MISMATCH');
  if (run.scoring_identity && run.scoring_identity !== SCORING_IDENTITY) throw Error('SCORING_IDENTITY_MISMATCH');
  const replayInputs = inputs.map(c => ({ ...c, snapshot: evidence(c.profile) }));
  if (run.input_set_digest !== sha(replayInputs) ||
    run.observations.some((o, i) => o.input_digest !== sha(replayInputs[i]))) throw Error('INPUT_IDENTITY_MISMATCH');
  const scores = inputs.map((c, i) => scoreObservation(run.observations[i], c));
  const counts = Object.fromEntries(VERDICTS.map(v => [v, scores.filter(s => s.verdict === v).length]));
  return { schema: 1, bank_version: run.bank_version, gold_version: GOLD_VERSION, oracle_version: ORACLE_VERSION,
    planned: inputs.length, attempted: scores.length, complete: scores.filter(s => s.execution_status === 'complete').length,
    invalid: scores.filter(s => s.execution_status !== 'complete').length, counts, scores,
    adjudicated: scores.filter(s => s.verdict !== null).length,
    required_facts_met: scores.reduce((n, s) => n + s.required_facts_met, 0),
    required_facts_total: scores.reduce((n, s) => n + s.required_facts_total, 0) };
}
