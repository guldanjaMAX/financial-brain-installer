import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import worker from '../src/index.js';

// Discovery, not a zero-defect release gate: wrong answers and route refusals
// are counted as findings. Only an incomplete/broken finder is NOT READY.
// No product classifier, reader, clean-view SQL or expected-result fixture is
// imported into the oracle. `event` is the synthetic bookkeeper's ground truth;
// it is deliberately NOT inserted into the database or exposed to the route.
const REPORT = pathToFileURL(join(mkdtempSync(join(tmpdir(), 'finder-tools-cards-')), 'REPORT.md'));
const NOW = '2026-11-12T12:00:00.000Z';
const FROM = '2026-10-01', TO = '2026-10-31';
const migrations = readdirSync(new URL('../../migrations/d1/', import.meta.url))
  .filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(`../../migrations/d1/${name}`, import.meta.url), 'utf8'));

function account(slug, kind, extra = {}) {
  return { slug, kind, side: 'business', currency: 'USD', mask: kind === 'card' ? '2222' : '1111',
    feed: 'live', coverage: 'complete', from: '2026-09-01', to: '2026-11-30', ...extra };
}
function row(uid, accountSlug, day, cents, event, extra = {}) {
  const defaults = {
    purchase: ['outflow', 'MERCHANT PURCHASE', 'merchant', 'PURCHASE'],
    fee: ['outflow', 'CARD ANNUAL FEE', 'card issuer', 'FEES'],
    interest: ['outflow', 'CARD INTEREST CHARGE', 'card issuer', 'INTEREST'],
    payment_out: ['outflow', 'PAYMENT TO CARD 2222', null, 'CREDIT_CARD_PAYMENT'],
    payment_in: ['inflow', 'PAYMENT THANK YOU', null, 'CREDIT_CARD_PAYMENT'],
    refund: ['inflow', 'MERCHANT REFUND', 'merchant', 'REFUND'],
    income: ['inflow', 'CLIENT INCOME', 'client', 'INCOME'],
    other_credit: ['inflow', 'CARD REWARD CREDIT', 'card issuer', null],
  };
  const [direction, description, payee, category] = defaults[event];
  return { uid, account: accountSlug, day, cents, event, direction, description, payee, category,
    currency: 'USD', pending: false, removed: false, superseded: false, ...extra };
}
const q = (metric, question, extra = {}) => ({ metric, question, from: FROM, to: TO,
  side: 'business', currency: 'USD', ...extra });
const checking = () => account('checking', 'checking');
const card = () => account('card', 'card');

