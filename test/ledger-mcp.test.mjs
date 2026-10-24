import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeAdminKeyFile } from "../operations/admin-key-file.mjs";
import { createProductFixture, seedOwnedEntity } from "../worker/test/product-contract-fixture.mjs";
import { withLedgerAnswer } from "../worker/src/lib/ledger-answer.js";
import { handleMcp } from "../worker/src/lib/mcp-endpoint.js";

const NOW = "2026-10-11T12:00:00Z";
const PRESERVE = "Preserve the ledger answer's exact amounts, account masks, dates, and coverage bounds.";
const SIDE_NOTE = "Side note: Gmail has been paused since Wed Oct 7, so anything only in Gmail after that date may be missing.";
const NO_MATCH = 'No match in this search. Search again with different wording, or sort "newest" for status, before saying "I didn\'t find a matching record in these searches". Name both searches and the next place you would check (another source, a wider date window, or a distinctive name or number). Do not turn those searches into a claim that no such record exists. Say nothing is recorded only when a response explicitly establishes a complete search. Do not substitute inference.';
const GLOBAL_ABSENCE = /brain has nothing|nothing recorded|Confidence nothing is recorded|documents do not answer|No (?:match|hits) in this search/i;

const questions = [
  ["balance", "What is my current balance?"],
  ["payment", "Did the payment of $120.01 arrive on September 15, 2026?"],
  ["totals", "How much money came in and went out in September 2026?"],
  ["largest", "What were my ten largest expenses in the last 60 days?"],
  ["deposits", "What deposits came in over the last 14 days?"],
  ["merchant", "How much did I spend at Fixture Store in September 2026?"],
  ["category", "How much did I spend on software/SaaS in Q3?"],
  ["transfers", "How much did I transfer between my own accounts last month?"],
  ["recurring", "What recurring subscriptions am I paying for, and how much per month?"],
];

async function ledgerBodies(t) {
  t.mock.method(Date, "now", () => Date.parse(NOW));
  let modelCalls = 0, documentCalls = 0;
  const f = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString("hex"), SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    AI: { async run() { modelCalls++; throw new Error("money must use the ledger"); } },
  } });
  t.after(() => f.close());
  seedOwnedEntity(f, "owner", "Owner");
  for (const [slug, mask, kind] of [["account-a", "1111", "checking"], ["account-b", "2222", "savings"]]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
      VALUES (?,'owner',?,'asset',?,'live','owner_stated','confirmed',?,'Fixture Bank')`, slug, kind, mask, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-06-01','2026-10-11',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
    f.raw(`INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
      VALUES (?,'2026-10-11',98765,98000,'owner_stated','confirmed',?)`, slug, NOW);
  }
  const add = (id, date, amount, direction, description, category = null, account = "account-a") => f.raw(
    `INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,category,category_basis_state,provenance,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,?,'confirmed','owner_stated','confirmed',?)`, id, account, date, amount, direction, description, category, NOW);
  add("payment", "2026-09-15", 12001, "inflow", "Fixture payer deposit");
  add("deposit", "2026-10-01", 13001, "inflow", "Fixture payer deposit");
  add("purchase", "2026-09-15", 23001, "outflow", "Fixture Store purchase", "software");
  add("sent", "2026-09-15", 34001, "outflow", "TRANSFER TO account 2222");
  add("received", "2026-09-18", 34001, "inflow", "TRANSFER FROM account 1111", null, "account-b");
  for (const [i, day] of ["2026-08-10", "2026-09-10", "2026-10-10"].entries())
    add(`monthly-${i}`, day, 4501, "outflow", "Fixture subscription");
  const bodies = [];
  for (const empty of [false, true]) {
    if (empty) f.raw("DELETE FROM fin_transactions");
    for (const [kind, question] of questions) {
      // Missing balance snapshots fall through to documents, not a ledger zero.
      if (empty && kind === "balance") continue;
      const readPattern = kind === "balance" ? /JOIN fin_balance_snapshots/ : /JOIN fin_transactions/;
      const before = f.seen.sql.filter(sql => readPattern.test(sql)).length;
      const body = await (await withLedgerAnswer({ env: f.env, question, now: NOW,
        grantScope: { all: true }, scopePrincipalKind: "owner",
        sourceCoverage: kind === "totals" ? { unavailable: false, gaps: [{
          type: "sync_review", source: "Gmail", source_kind: "gmail",
          last_good_sync_at: "2026-10-07T12:00:00.000Z", detail: "Fixture pause.",
        }] } : null }, async () => {
        documentCalls++;
        return new Response(JSON.stringify({ answer: null, gaps: [] }));
      })).json();
      assert.equal(body.ledger?.kind, kind, `${kind}: real ledger intent`);
      assert.equal(body.evidence_gate?.supported, true, `${kind}: supported ledger answer`);
      assert.equal(body.evidence_gate?.complete, true, `${kind}: complete ledger answer`);
      assert.ok(f.seen.sql.filter(sql => readPattern.test(sql)).length > before, `${kind}: ledger read count increased`);
      if (kind === "totals") assert.equal(body.ledger.accounts.reduce((n, a) => n + a.transaction_count, 0) > 0, !empty);
      else if (kind !== "balance") assert.equal(body.ledger.found, !empty, `${kind}: populated/zero decision`);
      assert.equal(body.citations.length > 0, !empty, `${kind}: populated/zero citations`);
      bodies.push({ key: `${kind}-${empty ? "zero" : "nonzero"}`, question, body });
    }
  }
  assert.equal(modelCalls, 0, "covered ledger answers never call the model");
  assert.equal(documentCalls, 0, "every fixture reached the successful ledger branch");
  return bodies;
}

test("every successful ledger kind survives local and remote MCP", async t => {
  const bodies = await ledgerBodies(t);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ledger-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home-fixture");
  mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  // Windows protects the key with DPAPI through the system PowerShell, which
  // needs the real system environment and account name, as in the MCP search
  // contract test.
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"),
    process.platform === "win32"
      ? { environment: process.env, username: process.env.USERNAME || process.env.USER }
      : { environment: { HOME: home } });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const replies = { empty: [{ answer: null, citations: [], results: [], gaps: [] }] };
  for (const { question, body } of bodies) (replies[question] ??= []).push(body);
  writeFileSync(join(root, "responses.json"), JSON.stringify(replies));
  // The real stdio CLI and credential-file reader run. Fetch is injected before
  // loading the CLI, so no socket, endpoint or host credential is reachable.
  const loader = join(root, "fetch-fixture.mjs");
  writeFileSync(loader, `import { readFileSync, appendFileSync } from 'node:fs';
