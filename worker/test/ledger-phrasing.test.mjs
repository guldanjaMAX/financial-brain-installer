import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { classifyLedgerQuestion, shiftLedgerDay } from "../src/lib/ledger-question.js";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { linkAccounts } from "./fixtures/money-fix/fixture.mjs";

const NOW = "2026-10-12T12:00:00.000Z";
const SEP = ["2026-09-01", "2026-09-30"];
const SIXTY = ["2026-08-14", "2026-10-12"];
const RECENT = ["2026-09-29", "2026-10-12"];
const MONTH = ["2026-10-01", "2026-10-12"];
const corpus = [];
const add = (kind, window, questions, mask = null, extra = {}) => {
  for (const question of questions) corpus.push({ question, kind, window, mask, extra });
};
// The eight field-observed shapes, exercised only against synthetic accounts.
add("balance", [], ["What is my current balance in the account ending 4417?"], "4417");
add("totals", SEP, [
  "How much money came in and went out of the account ending 8862 in September 2026?",
  "How much money came into account 8862 in September 2026?",
], "8862");
add("largest", SEP, ["What were my largest expenses in September 2026?", "What were my largest expenses last month?"]);
add("deposits", RECENT, ["What were my recent deposits?", "Show my recent deposits over the last 14 days."]);
add("deposits", SEP, ["Show my recent deposits in September 2026?"]);
add("payment", ["2026-10-01", "2026-10-31"], ["Did a payment of $2,500 arrive in my account ending 8862 in October 2026?"], "8862", { amountMinor: 250000 });
add("payment", SIXTY, ["Did the Paywire payment hit my bank account?"], null, { counterpartyWords: ["paywire"] });
add("totals", SEP, ["How much money came in and went out in September 2026?"]);
// Audit items 1, 3-7, 10, 14-16 have deterministic ledger operations.
add("payment", SIXTY, [
  "Did the Paywire payment from Fixture Payer reach account 4417, and when?",
  "Has the payment from Fixture Payer via Paywire posted in account ending 4417?",
], "4417", { counterpartyWords: ["paywire", "fixture", "payer"] });
add("balance", [], ["What is the current balance in each bank account?", "Show me all my bank balances.", "What are my checking balances?", "What is my current savings balance?"]);
add("totals", SEP, ["How much income came in during September 2026, by account?", "Show me money in for September 2026 by account.", "How much money came in during September 2026?", "Show me income in September 2026."]);
add("expense_summary", SEP, ["What was my spending last month?", "How much money went out last month?", "What did I spend in September 2026?", "How much did I spend in September 2026?", "What were my expenses in September 2026?"]);
add("category", SEP, ["What was my spending in September 2026 by category?", "Show my spending in September 2026, top categories.", "What were my top spending categories last month?", "Show me spending by category in September 2026."]);
add("largest", SIXTY, ["What were my ten largest expenses in the last 60 days?", "Show me the 10 biggest expenses over the last 60 days.", "List my top 10 expenses in the last 60 days.", "What were my biggest expenses in the last 60 days?"]);
add("largest", SEP, ["Show me my top expenses last month.", "List my largest charges in September 2026.", "What were my 3 biggest deposits in September 2026?"]);
add("recurring", ["2026-06-15", "2026-10-12"], ["What recurring subscriptions am I paying for, and how much per month?", "Show me recurring subscriptions and the monthly total.", "What are my subscriptions and their monthly total?", "List my recurring charges.", "Show me my subscriptions."]);
add("deposits", RECENT, ["What deposits came in over the last 14 days?", "Show me deposits in the last 14 days.", "List my recent deposits.", "What are my recent deposits?", "Which deposits came in over the last 14 days?"]);
add("category", ["2026-07-01", "2026-09-30"], ["How much did I spend on software/SaaS in Q3 2026?", "Show me software/SaaS spend in Q3 2026.", "What was my software spending in Q3 2026?"]);
add("merchant", SEP, ["How much did I spend at Amazon in September 2026?", "Show me Amazon spend in September 2026.", "What was my Amazon spending last month?"]);
add("transfers", SEP, ["How much did I transfer between my own accounts last month?", "Show me transfers between my own accounts last month.", "List my own-account transfers in September 2026."]);
add("totals", MONTH, ["How much money came in this month?"]);
add("expense_summary", MONTH, ["How much did I spend this month?"]);
add("totals", ["2026-01-01", "2026-10-12"], ["How much money came in so far this year?", "Show me money in and out in 2026 so far."]);
add("totals", SEP, ["How much money came into my checking account ending 8862 last month?"], "8862");
add("expense_summary", SEP, ["What did I spend in account 8862 in September 2026?"], "8862");
add("payment", SIXTY, ["Did the payment from Fixture Payer arrive?", "Has the payment from Fixture Payer cleared?", "Did the Fixture Payer payment post?", "Did the payment from Fixture Payer reach my bank account?"], null, { counterpartyWords: ["fixture", "payer"] });
add("payment", ["2026-09-13", "2026-10-12"], ["Did a payment of $2,500 clear?", "Has the $2,500 payment posted?"], null, { amountMinor: 250000 });
add("payment", SEP, ["Did the Paywire payment arrive in September 2026?", "Has the Paywire payment cleared last month?"], null, { counterpartyWords: ["paywire"] });
// Named banks remain unsupported, rather than silently selecting all banks.
// The pinned product has no conversational ordinal, entity selector, average,
// anomaly or runway operation. These audit premises stay on the document path.
const documents = [
  "Did the second payment arrive?", "Has my second payment posted?",
  "Which account pays my car loan, and what is the balance?", "What is my car loan payment account and loan balance?",
  "What bills are due in the next 30 days?", "Show my bills coming due over the next month.",
  "How much money came in and went out for the store entity in 2026 so far?", "Show the store business income versus spending so far this year.",
  "What was my average monthly spend over the last 3 months?", "How much do I spend per month on average for the past 3 months?",
  "Were there duplicate or unusual charges in the last 60 days?", "Show suspicious charges and duplicate payments over the last 60 days.",
  "Who owes me money?", "What receivables are still owed to me?",
  "Is every 2025 bank statement present?", "Which bank statements are missing for 2025?",
  "What 2025 tax documents are missing?", "Do I have all my tax documents for 2025?",
  "How many months of cash runway do I have?", "How long will my cash last at the current spending rate?",
  "What is the balance in my Fixture Bank account?", "Did a payment of $2,500 arrive in my Fixture Bank account?",
  "How do I balance work and rest?",
];

