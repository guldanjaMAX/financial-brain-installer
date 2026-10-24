import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { cmdIngestRemote, credentialScannerFingerprint } from "../brain.mjs";
import {
  DEFAULT_EXCLUDED_LABEL_IDS, GMAIL_EXTRACTION_POLICY_VERSION,
  gmailExtractionVersion, gmailPolicyFingerprint, gmailQuery,
} from "../connectors/gmail.mjs";
import * as ingest from "../ingest/run.mjs";

// Real runner acceptance tests for the separate candidate checkpoint. Provider
// and Worker boundaries reject every route outside these synthetic fixtures.
const scanner = credentialScannerFingerprint(true);
const candidateQuery = `${gmailQuery()} has:attachment {filename:xlsx filename:xls filename:csv filename:pdf}`;
const currentPolicy = () => gmailPolicyFingerprint({ credentialScannerFingerprint: scanner });
const legacyPolicy = () => createHash("sha256").update(JSON.stringify({
  version: 1,
  query: gmailQuery(),
  excludedLabelIds: [...DEFAULT_EXCLUDED_LABEL_IDS].sort(),
  extractionPolicyVersion: 1,
  credentialScannerFingerprint: scanner,
})).digest("hex");
const checkpoint = ({ complete = false, pending = [], next = null } = {}) => ({
  schema_version: 1,
  extraction_version: GMAIL_EXTRACTION_POLICY_VERSION,
  query: candidateQuery,
  scanner_fingerprint: scanner,
  pending_ids: [...pending],
  next_page_token: next,
  complete,
});
const json = value => new Response(JSON.stringify(value), { status: 200 });