const books = [
  {
    name: 'connected purchases and repayment', accounts: [checking(), card()],
    rows: [
      row('supplies', 'card', '2026-10-03', 12345, 'purchase'),
      row('software', 'card', '2026-10-07', 6789, 'purchase', { payee: 'supplier' }),
      row('rent', 'checking', '2026-10-08', 80000, 'purchase', { category: 'RENT', payee: 'landlord' }),
      row('sent', 'checking', '2026-10-10', 19000, 'payment_out'),
      row('received', 'card', '2026-10-11', 19000, 'payment_in'),
      row('returned', 'card', '2026-10-14', 2345, 'refund'),
      row('fee', 'card', '2026-10-15', 499, 'fee'),
      row('earned', 'checking', '2026-10-18', 150000, 'income'),
    ],
    questions: [
      q('spending', 'What were my October business expenses before refunds?'),
      q('card_spending', 'How much expense went on the card in October?'),
      q('checking_spending', 'What did I spend directly from checking, leaving card payments separate?'),
      q('payments_out', 'How much did checking pay toward the credit card in October?'),
      q('payments_in', 'How much repayment arrived on the card in October?'),
      q('card_refunds', 'How much did merchants refund to my card in October?'),
      q('net_spending', 'What are October business expenses after the recorded refunds?'),
      q('card_net', 'How much did October card activity add to what I owe?'),
      q('income', 'How much business income came in during October?'),
      q('card_count', 'How many posted card expenses do I have for October?'),
    ],
  },
  {
    name: 'partial repayments and older debt', accounts: [checking(), card()],
    rows: [
      row('prior-purchase', 'card', '2026-09-20', 90000, 'purchase'),
      row('new-purchase', 'card', '2026-10-02', 31001, 'purchase'),
      row('small-purchase', 'card', '2026-10-09', 2703, 'purchase'),
      row('first-send', 'checking', '2026-10-12', 10000, 'payment_out'),
      row('first-credit', 'card', '2026-10-13', 10000, 'payment_in'),
      row('second-send', 'checking', '2026-10-24', 12000, 'payment_out'),
      row('second-credit', 'card', '2026-10-25', 12000, 'payment_in'),
      row('interest', 'card', '2026-10-26', 1901, 'interest'),
      row('return', 'card', '2026-10-27', 703, 'refund'),
    ],
    questions: [
      q('card_spending', 'What did I charge in October, including the interest charge?'),
      q('payments_out', 'How much did I send to the card across my two October payments?'),
      q('payments_in', 'How much did those two payments credit to the card?'),
      q('spending', 'What were October expenses when I keep repayments separate?'),
      q('gross_out', 'How much actually left checking in October?', { accounts: ['checking'] }),
      q('card_refunds', 'How much of my October card spending came back as refunds?'),
      q('net_spending', 'What are my recorded October costs net of returns?'),
      q('card_net', 'Did my October card activity increase or reduce the debt, and by how much?'),
      q('card_count', 'How many separate October card charges count as expenses?'),
      q('card_spending', 'How much did I put on the card in September?', { from: '2026-09-01', to: '2026-09-30' }),
    ],
  },
  {
    name: 'month boundary repayment and late refund', accounts: [checking(), card()],
    rows: [
      row('prior-charge', 'card', '2026-09-15', 45000, 'purchase'),
      row('edge-send', 'checking', '2026-09-30', 25000, 'payment_out', { category: null, description: 'TRANSFER TO ACCOUNT 2222' }),
      row('edge-credit', 'card', '2026-10-02', 25000, 'payment_in', { category: null, description: 'TRANSFER FROM ACCOUNT 1111' }),
      row('current-charge', 'card', '2026-10-10', 18001, 'purchase'),
      row('late-return', 'card', '2026-10-15', 7001, 'refund'),
      row('next-send', 'checking', '2026-10-31', 16000, 'payment_out'),
      row('next-credit', 'card', '2026-11-02', 16000, 'payment_in'),
    ],
    questions: [
      q('card_spending', 'How much new card expense posted in October?'),
      q('payments_out', 'How much did checking send to the card in September?', { from: '2026-09-01', to: '2026-09-30' }),
      q('payments_out', 'How much did checking send to the card in October, by the posting date?'),
      q('payments_in', 'What repayments reached the card in October, including the September payment?'),
      q('payments_in', 'What repayments reached the card in November?', { from: '2026-11-01', to: '2026-11-30' }),
      q('card_refunds', 'How much was refunded to the card in October even if the purchase was earlier?'),
      q('net_spending', 'What were October expenses after refunds posted that month?'),
      q('card_net', 'What was the net effect of October posted card activity on my debt?'),
      q('income', 'Did the payment that arrived on my card create any October income?'),
      q('card_net', 'What did September card activity add to my debt?', { from: '2026-09-01', to: '2026-09-30' }),
    ],
  },
  {
    name: 'known card never connected',
    accounts: [checking(), account('unconnected-card', 'card', { mask: '9999', feed: 'none', coverage: 'missing', from: null, to: null })],
    rows: [
      row('coded-send', 'checking', '2026-10-03', 34001, 'payment_out', { description: 'BILL PAY TO CARD ISSUER 9999', payee: 'card issuer' }),
      row('plain-send', 'checking', '2026-10-12', 17003, 'payment_out', { description: 'CREDIT CARD PAYMENT 9999', payee: 'card issuer', category: null, provisional: true }),
      row('rent', 'checking', '2026-10-15', 65000, 'purchase', { category: 'RENT', payee: 'landlord' }),
      row('income', 'checking', '2026-10-18', 120000, 'income'),
      row('refund', 'checking', '2026-10-23', 1101, 'refund'),
    ],
    questions: [
      q('payments_out', 'How much did I pay the card issuer from checking in October?'),
      q('checking_spending', 'What did I spend from checking apart from paying the unconnected card?'),
      q('spending', 'What expenses can you see in the connected account for October, including unproved payments provisionally?'),
      q('gross_out', 'What is the full amount that left checking, including card repayments?', { accounts: ['checking'] }),
      q('income', 'How much income reached checking while the card was unconnected?'),
      q('complete_card_spending', 'Can you tell me the full October purchase total on the card that is not connected?', { accounts: ['unconnected-card'] }),
      q('card_spending', 'What card expenses are actually recorded for the unconnected card?', { accounts: ['unconnected-card'] }),
      q('payments_in', 'What payment credits can you actually see on the missing card feed?', { accounts: ['unconnected-card'] }),
      q('refunds', 'How much refund money is recorded in checking for October?', { accounts: ['checking'] }),
      q('net_spending', 'What are the visible October expenses after visible refunds, with the missing card disclosed?'),
    ],
  },
  {
    name: 'card absent from account inventory', accounts: [checking()],
    rows: [
      row('coded', 'checking', '2026-10-04', 45005, 'payment_out', { description: 'AUTOPAY CARD ISSUER', payee: 'card issuer' }),
      row('memo', 'checking', '2026-10-09', 21007, 'payment_out', { description: 'CREDIT CARD PAYMENT TO CARD ISSUER', payee: 'card issuer', category: null, provisional: true }),
      row('autopay', 'checking', '2026-10-17', 13009, 'payment_out', { description: 'AUTOPAY TO CREDIT CARD 9999', payee: null, category: null, provisional: true }),
      row('purchase', 'checking', '2026-10-20', 6001, 'purchase'),
      row('income', 'checking', '2026-10-22', 90000, 'income'),
    ],
    questions: [
      q('payments_out', 'How much went to card repayments when only checking is in the books?'),
      q('spending', 'What are my recorded October expenses without counting card debt payments twice?'),
      q('checking_spending', 'How much ordinary spending came directly out of the connected checking account?'),
      q('gross_out', 'How much left my only connected account in October?'),
      q('income', 'How much business income is visible in my checking-only books?'),
      q('complete_card_spending', 'What is the October purchase total on my card that is absent from your account list?', { accounts: ['unconnected-card'] }),
      q('card_spending', 'How much card purchase activity do these checking-only records actually contain?'),
      q('payments_out', 'What card payments posted in the first half of October?', { to: '2026-10-15' }),
      q('payments_out', 'How much of the second half of October was card repayment?', { from: '2026-10-16' }),
      q('net_spending', 'What are visible checking costs net of recorded refunds in October?'),
    ],
  },
  {
    name: 'business and personal cards',
    accounts: [checking(), card(), account('personal-checking', 'checking', { side: 'personal', mask: '3333' }),
      account('personal-card', 'card', { side: 'personal', mask: '4444' })],
    rows: [
      row('business-charge', 'card', '2026-10-02', 20001, 'purchase'),
      row('personal-charge', 'personal-card', '2026-10-03', 17003, 'purchase', { category: 'FOOD' }),
      row('business-send', 'checking', '2026-10-06', 15000, 'payment_out'),
      row('business-credit', 'card', '2026-10-07', 15000, 'payment_in'),
      row('personal-send', 'personal-checking', '2026-10-08', 11000, 'payment_out', { description: 'PAYMENT TO CARD 4444' }),
      row('personal-credit', 'personal-card', '2026-10-09', 11000, 'payment_in'),
      row('business-return', 'card', '2026-10-12', 3001, 'refund'),
      row('personal-return', 'personal-card', '2026-10-13', 2003, 'refund'),
      row('personal-fee', 'personal-card', '2026-10-19', 701, 'fee'),
      row('business-income', 'checking', '2026-10-22', 200000, 'income'),
    ],
    questions: [
      q('card_spending', 'What were the business card expenses for October?'),
      q('card_spending', 'What were my personal card expenses for October?', { side: 'personal' }),
      q('card_spending', 'How much expense hit both my business and personal cards combined?', { side: null }),
      q('payments_out', 'How much did business checking pay toward cards?'),
      q('payments_out', 'How much did personal checking pay toward cards?', { side: 'personal' }),
      q('card_refunds', 'How much was refunded on the business card?'),
      q('card_refunds', 'How much was refunded on the personal card?', { side: 'personal' }),
      q('net_spending', 'What did the business spend in October after its refunds?'),
      q('net_spending', 'What did I spend personally in October after personal refunds?', { side: 'personal' }),
      q('card_net', 'What was the combined October change from activity on both cards?', { side: null }),
    ],
  },
  {
    name: 'merchant return language on cards', accounts: [checking(), card()],
    rows: [
      row('charge', 'card', '2026-10-01', 64007, 'purchase'),
      row('explicit-refund', 'card', '2026-10-05', 1001, 'refund'),
      row('return', 'card', '2026-10-09', 2003, 'refund', { description: 'MERCHANDISE RETURN', category: 'MERCHANDISE' }),
      row('returned-purchase', 'card', '2026-10-13', 3007, 'refund', { description: 'RETURNED PURCHASE', category: null }),
      row('reversed', 'card', '2026-10-17', 4009, 'refund', { description: 'PURCHASE REVERSED', category: null }),
      row('payee-refund', 'card', '2026-10-21', 5011, 'refund', { description: 'MERCHANT CREDIT', payee: 'merchant refund', category: null }),
      row('reversal', 'card', '2026-10-25', 6013, 'refund', { description: 'PURCHASE REVERSAL', category: null }),
      row('send', 'checking', '2026-10-27', 25000, 'payment_out'),
      row('credit', 'card', '2026-10-28', 25000, 'payment_in'),
    ],
    questions: [
      q('card_refunds', 'How much in October merchant returns came back onto the card?'),
      q('payments_in', 'How much of the October card credits were my debt repayments?'),
      q('net_spending', 'How much October expense is left after the card returns?'),
      q('card_spending', 'What was October gross card expense before merchandise returns?'),
      q('gross_in', 'How much total credit activity appeared on the card?', { accounts: ['card'] }),
      q('card_net', 'How did all posted October card charges and credits change my debt?'),
      q('card_refunds', 'How much was returned to the card between October 6 and October 15?', { from: '2026-10-06', to: '2026-10-15' }),
      q('card_refunds', 'How much refund credit posted on October 17?', { from: '2026-10-17', to: '2026-10-17' }),
      q('card_refunds', 'How much refund is shown by the merchant refund payee on October 21?', { from: '2026-10-21', to: '2026-10-21' }),
      q('card_refunds', 'How much purchase reversal credit posted on October 25?', { from: '2026-10-25', to: '2026-10-25' }),
    ],
  },
  {
    name: 'fees interest and nonpayment card credits', accounts: [checking(), card()],
    rows: [
      row('purchase', 'card', '2026-10-02', 29003, 'purchase'),
      row('fee', 'card', '2026-10-06', 3901, 'fee', { description: 'CREDIT CARD PAYMENT FEE' }),
      row('interest', 'card', '2026-10-10', 1703, 'interest', { description: 'CARD PAYMENT INTEREST' }),
      row('reward', 'card', '2026-10-14', 1201, 'other_credit'),
      row('reward-two', 'card', '2026-10-16', 901, 'other_credit', { description: 'CASHBACK BONUS', category: 'CASHBACK' }),
      row('refund', 'card', '2026-10-18', 3007, 'refund'),
      row('send', 'checking', '2026-10-21', 20000, 'payment_out'),
      row('credit', 'card', '2026-10-22', 20000, 'payment_in'),
      row('income', 'checking', '2026-10-23', 110000, 'income'),
    ],
    questions: [
      q('card_spending', 'What were my card expenses including annual fees and interest?'),
      q('fees', 'How much did the explicitly labeled card fees cost in October?'),
      q('interest', 'How much separately posted card interest did I incur in October?'),
      q('payments_in', 'How much card credit was repayment rather than returns or reward credits?'),
      q('other_card_credits', 'How much of the card credits were rewards rather than repayments or refunds?'),
      q('card_refunds', 'How much actual merchant refund credit is recorded apart from rewards?'),
      q('card_net', 'What did the purchases, fees, interest, rewards, refunds and payments do to card debt?'),
      q('net_spending', 'What are my October costs after merchant refunds, keeping rewards separate?'),
      q('income', 'How much customer income arrived in checking during October?', { accounts: ['checking'] }),
      q('card_count', 'How many purchase, fee and interest expense rows posted to the card?'),
    ],
  },
  {
    name: 'posted versus pending removed and replaced', accounts: [checking(), card()],
    rows: [
      row('settled', 'card', '2026-10-03', 10001, 'purchase'),
      row('pending-charge', 'card', '2026-10-03', 900003, 'purchase', { pending: true }),
      row('removed-charge', 'card', '2026-10-04', 800009, 'purchase', { removed: true }),
      row('replaced-charge', 'card', '2026-10-05', 700001, 'purchase', { superseded: true }),
      row('send', 'checking', '2026-10-09', 6001, 'payment_out'),
      row('credit', 'card', '2026-10-10', 6001, 'payment_in'),
      row('pending-send', 'checking', '2026-10-11', 500009, 'payment_out', { pending: true }),
      row('removed-credit', 'card', '2026-10-12', 400009, 'payment_in', { removed: true }),
      row('refund', 'card', '2026-10-17', 2003, 'refund'),
      row('pending-refund', 'card', '2026-10-18', 300007, 'refund', { pending: true }),
      row('replaced-refund', 'card', '2026-10-19', 200003, 'refund', { superseded: true }),
      row('income', 'checking', '2026-10-20', 50001, 'income'),
    ],
    questions: [
      q('card_spending', 'What are my settled October card expenses after withdrawn and replaced entries are excluded?'),
      q('payments_out', 'How much posted checking money actually went to card repayment?'),
      q('payments_in', 'How much posted repayment credit remains on the card?'),
      q('card_refunds', 'What is the amount of posted refunds, leaving pending and replaced credits out?'),
      q('net_spending', 'What are the settled October costs after settled refunds?'),
      q('card_count', 'How many final posted expense entries are on the October card?'),
      q('card_net', 'How much did final posted October activity change the amount owed?'),
      q('gross_out', 'What settled money left checking when pending card payments are excluded?', { accounts: ['checking'] }),
      q('gross_in', 'What final credits are visible on the card after removed credits are excluded?', { accounts: ['card'] }),
      q('income', 'What October income remains after all transaction lifecycle filters?'),
    ],
  },
  {
    name: 'two currencies with separate card books',
    accounts: [checking(), card(), account('euro-checking', 'checking', { currency: 'EUR', mask: '5555' }),
      account('euro-card', 'card', { currency: 'EUR', mask: '6666' })],
    rows: [
      row('dollar-charge', 'card', '2026-10-03', 14003, 'purchase'),
      row('euro-charge', 'euro-card', '2026-10-04', 27007, 'purchase', { currency: 'EUR' }),
      row('dollar-send', 'checking', '2026-10-07', 9001, 'payment_out'),
      row('dollar-credit', 'card', '2026-10-08', 9001, 'payment_in'),
      row('euro-send', 'euro-checking', '2026-10-09', 18001, 'payment_out', { currency: 'EUR', description: 'PAYMENT TO CARD 6666' }),
      row('euro-credit', 'euro-card', '2026-10-10', 18001, 'payment_in', { currency: 'EUR' }),
      row('dollar-return', 'card', '2026-10-14', 2003, 'refund'),
      row('euro-return', 'euro-card', '2026-10-15', 3001, 'refund', { currency: 'EUR' }),
    ],
    questions: [
      q('card_spending', 'How much card expense posted in US dollars during October?'),
      q('card_spending', 'How much card expense posted in euros during October?', { currency: 'EUR' }),
      q('payments_out', 'How much did checking pay toward cards in US dollars?'),
      q('payments_out', 'How much did checking pay toward cards in euros?', { currency: 'EUR' }),
      q('card_refunds', 'How much was refunded to the US dollar card?'),
      q('card_refunds', 'How much was refunded to the euro card?', { currency: 'EUR' }),
      q('net_spending', 'What were October dollar expenses after dollar refunds?'),
      q('net_spending', 'What were October euro expenses after euro refunds?', { currency: 'EUR' }),
      q('card_net', 'How much did October activity change the dollar card debt?'),
      q('card_net', 'How much did October activity change the euro card debt?', { currency: 'EUR' }),
    ],
  },
];

