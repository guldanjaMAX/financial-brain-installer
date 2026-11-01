import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { cmdAsk } from "../../brain.mjs";
import { accountLinkIdentity } from "../src/lib/fin-account-links.js";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import { claimSimpleFinAccess, runSimpleFinMaintenance, simpleFinConnectPageHtml,
  simpleFinFeedStatus } from "../src/lib/simplefin-bank-feed.js";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";

const NOW = "2026-10-29T12:00:00.000Z";
const STAMP = "2026-10-29T11:55:00.000Z";

async function ledgerFixture(t) {
  const fixture = await createProductFixture({ env: { BRAIN_TIMEZONE: "UTC" } });
  t.after(() => fixture.close());
  seedOwnedEntity(fixture, "owner", "Owner");
  fixture.raw(`INSERT INTO bank_feed_items
    (item_ref,institution_label,access_ciphertext,access_iv,environment,status,connected_at,last_synced_at)
    VALUES ('fixture-feed','Fixture Bank',?,?,'production','connected',?,?)`,
  randomBytes(24).toString("base64"), randomBytes(12).toString("base64"), STAMP, STAMP);
  fixture.addAccount = ({ slug, label, mask, kind = "card", role = "liability", mode = "live",
    status = "complete", from = "2026-08-01", to = "2026-10-29", sourceFeed = "bank-feed:fixture-feed" }) => {
    fixture.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,institution,label,account_kind,balance_role,mask,currency,
       feed_mode,status,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'owner','Fixture Bank',?,?,?,?,'USD',?,'open','feed',?,'confirmed',?)`,
    slug, label, kind, role, mask, mode, sourceFeed, STAMP);
    fixture.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,basis_note,computed_at,provenance,
       source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?, 'feed',?,'confirmed',?)`,
    slug, status, from, to,
    status === "complete" ? "Fixture complete coverage." : `Read from a bank export covering ${from} to ${to}.`,
    STAMP, sourceFeed, STAMP);
  };
  fixture.addBalance = (slug, day, amount) => fixture.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,currency,provenance,source_feed,basis_state,recorded_at)
    VALUES (?,?,?,?,'USD','feed','bank-feed:fixture-feed','confirmed',?)`, slug, day, amount, amount, STAMP);
  fixture.addTransaction = ({ id, slug, day, amount, direction = "outflow", payee = "Fixture Store" }) =>
    fixture.raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,currency,description,payee,
       provenance,source_feed,source_provider,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'USD',?,?,'feed','bank-feed:fixture-feed','simplefin','confirmed',?)`,
    id, slug, day, amount, direction, direction === "outflow" ? -amount : amount,
    `${payee} purchase`, payee, STAMP);
  fixture.ask = async (question, next = async gap => Response.json({ answer: null, citations: [], gaps: gap ? [gap] : [] })) =>
    withLedgerAnswer({ env: fixture.env, question, now: NOW, grantScope: { all: true },
      scopePrincipalKind: "owner" }, next).then(response => response.json());
  return fixture;
}

test("exact merchant prepositions outrank command-word vetoes without widening non-merchant target questions", () => {
  for (const [preposition, question, direction] of [
    ["at", "How much did I spend at Target this month?", "outflow"],
    ["from", "How much income came from Target this month?", "inflow"],
    ["to", "How much did I pay to Target this month?", "outflow"],
  ]) {
    const intent = classifyLedgerQuestion(question, { now: NOW });
    assert.equal(intent.kind, "merchant", `${preposition} reached exact merchant grammar`);
    assert.equal(intent.match, "Target");
    assert.equal(intent.direction, direction);
  }
  for (const merchant of ["Best Buy", "Dollar General", "Amazon"]) {
    assert.equal(classifyLedgerQuestion(`How much did I spend at ${merchant} this month?`, { now: NOW }).kind,
      "merchant", merchant);
  }
  assert.equal(classifyLedgerQuestion("What was my target spending this month?", { now: NOW }).kind, null,
    "a planning target is not silently promoted to a merchant");
  assert.equal(classifyLedgerQuestion("What were my expected expenses this month?", { now: NOW }).kind, null,
    "the existing command-word refusal remains a green control");
});

