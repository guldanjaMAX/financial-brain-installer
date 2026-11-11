import { formatMinor } from '../../eval/fast-loop/money-oracle.mjs';
import { PAYER_PARTIAL_LINE } from './fixtures/plain-copy-expectations.mjs';
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture, NOW, Q, accepted, refused, flipQuestion } from "./fixtures/transfer-default/fixture.mjs";
import { reviewedFinalOffer, reviewedDateCopy, reviewedTitleFields, reviewedPlainCopy, POSTED_PLAIN, TRANSFERS_PLAIN, CATEGORY_PLAIN } from "./fixtures/plain-copy-expectations.mjs";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";

const head = JSON.parse(readFileSync(new URL("./fixtures/transfer-default/head-baseline.json", import.meta.url), "utf8"));
for (const scenario of Object.values(head)) for (const body of Object.values(scenario)) {
  if (typeof body.answer !== "string") continue;
  body.answer = reviewedPlainCopy(body.answer);
  body.ledger = reviewedTitleFields(body.ledger);
  if (body.ledger?.groups?.some(group => group.category_basis_state === "proposed")) body.answer = body.answer.replace("\nUnsorted:", `\n${CATEGORY_PLAIN}\nUnsorted:`);
  if (body.ledger?.kind === "transfers") body.answer = body.answer.replace("\nAccounts:", `\n${TRANSFERS_PLAIN}\nAccounts:`);
}
// Keep the captured file immutable. The frozen unclassified base charge is
// entered before the proposed movement; only their category bucket and the
// resulting citation numbering change. Transfer identities and amounts stay pinned.
const categoryPolicy = new Map();
for (const scenario of ['plain', 'own']) {
  const category = head[scenario][Q.category];
  const proposed = category.ledger.groups.filter(g => g.category_basis_state === 'proposed');
  const minor = category.ledger.unsorted_minor + proposed.reduce((n, g) => n + g.total_minor, 0);
  const count = 1 + proposed.reduce((n, g) => n + g.citations.length, 0);
  const unknownN = Number(category.answer.match(/^Unsorted:[^\n]*\[(\d+)\]/m)[1]);
  for (const kind of scenario === 'own' ? ['merchant', 'category'] : ['category']) {
    const expected = head[scenario][Q[kind]];
    expected.ledger.unsorted_minor = minor;
    if (kind === 'category' && proposed.length) {
      const proposedN = proposed[0].citations[0];
      const remapN = n => n === proposedN ? unknownN : n === unknownN ? proposedN : n;
      const remap = value => {
        if (Array.isArray(value)) return value.map(remap);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
          key === 'n' ? remapN(item) : /citations$/.test(key) && Array.isArray(item) ? item.map(remapN) : remap(item)]));
      };
      expected.ledger.groups = expected.ledger.groups.filter(g => g.category_basis_state === 'confirmed');
      expected.ledger = remap(expected.ledger);
      expected.answer = expected.answer.split('\n').filter(line => !proposed.some(g => line.startsWith(g.category + ' ('))).join('\n')
        .replace('\n' + CATEGORY_PLAIN, '').replace(/\[(\d+)\]/g, (_, n) => '[' + remapN(Number(n)) + ']');
    }
    const refs = scenario === 'own' ? '[2] [3]' : '[3]';
    expected.answer = expected.answer.replace(/^Unsorted:[^\n]*$/m, 'Unsorted: ' + formatMinor(String(minor)) + ' ' + refs + '.');
    if (kind === 'category') expected.answer = expected.answer.replace('\nUnsorted:',
      '\nUnconfirmed categories: ' + count + ' rows totaling ' + formatMinor(String(minor)) + '; left out of confirmed category totals.\nUnsorted:');
    categoryPolicy.set(scenario + ':' + Q[kind], { count, minor });
  }
}
const pairFacts = pairs => pairs.map(pair => ({ amount_minor: pair.amount_minor,
  legs: ['outgoing','incoming'].map(side => Object.fromEntries(
    ['ref','account_mask','posted_on','amount_minor','currency','description','supplied_by'].map(key => [key,pair[side][key]]))) }));
function verifyCategoryPolicy(body, scenario, question) {
  const expected = categoryPolicy.get(scenario + ':' + question);
  if (!expected) return;
  if (body.ledger.kind !== 'category') { assert.equal(body.ledger.unsorted_minor, expected.minor); return; }
  // These amounts come from the synthetic seed, not from product classifiers.
  const ordinary = scenario === 'plain' ? 2807 + 1903 + 2713 : 2807 + 1903;
  const confirmed = scenario === 'plain' ? 2807 + 2713 : 2807;
  assert.equal(body.ledger.total_minor, ordinary);
  assert.equal(body.ledger.unsorted_minor, 1903);
  assert.equal(body.ledger.unconfirmed_category_count, 1);
  assert.equal(body.ledger.includes_own_transfers, false);
  assert.deepEqual(body.ledger.groups.map(g => [g.category,g.category_basis_state,g.total_minor]), [['software','confirmed',confirmed]]);
  assert.deepEqual(body.ledger.own_account_payments, { total_minor:0,count:0,card_minor:0,loan_minor:0 });
  assert.equal(body.ledger.excluded_own_transfer_minor, scenario === 'own' ? 23617 : 0);
  assert.deepEqual(body.ledger.accounts, head[scenario][Q.category].ledger.accounts);
  assert.deepEqual(pairFacts(body.ledger.transfers), pairFacts(head[scenario][Q.category].ledger.transfers));
}
const postedDisclosure = `\n${POSTED_PLAIN}`;
test.before(() => {
  mock.method(Date, "now", () => Date.parse(NOW));
  mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
});
test.after(() => mock.restoreAll());
const newKeys = new Set(["possible_owned_movements", "lead_rows", "lead", "default_exclusions", "lead_accounts", "lead_total_minor", "lead_monthly_total_minor", "flip", "measure", "net_minor", "net_label", "excluded_from_lead", "kept_reason", "time_zone", "known_own_transfer_in_lead", "unconfirmed_category_count"]);
function oldKeys(value) {
  if (Array.isArray(value)) return value.map(oldKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !newKeys.has(key) && !(value.kind === "recurring" && ["set_aside_recurring", "confirmed_subtotal_minor", "total_minor", "recurring_context"].includes(key))).map(([key, item]) => [key, oldKeys(item)]));
  return value;
}
function unchanged(body, scenario, question) {
  verifyCategoryPolicy(body, scenario, question);
  const golden = head[scenario][question];
  if (body.ledger.kind === 'transfers') {
    assert.equal(body.ledger.total_minor, golden.ledger.transfers.reduce((n,pair)=>n+pair.amount_minor,0));
    assert.equal(body.ledger.match_count, golden.ledger.transfers.length);
    assert.deepEqual(pairFacts(body.ledger.transfers), pairFacts(golden.ledger.transfers));
    assert.deepEqual(body.ledger.accounts, golden.ledger.accounts);
    assert.ok(body.ledger.transfers.every(pair => pair.counted && !pair.excluded_from_totals));
    assert.match(body.answer, /^Identified moves between your own accounts:/);
    assert.ok(body.answer.includes(formatMinor(String(body.ledger.total_minor))));
    assert.ok(body.answer.includes(TRANSFERS_PLAIN.split('\n')[0]));
    assert.ok(body.answer.includes(POSTED_PLAIN));
    assert.deepEqual(body.answer.match(/Want[^?\n]*\?/g), ['Want me to show your account balances?']);
    return;
  }
  assert.ok(golden, "question captured before product changes");
  if (/^boundary-(?:far|uncovered)$/.test(scenario) && question === Q.totals) {
    if (scenario === 'boundary-uncovered') {
      assert.equal(body.ledger.reason, 'money_out_destination_unconfirmed');
      assert.equal(body.ledger.total_minor, null);
      assert.equal(body.evidence_gate.complete, false);
      const candidate = body.ledger.possible_payments.find(row => row.amount_minor === 27653);
      assert.ok(candidate?.destination_unconfirmed, 'receiving coverage decision is populated');
      assert.ok(body.citations.some(row => row.n === candidate.n && row.amount_minor === 27653));
    } else {
      assert.equal(account(body, '1111').debits_minor, 32363, 'unpaired outflow stays in money out');
      assert.deepEqual(body.ledger.accounts, golden.ledger.accounts, 'gross historical rows remain available');
      const candidate = body.ledger.possible_payments.find(row => row.amount_minor === 27653);
      assert.equal(candidate.included_in_total, true);
      assert.ok(body.citations.some(row => row.n === candidate.n && row.amount_minor === 27653));
      assert.match(body.answer, /counterpart not proved/);
    }
    return;
  }
  assert.equal(body.answer, reviewedFinalOffer(golden.answer + (body.ledger.kind === "balance" ? "" : postedDisclosure), body.ledger.kind === "balance" ? "Want help refreshing the bank connection for a newer balance?" : undefined),
    "reviewed answer bytes are preserved with the required posted-record disclosure");
  const comparable = oldKeys(body.ledger);
  if (body.ledger.kind === 'category') {
    // New category facts were independently checked above; compare every
    // remaining pinned field without rewriting the historical capture.
    delete comparable.own_account_payments; delete comparable.excluded_own_transfer_minor;
    comparable.includes_own_transfers = golden.ledger.includes_own_transfers;
  }
  assert.deepEqual(comparable, golden.ledger, 'other existing JSON keys retain their values');
}
async function ask(f, question = Q.totals, kind = "totals", pairCount = 1) {
  if (/\bcash flow\b/.test(question)) {
    // Cash flow is deliberately unsupported in this seal. Each former cash
    // arm now proves refusal, then keeps every numeric/exclusion assertion as
    // a supported net-income control over the identical fixture and flags.
    const before = f.seen.sql.length;
    const refused = await f.ask(question);
    assert.ok(f.seen.sql.slice(before).some(sql => /FROM fin_accounts/.test(sql)), "cash-flow scope decision reached");
    assert.equal(refused.ledger, undefined);
    assert.equal(refused.gaps[0].reason, "cash_flow_unsupported");
    assert.equal(refused.evidence_gate.supported, false);
    assert.equal(f.modelCalls, 0);
    question = question.replace("cash flow", "net income");
  }
  const before = f.seen.sql.length;
  const body = await f.ask(question);
  assert.equal(body.ledger?.kind, kind);
  assert.ok(f.seen.sql.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), "transaction decision reached");
  assert.equal(body.ledger.transfers?.length ?? 0, pairCount, "pair decision reached");
  return body;
}
const account = (body, mask, lead = true) => (lead ? body.ledger.lead_accounts : body.ledger.accounts).find(a => a.account_mask === mask);
const fmt = cents => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function blocks(body, scenario, question) {
  verifyCategoryPolicy(body, scenario, question);
  const marker = "\nWith everything counted:\n";
  assert.ok(body.answer.includes(marker));
  const [first, rest] = body.answer.split(marker);
  assert.doesNotMatch(first, /\b(?:credits|debits)\b/);
  const lines = first.split("\n"), note = lines.at(-1);
  assert.match(note, /^Note: /);
  assert.equal(lines.filter(line => line.startsWith("Note: ")).length, 1);
  const invitation = 'Want me to show your account balances?';
  const expected = reviewedFinalOffer(head[scenario][question].answer.split("\nAccounts:")[0]);
  const gross = expected.slice(0, -invitation.length - 1);
  assert.ok(body.answer.endsWith(invitation));
  assert.deepEqual(body.answer.match(/Want[^?\n]*\?/g), [invitation]);
  assert.ok(rest.startsWith(gross + "\nAccounts:"), "gross sentences and citations are unchanged");
  assert.doesNotMatch(body.answer, /no rows were removed as transfers|If these are transfers between your own accounts/);
  return { lead: lines.slice(0, -1).join("\n"), note };
}
const offered = body => [...body.answer.matchAll(/say "([a-z ]+)"/g)].map(m => m[1]);

