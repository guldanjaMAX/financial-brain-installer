/**
 * Offline characterization of an upload corpus whose persisted rows have no
 * carried authority, owner confirmation, agent marker, or recorded lineage.
 * All names, facts, identifiers, and dates in this file are invented.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { createProductFixture } from "./product-contract-fixture.mjs";
import { authorityFor, tierOf } from "../src/lib/evidence-authority.js";
import { evidenceLineageFor } from "../src/lib/evidence-lineage.js";
import { restampFirstPartySourceProvenance } from "../src/lib/provenance-receipt.js";
import { coverageGapReport } from "../src/lib/store-d1.js";

const REFUSAL = "The documents do not answer the question.";
const COMPLETE_AT = "2026-08-01T00:00:00.000Z";
const headers = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

const QUESTIONS = Object.freeze({
  status: "Is the Qevra Lattice engagement currently open or closed?",
  listing: "Which entities are named in the \"Qevra Lattice Entity Index\"? Return the names only; do not classify, evaluate, or infer any status.",
  meeting: "What was decided at the Nacre Meridian review meeting on 2024-06-18?",
  fact: "According to the \"Cobalt Loom Calibration Reference,\" what color is the spindle indicator?",
  synthesis: "Using the \"Linden Prism Materials Sheet\" and the \"Linden Prism Finish Sheet,\" what material and finish are specified for the latch, and according to the \"Sable Kestrel Storage Card,\" what inspection interval is specified?",
});

const DOCUMENTS = Object.freeze([
  {
    key: "status", source_id: "qevra-status", title: "Qevra Lattice Engagement Record",
    marker: "STATUS_MARKER_QEVRA",
    content: "STATUS_MARKER_QEVRA. The Qevra Lattice engagement is closed. The parties recorded the closure on 2024-05-14.",
    occurred_at: "2024-05-14",
  },
  {
    key: "listing", source_id: "qevra-index", title: "Qevra Lattice Entity Index",
    marker: "INDEX_MARKER_QEVRA",
    content: "INDEX_MARKER_QEVRA. Prepared 2024-05-15. The index names Rindle Moss Works, Umber Quill Studio, and Cinder Lake Guild.",
    occurred_at: "2024-05-15",
  },
  {
    key: "meeting", source_id: "nacre-review", title: "Nacre Meridian Review Record",
    marker: "MEETING_MARKER_NACRE",
    content: "MEETING_MARKER_NACRE. Meeting date: 2024-06-18. Decision: use a three-rung review cadence for the Nacre Meridian review.",
    occurred_at: "2024-06-18",
  },
  {
    key: "fact", source_id: "cobalt-fact", title: "Cobalt Loom Calibration Reference",
    marker: "FACT_MARKER_COBALT",
    content: "FACT_MARKER_COBALT. Inspection recorded 2024-07-02. The spindle indicator color is amber.",
    occurred_at: "2024-07-02",
  },
  {
    key: "material", source_id: "linden-material", title: "Linden Prism Materials Sheet",
    marker: "MATERIAL_MARKER_LINDEN",
    content: "MATERIAL_MARKER_LINDEN. Recorded 2024-07-03. The latch material is basalt composite.",
    occurred_at: "2024-07-03",
  },
  {
    key: "finish", source_id: "linden-finish", title: "Linden Prism Finish Sheet",
    marker: "FINISH_MARKER_LINDEN",
    content: "FINISH_MARKER_LINDEN. Recorded 2024-07-04. The latch finish is matte violet.",
    occurred_at: "2024-07-04",
  },
  {
    key: "interval", source_id: "sable-interval", title: "Sable Kestrel Storage Card",
    marker: "INTERVAL_MARKER_SABLE",
    content: "INTERVAL_MARKER_SABLE. Recorded 2024-07-05. Inspect the storage case every 19 days.",
    occurred_at: "2024-07-05",
  },
]);

function findDocNumber(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const matches = [...text.slice(0, at).matchAll(/\[(\d+)\] \(/g)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

function scriptedAI() {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      const messages = input?.messages || [];
      const system = String(messages[0]?.content || "");
      const text = String(messages.at(-1)?.content || "");
      const question = text.match(/^Question: (.*)$/m)?.[1] || "";
      const proposed = (text.split("PROPOSED ANSWER:")[1] || "").split("CITED DOCUMENTS:")[0] || "";
      if (/verify a proposed answer/.test(system)) {
        const evidence = [...new Set([...proposed.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))];
        calls.push({ kind: "verify", question, evidence });
        return {
          response: JSON.stringify({
            supported: true,
            complete: true,
            evidence,
            reason: "scripted verifier approved every cited document",
          }),
          usage: {},
        };
      }
      let answer = REFUSAL;
      if (question === QUESTIONS.status) {
        const n = findDocNumber(text, "STATUS_MARKER_QEVRA");
        if (n) answer = `The Qevra Lattice engagement is currently closed [${n}].`;
      } else if (question === QUESTIONS.fact) {
        const n = findDocNumber(text, "FACT_MARKER_COBALT");
        if (n) answer = `The spindle indicator is amber [${n}].`;
      } else if (question === QUESTIONS.synthesis) {
        const material = findDocNumber(text, "MATERIAL_MARKER_LINDEN");
        const finish = findDocNumber(text, "FINISH_MARKER_LINDEN");
        const interval = findDocNumber(text, "INTERVAL_MARKER_SABLE");
        if (material && finish && interval) {
          answer = `The latch uses basalt composite [${material}] with a matte violet finish [${finish}]. ` +
            `The storage card specifies inspection every 19 days [${interval}].`;
        }
      }
      calls.push({ kind: "draft", question, answer });
      return { response: answer, usage: {} };
    },
  };
}

// The shared product fixture deliberately leaves its Vectorize mutation
// unacknowledged. That is useful for degradation tests, but this
// characterization requires the healthy-retrieval premise from the measured
// Brain. This in-memory binding records and acknowledges every mutation.
function settlingVectorize() {
  const stored = new Map();
  let mutation = 0;
  const receipt = () => ({ mutationId: `undated-corpus-${mutation += 1}` });
  return {
    async query() { return { matches: [] }; },
    async upsert(rows) {
      for (const row of rows) stored.set(row.id, row);
      return receipt();
    },
    async deleteByIds(ids) {
      for (const id of ids) stored.delete(id);
      return receipt();
    },
    async getByIds(ids) {
      return ids.map((id) => stored.get(id)).filter(Boolean);
    },
    async describe() {
      return {
        vectorCount: stored.size,
        processedUpToMutation: mutation ? `undated-corpus-${mutation}` : null,
      };
    },
  };
}

async function ingest(fixture, document, metadata = {}) {
  const response = await fixture.post("/api/admin/brain/ingest", {
    source_type: "upload",
    source_id: document.source_id,
    title: document.title,
    content: document.content,
    occurred_at: document.occurred_at,
    date_source: "content",
    text_source: "native",
    text_reliable: true,
    metadata: { category: "synthetic-characterization", ...metadata },
  }, headers(fixture));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.doc_uid);
  return body.doc_uid;
}

async function ask(fixture, path, q) {
  const response = await fixture.post(path, { q, limit: 20, rerank: 0 }, headers(fixture));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

const baseRow = (overrides = {}) => ({
  doc_uid: "upload:synthetic-document",
  source: "upload",
  source_id: "synthetic-document",
  source_kind: "upload",
  title: "Synthetic Artifact",
  text: "Invented characterization content.",
  text_source: "native",
  text_reliable: true,
  date_source: "content",
  date_reliable: false,
  ...overrides,
});

function ownerConfirmedRow() {
  const day = "2026-01-09";
  const id = "riven-mailing";
  const text = [
    `# Confirmed by the owner, ${day}`,
    "",
    "Subject: Riven Alder",
    "",
    "## Mailing address",
    "Operative value: 12 Invented Way",
    `As of: ${day}, confirmed by the owner`,
    "Supersedes: 4 Fiction Lane",
  ].join("\n");
  return {
    ...baseRow(),
    doc_uid: `curated:owner-confirmed/${day}/${id}`,
    source: "curated",
    source_id: `owner-confirmed/${day}/${id}`,
    source_kind: "curated",
    title: `Confirmed by the owner, ${day}`,
    category: "owner-confirmed",
    client: "Riven Alder",
    document_date: Date.parse(`${day}T12:00:00.000Z`),
    date_source: "owner_confirmation",
    date_reliable: true,
    authority_meta: JSON.stringify({
      authority: "T1", operative: true, subject: "Riven Alder", client_name: "Riven Alder",
    }),
    text,
  };
}

const TIER_CASES = [
  ["carried T0", baseRow({ authority: { tier: "T0", rank: 9, name: "absent", reason: "synthetic carried absence" } }), "T0", "synthetic carried absence", false],
  ["carried T5", baseRow({ authority: { tier: "T5", rank: 5, name: "verbal only", reason: "synthetic carried verbal" } }), "T5", "synthetic carried verbal", false],
  ["owner confirmation", ownerConfirmedRow(), "T1", "an operative value you confirmed yourself", false],
  ["relationship system", baseRow({ source_kind: "crm" }), "T1", "the crm relationship system", false],
  ["machine feed", baseRow({ source_kind: "plaid" }), "T1", "a machine feed (plaid), not somebody's account of it", false],
  ["primary plus source lineage", baseRow({ title: "Executed Agreement", authority_meta: { evidence_lineage: { version: 1, kind: "source_record", root_ids: ["upload:primary-root"] } } }), "T1", "a recorded direct source artifact (Agreement)", false],
  ["derived lineage", baseRow({ authority_meta: { evidence_lineage: { version: 1, kind: "derived_record", root_ids: ["upload:derived-root"] } } }), "T2", "prepared from 1 recorded source family; it does not independently corroborate them", false],
  ["derived name plus source lineage", baseRow({ title: "Invoice Export", authority_meta: { evidence_lineage: { version: 1, kind: "source_record", root_ids: ["upload:invoice-root"] } } }), "T2", "a recorded source artifact prepared from primary records (Invoice)", false],
  ["agent-derived", baseRow({ authority_meta: { written_by: "agent" } }), "T4", "agent-written material whose source family was not recorded; it remains useful context, not independent corroboration", false],
  ["recollection source", baseRow({ source_kind: "zoom" }), "T4", "a zoom record of what was said", false],
  ["correspondence source", baseRow({ source_kind: "gmail" }), "T3", "gmail, written at the time", false],
  ["recollection title", baseRow({ title: "Meeting Record" }), "T4", "named like a record of a conversation (Meeting)", true],
  ["primary-name fallback", baseRow({ title: "Executed Agreement" }), "T3", "its name suggests a primary record (Agreement), but its derivation provenance was not recorded", true],
  ["derived-name fallback", baseRow({ title: "Invoice Export" }), "T3", "its name suggests a derived record (Invoice), but its derivation provenance was not recorded", true],
  ["plain fallback", baseRow(), "T3", "a document, with nothing to show it is authoritative", true],
];

function observedArrivalCompatible(row) {
  const metadata = typeof row.authority_meta === "string"
    ? JSON.parse(row.authority_meta)
    : (row.authority_meta || {});
  return row.source_kind === "upload" &&
    row.authority === undefined &&
    row.category !== "owner-confirmed" &&
    metadata.evidence_lineage === undefined &&
    evidenceLineageFor(row).lineage.kind !== "agent_derived";
}

let fixture;
let ai;
const docUids = {};
const outcomes = {};
const searches = {};
const storedPair = {};

before(async () => {
  ai = scriptedAI();
  fixture = await createProductFixture({ env: { AI: ai, VECTORIZE: settlingVectorize() } });
  fixture.raw(
    `INSERT INTO sources
       (name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,document_count)
     VALUES ('upload','upload','ready',?,?,?,0)`,
    COMPLETE_AT, COMPLETE_AT, COMPLETE_AT,
  );
  for (const document of DOCUMENTS) docUids[document.key] = await ingest(fixture, document);

  const pair = {
    title: "Executed Agreement",
    content: "PAIR_MARKER_ORIEL. The invented agreement specifies a copper latch.",
    occurred_at: "2024-07-06",
  };
  docUids.pairBare = await ingest(fixture, { ...pair, source_id: "oriel-bare" });
  docUids.pairLineage = await ingest(fixture, { ...pair, source_id: "oriel-lineage" }, {
    evidence_lineage: { version: 1, kind: "source_record", root_ids: ["upload:oriel-family"] },
  });
  fixture.raw(
    `UPDATE sources
        SET document_count=(SELECT COUNT(*) FROM documents WHERE source='upload' AND deleted_at IS NULL)
      WHERE name='upload'`,
  );

  for (const row of fixture.rows(
    `SELECT d.doc_uid,d.source,d.source_id,d.title,d.uri,d.document_date,
            d.date_source,d.date_reliable,d.entity_slug,d.client,d.category,
            d.top_folder,d.platform,d.text_source,d.text_reliable,
            d.content_hash,d.meta AS authority_meta,s.kind AS source_kind,
            c.text,c.text AS snippet
       FROM documents d
       JOIN sources s ON s.name=d.source
       JOIN chunks c ON c.doc_uid=d.doc_uid AND c.chunk_ix=0
      WHERE d.doc_uid IN (?,?)
      ORDER BY d.doc_uid`,
    docUids.pairBare, docUids.pairLineage,
  )) storedPair[row.doc_uid] = row;

  const drained = await fixture.post("/api/admin/brain/drain", {}, headers(fixture));
  assert.equal(drained.status, 200, await drained.text());
  assert.equal(fixture.first("SELECT count(*) AS n FROM vector_outbox").n, 0);

  const cleanCoverage = await coverageGapReport(fixture.env);
  assert.equal(cleanCoverage.unavailable, false);
  assert.deepEqual(cleanCoverage.gaps, []);

  const pairSearch = await ask(fixture, "/api/rag/unified", "PAIR_MARKER_ORIEL copper latch");
  searches.pair = pairSearch;

  // Match the measured corpus state for A4: usable records with incomplete
  // declared source history. Coverage may mask refusals, never supported text.
  fixture.raw("UPDATE sources SET last_complete_sweep_at=NULL WHERE name='upload'");
  for (const [kind, question] of Object.entries(QUESTIONS)) {
    searches[kind] = await ask(fixture, "/api/rag/unified", question);
    outcomes[kind] = await ask(fixture, "/api/rag/think", question);
  }

  assert.notEqual(outcomes.fact.answer, null, "FIXTURE WRONG: the single-fact question refused");
  assert.notEqual(outcomes.synthesis.answer, null, "FIXTURE WRONG: the synthesis question refused");
});

after(() => fixture?.close());

test("A1: every tier route is enumerated with its verbatim reason", () => {
  const table = TIER_CASES.map(([route, row, expectedTier, expectedReason]) => {
    const actual = tierOf(row);
    assert.equal(actual.tier, expectedTier, route);
    assert.equal(actual.reason, expectedReason, route);
    return { route, tier: actual.tier, reason: actual.reason };
  });
  assert.deepEqual(new Set(table.map((entry) => entry.tier)), new Set(["T0", "T1", "T2", "T3", "T4", "T5"]));
  console.log("A1 tier routes:", JSON.stringify(table, null, 2));
});

test("A2: the observed arrival constraints reach only name-driven T4 or T3 fallbacks", () => {
  const reachable = TIER_CASES.filter((entry) => observedArrivalCompatible(entry[1])).map((entry) => entry[0]);
  assert.deepEqual(reachable, ["recollection title", "primary-name fallback", "derived-name fallback", "plain fallback"]);
  const observed = baseRow();
  const tier = tierOf(observed);
  const authority = authorityFor(observed, { query: "What does this artifact say?", current: false });
  assert.equal(tier.tier, "T3");
  assert.equal(tier.reason, "a document, with nothing to show it is authoritative");
  assert.equal(authority.authoritative, false);
  assert.equal(authority.current, false);
  assert.deepEqual(
    TIER_CASES.map(([route, row]) => [route, observedArrivalCompatible(row)]),
    TIER_CASES.map(([route, , , , compatible]) => [route, compatible]),
  );

  const stamped = restampFirstPartySourceProvenance({
    source_type: "upload", source_id: "synthetic-stamped", title: "Executed Agreement",
    content: "Invented first-party upload content.", metadata: {},
  }, { sourceType: "upload" });
  assert.deepEqual(stamped.metadata.evidence_lineage, {
    version: 1, kind: "source_record", root_ids: ["upload:synthetic-stamped"],
  });
  console.log("A2 observed-shape reachability:", JSON.stringify({
    reachable,
    exact_measured_reason_reaches: ["plain fallback"],
    unreachable: TIER_CASES.filter((entry) => !observedArrivalCompatible(entry[1])).map((entry) => entry[0]),
    current_first_party_upload_adds: stamped.metadata.evidence_lineage,
  }, null, 2));
});

test("A3: recorded source lineage is the minimum pair difference that lifts an executed agreement", () => {
  const bare = storedPair[docUids.pairBare];
  const lifted = storedPair[docUids.pairLineage];
  assert.ok(bare, "bare upload missing from storage");
  assert.ok(lifted, "lineage upload missing from storage");
  assert.equal(bare.title, lifted.title);
  assert.equal(bare.text, lifted.text);
  assert.equal(bare.content_hash, lifted.content_hash);
  const bareAuthority = authorityFor(bare, { query: "What material does the executed agreement specify?", current: false });
  const liftedAuthority = authorityFor(lifted, { query: "What material does the executed agreement specify?", current: false });
  assert.equal(bareAuthority.tier, "T3");
  assert.equal(bareAuthority.reason, "its name suggests a primary record (Agreement), but its derivation provenance was not recorded");
  assert.equal(bareAuthority.authoritative, false);
  assert.equal(liftedAuthority.tier, "T1");
  assert.equal(liftedAuthority.reason, "a recorded direct source artifact (Agreement)");
  assert.equal(liftedAuthority.authoritative, true);
  assert.equal(liftedAuthority.current, false);
  assert.equal(evidenceLineageFor(lifted).lineage.status, "known");
  assert.equal((searches.pair.results || []).filter((row) =>
    row.doc_uid === docUids.pairBare || row.doc_uid === docUids.pairLineage).length, 1,
  "public retrieval must collapse byte-identical records rather than double count them");
  console.log("A3 concrete pair:", JSON.stringify([
    { variant: "bare upload", tier: bareAuthority.tier, authoritative: bareAuthority.authoritative, reason: bareAuthority.reason },
    { variant: "plus source_record lineage", tier: liftedAuthority.tier, authoritative: liftedAuthority.authoritative, reason: liftedAuthority.reason },
  ], null, 2));
});

test("A4: five question kinds reproduce three null refusals and two cited answers", () => {
  const expected = {
    status: [true, "present-status claim had no reliable-dated evidence for the named subject", 0, "coverage_incomplete"],
    listing: [true, "answer model found no direct support", 0, "coverage_incomplete"],
    meeting: [true, "answer model found no direct support", 0, "coverage_incomplete"],
    fact: [false, "scripted verifier approved every cited document", 1, undefined],
    synthesis: [false, "scripted verifier approved every cited document", 3, undefined],
  };
  const table = [];
  for (const [kind, body] of Object.entries(outcomes)) {
    const [answerNull, reason, citations, status] = expected[kind];
    assert.equal(body.answer === null, answerNull, kind);
    assert.equal(body.evidence_gate?.reason, reason, kind);
    assert.equal(body.answer_error, undefined, kind);
    assert.equal(body.citations?.length, citations, kind);
    assert.equal(body.status, status, kind);
    table.push({
      kind, answer: body.answer, answer_null: body.answer === null, reason: body.evidence_gate?.reason,
      answer_error: body.answer_error ?? null, citations: body.citations?.length || 0,
      status: body.status ?? null,
      reason_setter: kind === "status" ? "worker/src/index.js:1219"
        : answerNull ? "worker/src/index.js:1102" : "scripted verifier fixture",
      null_setter: answerNull ? "worker/src/index.js:1321-1325,1347-1361" : null,
    });
  }
  for (const key of ["status", "listing", "meeting"]) {
    const rows = searches[key].results || [];
    const target = rows.find((row) => row.doc_uid === docUids[key]);
    assert.ok(target, `${key}: target document was not retrieved`);
    assert.equal(target.authority.tier, "T3");
    assert.equal(target.authority.rank, 3);
    assert.equal(target.authority.authoritative, false);
    assert.equal(target.authority.current, key === "status");
    assert.equal(target.authority.eligible, true);
    assert.equal(target.authority.owner_confirmed, false);
    assert.equal(target.authority.operative, false);
    assert.equal(target.authority.reason, key === "status"
      ? "a document, with nothing to show it is authoritative; it has no reliable as-of date for a current claim"
      : "a document, with nothing to show it is authoritative");
    assert.equal(target.date_reliable, false);
    assert.equal(target.date_source, "content");
    assert.equal(target.text_reliable, true);
    assert.equal(target.source_kind, "upload");
  }
  for (const key of ["fact", "synthesis"]) {
    for (const citation of outcomes[key].citations) {
      assert.equal(citation.authority.tier, "T3");
      assert.equal(citation.authority.rank, 3);
      assert.equal(citation.authority.authoritative, false);
      assert.equal(citation.authority.current, false);
      assert.equal(citation.authority.eligible, true);
      assert.equal(citation.authority.owner_confirmed, false);
      assert.equal(citation.authority.operative, false);
      assert.equal(citation.authority.reason, "a document, with nothing to show it is authoritative");
      assert.equal(citation.date_reliable, false);
      assert.equal(citation.date_source, "content");
      assert.equal(citation.text_reliable, true);
      assert.equal(citation.source_kind, "upload");
    }
  }
  console.log("A4 five-question outcomes:", JSON.stringify(table, null, 2));
});

test("A5: the descriptive questions answer with the requested citations", () => {
  assert.match(outcomes.fact.answer, /^The spindle indicator is amber \[\d+\]\.$/);
  assert.equal(outcomes.fact.citations.length, 1);
  assert.match(outcomes.synthesis.answer, /basalt composite \[\d+\].*matte violet finish \[\d+\]/s);
  assert.match(outcomes.synthesis.answer, /every 19 days \[\d+\]/);
  assert.equal(outcomes.synthesis.citations.length, 3);
});

test("A6: source coverage masks only refusals, never supported answers", async () => {
  const gap = await coverageGapReport(fixture.env);
  assert.equal(gap.unavailable, false);
  assert.deepEqual(gap.gaps.filter((entry) => entry.type === "history_unproven").map((entry) => entry.source), ["upload"]);

  const masked = await ask(fixture, "/api/rag/think", QUESTIONS.listing);
  assert.equal(masked.answer, null);
  assert.equal(String(masked.answer || "").includes(REFUSAL), false);
  assert.equal(masked.evidence_gate?.reason, "answer model found no direct support");
  assert.equal(masked.status, "coverage_incomplete");
  assert.equal(masked.citations.length, 0);

  fixture.raw("UPDATE sources SET last_complete_sweep_at=last_ingest_at WHERE name='upload'");
  const cleanCoverage = await coverageGapReport(fixture.env);
  assert.equal(cleanCoverage.unavailable, false);
  assert.deepEqual(cleanCoverage.gaps, []);
  const surfaced = await ask(fixture, "/api/rag/think", QUESTIONS.listing);
  assert.equal(surfaced.answer, REFUSAL);
  assert.equal(surfaced.evidence_gate?.reason, "answer model found no direct support");
  assert.equal(surfaced.status, undefined);
  assert.equal(surfaced.citations.length, 0);

  fixture.raw("UPDATE sources SET last_complete_sweep_at=NULL WHERE name='upload'");
  const supported = await ask(fixture, "/api/rag/think", QUESTIONS.fact);
  assert.match(supported.answer, /^The spindle indicator is amber \[\d+\]\.$/);
  assert.equal(supported.citations.length, 1);
  assert.equal(supported.evidence_gate?.supported, true);
  assert.equal(supported.status, undefined);
  assert.ok(supported.gaps.some((entry) => entry.type === "history_unproven" && entry.source === "upload"));
});
