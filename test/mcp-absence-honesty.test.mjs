// A brain that found the right documents and failed to write an answer must
// never report itself as a brain with nothing on file. Those two outcomes are
// indistinguishable to the consuming model, and only one of them is honest.
//
// Field case, 2026-08-31: `/api/rag/think` was asked a question carrying four
// clauses. Two of them ("pause", "status") had no answer in the corpus, so the
// synthesis model refused the whole question and cited nothing, while its own
// results array held the owner's signed coaching agreement at ranks 2, 3 and 4.
// The MCP layer then attached "The brain has nothing on this", because the
// refusal string is truthy and so the raw rows were never carried out. The
// consumer relayed absence to the owner about a contract sitting in the payload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAdminKeyFile } from "../operations/admin-key-file.mjs";
import { handleMcp } from "../worker/src/lib/mcp-endpoint.js";
import { createProductFixture, seedOwnedEntity } from "../worker/test/product-contract-fixture.mjs";
import { withLedgerAnswer } from "../worker/src/lib/ledger-answer.js";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const MCP = fileURLToPath(new URL("../components/brain-mcp.mjs", import.meta.url));

const ABSENCE = 'No match in this search. Say "I didn\'t find a matching record in this search", name what you searched, and name the next search you would run (another source, a wider date window, sort "newest", or a distinctive name or number). Do not turn one search into a claim that no such record exists. Do not substitute inference.';
const NO_HITS = 'No hits in this search. This is not proof that no such record exists. Say "I didn\'t find a matching record in this search" and name the next search you would run.';
const SCOPED_GAP = "No match in this search. This is not proof that no such record exists.";
const REFUSAL = "I didn't find a matching record in this search. Next, search with alternate subject terms or a distinctive name or number. Remote search is relevance-ranked and cannot filter or sort by date.";
const PRESERVE = "Preserve the ledger answer's exact amounts, account masks, dates, and coverage bounds.";
const LATEST = 'Before any status, "latest", or absence claim, run one brain_search for the subject with sort "newest", read newest_record, and say "as of <record date>" for the record you relied on.';
const MONEY = "For a money question the bank ledger answers (a balance, a payment received, money in and out, largest expenses, deposits, spend by merchant or category, transfers between the owner's own accounts, recurring charges, profit, net income, cash flow, withdrawals, loan proceeds), use brain_think: it reads the ledger directly. Keep its exact amounts, account masks, dates and coverage bounds.";
const NEWEST_DESCRIPTION = 'Before any status, "latest", or absence claim, search the subject once with sort "newest" and check newest_record, the newest reliably dated record among the results this search returned before pagination (at most 50), or the newest unverified date if none is reliable. Before a latest claim, re-search the subject with a recent date window; relevance ranking may omit newer matches.';