const spendEvents = new Set(['purchase', 'fee', 'interest']);
const isPosted = r => !r.pending && !r.removed && !r.superseded;
function selectedAccounts(book, question) {
  return book.accounts.filter(a => a.currency === question.currency &&
    (question.side === null || a.side === question.side) &&
    (!question.accounts || question.accounts.includes(a.slug)));
}
function oracle(book, question, rows = book.rows) {
  const accounts = selectedAccounts(book, question), bySlug = new Map(accounts.map(a => [a.slug, a]));
  const posted = rows.filter(r => isPosted(r) && bySlug.has(r.account) && r.currency === question.currency);
  const selected = posted.filter(r => r.day >= question.from && r.day <= question.to);
  const sum = predicate => selected.filter(predicate).reduce((n, r) => n + r.cents, 0);
  const isCard = r => bySlug.get(r.account).kind === 'card';
  // An unproved payment memo stays in provisional spending; event labels cannot supply missing bank evidence.
  const expense = r => spendEvents.has(r.event) || r.provisional;
  const complete = accounts.length > 0 && accounts.every(a => a.coverage === 'complete' && a.from <= question.from && a.to >= question.to);
  const figures = {
    spending: () => sum(expense),
    card_spending: () => sum(r => isCard(r) && expense(r)),
    checking_spending: () => sum(r => bySlug.get(r.account).kind === 'checking' && expense(r)),
    payments_out: () => sum(r => r.event === 'payment_out' && !r.provisional),
    payments_in: () => sum(r => isCard(r) && r.event === 'payment_in'),
    refunds: () => sum(r => r.event === 'refund'),
    card_refunds: () => sum(r => isCard(r) && r.event === 'refund'),
    net_spending: () => sum(expense) - sum(r => r.event === 'refund'),
    card_net: () => sum(r => isCard(r) && r.direction === 'outflow') - sum(r => isCard(r) && r.direction === 'inflow'),
    income: () => sum(r => r.event === 'income'),
    gross_out: () => sum(r => r.direction === 'outflow'),
    gross_in: () => sum(r => r.direction === 'inflow'),
    card_count: () => selected.filter(r => isCard(r) && expense(r)).length,
    fees: () => sum(r => r.event === 'fee'),
    interest: () => sum(r => r.event === 'interest'),
    other_card_credits: () => sum(r => isCard(r) && r.event === 'other_credit'),
    complete_card_spending: () => complete ? sum(r => isCard(r) && expense(r)) : null,
  };
  return { value_minor: figures[question.metric](), coverage_accounts: accounts.length,
    coverage_rows: posted.length, incomplete_accounts: accounts.filter(a => a.coverage !== 'complete' ||
      a.from > question.from || a.to < question.to).length };
}

