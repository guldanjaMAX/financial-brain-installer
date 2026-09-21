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
 * inspectable: the draft ALWAYS cites the instrument when it was shown to
 * the model. The verifier stub allows every
 * citation the draft made, so any refusal below is provably the deterministic
 * temporal gate in worker/src/index.js, not the scripted model being
 * uncooperative.
 *
 * Every subject, name, and document below is invented for this fixture.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { currentEvidenceCandidates, newestCurrentEvidence } from "../src/lib/query-intent.js";

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
// "drive") and four reliably dated CORRESPONDENCE documents (source
// "gmail", all dated after the instrument): one that attaches it by
// filename only, one that quotes its operative clause inline, one that
// forwards it, and one newest note that repeats the question's own
// vocabulary while saying nothing about the entity's actual status.
// Only that newest note carries the full named-subject anchor. Removing
// it is a clean recency control without removing every newer message.
// ---------------------------------------------------------------------------

const SUBJECTS = [
  {
    key: "meridian",
    question: "Is our engagement with Meridian Grove Holdings LLC currently active or closed?",
    statusSubject: "Meridian Grove Holdings LLC engagement",
    instrumentMarker: "MERIDIANINSTRUMENTMARKERA",
    vocabMarker: "MERIDIANVOCABMARKERA",
    instrument: {
      source_type: "drive",
      source_id: "instrument/meridian-dissolution",
      category: "legal",
      title: "Certificate of Dissolution and Articles of Organization, Meridian Grove Holdings LLC, 2024-01-15 [MERIDIANINSTRUMENTMARKERA]",
      content:
        "MERIDIANINSTRUMENTMARKERA. This certificate confirms that Meridian Grove Holdings LLC's " +
        "operating engagement is closed as of the filing date below, following the members' " +
        "unanimous vote to dissolve the company. The manager's engagement with Meridian Grove " +
        "Holdings LLC terminated upon this filing. Filed with the Secretary of State on 2024-01-15.",
      occurred_at: "2024-01-15",
      date_source: "filename",
      date_reliable: true,
      lineageRoot: "drive:instrument/meridian-dissolution",
    },
    correspondence: [
      {
        source_type: "gmail",
        source_id: "corr/meridian-attach",
        title: "Fwd: Paperwork for your files",
        occurred_at: "2024-02-01",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Attachments: certificate-of-dissolution-meridian.pdf\n\nHi team, attaching the " +
          "paperwork for your records. Let me know if you need anything else.",
      },
      {
        source_type: "gmail",
        source_id: "corr/meridian-quote",
        title: "Re: Meridian Grove question",
        occurred_at: "2024-02-10",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Following up on your question. Quoting the filing, \"operating engagement " +
          "is closed as of the filing date.\" Please check the signed document itself.",
      },
      {
        source_type: "gmail",
        source_id: "corr/meridian-forward",
        title: "Fwd: Meridian filing confirmation",
        occurred_at: "2024-02-20",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Please see the forwarded message below.\n\n---------- Forwarded message ---------\n" +
          "From: State Filing Office\nSubject: Filing confirmed\n\nThe submitted " +
          "paperwork has been recorded.",
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
    statusSubject: "Castel Mediation Engagement",
    instrumentMarker: "CASTELINSTRUMENTMARKERB",
    vocabMarker: "CASTELVOCABMARKERB",
    instrument: {
      source_type: "drive",
      source_id: "instrument/castel-order",
      category: "legal",
      title: "Final Judgment and Settlement Order, Castel Mediation Engagement, 2024-03-03 [CASTELINSTRUMENTMARKERB]",
      content:
        "CASTELINSTRUMENTMARKERB. This judgment confirms that the Castel Mediation Engagement " +
        "is closed. All obligations under the mediation are terminated as of the order date " +
        "below. Entered 2024-03-03.",
      occurred_at: "2024-03-03",
      date_source: "filename",
      date_reliable: true,
      lineageRoot: "drive:instrument/castel-order",
    },
    correspondence: [
      {
        source_type: "gmail",
        source_id: "corr/castel-attach",
        title: "Fwd: Signed copy",
        occurred_at: "2024-03-10",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Attachments: castel-settlement-order-signed.pdf\n\nHere is the signed copy for your " +
          "files. Please keep it with the rest of the matter's paperwork.",
      },
      {
        source_type: "gmail",
        source_id: "corr/castel-quote",
        title: "Re: Castel order question",
        occurred_at: "2024-03-15",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Quoting the signed order: \"All obligations under the mediation are terminated.\" " +
          "Please consult the order for the parties and effective date.",
      },
      {
        source_type: "gmail",
        source_id: "corr/castel-forward",
        title: "Fwd: Order entered",
        occurred_at: "2024-03-20",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Forwarding the note below.\n\n---------- Forwarded message ---------\nFrom: Court " +
          "Clerk\nSubject: Order entered\n\nThe signed order " +
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
    statusSubject: "Solvera Bramwell Engagement",
    instrumentMarker: "SOLVERAINSTRUMENTMARKERC",
    vocabMarker: "SOLVERAVOCABMARKERC",
    instrument: {
      source_type: "drive",
      source_id: "instrument/solvera-agreement",
      category: "legal",
      title: "Executed Services Agreement, Solvera Bramwell Engagement, 2024-04-12 [SOLVERAINSTRUMENTMARKERC]",
      content:
        "SOLVERAINSTRUMENTMARKERC. Effective Date: 2024-04-12.\n\nThis executed agreement " +
        "confirms that the Solvera Bramwell Engagement is closed, having reached its natural " +
        "conclusion under Section 9 (Term and Termination). All parties' obligations under " +
        "this engagement terminated as of the effective date above.",
      occurred_at: "2024-04-12",
      date_source: "filename",
      date_reliable: true,
      lineageRoot: "drive:instrument/solvera-agreement",
    },
    correspondence: [
      {
        source_type: "gmail",
        source_id: "corr/solvera-attach",
        title: "Fwd: Signed agreement",
        occurred_at: "2024-04-20",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Attachments: solvera-bramwell-agreement-signed.pdf\n\nAttaching the signed copy for " +
          "your records. Please retain the original attachment.",
      },
      {
        source_type: "gmail",
        source_id: "corr/solvera-quote",
        title: "Re: Solvera question",
        occurred_at: "2024-04-25",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "Quoting the signed agreement directly: \"having reached its natural conclusion " +
          "under Section 9.\" Please check the agreement for the named parties.",
      },
      {
        source_type: "gmail",
        source_id: "corr/solvera-forward",
        title: "Fwd: Agreement executed",
        occurred_at: "2024-05-01",
        date_source: "gmail:sent_at",
        date_reliable: true,
        content:
          "See forwarded note below.\n\n---------- Forwarded message ---------\nFrom: Ops\n" +
          "Subject: Agreement executed\n\nThe signed paperwork has been " +
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
// actually shown, then cite the instrument. This is deterministic and inspectable
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
      const questionLine = userContent.match(/^Question: (.*)$/m)?.[1];
      const subject = SUBJECTS.find((s) => s.question === questionLine);
      const afterHeader = userContent.split("PROPOSED ANSWER:")[1] || "";
      const answerOnly = afterHeader.split("CITED DOCUMENTS:")[0] || afterHeader;
      const evidence = [...new Set(
        [...answerOnly.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
      )];
      calls.verifies.push({ subject: subject?.key || null, userContent, evidence, supported: true, complete: true });
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
      sentences.push(`The ${subject.statusSubject} is currently closed [${instrumentN}].`);
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

async function seedScenario(targetFixture, { invertDates = false, omitNewest = false } = {}) {
  const uids = {};
  for (const subject of SUBJECTS) {
    const originalDate = subject.instrument.occurred_at;
    const invertedDate = "2024-12-01";
    // Invert only the instrument's date, including its filename and printed
    // date, so the date_source="filename" claim stays internally consistent.
    const instrument = invertDates
      ? {
          ...subject.instrument,
          occurred_at: invertedDate,
          title: subject.instrument.title.replaceAll(originalDate, invertedDate),
          content: subject.instrument.content.replaceAll(originalDate, invertedDate),
        }
      : subject.instrument;
    const instrumentDocUid = await ingest(targetFixture, instrument);
    const correspondenceDocUids = [];
    const correspondence = omitNewest ? subject.correspondence.slice(0, -1) : subject.correspondence;
    for (const doc of correspondence) {
      correspondenceDocUids.push(await ingest(targetFixture, doc));
    }
    uids[subject.key] = { instrument: instrumentDocUid, correspondence: correspondenceDocUids };
  }
  return uids;
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
  docUids = await seedScenario(fixture);

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

async function runControl(options) {
  const controlAI = makeScriptedAI();
  const controlFixture = await createProductFixture({ env: { AI: controlAI } });
  try {
    const uids = await seedScenario(controlFixture, options);
    const outcomes = [];
    for (const subject of SUBJECTS) {
      const search = await unified(controlFixture, subject.question);
      const answer = await think(controlFixture, subject.question);
      const newest = newestCurrentEvidence(subject.question, search.results || [], {
        owner: controlFixture.env.BRAIN_OWNER || null,
      });
      outcomes.push({
        key: subject.key,
        answer: answer.answer,
        reason: answer.evidence_gate?.reason,
        firstCitation: answer.citations?.[0]?.ref,
        instrument: uids[subject.key].instrument,
        correspondenceCount: uids[subject.key].correspondence.length,
        newestUids: newest.map((row) => row.doc_uid),
      });
    }
    return outcomes;
  } finally {
    controlFixture.close();
  }
}

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

test("A2: every subject refuses for one of the two specified present-status reasons", () => {
  const reasonPattern = /^(?:newest cited evidence did not itself support the present-status claim|present-status claim cited older evidence while newer direct evidence was available)$/;
  const outcomes = SUBJECTS.map(({ key }) => {
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

test("A3: the instrument is retrieved and eligible but not selected as newest", () => {
  const observations = SUBJECTS.map((subject) => {
    const results = unifiedBySubject[subject.key]?.results || [];
    const opts = { owner: fixture.env.BRAIN_OWNER || null };
    const candidates = currentEvidenceCandidates(subject.question, results, opts);
    const newest = newestCurrentEvidence(subject.question, results, opts);
    const instrument = docUids[subject.key].instrument;
    const instrumentRow = results.find((row) => row.doc_uid === instrument);
    return {
      key: subject.key,
      inResults: Boolean(instrumentRow),
      inCandidates: candidates.some((row) => row.doc_uid === instrument),
      inNewest: newest.some((row) => row.doc_uid === instrument),
      instrumentAuthority: instrumentRow?.authority?.tier,
      newestAuthority: newest[0]?.authority?.tier,
      newestUids: newest.map((row) => row.doc_uid),
    };
  });
  console.log("A3 selector observations:", JSON.stringify(observations, null, 2));
  for (const observation of observations) {
    assert.equal(observation.inResults, true, `${observation.key}: instrument missing from results`);
    assert.equal(observation.inCandidates, true, `${observation.key}: instrument missing from currentEvidenceCandidates`);
    assert.equal(observation.inNewest, false, `${observation.key}: instrument unexpectedly in newestCurrentEvidence`);
    assert.equal(observation.instrumentAuthority, "T1", `${observation.key}: instrument was not classified T1`);
    assert.equal(observation.newestAuthority, "T3", `${observation.key}: newer email was not classified T3`);
    assert.deepEqual(observation.newestUids, [docUids[observation.key].correspondence.at(-1)]);
  }
});

test("A4: the drafting model saw and cited the numbered instrument and its verifier allowed it", () => {
  const bySubject = {};
  for (const call of scriptedAI.calls.drafts) {
    if (call.subject) bySubject[call.subject] = call;
  }
  console.log("A4 draft calls:", JSON.stringify(
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
    assert.match(call.userContent, new RegExp(`\\[${call.instrumentN}\\] \\(`));
    const verifier = scriptedAI.calls.verifies.find((entry) => entry.subject === subject.key);
    assert.ok(verifier, `subject ${subject.key}: no verifier call was recorded`);
    assert.equal(verifier.supported, true);
    assert.equal(verifier.complete, true);
    assert.ok(verifier.evidence.includes(call.instrumentN),
      `subject ${subject.key}: scripted verifier did not allow the instrument citation`);
  }
});

test("B1: when instrument dates alone become newest, it answers with the instrument", async () => {
  const outcomes = await runControl({ invertDates: true });
  console.log("B1 inverted-date outcomes:", JSON.stringify(outcomes, null, 2));
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.newestUids, [outcome.instrument], `${outcome.key}: instrument was not selected as newest`);
    assert.notEqual(outcome.answer, null, `${outcome.key}: inverted-date answer was refused: ${outcome.reason}`);
    assert.equal(`drive:${outcome.firstCitation}`, outcome.instrument,
      `${outcome.key}: first citation ref did not identify the instrument doc_uid`);
  }
});

test("B2: removing only the newest named correspondence makes the instrument answer", async () => {
  const outcomes = await runControl({ omitNewest: true });
  console.log("B2 newest-email-omitted outcomes:", JSON.stringify(outcomes, null, 2));
  for (const outcome of outcomes) {
    assert.equal(outcome.correspondenceCount, 3, `${outcome.key}: did not remove exactly one email`);
    assert.deepEqual(outcome.newestUids, [outcome.instrument], `${outcome.key}: instrument was not selected as newest`);
    assert.notEqual(outcome.answer, null, `${outcome.key}: omitted-email answer was refused: ${outcome.reason}`);
    assert.equal(`drive:${outcome.firstCitation}`, outcome.instrument,
      `${outcome.key}: first citation ref did not identify the instrument doc_uid`);
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
        subject.instrument.source_id,
        `subject ${subject.key}: expected citations[0].ref to be the instrument's source_id`,
      );
    }
  },
);

test("fixture: every instrument and email has explicit reliable date provenance", () => {
  const observations = SUBJECTS.map((subject) => {
    for (const document of [subject.instrument, ...subject.correspondence]) {
      assert.equal(document.date_reliable, true, `${document.source_id}: date_reliable must be explicit`);
      assert.ok(document.occurred_at, `${document.source_id}: occurred_at missing`);
      assert.ok(document.date_source, `${document.source_id}: date_source missing`);
    }
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
  for (const observation of observations) {
    assert.equal(observation.hadOccurredAt, true, `${observation.key}: instrument lacked occurred_at`);
    assert.equal(observation.foundInUnifiedResults, true, `${observation.key}: instrument was not retrieved`);
    assert.equal(observation.date_reliable, true, `${observation.key}: instrument did not retain reliable date`);
    assert.ok(observation.ts, `${observation.key}: instrument had no retained timestamp`);
  }
});