async function fixture(run, {
  mailboxSize = 64,
  reports = ["report-one", "report-two", "report-three"],
  legacy = false,
  backfill = checkpoint({ complete: true }),
  cap = 100,
} = {}) {
  const temporaryRoot = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(temporaryRoot, "gmail-backfill-probe-")));
  const manifestPath = join(root, "fixture.manifest.json");
  const manifest = {
    client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    corpora: { gmail: { enabled: true } },
    safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const done = Object.fromEntries(Array.from({ length: mailboxSize - reports.length },
    (_, index) => [`gmail:body-${index}`, "legacy-message-revision"]));
  for (const id of reports) done[`gmail:${id}`] = "legacy-message-revision";
  let persisted = {
    version: 1, done, skipped: {}, history_id: "history-before",
    credential_scanner_fingerprint: scanner,
    gmail_policy_fingerprint: legacy ? legacyPolicy() : currentPolicy(),
    ...(backfill ? { gmail_attachment_backfill: structuredClone(backfill) } : {}),
  };
  const stored = new Set(Object.keys(done));
  const observations = {
    fullLists: 0, inventories: 0, histories: 0, candidatePages: [],
    rawReads: [], sent: [], previewFamilies: [], receipts: [], saves: 0,
    historyIds: [], marker: "history-after", changed: [],
    page: null, envelope: null, batch: null, preview: null, request: null, onSave: null,
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = console.warn = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== "https://fixture.invalid" || parsed.username || parsed.password) {
      throw new Error("offline fixture refused an external request");
    }
    if (parsed.pathname === "/api/admin/brain/ingest/batch") {
      const docs = JSON.parse(options.body).docs;
      assert.ok(Array.isArray(docs), "fixture batch must contain documents");
      observations.sent.push(...docs.map(doc => doc.source_id));
      if (observations.batch) return json(observations.batch(docs));
      return json({ results: docs.map(doc => ({ source_id: doc.source_id, status: "updated", chunks: 1 })) });
    }
    if (parsed.pathname === "/api/admin/brain/documents") return json({ vector_backlog: { pending: 1 } });
    throw new Error("offline fixture refused an unknown route");
  };
  const once = async (flags = {}) => {
    let failed = false;
    let outcome = null;
    try {
      outcome = await cmdIngestRemote(manifest, manifestPath, { from: "gmail", source: "gmail", ...flags }, {
        withSourceIngestLock: async (_options, task) => task({ assertOwned() {} }),
        resolveBaseUrl: async () => "https://fixture.invalid",
        resolveAdminKey: () => "synthetic-owner-authority",
        getAccessToken: async () => { throw new Error("provider credential seam must remain unused"); },
        ingestLib: async () => ({ ...ingest,
          loadState: () => structuredClone(persisted),
          saveState: (_path, state) => {
            observations.saves++; persisted = structuredClone(state); observations.onSave?.(state);
          },
        }),
        // A dependency-injected bound for a small resume rehearsal. Production
        // retains the fixed 100-candidate cap; this is not manifest configuration.
        gmailAttachmentBackfillLimit: cap,
        gmail: {
          currentHistoryId: async () => observations.marker,
          listHistory: async (_token, historyId) => {
            observations.histories++;
            observations.historyIds.push(historyId);
            return { ids: [...observations.changed], deletedIds: [], historyId: observations.marker };
          },
          listMessages: async function* () {
            observations.fullLists++;
            // The state really contains the full scale denominator. Stop an
            // erroneous walk after enough rows to prove excess work, so this
            // red probe never performs 140,000 synthetic writes.
            let yielded = 0;
            for (const uid of stored) {
              if (yielded++ >= 104) throw new Error("synthetic full-walk budget exceeded");
              yield uid.slice("gmail:".length);
            }
          },
          listAttachmentCandidates: async (_token, { query, pageToken = null, pageSize }) => {
            assert.equal(query, candidateQuery, "backfill must request only the supported candidate query");
            assert.ok(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= cap,
              "candidate provider page must honor the remaining run budget");
            observations.candidatePages.push(pageToken);
            if (observations.page) return observations.page({ pageToken, pageSize });
            const offset = pageToken == null ? 0 : Number(pageToken.replace("candidate-page-", ""));
            assert.ok(Number.isSafeInteger(offset) && offset >= 0, "synthetic page token must be valid");
            const ids = reports.slice(offset, offset + pageSize);
            return { ids, nextPageToken: offset + ids.length < reports.length
              ? `candidate-page-${offset + ids.length}` : null };
          },
          messagePolicy: async () => ({ allowed: true, cursor_blocking: false }),
          toEnvelope: async (_token, id) => {
            observations.rawReads.push(id);
            if (observations.envelope) return observations.envelope(id);
            return { version: gmailExtractionVersion(`revision-${id}`), envelope: {
              source_type: "gmail", source_id: id, title: "Synthetic correspondence",
              content: reports.includes(id)
                ? "Synthetic report attachment lists cash of 400 and liabilities of 100."
                : "Ordinary synthetic correspondence has no supported attachment.",
            } };
          },
        },
        listStoredSourceFamilies: async () => { observations.inventories++; return new Set(stored); },
        postSourceReceipt: async (_base, _authority, receipt) => {
          observations.receipts.push({ status: receipt.status, lane: receipt.lane });
          return receipt;
        },
        removalPlanRequest: async ({ body }) => {
          if (observations.request) return observations.request(body);
          assert.equal(body.action, "preview", "no removal is authorized by this fixture");
          observations.previewFamilies.push(...(body.families || []).map(family => family.base_doc_uid));
          if (observations.preview) return observations.preview(body);
          return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" },
            targets: [], documents: 0 };
        },
        removalPlanRuntime: () => "synthetic-runtime",
      });
    } catch { failed = true; }
    // Return only closed evidence. Errors and envelopes are never test output.
    return { failed, state: structuredClone(persisted), outcome };
  };
  try { await run({ observations, once, state: () => structuredClone(persisted),
    editState: change => change(persisted) }); }
  finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    const relativeRoot = relative(temporaryRoot, root);
    assert.ok(relativeRoot && !relativeRoot.startsWith("..") && !isAbsolute(relativeRoot));
    rmSync(root, { recursive: true, force: true });
  }
}

test("control: a completed backfill keeps an empty history run free of content work", async () => {
  await fixture(async ({ observations: seen, once }) => {
    const result = await once();
    assert.equal(result.failed, false);
    assert.equal(seen.histories, 1);
    assert.equal(result.state.history_id, "history-after");
    assert.equal(Object.keys(result.state.done).length, 64);
    assert.equal(seen.fullLists + seen.inventories + seen.rawReads.length + seen.sent.length +
      seen.previewFamilies.length + seen.candidatePages.length, 0);
  });
});

test("control: ordinary new mail still reaches raw read, send and replacement preview", async () => {
  await fixture(async ({ observations: seen, once }) => {
    seen.changed = ["new-body"];
    const result = await once();
    assert.equal(result.failed, false);
    assert.deepEqual(seen.rawReads, ["new-body"]);
    assert.deepEqual(seen.sent, ["new-body"]);
    assert.deepEqual(seen.previewFamilies, ["gmail:new-body"]);
    assert.equal(result.state.history_id, "history-after");
    assert.equal(seen.candidatePages.length, 0);
  });
});

