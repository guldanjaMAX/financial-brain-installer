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

// M1 acceptance tests. The candidate pager and checkpoint below are the proposed
// contract in partner-reports/qbo-attach-backfill-design.md. They intentionally
// remain red until the separate backfill is implemented; this file does not add
// a test-only implementation or weaken the ordinary source runner.
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
      return json({ results: docs.map(doc => ({ source_id: doc.source_id, status: "updated", chunks: 1 })) });
    }
    if (parsed.pathname === "/api/admin/brain/documents") return json({ vector_backlog: { pending: 1 } });
    throw new Error("offline fixture refused an unknown route");
  };
  const once = async (flags = {}) => {
    let failed = false;
    try {
      await cmdIngestRemote(manifest, manifestPath, { from: "gmail", source: "gmail", ...flags }, {
        withSourceIngestLock: async (_options, task) => task({ assertOwned() {} }),
        resolveBaseUrl: async () => "https://fixture.invalid",
        resolveAdminKey: () => "synthetic-owner-authority",
        getAccessToken: async () => { throw new Error("provider credential seam must remain unused"); },
        ingestLib: async () => ({ ...ingest,
          loadState: () => structuredClone(persisted),
          saveState: (_path, state) => { observations.saves++; persisted = structuredClone(state); },
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
            const offset = pageToken == null ? 0 : Number(pageToken.replace("candidate-page-", ""));
            assert.ok(Number.isSafeInteger(offset) && offset >= 0, "synthetic page token must be valid");
            const ids = reports.slice(offset, offset + pageSize);
            return { ids, nextPageToken: offset + ids.length < reports.length
              ? `candidate-page-${offset + ids.length}` : null };
          },
          messagePolicy: async () => ({ allowed: true, cursor_blocking: false }),
          toEnvelope: async (_token, id) => {
            observations.rawReads.push(id);
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
          assert.equal(body.action, "preview", "no removal is authorized by this fixture");
          observations.previewFamilies.push(...(body.families || []).map(family => family.base_doc_uid));
          return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" },
            targets: [], documents: 0 };
        },
      });
    } catch { failed = true; }
    // Return only closed evidence. Errors and envelopes are never test output.
    return { failed, state: structuredClone(persisted) };
  };
  try { await run({ observations, once, state: () => structuredClone(persisted) }); }
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

test("M1 red: an extraction upgrade preserves the legacy Gmail membership fingerprint", () => {
  assert.equal(gmailQuery(), gmailQuery({ since: null }), "control: the membership query is unchanged");
  assert.equal(currentPolicy(), legacyPolicy(),
    "an extraction-only upgrade must not select an authoritative membership sweep");
});

test("M1 red: 140000 legacy messages fetch, send and preview only three report candidates", async () => {
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

test("M1 red: a capped backfill resumes pending candidates before requesting another page", async () => {
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