const aggregate = {
  spending: 'COALESCE(SUM(expense_minor),0)',
  card_spending: "COALESCE(SUM(CASE WHEN account_kind='card' THEN expense_minor ELSE 0 END),0)",
  checking_spending: "COALESCE(SUM(CASE WHEN account_kind='checking' THEN expense_minor ELSE 0 END),0)",
  payments_out: "COALESCE(SUM(CASE WHEN direction='outflow' AND money_kind='card_payment' THEN amount_minor ELSE 0 END),0)",
  payments_in: "COALESCE(SUM(CASE WHEN account_kind='card' AND direction='inflow' AND money_kind='card_payment' THEN amount_minor ELSE 0 END),0)",
  refunds: "COALESCE(SUM(CASE WHEN direction='inflow' AND money_kind='refund' THEN amount_minor ELSE 0 END),0)",
  card_refunds: "COALESCE(SUM(CASE WHEN account_kind='card' AND direction='inflow' AND money_kind='refund' THEN amount_minor ELSE 0 END),0)",
  net_spending: "COALESCE(SUM(expense_minor),0)-COALESCE(SUM(CASE WHEN direction='inflow' AND money_kind='refund' THEN amount_minor ELSE 0 END),0)",
  card_net: "COALESCE(SUM(CASE WHEN account_kind='card' THEN CASE WHEN direction='outflow' THEN amount_minor ELSE -amount_minor END ELSE 0 END),0)",
  income: 'COALESCE(SUM(income_minor),0)',
  gross_out: "COALESCE(SUM(CASE WHEN direction='outflow' THEN amount_minor ELSE 0 END),0)",
  gross_in: "COALESCE(SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE 0 END),0)",
  card_count: "COALESCE(SUM(CASE WHEN account_kind='card' AND expense_minor>0 THEN 1 ELSE 0 END),0)",
  fees: "COALESCE(SUM(CASE WHEN category='FEES' THEN expense_minor ELSE 0 END),0)",
  interest: "COALESCE(SUM(CASE WHEN category='INTEREST' THEN expense_minor ELSE 0 END),0)",
  other_card_credits: "COALESCE(SUM(CASE WHEN account_kind='card' AND direction='inflow' AND money_kind NOT IN ('card_payment','refund','own_transfer') THEN amount_minor ELSE 0 END),0)",
};
const literal = value => "'" + value.replaceAll("'", "''") + "'";
function sqlFor(question) {
  const scope = ["tenant_id='primary'", `currency=${literal(question.currency)}`];
  if (question.side !== null) scope.push(`side=${literal(question.side)}`);
  if (question.accounts) scope.push(`account_slug IN (${question.accounts.map(literal).join(',')})`);
  const limits = `coverage_status IS NULL OR coverage_status<>'complete' OR covered_from IS NULL OR covered_to IS NULL OR covered_from>${literal(question.from)} OR covered_to<${literal(question.to)}`;
  const value = question.metric === 'complete_card_spending'
    ? `CASE WHEN NOT EXISTS(SELECT 1 FROM account_coverage) OR EXISTS(SELECT 1 FROM account_coverage WHERE ${limits}) THEN NULL ELSE ${aggregate.card_spending} END`
    : aggregate[question.metric];
  assert.ok(value, `SQL exists for ${question.metric}`);
  return `WITH selected AS (SELECT * FROM txn WHERE ${scope.join(' AND ')} AND posted_on BETWEEN ${literal(question.from)} AND ${literal(question.to)}),
account_coverage AS (SELECT * FROM coverage WHERE ${scope.join(' AND ')})
SELECT ${value} AS value_minor,
  (SELECT count(*) FROM account_coverage) AS coverage_accounts,
  (SELECT COALESCE(SUM(row_count),0) FROM account_coverage) AS coverage_rows,
  (SELECT count(*) FROM account_coverage WHERE ${limits}) AS incomplete_accounts,
  (SELECT json_group_array(json_object('account',account_slug,'status',coverage_status,'from',covered_from,'to',covered_to,'rows',row_count,'unreadable',unreadable_rows,'unconfirmed',unconfirmed_rows,'last_sync',last_sync)) FROM account_coverage) AS coverage_json,
  json_group_array(json_object('uid',txn_uid,'amount_minor',amount_minor,'direction',direction,'money_kind',money_kind,'classification',movement_classification,'estimated',estimated,'income_minor',income_minor,'expense_minor',expense_minor)) AS evidence_json
FROM selected`;
}

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const sql of migrations) db.exec(sql);
  const calls = [];
  const env = { STORAGE: 'd1',
    // Ephemeral local authentication fixture only; no credential store or real
    // account is accessed, and this value never appears in SQL/output/report.
    ADMIN_KEY: randomBytes(24).toString('hex'), DB: {
      prepare(sql) {
        calls.push(sql);
        const statement = db.prepare(sql);
        const bound = args => ({
          async all() { return { success: true, results: statement.all(...args) }; },
          async first() { return statement.get(...args) ?? null; },
        });
        return { ...bound([]), bind: (...args) => bound(args) };
      },
    } };
  const raw = (sql, ...args) => db.prepare(sql).run(...args);
  for (const [slug, kind] of [['business', 'business'], ['personal', 'household']]) {
    raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,provenance,basis_state,recorded_at)
      VALUES (?,?,?,'owner_stated','confirmed',?)`, slug, `Owner ${slug}`, kind, NOW);
  }
  function seed(book, rows = book.rows) {
    raw('DELETE FROM fin_transactions');
    raw('DELETE FROM fin_account_coverage');
    raw('DELETE FROM fin_accounts');
    for (const a of book.accounts) {
      raw(`INSERT INTO fin_accounts(account_slug,entity_slug,label,account_kind,balance_role,mask,currency,feed_mode,status,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,'owner_stated','confirmed',?)`, a.slug, a.side, a.slug,
      a.kind, a.kind === 'card' ? 'liability' : 'asset', a.mask, a.currency, a.feed,
      a.feed === 'none' ? 'never_connected' : 'open', NOW);
      raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,basis_note,computed_at,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,'owner_stated','confirmed',?)`, a.slug, a.coverage, a.from, a.to,
      a.coverage === 'complete' ? 'Synthetic owner book complete for stated interval.' : 'Owner card is not connected.', NOW, NOW);
    }
    for (const r of rows) {
      raw(`INSERT INTO fin_transactions(txn_uid,account_slug,posted_on,amount_minor,direction,currency,description,payee,category,category_basis_state,pending,removed_at,removal_reason,superseded_by_id,source_provider,provenance,basis_state,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?,?,'owner_stated','confirmed',?)`,
      r.uid, r.account, r.day, r.cents, r.direction, r.currency, r.description, r.payee, r.category,
      Number(r.pending), r.removed ? NOW : null, r.removed ? 'Synthetic provider removal' : null,
      r.superseded ? 999999 : null, 'simplefin', NOW);
    }
  }
  async function ask(sql) {
    const before = calls.length;
    let response, body;
    try {
      response = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/money-query', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY },
        body: JSON.stringify({ sql, max_rows: 1000 }),
      }), env, {});
      body = await response.json();
    } catch {
      return { status: 0, code: 'ROUTE_EXCEPTION_OR_NON_JSON' };
    }
    if (response.status !== 200) return { status: response.status, code: body.code ?? 'ROUTE_REFUSAL' };
    assert.equal(body.truncated, false, 'a scalar total must never be truncated');
    assert.equal(body.rows.length, 1, 'each owner SQL query returns its scalar plus coverage');
    assert.ok(calls.slice(before).some(sql => sql.startsWith('EXPLAIN ')), 'real SQL validation ran');
    assert.ok(calls.slice(before).some(sql => sql.includes('snapshot_kind')), 'real clean snapshot ran');
    const result = body.rows[0];
    const figures = Object.fromEntries(['value_minor', 'coverage_accounts', 'coverage_rows', 'incomplete_accounts'].map(key => [key, result[key]]));
    assert.ok(Object.values(figures).every(value => value === null || Number.isSafeInteger(value)), 'integer arithmetic or explicit unknown');
    return { status: response.status, confidence:body.confidence, figures, coverage: JSON.parse(result.coverage_json), evidence: JSON.parse(result.evidence_json) };
  }
  return { seed, ask };
}