const EVERYDAY_ROWS = [
  {
    id: "D-R1",
    question: "Did Payer Unit pay?",
    control: "Did the payment from Payer Unit arrive?",
    negative: "Did the second payer pay?",
    expected: { kind: "payment", from: "2026-08-14", to: "2026-10-12", amountMinor: null, counterpartyWords: ["payer", "unit"] },
  },
  {
    id: "D-R2",
    question: "Has Payer Unit paid?",
    control: "Has the payment from Payer Unit posted?",
    negative: "Has payroll been paid?",
    expected: { kind: "payment", from: "2026-08-14", to: "2026-10-12", amountMinor: null, counterpartyWords: ["payer", "unit"] },
  },
  {
    id: "D-R3",
    question: "Did Payer Unit pay in the past month?",
    control: "Did the payment from Payer Unit arrive in the last 30 days?",
    negative: "Did Payer Unit pay in the past 2 months?",
    expected: { kind: "payment", from: "2026-09-13", to: "2026-10-12", amountMinor: null, counterpartyWords: ["payer", "unit"] },
  },
  {
    id: "D-R4",
    question: "Has Payer Unit paid in the last 30 days?",
    control: "Has the payment from Payer Unit posted in the last 30 days?",
    negative: "Has Payer Unit paid in the last 0 days?",
    expected: { kind: "payment", from: "2026-09-13", to: "2026-10-12", amountMinor: null, counterpartyWords: ["payer", "unit"] },
  },
  {
    id: "D-R5",
    question: "Did Payer Unit pay in September?",
    control: "Did the payment from Payer Unit arrive in September 2026?",
    negative: "Did Payer Unit pay in September or October?",
    expected: { kind: "payment", from: "2026-09-01", to: "2026-09-30", amountMinor: null, counterpartyWords: ["payer", "unit"] },
  },
  {
    id: "D-R6",
    question: "Was I paid by Payer Unit in September?",
    control: "Did the payment from Payer Unit arrive in September 2026?",
    negative: "Was the invoice paid in September?",
    expected: { kind: "payment", from: "2026-09-01", to: "2026-09-30", amountMinor: null, counterpartyWords: ["payer", "unit"] },
  },
  {
    id: "D-R7",
    question: "Did I get paid $123.45 in the past month?",
    control: "Did the payment of $123.45 arrive in the last 30 days?",
    negative: "Did I get paid about $123.45 in the past month?",
    expected: { kind: "payment", from: "2026-09-13", to: "2026-10-12", amountMinor: 12345, counterpartyWords: [] },
  },
  {
    id: "D-R8",
    question: "Were we paid $123.45 in the last 30 days?",
    control: "Did the payment of $123.45 arrive in the last 30 days?",
    negative: "Were we paid $123.45 or $234.56 in the last 30 days?",
    expected: { kind: "payment", from: "2026-09-13", to: "2026-10-12", amountMinor: 12345, counterpartyWords: [] },
  },
  {
    id: "D-R9",
    question: "How much did I spend in the past month?",
    control: "How much did I spend in the last 30 days?",
    negative: "How much did I spend in the past 2 months?",
    expected: { kind: "expense_summary", from: "2026-09-13", to: "2026-10-12", amountMinor: undefined, counterpartyWords: undefined },
  },
  {
    id: "D-R10",
    question: "How much money came in over the past month?",
    control: "How much money came in over the last 30 days?",
    negative: "How much money came in over the past year?",
    expected: { kind: "totals", from: "2026-09-13", to: "2026-10-12", amountMinor: undefined, counterpartyWords: undefined },
  },
];

