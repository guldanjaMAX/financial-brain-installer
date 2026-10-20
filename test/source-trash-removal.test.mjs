import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdIngestCalendar, cmdIngestRemote, credentialScannerFingerprint } from "../brain.mjs";
import { gmailPolicyFingerprint } from "../connectors/gmail.mjs";
import { TOKEN_URL, createTokenProvider, syncAll } from "../connectors/google-calendar.mjs";
import { batchStream, prefetch, splitOversized } from "../ingest/run.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

// The packet 10 addendum: an item deleted, trashed or cancelled at the
// source loses its one stored document in the daily run itself. No plan, no
// fingerprint, no review stop. Google and the Worker are in-process doubles;
// every other network attempt fails the test.
globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };

const capture = async (task) => {
  const lines = [];
  const { log, warn } = console;
  const write = process.stdout.write;
  console.log = console.warn = (...args) => lines.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  process.stdout.write = () => true;
  let result;
  let error;
  try { result = await task(); } catch (caught) { error = caught; }
  finally { console.log = log; console.warn = warn; process.stdout.write = write; }
  return { result, error, output: lines.join("\n") };
};

const sandbox = (t, prefix) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const manifest = {
    brain: { domain: "fixture.invalid" },
    safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath };
};

const commonOptions = (store) => ({
  withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
  resolveBaseUrl: async () => "https://fixture.invalid",
  resolveAdminKey: () => "fixture-admin-key",
  removalPlanRequest: store.request,
  removalPlanRuntime: () => "fixture-runtime",
  listStoredSourceFamilies: async ({ source }) => new Set(store.uids().filter((uid) => uid.startsWith(`${source}:`))),
  applyDriveRemovals: async () => { throw new Error("the daily path must not use the legacy forget route"); },
  postSourceReceipt: async () => ({}),
});

/* ------------------------------------------------------------------ Gmail */

const BODY = "This synthetic note from Sender One confirms the planning review for Store North. " +
  "The team agreed the schedule and will report progress at the next weekly meeting.";
const rawMessage = (id) => Buffer.from([
  "From: Sender One <sender.one@example.invalid>",
  "To: Owner <owner@example.invalid>",
  `Subject: Synthetic planning note ${id}`,
  "Date: Tue, 06 Oct 2026 10:00:00 +0000",
  `Message-ID: <${id}@example.invalid>`,
  "Content-Type: text/plain; charset=utf-8",
  "",
  BODY,
  "",
].join("\r\n")).toString("base64url");

function gmailScenario(t, { labels, history }) {
  const { manifest, manifestPath } = sandbox(t, "gmail-trash-");
  const store = ingestPlanStore();
  t.after(() => store.db.close());
  const scanner = credentialScannerFingerprint(true);
  const state = {
    version: 1, done: {}, skipped: {}, history_id: "history-prior",
    credential_scanner_fingerprint: scanner,
    gmail_policy_fingerprint: gmailPolicyFingerprint({ credentialScannerFingerprint: scanner }),
  };
  for (const id of Object.keys(labels)) {
    store.put(`gmail:${id}`);
    state.done[`gmail:${id}`] = `${id}-v1`;
  }
  const sent = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname !== "gmail.googleapis.com") throw new Error(`unexpected network attempt: ${url.hostname}`);
    if (url.pathname.endsWith("/users/me/history")) return Response.json({ history, historyId: "history-next" });
    const id = url.pathname.split("/").at(-1);
    if (!labels[id]) return Response.json({ error: { message: "Not Found" } }, { status: 404 });
    return Response.json({
      id, labelIds: labels[id], internalDate: "1791280800000",
      ...(url.searchParams.get("format") === "raw" ? { raw: rawMessage(id) } : {}),
    });
  };
  t.after(() => { globalThis.fetch = async () => { throw new Error("unexpected network attempt"); }; });
  const options = {
    ...commonOptions(store),
    getAccessToken: async () => "fixture-access-token",
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state, saveState() {} }),
    sendBatches: async ({ groups, onResult }) => {
      const tally = { created: 0 };
      for (const item of groups.flat()) {
        sent.push(item.envelope.source_id);
        store.put(`gmail:${item.envelope.source_id}`, {}, "v2");
        onResult(item, { status: "created", source_id: item.envelope.source_id, chunks: 1 });
        tally.created++;
      }
      return tally;
    },
  };
  const run = () => capture(() => cmdIngestRemote(manifest, manifestPath, { from: "gmail" }, options));
  return { store, state, sent, run };
}

const record = (field, id) => ({ [field]: [{ message: { id } }] });

test("Gmail: a trashed, a spam and a deleted message each lose their document with no review stop", async (t) => {
  const s = gmailScenario(t, {
    labels: {
      "trash-msg": ["TRASH"],
      "spam-msg": ["SPAM"],
      "normal-msg": ["INBOX"],
      "deleted-msg": ["INBOX"],
      "new-msg": ["INBOX"],
    },
    history: [
      record("labelsAdded", "trash-msg"),
      record("labelsAdded", "spam-msg"),
      record("messagesDeleted", "deleted-msg"),
      record("messagesAdded", "new-msg"),
    ],
  });
  // new-msg arrives in this window; it is not stored yet.
  s.store.db.prepare("DELETE FROM documents WHERE doc_uid='gmail:new-msg'").run();
  delete s.state.done["gmail:new-msg"];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:new-msg", "gmail:normal-msg"],
    "trash, spam and deleted messages are removed; the untouched message stays");
  assert.deepEqual(s.sent, ["new-msg"]);
  assert.equal(s.state.ingest_removal_plan, undefined, "no removal plan is saved");
  assert.equal(s.state.history_id, "history-next", "the cursor advances in the same run");
  assert.doesNotMatch(output, /--apply-removals|--approve-removals/);
  assert.equal(s.store.calls.apply, 1, "one preview then apply removes the batch");
  for (const id of ["trash-msg", "spam-msg", "deleted-msg"]) assert.equal(s.state.done[`gmail:${id}`], undefined);
  assert.equal(s.state.done["gmail:normal-msg"], "normal-msg-v1", "the control message is untouched");
});