test("balance selectors resolve exact labels before aliases and syntactic kinds", async t => {
  const fixture = await ledgerFixture(t);
  for (const account of [
    { slug: `simplefin-${"a".repeat(32)}`, label: "Everyday Card", mask: "1111", amount: -12345,
      kind: "other", role: "neither" },
    { slug: `simplefin-${"b".repeat(32)}`, label: "Everyday Card", mask: "2222", amount: -6789,
      kind: "other", role: "neither" },
    { slug: `simplefin-${"d".repeat(32)}`, label: "Travel", mask: "5555", amount: -700,
      kind: "other", role: "neither" },
    { slug: "card-alias", label: "Everyday", mask: "3333", amount: -500 },
    { slug: "card-control", label: "Reviewed Card", mask: "4444", amount: -900 },
    { slug: "mask-collision-a", label: "First Mask Match", mask: "4321", amount: -1100,
      kind: "other", role: "neither" },
    { slug: "mask-collision-b", label: "Second Mask Match", mask: "4321", amount: -2200,
      kind: "other", role: "neither" },
  ]) {
    fixture.addAccount(account);
    fixture.addBalance(account.slug, "2026-10-29", account.amount);
  }
  const ambiguous = await fixture.ask("What is my Everyday Card balance?");
  assert.equal(ambiguous.ledger?.kind, "balance");
  assert.deepEqual(ambiguous.ledger.accounts.map(account => account.account_mask), ["1111", "2222"]);
  assert.match(ambiguous.answer, /Everyday Card.*1111[\s\S]*Everyday Card.*2222/);
  assert.doesNotMatch(ambiguous.answer, /3333|4444/,
    "exact label collisions outrank kind-stripped aliases and unrelated reviewed cards");

  const masked = await fixture.ask("What is the balance on my 4444?");
  assert.deepEqual(masked.ledger?.accounts.map(account => account.account_mask), ["4444"]);

  const duplicateMask = await fixture.ask("What is the balance on my account ending in 4321?");
  assert.deepEqual(duplicateMask.ledger?.accounts.map(account => account.account_mask), ["4321", "4321"]);
  assert.match(duplicateMask.answer, /First Mask Match.*4321[\s\S]*Second Mask Match.*4321/,
    "the named balance form labels every exact mask collision");

  const beforeLegacyMask = fixture.seen.sql.filter(sql => /FROM fin_accounts/.test(sql)).length;
  const legacyMask = await fixture.ask("What is my balance for account 4321?");
  assert.equal(legacyMask.gaps[0]?.reason, "ambiguous_account",
    "green control: the older non-selector mask form remains fail closed");
  assert.ok(fixture.seen.sql.filter(sql => /FROM fin_accounts/.test(sql)).length > beforeLegacyMask,
    "the non-selector mask ambiguity reached the account-inventory decision");

  const aliasOnly = await fixture.ask("What is my Travel Card balance?");
  assert.deepEqual(aliasOnly.ledger?.accounts.map(account => account.account_mask), ["5555"],
    "a kind-stripped alias remains available when no exact label exists");

  const kindOnly = await fixture.ask("What is my card balance?");
  assert.deepEqual(kindOnly.ledger?.accounts.map(account => account.account_mask), ["3333", "4444"],
    "green control: a question without an exact selector still uses its syntactic kind");

  let fallbackCalls = 0;
  const before = fixture.seen.sql.filter(sql => /FROM fin_accounts/.test(sql)).length;
  const unknown = await fixture.ask("What is my Unknown Card balance?", async gap => {
    fallbackCalls++;
    return Response.json({ answer: null, citations: [], gaps: [gap] });
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(unknown.gaps[0]?.reason, "no_accounts");
  assert.ok(fixture.seen.sql.filter(sql => /FROM fin_accounts/.test(sql)).length > before,
    "the unknown selector reached exact account inventory instead of matching a random account");
});

test("last-N transactions resolve a SimpleFIN label before its syntactic kind", async t => {
  assert.equal(classifyLedgerQuestion("Show my last 3 transactions on Everyday Card", { now: NOW }).accountSelector,
    "everyday card", "the optional account clause does not require a determiner");
  const fixture = await ledgerFixture(t);
  const simpleFinSlug = `simplefin-${"c".repeat(32)}`;
  fixture.addAccount({ slug: simpleFinSlug, label: "Everyday Card", mask: "1111",
    kind: "other", role: "neither" });
  fixture.addAccount({ slug: "card-b", label: "Reserve Card", mask: "2222" });
  for (let index = 0; index < 30; index++) {
    const day = new Date(Date.UTC(2026, 9, 29 - index)).toISOString().slice(0, 10);
    fixture.addTransaction({ id: `txn-${index}`, slug: simpleFinSlug, day,
      amount: 100 + index, payee: `Fixture Store ${index}` });
  }
  fixture.addTransaction({ id: "other-account", slug: "card-b", day: "2026-10-29", amount: 99999,
    payee: "Other Account Store" });
  const before = fixture.seen.sql.filter(sql => /JOIN fin_transactions/.test(sql)).length;
  const body = await fixture.ask("What were my last 30 transactions on my Everyday Card?");
  assert.equal(body.ledger?.kind, "transactions");
  assert.equal(body.ledger.requested_limit, 30);
  assert.equal(body.ledger.limit, 25);
  assert.equal(body.ledger.rows.length, 25);
  assert.equal(body.citations.length, 25);
  assert.equal(body.ledger.rows[0].posted_on, "2026-10-29");
  assert.ok(body.ledger.rows.every((row, index, rows) => !index || rows[index - 1].posted_on >= row.posted_on));
  assert.ok(body.ledger.rows.every(row => row.account_mask === "1111"));
  assert.match(body.answer, /2026-10-29.*Fixture Store 0.*-\$1\.00.*Everyday Card.*1111.*\[1\]/);
  assert.ok(fixture.seen.sql.filter(sql => /JOIN fin_transactions/.test(sql)).length > before,
    "the route reached the real bounded ledger reader");

  let fallbackCalls = 0;
  const unknown = await fixture.ask("What were my last 3 transactions on my Unknown Card?", async gap => {
    fallbackCalls++;
    return Response.json({ answer: null, citations: [], gaps: [gap] });
  });
  assert.equal(fallbackCalls, 1, "an unknown selector reaches document fallback exactly once");
  assert.equal(unknown.gaps[0]?.reason, "no_accounts");

  const unscoped = await fixture.ask("What were my last 1 transactions?");
  assert.equal(unscoped.ledger?.rows[0].account_mask, "2222",
    "green control: a last-N question without a selector still reads the authorized inventory");
});

test("named last-N reads structurally exclude every unrelated account sibling", async t => {
  const cases = [
    {
      name: "more than 5,000 unrelated rows",
      prepare(fixture) {
        fixture.addAccount({ slug: "unrelated-history", label: "Unrelated History", mask: "9001" });
        fixture.raw(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<5000)
          INSERT INTO fin_transactions
            (txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,currency,description,payee,
             provenance,source_feed,source_provider,basis_state,recorded_at)
          SELECT 'unrelated-'||n,'unrelated-history',date('2026-10-29','-'||(n%60)||' days'),
            100+n,'outflow',-(100+n),'USD','Unrelated purchase','Unrelated Store',
            'feed','bank-feed:fixture-feed','simplefin','confirmed',? FROM seq`, STAMP);
      },
    },
    {
      name: "an unrelated approved twin with unknown live coverage",
      prepare(fixture) {
        fixture.addAccount({ slug: "unrelated-manual", label: "Unrelated Twin", mask: "9002",
          mode: "manual", sourceFeed: "manual:fixture", status: "complete" });
        fixture.addAccount({ slug: "unrelated-live", label: "Unrelated Twin", mask: "9002",
          mode: "live", status: "partial" });
        const fields = "id,account_slug,entity_slug,mask,account_kind,institution,currency,balance_role,feed_mode,external_ref,source_feed";
        const manual = fixture.first(`SELECT ${fields} FROM fin_accounts WHERE account_slug='unrelated-manual'`);
        const live = fixture.first(`SELECT ${fields} FROM fin_accounts WHERE account_slug='unrelated-live'`);
        fixture.raw(`INSERT INTO fin_account_links
          (tenant_id,manual_account_slug,live_account_slug,identity_json,link_plan_hash,linked_at)
          VALUES ('primary','unrelated-manual','unrelated-live',?,?,'2026-10-29T11:56:00.000Z')`,
        JSON.stringify([accountLinkIdentity(manual), accountLinkIdentity(live)]), "a".repeat(64));
      },
    },
  ];
  for (const row of cases) await t.test(row.name, async child => {
    const fixture = await ledgerFixture(child);
    const selectedSlug = `simplefin-${"e".repeat(32)}`;
    fixture.addAccount({ slug: selectedSlug, label: "Everyday Card", mask: "1111",
      kind: "other", role: "neither" });
    for (let index = 0; index < 3; index++) fixture.addTransaction({
      id: `selected-${index}`, slug: selectedSlug, day: `2026-10-2${9 - index}`,
      amount: 500 + index, payee: `Selected Store ${index}`,
    });
    row.prepare(fixture);

    const beforeSelected = fixture.seen.sql.length;
    const selected = await fixture.ask("What were my last 3 transactions on my Everyday Card?");
    assert.equal(selected.ledger?.kind, "transactions");
    assert.equal(selected.ledger.rows.length, 3);
    assert.ok(selected.ledger.rows.every(item => item.account_mask === "1111"));
    const selectedFactIndex = fixture.seen.sql.findLastIndex((sql, index) =>
      index >= beforeSelected && /JOIN fin_transactions/.test(sql));
    assert.ok(selectedFactIndex >= beforeSelected,
      "the exact-account request reached the bounded transaction snapshot reader");
    const mapping = JSON.parse(fixture.seen.binds[selectedFactIndex][0]);
    assert.deepEqual([...new Set(mapping.map(item => item.effective))], [selectedSlug],
      "the snapshot query maps only the selected effective account");

    const beforeUnscoped = fixture.seen.sql.length;
    const unscoped = await fixture.ask("What were my last 3 transactions?");
    assert.equal(unscoped.gaps[0]?.reason, "ledger_unavailable",
      "green control: the same safeguard still refuses when the unrelated account is in scope");
    const refusalSql = fixture.seen.sql.slice(beforeUnscoped);
    assert.ok(refusalSql.some(sql => /FROM fin_accounts/.test(sql)),
      "the unscoped refusal reached the current account inventory");
    assert.equal(refusalSql.some(sql => /JOIN fin_transactions/.test(sql)),
      row.name === "more than 5,000 unrelated rows",
      "the row-limit arm reads bounded facts, while the unknown-twin arm closes before facts");
  });
});

test("named snapshot allow-lists still validate unrelated inventory atomically", async t => {
  const fixture = await ledgerFixture(t);
  const selectedSlug = `simplefin-${"f".repeat(32)}`;
  fixture.addAccount({ slug: selectedSlug, label: "Everyday Card", mask: "1111",
    kind: "other", role: "neither" });
  fixture.addAccount({ slug: "unrelated-current", label: "Unrelated Current", mask: "9003" });
  for (let index = 0; index < 3; index++) fixture.addTransaction({
    id: `atomic-${index}`, slug: selectedSlug, day: `2026-10-2${9 - index}`,
    amount: 700 + index, payee: `Atomic Store ${index}`,
  });

  let changed = 0;
  const prepare = fixture.env.DB.prepare;
  fixture.env.DB.prepare = sql => {
    if (/JOIN fin_transactions/.test(sql) && !changed++) {
      fixture.raw("UPDATE fin_accounts SET label='Changed during snapshot' WHERE account_slug='unrelated-current'");
    }
    return prepare(sql);
  };
  let fallbackCalls = 0;
  const refused = await fixture.ask("What were my last 3 transactions on my Everyday Card?", async gap => {
    fallbackCalls++;
    return Response.json({ answer: null, citations: [], gaps: [gap] });
  });
  assert.equal(changed, 1, "the atomic snapshot decision point changed an unrelated inventory member");
  assert.equal(fallbackCalls, 1);
  assert.equal(refused.gaps[0]?.reason, "ledger_unavailable");
  assert.ok(fixture.seen.sql.some(sql => /JOIN fin_transactions/.test(sql)),
    "the selected-account fact statement was prepared inside the guarded snapshot");

  fixture.env.DB.prepare = prepare;
  const control = await fixture.ask("What were my last 3 transactions on my Everyday Card?");
  assert.equal(control.ledger?.rows.length, 3,
    "green control: the same structural selection succeeds when the inventory is stable");
});

test("SimpleFIN-shaped partial coverage returns a cited partial largest-expenses answer", async t => {
  const fixture = await ledgerFixture(t);
  const slug = `simplefin-${"a".repeat(32)}`;
  fixture.addAccount({ slug, label: "Everyday Card", mask: null, kind: "other", role: "neither",
    status: "partial", from: "2026-08-01", to: "2026-10-29" });
  fixture.addTransaction({ id: "small", slug, day: "2026-10-10", amount: 1200, payee: "Fixture Small" });
  fixture.addTransaction({ id: "large", slug, day: "2026-10-20", amount: 4500, payee: "Fixture Large" });
  let fallbackCalls = 0;
  const beforeInventory = fixture.seen.sql.filter(sql => /FROM fin_accounts/.test(sql)).length;
  const body = await fixture.ask("What were my 3 largest expenses this month?", async gap => {
    fallbackCalls++;
    return Response.json({ answer: null, citations: [], gaps: [gap] });
  });
  assert.equal(fallbackCalls, 0, "the ranked ledger answer does not disappear into document fallback");
  assert.ok(fixture.seen.sql.filter(sql => /FROM fin_accounts/.test(sql)).length > beforeInventory,
    "the production-shaped account reached the ledger coverage decision");
  assert.equal(body.ledger?.kind, "largest");
  assert.equal(body.ledger.complete, false);
  assert.deepEqual(body.ledger.rows.map(row => row.amount_minor), [4500, 1200]);
  assert.equal(body.citations.length, 2);
  assert.match(body.answer, /partial|available ledger records/i);
  assert.equal(body.gaps[0]?.code, "ledger_partial_coverage");
  assert.equal(body.evidence_gate?.partial, true);
});

async function captureAsk(body) {
  const directory = mkdtempSync(join(tmpdir(), "brain-ask-money-"));
  try {
    const manifest = join(directory, "brain.manifest.json");
    writeFileSync(manifest, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "brain.invalid" },
    }));
    const printed = [];
    const original = console.log;
    console.log = (...parts) => printed.push(parts.join(" "));
    try {
      await cmdAsk(manifest, {
        adminKey: randomBytes(24).toString("hex"),
        ask: async () => "What did the ledger find?",
        http: async () => Response.json(body),
      });
    } finally {
      console.log = original;
    }
    return printed.join("\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("brain ask prints a safe ledger gap code and never labels a refusal high-confidence", async () => {
  const refused = await captureAsk({
    answer: "The documents do not answer the question.",
    results: [{ title: "Fixture candidate" }],
    citations: [],
    gaps: [{ type: "ledger_out_of_coverage", reason: "period_outside_coverage", code: "period_outside_coverage" }],
    confidence: { percent: 80, band: "high", basis: ["fixture search scope"] },
    evidence_gate: { supported: false, complete: false, reason: "No supported answer" },
  });
  const plainRefusal = refused.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plainRefusal, /Ledger gap: period_outside_coverage/);
  assert.doesNotMatch(refused, /Confidence[^\n]*\(high\)/i);

  const answered = await captureAsk({
    answer: "The ledger supports the answer [1].",
    citations: [{ n: 1, title: "Fixture ledger row", source: "ledger" }],
    results: [], gaps: [],
    confidence: { percent: 80, band: "high", basis: ["cited ledger row"] },
    evidence_gate: { supported: true, complete: true, reason: "read from covered ledger rows" },
  });
  assert.match(answered, /Confidence: 80% \(high\)/,
    "a supported cited answer remains the green high-confidence control");
});

class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.textContent = ""; this.options = []; }
  append(...children) {
    this.children.push(...children);
    if (this.tag === "select") this.options.push(...children);
  }
  replaceChildren(...children) { this.children = [...children]; }
}

async function renderConnectionStatus(statusBody) {
  const { html } = simpleFinConnectPageHtml({});
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "the owner page script was found");
  const elements = new Map([
    "claim", "claim-button", "claim-status", "token", "entity-create", "entity-name", "entity-kind",
    "entity-status", "entity-details", "account-status", "accounts", "refresh", "connections",
  ].map(id => [id, new Element(id === "entity-kind" ? "select" : "div")]));
  elements.get("entity-name").value = "";
  elements.get("entity-kind").value = "business";
  const calls = [];
  const response = body => ({ ok: true, async json() { return body; } });
  const context = {
    document: {
      getElementById: id => elements.get(id),
      createElement: tag => new Element(tag),
    },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    fetch: async path => {
      calls.push(path);
      if (path === "/api/bank-feed/status") return response(statusBody);
      if (path === "/api/bank-feed/accounts") return response({ accounts: [], summary: { assignment_required: 0 } });
      return response({ entities: [] });
    },
  };
  vm.runInNewContext(script, context);
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
  return {
    calls,
    rendered: elements.get("connections").children
      .flatMap(card => card.children || [])
      .map(child => child.textContent),
  };
}

test("legacy durable SimpleFIN object artifacts fail closed at status and page boundaries", async t => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  fixture.raw(`INSERT INTO bank_feed_items
    (item_ref,institution_label,access_ciphertext,access_iv,environment,status,connected_at,last_synced_at)
    VALUES ('legacy-feed','Fixture Bank',?,?,'production','connected',?,?)`,
  randomBytes(24).toString("base64"), randomBytes(12).toString("base64"), STAMP, STAMP);
  const legacyArtifacts = ["[object Object]", "[object Object],[object Object]", "[object Object],Readable details"];
  fixture.raw(`INSERT INTO simplefin_connections
    (tenant_id,item_ref,backfill_start,backfill_next,backfill_end,next_pull_at,last_errlist_json,
     last_pull_partial,updated_at)
    VALUES ('primary','legacy-feed','2026-08-01','2026-08-01','2026-10-29',?, ?,1,?)`,
  STAMP, JSON.stringify(legacyArtifacts), STAMP);
  const before = fixture.seen.sql.length;
  const statusBody = await simpleFinFeedStatus(fixture.env);
  assert.ok(fixture.seen.sql.slice(before).some(sql => /last_errlist_json/.test(sql)),
    "the directly seeded durable status decision ran without maintenance");
  assert.deepEqual(statusBody.connections[0]?.provider_errors,
    legacyArtifacts.map(() => "SimpleFIN reported an issue without readable details."));
  const { calls, rendered } = await renderConnectionStatus(statusBody);
  assert.ok(calls.includes("/api/bank-feed/status"), "the owner page rendered the real status response");
  assert.ok(rendered.includes("SimpleFIN reported an issue without readable details."));
  assert.equal(rendered.some(value => value.includes("[object Object]")), false);

  fixture.raw(`UPDATE simplefin_connections SET last_errlist_json=? WHERE item_ref='legacy-feed'`,
    JSON.stringify(["Readable string control."]));
  const control = await simpleFinFeedStatus(fixture.env);
  assert.deepEqual(control.connections[0]?.provider_errors, ["Readable string control."],
    "green control: an ordinary persisted provider string remains readable");
});

test("SimpleFIN provider objects remain readable through maintenance, status, and page rendering", async t => {
  const fixture = await createProductFixture({ env: {
    BANK_FEED_PROVIDER: "simplefin",
    BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  } });
  t.after(() => fixture.close());
  const claimUrl = ["https", "://", "fixture-claim", ":", "fixture-value", "@bridge.example.invalid/claim/once"].join("");
  const accessUrl = ["https", "://", "fixture-access", ":", "fixture-value", "@bridge.example.invalid/data"].join("");
  const setupToken = Buffer.from(claimUrl, "utf8").toString("base64");
  const unreadable = "SimpleFIN reported an issue without readable details.";
  const providerCases = [
    { entry: { text: "Provider needs attention.", code: "fixture_attention" }, expected: "Provider needs attention." },
    { entry: "String control.", expected: "String control." },
    { entry: { code: "fixture_without_text" }, expected: unreadable },
    { entry: null, expected: unreadable },
    { entry: ["nested provider issue"], expected: unreadable },
    { entry: 17, expected: unreadable },
  ];
  let providerPulls = 0;
  const fetchImpl = async (input) => {
    const request = new Request(input);
    if (request.method === "POST") return new Response(accessUrl, { status: 200 });
    providerPulls++;
    return Response.json({
      accounts: [],
      errlist: providerCases.map(row => row.entry),
    });
  };
  await claimSimpleFinAccess(fixture.env, {
    requestId: "simplefin-message-shape-0001",
    setupToken,
    fetchImpl,
    now: "2026-10-29T10:00:00.000Z",
  });
  const maintenance = await runSimpleFinMaintenance(fixture.env, {
    fetchImpl,
    now: "2026-10-29T12:00:00.000Z",
    maxRequestsPerItem: 1,
  });
  assert.equal(providerPulls, 1, "the provider message-shape decision point ran through real staging");
  assert.equal(maintenance.items[0]?.partial, true);
  const expectedErrors = providerCases.map(row => row.expected);
  const storedErrors = JSON.parse(fixture.first("SELECT last_errlist_json FROM simplefin_connections").last_errlist_json);
  assert.deepEqual(storedErrors, expectedErrors, "stored provider issues are already readable");
  const statusBody = await simpleFinFeedStatus(fixture.env);
  assert.deepEqual(statusBody.connections[0]?.provider_errors, expectedErrors,
    "the status boundary preserves readable provider issues");

  const { calls, rendered } = await renderConnectionStatus(statusBody);
  assert.ok(calls.includes("/api/bank-feed/status"), "the real connection-status rendering decision ran");
  assert.ok(rendered.includes("Provider needs attention."));
  assert.ok(rendered.includes("String control."), "string provider messages remain a green control");
  assert.ok(rendered.includes("SimpleFIN reported an issue without readable details."));
  assert.equal(rendered.includes("[object Object]"), false);
});