function outcome(expected, actual) {
  return actual.status !== 200 ? 'failed' : isDeepStrictEqual(actual.figures, expected) ? 'right' : 'wrong';
}
function cause(rows, actual) {
  if (rows.some(refund => refund.event === 'refund' &&
      actual.evidence?.some(r => r.uid === refund.uid && r.money_kind !== 'refund'))) {
    return 'worker/src/lib/clean-money.js:247 delegates membership to the shared classifier and :135 copies its money_kind. '
      + 'worker/src/lib/ledger-analysis.js:323 reads description and category only; the refund keyword test is at :324. '
      + 'merchant return, returned purchase, reversed, and a refund stated only in payee miss that test. '
      + 'Unknown card credits become card_payment at worker/src/lib/ledger-analysis.js:343. '
      + 'The resulting tag removes the credit from a refund sum and can add it to a repayment sum.';
  }
  if (rows.some(payment => payment.event === 'payment_out' &&
      actual.evidence?.some(r => r.uid === payment.uid && r.money_kind === 'ordinary'))) {
    return 'worker/src/lib/clean-money.js:155 includes every ordinary outflow in expense_minor; :247 uses the shared classifier. '
      + 'worker/src/lib/ledger-analysis.js:302 requires a payment category or :305 a resolved owned liability; '
      + ':346 has a bounded memo-prefix list and :351 rejects an independent issuer payee unless it matches a known liability. '
      + 'A clearly described payment to an unconnected card can therefore stay ordinary spending and disappear from card_payment totals.';
  }
  if (rows.some(credit => credit.event === 'other_credit' &&
      actual.evidence?.some(r => r.uid === credit.uid && r.money_kind === 'card_payment'))) {
    return 'worker/src/lib/clean-money.js:247 uses moneyMovementReading, and :135 copies its kind. '
      + 'worker/src/lib/ledger-analysis.js:343 provisionally tags every unknown card inflow as card_payment. '
      + 'A reward credit with no recognized income keyword is therefore counted as repayment rather than a separate nonpayment card credit.';
  }
  return 'worker/src/lib/clean-money.js:148-155 projects the classified membership into income_minor/expense_minor; '
    + ':165-182 projects retained rows and declared coverage. Inspect the reproduced row and its evidence below.';
}