const comparableIntent = intent => ({
  kind: intent.kind,
  from: intent.from,
  to: intent.to,
  amountMinor: intent.amountMinor,
  counterpartyWords: intent.counterpartyWords,
});

for (const row of EVERYDAY_ROWS) test(`${row.id}: reviewed everyday form stays bounded`, () => {
  const decisions = { classifier: 0, window: 0 };
  const classify = question => {
    decisions.classifier++;
    const intent = classifyLedgerQuestion(question, { now: NOW });
    if (intent.from && intent.to) decisions.window++;
    return intent;
  };
  const control = classify(row.control);
  const actual = classify(row.question);
  const negative = classify(row.negative);
  assert.deepEqual(comparableIntent(control), row.expected, `${row.id} canonical control`);
  assert.equal(decisions.classifier, 3, `${row.id} classifier decision count`);
  assert.equal(negative.kind, null, `${row.id} negative sibling stays on documents`);
  assert.deepEqual(comparableIntent(actual), row.expected,
    `${row.id} classifier=${decisions.classifier} window=${decisions.window}`);
  assert.notEqual(actual.kind, negative.kind, `${row.id} routing outcomes must not be uniform`);
});

test("anchored bare months stay in the current owner year without widening arrival grammar", () => {
  for (const question of ["Did Payer Unit pay in October?", "Was I paid by Payer Unit in October?"]) {
    const current = classifyLedgerQuestion(question, { now: NOW });
    assert.deepEqual([current.kind, current.from, current.to], ["payment", "2026-10-01", "2026-10-12"], question);
  }
  for (const question of [
    "Did Payer Unit pay in November?",
    "Was I paid by Payer Unit in November?",
    "Did the payment from Payer Unit arrive in September?",
    "Do we pay Payer Unit?",
    "What were my largest expenses in the past month?",
    "How much income came in during the past month?",
  ]) assert.equal(classifyLedgerQuestion(question, { now: NOW }).kind, null, question);
});