test("control: a completed-checkpoint dry run performs no state or receipt writes", async () => {
  await fixture(async ({ observations: seen, once, state }) => {
    const before = state();
    const result = await once({ "dry-run": true });
    assert.equal(result.failed, false);
    assert.deepEqual(result.state, before);
    assert.equal(seen.saves + seen.sent.length + seen.receipts.length, 0);
  });
});

test("an extraction upgrade preserves the legacy Gmail membership fingerprint", () => {
  assert.equal(gmailQuery(), gmailQuery({ since: null }), "control: the membership query is unchanged");
  assert.equal(currentPolicy(), legacyPolicy(),
    "an extraction-only upgrade must not select an authoritative membership sweep");
});

test("140000 legacy messages fetch, send and preview only three report candidates", async () => {
  const candidates = ["report-one", "report-two", "report-three"];
  await fixture(async ({ observations: seen, once }) => {
    const result = await once();
    const counts = { fetch: seen.rawReads.length, send: seen.sent.length, preview: seen.previewFamilies.length };
    assert.ok(Object.values(counts).every(count => count <= candidates.length),
      `candidate-only budgets exceeded: ${JSON.stringify(counts)}`);
    assert.equal(result.failed, false, "candidate backfill must finish this bounded page");
    assert.equal(seen.fullLists + seen.inventories, 0, "backfill must not walk ordinary mail or full D1 inventory");
    assert.equal(seen.histories, 1, "normal history remains active during attachment migration");
    assert.deepEqual(seen.rawReads, candidates);
    assert.deepEqual(seen.sent, candidates);
    assert.deepEqual(seen.previewFamilies, candidates.map(id => `gmail:${id}`));
    assert.equal(result.state.history_id, "history-after");
    assert.equal(result.state.done["gmail:body-0"], "legacy-message-revision");
    assert.equal(Object.keys(result.state.done).length, 140_000);
    assert.equal(result.state.gmail_attachment_backfill?.complete, true);
  }, { mailboxSize: 140_000, reports: candidates, legacy: true, backfill: null });
});

test("a capped backfill resumes pending candidates before requesting another page", async () => {
  const reports = ["report-one", "report-two", "report-three"];
  await fixture(async ({ observations: seen, once }) => {
    const first = await once();
    assert.equal(first.failed, false);
    assert.deepEqual(seen.sent, ["report-one"], "the run cap must allow one pending candidate");
    assert.deepEqual(seen.candidatePages, [], "saved pending candidates precede the next provider page");
    assert.deepEqual(first.state.gmail_attachment_backfill.pending_ids, ["report-two"]);
    assert.equal(first.state.history_id, "history-after");

    seen.marker = "history-later";
    const second = await once();
    assert.equal(second.failed, false);
    assert.deepEqual(seen.sent, ["report-one", "report-two"]);
    assert.deepEqual(seen.candidatePages, []);
    assert.equal(second.state.history_id, "history-later");

    seen.marker = "history-final";
    const third = await once();
    assert.equal(third.failed, false);
    assert.deepEqual(seen.sent, reports, "accepted candidates must not be resent on later capped runs");
    assert.deepEqual(seen.rawReads, reports);
    assert.deepEqual(seen.candidatePages, ["candidate-page-2"]);
    assert.equal(seen.fullLists + seen.inventories, 0);
    assert.equal(third.state.history_id, "history-final");
    assert.equal(third.state.gmail_attachment_backfill.complete, true);
  }, { reports, cap: 1, backfill: checkpoint({ pending: reports.slice(0, 2), next: "candidate-page-2" }) });
});

test("a missing acknowledgement keeps the candidate pending while history stays live", async () => {
  await fixture(async ({ observations: seen, once }) => {
    seen.batch = () => ({ results: [] });
    const failed = await once();
    assert.equal(failed.failed, true);
    assert.equal(failed.state.history_id, "history-after");
    assert.deepEqual(failed.state.gmail_attachment_backfill.pending_ids, ["report-one"]);
    assert.equal(failed.state.done["gmail:report-one"], "legacy-message-revision");
    assert.equal(seen.previewFamilies.length, 0);
    seen.batch = null;
    seen.marker = "history-recovered";
    const recovered = await once();
    assert.equal(recovered.failed, false);
    assert.equal(recovered.state.history_id, "history-recovered");
    assert.equal(recovered.state.gmail_attachment_backfill.complete, true);
    assert.deepEqual(seen.candidatePages, [null]);
  }, { reports: ["report-one"], backfill: null });
});