const replies = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://brain.invalid/api/rag/think') throw new Error('unexpected fixture route');
  const body = JSON.parse(init.body);
  appendFileSync(new URL('./calls.txt', import.meta.url), body.q + '\\n');
  return new Response(JSON.stringify(replies[body.q].shift()), { headers: { 'Content-Type': 'application/json' } });
};\n`);
  const env = { HOME: home, TMPDIR: root, BRAIN_URL: "https://brain.invalid", BRAIN_NAME: "fixture",
    BRAIN_MANIFEST: manifest, BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: launchctl };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "USERNAME", "USER", "LOGNAME", "PATH"])
    if (process.env[name]) env[name] = process.env[name];
  const keys = [...bodies.map(({ question }) => question), "empty"];
  const input = keys.map((q, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1,
    method: "tools/call", params: { name: "brain_think", arguments: { q } } })).join("\n") + "\n";
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(loader).href,
    fileURLToPath(new URL("../components/brain-mcp.mjs", import.meta.url))], {
    env, input, encoding: "utf8", timeout: 10000,
  });
  assert.equal(child.status, 0, "fixture CLI must complete without credential lookup or network");
  assert.deepEqual(readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n").sort(), [...keys].sort(),
    "every local question reached the injected fetch fixture");
  const messages = child.stdout.trim().split("\n").map(JSON.parse);
  const result = id => JSON.parse(messages.find(m => m.id === id).result.content[0].text);
  for (const [index, { key, question, body }] of bodies.entries()) {
    await t.test(`local ${key}`, () => {
      const out = result(index + 1);
      assert.equal(out.answer, body.answer, "answer equals the real Worker ledger body");
      assert.deepEqual(out.ledger, body.ledger, "ledger metadata is unchanged");
      assert.equal(out.note, PRESERVE, "every supported complete ledger answer gets the preserve note");
      assert.equal(out.side_note, body.side_note || undefined, "the local MCP preserves the Worker's side note field");
      assert.doesNotMatch(JSON.stringify(out), GLOBAL_ABSENCE, "no document absence or no-match instruction beside ledger answers");
    });
    await t.test(`remote ${key}`, async () => {
      let thinkCalls = 0, searchCalls = 0, fetchCalls = 0;
      const url = new URL("https://fixture.invalid/mcp");
      const response = await handleMcp({ DB: { prepare() { fetchCalls++; throw new Error("unexpected fetch"); } } },
        new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "ask", arguments: { question } } }) }), url, {
          think: async args => { thinkCalls++; assert.equal(args.q, question); return body; },
          search: async () => { searchCalls++; throw new Error("unexpected search"); },
        });
      const reply = await response.json();
      assert.equal(thinkCalls, 1, "ask reached the ledger body");
      assert.equal(searchCalls, 0);
      assert.equal(fetchCalls, 0);
      assert.ok(!reply.result.isError);
      const text = reply.result.content[0].text;
      assert.ok(text.includes(body.answer), "remote ask contains the real Worker answer verbatim");
      if (body.side_note) {
        assert.ok(text.indexOf(body.answer) < text.indexOf(body.side_note), "remote ask renders the answer before its side note");
        assert.ok(text.includes(SIDE_NOTE));
      }
      assert.doesNotMatch(text, GLOBAL_ABSENCE);
    });
  }
  await t.test("empty document answering control", () => {
    assert.equal(result(keys.length).note, NO_MATCH, "empty documents get the scoped no-match note");
  });
});