for (const row of corpus) test(`phrasing: ${row.question}`, () => {
  const result = classifyLedgerQuestion(row.question, { now: NOW });
  assert.equal(result.kind, row.kind);
  assert.equal(result.mask ?? null, row.mask);
  assert.deepEqual([result.from, result.to], row.window.length ? row.window : [undefined, undefined]);
  for (const [key, value] of Object.entries(row.extra)) assert.deepEqual(result[key], value);
});
test("corpus has at least sixty supported natural phrasings", () => assert.ok(corpus.length >= 60));
for (const question of documents) test(`document routing: ${question}`, () => {
  assert.equal(classifyLedgerQuestion("What is my current balance?", { now: NOW }).kind, "balance", "green classifier control");
  const result = classifyLedgerQuestion(question, { now: NOW });
  assert.equal(result.kind, null);
  assert.equal(result.mask ?? null, null);
  assert.deepEqual([result.from, result.to], [undefined, undefined]);
});

test("C-R1: owner evening drives current, recurring, and payment windows", () => {
  const now = "2026-10-01T02:30:00Z";
  const zone = "America/Phoenix";
  const cases = [
    ["How much money came in this month?", "2026-09-01", "2026-09-30"],
    ["How much money came in September 2026?", "2026-09-01", "2026-09-30"],
    ["What are my recurring charges?", "2026-06-03", "2026-09-30"],
    ["Did the payment from Fixture Payer arrive?", "2026-08-02", "2026-09-30"],
  ];
  let windowDecisions = 0;
  for (const [question, from, to] of cases) {
    const intent = classifyLedgerQuestion(question, { now, timeZone: zone });
    assert.ok(intent.kind, `${question}: grammar decision reached`);
    assert.deepEqual([intent.from, intent.to], [from, to]);
    assert.equal(intent.timeZone, zone);
    windowDecisions++;
  }
  const utcCurrent = classifyLedgerQuestion("How much money came in this month?", { now, timeZone: "UTC" });
  const utcRecurring = classifyLedgerQuestion("What are my recurring charges?", { now, timeZone: "UTC" });
  const utcPayment = classifyLedgerQuestion("Did the payment from Fixture Payer arrive?", { now, timeZone: "UTC" });
  const utcNamed = classifyLedgerQuestion("How much money came in October 2026?", { now, timeZone: "UTC" });
  for (const intent of [utcCurrent, utcRecurring, utcPayment]) assert.equal(intent.to, "2026-10-01");
  assert.equal(utcNamed.to, "2026-10-31", "an explicit month and year keeps its fixed calendar end");
  assert.equal(windowDecisions, 4, "all four window decisions were reached");
});

test("C-R2: rolling days stay calendar-exact across spring and fall transitions", () => {
  const cases = [
    ["2026-03-08T04:30:00Z", true],
    ["2026-03-08T06:59:00Z", false],
    ["2026-03-08T07:01:00Z", false],
    ["2026-11-01T03:30:00Z", true],
    ["2026-11-01T05:59:00Z", false],
    ["2026-11-01T06:01:00Z", false],
  ];
  let differingOwnerDays = 0, matchingOwnerDays = 0;
  for (const [now, differs] of cases) {
    const owner = classifyLedgerQuestion("How much money came in in the last 30 days?", {
      now, timeZone: "America/New_York",
    });
    const utc = classifyLedgerQuestion("How much money came in in the last 30 days?", { now, timeZone: "UTC" });
    const days = [];
    for (let day = owner.from; day <= owner.to; day = shiftLedgerDay(day, 1)) days.push(day);
    assert.equal(days.length, 30, `${now}: exactly thirty inclusive owner dates`);
    assert.equal(new Set(days).size, 30, `${now}: no duplicate owner date`);
    assert.equal(days.at(-1), owner.to, `${now}: no missing owner date`);
    assert.equal(owner.timeZone, "America/New_York");
    assert.equal(JSON.stringify([owner.from, owner.to]) !== JSON.stringify([utc.from, utc.to]), differs);
    if (differs) differingOwnerDays++; else matchingOwnerDays++;
  }
  assert.equal(differingOwnerDays, 2, "evening boundary controls differ");
  assert.equal(matchingOwnerDays, 4, "transition controls with the same calendar day stay equal");
});