test("missing MIME evidence retains a candidate and a recovered provider read finishes it", async () => {
  await fixture(async ({ observations: seen, once }) => {
    seen.envelope = id => ({ skip: { id, reason: "message evidence unavailable" }, cursor_blocking: true });
    const held = await once();
    assert.equal(held.failed, true);
    assert.equal(held.state.history_id, "history-after");
    assert.deepEqual(held.state.gmail_attachment_backfill.pending_ids, ["report-one"]);
    assert.equal(seen.sent.length, 0);
    seen.envelope = null;
    const recovered = await once();
    assert.equal(recovered.failed, false);
    assert.equal(recovered.state.gmail_attachment_backfill.complete, true);
    assert.deepEqual(seen.sent, ["report-one"]);
  }, { reports: ["report-one"], backfill: null });
});

test("a candidate dry run is capped and changes no checkpoint, receipts or documents", async () => {
  await fixture(async ({ observations: seen, once, state }) => {
    const before = state();
    const result = await once({ "dry-run": true });
    assert.equal(result.failed, false);
    assert.deepEqual(seen.rawReads, ["report-one"]);
    assert.equal(result.outcome.would_send, 1);
    assert.deepEqual(result.state, before);
    assert.equal(seen.saves + seen.sent.length + seen.receipts.length + seen.previewFamilies.length, 0);
  }, { cap: 1, backfill: null });
});

test("invalid provider pages cannot grant completion and a valid page recovers", async () => {
  for (const page of [{ ids: null }, { ids: ["bad/id"], nextPageToken: null },
    { ids: ["report-one", "report-two"], nextPageToken: null },
    { ids: [], nextPageToken: "candidate-page-1" }]) {
    await fixture(async ({ observations: seen, once }) => {
      seen.page = () => page;
      const held = await once();
      assert.equal(held.failed, true);
      assert.equal(held.state.history_id, "history-after");
      assert.equal(held.state.gmail_attachment_backfill.complete, false);
      assert.equal(seen.rawReads.length, 0);
      seen.page = null;
      const control = await once();
      assert.equal(control.failed, false);
      assert.equal(control.state.gmail_attachment_backfill.complete, true);
    }, { reports: ["report-one", "report-two"], cap: 1,
      backfill: checkpoint({ next: "candidate-page-1" }) });
  }
});

test("expired candidate tokens restart candidate search without replaying accepted content", async () => {
  await fixture(async ({ observations: seen, once }) => {
    const first = await once();
    assert.equal(first.failed, false);
    assert.deepEqual(seen.sent, ["report-one"]);
    seen.page = () => { const error = new Error("synthetic expired page"); error.reason = "attachmentPageTokenExpired"; throw error; };
    seen.marker = "history-later";
    const expired = await once();
    assert.equal(expired.state.history_id, "history-later");
    assert.equal(expired.state.gmail_attachment_backfill.complete, false);
    assert.equal(expired.state.gmail_attachment_backfill.next_page_token, null);
    seen.page = null;
    await once();
    const final = await once();
    assert.equal(final.failed, false);
    assert.equal(final.state.gmail_attachment_backfill.complete, true);
    assert.deepEqual(seen.rawReads, ["report-one", "report-two"]);
    assert.deepEqual(seen.sent, ["report-one", "report-two"]);
    assert.equal(seen.fullLists + seen.inventories, 0);
  }, { reports: ["report-one", "report-two"], cap: 1, backfill: null });
});

test("empty pages consume a separate provider page budget", async () => {
  await fixture(async ({ observations: seen, once }) => {
    seen.page = () => ({ ids: [], nextPageToken: `empty-${seen.candidatePages.length}` });
    const bounded = await once();
    assert.equal(bounded.failed, false);
    assert.equal(seen.candidatePages.length, 10);
    assert.equal(bounded.state.gmail_attachment_backfill.complete, false);
    assert.equal(bounded.state.history_id, "history-after");
    seen.page = () => ({ ids: [], nextPageToken: null });
    const control = await once();
    assert.equal(control.failed, false);
    assert.equal(control.state.gmail_attachment_backfill.complete, true);
  }, { backfill: null });
});