const bilateralDescriptions = [
  ["A-R1", "TRANSFER FROM X1111 TO X2222"],
  ["A-R2", "ONLINE TRANSFER FROM XXXX1111 TO XXXX2222"],
  ["A-R3", "AUTOMATIC TRANSFER FROM ****1111 TO ****2222"],
  ["A-R4", "MOBILE TRANSFER FROM ••••1111 TO ••••2222"],
  ["A-R5", "INTERNET TRANSFER FROM checking ending in 1111 TO savings ending 2222"],
];

for (const [id, description] of bilateralDescriptions) test(`${id} bilateral endpoints remove both legs and preserve gross`, async t => {
  const f = await fixture(t);
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid IN ('move-out','move-in')", description);
  const body = await ask(f);
  assert.equal(body.ledger.candidate_transfer_count, 1, "bilateral pair reached transfer analysis");
  assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
  assert.equal(body.ledger.default_exclusions.own_transfer_minor, 23617);
  assert.deepEqual(
    [account(body, "1111").credits_minor, account(body, "1111").debits_minor,
      account(body, "2222").credits_minor, account(body, "2222").debits_minor],
    [73129, 4710, 0, 0],
  );
  assert.deepEqual(
    [account(body, "1111", false).debits_minor, account(body, "2222", false).credits_minor],
    [28327, 23617],
    "gross figures retain both transfer legs",
  );
  assert.match(body.answer, /Moves between your own connected accounts/);
  assert.equal(body.ledger.known_own_transfer_in_lead, undefined);
  assert.equal(body.evidence_gate.complete, true);
});

test("A-R7 a named owned bilateral leg is excluded across account scope", async t => {
  const f = await fixture(t);
  f.raw("UPDATE fin_transactions SET description='TRANSFER FROM X1111 TO X2222' WHERE txn_uid IN ('move-out','move-in')");
  const body = await ask(f, Q.checking);
  assert.equal(body.ledger.candidate_transfer_count, 1, "scoped pair reached transfer analysis");
  assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
  assert.equal(account(body, "1111").debits_minor, 4710);
  assert.equal(body.ledger.known_own_transfer_in_lead, undefined);
  assert.equal(body.evidence_gate.complete, true);
  assert.match(body.answer, /identified owned-account movement/i);
  assert.doesNotMatch(body.answer, /other account is outside this question/i);
});

for (const [name, outgoing, incoming] of [
  ["bilateral plus unary", "TRANSFER FROM X1111 TO X2222", "TRANSFER FROM account 1111"],
  ["unary plus bilateral", "TRANSFER TO account 2222", "TRANSFER FROM X1111 TO X2222"],
]) test(`A-R8 mixed-form ${name} removes both compatible legs`, async t => {
  const f = await fixture(t);
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='move-out'", outgoing);
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='move-in'", incoming);
  const body = await ask(f);
  assert.equal(body.ledger.candidate_transfer_count, 1, "mixed-form pair decision reached");
  assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
  assert.equal(body.ledger.default_exclusions.own_transfer_minor, 23617, "pair amount removed once");
  assert.deepEqual(
    [account(body, "1111").credits_minor, account(body, "1111").debits_minor,
      account(body, "2222").credits_minor, account(body, "2222").debits_minor],
    [73129, 4710, 0, 0],
    "lead figures exclude the compatible mixed-form movement",
  );
  assert.equal(body.ledger.known_own_transfer_in_lead, undefined);
  assert.equal(body.evidence_gate.complete, true);
});

test("A-R8 bilateral counterexamples preserve unproved legs and exclude independently proved legs", async t => {
  const arms = [
    ["duplicated mask", f => f.account("account-c", "2222", "savings")],
    ["outside endpoint", f => f.raw("UPDATE fin_transactions SET description='TRANSFER FROM X1111 TO X9999' WHERE txn_uid IN ('move-out','move-in')")],
    ["conflicting payee", f => f.raw("UPDATE fin_transactions SET payee='Outside counterparty' WHERE txn_uid='move-out'")],
    ["reversed endpoint", f => f.raw("UPDATE fin_transactions SET description='TRANSFER FROM X2222 TO X1111' WHERE txn_uid IN ('move-out','move-in')")],
    ["four-day gap", f => f.raw("UPDATE fin_transactions SET posted_on='2026-09-19' WHERE txn_uid='move-in'")],
    ["unequal amount", f => f.raw("UPDATE fin_transactions SET amount_minor=23618 WHERE txn_uid='move-in'")],
  ];
  const decisions = new Set();
  for (const [name, mutate] of arms) {
    await t.test(name, async t => {
      const f = await fixture(t);
      f.raw("UPDATE fin_transactions SET description='TRANSFER FROM X1111 TO X2222' WHERE txn_uid IN ('move-out','move-in')");
      mutate(f);
      const withheld = ["duplicated mask", "outside endpoint", "reversed endpoint"].includes(name);
      const body = await ask(f, Q.totals, "totals", withheld || ["four-day gap", "unequal amount"].includes(name) ? 0 : 1);
      if (withheld) {
        assert.equal(body.ledger.reason, 'money_out_destination_unconfirmed');
        assert.equal(body.ledger.total_minor, null);
        assert.equal(body.ledger.complete, false);
        assert.equal(body.evidence_gate.complete, false);
        const candidate = body.ledger.possible_payments.find(row => row.amount_minor === 23617);
        assert.ok(candidate?.destination_unconfirmed);
        assert.ok(body.citations.some(c => c.n === candidate.n && c.amount_minor === 23617));
        decisions.add('withheld');
        return;
      }
      const reached = body.ledger.candidate_transfer_count + body.ledger.unmatched_transfers.length;
      assert.ok(reached > 0, `${name} reached candidate or unmatched transfer analysis`);
      const decision = body.ledger.candidate_transfer_count ? "paired-kept" : "unmatched-kept";
      decisions.add(decision);
      assert.equal(body.ledger.default_exclusions.own_transfer_minor, 0);
      assert.equal(account(body, "1111").debits_minor, 28327, `${name} retains the unproved outgoing activity`);
      assert.equal(body.ledger.known_own_transfer_in_lead, undefined);
      assert.ok(body.ledger.transfers.every(pair => pair.excluded_from_lead === false));
      assert.match(body.answer, /possible|insufficient|conflicting|unmatched/i);
    });
  }
  assert.ok(decisions.size > 1, "negative arms exercise nonuniform paired and unmatched decisions");
});

