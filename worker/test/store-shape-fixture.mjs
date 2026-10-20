/**
 * Synthetic multi-entity store fixture for the Tier 1 Worker contract rows.
 *
 * Every row pins what the sealed Worker does today on one generic question
 * shape, with documents and chunks seeded straight into SQLite (the pattern in
 * business-scope-contract.test.mjs) and a model that is scripted per row. The
 * model is never asked to be clever: each row tells it exactly what draft to
 * write and what verdict to return, so the assertions measure the Worker's own
 * routing, retrieval, citation, veto, scope and money decisions around it.
 *
 * Vocabulary is role words only (Store North, Licensee Alpha, Lender One,
 * Payer One, Supplier One). Counts are deliberately small and arbitrary. No
 * reference wording, private term, credential, account or network is used.
 *
 * Known gaps run as node:test todo rows with a reason. Set
 * STORE_SHAPES_STRICT=1 to run them as ordinary tests, which is how a gap is
 * shown failing on the sealed code and how a fix is shown closing it.
 */
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";

export const STRICT = process.env.STORE_SHAPES_STRICT === "1";

/** Options for a known-gap row: todo with its reason, or a hard test in strict mode. */
export function knownGap(reason) {
  assert.ok(reason && reason.length > 20, "every known gap carries a reason");
  return STRICT ? {} : { todo: reason };
}

// Rows from the plan's section 5 that need a live model (or a live window) to
// mean anything. They are listed so the Tier 2 harness has an exact handoff;
// nothing here pretends to cover them.
export const TIER_2_ROWS = Object.freeze([
  ["R01", "depends on a live notice window computed against the real calendar; a frozen clock would only test the fixture"],
  ["R12", "the trap is whether a live model treats operating identities as legal ownership; a scripted draft cannot fall for it"],
  ["R16", "terms made up for an agreement that was never made are a live-model behaviour; the Worker side is the generic refusal invariant"],
  ["R17", "a missing governing clause answered from a template is a live-model behaviour"],
  ["R18", "an unwritten repayment arrangement inferred from payment cadence is a live-model behaviour"],
  ["R19", "a neighbouring location's lease substituted for an absent one is a live-model behaviour"],
  ["R20", "a deal that never closed, described as closed, is caught by the model's support check rather than only the deterministic draft veto"],
]);

export const TIER_1_ROWS = Object.freeze([
  "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R13", "R14", "R15",
]);

export const ROLE = Object.freeze({
  north: "store-north",
  south: "store-south",
  household: "household-side",
});

const DAY = 86_400_000;
const epoch = (day) => Date.parse(`${day}T00:00:00Z`);
const CANNED_REFUSAL = "The documents do not answer the question.";
const GATE = /^You verify a proposed answer/;
const SYNTHESIS_GATE = /^You verify each synthesis item/;

function questionFrom(messages) {
  const user = String(messages.at(-1)?.content || "");
  const plain = user.match(/^Question: (.*)$/m);
  if (plain) return plain[1].trim();
  try { return String(JSON.parse(user).question || "").trim(); } catch { return ""; }
}

// The Worker numbers retrieved documents itself. A scripted draft cites by
// title, and this map turns a title into the number the Worker assigned.
function numbersByTitle(messages) {
  const user = String(messages.at(-1)?.content || "");
  const numbers = new Map();
  for (const match of user.matchAll(/^\[(\d+)\] \(.*\) (.+)$/gm)) numbers.set(match[2].trim(), Number(match[1]));
  try {
    for (const item of JSON.parse(user).items || []) {
      for (const doc of item.documents || []) numbers.set(doc.title, doc.n);
    }
  } catch { /* not a synthesis prompt */ }
  return numbers;
}

/**
 * A model scripted per row. `script` maps the exact question to
 * { answer, verdict, synthesis }, or to a function of
 * { kind, cite(title) } returning that object. A call for any other question
 * is recorded and throws, so an unexpected model turn can never pass silently.
 */
export function scriptedModel(script) {
  const calls = [];
  const unscripted = [];
  return {
    calls,
    unscripted,
    async run(model, input) {
      if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      const messages = input?.messages || [];
      const system = String(messages[0]?.content || "");
      const question = questionFrom(messages.slice(1));
      const kind = GATE.test(system) ? "gate" : SYNTHESIS_GATE.test(system) ? "synthesis" : "answer";
      const numbers = numbersByTitle(messages.slice(1));
      const cite = (title) => {
        assert.ok(numbers.has(title), `the Worker supplied "${title}" to the ${kind} turn`);
        return numbers.get(title);
      };
      const entry = script[question];
      const row = typeof entry === "function" ? entry({ kind, cite, numbers }) : entry;
      calls.push({ question, kind });
      if (!row) {
        unscripted.push({ question, kind });
        throw new Error("unscripted fixture model call");
      }
      if (kind === "gate") return { response: JSON.stringify(row.verdict ?? { supported: false, complete: false, evidence: [], reason: "fixture verdict" }) };
      if (kind === "synthesis") return { response: JSON.stringify(row.synthesis ?? { items: [] }) };
      return { response: row.answer ?? CANNED_REFUSAL };
    },
  };
}

/** A fresh in-memory Brain with one registered, fully swept document source. */
export async function createStoreFixture({ script = {}, now = Date.now() } = {}) {
  const model = scriptedModel(script);
  const f = await createProductFixture({ env: { AI: model } });
  f.model = model;
  const stamp = new Date(now).toISOString();
  f.raw(
    `INSERT INTO sources
       (name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,document_count,expected_refresh_seconds)
     VALUES ('store-files','drive','ready',?,?,?,0,86400)`,
    stamp, stamp, stamp,
  );
  f.think = async (q, extra = {}, headers = null) => {
    const response = await f.post("/api/rag/think", { q, ...extra }, headers || await f.ownerHeaders());
    const body = await response.json();
    return { status: response.status, body };
  };
  return f;
}