test("independent candidate cleanup keeps history live and applies only its exact approved targets", async () => {
  await fixture(async ({ observations: seen, once }) => {
    let removed = false;
    const marker = () => ({ instance: "fixture", nonce: "fixture", generation: removed ? 2 : 1, runtime: "fixture" });
    seen.request = body => {
      if (body.action === "apply") {
        assert.deepEqual(body.targets, ["gmail:report-one#part1of2"]);
        assert.equal(body.marker.generation, 1);
        removed = true;
        return { documents: 1, marker: marker() };
      }
      assert.equal(body.action, "preview");
      const targets = !removed && body.families.some(f => f.base_doc_uid === "gmail:report-one")
        ? ["gmail:report-one#part1of2"] : [];
      return { targets, documents: targets.length, marker: marker() };
    };
    const first = await once();
    assert.equal(first.failed, true);
    assert.equal(first.state.history_id, "history-after");
    assert.ok(first.state.gmail_attachment_backfill.review.ingest_removal_plan);
    assert.equal(first.state.ingest_removal_plan, undefined);
    assert.equal(first.state.ingest_pending_families, undefined);
    seen.marker = "history-later";
    seen.changed = ["new-body"];
    const second = await once();
    assert.equal(second.failed, true);
    assert.equal(second.state.history_id, "history-later");
    assert.deepEqual(seen.rawReads, ["report-one", "new-body"]);
    assert.equal(removed, false);
    const fingerprint = second.state.gmail_attachment_backfill.review.ingest_removal_plan.fingerprint;
    const applied = await once({ "apply-removals": fingerprint });
    assert.equal(applied.failed, false);
    assert.equal(removed, true);
    assert.equal(applied.state.history_id, "history-later");
    seen.changed = [];
    const resumed = await once();
    assert.equal(resumed.failed, false);
    assert.equal(resumed.state.gmail_attachment_backfill.complete, true);
    assert.deepEqual(seen.rawReads, ["report-one", "new-body"]);
  }, { reports: ["report-one"], backfill: null });
});

test("a completed marker cannot conceal pending candidate cleanup", async () => {
  await fixture(async ({ once, editState }) => {
    editState(state => { state.gmail_attachment_backfill.review = { ingest_removal_plan: { fingerprint: "pending" } }; });
    const blocked = await once();
    assert.equal(blocked.failed, true);
    assert.equal(blocked.state.history_id, "history-after");
    assert.ok(blocked.state.gmail_attachment_backfill.review.ingest_removal_plan);
    editState(state => { delete state.gmail_attachment_backfill.review; });
    assert.equal((await once()).failed, false);
  });
});

test("a rejected cleanup intent cannot become a resumable accepted candidate", async () => {
  await fixture(async ({ observations: seen, once }) => {
    seen.envelope = id => ({ version: gmailExtractionVersion("new"), envelope: {
      source_type: "wrong-source", source_id: id, content: "Synthetic complete report content with readable accounts.",
    } });
    const blocked = await once();
    assert.equal(blocked.failed, true);
    assert.equal(blocked.state.done["gmail:report-one"], "legacy-message-revision");
    assert.deepEqual(blocked.state.gmail_attachment_backfill.pending_ids, ["report-one"]);
    seen.envelope = null;
    const control = await once();
    assert.equal(control.failed, false);
    assert.equal(control.state.gmail_attachment_backfill.complete, true);
    assert.deepEqual(seen.rawReads, ["report-one", "report-one"]);
  }, { reports: ["report-one"], backfill: null });
});

test("malformed nested reviews cannot authorize an exhausted or completed checkpoint", async () => {
  for (const complete of [true, false]) await fixture(async ({ once, editState }) => {
    editState(state => {
      state.gmail_attachment_backfill.enumeration_started = true;
      state.gmail_attachment_backfill.review = { version: 1, done: [], skipped: {} };
    });
    const blocked = await once();
    assert.equal(blocked.failed, true);
    assert.equal(blocked.state.history_id, "history-after");
    editState(state => { delete state.gmail_attachment_backfill.review; });
    assert.equal((await once()).failed, false);
  }, { backfill: checkpoint({ complete }) });
});

test("partial family acceptance stays pending until every split part is acknowledged", async () => {
  await fixture(async ({ observations: seen, once }) => {
    seen.batch = docs => ({ results: docs.map(doc => ({ source_id: doc.source_id,
      status: doc.source_id.endsWith("#part2of3") ? "refused" : "updated", chunks: 1 })) });
    // Three parts make the interrupted family cross the real batch boundary.
    seen.envelope = id => ({ version: gmailExtractionVersion("split"), envelope: {
      source_type: "gmail", source_id: id, title: "Synthetic long report",
      content: "Operating account and report evidence. ".repeat(24_000),
    } });
    const blocked = await once();
    assert.equal(blocked.failed, true);
    assert.equal(blocked.state.history_id, "history-after");
    assert.equal(blocked.state.done["gmail:report-one"], "legacy-message-revision");
    assert.deepEqual(blocked.state.gmail_attachment_backfill.pending_ids, ["report-one"]);
    assert.equal(seen.previewFamilies.length, 0);
    seen.batch = null;
    const accepted = await once();
    assert.equal(accepted.failed, false);
    assert.equal(accepted.state.gmail_attachment_backfill.complete, true);
    assert.equal(accepted.state.done["gmail:report-one"], gmailExtractionVersion("split"));
    assert.deepEqual(seen.previewFamilies, ["gmail:report-one"]);
  }, { reports: ["report-one"], backfill: null });
});