test("C-R3: owner year boundary and explicit historical dates remain distinct", () => {
  const now = "2035-01-01T02:30:00Z";
  const zone = "America/Phoenix";
  const lastMonth = classifyLedgerQuestion("What was my profit last month?", { now, timeZone: zone });
  const yearToDate = classifyLedgerQuestion("How much money came in so far this year?", { now, timeZone: zone });
  const payment = classifyLedgerQuestion("Did the payment from Fixture Payer arrive?", { now, timeZone: zone });
  assert.deepEqual([lastMonth.from, lastMonth.to], ["2034-11-01", "2034-11-30"]);
  assert.deepEqual([yearToDate.from, yearToDate.to], ["2034-01-01", "2034-12-31"]);
  assert.deepEqual([payment.from, payment.to], ["2034-11-02", "2034-12-31"]);
  for (const intent of [lastMonth, yearToDate, payment]) assert.equal(intent.timeZone, zone);

  const historical = classifyLedgerQuestion("What was my profit in November 2034?", {
    now, timeZone: "Invalid/Zone",
  });
  assert.deepEqual([historical.kind, historical.from, historical.to], ["totals", "2034-11-01", "2034-11-30"]);
  assert.equal(historical.ownerTimeZoneUnavailable, undefined);
  const explicitPayment = classifyLedgerQuestion("Did the payment of $120.01 arrive on 2034-11-15?", {
    now, timeZone: "Invalid/Zone",
  });
  assert.deepEqual([explicitPayment.from, explicitPayment.to], ["2034-11-08", "2034-11-22"]);

  const invalidDerived = classifyLedgerQuestion("What was my profit last month?", {
    now, timeZone: "Invalid/Zone",
  });
  assert.equal(invalidDerived.kind, "totals", "derived grammar decision reached");
  assert.equal(invalidDerived.ownerTimeZoneUnavailable, true);
  assert.deepEqual([invalidDerived.from, invalidDerived.to], [undefined, undefined]);
});

test("item C explicit-window invariance table keeps fixed bounds without an owner zone", () => {
  const explicitCases = [
    ["owner-day boundary", "2026-10-01T02:30:00Z", "How much money came in October 2026?", "2026-10-01", "2026-10-31"],
    ["month end", "2026-10-31T23:30:00Z", "How much money came in October 2026?", "2026-10-01", "2026-10-31"],
    ["year end", "2034-12-31T23:30:00Z", "How much money came in December 2034?", "2034-12-01", "2034-12-31"],
    ["leap day", "2024-02-29T12:00:00Z", "How much money came in February 2024?", "2024-02-01", "2024-02-29"],
  ];
  const zoneStates = [["valid owner-day-different", "America/Phoenix"], ["missing", null], ["invalid", "Invalid/Zone"]];
  const armOutcomes = [];
  let classificationDecisions = 0, boundDecisions = 0;
  for (const [edge, now, question, from, to] of explicitCases) {
    for (const [zoneState, timeZone] of zoneStates) {
      const intent = classifyLedgerQuestion(question, { now, timeZone });
      assert.equal(intent.kind, "totals", `${edge} ${zoneState}: classification decision reached`);
      classificationDecisions++;
      assert.equal(intent.ownerTimeZoneUnavailable, undefined, `${edge} ${zoneState}: explicit bounds do not need an owner day`);
      assert.deepEqual([intent.from, intent.to], [from, to], `${edge} ${zoneState}: fixed date-only bounds`);
      boundDecisions++;
      armOutcomes.push("usable");
    }
  }

  let historicalControls = 0;
  for (const [zoneState, timeZone] of zoneStates.slice(1)) {
    const historical = classifyLedgerQuestion("How much money came in September 2026?", {
      now: "2026-10-01T02:30:00Z", timeZone,
    });
    assert.equal(historical.kind, "totals", `${zoneState}: historical classification reached`);
    assert.deepEqual([historical.from, historical.to], ["2026-09-01", "2026-09-30"]);
    assert.equal(historical.ownerTimeZoneUnavailable, undefined);
    historicalControls++;
  }

  const derivedCases = [
    ["current month", "How much money came in this month?"],
    ["last month", "How much money came in last month?"],
    ["rolling days", "How much money came in in the last 30 days?"],
    ["year to date", "How much money came in so far this year?"],
    ["explicit current year to date", "Show me money in and out in 2026 so far."],
  ];
  let refusalDecisions = 0;
  for (const [zoneState, timeZone] of zoneStates.slice(1)) {
    for (const [period, question] of derivedCases) {
      const intent = classifyLedgerQuestion(question, { now: "2026-10-01T02:30:00Z", timeZone });
      assert.equal(intent.kind, "totals", `${period} ${zoneState}: classification decision reached`);
      assert.equal(intent.ownerTimeZoneUnavailable, true, `${period} ${zoneState}: refusal decision reached`);
      assert.deepEqual([intent.from, intent.to], [undefined, undefined]);
      refusalDecisions++;
      armOutcomes.push("refused");
    }
  }
  assert.equal(classificationDecisions, explicitCases.length * zoneStates.length);
  assert.equal(boundDecisions, explicitCases.length * zoneStates.length);
  assert.equal(historicalControls, 2);
  assert.equal(refusalDecisions, derivedCases.length * 2);
  assert.equal(new Set(armOutcomes).size, 2, "usable and refused arms must not collapse to a uniform outcome");
});

