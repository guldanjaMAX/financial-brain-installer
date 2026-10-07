import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { runProviderConnector } from "../connectors/provider-runtime.mjs";
import { cmdIngestProvider } from "../brain.mjs";
import { normalizeMailStartAt } from "../connectors/microsoft-mail-transition.mjs";

const START = "2026-10-01T07:00:00.000Z";
const token = randomBytes(24).toString("hex");
const message = (id, time) => ({ id, receivedDateTime: time, body: { content: "Synthetic mail body." } });
const boundaryMail = [
  message("old", "2026-09-30T12:00:00Z"),
  message("last-exported", "2026-10-01T06:59:59.9999999Z"),
  message("first-new", START),
  message("fraction", "2026-10-01T07:00:00.0000001Z"),
  message("later", "2026-10-02T07:00:00Z"),
];
const ids = (result) => result.documents.map((doc) => doc.source_id);

async function collect({ value = boundaryMail, cursor = null, start = START, pages = false } = {}) {
  const reads = [];
  const result = await syncMicrosoftGraph({
    accessToken: token, mailStartAt: start, cursor,
    includeCalendar: false, includePersonalDrive: false,
    fetchImpl: async (url) => {
      reads.push(String(url));
      return new Response(JSON.stringify({
        value: pages && reads.length === 1 ? value.slice(0, 2) : pages ? value.slice(2) : value,
        ...(pages && reads.length === 1
          ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/fixture-next" }
          : { "@odata.deltaLink": "https://graph.microsoft.com/v1.0/fixture-delta" }),
      }), { headers: { "content-type": "application/json" } });
    },
  });
  return { result, reads };
}

test("mail cutover excludes the entire exported local day and includes the exact next midnight", async () => {
  const control = await collect({ start: null });
  assert.equal(control.reads.length, 1);
  assert.equal(control.result.documents.length, 5);
  const { result, reads } = await collect({ pages: true });
  assert.equal(reads.length, 2, "both real adapter pages reached the boundary decision");
  assert.deepEqual(ids(result), ["outlook:message:first-new", "outlook:message:fraction", "outlook:message:later"]);
  assert.equal(result.cursor_can_advance, true);
  assert.equal(result.mail_transition.excluded_messages, 2);
});

test("saved delta still filters old mail moved into a selected folder", async () => {
  const baseline = await collect();
  const { result, reads } = await collect({ cursor: baseline.result.proposed_cursor });
  assert.equal(reads[0], "https://graph.microsoft.com/v1.0/fixture-delta");
  assert.deepEqual(ids(result), ["outlook:message:first-new", "outlook:message:fraction", "outlook:message:later"]);
  assert.equal(result.cursor_can_advance, true);
});

test("offset timestamps compare as instants and the selected window walks more than 5000 messages", async () => {
  const value = [
    message("before-offset", "2026-09-30T23:59:59.9999999-07:00"),
    message("at-offset", "2026-10-01T00:00:00-07:00"),
    ...Array.from({ length: 5001 }, (_, i) => message(`bulk-${i}`, "2026-10-02T07:00:00Z")),
  ];
  const { result, reads } = await collect({ value, pages: true });
  assert.equal(reads.length, 2);
  assert.equal(result.documents.length, 5002);
  assert.equal(result.mail_transition.excluded_messages, 1);
  assert.equal(ids(result)[0], "outlook:message:at-offset");
  assert.equal(new URL(reads[0]).searchParams.has("$filter"), false,
    "filtered Graph deltas have a bounded result set and cannot prove complete backfill");
  assert.equal(result.cursor_can_advance, true);
});