test("a changed scanner binding restarts candidate enumeration and retains normal history", async () => {
  await fixture(async ({ observations: seen, once, editState }) => {
    editState(state => { state.gmail_attachment_backfill.scanner_fingerprint = "previous-scanner"; });
    const result = await once();
    assert.equal(result.failed, false);
    assert.equal(result.state.history_id, "history-after");
    assert.deepEqual(seen.sent, ["report-one"]);
    assert.equal(result.state.gmail_attachment_backfill.scanner_fingerprint, scanner);
    assert.equal(result.state.gmail_attachment_backfill.complete, true);
    assert.equal((await once()).failed, false);
    assert.deepEqual(seen.sent, ["report-one"]);
  }, { reports: ["report-one"] });
});

test("a changed accepted revision or migration binding rebuilds pending candidate cleanup", async () => {
  for (const change of ["revision", "scanner"]) await fixture(async ({ observations: seen, once, editState }) => {
    let targets = ["gmail:report-one#part1of2"];
    seen.preview = () => ({ targets, documents: targets.length,
      marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" } });
    const first = await once();
    assert.equal(first.failed, true);
    assert.ok(first.state.gmail_attachment_backfill.review.ingest_removal_plan);
    editState(state => {
      if (change === "revision") state.done["gmail:report-one"] = gmailExtractionVersion("changed-by-history");
      else state.gmail_attachment_backfill.scanner_fingerprint = "older-scanner";
    });
    seen.marker = "history-later";
    targets = [];
    const recovered = await once();
    assert.equal(recovered.failed, false);
    assert.equal(recovered.state.history_id, "history-later");
    assert.equal(recovered.state.gmail_attachment_backfill.complete, true);
    assert.equal(recovered.state.gmail_attachment_backfill.review?.ingest_removal_plan, undefined);
    assert.deepEqual(seen.rawReads, ["report-one", "report-one"]);
    assert.deepEqual(seen.sent, ["report-one", "report-one"]);
    assert.equal(seen.fullLists + seen.inventories, 0);
  }, { reports: ["report-one"], backfill: null });
});

test("an unfinished dry preview rejects malformed cleanup while a clean preview remains bounded", async () => {
  await fixture(async ({ observations: seen, once, editState, state }) => {
    editState(value => { value.gmail_attachment_backfill.review = { version: 1, done: [], skipped: {} }; });
    const before = state();
    const blocked = await once({ "dry-run": true });
    assert.equal(blocked.failed, true);
    assert.deepEqual(blocked.state, before);
    assert.equal(seen.saves + seen.sent.length + seen.receipts.length + seen.rawReads.length, 0);
    editState(value => { delete value.gmail_attachment_backfill.review; });
    const control = await once({ "dry-run": true });
    assert.equal(control.failed, false);
    assert.deepEqual(seen.rawReads, ["report-one"]);
  }, { cap: 1, backfill: checkpoint() });
});

test("an interruption after empty cleanup readback resumes without a stranded review receipt", async () => {
  await fixture(async ({ observations: seen, once }) => {
    let interrupted = false;
    seen.onSave = state => {
      const review = state.gmail_attachment_backfill?.review;
      if (!interrupted && Object.keys(review?.done || {}).length && !review.ingest_pending_families) {
        interrupted = true;
        throw new Error("synthetic interruption after cleanup readback");
      }
    };
    assert.equal((await once()).failed, true);
    assert.equal(interrupted, true);
    const recovered = await once();
    assert.equal(recovered.failed, false);
    assert.equal(recovered.state.gmail_attachment_backfill.complete, true);
    assert.equal((await once()).failed, false);
    assert.deepEqual(seen.rawReads, ["report-one"]);
    assert.deepEqual(seen.sent, ["report-one"]);
  }, { reports: ["report-one"], backfill: null });
});