function fixtureRuntime(url, profile = "") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-honesty-")));
  const home = join(root, "home-fixture");
  mkdirSync(home);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }));
  writeAdminKeyFile(join(root, ".brain-admin-key"), randomBytes(24).toString("hex"),
    process.platform === "win32"
      ? { environment: process.env, username: process.env.USERNAME || process.env.USER }
      : { environment: { HOME: home } });
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const env = { HOME: home, TMPDIR: root, BRAIN_URL: url, BRAIN_NAME: "fixture-brain",
    BRAIN_MANIFEST: manifest, BRAIN_AGENT_PROFILE: profile,
    BRAIN_NO_WRANGLER_LOGIN: "1", BRAIN_TEST_LAUNCHCTL: launchctl };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "USERNAME", "USER", "LOGNAME", "PATH"])
    if (process.env[name]) env[name] = process.env[name];
  return { env, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function localMessages(runtime, messages) {
  const child = spawn(process.execPath, [MCP], {
    stdio: ["pipe", "pipe", "pipe"], env: runtime.env, timeout: 15000,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(messages.map(message => JSON.stringify(message)).join("\n") + "\n");
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, `MCP exited non-zero: ${stderr}`);
  const replies = stdout.split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(replies.length, messages.length, "every MCP request must receive a reply");
  return replies;
}

/** Serve one canned body; every assertion must first reach the requested route. */
async function thinkReturns(body, tool = "brain_think", args = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      requests.push({ path: req.url, body: JSON.parse(raw), method: req.method });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const runtime = fixtureRuntime(`http://127.0.0.1:${server.address().port}`);
  try {
    const [reply] = await localMessages(runtime, [{ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: tool, arguments: { q: "anything", ...args } } }]);
    assert.ok(requests.length > 0, "the local decision point must reach the fixture");
    for (const request of requests) {
      assert.equal(request.method, "POST");
      assert.equal(request.path, tool === "brain_think" ? "/api/rag/think" : "/api/rag/unified");
      assert.equal(request.body.q, args.q ?? "anything");
    }
    assert.ok(!reply.result?.isError, `MCP errored: ${reply.result?.content?.[0]?.text}`);
    return JSON.parse(reply.result.content[0].text);
  } finally {
    runtime.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function initializeResponse(profile) {
  const runtime = fixtureRuntime("https://fixture.invalid", profile);
  try {
    const [initialized, listed] = await localMessages(runtime, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    assert.ok(initialized.result?.instructions);
    assert.ok(listed.result?.tools.length > 0, "tool listing decision point was reached");
    return { instructions: initialized.result.instructions, tools: listed.result.tools };
  } finally { runtime.close(); }
}

function orderedIndex(text, expression, after, label) {
  const offset = Math.max(0, after + 1);
  const relative = text.slice(offset).search(expression);
  assert.ok(relative >= 0, `${label} is missing or out of order: ${expression}`);
  return offset + relative;
}

function assertMapOpeningSequence(text, label) {
  let cursor = -1;
  cursor = orderedIndex(text,
    /What would you\s+most\s+like\s+your\s+Financial Brain to help you understand or keep current\?/i,
    cursor, label);
  cursor = orderedIndex(text, /This sends no Financial Map\s+snapshot and changes nothing\./i, cursor, label);
  cursor = orderedIndex(text,
    /(?:report (?:its )?current, stale, or not-established map state|whether the active map is current, stale, or not established)/i,
    cursor, label);
  cursor = orderedIndex(text,
    /Before (?:making )?any financial\s+completeness conclusion, offer the (?:optional )?guided/i,
    cursor, label);
  cursor = orderedIndex(text,
    /(?:end\s+Optimize without submitting the working draft|End Optimize before previewing)/i,
    cursor, label);
  cursor = orderedIndex(text,
    /separate explicit owner\s+approval(?: outside Optimize)? before (?:calling|preview mode)/i,
    cursor, label);
  orderedIndex(text,
    /Activation requires another separate owner decision[\s\S]{0,260}?fresh passkey/i,
    cursor, label);
}

// Optimize ordering must live in the MCP initialize response, because that is
// what the owner-facing assistant actually reads. Keep its anchors aligned
// with both packaged contracts so one copy cannot silently fall back to an
// after-the-report interview.
await test("Optimize guidance remains map-first", async () => {
  const { instructions } = await initializeResponse("owner-assistant");
  const skill = readFileSync(new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../operations/claude-workspace.mjs", import.meta.url), "utf8");

  assertMapOpeningSequence(instructions, "MCP runtime guidance");
  assertMapOpeningSequence(skill, "technician skill");
  assertMapOpeningSequence(workspace, "Claude workspace contract");
  for (const [label, text] of [
    ["MCP runtime guidance", instructions],
    ["technician skill", skill],
    ["Claude workspace contract", workspace],
  ]) {
    assert.match(text,
      /one total owner-question budget per (?:owner-facing Optimize )?response across\s+the optional goal, evidence clarification, and zoning/i,
      label);
    assert.match(text,
      /material evidence conflict,\s+(?:then )?a\s+whole-source zoning decision, then\s+the\s+optional goal/i,
      label);
    assert.match(text,
      /Skip\s+the goal whenever a material evidence conflict or any\s+zoning decision is\s+(?:already )?pending/i,
      label);
    assert.match(text, /records do not determine\s+the choice/i, label);
    assert.match(text,
      /source label, connector kind, document count, or plausible\s+guess is\s+not enough/i,
      label);
    assert.match(text,
      /Without (?:that|supporting) evidence, (?:do not|never) propose or recommend a\s+zone/i,
      label);
    assert.match(text,
      /material evidence conflict has higher priority,\s+(?:ask only that evidence question and\s+)?defer\s+(?:the\s+)?zoning(?:\s+choice)?\s+to\s+the\s+next response/i,
      label);
    assert.match(text,
      /Do not run Golden Questions, a Golden evaluation, a canned refusal exercise, a\s+known-answer control question/i,
      label);
    assert.match(text,
      /Never claim an MCP or other Optimize check ran without its actual receipt[\s\S]{0,180}?never call Optimize complete while any planned check is not run/i,
      label);
    assert.match(text,
      /gpt-5\.6-luna.*medium reasoning[\s\S]{0,180}?gpt-5\.6-terra.*low reasoning/i,
      label);
    assert.match(text, /synthetic behavioral\s+evidence only, not live Brain proof/i, label);
    assert.match(text,
      /Do not pin [`]?gpt-5\.6-sol[`]? or infer Optimize\s+completeness from model choice/i,
      label);
    assert.match(text,
      /Each interview response asks only (?:that|its) one adaptive map question and combines it\s+with no goal, evidence-clarification, or zoning question/i,
      label);
    assert.doesNotMatch(text,
      /one total owner-question budget for the complete Optimize run/i,
      label);
  }
  assert.match(instructions, /keep the audit read-only/i);
  assert.match(instructions, /first audit evidence after that opening decision, whether the goal was asked or skipped/i);
  assert.match(instructions, /Immediately before calling brain_financial_map with mode=read/i);
  assert.match(instructions, /optional guided, session-only Owner Financial Map interview/i);
  assert.match(instructions, /Do not start the interview automatically/i);
  assert.match(instructions, /The interview submits nothing and changes nothing/i);
  assert.match(instructions,
    /preview is a separate data-changing step outside Optimize.*separate explicit owner approval/is);
  assert.match(instructions, /Activation is never an Optimize or MCP step/i);
  assert.doesNotMatch(instructions, /After the read-only Optimize report, offer a guided financial map interview/i);
  console.log("PASS MCP Optimize guidance is map-first and keeps preview and activation separate");
});

// 1. F04 deliberately replaces the global absence claim with a search-scoped
//    finding and a next search. Pin the new contract byte for byte.
await test("healthy empty think is search-scoped", async () => {
  const out = await thinkReturns({
    answer: "The documents do not answer the question.",
    citations: [],
    results: [],
    gaps: [],
  });
  assert.equal(out.note, ABSENCE, "a healthy empty search must use the scoped no-match note");
  console.log("PASS empty retrieval reports only what this search found");
});

// 2. The defect. Retrieval returned documents, the answer layer cited none.
await test("found-but-uncited keeps three rows", async () => {
  const rows = [
    { source: "upload", source_id: "signed-agreement", ref_key: "signed-agreement", uri: "https://files.example/signed-agreement", chunk_uid: "upload:signed-agreement#2", title: "Signed coaching agreement.md", ts: "2026-04-11T00:00:00.000Z", date_source: "filename", date_reliable: false, text_source: "ocr_partial", text_reliable: false, snippet: "Monthly fee: $5,000" },
    { title: "Covenant for the Work Ahead.docx", ts: "2026-04-11T00:00:00.000Z", snippet: "30 days written notice" },
    { title: "Intro email.md", ts: "2026-04-11T00:00:00.000Z", snippet: "First Stripe payment" },
  ];
  const out = await thinkReturns({
    answer: "The documents do not answer the question.",
    citations: [],
    results: rows,
    gaps: [],
  });

  assert.notEqual(out.note, ABSENCE, "a synthesis failure must not be reported as absence");
  assert.ok(!/nothing on this/i.test(out.note ?? ""), `note still reads as absence: ${out.note}`);
  assert.match(out.note ?? "", /NOT "nothing recorded"/, "the note must say plainly what this is not");
  assert.match(out.note ?? "", /3 document/, "the note must state how many documents were held back");
  // The rows themselves have to travel, or the consumer has nothing to recover
  // from and no way to check the claim.
  assert.equal(out.results?.length, 3, "raw rows must be attached when nothing was cited");
  assert.equal(out.results[0].title, "Signed coaching agreement.md");
  assert.equal(out.results[0].ref, "signed-agreement", "stable document identity must survive the refusal path");
  assert.equal(out.results[0].source_id, "signed-agreement");
  assert.equal(out.results[0].uri, "https://files.example/signed-agreement");
  assert.equal("chunk_uid" in out.results[0], false, "unstable chunk identity must stay internal");
  assert.equal(out.results[0].date_reliable, false, "date trust must survive the MCP boundary");
  assert.equal(out.results[0].text_source, "ocr_partial", "extraction provenance must survive the MCP boundary");
  assert.equal(out.results[0].text_reliable, false, "extraction trust must survive the MCP boundary");
  console.log("PASS documents found but none cited is not reported as absence");
});

// 3. A cited answer stays clean: no scolding note bolted onto a good result.
await test("cited answer stays clean", async () => {
  const out = await thinkReturns({
    answer: "The monthly fee is $5,000 [1].",
    citations: [{ n: 1, title: "Signed coaching agreement.md" }],
    results: [{ title: "Signed coaching agreement.md", ts: null, snippet: "Monthly fee: $5,000" }],
    gaps: [],
  });
  assert.equal(out.note, undefined, "a cited answer must carry no note");
  assert.equal(out.results, undefined, "a cited answer must not duplicate the corpus back");
  console.log("PASS a cited answer is returned clean");
});

// 4. Raw search keeps the same provenance fields as the cited answer path.
await test("raw search keeps provenance", async () => {
  const out = await thinkReturns({
    results: [{
      source: "upload", ref: "statement-public-ref", source_id: "statement-source-id",
      uri: "https://files.example/statement", chunk_uid: "upload:statement-source-id#4",
      title: "Scanned statement", category: "upload",
      ts: "2026-01-02T00:00:00.000Z", date_source: "filename", date_reliable: false,
      text_source: "ocr_partial", text_reliable: false,
      lineage: {
        kind: "unclassified", status: "unknown", derived: false,
        reason: "derivation family was not recorded",
      },
      snippet: "Balance shown on scan",
    }],
  }, "brain_search");
  assert.equal(out.results[0].id, "upload:statement-source-id",
    "raw search must expose the exact id the remember contract accepts");
  assert.equal(out.results[0].ref, "statement-public-ref");
  assert.equal(out.results[0].source_id, "statement-source-id");
  assert.equal(out.results[0].uri, "https://files.example/statement");
  assert.equal("chunk_uid" in out.results[0], false, "raw search must expose document identity only");
  assert.equal(out.results[0].date_source, "filename");
  assert.equal(out.results[0].date_reliable, false);
  assert.equal(out.results[0].text_source, "ocr_partial");
  assert.equal(out.results[0].text_reliable, false);
  assert.equal(out.results[0].lineage.status, "unknown");
  console.log("PASS raw search keeps date and extraction provenance");
});

// 5. A failed vector query is not the same state as a projection that is still
//    building. The closed reason token must survive the MCP boundary so the
//    consuming assistant receives the Worker's reviewed cause and remedy.
await test("vector failure keeps reviewed cause", async () => {
  const out = await thinkReturns({
    status: "search_unavailable",
    degraded: "vector",
    degraded_reason: "vector-query-failed",
    notice: "untrusted worker notice",
    answer: null,
    citations: [],
    results: [],
    gaps: [],
  });
  assert.equal(out.search_status, "search_unavailable");
  assert.equal(out.degraded, "vector");
  assert.equal(out.degraded_reason, "vector-query-failed");
  assert.match(out.note, /meaning-based search failed/i);
  assert.doesNotMatch(out.note, /index is still building/i);
  assert.match(out.gaps[0]?.detail ?? "", /meaning-based search failed/i);
  console.log("PASS MCP preserves the reviewed vector-query failure state");
});

// 6. When both attempted modalities fail, raw search carries the distinct
//    public reason rather than collapsing it into a one-sided degradation.
await test("both-modality failure keeps its cause", async () => {
  const out = await thinkReturns({
    status: "search_unavailable",
    degraded: "retrieval",
    degraded_reason: "keyword-and-vector-query-failed",
    results: [],
    gaps: [],
  }, "brain_search");
  assert.equal(out.search_status, "search_unavailable");
  assert.equal(out.degraded, "retrieval");
  assert.equal(out.degraded_reason, "keyword-and-vector-query-failed");
  assert.match(out.note, /both keyword search and meaning-based search failed/i);
  console.log("PASS MCP preserves the both-modalities-failed state");
});

// 7. Reason is a closed product field, not a path for raw provider text.
await test("unknown degraded reason stays private", async () => {
  const privateCanary = "provider-private-trace-fixture-123";
  const out = await thinkReturns({
    status: "search_unavailable",
    degraded: "vector",
    degraded_reason: privateCanary,
    answer: null,
    citations: [],
    results: [],
    gaps: [],
  });
  assert.equal("degraded_reason" in out, false, "unknown reason must be omitted");
  assert.doesNotMatch(JSON.stringify(out), new RegExp(privateCanary));
  console.log("PASS MCP does not relay arbitrary degraded reason text");
});



await test("local tool descriptions route money and require newest-record evidence", async () => {
  const { instructions, tools } = await initializeResponse("owner-assistant");
  const think = tools.find(tool => tool.name === "brain_think").description;
  const search = tools.find(tool => tool.name === "brain_search").description;
  assert.match(think, /^Money and short lookups\./);
  assert.match(think, /For anything else use brain_search/);
  for (const phrase of ["balance", "payment received", "money in and out", "largest expenses", "deposits", "merchant or category", "transfers", "recurring charges", "single-fact"])
    assert.ok(think.includes(phrase), `think routes ${phrase}`);
  assert.match(search, /^Default tool for answering questions from the Brain\./);
  assert.ok(search.includes(NEWEST_DESCRIPTION), "search explains the whole matched window");
  assert.ok(instructions.includes(LATEST), "initialize requires a newest search and an as-of date");
  assert.ok(instructions.includes(MONEY), "initialize routes ledger questions to think");
  assert.match(instructions, /To answer, search, read, then write\./);
  assert.doesNotMatch(instructions, /Call brain_think first/);
});

await test("zero-row largest keeps the real ledger answer beside an empty-document control", async t => {
  const now = "2026-10-11T12:00:00Z";
  t.mock.method(Date, "now", () => Date.parse(now));
  const f = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString("hex"), SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    AI: { async run() { throw new Error("money must use the ledger"); } },
  } });
  t.after(() => f.close());
  seedOwnedEntity(f, "owner", "Owner");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('account-a','owner','checking','asset','1111','live','owner_stated','confirmed',?)`, now);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('account-a','complete','2026-06-01','2026-10-11',?,'owner_stated','confirmed',?)`, now, now);
  const before = f.seen.sql.filter(sql => /JOIN fin_transactions/.test(sql)).length;
  const body = await (await withLedgerAnswer({ env: f.env, now,
    question: "What were my ten largest expenses in the last 60 days?",
    grantScope: { all: true }, scopePrincipalKind: "owner" },
  async () => { throw new Error("unexpected document fallback"); })).json();
  assert.equal(body.ledger?.kind, "largest");
  assert.equal(body.ledger.found, false);
  assert.equal(body.evidence_gate.supported, true);
  assert.equal(body.evidence_gate.complete, true);
  assert.ok(f.seen.sql.filter(sql => /JOIN fin_transactions/.test(sql)).length > before, "zero reached ledger SQL");
  const ledger = await thinkReturns(body);
  assert.equal(ledger.answer, body.answer);
  assert.deepEqual(ledger.ledger, body.ledger);
  assert.equal(ledger.note, PRESERVE);
  const empty = await thinkReturns({ answer: null, citations: [], results: [], gaps: [] });
  assert.equal(empty.note, ABSENCE, "document control differs from the covered ledger zero");
});

await test("no_results detail is scoped while other gaps retain their exact bytes", async () => {
  const coverage = { type: "coverage_unavailable", detail: "Fixture coverage could not be checked.", source: "fixture", count: 2 };
  const original = { type: "no_results", detail: "The brain has nothing on this query. Say so plainly rather than inferring.", marker: "keep" };
  const out = await thinkReturns({ answer: null, citations: [], results: [], gaps: [original, coverage] });
  assert.deepEqual(out.gaps[0], { ...original, detail: SCOPED_GAP }, "only no_results detail changes");
  assert.equal(JSON.stringify(out.gaps[1]), JSON.stringify(coverage), "coverage gap bytes pass through");
  assert.equal(out.note, ABSENCE);
  const cited = await thinkReturns({ answer: "Fixture record [1].", citations: [{ n: 1, title: "Fixture record" }],
    results: [{ title: "Fixture record" }], gaps: [coverage] });
  assert.equal(cited.note, undefined);
  assert.equal(JSON.stringify(cited.gaps), JSON.stringify([coverage]), "answered control retains the other gap");
});

const datedRow = (id, ts, date_reliable) => ({ source: "fixture", source_id: id, ref_key: id,
  title: `Fixture ${id}`, ts, date_reliable, snippet: "Fixture record" });
const reliable = datedRow("reliable", "2026-09-15T00:00:00Z", true);
const unreliable = datedRow("unreliable", "2026-10-01T00:00:00Z", false);
const localRecord = row => ({ id: `fixture:${row.source_id}`, ts: row.ts, date_reliable: row.date_reliable === true });
const remoteRecord = row => ({ id: `fixture:${row.ref_key}`, date: row.ts, date_reliable: row.date_reliable === true });

await test("local newest record prefers reliability and counts newer unverified dates", async () => {
  const results = [unreliable, reliable, datedRow("unknown", "2026-09-20", undefined), datedRow("invalid", "not-a-date", true)];
  const out = await thinkReturns({ results }, "brain_search");
  assert.deepEqual(out.newest_record, localRecord(reliable));
  assert.equal(out.newer_unreliably_dated, 2);
  assert.equal(out.results.length, 4, "selection does not discard unverified records");
  const filtered = await thinkReturns({ results }, "brain_search", { reliable_dates_only: true });
  assert.deepEqual(filtered.newest_record, out.newest_record);
  assert.equal(filtered.newer_unreliably_dated, 0, "date filtering precedes newest-record selection");
  assert.equal(filtered.results.length, 2);
});

await test("local newest date handles unreliable-only, undated and stable ties", async () => {
  const unknown = datedRow("unknown", "2026-10-02", undefined);
  const onlyUnreliable = await thinkReturns({ results: [unreliable, unknown] }, "brain_search");
  assert.deepEqual(onlyUnreliable.newest_record, localRecord(unknown));
  assert.equal(onlyUnreliable.newer_unreliably_dated, 0);
  const undated = await thinkReturns({ results: [datedRow("undated", null, true), datedRow("invalid", "not-a-date", false)] }, "brain_search");
  assert.equal(undated.newest_record, null);
  assert.equal(undated.newer_unreliably_dated, 0);
  assert.equal(undated.results.length, 2, "undated is distinct from no matches");
  const twin = { ...reliable, source_id: "twin", ref_key: "twin", doc_uid: "fixture:canonical" };
  const tied = await thinkReturns({ results: [twin, reliable] }, "brain_search", { sort: "newest" });
  assert.deepEqual(tied.newest_record, { ...localRecord(twin), id: "fixture:canonical" });
  assert.equal(tied.results[0].id, tied.newest_record.id, "id scheme and Worker-order tie break agree");
});

await test("local newest record describes the window even past the last page", async () => {
  const newest = datedRow("newest", "2026-10-03", true);
  const body = { results: [reliable, newest, unreliable] };
  const first = await thinkReturns(body, "brain_search", { limit: 1 });
  assert.deepEqual(first.newest_record, localRecord(newest));
  assert.equal(first.results[0].id, "fixture:reliable", "control page differs from newest matched row");
  const pastEnd = await thinkReturns(body, "brain_search", { offset: 4, limit: 1 });
  assert.deepEqual(pastEnd.newest_record, first.newest_record, "offset must not change newest_record");
  assert.equal(pastEnd.newer_unreliably_dated, first.newer_unreliably_dated);
  assert.equal(pastEnd.results.length, 0);
  assert.match(pastEnd.note, /offset 4 is past/);
  const sorted = await thinkReturns(body, "brain_search", { sort: "newest", limit: 1 });
  assert.deepEqual(sorted.newest_record, first.newest_record);
  assert.equal(sorted.results[0].id, sorted.newest_record.id);
  assert.equal(sorted.results[0].ts, sorted.newest_record.ts);
});

await test("local empty search is scoped and unavailable search keeps its notice", async () => {
  const empty = await thinkReturns({ results: [] }, "brain_search");
  assert.equal(empty.note, NO_HITS);
  assert.equal(empty.newest_record, null);
  const found = await thinkReturns({ results: [reliable] }, "brain_search");
  assert.deepEqual(found.newest_record, localRecord(reliable));
  assert.equal(found.note, undefined);
  const unavailable = await thinkReturns({ status: "search_unavailable", degraded: "vector", degraded_reason: "vector-query-failed", results: [] }, "brain_search");
  assert.equal(unavailable.search_status, "search_unavailable");
  assert.match(unavailable.note, /could not be completed/);
  assert.notEqual(unavailable.note, NO_HITS);
});

async function remoteCall(body, tool, args = {}) {
  const calls = [];
  let fetchCalls = 0;
  const url = new URL("https://fixture.invalid/mcp");
  const reply = await (await handleMcp({ DB: { prepare() { fetchCalls++; throw new Error("unexpected fetch"); } } },
    new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: tool, arguments: tool === "ask" ? { question: "fixture question", ...args } : { query: "fixture query", ...args } } }) }), url, {
      think: async request => { calls.push(["think", request]); return body; },
      search: async request => { calls.push(["search", request]); return body; },
    })).json();
  assert.deepEqual(calls, [[tool === "ask" ? "think" : "search", { q: tool === "ask" ? "fixture question" : "fixture query", limit: tool === "ask" ? 12 : 10 }]],
    "remote tool reached exactly its injected decision point");
  assert.equal(fetchCalls, 0);
  assert.ok(!reply.result.isError);
  return tool === "search" ? JSON.parse(reply.result.content[0].text) : reply.result.content[0].text;
}