test("A green controls retain unary, card acknowledgement, and explicit gross behavior", async t => {
  const unary = await fixture(t);
  const unaryBody = await ask(unary);
  assert.equal(unaryBody.ledger.transfers[0].excluded_from_lead, true);

  const card = await fixture(t, "card");
  const cardBody = await ask(card, Q.totals, 'totals', 0);
  assert.equal(cardBody.ledger.payment_exclusions.count, 2, 'both repayment legs reached the payment decision');
  assert.equal(account(cardBody, '1111').debits_minor, 4710);
  assert.equal(account(cardBody, '3333').credits_minor, 0);

  const gross = await ask(unary, flipQuestion(Q.totals, "including transfers"));
  assert.equal(gross.ledger.lead, "gross");
  assert.deepEqual(gross.ledger.lead_accounts, gross.ledger.accounts);
  assert.equal(gross.ledger.known_own_transfer_in_lead, true);
  assert.equal(gross.evidence_gate.complete, false);
});

// Byte controls are separate tests so the failing-first run proves them green.
for (const kind of ["balance", "payment", "totals", "largest", "deposits", "merchant", "category", "recurring", "transfers"]) {
  test(`HEAD control: no exclusions, ${kind}`, async t => {
    const f = await fixture(t, "plain");
    const before = f.seen.sql.length, body = await f.ask(Q[kind]);
    assert.equal(body.ledger?.kind, kind);
    assert.ok(f.seen.sql.slice(before).some(sql => kind === "balance" ? /fin_balance_snapshots/.test(sql) : /JOIN fin_transactions/.test(sql)));
    assert.equal(body.ledger.transfers?.length ?? 0, 0);
    if (kind === "balance") {
      assert.equal(body.answer, reviewedFinalOffer("Your latest synced balances are below.\nThe saved account history is complete.\nNo pending transactions are recorded after these snapshots.\nHere are your recorded balances, with the date for each account; these do not show live or available cash.\nWant help refreshing the bank connection for a newer balance?\nCash accounts (recorded balances):\nyour account ending 1111: $837.19 as of October 11; last update unavailable [1].", "Want help refreshing the bank connection for a newer balance?"));
      assert.deepEqual(body.ledger.observation.pending, { count: 0, outflow_minor: 0, inflow_minor: 0, treatment: 'not_included' });
      assert.deepEqual(body.ledger.accounts, [{ account_mask: "1111", balance_group: "cash", current_minor: 83719,
        as_of: "2026-10-11", last_synced_at: null }]);
    } else unchanged(body, "plain", Q[kind]);
  });
}
for (const scenario of ["unrelated", "card-unconnected", "dividend", "description-ira", "description-401k", "boundary-far", "boundary-uncovered"]) {
  test(`HEAD control: ${scenario}`, async t => {
    const f = await fixture(t, scenario);
    const body = await ask(f, Q.totals, "totals", 0);
    if (scenario === 'card-unconnected') {
      assert.equal(body.ledger.payment_exclusions, undefined);
      assert.equal(account(body, '1111').debits_minor, 20149);
      const candidate = body.ledger.possible_payments.find(row => row.amount_minor === 15439);
      assert.equal(candidate.payment_kind, 'own_account');
      assert.equal(candidate.included_in_total, true);
      assert.ok(body.citations.some(c => c.n === candidate.n && c.amount_minor === 15439));
    } else unchanged(body, scenario, Q.totals);
  });
}
test("HEAD control: transfers view keeps both candidate legs and text", async t => {
  const f = await fixture(t);
  unchanged(await ask(f, Q.transfers, "transfers"), "own", Q.transfers);
});

test("a: own move leads with conditional cents, one note, then exact gross", async t => {
  const f = await fixture(t), body = await ask(f);
  const { lead, note } = blocks(body, "own", Q.totals);
  assert.equal(lead, "your account ending 1111, September: money in $731.29; money out $47.10.\nyour account ending 2222, September: money in $0.00; money out $0.00.");
  assert.equal(note.split("$236.17").length - 1, 1);
  assert.match(note, /between your own connected accounts/);
  assert.match(note, /say "including transfers"/);
  assert.deepEqual(body.ledger.default_exclusions, { own_transfer_pairs: 1, own_transfer_minor: 23617, withdrawal_count: 0, withdrawal_minor: 0, loan_proceeds_count: 0, loan_proceeds_minor: 0 });
  assert.equal(body.ledger.lead, "default_exclusions");
  assert.deepEqual(body.ledger.lead_accounts, head.own[Q.totals].ledger.if_own_transfers.accounts);
  assert.deepEqual(oldKeys(body.ledger), head.own[Q.totals].ledger);
  assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
  assert.equal(body.ledger.transfers[0].excluded_from_totals, false);
  assert.deepEqual(body.ledger.flip, ["including transfers"]);
  f.raw("UPDATE fin_accounts SET feed_mode='manual'");
  const imported = await ask(f);
  assert.deepEqual(imported.ledger.lead_accounts, body.ledger.lead_accounts);
  assert.doesNotMatch(body.answer.split("Moves between your own connected accounts, left out of the first figures:")[1], /, included/);
});

test("b: offered flip phrases round-trip through the classifier", async t => {
  for (const [scenario, question, expected] of [["own", Q.totals, "gross"], ["category-withdrawal", Q.totals, "gross"], ["card", Q.checking, "default_exclusions"]]) {
    const f = await fixture(t, scenario), first = await ask(f, question, "totals", scenario === "category-withdrawal" || scenario === "card" ? 0 : 1);
    const phrases = offered(first);
    if (scenario === 'card') {
      assert.equal(phrases.length, 0, 'payment exclusions have no transfer flip');
      assert.equal(first.ledger.payment_exclusions.total_minor, 15439);
      const included = await ask(f, flipQuestion(question, 'including transfers'), 'totals', 0);
      assert.equal(account(included, '1111').debits_minor, 4710);
      assert.equal(included.ledger.payment_exclusions.total_minor, 15439);
      continue;
    }
    assert.equal(phrases.length, 1);
    const flipped = await ask(f, flipQuestion(question, phrases[0]), "totals", scenario === "category-withdrawal" ? 0 : 1);
    assert.equal(flipped.ledger.lead, expected);
    if (expected === "gross") {
      assert.equal(flipped.answer, reviewedFinalOffer(head[scenario][question].answer + postedDisclosure));
      assert.deepEqual(oldKeys(flipped.ledger), head[scenario][question].ledger);
    } else assert.equal(account(flipped, "1111").debits_minor, 4710);
  }
});

test("c: one directed leg withholds until reciprocal evidence excludes both", async t => {
  const f = await fixture(t, "unrelated");
  unchanged(await ask(f, Q.totals, "totals", 0), "unrelated", Q.totals);
  f.raw("UPDATE fin_transactions SET description='TRANSFER TO account 2222' WHERE txn_uid='same-out'");
  const advisory = await ask(f, Q.totals, 'totals', 0);
  assert.equal(advisory.ledger.reason, 'money_out_destination_unconfirmed');
  assert.equal(advisory.ledger.total_minor, null);
  assert.equal(advisory.evidence_gate.complete, false);
  const candidate = advisory.ledger.possible_payments.find(row => row.amount_minor === 23617);
  assert.ok(candidate?.destination_unconfirmed);
  assert.ok(advisory.citations.some(row => row.n === candidate.n && row.amount_minor === 23617));
  f.raw("UPDATE fin_transactions SET description='TRANSFER FROM account 1111' WHERE txn_uid='same-in'");
  const control = await ask(f);
  assert.equal(control.ledger.transfers[0].excluded_from_lead, true);
  assert.equal(account(control, "1111").debits_minor, 4710);
});

for (const [question, mask, credit, debit] of [[Q.totals, "1111", 73129, 4710], [Q.october, "2222", 0, 0]]) {
  test(`d: only the in-period leg changes the lead for ${mask}`, async t => {
    const f = await fixture(t, "boundary");
    if (question === Q.october) f.raw("UPDATE fin_account_coverage SET covered_to='2026-10-31'");
    const body = await ask(f, question);
    assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
    assert.deepEqual([account(body, mask).credits_minor, account(body, mask).debits_minor], [credit, debit]);
    assert.equal(account(body, mask, false)[mask === "1111" ? "debits_minor" : "credits_minor"], mask === "1111" ? 32363 : 27653);
    assert.equal(body.ledger.to, mask === "1111" ? "2026-09-30" : "2026-10-11");
    if (mask === "2222") {
      assert.equal(body.ledger.requested_to, '2026-10-31');
      assert.equal(body.ledger.complete, false);
      assert.equal(body.ledger.coverage.complete, false);
      assert.match(body.answer, /Partial period:.*through/);
    }
    assert.equal(body.ledger.lead_accounts.reduce((n, a) => n + a.transaction_count, 0), mask === "1111" ? 3 : 0);
  });
}
for (const [scenario, sql] of [
  ["boundary-far", "UPDATE fin_transactions SET posted_on='2026-10-02' WHERE txn_uid='boundary-in'"],
  ["boundary-uncovered", "UPDATE fin_account_coverage SET covered_to='2026-10-11' WHERE account_slug='account-b'"],
]) test(`d: ${scenario} stays until one evidence variable changes`, async t => {
  const f = await fixture(t, scenario);
  unchanged(await ask(f, Q.totals, "totals", 0), scenario, Q.totals);
  f.raw(sql);
  const control = await ask(f);
  assert.equal(account(control, "1111").debits_minor, 4710);
  assert.equal(control.ledger.transfers[0].excluded_from_lead, true);
});