async function minimize(f, finding) {
  let rows = finding.book.rows;
  // Keep the question, accounts and declared coverage fixed. Delete rows only
  // when the same outcome still reproduces against a freshly computed oracle.
  for (let i = 0; i < rows.length;) {
    const candidate = rows.filter((_, j) => j !== i);
    f.seed(finding.book, candidate);
    const actual = await f.ask(finding.sql);
    if (outcome(oracle(finding.book, finding.question, candidate), actual) === finding.outcome) rows = candidate;
    else i++;
  }
  f.seed(finding.book, rows);
  const actual = await f.ask(finding.sql), expected = oracle(finding.book, finding.question, rows);
  assert.equal(outcome(expected, actual), finding.outcome, 'minimal input replays through the real route');
  // A second pass proves single-row-deletion minimality after the last edit.
  for (let i = 0; i < rows.length; i++) {
    const candidate = rows.filter((_, j) => j !== i);
    f.seed(finding.book, candidate);
    assert.notEqual(outcome(oracle(finding.book, finding.question, candidate), await f.ask(finding.sql)), finding.outcome,
      'every retained transaction is necessary to reproduce the finding');
  }
  return { ...finding, rows, expected, actual };
}

function render(counts, perBook, witnesses) {
  const lines = ['READY', `questions=${counts.questions} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}`, '',
    `Ran ${books.length} synthetic owner books through worker.fetch POST /api/admin/brain/money-query on node:sqlite with every shipped D1 migration. Each question has explicit calendar dates and one currency. No network or real credentials.`, '',
    `Handwritten assistant SQL uses txn and coverage. The independent oracle adds integer cents by synthetic bookkeeper event; it never calls product classification or SQL. All ${counts.questions} questions are written in the test file. Coverage counts are also compared. Null means missing history, not zero purchases. value_minor is cents except card_count, which is a row count. Net expenses subtract labeled synthetic return events; they do not claim provider-certified refunds or tax profit.`, '',
    'This is a SQL/clean-view finder, not a live Claude or connector test. READY means the finder completed; wrong figures and route refusals are findings, not a product readiness verdict.', '',
    ...perBook.map(b => `${b.name}: questions=${b.questions} right=${b.right} wrong=${b.wrong} failed=${b.failed}`), '',
    'At most ten representative failures follow. Inputs are transaction-row deletion minimal with the question, account definitions and coverage fixed. Each expected answer below is recomputed for its reduced rows, not copied from the original book.', ''];
  for (const [i, w] of witnesses.entries()) {
    lines.push(`${i + 1}. ${w.outcome}: ${w.question.question}`,
      `Period: ${w.question.from} through ${w.question.to}; currency=${w.question.currency}; side=${w.question.side ?? 'both'}; accounts=${JSON.stringify(w.question.accounts ?? 'all in scope')}.`,
      `Accounts: ${JSON.stringify(w.book.accounts)}`,
      `Rows (event is oracle-only): ${JSON.stringify(w.rows)}`,
      `Expected: ${JSON.stringify(w.expected)}`,
      `Actual SQL result: ${JSON.stringify(w.actual)}`,
      `Clean-view rule: ${w.outcome === 'wrong' ? cause(w.rows, w.actual) : 'Route returned an error/refusal; no numeric answer.'}`,
      '```sql', w.sql, '```', '');
  }
  lines.push('LANE PRO-TOOLS-FINDER-CARDS-1112: READY');
  return lines.join('\n') + '\n';
}