await test("remote empty search is scoped with a populated answering control", async () => {
  const empty = await remoteCall({ results: [] }, "search");
  assert.deepEqual(empty.results, []);
  assert.equal(empty.note, NO_HITS);
  assert.equal(empty.newest_record, null);
  assert.equal(empty.newer_unreliably_dated, 0);
  const found = await remoteCall({ results: [unreliable, reliable] }, "search");
  assert.deepEqual(found.newest_record, remoteRecord(reliable));
  assert.equal(found.newer_unreliably_dated, 1);
  assert.equal(found.results.length, 2);
  assert.equal(found.note, undefined);
});

await test("remote newest record shares reliability, fallback and tie rules", async () => {
  const unknown = datedRow("unknown", "2026-10-02", undefined);
  const twin = { ...reliable, source_id: "ignored", ref_key: "twin" };
  for (const [results, expected, count] of [
    [[unreliable, reliable, unknown], remoteRecord(reliable), 2],
    [[unreliable, unknown], remoteRecord(unknown), 0],
    [[datedRow("invalid", "invalid", true), datedRow("undated", null, false)], null, 0],
    [[twin, reliable], remoteRecord(twin), 0],
  ]) {
    const out = await remoteCall({ results }, "search");
    assert.deepEqual(out.newest_record, expected);
    assert.equal(out.newer_unreliably_dated, count);
    assert.equal(out.results.length, results.length);
  }
});