test("e: card purchases count and scoped repayments stay excluded under transfer flags", async t => {
  const f = await fixture(t, "card"), all = await ask(f, Q.totals, 'totals', 0);
  assert.equal(account(all, "1111").debits_minor, 4710);
  assert.deepEqual([account(all, "3333").credits_minor, account(all, "3333").debits_minor], [0, 9341]);
  assert.equal(all.ledger.payment_exclusions.count, 2, 'both liability-payment legs identified');
  for (const question of [Q.checking, flipQuestion(Q.checking, 'including transfers'), flipQuestion(Q.checking, 'excluding transfers')]) {
    const selected = await ask(f, question, 'totals', 0);
    assert.equal(account(selected, '1111').debits_minor, 4710);
    assert.equal(selected.ledger.payment_exclusions.total_minor, 15439);
    assert.equal(selected.ledger.payment_exclusions.count, 1);
    assert.deepEqual(offered(selected), []);
    assert.match(selected.answer, /Payments to loans and cards/);
  }
});

test("e: unconnected card stays money out until its counterpart is connected", async t => {
  const f = await fixture(t, "card-unconnected");
  const unconnected = await ask(f, Q.totals, 'totals', 0);
  assert.equal(account(unconnected, '1111').debits_minor, 20149);
  assert.equal(unconnected.ledger.payment_exclusions, undefined);
  const candidate = unconnected.ledger.possible_payments.find(row => row.amount_minor === 15439);
  assert.equal(candidate.payment_kind, 'own_account');
  assert.equal(candidate.included_in_total, true);
  assert.ok(unconnected.citations.some(c => c.n === candidate.n && c.amount_minor === 15439));
  f.account("account-c", "9999", "card");
  f.add("card-in", "2026-09-20", 15439, "inflow", "PAYMENT THANK YOU", null, null, "account-c");
  const connected = await ask(f, Q.totals, 'totals', 0);
  assert.equal(account(connected, "1111").debits_minor, 4710);
  assert.equal(account(connected, '9999').credits_minor, 0);
  assert.equal(connected.ledger.payment_exclusions.total_minor, 30878);
  assert.equal(connected.ledger.payment_exclusions.count, 2);
  assert.ok(connected.ledger.payment_exclusions.rows.every(row => row.pairing_uncertain), 'acknowledgement alone does not invent an economic pair');
  f.raw("UPDATE fin_transactions SET category=NULL,category_basis_state=NULL,description='External purchase' WHERE txn_uid='card-out'");
  const purchase = await ask(f, Q.totals, 'totals', 0);
  assert.equal(account(purchase, '1111').debits_minor, 20149, 'ordinary purchase control stays counted');
});

for (const [scenario, reason] of [["loan", "loan payment"], ["credit-line", "loan payment"], ["kept-other", "account kind"]]) {
  test(`f: ${scenario} follows payment membership independently of transfer eligibility`, async t => {
    const f = await fixture(t, scenario), payment = scenario !== 'kept-other';
    const kept = await ask(f, Q.totals, 'totals', 0);
    if (payment) {
      assert.equal(f.rows("SELECT txn_uid FROM fin_transactions WHERE txn_uid IN ('loan-out','loan-in')").length, 2,
        'both stored postings reached the payment decision');
      // A proved bilateral repayment is one economic payment, with both
      // stored legs preserved rather than counted twice in its disclosure.
      assert.equal(kept.ledger.payment_exclusions.count, 1);
      assert.equal(kept.ledger.payment_exclusions.total_minor, 18263);
      assert.deepEqual(kept.ledger.payment_exclusions.rows.map(row =>
        [row.payment_kind,row.amount_minor,row.direction,row.account_mask,row.own_loan_mask,row.posted_on]),
      [['loan',18263,'outflow','1111','4444','2026-09-23']]);
      assert.ok(kept.citations.some(ref => ref.n === kept.ledger.payment_exclusions.rows[0].n),
        'the one-payment disclosure retains its citation');
      assert.equal(account(kept, '1111').debits_minor, 4710);
      assert.equal(account(kept, '4444').credits_minor, 0);
      assert.match(kept.answer, /Payments to loans and cards/);
    } else {
      assert.equal(f.rows("SELECT txn_uid FROM fin_transactions WHERE txn_uid IN ('loan-out','loan-in')").length, 2,
        'both postings reach the unconfirmed-kind decision');
      assert.equal(kept.ledger.reason, 'money_out_destination_unconfirmed');
      assert.equal(kept.ledger.total_minor, null);
      assert.equal(kept.evidence_gate.complete, false);
      const candidate = kept.ledger.possible_payments.find(row => row.amount_minor === 18263);
      assert.equal(candidate.payment_kind, 'own_account', 'no repayment subtype is inferred');
      assert.equal(candidate.destination_unconfirmed, true);
      assert.ok(kept.citations.some(row => row.n === candidate.n && row.amount_minor === 18263));
    }
    f.raw("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='account-d'");
    const control = await ask(f);
    assert.equal(control.ledger.transfers[0].excluded_from_lead, true);
    assert.equal(account(control, "1111").debits_minor, 4710);
    assert.equal(account(control, '1111', false).debits_minor, 22973, 'asset-transfer control retains gross evidence');
    assert.equal(control.ledger.payment_exclusions, undefined);
  });
}

test("g: proposed and confirmed category withdrawals leave income with a flip note", async t => {
  for (const scenario of ["category-withdrawal", "confirmed-withdrawal"]) {
    const f = await fixture(t, scenario), body = await ask(f, Q.totals, "totals", 0);
    assert.equal(account(body, "1111").credits_minor, 73129);
    assert.equal(account(body, "1111", false).credits_minor, 114512);
    assert.deepEqual(body.ledger.default_exclusions, { own_transfer_pairs: 0, own_transfer_minor: 0, withdrawal_count: 1, withdrawal_minor: 41383, loan_proceeds_count: 0, loan_proceeds_minor: 0 });
    assert.match(blocks(body, scenario, Q.totals).note, /say "including withdrawals"/);
  }
  const f = await fixture(t, "category-withdrawal"), incomplete = await ask(f, Q.income, "merchant", 0);
  // The other deposit has no confirmed payer, so this cannot be a complete income total.
  assert.equal(incomplete.ledger.total_minor, null);
  assert.equal(incomplete.ledger.attributed_subtotal_minor, 41383);
  assert.equal(incomplete.ledger.inflow_count, 2);
  assert.equal(incomplete.evidence_gate.complete, false);
  assert.equal(incomplete.ledger.lead_total_minor, null);
  assert.equal(incomplete.ledger.lead_attributed_subtotal_minor, 0);
  assert.equal(incomplete.ledger.default_exclusions.withdrawal_minor, 41383);
  assert.match(incomplete.answer, /withdrawals left out/);
  assert.ok(incomplete.ledger.flip.includes("including withdrawals"));
  assert.match(incomplete.answer.split("\nNote:")[0], PAYER_PARTIAL_LINE);
  f.raw("UPDATE fin_transactions SET payee='Fixture client' WHERE txn_uid='deposit'");
  const income = await ask(f, Q.income, "merchant", 0);
  assert.equal(income.ledger.lead_total_minor, null);
  assert.equal(income.ledger.lead_attributed_subtotal_minor, 0);
  assert.equal(income.ledger.total_minor, null);
  assert.equal(income.ledger.attributed_subtotal_minor, 41383);
  assert.match(income.answer, /withdrawals left out/);
  assert.doesNotMatch(income.answer, /\$0\.00/);
});
for (const kind of ["investment", "retirement"]) test(`g: paired ${kind} withdrawal omits both legs`, async t => {
  const f = await fixture(t, kind), body = await ask(f);
  assert.equal(account(body, "1111").credits_minor, 73129);
  assert.equal(account(body, "5555").debits_minor, 0);
  assert.equal(body.ledger.default_exclusions.withdrawal_minor, 32641);
  assert.equal(body.ledger.default_exclusions.withdrawal_count, 1);
  assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
});
for (const [kind, summaryKey, phrase] of [
  ["checking", "own_transfer_minor", "including transfers"],
  ["loan", "loan_proceeds_minor", "including loan proceeds"],
]) test(`payer subtotal excludes ${kind} own credit before every transfer alternate`, async t => {
  const f = await fixture(t, "own");
  f.raw("UPDATE fin_accounts SET label='Fixture source',account_kind=?,balance_role=? WHERE account_slug='account-a'", kind, kind === "loan" ? "liability" : "asset");
  f.raw("UPDATE fin_transactions SET description='TRANSFER FROM Fixture source' WHERE txn_uid='move-in'");
  f.raw("UPDATE fin_transactions SET payee='Fixture client' WHERE txn_uid='deposit'");
  const question = "How much income came from Fixture source in September 2026?";
  const control = await ask(f, question, "merchant");
  assert.equal(control.evidence_gate.complete, false);
  assert.equal(control.ledger.lead_attributed_subtotal_minor, null);
  assert.equal(control.ledger.lead_total_minor, null);
  assert.equal(control.ledger.default_exclusions[summaryKey], 23617);
  f.add("uncertain", "2026-09-20", 1000, "inflow", "Deposit", null, null, "account-b");
  const body = await ask(f, question, "merchant");
  assert.equal(body.ledger.inflow_count, 3, 'all recorded deposits reach the payer decision');
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.attributed_subtotal_minor, null);
  assert.equal(body.ledger.lead_total_minor, null);
  assert.equal(body.ledger.lead_attributed_subtotal_minor, null);
  assert.equal(body.ledger.default_exclusions[summaryKey], 23617);
  assert.ok(body.ledger.flip.includes(phrase));
  assert.ok(body.answer.includes(`say "${phrase}"`));
  assert.match(body.answer.split("\nNote:")[0], PAYER_PARTIAL_LINE);
  const restored = await ask(f, flipQuestion(question, phrase), "merchant");
  assert.equal(restored.ledger.lead_total_minor, null);
  assert.equal(restored.ledger.lead_attributed_subtotal_minor, null);
  assert.equal(restored.evidence_gate.complete, false);
  assert.equal(restored.ledger.attributed_subtotal_minor, null);
  for (const result of [control, body, restored]) {
    assert.equal(result.ledger.not_payments.total_minor, 23617);
    assert.equal(result.ledger.not_payments.count, 1);
    assert.ok(result.citations.some(row => row.n === result.ledger.not_payments.rows[0].n && row.amount_minor === 23617));
    assert.match(result.answer, /Not counted as payments to you/);
  }
  f.raw("UPDATE fin_transactions SET amount_minor=23618 WHERE txn_uid='move-out'");
  f.raw("UPDATE fin_transactions SET description='Outside receipt',payee='Fixture source' WHERE txn_uid='move-in'");
  const outside = await ask(f, question, 'merchant', 0);
  assert.equal(outside.ledger.attributed_subtotal_minor, 23617, 'a genuine outside sender remains attributed');
});
for (const scenario of ["dividend", "description-ira", "description-401k"]) test(`g: ${scenario} is not withdrawal evidence; category alone changes decision`, async t => {
  const f = await fixture(t, scenario), kept = await ask(f, Q.totals, "totals", 0);
  unchanged(kept, scenario, Q.totals);
  f.raw("UPDATE fin_transactions SET category='TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',category_basis_state='proposed' WHERE txn_uid='income'");
  const control = await ask(f, Q.totals, "totals", 0);
  assert.equal(account(control, "1111").credits_minor, 73129);
});