test("Gmail control: a normal message changing labels is untouched", async (t) => {
  const s = gmailScenario(t, {
    labels: { "normal-msg": ["INBOX", "STARRED"], "other-msg": ["INBOX"] },
    history: [record("labelsAdded", "normal-msg")],
  });
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg", "gmail:other-msg"]);
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.state.history_id, "history-next");
});

/* --------------------------------------------------------------- Calendar */

const EVENT = (id, extra = {}) => ({
  kind: "calendar#event", id, status: "confirmed", summary: `Synthetic review ${id}`,
  updated: "2026-10-01T18:00:00.000Z",
  start: { dateTime: "2026-10-12T09:00:00-07:00", timeZone: "America/Phoenix" },
  end: { dateTime: "2026-10-12T10:00:00-07:00", timeZone: "America/Phoenix" },
  organizer: { email: "organizer@example.invalid", displayName: "Organizer" },
  ...extra,
});

function calendarScenario(t, pages) {
  const { manifest, manifestPath } = sandbox(t, "calendar-trash-");
  const store = ingestPlanStore();
  t.after(() => store.db.close());
  for (const id of ["evt_normal", "evt_cancelled", "evt_deleted"]) store.put(`calendar:gcal:primary:${id}`);
  let state = {};
  const sent = [];
  const calls = [];
  let page = 0;
  const fetchImpl = async (url) => {
    if (String(url).startsWith(TOKEN_URL)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "at-1", expires_in: 3600 }) };
    }
    calls.push(new URL(url).searchParams.get("syncToken"));
    const body = pages[page++];
    if (!body) throw new Error("unscripted calendar request");
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const options = {
    ...commonOptions(store),
    fetchImpl,
    getAccessToken: createTokenProvider({ clientId: "cid", clientSecret: "csec", refreshToken: "rt", fetchImpl }).get,
    loadCalendarState: () => structuredClone(state),
    saveCalendarState: (_path, next) => { state = structuredClone(next); },
    googleCalendar: {
      syncAll,
      ingestEnvelopes: async ({ envelopes }) => {
        for (const envelope of envelopes) {
          sent.push(envelope.source_id);
          store.put(`calendar:${envelope.source_id}`, {}, "v2");
        }
        return { created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length };
      },
    },
  };
  const run = () => capture(() => cmdIngestCalendar(manifest, manifestPath, {}, options));
  return { store, sent, calls, run, state: () => state };
}

test("Calendar: a cancelled and a deleted event each lose their document with no review stop", async (t) => {
  const s = calendarScenario(t, [
    { nextSyncToken: "TOK_1", items: [EVENT("evt_normal"), EVENT("evt_cancelled"), EVENT("evt_deleted")] },
    { nextSyncToken: "TOK_2", items: [
      // A cancelled meeting keeps its details; a deleted one is a bare tombstone.
      EVENT("evt_cancelled", { status: "cancelled" }),
      { kind: "calendar#event", id: "evt_deleted", status: "cancelled" },
      EVENT("evt_new"),
    ] },
  ]);
  const seeded = await s.run();
  assert.equal(seeded.error, undefined, seeded.error?.message);
  assert.equal(s.state().primary.sync_token, "TOK_1");

  const { error, output, result } = await s.run();
  assert.equal(error, undefined, `${error?.message}\n${output.slice(-1500)}`);
  assert.equal(s.calls.at(-1), "TOK_1", "the daily run is incremental");
  assert.deepEqual(s.store.uids(), ["calendar:gcal:primary:evt_new", "calendar:gcal:primary:evt_normal"],
    "the cancelled and the deleted event are removed; the normal event stays");
  assert.equal(result.removed, 2);
  assert.equal(result.removalPending, 0);
  assert.equal(s.state().primary.sync_token, "TOK_2", "the cursor advances in the same run");
  assert.equal(s.state().ingest_removal_plan, undefined, "no removal plan is saved");
  assert.doesNotMatch(output, /--apply-removals|--approve-removals/);
  assert.match(output, /2 cancellation\(s\) removed/);
});

test("Calendar control: a normal event change is untouched", async (t) => {
  const s = calendarScenario(t, [
    { nextSyncToken: "TOK_1", items: [EVENT("evt_normal")] },
    { nextSyncToken: "TOK_2", items: [EVENT("evt_normal", { summary: "Synthetic review moved", updated: "2026-10-02T18:00:00.000Z" })] },
  ]);
  await s.run();
  const { error, result } = await s.run();
  assert.equal(error, undefined, error?.message);
  assert.equal(result.removed, 0);
  assert.equal(s.store.calls.apply, 0);
  assert.deepEqual(s.store.uids(), ["calendar:gcal:primary:evt_cancelled", "calendar:gcal:primary:evt_deleted",
    "calendar:gcal:primary:evt_normal"]);
  assert.equal(s.state().primary.sync_token, "TOK_2");
});
