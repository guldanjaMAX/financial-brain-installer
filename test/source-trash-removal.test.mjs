import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdIngestCalendar, cmdIngestRemote, credentialScannerFingerprint } from "../brain.mjs";
import { gmailLabelDecision, gmailPolicyFingerprint } from "../connectors/gmail.mjs";
import { TOKEN_URL, createTokenProvider, syncAll } from "../connectors/google-calendar.mjs";
import { batchStream, prefetch, splitOversized } from "../ingest/run.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

// The packet 10 addendum and its follow-up: a Gmail message marked as spam,
// and a cancelled or deleted Calendar event, lose their one stored document in
// the daily run itself. No plan, no fingerprint, no review stop. A Gmail
// message moved to Trash, or deleted, keeps its document. A removal that does
// not finish carries the retry code REMOVAL_RETRY_PENDING, never a review
// code. Google and the Worker are in-process doubles; every other network
// attempt fails the test.
globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };

const capture = async (task) => {
  const lines = [];
  const { log, warn } = console;
  const write = process.stdout.write;
  console.log = console.warn = (...args) => lines.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  // Swallow only the run's own carriage-return progress writes, never the
  // node:test reporter's, so node --test names every test in this file.
  process.stdout.write = function progressOnly(chunk, ...rest) {
    if (typeof chunk === "string" && chunk.startsWith("\r")) return true;
    return write.call(this, chunk, ...rest);
  };
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

// `labels[id] === null` is a stored message Gmail answers 404 for (deleted, or
// purged from Trash). `listed` is what a full list returns; its query excludes
// Trash and Spam. `historyExpired` makes Gmail refuse the saved history id.
function gmailScenario(t, { labels, history = [], listed = [], historyExpired = false }) {
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
  // A --reset run starts from a fresh state object; the next run loads it.
  let current = state;
  const sent = [];
  const receipts = [];
  const removal = { fail: false };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname !== "gmail.googleapis.com") throw new Error(`unexpected network attempt: ${url.hostname}`);
    if (url.pathname.endsWith("/users/me/history")) {
      if (historyExpired) return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
      return Response.json({ history, historyId: "history-next" });
    }
    if (url.pathname.endsWith("/users/me/profile")) return Response.json({ historyId: "history-sweep" });
    if (url.pathname.endsWith("/users/me/messages")) return Response.json({ messages: listed.map((id) => ({ id })) });
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
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return {}; },
    removalPlanRequest: async (input) => {
      if (removal.fail && input.body.action === "apply") {
        throw new Error("Authenticated removal request failed. HTTP 503. Some approved removals may have completed. " +
          "The source cursor was not advanced. Review a fresh removal plan before applying it.");
      }
      return store.request(input);
    },
    getAccessToken: async () => "fixture-access-token",
    ingestLib: async () => ({
      batchStream, splitOversized, prefetch, loadState: () => current, saveState: (_path, next) => { current = next; },
    }),
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
  const run = (flags = {}) => capture(() => cmdIngestRemote(manifest, manifestPath, { from: "gmail", ...flags }, options));
  return { store, state, current: () => current, sent, receipts, removal, run };
}

const record = (field, id) => ({ [field]: [{ message: { id } }] });

test("Gmail: a spam message loses its document; a trashed and a deleted message keep theirs, with no review stop", async (t) => {
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
  assert.deepEqual(s.store.uids(), ["gmail:deleted-msg", "gmail:new-msg", "gmail:normal-msg", "gmail:trash-msg"],
    "only the spam message is removed; trashed, deleted and untouched messages stay");
  assert.deepEqual(s.sent, ["new-msg"]);
  assert.equal(s.state.ingest_removal_plan, undefined, "no removal plan is saved");
  assert.equal(s.state.history_id, "history-next", "the cursor advances in the same run");
  assert.doesNotMatch(output, /--apply-removals|--approve-removals/);
  assert.equal(s.store.calls.apply, 1, "one preview then apply removes the spam message");
  assert.equal(s.state.done["gmail:spam-msg"], undefined);
  assert.equal(s.state.done["gmail:trash-msg"], "trash-msg-v1", "the trashed message keeps its document");
  assert.equal(s.state.done["gmail:deleted-msg"], "deleted-msg-v1", "the deleted message keeps its document");
  assert.match(output, /2 Gmail message\(s\) moved to Trash or deleted at the source; any stored document is kept/);
  assert.match(output, /removed 1 stored Gmail document\(s\) for 1 spam message\(s\)/);
  assert.equal(s.receipts.at(-1).status, "ready");
  assert.equal(s.state.done["gmail:normal-msg"], "normal-msg-v1", "the control message is untouched");
});