await test("remote incomplete coverage retains newest metadata and unavailable stays unchanged", async () => {
  const gaps = [{ type: "history_unproven", source: "fixture", detail: "Fixture history is incomplete." }];
  const partial = await remoteCall({ status: "coverage_incomplete", results: [unreliable, reliable], gaps }, "search");
  assert.deepEqual(partial.newest_record, remoteRecord(reliable));
  assert.equal(partial.newer_unreliably_dated, 1);
  assert.equal(partial.results.length, 2);
  assert.deepEqual(partial.gaps, gaps);
  assert.match(partial.note, /provisional/i);
  const unavailable = await remoteCall({ status: "search_unavailable", results: [], gaps: [] }, "search");
  assert.deepEqual(Object.keys(unavailable).sort(), ["gaps", "note", "results"]);
  assert.match(unavailable.note, /could not be completed/i);
  assert.deepEqual(unavailable.results, []);
});

await test("remote refused ask scopes its line and confidence beside an unchanged cited control", async () => {
  const confidence = { percent: 80, band: "high", basis: ["fixture evidence"] };
  const refused = await remoteCall({ answer: "The documents do not answer the question.", confidence, results: [], citations: [], gaps: [] }, "ask");
  assert.equal(refused, `${REFUSAL}\n\nConfidence in this search result: 80% (high). fixture evidence.`);
  assert.doesNotMatch(refused, /Confidence nothing is recorded|The documents do not answer/);
  const cited = await remoteCall({ answer: "Fixture answer [1].", confidence,
    citations: [{ n: 1, title: "Fixture record", source: "fixture", lineage: { status: "known" } }], results: [], gaps: [] }, "ask");
  assert.equal(cited, "Fixture answer [1].\n\nConfidence: 80% (high). fixture evidence.\n\nSources:\n[1] Fixture record · fixture");
  const unavailable = await remoteCall({ status: "search_unavailable", answer: "The documents do not answer the question.", confidence, results: [], citations: [], gaps: [] }, "ask");
  assert.match(unavailable, /could not be completed/i);
  assert.doesNotMatch(unavailable, /\d+%|Confidence nothing is recorded|I didn't find a matching record/);
});

await test("remote descriptions and initialize route money and newest-record reading", async () => {
  const url = new URL("https://fixture.invalid/mcp");
  let backendCalls = 0;
  const deps = { think() { backendCalls++; throw new Error("unexpected think"); }, search() { backendCalls++; throw new Error("unexpected search"); } };
  const rpc = async method => (await (await handleMcp({}, new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) }), url, deps)).json()).result;
  const { tools } = await rpc("tools/list");
  assert.equal(tools.length, 3, "read-only tool listing was reached");
  const ask = tools.find(tool => tool.name === "ask").description;
  const search = tools.find(tool => tool.name === "search").description;
  assert.match(ask, /^Money and short lookups\./);
  assert.match(ask, /For anything else, use search, then fetch\./);
  assert.match(search, /^Default tool for questions about the owner's records\./);
  assert.match(search, /newest_record/);
  assert.match(search, /among the results this search returned/);
  assert.match(search, /does not support date bounds or sorting/);
  assert.match(search, /Before any status, "latest", or absence claim, fetch the newest matching record returned here and state its date and these search limits\./);
  assert.ok(search.endsWith("Relay any provisional coverage note and do not turn an incomplete empty result into a corpus-wide absence claim."));
  const { instructions } = await rpc("initialize");
  assert.match(instructions, /ask is for money and short lookups/);
  assert.match(instructions, /relevance-ranked search and reading the returned records come before any status or absence claim/);
  assert.match(instructions, /a search with no match is not proof that no record exists/i);
  assert.equal(backendCalls, 0, "metadata never reads records");
});