test("g: an owned contribution is excluded before and after its account kind changes", async t => {
  const f = await fixture(t, "contribution"), body = await ask(f);
  assert.equal(account(body, "1111").debits_minor, 4710);
  assert.equal(body.ledger.transfers[0].excluded_from_lead, true);
  assert.match(body.answer, /identified owned-account movement/);
  f.raw("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='account-e'");
  const control = await ask(f);
  assert.equal(account(control, "1111").debits_minor, 4710);
});

test("ordinary money excludes loan and contribution movements with either exclusion policy", async t => {
  for (const scenario of ["loan", "contribution"]) {
    const f = await fixture(t, scenario), count = scenario === 'loan' ? 0 : 1;
    const unflagged = await ask(f, Q.totals, 'totals', count);
    const flagged = await ask(f, flipQuestion(Q.totals, "excluding transfers"), 'totals', count);
    if (scenario === 'loan') {
      assert.equal(flagged.ledger.payment_exclusions.total_minor, 18263);
      assert.equal(flagged.ledger.payment_exclusions.count, 1);
      assert.equal(account(flagged, '1111').debits_minor, 4710);
    } else assert.equal(flagged.ledger.transfers[0].excluded_from_lead, true);
    assert.deepEqual(flagged.ledger.lead_accounts, unflagged.ledger.lead_accounts);
    f.raw(`UPDATE fin_accounts SET account_kind='savings' WHERE account_slug=?`, scenario === "loan" ? "account-d" : "account-e");
    const control = await ask(f, flipQuestion(Q.totals, "excluding transfers"));
    assert.equal(control.ledger.transfers[0].excluded_from_lead, true);
  }
});

for (const [question, kind, measure, from, to, mask, ownTransfers, withdrawals] of accepted) {
  test(`h: accepted grammar: ${question}`, () => {
    const intent = classifyLedgerQuestion(question, { now: NOW });
    assert.deepEqual([intent.kind, intent.measure, intent.from, intent.to, intent.mask, intent.accountKind, intent.ownTransfers, intent.withdrawals],
      [kind, measure, from, to, mask, null, ownTransfers, withdrawals]);
  });
}
for (const question of refused) test(`h: refusal with accepted control: ${question}`, () => {
  assert.equal(classifyLedgerQuestion(Q.profit, { now: NOW }).kind, "totals", "accepted measure control reaches grammar");
  const intent = classifyLedgerQuestion(question, { now: NOW });
  assert.equal(intent.broad, true);
  assert.equal(intent.kind, null);
});

test("h: combined profit sums only move kinds and uses real Think without a model", async t => {
  const f = await fixture(t, "combined"), body = await ask(f, Q.profit, "totals", 2);
  const omitted = new Set(["move-out", "move-in", "card-out", "card-in", "withdraw-out", "withdraw-in", "loan-out", "loan-in"]);
  const expected = f.rows("SELECT t.*,a.account_kind FROM fin_transactions t JOIN fin_accounts a USING(account_slug)")
    .filter(r => ["checking", "savings", "card"].includes(r.account_kind) && !omitted.has(r.txn_uid))
    .reduce((n, r) => n + (r.direction === "inflow" ? r.amount_minor : -r.amount_minor), 0);
  assert.equal(body.ledger.measure, "profit");
  assert.equal(body.ledger.net_minor, expected);
  assert.equal(body.ledger.net_label, "money in minus money out, not accounting profit or cash flow");
  assert.ok(body.answer.startsWith(`Money in minus money out, not accounting profit or cash flow: ${fmt(expected)}`));
  assert.match(body.answer, /your account ending 4444.*loan.*left out of money in minus money out/);
  assert.match(body.answer, /Payments to loans and cards/);
  assert.equal(body.ledger.payment_exclusions.count, 3);
  assert.equal(body.ledger.payment_exclusions.total_minor, 49141);
  assert.equal(body.ledger.payment_exclusions.loan_minor, 18263);
  assert.equal(body.ledger.payment_exclusions.card_minor, 30878);
  const routeBefore = f.seen.sql.length, routed = await f.ask(Q.profit, true);
  assert.equal(routed.ledger.kind, "totals");
  assert.ok(f.seen.sql.slice(routeBefore).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.equal(routed.ledger.net_minor, expected);
  assert.equal(f.modelCalls, 0);
  const gross = await ask(f, flipQuestion(Q.totals, "including transfers including withdrawals"), "totals", 2);
  assert.equal(gross.ledger.payment_exclusions.total_minor, 49141, 'explicit transfer inclusion cannot restore payments');
  assert.equal(gross.ledger.payment_exclusions.count, 3, 'transfer flags cannot duplicate the proved loan pair');
  assert.equal(gross.ledger.default_exclusions.own_transfer_minor, 0);
  assert.equal(gross.ledger.default_exclusions.withdrawal_minor, 0);
  assert.deepEqual(gross.ledger.lead_accounts, gross.ledger.accounts);
  const expectedRaw = f.rows("SELECT t.*,a.mask FROM fin_transactions t JOIN fin_accounts a USING(account_slug)")
    .filter(row => !['loan-out','loan-in','card-out','card-in'].includes(row.txn_uid));
  for (const account of gross.ledger.accounts) for (const [direction, key] of [['inflow','credits_minor'],['outflow','debits_minor']])
    assert.equal(account[key], expectedRaw.filter(row => row.mask === account.account_mask && row.direction === direction).reduce((sum, row) => sum + row.amount_minor, 0));
});

test("h: a measure without a move-kind account falls through, kind change enables it", async t => {
  const f = await fixture(t, "no-move-kind"), gross = await ask(f, Q.totals, "totals", 0);
  assert.equal(gross.ledger.accounts[0].credits_minor, 18263);
  const before = f.seen.sql.length, refusedBody = await f.ask(Q.profit);
  assert.equal(classifyLedgerQuestion(Q.profit, { now: NOW }).kind, "totals");
  assert.equal(refusedBody.gaps[0]?.reason, "unsupported_question");
  assert.ok(f.seen.sql.slice(before).some(sql => /FROM fin_accounts/.test(sql)), "scope decision reached");
  assert.equal(refusedBody.ledger, undefined);
  f.raw("UPDATE fin_accounts SET account_kind='checking' WHERE account_slug='account-d'");
  const control = await ask(f, Q.profit, "totals", 0);
  assert.equal(control.ledger.net_minor, 18263);
});

for (const kind of ["merchant", "category", "recurring", "largest", "deposits"]) test(`i: ${kind} leads, notes and preserves the gross view`, async t => {
  const f = await fixture(t), body = await ask(f, Q[kind], kind);
  if (kind === "recurring") {
    unchanged(body, "own", Q[kind]);
    assert.equal(body.ledger.lead_monthly_total_minor, 0);
    assert.equal(body.ledger.flip.length, 0);
    assert.doesNotMatch(body.answer, /left out of the first figures/);
    return;
  }
  if (kind === 'category') {
    verifyCategoryPolicy(body, 'own', Q.category);
    assert.equal(body.ledger.lead_total_minor, 4710);
    assert.deepEqual(offered(body), []);
    const included = await ask(f, flipQuestion(Q.category, 'including transfers'), 'category');
    verifyCategoryPolicy(included, 'own', Q.category);
    assert.ok(included.ledger.transfers.every(pair => pair.excluded_from_totals));
    assert.doesNotMatch(included.answer, /With everything counted|Possible transfers are included/);
    // The original gross money view still exposes both raw movement legs.
    const gross = await ask(f, flipQuestion(Q.totals, 'including transfers'), 'totals');
    unchanged(gross, 'own', Q.totals);
    return;
  }
  const { lead, note } = blocks(body, "own", Q[kind]);
  assert.match(note, /say "including transfers"/);
  assert.deepEqual(oldKeys(body.ledger), head.own[Q[kind]].ledger);
  if (["merchant", "category"].includes(kind)) {
    assert.equal(body.ledger.lead_total_minor, 4710);
    assert.match(lead, /\$47\.10/);
  } else if (kind === "recurring") assert.equal(body.ledger.lead_monthly_total_minor, 0);
  else {
    assert.notEqual(lead, head.own[Q[kind]].answer.split("\nAccounts:")[0]);
    assert.doesNotMatch(lead, /TRANSFER (?:TO|FROM)/);
    assert.ok(body.ledger.lead_rows.length > 0);
  }
  const phrases = offered(body);
  assert.equal(phrases.length, 1);
  const flipped = await ask(f, flipQuestion(Q[kind], phrases[0]), kind);
  assert.equal(flipped.answer, reviewedFinalOffer(head.own[Q[kind]].answer + postedDisclosure));
  assert.deepEqual(oldKeys(flipped.ledger), head.own[Q[kind]].ledger);
});

test("i: recurrence recomputes after removing a paired cadence", async t => {
  const f = await fixture(t, "recurring-pairs"), body = await ask(f, "Show my recurring charges?", "recurring", 3);
  assert.equal(body.ledger.monthly_total_minor, 2713);
  assert.equal(body.ledger.recurring.length, 1);
  assert.deepEqual(body.ledger.possible_owned_movements, []);
  assert.equal(body.ledger.lead_monthly_total_minor, 2713);
  assert.equal(body.ledger.if_own_transfers.monthly_total_minor, 2713);
});

// Review regressions use real ledger reads; the gross view is the green control.
test("R1 lists exclude before ranking and retain the complete gross list", async t => {
  const f = await fixture(t, "own");
  const question = "What were my 2 largest expenses in September 2026 excluding transfers?";
  const body = await ask(f, question, "largest");
  const lead = body.answer.split("\nNote:")[0];
  assert.match(lead, /Fixture Store/);
  assert.match(lead, /Fixture Supplies/);
  assert.doesNotMatch(lead, /TRANSFER TO/);
  assert.match(body.answer.split("With everything counted:")[1], /TRANSFER TO/);
  const control = await ask(f, question.replace("excluding", "including"), "largest");
  assert.match(control.answer.split("\nAccounts:")[0], /TRANSFER TO/);
});

test("R1 deposits omit withdrawals in the lead and list them in gross", async t => {
  const f = await fixture(t, "investment");
  const body = await ask(f, Q.deposits, "deposits");
  assert.match(body.answer.split("\nNote:")[0], /Fixture client deposit/);
  assert.doesNotMatch(body.answer.split("\nNote:")[0], /TRANSFER FROM/);
  assert.match(body.answer.split("With everything counted:")[1], /TRANSFER FROM/);
  const control = await ask(f, flipQuestion(Q.deposits, "including withdrawals"), "deposits");
  assert.match(control.answer.split("\nAccounts:")[0], /TRANSFER FROM/);
});

for (const kind of ["loan", "line_of_credit"]) test(`R3 ${kind} advances are not profit and their flip restores them`, async t => {
  const f = await fixture(t, "plain");
  const control = await ask(f, Q.profit, "totals", 0);
  f.account("account-loan", "7777", kind);
  f.add("advance-out", "2026-09-12", 500000, "outflow", "TRANSFER TO account 1111", null, null, "account-loan");
  f.add("advance-in", "2026-09-12", 500000, "inflow", "TRANSFER FROM account 7777");
  for (const measure of ["profit", "net income", "cash flow"]) {
    const question = Q.profit.replace("profit", measure);
    const body = await ask(f, question);
    assert.equal(body.ledger.net_minor, control.ledger.net_minor);
    assert.equal(account(body, "1111").credits_minor, 73129);
    assert.equal(account(body, "7777").debits_minor, 0, "both owned legs leave the lead");
    assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 500000);
    assert.match(body.answer, /\$5,000\.00 in loan or line-of-credit proceeds left out/);
    const flip = await ask(f, flipQuestion(question, "including loan proceeds"));
    assert.equal(flip.ledger.net_minor, control.ledger.net_minor + 500000);
    assert.equal(account(flip, "7777").debits_minor, 500000);
  }
});