test("Gmail: Spam and Trash win over a category label carried with them", async (t) => {
  assert.equal(gmailLabelDecision(["CATEGORY_PROMOTIONS", "SPAM"]).spam, true);
  assert.equal(gmailLabelDecision(["CATEGORY_SOCIAL", "TRASH"]).trashed, true);
  assert.equal(gmailLabelDecision(["CATEGORY_SOCIAL", "TRASH"]).spam, false);
  assert.equal(gmailLabelDecision(["CATEGORY_FORUMS"]).trashed || gmailLabelDecision(["CATEGORY_FORUMS"]).spam, false,
    "a category label alone is still a policy exclusion");
  const s = gmailScenario(t, {
    labels: {
      "spam-category": ["CATEGORY_PROMOTIONS", "SPAM"],
      "trash-category": ["CATEGORY_SOCIAL", "TRASH"],
      "normal-msg": ["INBOX"],
    },
    history: [record("labelsAdded", "spam-category"), record("labelsAdded", "trash-category")],
  });
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg", "gmail:trash-category"],
    "spam with a category is removed at once; trash with a category is kept");
  assert.equal(s.state.ingest_removal_plan, undefined, "neither stops for a review");
  assert.doesNotMatch(output, /--apply-removals|--approve-removals/);
  assert.equal(s.state.history_id, "history-next");
});