async function fixture(t, reverse = false) {
  t.mock.method(Date, "now", () => Date.parse(NOW));
  const f = await createProductFixture({ env: { ADMIN_KEY: randomBytes(24).toString("hex"),
    SESSION_SIGNING_KEY: randomBytes(32).toString("hex"), BRAIN_TIMEZONE: "UTC",
    AI: { async run() { return { response: "No document answer." }; } } } });
  t.after(() => f.close());
  seedOwnedEntity(f, "owner", "Owner");
  f.raw(`INSERT INTO bank_feed_items (item_ref,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('synthetic-feed',?,?,'sandbox','2026-10-01T00:00:00Z',?)`, randomBytes(32).toString("base64"), randomBytes(12).toString("base64"), NOW);
  f.raw(`INSERT INTO bank_feed_backfill (item_ref,requested_days,state,queued_at,finished_at,provider_history_state)
    VALUES ('synthetic-feed',730,'complete','2026-10-01T00:00:00Z',?,'HISTORICAL_UPDATE_COMPLETE')`, NOW);
  const emptySlug = reverse ? "zz-empty" : "empty";
  const specs = [["manual-a", "4417", "manual"], ["live-a", "4417", "live"], ["manual-b", "8862", "manual"], ["live-b", "8862", "live"], [emptySlug, "0002", "live"]];
  for (const [slug, mask, mode] of reverse ? specs.reverse() : specs) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at,institution)
      VALUES (?,'owner',?,'asset',?,?,'feed','bank-feed:synthetic-feed','confirmed',?,'Synthetic Bank')`, slug, slug === emptySlug ? "other" : "checking", mask, mode, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'complete',?,'2026-10-12',?,'feed','bank-feed:synthetic-feed','confirmed',?)`, slug, slug === emptySlug ? null : "2025-11-01", NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'2026-10-12',?,'feed','bank-feed:synthetic-feed','confirmed',?)`, slug, slug === emptySlug ? 0 : 98765, NOW);
  }
  f.add = (uid, slug, date, cents, direction = "inflow", description = "Synthetic payer", payee = null) => f.raw(
    `INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'feed','bank-feed:synthetic-feed','confirmed',?)`, uid, slug, date, cents, direction, description, payee, NOW);
  for (const slug of ["manual-a", "live-a", "manual-b", "live-b"]) {
    f.add(`${slug}-credit`, slug, "2026-09-15", slug.endsWith("a") ? 10001 : 250000);
    f.add(`${slug}-debit`, slug, "2026-09-20", slug.endsWith("a") ? 12345 : 6789, "outflow");
  }
  f.add("arrived", "live-b", "2026-10-05", 250000, "inflow", "Paywire settlement", "Fixture Payer");
  f.add("wrong-direction", "live-b", "2026-10-06", 901, "outflow", "Paywire fee");
  f.add("partial-word", "live-b", "2026-10-07", 902, "inflow", "Paywirerate receipt");
  f.add("payee-match", "live-a", "2026-10-08", 1234, "inflow", "Settlement", "Paywire");
  for (const suffix of ["a", "b"]) {
    const linked = await linkAccounts(f, `manual-${suffix}`, `live-${suffix}`);
    assert.equal(linked.complete, true, "approved twin link reached");
  }
  f.ask = async question => (await f.post("/api/rag/think", { q: question }, { "X-Admin-Key": f.env.ADMIN_KEY })).json();
  return f;
}

for (const reverse of [false, true]) test(`Think exact cents and empty-account coverage, insertion order ${reverse}`, async t => {
  const f = await fixture(t, reverse);
  let modelCalls = 0;
  f.env.AI.run = async () => { modelCalls++; throw new Error("ledger must not call a model"); };
  const scoped = await f.ask(corpus[1].question);
  assert.deepEqual(scoped.ledger?.accounts.map(a => [a.account_mask, a.credits_minor, a.debits_minor]), [["8862", 250000, 6789]]);
  const all = await f.ask("How much money came in and went out in September 2026?");
  assert.deepEqual(all.ledger?.accounts.map(a => [a.account_mask, a.credits_minor, a.debits_minor]).sort(), [["0002", 0, 0], ["4417", 10001, 12345], ["8862", 250000, 6789]]);
  const largest = await f.ask("What were my largest expenses last month?");
  assert.deepEqual(largest.ledger?.rows.map(r => r.amount_minor), [12345, 6789]);
  const recent = await f.ask("What were my recent deposits?");
  assert.deepEqual(recent.ledger?.rows.map(r => r.amount_minor), [1234, 902, 250000]);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-10-31' WHERE account_slug IN ('manual-b','live-b')");
  const amount = await f.ask("Did a payment of $2,500 arrive in my account ending 8862 in October 2026?");
  assert.equal(amount.ledger?.found, true); assert.deepEqual(amount.citations.map(c => c.amount_minor), [250000]);
  const named = await f.ask("Did the Paywire payment hit my bank account?");
  assert.equal(named.ledger?.found, true);
  // The first deposit names a different explicit payee. Its memo mention
  // cannot supply the sender evidence for an amountless arrival (R02/F3).
  assert.deepEqual(named.citations.map(c => [c.posted_on, c.amount_minor, c.account_mask]), [["2026-10-08", 1234, "4417"]]);
  assert.ok(f.seen.sql.some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(modelCalls, 0);
});

test("named arrival absence is covered, scoped, token matched and never a model claim", async t => {
  const f = await fixture(t);
  f.raw("UPDATE fin_account_coverage SET covered_from='2025-11-01' WHERE account_slug='empty'");
  assert.equal((await f.ask("Did the Paywire payment hit my bank account?")).ledger?.found, true);
  const start = f.seen.sql.length;
  const absent = await f.ask("Did the payment from Absent Payer reach account 4417?");
  // The window contains a deposit with only a generic opening description.
  assert.equal(absent.ledger?.found, null);
  assert.equal(absent.ledger.inflow_count, 2);
  assert.deepEqual(absent.citations.map(c => c.amount_minor), [1234, 10001]);
  assert.match(absent.answer, /2026-08-14.*2026-10-12/);
  assert.ok(f.seen.sql.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), "absence read the window");
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-01'");
  const before = f.seen.sql.length;
  const gap = await f.ask("Did the Paywire payment hit my bank account?");
  assert.equal(gap.ledger, undefined); assert.equal(gap.gaps[0]?.reason, "period_outside_coverage");
  assert.ok(f.seen.sql.slice(before).some(sql => /FROM fin_accounts/.test(sql)), "coverage decision reached");
});

test("unsupported audit questions reach documents without reading the ledger, with a green control", async t => {
  const f = await fixture(t);
  assert.equal((await f.ask("What is my current balance?")).ledger?.kind, "balance");
  for (const question of documents) {
    const before = f.seen.sql.length;
    const body = await f.ask(question);
    assert.equal(body.ledger, undefined, question);
    assert.ok(f.seen.sql.length > before, "document decision reached");
    assert.equal(f.seen.sql.slice(before).some(sql => /FROM fin_accounts/.test(sql)), false, question);
  }
});

for (const [label, change] of [
  ["missing provider proof", f => f.raw("DELETE FROM bank_feed_backfill")],
  ["no balance observations", f => f.raw("DELETE FROM fin_balance_snapshots WHERE account_slug='empty'")],
  ["unconfirmed balance", f => f.raw("UPDATE fin_balance_snapshots SET basis_state='proposed' WHERE account_slug='empty'")],
  ["nonzero available balance", f => f.raw("UPDATE fin_balance_snapshots SET available_minor=1 WHERE account_slug='empty'")],
  ["stale completion", f => f.raw("UPDATE bank_feed_backfill SET finished_at='2026-10-11T12:00:00.000Z'")],
  ["invalid provider date", f => f.raw("UPDATE bank_feed_backfill SET queued_at='2026-02-30T12:00:00.000Z'")],
  ["partial account coverage", f => f.raw("UPDATE fin_account_coverage SET coverage_status='partial' WHERE account_slug='empty'")],
  ["staged provider refresh", f => f.raw(`INSERT INTO plaid_sync_windows (item_ref,window_ref,state,started_at,updated_at)
    VALUES ('synthetic-feed','synthetic-window','staging',?,?)`, NOW, NOW)],
  ["historical activity outside the question", f => f.add("empty-historical", "empty", "2026-08-15", 1)],
  ["incomplete provider", f => f.raw("UPDATE bank_feed_backfill SET state='running'")],
  ["unknown provider history", f => f.raw("UPDATE bank_feed_backfill SET provider_history_state='INITIAL_UPDATE_COMPLETE'")],
  ["provider window too short", f => f.raw("UPDATE bank_feed_backfill SET requested_days=1")],
  ["unread provider rows", f => f.raw("UPDATE bank_feed_backfill SET unread_lines=1")],
  ["nonzero balance", f => f.raw("UPDATE fin_balance_snapshots SET current_minor=1 WHERE account_slug='empty'")],
  ["unknown balance", f => f.raw("UPDATE fin_balance_snapshots SET current_minor=NULL WHERE account_slug='empty'")],
  ["transaction activity", f => f.add("empty-activity", "empty", "2026-09-15", 1)],
  ["undated activity", f => f.add("empty-undated", "empty", null, 1)],
  ["different coverage source", f => f.raw("UPDATE fin_account_coverage SET source_feed='bank-feed:other' WHERE account_slug='empty'")],
]) test(`empty coverage refuses ${label}`, async t => {
  const f = await fixture(t);
  const question = "How much money came in and went out in September 2026?";
  assert.equal((await f.ask(question)).ledger?.kind, "totals", "green completed provider control");
  change(f);
  const before = f.seen.sql.length;
  const body = await f.ask(question);
  assert.equal(body.ledger, undefined); assert.equal(body.gaps[0]?.reason, "period_outside_coverage");
  assert.ok(f.seen.sql.slice(before).some(sql => /FROM fin_accounts/.test(sql)), "coverage refusal reached");
});

test("top spending categories rank exact totals rather than posting order", async t => {
  const f = await fixture(t);
  f.add("early-small-expense", "live-a", "2026-09-01", 10, "outflow");
  f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed' WHERE direction='outflow'");
  f.raw("UPDATE fin_transactions SET category='Software' WHERE txn_uid='live-a-debit'");
  const before = f.seen.sql.length;
  const body = await f.ask("Show my spending in September 2026, top categories.");
  assert.ok(f.seen.sql.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), "category grouping reached");
  assert.equal(body.ledger?.total_minor, 19144);
  assert.deepEqual(body.ledger.groups.map(g => [g.category, g.total_minor]), [["software", 12345], ["office", 6799]]);
  assert.ok(body.answer.indexOf("software: ") < body.answer.indexOf("office: "));
});