test("m1 only excluded rows contributing to this figure justify a Note", async t => {
  const f = await fixture(t);
  for (const question of ["How much did I spend at Fixture Store in September 2026?", "How much income came from Fixture client in September 2026?", Q.recurring]) {
    const body = await f.ask(question);
    assert.equal(body.ledger.transfers.length, 1, "the excluded-pair decision was reached");
    assert.doesNotMatch(body.answer, /left out of the first figures|\nNote:/);
    assert.deepEqual(body.ledger.flip, []);
  }
  const control = await ask(f);
  assert.match(control.answer, /left out of the first figures/);
});

test("m2 unmatched category withdrawals disclose the same exclusion as the lead", async t => {
  const f = await fixture(t, "category-withdrawal"), body = await ask(f, Q.totals, "totals", 0);
  assert.equal(body.ledger.unmatched_transfers.length, 1);
  assert.match(body.answer, /unmatched \(left out of the first figures as a retirement or investment withdrawal; kept in the gross figures\)/);
  const control = await ask(f, flipQuestion(Q.totals, "including withdrawals"), "totals", 0);
  assert.match(control.answer, /unmatched \(retained in income\/spend totals\)/);
});

// Second review: advisory matches cannot establish a loan advance.
for (const kind of ["loan", "line_of_credit"]) for (const arm of ["customer", "refund", "ambiguous", "external-payee", "advance-refund", "advance-customer", "external-mask-payee"]) {
  test(`F1 ${kind} ${arm} stays in income and cannot reverse profit`, async t => {
    const f = await fixture(t, "plain");
    const baseline = await ask(f, Q.profit, "totals", 0);
    f.account("debt", "6193", kind);
    f.add("debt-adjustment", "2026-09-20", 41000, "outflow",
      arm === "refund" ? "Loan fee reversal" : (arm.startsWith("external-") || arm.startsWith("advance-")) ? "TRANSFER TO account 1111" : "Debt adjustment", null, null, "debt");
    f.add("receipt", "2026-09-20", 41000, "inflow", {
      customer: `Customer payment for ${kind === "loan" ? "loan" : "credit line"} account 6193 consultation`,
      "advance-refund": "TRANSFER FROM account 6193 REFUND of prior fee",
      "advance-customer": "TRANSFER FROM account 6193 customer receipt",
      refund: "REFUND of prior fee from account 6193",
      ambiguous: "Adjustment for account 6193",
      "external-payee": "TRANSFER FROM account 6193",
      "external-mask-payee": "TRANSFER FROM account 6193",
    }[arm]);
    if (["customer", "external-payee"].includes(arm)) f.raw("UPDATE fin_transactions SET payee='Fixture Customer' WHERE txn_uid='receipt'");
    if (arm === "external-mask-payee") f.raw("UPDATE fin_transactions SET payee='Fixture Supplier account 6193' WHERE txn_uid='receipt'");
    // Keep gross cash positive while a false exclusion would make it negative.
    f.add("equipment", "2026-09-25", baseline.ledger.net_minor + 25000, "outflow", "Equipment Outlet");
    for (const measure of ["profit", "net income", "cash flow"]) {
      const question = Q.profit.replace("profit", measure);
      const control = await ask(f, flipQuestion(question, "including loan proceeds"));
      assert.equal(control.ledger.net_minor, 16000);
      const body = await ask(f, question);
      assert.equal(body.ledger.transfers.length, 1, "advisory pair reached the exclusion decision");
      assert.equal(body.ledger.net_minor, 16000, "a receipt is retained even when an owned loan is mentioned");
      assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 0);
      assert.equal(body.ledger.transfers[0].excluded_from_lead, false);
    }
  });
}

test("F2 a below-cutoff transfer never claims to change the displayed top two", async t => {
  const f = await fixture(t, "own");
  f.raw("UPDATE fin_transactions SET amount_minor=800 WHERE txn_uid IN ('move-out','move-in')");
  const question = "What were my 2 largest expenses in September 2026?";
  const body = await ask(f, question, "largest");
  assert.equal(body.ledger.default_exclusions.own_transfer_minor, 800, "candidate-pool exclusion was reached");
  const control = await ask(f, flipQuestion(question, "including transfers"), "largest");
  assert.deepEqual(body.ledger.lead_rows, body.ledger.rows);
  assert.deepEqual(body.ledger.lead_rows, control.ledger.lead_rows);
  assert.doesNotMatch(body.answer, /left out of the first figures/);
  assert.deepEqual(body.ledger.flip, []);
  f.raw("UPDATE fin_transactions SET amount_minor=31000 WHERE txn_uid IN ('move-out','move-in')");
  const changed = await ask(f, question, "largest");
  assert.notDeepEqual(changed.ledger.lead_rows, changed.ledger.rows);
  assert.match(changed.answer, /Note: \$310\.00.*left out of the first figures/);
  assert.deepEqual(changed.ledger.flip, ["including transfers"]);
});

