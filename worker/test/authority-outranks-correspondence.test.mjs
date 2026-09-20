/**
 * D1 reproduction attempt: does a present-status question get answered from
 * the governing INSTRUMENT (a formation/dissolution filing, a signed order,
 * an executed agreement), or does /api/rag/think refuse because the newest
 * reliable-dated evidence is CORRESPONDENCE that talks about the instrument
 * without itself restating its operative status?
 *
 * This uses the real offline fixture (real node:sqlite, real migrations, real
 * FTS5 chunks_fts, real handleThink evidence gate). Only env.AI is scripted,
 * and only to make the drafting model's behaviour deterministic and
 * inspectable: the draft ALWAYS cites the instrument (when it was shown to
 * the model) plus whichever document the gate's own current-evidence logic
 * treats as newest for the named entity. The verifier stub allows every
 * citation the draft made, so any refusal below is provably the deterministic
 * temporal gate in worker/src/index.js, not the scripted model being
 * uncooperative.
 *
 * Every subject, name, and document below is invented for this fixture.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";

const headers = (fixture) => ({ "X-Admin-Key": fixture.env.ADMIN_KEY });

async function unified(fixture, q) {
  const response = await fixture.post("/api/rag/unified", { q }, headers(fixture));
  assert.equal(response.status, 200);
  return response.json();
}

async function think(fixture, q) {
  const response = await fixture.post("/api/rag/think", { q }, headers(fixture));
  assert.equal(response.status, 200);
  return response.json();
}

async function ingest(fixture, doc) {
  const envelope = {
    source_type: doc.source_type,
    source_id: doc.source_id,
    title: doc.title,
    content: doc.content,
    text_source: "native",
    text_reliable: true,
    metadata: {
      category: doc.category || "correspondence",
      ...(doc.lineageRoot
        ? { evidence_lineage: { version: 1, kind: "source_record", root_ids: [doc.lineageRoot] } }
        : {}),
    },
  };
  if (doc.occurred_at !== undefined) envelope.occurred_at = doc.occurred_at;
  if (doc.date_source !== undefined) envelope.date_source = doc.date_source;
  if (doc.date_reliable !== undefined) envelope.date_reliable = doc.date_reliable;
  const response = await fixture.post("/api/admin/brain/ingest", envelope, headers(fixture));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.doc_uid, `ingest of ${doc.source_type}:${doc.source_id} returned no doc_uid`);
  return body.doc_uid;
}

// ---------------------------------------------------------------------------
// Three invented subjects: an LLC formation/dissolution question, a signed
// court order, and an executed agreement. Each has one INSTRUMENT (source
// "drive") and four CORRESPONDENCE documents (source "gmail", all dated
// after the instrument): one that attaches it by filename only, one that
// quotes its operative clause inline, one that forwards it, and one that
// repeats the question's own vocabulary (open/closed/current/governing)
// while saying nothing about the entity's actual status.
// ---------------------------------------------------------------------------

const SUBJECTS = [
  {
    key: "meridian",
    question: "Is our engagement with Meridian Grove Holdings LLC currently active or closed?",
    instrumentMarker: "MERIDIANINSTRUMENTMARKERA",
    vocabMarker: "MERIDIANVOCABMARKERA",
    instrument: {
      source_type: "drive",
      source_id: "instrument/meridian-dissolution",
      category: "legal",
      title: "Certificate of Dissolution and Articles of Organization, Meridian Grove Holdings LLC [MERIDIANINSTRUMENTMARKERA]",
      content:
        "MERIDIANINSTRUMENTMARKERA. This certificate confirms that Meridian Grove Holdings LLC's " +
        "operating engagement is closed as of the filing date below, following the members' " +
        "unanimous vote to dissolve the company. The manager's engagement with Meridian Grove " +
        "Holdings LLC terminated upon this filing. Filed with the Secretary of State on 2024-01-15.",
      occurred_at: "2024-01-15",
      date_source: "drive:file_modified",
      date_reliable: true,
      lineageRoot: "drive:instrument/meridian-dissolution",
    },
    correspondence: [
      {
        source_type: "gmail",
        source_id: "corr/meridian-attach",
        title: "Fwd: Paperwork for your files",
        occurred_at: "2024-02-01",
        content:
          "Attachments: certificate-of-dissolution-meridian.pdf\n\nHi team, attaching the " +
          "paperwork for Meridian Grove Holdings LLC for your records. Let me know if you need " +
          "anything else.",
      },
      {
        source_type: "gmail",
        source_id: "corr/meridian-quote",
        title: "Re: Meridian Grove question",
        occurred_at: "2024-02-10",
        content:
          "Following up on your question. As the filing states, \"Meridian Grove Holdings LLC's " +
          "operating engagement is closed as of the filing date.\" That should answer it.",
      },
      {
        source_type: "gmail",
        source_id: "corr/meridian-forward",
        title: "Fwd: Meridian filing confirmation",
        occurred_at: "2024-02-20",
        content:
          "Please see the forwarded message below.\n\n---------- Forwarded message ---------\n" +
          "From: State Filing Office\nSubject: Filing confirmed\n\nYour filing regarding " +
          "Meridian Grove Holdings LLC has been recorded.",
      },
      {
        source_type: "gmail",
        source_id: "corr/meridian-vocab",
        title: "Re: Office hours reminder [MERIDIANVOCABMARKERA]",
        occurred_at: "2024-03-05",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "MERIDIANVOCABMARKERA. Just a note that our office is currently closed for the " +
          "holiday and will reopen Monday. Please check the governing calendar for open hours " +
          "next week. This message also references Meridian Grove Holdings LLC's updated " +
          "mailing address for correspondence.",
      },
    ],
  },
  {
    key: "castel",
    question: "Is the Castel Mediation Engagement currently active or closed?",
    instrumentMarker: "CASTELINSTRUMENTMARKERB",
    vocabMarker: "CASTELVOCABMARKERB",
    instrument: {
      source_type: "drive",
      source_id: "instrument/castel-order",
      category: "legal",
      title: "Final Judgment and Settlement Order, Castel Mediation Engagement [CASTELINSTRUMENTMARKERB]",
      content:
        "CASTELINSTRUMENTMARKERB. This judgment confirms that the Castel Mediation Engagement " +
        "is closed. All obligations under the mediation are terminated as of the order date " +
        "below. Entered 2024-03-03.",
      occurred_at: "2024-03-03",
      date_source: "drive:file_modified",
      date_reliable: true,
      lineageRoot: "drive:instrument/castel-order",
    },
    correspondence: [
      {
        source_type: "gmail",
        source_id: "corr/castel-attach",
        title: "Fwd: Signed copy",
        occurred_at: "2024-03-10",
        content:
          "Attachments: castel-settlement-order-signed.pdf\n\nHere is the signed copy for your " +
          "files regarding the Castel Mediation Engagement.",
      },
      {
        source_type: "gmail",
        source_id: "corr/castel-quote",
        title: "Re: Castel order question",
        occurred_at: "2024-03-15",
        content:
          "To answer your question directly: \"the Castel Mediation Engagement is closed.\" " +
          "That is straight from the order.",
      },
      {
        source_type: "gmail",
        source_id: "corr/castel-forward",
        title: "Fwd: Order entered",
        occurred_at: "2024-03-20",
        content:
          "Forwarding the note below.\n\n---------- Forwarded message ---------\nFrom: Court " +
          "Clerk\nSubject: Order entered\n\nThe order regarding the Castel Mediation Engagement " +
          "has been entered on the docket.",
      },
      {
        source_type: "gmail",
        source_id: "corr/castel-vocab",
        title: "Re: Building access reminder [CASTELVOCABMARKERB]",
        occurred_at: "2024-04-01",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "CASTELVOCABMARKERB. Reminder that the parking garage is currently closed for " +
          "repairs; the north entrance remains open and governing signage will be posted. This " +
          "note also references the Castel Mediation Engagement file number for archiving.",
      },
    ],
  },
  {
    key: "solvera",
    question: "Is the Solvera Bramwell Engagement currently active or closed?",
    instrumentMarker: "SOLVERAINSTRUMENTMARKERC",
    vocabMarker: "SOLVERAVOCABMARKERC",
    instrument: {
      source_type: "drive",
      source_id: "instrument/solvera-agreement",
      category: "legal",
      title: "Executed Services Agreement, Solvera Bramwell Engagement [SOLVERAINSTRUMENTMARKERC]",
      content:
        "SOLVERAINSTRUMENTMARKERC. Effective Date: 2024-04-12.\n\nThis executed agreement " +
        "confirms that the Solvera Bramwell Engagement is closed, having reached its natural " +
        "conclusion under Section 9 (Term and Termination). All parties' obligations under " +
        "this engagement terminated as of the effective date above.",
      // Deliberately no occurred_at/date_source/date_reliable: this is the
      // subject used to exercise whatever happens when a drive document's
      // date must come from its body text instead of a supplied envelope
      // field. See the run report for what was actually observed.
      lineageRoot: "drive:instrument/solvera-agreement",
    },
    correspondence: [
      {
        source_type: "gmail",
        source_id: "corr/solvera-attach",
        title: "Fwd: Signed agreement",
        occurred_at: "2024-04-20",
        content:
          "Attachments: solvera-bramwell-agreement-signed.pdf\n\nAttaching the signed copy for " +
          "the Solvera Bramwell Engagement for your records.",
      },
      {
        source_type: "gmail",
        source_id: "corr/solvera-quote",
        title: "Re: Solvera question",
        occurred_at: "2024-04-25",
        content:
          "Quoting the agreement directly: \"the Solvera Bramwell Engagement is closed, having " +
          "reached its natural conclusion.\" Hope that helps.",
      },
      {
        source_type: "gmail",
        source_id: "corr/solvera-forward",
        title: "Fwd: Agreement executed",
        occurred_at: "2024-05-01",
        content:
          "See forwarded note below.\n\n---------- Forwarded message ---------\nFrom: Ops\n" +
          "Subject: Agreement executed\n\nThe Solvera Bramwell Engagement paperwork has been " +
          "fully executed and filed.",
      },
      {
        source_type: "gmail",
        source_id: "corr/solvera-vocab",
        title: "Re: Kitchen access reminder [SOLVERAVOCABMARKERC]",
        occurred_at: "2024-05-10",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "SOLVERAVOCABMARKERC. FYI the shared kitchen is currently closed for cleaning; the " +
          "lobby remains open and governing building rules apply. This also references the " +
          "Solvera Bramwell Engagement folder for filing.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Scripted AI binding.
//
// bge- embedding calls: constant vector (matches the fixture default; vector
// search still returns no matches because VECTORIZE.query is untouched).
//
// Verifier calls ("verify a proposed answer" in the system prompt): allow
// every document number the draft actually cited. This makes any refusal
// below the deterministic temporal gate's decision, not the verifier's.
//
// Drafting calls: find the instrument's assigned document number and the
// "vocabulary" correspondence document's assigned number by locating each
// document's unique marker inside the numbered DOCUMENTS block the model was
// actually shown, then cite both. This is deterministic and inspectable
// (every call is recorded in `calls`) without needing to know retrieval
// ranking ahead of time.
// ---------------------------------------------------------------------------

function findDocNumber(userContent, marker) {
  const idx = userContent.indexOf(marker);
  if (idx === -1) return null;
  const before = userContent.slice(0, idx);
  const matches = [...before.matchAll(/\[(\d+)\] \(/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function makeScriptedAI() {
  const calls = { drafts: [], verifies: [] };
  const run = async (model, input) => {
    if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
    const messages = input?.messages || [];
    const system = String(messages[0]?.content || "");
    const userContent = String(messages[messages.length - 1]?.content || "");

    if (/verify a proposed answer/.test(system)) {
      const afterHeader = userContent.split("PROPOSED ANSWER:")[1] || "";
      const answerOnly = afterHeader.split("CITED DOCUMENTS:")[0] || afterHeader;
      const evidence = [...new Set(
        [...answerOnly.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
      )];
      calls.verifies.push({ userContent, evidence });
      return {
        response: JSON.stringify({
          supported: true,
          complete: true,
          evidence,
          reason: "stub verifier allows every document number the draft cited",
        }),
        usage: {},
      };
    }

    // Documents from every subject can appear in one subject's retrieved set
    // (they share vocabulary like "engagement"/"currently"/"closed"), so the
    // subject must be identified from the literal question line, never from
    // which marker happens to be present in the DOCUMENTS block.
    const questionLine = userContent.match(/^Question: (.*)$/m)?.[1];
    const subject = SUBJECTS.find((s) => s.question === questionLine);
    const instrumentN = subject ? findDocNumber(userContent, subject.instrumentMarker) : null;
    const vocabN = subject ? findDocNumber(userContent, subject.vocabMarker) : null;

    const sentences = [];
    if (instrumentN) {
      sentences.push(`The governing record on file [${instrumentN}] establishes the engagement's history.`);
    }
    if (vocabN) {
      sentences.push(`According to the most recent message on file, the engagement is currently closed [${vocabN}].`);
    }
    const draft = sentences.length ? sentences.join(" ") : "The documents do not answer the question.";
    calls.drafts.push({
      subject: subject?.key || null,
      userContent,
      draft,
      instrumentN,
      vocabN,
    });
    return { response: draft, usage: {} };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Shared fixture, seeded once.
// ---------------------------------------------------------------------------

let fixture;
let scriptedAI;
let docUids; // key -> { instrument, correspondence: [...] }
let unifiedBySubject; // key -> unified() response body
let thinkBySubject; // key -> think() response body

before(async () => {
  scriptedAI = makeScriptedAI();
  fixture = await createProductFixture({ env: { AI: scriptedAI } });

  docUids = {};
  for (const subject of SUBJECTS) {
    const instrumentDocUid = await ingest(fixture, subject.instrument);
    const correspondenceDocUids = [];
    for (const doc of subject.correspondence) {
      correspondenceDocUids.push(await ingest(fixture, doc));
    }
    docUids[subject.key] = { instrument: instrumentDocUid, correspondence: correspondenceDocUids };
  }

  unifiedBySubject = {};
  thinkBySubject = {};
  for (const subject of SUBJECTS) {
    unifiedBySubject[subject.key] = await unified(fixture, subject.question);
    thinkBySubject[subject.key] = await think(fixture, subject.question);
  }
});

after(() => {
  fixture?.close();
});

test("A1: unified ranks the instrument's doc_uid in the top 3 for at least two of three subjects", () => {
  const ranks = SUBJECTS.map((subject) => {
    const results = unifiedBySubject[subject.key]?.results || [];
    const index = results.findIndex((row) => row.doc_uid === docUids[subject.key].instrument);
    return { key: subject.key, index, doc_uids: results.map((r) => r.doc_uid) };
  });
  console.log("A1 unified ranks:", JSON.stringify(ranks, null, 2));
  const top3 = ranks.filter((r) => r.index >= 0 && r.index < 3);
  assert.ok(
    top3.length >= 2,
    `expected the instrument in the unified top 3 for at least 2 of 3 subjects, got ${top3.length}: ${JSON.stringify(ranks)}`,
  );
});

test("A2: think refuses a present-status claim resting on correspondence, for the subjects where A1 held", () => {
  const top3Keys = SUBJECTS
    .filter((subject) => {
      const results = unifiedBySubject[subject.key]?.results || [];
      const index = results.findIndex((row) => row.doc_uid === docUids[subject.key].instrument);
      return index >= 0 && index < 3;
    })
    .map((s) => s.key);

  assert.ok(top3Keys.length >= 2, "no subjects qualified from A1 to check here");

  const reasonPattern = /did not itself support|no reliable-dated evidence/;
  const outcomes = top3Keys.map((key) => {
    const body = thinkBySubject[key];
    return {
      key,
      answer: body.answer,
      reason: body.evidence_gate?.reason,
      citations: body.citations,
    };
  });
  console.log("A2 think outcomes:", JSON.stringify(outcomes, null, 2));

  for (const outcome of outcomes) {
    assert.equal(outcome.answer, null, `subject ${outcome.key}: expected answer null, got ${JSON.stringify(outcome.answer)}`);
    assert.match(
      String(outcome.reason || ""),
      reasonPattern,
      `subject ${outcome.key}: evidence_gate.reason did not match, got ${JSON.stringify(outcome.reason)}`,
    );
    const instrumentDocUid = docUids[outcome.key].instrument;
    assert.ok(
      !(outcome.citations || []).some((c) => c.ref === instrumentDocUid || c.doc_uid === instrumentDocUid),
      `subject ${outcome.key}: a citation referenced the instrument doc_uid despite the refusal`,
    );
  }
});

test("A3: the drafting model was shown the instrument as a numbered document and cited it", () => {
  const bySubject = {};
  for (const call of scriptedAI.calls.drafts) {
    if (call.subject) bySubject[call.subject] = call;
  }
  console.log("A3 draft calls:", JSON.stringify(
    Object.fromEntries(Object.entries(bySubject).map(([k, v]) => [k, {
      instrumentN: v.instrumentN, vocabN: v.vocabN, draft: v.draft,
    }])),
    null,
    2,
  ));

  for (const subject of SUBJECTS) {
    const call = bySubject[subject.key];
    assert.ok(call, `no drafting call recorded for subject ${subject.key}`);
    if (call.instrumentN === null) {
      // The instrument was not among the numbered documents shown to the
      // model at all. Per the task, that is itself the finding to record
      // here rather than something to route around.
      assert.ok(
        false,
        `FINDING for ${subject.key}: the instrument was not among the numbered documents shown to the drafting model`,
      );
      continue;
    }
    assert.ok(
      call.draft.includes(`[${call.instrumentN}]`),
      `subject ${subject.key}: draft did not cite the instrument's number [${call.instrumentN}]: ${call.draft}`,
    );
  }
});

test(
  "A5 (todo, D1 step 3): think should be able to answer the present-status question from the instrument itself",
  { todo: "D1 step 3" },
  () => {
    for (const subject of SUBJECTS) {
      const body = thinkBySubject[subject.key];
      assert.notEqual(body.answer, null, `subject ${subject.key}: expected a non-null answer`);
      assert.equal(
        body.citations?.[0]?.ref,
        docUids[subject.key].instrument,
        `subject ${subject.key}: expected citations[0].ref to be the instrument's doc_uid`,
      );
    }
  },
);

test("observation: date_reliable on the drive instrument documents", () => {
  const observations = SUBJECTS.map((subject) => {
    const results = unifiedBySubject[subject.key]?.results || [];
    const row = results.find((r) => r.doc_uid === docUids[subject.key].instrument);
    return {
      key: subject.key,
      hadOccurredAt: subject.instrument.occurred_at !== undefined,
      foundInUnifiedResults: Boolean(row),
      date_reliable: row?.date_reliable,
      ts: row?.ts,
    };
  });
  console.log("date_reliable observations:", JSON.stringify(observations, null, 2));
  // No assertion: this test exists to force the observation into the run log.
});