test("unidentifiable new mail withholds the window while an identified message succeeds", async () => {
  const good = await collect({ value: [message("identified", START)] });
  assert.equal(good.result.documents.length, 1);
  let reads = 0;
  await assert.rejects(syncMicrosoftGraph({
    accessToken: token, mailStartAt: START, includeCalendar: false, includePersonalDrive: false,
    fetchImpl: async () => {
      reads++;
      return new Response(JSON.stringify({ value: [message(undefined, START)], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/fixture-delta" }));
    },
  }), /immutable message identity/);
  assert.equal(reads, 1, "the nonempty candidate window reached the adapter");
});

test("cutover retains historical citations through real delivery, tombstones, and a reset", async () => {
  const original = { uid: "exported-mail:digest", content: "Synthetic historical digest.", citation: "fixture://digest" };
  const stored = new Map([[original.uid, original], ["microsoft:outlook:message:missing", { content: "Retained mail." }]]);
  const before = structuredClone([...stored]);
  let deletions = 0;
  let sent = 0;
  let saved = 0;
  const { result, reads } = await collect({ value: [...boundaryMail, { id: "missing", "@removed": { reason: "deleted" } }] });
  assert.equal(reads.length, 1);
  const run = await runProviderConnector({
    provider: "microsoft", source: "microsoft", reset: true,
    sync: async () => result, resolveAccess: async () => ({ accessToken: token }),
    loadState: () => ({}), saveState: () => { saved++; },
    postReceipt: async () => {}, now: () => new Date("2026-10-07T12:00:00Z"),
    listStoredFamilies: async () => new Set([...stored.keys()].filter((key) => key.startsWith("microsoft:"))),
    sendBatch: async ({ docs }) => {
      sent += docs.length;
      for (const doc of docs) stored.set(`microsoft:${doc.source_id}`, doc);
      return { results: docs.map((doc) => ({ source_id: doc.source_id, status: "created" })) };
    },
    removeDocuments: async () => { deletions++; return { applied: 1, pending: 0 }; },
  });
  assert.equal(sent, 3, "new mail actually reached the writer");
  assert.equal(deletions, 0);
  assert.deepEqual([...stored].slice(0, 2), before);
  assert.equal(stored.get(original.uid).citation, original.citation);
  assert.equal(saved, 1);
  assert.equal(run.mail_transition.retained_tombstones, 1);
  const control = await collect({ start: null, value: [{ id: "missing", "@removed": {} }] });
  assert.equal(control.reads.length, 1);
  assert.equal(control.result.deletions.length, 1, "ordinary unbounded connector retains its deletion behavior");
});

test("missing or malformed message dates stop before delivery or cursor promotion", async () => {
  const control = await collect();
  assert.equal(control.result.cursor_can_advance, true);
  for (const time of [undefined, "invalid", "2026-02-30T12:00:00Z", "2026-10-01"]) {
    let reads = 0;
    await assert.rejects(syncMicrosoftGraph({
      accessToken: token, mailStartAt: START, includeCalendar: false, includePersonalDrive: false,
      fetchImpl: async () => {
        reads++;
        return new Response(JSON.stringify({ value: [message("undated", time)], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/fixture-delta" }));
      },
    }), /receivedDateTime/);
    assert.equal(reads, 1, "malformed record reached the real adapter decision");
  }
});

test("manifest cutoff reaches the real ingest adapter boundary and invalid settings stop before credentials", async () => {
  let accessCalls = 0;
  const seen = [];
  const options = {
    oauth: {
      loadProviderSyncState: () => ({}),
      providerAccessToken: async () => { accessCalls++; return { accessToken: token }; },
    },
    sync: async (args) => { seen.push(args); return { documents: [], deletions: [], warnings: [] }; },
  };
  const manifest = { corpora: { microsoft: { enabled: true, mail_start_at: START } } };
  await cmdIngestProvider(manifest, "unused-fixture", { from: "microsoft", "dry-run": true }, options);
  assert.equal(seen.length, 1, "real command invoked injected adapter");
  assert.equal(seen[0].mailStartAt, START);
  assert.equal(accessCalls, 1);
  for (const value of ["", "2026-10-01", "2026-02-30T00:00:00.000Z", false, " 2026-10-01T00:00:00.000Z"]) {
    assert.throws(() => normalizeMailStartAt(value), /mail_start_at/);
    const bad = { corpora: { microsoft: { enabled: true, mail_start_at: value } } };
    await assert.rejects(cmdIngestProvider(bad, "unused-fixture", { from: "microsoft", "dry-run": true }, options), /mail_start_at/);
  }
  assert.equal(accessCalls, 1, "invalid configured values never reached credentials after the green control");
  assert.equal(seen.length, 1);
});