await test("R4 remote refused ask reports candidates with titles and dates", async () => {
  const out = await remoteCall({ answer: "The documents do not answer the question.", results: [reliable, unreliable, datedRow("third", null, false)], citations: [], gaps: [] }, "ask");
  assert.match(out, /I found 3 records but none answered this directly/);
  assert.match(out, /Fixture reliable.*2026-09-15/);
  assert.match(out, /Fixture unreliable.*2026-10-01.*unverified/i);
  assert.doesNotMatch(out, /didn't find a matching record/);
  assert.match(await remoteCall({ answer: "The documents do not answer the question.", results: [], citations: [], gaps: [] }, "ask"), /didn't find a matching record/);
});

await test("R4 remote refusal preserves ledger and source coverage limits", async () => {
  for (const type of ["ledger_out_of_coverage", "ledger_not_consulted", "coverage_stale"]) {
    const detail = "Fixture bank feed covered through 2026-10-10.";
    const out = await remoteCall({ answer: "The documents do not answer the question.", results: [reliable], citations: [], gaps: [{ type, detail }] }, "ask");
    assert.ok(out.includes(detail));
    assert.match(out, /I found 1 record/);
    if (type === "ledger_out_of_coverage") assert.match(out, /last finished month/);
    const empty = await remoteCall({ answer: null, results: [], citations: [], gaps: [{ type, detail }] }, "ask");
    assert.ok(empty.includes(detail), "empty synthesis still carries the real reason");
  }
  assert.equal(await remoteCall({ answer: "Fixture supported answer.", results: [], citations: [], gaps: [] }, "ask"), "Fixture supported answer.");
});

for (const status of ["coverage_incomplete", "search_unavailable"]) for (const type of ["ledger_out_of_coverage", "ledger_not_consulted"]) await test(`F5 ${status} retains authorized ${type} without candidate records`, async () => {
  const detail = "Fixture bank feed covered through 2032-04-30.";
  const notice = "Fixture document search could not be completed.";
  const payload = { answer: null, status, notice, results: [reliable],
    citations: [{ n: 1, title: "Candidate citation must stay hidden" }], gaps: [{ type, detail }] };
  const out = await remoteCall(payload, "ask");
  assert.ok(out.includes(notice), "the unavailable document branch was reached");
  assert.ok(out.includes(detail));
  assert.match(out, /last finished month/);
  assert.doesNotMatch(out, /Fixture reliable|Candidate citation|Sources:|I found 1 record/);
  const control = await remoteCall({ ...payload, status: undefined, notice: undefined, results: [], citations: [] }, "ask");
  assert.ok(control.includes(detail));
});

await test("R5 remote search guidance matches its query-only schema", async () => {
  const url = new URL("https://fixture.invalid/mcp"), calls = [];
  const rpc = async (method, params = {}) => (await (await handleMcp({}, new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), url, {
    search: async body => { calls.push(body); return { results: body.q === "current status" ? [reliable] : [reliable, unreliable] }; },
  })).json()).result;
  const spec = (await rpc("tools/list")).tools.find(tool => tool.name === "search");
  assert.deepEqual(Object.keys(spec.inputSchema.properties), ["query"]);
  const plain = await rpc("tools/call", { name: "search", arguments: { query: "status" } });
  const narrowed = await rpc("tools/call", { name: "search", arguments: { query: "current status" } });
  assert.deepEqual(calls, [{ q: "status", limit: 10 }, { q: "current status", limit: 10 }]);
  assert.equal(JSON.parse(plain.content[0].text).results.length, 2);
  assert.equal(JSON.parse(narrowed.content[0].text).results.length, 1, "changed-query control changes retrieval");
  assert.doesNotMatch(spec.description, /re-search the subject with a recent date window/);
  assert.match(spec.description, /does not support date bounds or sorting/);
  const { instructions } = await rpc("initialize");
  assert.doesNotMatch(instructions, /search, newest first/);
  assert.match(instructions, /relevance-ranked/);
});