test('card tool finder: independent owner books against the real money SQL route', async t => {
  const counts = { questions: 0, right: 0, wrong: 0, failed: 0 }, findings = [], perBook = [];
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('Finder forbids network'); });
  try {
    const f = fixture(t), unique = new Set();
    assert.ok(books.length >= 8);
    for (const book of books) {
      f.seed(book);
      const tally = { name: book.name, questions: 0, right: 0, wrong: 0, failed: 0 };
      for (const question of book.questions) {
        assert.ok(!unique.has(question.question), 'owner questions are distinct');
        unique.add(question.question);
        const sql = sqlFor(question), expected = oracle(book, question), actual = await f.ask(sql);
        const result = outcome(expected, actual);
        const c=actual.confidence;
        assert.ok(c && Number.isInteger(c.percent) && c.percent>=0 && c.percent<=100,'every finder answer is scored');
        if(c.percent<100) assert.ok(c.reasons.length && c.missing.length,'every sub-100 answer explains why and what is missing');
        if(result==='wrong') assert.ok(c.percent<90,'an incorrect High-confidence figure is a ship blocker');
        counts.questions++; counts[result]++; tally.questions++; tally[result]++;
        if (result !== 'right') findings.push({ book, question, sql, expected, actual, outcome: result });
        t.diagnostic(`${result}: ${question.question} expected=${expected.value_minor} actual=${actual.figures?.value_minor ?? (actual.status === 200 ? 'null' : actual.code)} confidence=${c.level} (${c.percent}%)`);
      }
      perBook.push(tally);
    }
    assert.ok(counts.questions >= 60);
    assert.equal(unique.size, counts.questions);
    assert.equal(counts.right + counts.wrong + counts.failed, counts.questions);
    assert.ok(counts.right > 0, 'positive control reached actual answers');
    // Minimize every failure before selecting report examples. Prefer distinct
    // failing bank descriptions so a new grammar gap is not crowded out by
    // several totals affected by the same one-row classification error.
    const minimal = [];
    for (const finding of findings) minimal.push(await minimize(f, finding));
    const rowKey = w => JSON.stringify(w.rows.map(r => [r.event, r.description, r.payee, r.category]));
    const distinctRows = new Map(), distinctFigures = new Map();
    for (const witness of minimal) {
      const key = rowKey(witness);
      if (!distinctRows.has(key)) distinctRows.set(key, witness);
      if (!distinctFigures.has(key + ':' + witness.question.metric)) distinctFigures.set(key + ':' + witness.question.metric, witness);
    }
    const witnesses = [...new Set([...distinctRows.values(), ...distinctFigures.values()])].slice(0, 10);
    assert.equal(networkCalls, 0, 'no network access attempted');
    writeFileSync(REPORT, render(counts, perBook, witnesses));
    t.diagnostic(`books=${books.length} questions=${counts.questions} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed} minimal_inputs=${witnesses.length}`);
  } catch (error) {
    // Do not leave an earlier READY report behind if the harness cannot finish.
    writeFileSync(REPORT, `NOT READY\nquestions=${counts.questions} right=${counts.right} wrong=${counts.wrong} failed=${counts.failed}\n\nFinder did not complete; inspect the local node --test failure.\nLANE PRO-TOOLS-FINDER-CARDS-1112: NOT READY finder did not complete\n`);
    throw error;
  }
});