test("Gmail: a spam removal that fails stays pending with the retry code and holds the cursor", async (t) => {
  const s = gmailScenario(t, {
    labels: { "spam-msg": ["SPAM"], "normal-msg": ["INBOX"] },
    history: [record("labelsAdded", "spam-msg")],
  });
  s.removal.fail = true;
  const failed = await s.run();
  assert.equal(failed.error?.code, "REMOVAL_RETRY_PENDING", failed.error?.message);
  assert.doesNotMatch(failed.error.message, /review/i);
  assert.match(failed.error.message, /HTTP 503/);
  assert.equal(s.receipts.at(-1).status, "error");
  assert.equal(s.receipts.at(-1).issue_code, "REMOVAL_RETRY_PENDING");
  assert.equal(s.state.history_id, "history-prior", "the cursor is held");
  assert.ok(s.store.uids().includes("gmail:spam-msg"), "the spam message is still stored, pending");
  assert.equal(s.state.ingest_removal_plan, undefined, "no review plan is saved");

  s.removal.fail = false;
  const retried = await s.run();
  assert.equal(retried.error, undefined, retried.error?.message);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg"], "the next run retries and removes it");
  assert.equal(s.state.history_id, "history-next");
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

// A full list (--reset, an expired history id, a changed scanner or policy)
// cannot see Trash or Spam: its query excludes both. A stored message missing
// from it is classified the way the daily run would classify it.
const FULL_SWEEP_TRIGGERS = [
  { name: "--reset", flags: { reset: true } },
  { name: "an expired history id", historyExpired: true },
  {
    name: "a credential scanner change",
    setup: (state) => {
      state.credential_scanner_fingerprint = "an-older-scanner-fingerprint";
      state.gmail_policy_fingerprint = "an-older-policy-fingerprint";
    },
  },
];

for (const trigger of FULL_SWEEP_TRIGGERS) {
  test(`Gmail full sweep after ${trigger.name}: a trashed and a deleted message are kept, spam is removed, no review stop on two runs`, async (t) => {
    const s = gmailScenario(t, {
      labels: { "trash-msg": ["TRASH"], "deleted-msg": null, "spam-msg": ["SPAM"], "normal-msg": ["INBOX"] },
      listed: ["normal-msg"],
      historyExpired: trigger.historyExpired === true,
    });
    trigger.setup?.(s.state);

    const first = await s.run(trigger.flags);
    assert.equal(first.error, undefined, `${first.error?.name}: ${first.error?.message}\n${first.output.slice(-1500)}`);
    assert.deepEqual(s.store.uids(), ["gmail:deleted-msg", "gmail:normal-msg", "gmail:trash-msg"],
      "only the spam message is removed; the trashed and the deleted message stay findable");
    assert.match(first.output, /2 Gmail message\(s\) moved to Trash or deleted at the source; any stored document is kept/);
    assert.match(first.output, /removed 1 stored Gmail document\(s\) for 1 spam message\(s\)/);
    assert.doesNotMatch(first.output, /--apply-removals|--approve-removals/);
    assert.equal(s.current().ingest_removal_plan, undefined, "no removal plan is saved");
    assert.equal(s.current().history_id, "history-sweep", "the cursor advances");
    assert.equal(s.receipts.at(-1).status, "ready");

    const second = await s.run();
    assert.equal(second.error, undefined, `${second.error?.name}: ${second.error?.message}\n${second.output.slice(-1500)}`);
    assert.deepEqual(s.store.uids(), ["gmail:deleted-msg", "gmail:normal-msg", "gmail:trash-msg"]);
    assert.doesNotMatch(second.output, /--apply-removals|--approve-removals/);
    assert.equal(s.current().ingest_removal_plan, undefined);
    assert.equal(s.current().history_id, trigger.historyExpired ? "history-sweep" : "history-next",
      "the next run advances the cursor too");
    assert.equal(s.receipts.at(-1).status, "ready");
  });
}

test("Gmail full sweep control: a stored message that left the list for another reason still stops for review", async (t) => {
  const s = gmailScenario(t, {
    labels: { "promo-msg": ["CATEGORY_PROMOTIONS"], "normal-msg": ["INBOX"] },
    listed: ["normal-msg"],
  });
  const { error } = await s.run({ reset: true });
  assert.equal(error?.name, "DriveRemovalReviewRequired", error?.message);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg", "gmail:promo-msg"], "nothing is removed without the review");
});

// A legacy pending-removal marker (state.removed) was written only by the older
// forget route when a request failed in transit. A current decision about the
// message settles it, on the daily run and on a full sweep alike.
const LEGACY_MARKER = "2026-09-04T00:00:00.000Z";

test("Gmail full sweep: a trashed message carrying a legacy pending-removal marker is kept, the marker is cleared and the cursor advances", async (t) => {
  const s = gmailScenario(t, {
    labels: { "trash-msg": ["TRASH"], "normal-msg": ["INBOX"] },
    listed: ["normal-msg"],
  });
  s.state.removed = { "gmail:trash-msg": LEGACY_MARKER };
  const { error, output } = await s.run({ reset: true });
  assert.equal(error, undefined, `${error?.name}: ${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg", "gmail:trash-msg"], "the trashed message keeps its document");
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.current().removed?.["gmail:trash-msg"], undefined, "the marker is cleared");
  assert.equal(s.current().ingest_removal_plan, undefined, "no review stop");
  assert.doesNotMatch(output, /--apply-removals|--approve-removals|partial coverage/);
  assert.equal(s.current().history_id, "history-sweep", "the cursor advances");
  assert.equal(s.receipts.at(-1).status, "ready");
});

test("Gmail full sweep: a spam message carrying a legacy marker is removed at once and the marker is cleared", async (t) => {
  const s = gmailScenario(t, {
    labels: { "spam-msg": ["SPAM"], "normal-msg": ["INBOX"] },
    listed: ["normal-msg"],
  });
  s.state.removed = { "gmail:spam-msg": LEGACY_MARKER };
  const { error, output } = await s.run({ reset: true });
  assert.equal(error, undefined, `${error?.name}: ${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg"], "the spam message is removed; the normal message stays");
  assert.match(output, /removed 1 stored Gmail document\(s\) for 1 spam message\(s\)/);
  assert.equal(s.current().removed?.["gmail:spam-msg"], undefined, "the marker is cleared");
  assert.equal(s.current().ingest_removal_plan, undefined, "no review stop");
  assert.equal(s.current().history_id, "history-sweep", "the cursor advances");
  assert.equal(s.receipts.at(-1).status, "ready");
});

test("Gmail full sweep control: a category message carrying a legacy marker still stops for review", async (t) => {
  const s = gmailScenario(t, {
    labels: { "promo-msg": ["CATEGORY_PROMOTIONS"], "normal-msg": ["INBOX"] },
    listed: ["normal-msg"],
  });
  s.state.removed = { "gmail:promo-msg": LEGACY_MARKER };
  const { error } = await s.run({ reset: true });
  assert.equal(error?.name, "DriveRemovalReviewRequired", error?.message);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg", "gmail:promo-msg"], "nothing is removed without the review");
  assert.equal(s.current().removed?.["gmail:promo-msg"], LEGACY_MARKER, "its marker stays for the review");
});

test("Gmail daily run: a trashed message carrying a legacy pending-removal marker is kept, the marker is cleared and the cursor advances", async (t) => {
  const s = gmailScenario(t, {
    labels: { "trash-msg": ["TRASH"], "normal-msg": ["INBOX", "STARRED"] },
    history: [record("labelsAdded", "trash-msg"), record("labelsAdded", "normal-msg")],
  });
  s.state.removed = { "gmail:trash-msg": LEGACY_MARKER };
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.name}: ${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg", "gmail:trash-msg"], "nothing is removed");
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.state.done["gmail:trash-msg"], "trash-msg-v1", "the trashed message keeps its document");
  assert.equal(s.state.removed?.["gmail:trash-msg"], undefined, "the marker is cleared");
  assert.doesNotMatch(output, /partial coverage|unresolved pending removals|--apply-removals|--approve-removals/);
  assert.equal(s.state.history_id, "history-next", "the cursor advances");
  assert.equal(s.receipts.at(-1).status, "ready");
  assert.equal(s.state.removed?.["gmail:normal-msg"], undefined, "the control message carries no marker");
  assert.ok(s.store.uids().includes("gmail:normal-msg"), "the control message is untouched");
});

test("Gmail daily run: a spam message carrying a legacy marker is removed at once and the marker is cleared", async (t) => {
  const s = gmailScenario(t, {
    labels: { "spam-msg": ["SPAM"], "normal-msg": ["INBOX", "STARRED"] },
    history: [record("labelsAdded", "spam-msg"), record("labelsAdded", "normal-msg")],
  });
  s.state.removed = { "gmail:spam-msg": LEGACY_MARKER };
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.name}: ${error?.message}\n${output.slice(-1500)}`);
  assert.deepEqual(s.store.uids(), ["gmail:normal-msg"], "the spam message is removed; the control message stays");
  assert.equal(s.store.calls.apply, 1, "one preview then apply, through the spam route");
  assert.match(output, /removed 1 stored Gmail document\(s\) for 1 spam message\(s\)/);
  assert.equal(s.state.done["gmail:spam-msg"], undefined);
  assert.equal(s.state.removed?.["gmail:spam-msg"], undefined, "the marker is cleared");
  assert.equal(s.state.ingest_removal_plan, undefined, "no review stop");
  assert.equal(s.state.history_id, "history-next", "the cursor advances");
  assert.equal(s.receipts.at(-1).status, "ready");
});

// An account switch: the saved history id means nothing to the new mailbox,
// so the run is a full sweep, and every stored message answers 404.
test("Gmail full sweep where every stored message answers 404: a loud account warning on the terminal and in the receipt; the corpus is kept and the cursor advances", async (t) => {
  const s = gmailScenario(t, {
    labels: { "old-msg-1": null, "old-msg-2": null, "old-msg-3": null, "other-msg": ["INBOX"] },
    listed: ["other-msg"],
    historyExpired: true,
  });
  // other-msg belongs to the newly connected mailbox; it is not stored yet.
  s.store.db.prepare("DELETE FROM documents WHERE doc_uid='gmail:other-msg'").run();
  delete s.state.done["gmail:other-msg"];
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.name}: ${error?.message}\n${output.slice(-1500)}`);
  assert.match(output,
    /warn\s+None of the 3 stored messages exist in this mailbox\. Did you connect a different Google account\?/);
  assert.deepEqual(s.store.uids(), ["gmail:old-msg-1", "gmail:old-msg-2", "gmail:old-msg-3", "gmail:other-msg"],
    "the stored corpus is kept");
  assert.equal(s.store.calls.apply, 0);
  assert.equal(s.current().ingest_removal_plan, undefined, "a warning, not a stop");
  assert.equal(s.current().history_id, "history-sweep", "the cursor advances");
  const receipt = s.receipts.at(-1);
  assert.equal(receipt.status, "ready");
  assert.match(receipt.detail, /; warning=GMAIL_ACCOUNT_MISMATCH_SUSPECTED; stored_not_found=3$/);
});

test("Gmail full sweep control: one deleted message among stored mail that still exists raises no account warning", async (t) => {
  const s = gmailScenario(t, {
    labels: { "deleted-msg": null, "normal-msg": ["INBOX"] },
    listed: ["normal-msg"],
    historyExpired: true,
  });
  const { error, output } = await s.run();
  assert.equal(error, undefined, `${error?.name}: ${error?.message}\n${output.slice(-1500)}`);
  assert.doesNotMatch(output, /different Google account/);
  assert.doesNotMatch(s.receipts.at(-1).detail, /warning=/);
  assert.equal(s.receipts.at(-1).status, "ready");
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
  const receipts = [];
  const removal = { fail: false };
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
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return {}; },
    removalPlanRequest: async (input) => {
      if (removal.fail && input.body.action === "apply") {
        throw new Error("Authenticated removal request failed. HTTP 503. Some approved removals may have completed. " +
          "The source cursor was not advanced. Review a fresh removal plan before applying it.");
      }
      return store.request(input);
    },
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
  return { store, sent, calls, receipts, removal, run, state: () => state };
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

test("Calendar: a cancellation removal that fails stays pending with the retry code, not a review code", async (t) => {
  const s = calendarScenario(t, [
    { nextSyncToken: "TOK_1", items: [EVENT("evt_normal"), EVENT("evt_cancelled")] },
    { nextSyncToken: "TOK_2", items: [EVENT("evt_cancelled", { status: "cancelled" })] },
    { nextSyncToken: "TOK_2", items: [EVENT("evt_cancelled", { status: "cancelled" })] },
  ]);
  await s.run();
  s.removal.fail = true;
  const failed = await s.run();
  assert.equal(failed.error?.code, "REMOVAL_RETRY_PENDING", failed.error?.message);
  assert.doesNotMatch(failed.error.message, /review/i);
  assert.equal(s.receipts.at(-1).status, "error");
  assert.equal(s.receipts.at(-1).issue_code, "REMOVAL_RETRY_PENDING");
  assert.equal(s.state().primary.sync_token, "TOK_1", "the cursor is held");
  assert.ok(s.store.uids().includes("calendar:gcal:primary:evt_cancelled"));

  s.removal.fail = false;
  const retried = await s.run();
  assert.equal(retried.error, undefined, retried.error?.message);
  assert.equal(s.calls.at(-1), "TOK_1", "the retry replays the same window");
  assert.equal(retried.result.removed, 1);
  assert.equal(s.store.uids().includes("calendar:gcal:primary:evt_cancelled"), false);
  assert.equal(s.state().primary.sync_token, "TOK_2");
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