test("F1 exact owned-account payees retain the genuine advance control", async t => {
  const f = await fixture(t, "plain"), baseline = await ask(f, Q.profit, "totals", 0);
  f.account("debt", "6193", "loan");
  f.add("advance-out", "2026-09-20", 41000, "outflow", "TRANSFER TO account 1111", null, null, "debt");
  f.add("advance-in", "2026-09-20", 41000, "inflow", "TRANSFER FROM account 6193");
  f.raw("UPDATE fin_transactions SET payee='account 6193' WHERE txn_uid='advance-in'");
  f.raw("UPDATE fin_transactions SET payee='account 1111' WHERE txn_uid='advance-out'");
  const body = await ask(f, Q.profit);
  assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 41000);
  assert.equal(body.ledger.net_minor, baseline.ledger.net_minor);
  const control = await ask(f, flipQuestion(Q.profit, "including loan proceeds"));
  assert.equal(control.ledger.net_minor, baseline.ledger.net_minor + 41000);
});

// Third-review probes ported through the real SQLite reader and renderer.
for (const kind of ["loan", "line_of_credit"]) for (const measure of ["profit", "net income", "cash flow"]) {
  test(`R3 review bare reciprocal masks: ${kind}, ${measure}`, async t => {
    const f = await fixture(t, "plain");
    const question = Q.profit.replace("profit", measure);
    const baseline = await ask(f, question, "totals", 0);
    f.account("debt", "6193", kind);
    f.add("advance-out", "2026-09-20", 51000, "outflow", "TRANSFER TO 1111", null, null, "debt");
    f.add("advance-in", "2026-09-20", 51000, "inflow", "TRANSFER FROM 6193");
    const included = await ask(f, flipQuestion(question, "including loan proceeds"));
    assert.equal(included.ledger.net_minor, baseline.ledger.net_minor + 51000);
    const body = await ask(f, question);
    assert.equal(body.ledger.net_minor, baseline.ledger.net_minor);
    assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 51000);
    assert.match(body.answer, /Note:.*\$510\.00.*loan/);
    f.raw("UPDATE fin_transactions SET description=replace(description,'TO 1111','TO account 1111') WHERE txn_uid='advance-out'");
    f.raw("UPDATE fin_transactions SET description=replace(description,'FROM 6193','FROM account 6193') WHERE txn_uid='advance-in'");
    assert.equal((await ask(f, question)).ledger.net_minor, baseline.ledger.net_minor);
  });
}

for (const description of [
  "TRANSFER FROM Outside payer for consultation on account 6193",
  "TRANSFER FROM Outside payer; memo account 6193",
  "TRANSFER FROM account 6193 or account 1111",
]) test(`R3 review immediate sender: ${description}`, async t => {
  const f = await fixture(t, "plain"), baseline = await ask(f, Q.profit, "totals", 0);
  f.account("debt", "6193", "loan");
  f.add("advance-out", "2026-09-20", 51000, "outflow", "TRANSFER TO account 1111", null, null, "debt");
  f.add("advance-in", "2026-09-20", 51000, "inflow", description);
  for (const measure of ["profit", "net income", "cash flow"]) {
    const question = Q.profit.replace("profit", measure);
    const body = await ask(f, question);
    assert.equal(body.ledger.net_minor, baseline.ledger.net_minor + 51000);
    assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 0);
    assert.equal((await ask(f, flipQuestion(question, "including loan proceeds"))).ledger.net_minor, body.ledger.net_minor);
  }
  f.raw("UPDATE fin_transactions SET description='TRANSFER FROM account 6193' WHERE txn_uid='advance-in'");
  assert.equal((await ask(f, Q.profit)).ledger.default_exclusions.loan_proceeds_minor, 51000, "genuine sender control");
});

for (const arm of ["duplicate-mask", "outside-destination", "kind-conflict"]) test(`R3 review locator conflict stays counted: ${arm}`, async t => {
  const f = await fixture(t, "plain"), baseline = await ask(f, Q.profit, "totals", 0);
  f.account("debt", "6193", "loan");
  f.add("advance-out", "2026-09-20", 51000, "outflow", arm === "outside-destination" ? "TRANSFER TO Outside payee for account 1111" : "TRANSFER TO 1111", null, null, "debt");
  f.add("advance-in", "2026-09-20", 51000, "inflow", arm === "kind-conflict" ? "TRANSFER FROM checking 6193" : "TRANSFER FROM 6193");
  if (arm === "duplicate-mask") f.account("other", "6193", "savings");
  const body = await ask(f, Q.profit, "totals", arm === "kind-conflict" ? 0 : 1);
  assert.equal(body.ledger.net_minor, baseline.ledger.net_minor + 51000);
  assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 0);
  f.raw("UPDATE fin_accounts SET mask='9142' WHERE account_slug='other'");
  f.raw("UPDATE fin_transactions SET description='TRANSFER TO 1111' WHERE txn_uid='advance-out'");
  f.raw("UPDATE fin_transactions SET description='TRANSFER FROM 6193' WHERE txn_uid='advance-in'");
  assert.equal((await ask(f, Q.profit)).ledger.default_exclusions.loan_proceeds_minor, 51000);
});

// Fourth review: ordinary channels do not change the immediate counterparty.
for (const prefix of ["", "ONLINE ", "AUTOMATIC ", "MOBILE ", "INTERNET "]) {
  for (const kind of ["loan", "line_of_credit"]) for (const measure of ["profit", "net income", "cash flow"]) {
    test(`R4 channel advance: ${prefix || "plain"} ${kind} ${measure}`, async t => {
      const f = await fixture(t, "plain"), question = Q.profit.replace("profit", measure);
      const baseline = await ask(f, question, "totals", 0);
      f.add("equipment", "2026-09-25", baseline.ledger.net_minor + 23000, "outflow", "Equipment Outlet");
      f.account("debt", "6193", kind);
      f.add("advance-out", "2026-09-20", 51000, "outflow", `${prefix}TRANSFER TO account 1111`, null, null, "debt");
      f.add("advance-in", "2026-09-20", 51000, "inflow", `${prefix}TRANSFER FROM account 6193`);
      f.raw("UPDATE fin_transactions SET payee='account 1111' WHERE txn_uid='advance-out'");
      f.raw("UPDATE fin_transactions SET payee='account 6193' WHERE txn_uid='advance-in'");
      const included = await ask(f, flipQuestion(question, "including loan proceeds"));
      assert.equal(included.ledger.net_minor, 28000, "inclusion control reaches a positive gross result");
      const body = await ask(f, question);
      assert.equal(body.ledger.net_minor, -23000);
      assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 51000);
      assert.equal(account(body, "6193").debits_minor, 0);
      assert.match(body.answer, /Note:.*\$510\.00.*loan/);
      assert.equal(f.modelCalls, 0);
    });
  }
  for (const kind of ["loan", "line_of_credit"]) for (const arm of ["sender", "refund", "payee", "ambiguous", "unknown-prefix"]) {
    test(`R4 channel veto: ${prefix || "plain"} ${kind} ${arm}`, async t => {
      const f = await fixture(t, "plain"), baseline = await ask(f, Q.profit, "totals", 0);
      f.add("equipment", "2026-09-25", baseline.ledger.net_minor + 23000, "outflow", "Equipment Outlet");
      f.account("debt", "6193", kind);
      f.add("advance-out", "2026-09-20", 51000, "outflow", `${prefix}TRANSFER TO account 1111`, null, null, "debt");
      const sender = arm === "sender" ? "Outside payer memo account 6193" : "account 6193";
      f.add("advance-in", "2026-09-20", 51000, "inflow",
        `${arm === "unknown-prefix" ? "UNRECOGNIZED " : ""}${prefix}TRANSFER FROM ${sender}${arm === "refund" ? " REFUND" : ""}`);
      if (arm === "payee") f.raw("UPDATE fin_transactions SET payee='Outside payee account 6193' WHERE txn_uid='advance-in'");
      if (arm === "ambiguous") f.account("other", "6193", "savings");
      for (const measure of ["profit", "net income", "cash flow"]) {
        const question = Q.profit.replace("profit", measure), body = await ask(f, question);
        assert.equal(body.ledger.transfers.length, 1, "advisory pair reaches the veto decision");
        assert.equal(body.ledger.net_minor, 28000);
        assert.equal(body.ledger.default_exclusions.loan_proceeds_minor, 0);
        assert.equal((await ask(f, flipQuestion(question, "including loan proceeds"))).ledger.net_minor, 28000);
      }
      f.raw("UPDATE fin_accounts SET mask='9142' WHERE account_slug='other'");
      f.raw("UPDATE fin_transactions SET payee=NULL, description=? WHERE txn_uid='advance-in'", `${prefix}TRANSFER FROM account 6193`);
      const control = await ask(f, Q.profit);
      assert.equal(control.ledger.default_exclusions.loan_proceeds_minor, 51000, "uncontested channel control excludes the advance");
      assert.equal(control.ledger.net_minor, -23000);
    });
  }
}