export function seedEntity(f, slug, label, { kind = "business", relationship = "owned" } = {}) {
  f.raw(
    `INSERT INTO fin_entities
       (tenant_id, entity_slug, legal_name, display_label, kind, status, relationship,
        provenance, basis_state, recorded_at)
     VALUES ('primary', ?, ?, ?, ?, 'active', ?, 'owner_stated', 'confirmed', '2034-01-02T00:00:00Z')`,
    slug, `${label} LLC`, label, kind, relationship,
  );
}

/**
 * One readable document and its single chunk. `day` is the record's own
 * reliable date; `entity` is the authoritative business mapping.
 */
export function seedDocument(f, { id, title, text, day = "2034-03-02", entity = null, source = "store-files", reliable = true }) {
  const docUid = `${source}:${id}`;
  f.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,
        date_reliable,text_source,text_reliable,entity_slug)
     VALUES (?,?,?,?,?,?,'{}',?,?,?,'native',1,?)`,
    docUid, source, id, title, Date.now(), id.padEnd(64, "0").slice(0, 64), day ? epoch(day) : null,
    day ? "fixture:record_date" : null, reliable && day ? 1 : 0, entity,
  );
  f.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
     VALUES (?,?,0,?,?,?,?)`,
    `${docUid}#0`, docUid, text, source, title, day ? epoch(day) : null,
  );
  if (entity) {
    f.raw(
      `INSERT INTO fin_documents
         (tenant_id,fin_doc_uid,entity_slug,doc_kind,title,custody_class,availability,
          filed_at,corpus_doc_uid,readable,restricted,provenance,basis_state,recorded_at)
       VALUES ('primary',?,?,'other',?,'reference','have_it','2034-01-02',?,1,0,
               'owner_stated','confirmed','2034-01-02')`,
      `fin:${docUid}`, entity, title, docUid,
    );
  }
  f.raw("UPDATE sources SET document_count = document_count + 1 WHERE name = ?", source);
  return docUid;
}

export const resultIds = (body) => (body.results || []).map((row) => row.doc_uid);
export const citedIds = (body) => (body.citations || []).map((row) => row.ref);

/** The Worker's honest no-answer shape: no prose answer and nothing cited. */
export function assertNoConfidentAnswer(body, message = "no confident answer") {
  const refusal = body.answer === null || body.answer === CANNED_REFUSAL;
  assert.ok(refusal, `${message}: answer was ${JSON.stringify(body.answer)}`);
  assert.deepEqual(body.citations || [], [], `${message}: nothing may be cited`);
  assert.notEqual(body.evidence_gate?.supported, true, `${message}: the gate cannot approve it`);
}

// ---------------------------------------------------------------------------
// Ledger side. Manual, owner-confirmed accounts with an explicit covered
// window, so every answer is read from the same rows the assertions name.

export const LEDGER_NOW = "2034-12-20T12:00:00Z";

export function seedLedgerAccount(f, slug, mask, { entity = ROLE.north, kind = "checking", from = "2034-01-01", to = "2034-12-20" } = {}) {
  f.raw(
    `INSERT INTO fin_accounts
       (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,institution,provenance,basis_state,recorded_at)
     VALUES (?,?,?,?,?,'manual','Synthetic Bank','owner_stated','confirmed',?)`,
    slug, entity, kind, kind === "card" ? "liability" : "asset", mask, LEDGER_NOW,
  );
  f.raw(
    `INSERT INTO fin_account_coverage
       (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at,basis_note)
     VALUES (?,'complete',?,?,?,'owner_stated','confirmed',?,'Synthetic reviewed interval')`,
    slug, from, to, LEDGER_NOW, LEDGER_NOW,
  );
  f.raw(
    `INSERT INTO fin_balance_snapshots (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
     VALUES (?,?,100000,'owner_stated','confirmed',?)`,
    slug, to, LEDGER_NOW,
  );
}

let txnSerial = 0;
export function seedTxn(f, account, { day, cents, direction = "outflow", description, payee = null }) {
  txnSerial += 1;
  f.raw(
    `INSERT INTO fin_transactions
       (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
     VALUES (?,?,?,?,?,?,?,'owner_stated','confirmed',?)`,
    `shape-${txnSerial}`, account, day, cents, direction, description, payee, LEDGER_NOW,
  );
}

/**
 * Ask the Worker's ledger integration point directly, with a fixed clock and
 * whole-owner authority. `fallbacks` counts questions handed to documents.
 */
export function ledgerAsker(f, { now = LEDGER_NOW } = {}) {
  const asked = { fallbacks: 0, gaps: [] };
  const ask = async (question, options = {}) => {
    const before = f.first("SELECT total_changes() AS n").n;
    const response = await withLedgerAnswer({
      env: f.env, question, now: Date.parse(now), grantScope: { all: true }, scopePrincipalKind: "owner", ...options,
    }, async (gap) => {
      asked.fallbacks += 1; asked.gaps.push(gap);
      return Response.json({ route: "documents", answer: null, citations: [], gaps: gap ? [gap] : [] });
    });
    assert.equal(f.first("SELECT total_changes() AS n").n, before, "a question never writes");
    return response.json();
  };
  return { ask, asked };
}

export const monthDays = (year, months, day = 12) =>
  months.map((month) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);

export { DAY, epoch };