// R5: advisory pairs cannot exclude an unproved leg; a separately named owned leg remains excluded.
for (const kind of ["savings", "investment", "retirement"]) for (const arm of ["customer", "refund", "outside-out", "ambiguous", "undirected"]) {
  test(`R5 cash and withdrawal evidence: ${kind} ${arm}`, async t => {
    const f = await fixture(t, "plain");
    f.account("other", "7351", kind);
    f.add("pair-out", "2026-09-20", 62000, "outflow", arm === "customer" ? "Asset adjustment for account 1111" : "TRANSFER TO account 1111", null, null, "other");
    f.add("pair-in", "2026-09-20", 62000, "inflow", arm === "customer" ? "Customer receipt" : arm === "refund" ? "TRANSFER FROM account 7351 REFUND" : arm === "undirected" ? "Adjustment mentioning account 7351" : "TRANSFER FROM account 7351");
    if (arm === "customer") f.raw("UPDATE fin_transactions SET payee='Outside buyer' WHERE txn_uid='pair-in'");
    if (arm === "outside-out") f.raw("UPDATE fin_transactions SET payee='Outside seller' WHERE txn_uid='pair-out'");
    if (arm === "ambiguous") f.account("duplicate", "7351", "savings");
    const facts = f.rows("SELECT t.*,a.account_kind FROM fin_transactions t JOIN fin_accounts a USING(account_slug) WHERE t.posted_on BETWEEN '2026-09-01' AND '2026-09-30'");
    const rawNet = facts.filter(row => ['checking','savings','card'].includes(row.account_kind))
      .reduce((n,row) => n + (row.direction === 'inflow' ? row.amount_minor : -row.amount_minor), 0);
    const rawCashCredits = facts.filter(row => row.account_slug === 'account-a' && row.direction === 'inflow')
      .reduce((n,row) => n + row.amount_minor, 0);
    const unconfirmedDestination = !['customer','outside-out'].includes(arm);
    const flip = kind === "savings" ? "including transfers" : "including withdrawals";
    for (const question of [Q.profit, Q.profit.replace("profit", "net income"), Q.profit.replace("profit", "cash flow"), Q.deposits]) {
      const queryKind = question === Q.deposits ? "deposits" : "totals";
      const held = queryKind === 'totals' && unconfirmedDestination;
      const body = await ask(f, question, queryKind, held ? 0 : 1);
      const gross = await ask(f, flipQuestion(question, flip), queryKind, held ? 0 : 1);
      if (held) {
        for (const result of [body, gross]) {
          assert.equal(result.ledger.reason, 'money_out_destination_unconfirmed');
          assert.equal(result.ledger.total_minor, null);
          assert.equal(result.evidence_gate.complete, false);
          const candidate = result.ledger.possible_payments.find(row => row.amount_minor === 62000);
          assert.ok(candidate?.destination_unconfirmed, 'equal connected counterpart decision reached');
          assert.ok(result.citations.some(row => row.n === candidate.n && row.amount_minor === 62000));
        }
        continue;
      }
      assert.equal(body.ledger.candidate_transfer_count, 1, "advisory pair reaches exclusion decision");
      assert.equal(body.ledger.default_exclusions.own_transfer_minor, 0);
      assert.equal(body.ledger.default_exclusions.withdrawal_minor, 0);
      assert.match(body.ledger.transfers[0].kept_reason, /counterparty evidence/);
      if (queryKind === "deposits") {
        assert.ok(body.ledger.lead_rows.some(row => row.account_mask === "1111" && row.amount_minor === 62000), "the receipt remains in the displayed deposits");
        assert.deepEqual(body.ledger.lead_rows, gross.ledger.lead_rows);
      }
      else {
        assert.equal(body.ledger.net_minor, rawNet);
        assert.equal(gross.ledger.net_minor, rawNet);
        assert.equal(account(body, "1111").credits_minor, rawCashCredits);
        assert.equal(account(gross, "1111").credits_minor, rawCashCredits);
      }
      assert.equal(f.modelCalls, 0);
    }
    f.raw("UPDATE fin_accounts SET mask='9142' WHERE account_slug='duplicate'");
    f.raw("UPDATE fin_transactions SET payee=NULL, description='TRANSFER TO account 1111' WHERE txn_uid='pair-out'");
    f.raw("UPDATE fin_transactions SET payee=NULL, description='TRANSFER FROM account 7351' WHERE txn_uid='pair-in'");
    const control = await ask(f, Q.profit);
    assert.equal(control.ledger.default_exclusions[kind === "savings" ? "own_transfer_minor" : "withdrawal_minor"], 62000, "genuine directed transfer control excludes the same amount");
  });
}

for (const scenario of ["own", "card", "investment", "retirement", "category-withdrawal"]) test(`R5 genuine exclusion control: ${scenario}`, async t => {
  const f = await fixture(t, scenario), body = await ask(f, Q.profit, "totals", scenario === "category-withdrawal" || scenario === "card" ? 0 : 1);
  const type = ["own", "card"].includes(scenario) ? "own_transfer_minor" : "withdrawal_minor";
  if (scenario === 'card') {
    assert.equal(body.ledger.payment_exclusions.total_minor, 30878);
    const included = await ask(f, flipQuestion(Q.profit, 'including transfers'), 'totals', 0);
    assert.equal(included.ledger.payment_exclusions.total_minor, 30878);
    assert.equal(included.ledger.net_minor, body.ledger.net_minor);
    assert.equal(f.modelCalls, 0);
    return;
  }
  assert.ok(body.ledger.default_exclusions[type] > 0);
  const gross = await f.ask(flipQuestion(Q.profit, type === "own_transfer_minor" ? "including transfers" : "including withdrawals"));
  assert.equal(gross.ledger.default_exclusions[type], 0);
  assert.equal(f.modelCalls, 0);
});

// Ordinary category expenses exclude identified owned movements in every
// rendering; an invitation cannot promise to put them back into spending.
async function categoryOwnedContract(f) {
  for (const q of [Q.category, flipQuestion(Q.category, 'including transfers')]) {
    const body = await ask(f, q, 'category');
    assert.equal(body.ledger.total_minor, 4710);
    assert.equal(body.ledger.unsorted_minor, 1903);
    assert.equal(body.ledger.unconfirmed_category_count, 1);
    assert.equal(body.ledger.excluded_own_transfer_minor, 23617);
    assert.equal(body.ledger.includes_own_transfers, false);
    assert.ok(!body.ledger.flip.includes('including transfers'));
    assert.equal(body.ledger.known_own_transfer_in_lead, undefined);
    assert.equal(body.ledger.transfers[0].excluded_from_totals, true);
    assert.deepEqual(['outgoing','incoming'].map(side => body.ledger.transfers[0][side].amount_minor), [23617,23617]);
    assert.doesNotMatch(body.answer, /say "including transfers"|Possible transfers are included|With everything counted/);
    assert.match(body.answer, /Excluded detected own-account transfers: \$236\.17/);
  }
}
test('category owned moves retain raw evidence without an impossible spending flip', async t => {
  await categoryOwnedContract(await fixture(t));
});
test('category spending flip inverse mutant is killed with a green control', async t => {
  await categoryOwnedContract(await fixture(t));
  const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const source = readFileSync(url, 'utf8'), site = 'categoryOwned.size';
  assert.ok(source.split(site).length - 1 >= 2);
  const absolute = source.replaceAll(site, '0')
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, quote, path) => 'from ' + quote + new URL(path, url).href + quote);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(absolute).toString('base64'));
  const changed = await fixture(t, 'own', { answer: mutant.withLedgerAnswer });
  await assert.rejects(() => categoryOwnedContract(changed), assert.AssertionError);
});

test('category payment-only exclusions preserve their raw receipt and truthful flags', async t => {
  const setup = async answer => {
    const f = await fixture(t, 'plain', answer ? { answer } : {});
    f.account('payment-card','3333','card');
    f.add('payment-out','2026-09-19',4000,'outflow','PAYMENT TO CARD ENDING 3333','LOAN_PAYMENTS_CREDIT_CARD_PAYMENT','confirmed');
    f.add('payment-in','2026-09-20',4000,'inflow','PAYMENT THANK YOU',null,null,'payment-card');
    return f;
  };
  const oracle = body => {
    assert.equal(body.ledger.total_minor,7423);
    assert.equal(body.ledger.own_account_payments.total_minor,4000,'legacy spending summary counts outgoing postings only');
    assert.deepEqual(body.ledger.transfers,[],'repayments do not remain advisory transfer candidates');
    assert.equal(body.ledger.payment_exclusions.total_minor,8000,'both raw liability legs remain cited');
    assert.deepEqual(body.ledger.payment_exclusions.rows.map(r=>r.amount_minor),[4000,4000]);
    for(const row of body.ledger.payment_exclusions.rows) assert.equal(body.citations.find(c=>c.n===row.n).amount_minor,4000);
    assert.doesNotMatch(body.answer,/Possible transfers are included|say "including transfers"/);
  };
  oracle(await ask(await setup(),Q.category,'category',0));
  const url=new URL('../src/lib/ledger-answer.js',import.meta.url), source=readFileSync(url,'utf8');
  const site="const outgoing = payments.filter(item => item.row.direction === 'outflow');";
  assert.equal(source.split(site).length-1,1,'legacy direction decision reached once');
  const changed=source.replace(site,'const outgoing = payments;').replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_,q,p)=>'from '+q+new URL(p,url).href+q);
  const mutant=await import('data:text/javascript;base64,'+Buffer.from(changed).toString('base64'));
  const body=await ask(await setup(mutant.withLedgerAnswer),Q.category,'category',0);
  assert.throws(()=>oracle(body),assert.AssertionError,'receiving repayment cannot inflate the legacy outgoing total');
});
