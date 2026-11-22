// WP-04: the calendar connector, actually wired to a runnable command.
//
// connectors/google-calendar.mjs was fully built and covered by 223 tests
// of its own internal functions (test/google-calendar.test.mjs), but a
// repo-wide search turned up nothing anywhere that ever called syncAll() or
// ingestEnvelopes() outside that connector's own test file. `brain connect
// google --scopes calendar` could request the OAuth scope; nothing could
// then actually run a sync. The source matrix's "designed, not written" was
// ALSO wrong, just in the opposite direction from what it looked like.
//
// This file proves the new `brain ingest <manifest> --from calendar`
// command (cmdIngestCalendar in brain.mjs) actually drives the real,
// existing connector correctly: a real syncAll() run against a scripted
// fake Google API, real state persistence to disk, real incremental resume
// on a second call, and correct forwarding of upserts and cancellations.
// Only the outside world this session cannot reach live (Cloudflare account
// resolution, the admin key, and the brain's own /api/admin/brain/ingest
// endpoint) is faked; every calendar-side function is the genuine one.

import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TOKEN_URL,
  createTokenProvider,
  syncAll,
} from "../connectors/google-calendar.mjs";
import assert from "node:assert/strict";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { cmdIngestCalendar } from "../brain.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ------------------------------------------------------------ fake google */
// Same scripted-transport shape as test/google-calendar.test.mjs, kept
// self-contained here rather than shared, matching this repo's convention.

function mkRes({ status = 200, body = {} }) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
function fakeGoogle({ token = { status: 200, body: { access_token: "at-1", expires_in: 3600 } }, calendar = [] } = {}) {
  const calls = { token: [], calendar: [] };
  let ti = 0, ci = 0;
  const impl = async (url, init = {}) => {
    if (String(url).startsWith(TOKEN_URL)) {
      calls.token.push(Object.fromEntries(new URLSearchParams(init.body || "")));
      const script = Array.isArray(token) ? token[Math.min(ti, token.length - 1)] : token;
      ti++;
      return mkRes(script);
    }
    const u = new URL(url);
    calls.calendar.push({ path: u.pathname, params: u.searchParams });
    const next = calendar[ci];
    ci++;
    if (!next) throw new Error(`unscripted calendar request #${ci}: ${url}`);
    return mkRes(next);
  };
  impl.calls = calls;
  return impl;
}
const provider = (impl) => createTokenProvider({ clientId: "cid", clientSecret: "csec", refreshToken: "rt", fetchImpl: impl });

const EVENT_KICKOFF = {
  kind: "calendar#event", id: "evt_kickoff_001", status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=ZXZ0X2tpY2tvZmY",
  summary: "Synthetic project kickoff", updated: "2026-06-10T18:22:41.512Z",
  start: { dateTime: "2026-06-12T09:00:00-07:00", timeZone: "America/Phoenix" },
  end: { dateTime: "2026-06-12T10:30:00-07:00", timeZone: "America/Phoenix" },
  organizer: { email: "organizer@example.invalid", displayName: "Organizer" },
  attendees: [
    { email: "organizer@example.invalid", displayName: "Organizer", responseStatus: "accepted" },
    { email: "owner@example.invalid", displayName: "Owner", self: true, responseStatus: "accepted" },
  ],
  iCalUID: "evt_kickoff_001@google.com",
};
const EVENT_CANCELLED = { kind: "calendar#event", id: "evt_old_002", status: "cancelled" };

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-calendar-ingest-")));
const manifestPath = join(sandbox, "brain.manifest.json");
writeFileSync(manifestPath, "{}\n", { mode: 0o600 });

const fakeReceipts = [];
const fakeRemovals = [];
const fakeCancellations = [];
const store = ingestPlanStore();
const seededSources = new Set();
const commonOptions = () => ({
  markCalendarCancellations: async ({ source, cancellations }) => {
    fakeCancellations.push(...cancellations.map(item => `${source}:${item.source_id}`));
    return cancellations.length;
  },
  removalPlanRuntime: () => "fixture-runtime",
  listStoredSourceFamilies: async ({ source }) => {
    if (!seededSources.has(source)) {
      seededSources.add(source);
      store.put(`${source}:gcal:primary:evt_old_002`);
      for (let index = 0; index < 20; index++) store.put(`${source}:neighbor${index}`);
    }
    return new Set(store.uids().filter((uid) => uid.startsWith(`${source}:`)));
  },
  removalPlanRequest: async (input) => {
    if (input.body.action === "apply") fakeRemovals.push(input.body.targets);
    return store.request(input);
  },
  sourceIngestLockOptions: { home: sandbox },
  resolveAccount: async () => ({ id: "fixture-account" }),
  resolveBaseUrl: async () => "https://fixture.invalid",
  resolveAdminKey: () => "fixture-admin-key",
  postSourceReceipt: async (base, adminKey, receipt) => { fakeReceipts.push({ base, adminKey, receipt }); },
  applyDriveRemovals: async ({ uids }) => { fakeRemovals.push(uids); return { applied: uids.length, pending: 0 }; },
});


try {
  /* ---- dry run: computes and previews, sends and saves NOTHING ---- */
  {
    const impl = fakeGoogle({ calendar: [{ status: 200, body: { nextSyncToken: "TOK_1", items: [EVENT_KICKOFF] } }] });
    let ingestCalls = 0;
    const result = await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, manifestPath, { "dry-run": true },
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: { syncAll, ingestEnvelopes: async () => { ingestCalls++; return {}; } },
      },
    );
    check("dry run computes the real event as something that would upsert",
      result.documents.length === 1 && result.documents[0].title.includes("Synthetic project kickoff"),
      JSON.stringify(result.documents.map((d) => d.title)));
    check("dry run returns the common preview receipt",
      result.dry_run === true && result.would_send === 1, JSON.stringify(result));
    check("dry run sends nothing", ingestCalls === 0);
    check("dry run posts no source receipt", fakeReceipts.length === 0);
    check("dry run writes no state file", !(await import("node:fs")).existsSync(join(sandbox, ".brain-ingest-calendar.json")));
  }

  fakeReceipts.length = 0;
  fakeRemovals.length = 0;

  /* ---- a real run: one upsert, one cancellation, state persisted ---- */
  let savedSyncToken = null;
  {
    const impl = fakeGoogle({
      calendar: [
        { status: 200, body: { nextSyncToken: "TOK_1", items: [EVENT_KICKOFF, EVENT_CANCELLED] } },
        { status: 200, body: { nextSyncToken: "TOK_1", items: [] } },
      ],
    });
    const sentEnvelopes = [];
    const result = await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, manifestPath, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async ({ envelopes }) => {
            sentEnvelopes.push(...envelopes);
            return { created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length };
          },
        },
      },
    );
    check("the real event was sent for upsert", sentEnvelopes.length === 1 && sentEnvelopes[0].source_id.includes("evt_kickoff_001"),
      JSON.stringify(sentEnvelopes.map((e) => e.source_id)));
    check("the sent event uses the receipt source namespace",
      sentEnvelopes[0]?.source_type === "calendar", sentEnvelopes[0]?.source_type);
    check("the sent event keeps its explicit date provenance",
      sentEnvelopes[0]?.date_source === "calendar:event_start" && sentEnvelopes[0]?.date_reliable === true,
      JSON.stringify({ date_source: sentEnvelopes[0]?.date_source, date_reliable: sentEnvelopes[0]?.date_reliable }));
    check("the sent event keeps its canonical citation link",
      sentEnvelopes[0]?.uri === EVENT_KICKOFF.htmlLink, sentEnvelopes[0]?.uri);
    check("the cancelled event was kept and marked, with no removal apply",
      fakeRemovals.length === 0 && fakeCancellations.includes("calendar:gcal:primary:evt_old_002"),
      JSON.stringify(fakeCancellations));
    check("the run posts indexing and ready receipts without a review stop",
      fakeReceipts.length === 2 && fakeReceipts[1].receipt.status === "ready",
      JSON.stringify(fakeReceipts.map(r => r.receipt.status)));
    check("the receipt reports accepted additions and retained cancellations",
      fakeReceipts[1].receipt.docs_added === 1 && /1 cancellation\(s\) kept and marked/.test(fakeReceipts[1].receipt.detail),
      JSON.stringify(fakeReceipts[1].receipt));
    check("accepted cancellation marking permits full traversal proof without removal",
      fakeReceipts[1].receipt.walk_complete === true &&
      fakeReceipts[1].receipt.complete_sweep === true &&
      fakeReceipts[1].receipt.files_seen === 2 &&
      fakeReceipts[1].receipt.docs_refused === 0 &&
      fakeReceipts[1].receipt.docs_failed === 0 && fakeRemovals.length === 0,
      JSON.stringify(fakeReceipts[1].receipt));
    check("cmdIngestCalendar returns a real result object, not undefined",
      result && result.result && result.sent && typeof result.removed === "number");

    const statePath = join(sandbox, ".brain-ingest-calendar.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    check("the sync token was actually persisted to disk",
      saved?.primary?.sync_token === "TOK_1", JSON.stringify(saved));
    savedSyncToken = saved?.primary?.sync_token;
  }

  fakeReceipts.length = 0;
  fakeRemovals.length = 0;

  /* ---- resume: the SECOND call must load the saved state and go incremental ---- */
  {
    check("precondition: the first run's token was saved", savedSyncToken === "TOK_1", savedSyncToken);
    const impl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_2", items: [] } }],
    });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, manifestPath, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: { syncAll, ingestEnvelopes: async () => ({ created: 0, updated: 0, unchanged: 0, refused: [], errors: [], total: 0 }) },
      },
    );
    check("the resumed run sent the saved syncToken back to Google (incremental, not a full resync)",
      impl.calls.calendar[0]?.params.get("syncToken") === "TOK_1",
      JSON.stringify(impl.calls.calendar[0]?.params?.toString()));

    const statePath = join(sandbox, ".brain-ingest-calendar.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    check("the new token replaces the old one", saved?.primary?.sync_token === "TOK_2", JSON.stringify(saved));
    check("an incremental Calendar walk is successful without restating a full history sweep",
      fakeReceipts.at(-1)?.receipt.walk_complete === true &&
      fakeReceipts.at(-1)?.receipt.complete_sweep === false &&
      !("confirmed_range" in fakeReceipts.at(-1).receipt),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
  }

  fakeReceipts.length = 0;

  /* ---- a custom source controls rows, removals, state, and receipts ---- */
  {
    const customManifest = join(sandbox, "custom-source.manifest.json");
    writeFileSync(customManifest, "{}\n", { mode: 0o600 });
    const impl = fakeGoogle({
      calendar: [
        { status: 200, body: { nextSyncToken: "TOK_CUSTOM", items: [EVENT_KICKOFF, EVENT_CANCELLED] } },
        { status: 200, body: { nextSyncToken: "TOK_CUSTOM", items: [] } },
      ],
    });
    const sentEnvelopes = [];
    const removalsBefore = fakeRemovals.length;
    const receiptsBefore = fakeReceipts.length;
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, customManifest, { source: "client-calendar" },
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async ({ envelopes }) => {
            sentEnvelopes.push(...envelopes);
            return { created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length };
          },
        },
      },
    );
    check("a custom Calendar source names the stored rows",
      sentEnvelopes[0]?.source_type === "client-calendar", sentEnvelopes[0]?.source_type);
    check("a custom Calendar source names retained cancellation targets",
      fakeRemovals.length === removalsBefore && fakeCancellations.includes("client-calendar:gcal:primary:evt_old_002"),
      JSON.stringify(fakeCancellations));
    check("a custom Calendar source names its lifecycle receipts",
      fakeReceipts.slice(receiptsBefore).length === 2 &&
        fakeReceipts.slice(receiptsBefore).every((entry) => entry.receipt.source === "client-calendar"),
      JSON.stringify(fakeReceipts.slice(receiptsBefore).map((entry) => entry.receipt.source)));
    check("a custom Calendar source gets its own resume state",
      (await import("node:fs")).existsSync(join(sandbox, ".brain-ingest-client-calendar.json")));
  }

  fakeReceipts.length = 0;

  /* ---- an unaccepted event withholds the Google cursor and retries ---- */
  {
    const retryDir = join(sandbox, "send-retry");
    mkdirSync(retryDir);
    const retryManifest = join(retryDir, "brain.manifest.json");
    writeFileSync(retryManifest, "{}\n", { mode: 0o600 });
    const failedImpl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_MUST_NOT_SAVE", items: [EVENT_KICKOFF] } }],
    });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, retryManifest, {},
      {
        ...commonOptions(),
        getAccessToken: provider(failedImpl).get,
        fetchImpl: failedImpl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async () => ({
            created: 0, updated: 0, unchanged: 0, refused: [],
            errors: [{ source_id: "gcal:primary:evt_kickoff_001", error: "fixture write failure" }], total: 1,
          }),
        },
      },
    );
    check("an event send failure withholds the Calendar sync state",
      !existsSync(join(retryDir, ".brain-ingest-calendar.json")));
    check("an event send failure closes the source receipt as error",
      fakeReceipts.at(-1)?.receipt.status === "error" && /send.*failed/.test(fakeReceipts.at(-1)?.receipt.error || ""),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
    check("an event send failure does not erase the completed Google walk",
      fakeReceipts.at(-1)?.receipt.walk_complete === true &&
      fakeReceipts.at(-1)?.receipt.complete_sweep === false &&
      fakeReceipts.at(-1)?.receipt.docs_failed === 1 &&
      !("confirmed_range" in fakeReceipts.at(-1).receipt),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));

    const retryImpl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_RETRY_ACCEPTED", items: [EVENT_KICKOFF] } }],
    });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, retryManifest, {},
      {
        ...commonOptions(),
        getAccessToken: provider(retryImpl).get,
        fetchImpl: retryImpl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async ({ envelopes }) => ({
            created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length,
          }),
        },
      },
    );
    check("the retry re-reads the unsaved Google window instead of skipping it",
      retryImpl.calls.calendar[0]?.params.get("syncToken") === null,
      retryImpl.calls.calendar[0]?.params.toString());
    check("the accepted retry may then save its new sync token",
      JSON.parse(readFileSync(join(retryDir, ".brain-ingest-calendar.json"), "utf8"))?.primary?.sync_token === "TOK_RETRY_ACCEPTED");
  }

  fakeReceipts.length = 0;

  /* ---- refusal and pending cancellation also remain retryable ---- */
  {
    const refusedDir = join(sandbox, "refused");
    mkdirSync(refusedDir);
    const refusedManifest = join(refusedDir, "brain.manifest.json");
    writeFileSync(refusedManifest, "{}\n", { mode: 0o600 });
    const impl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_REFUSED", items: [EVENT_KICKOFF] } }],
    });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, refusedManifest, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async () => ({
            created: 0, updated: 0, unchanged: 0,
            refused: [{ source_id: "gcal:primary:evt_kickoff_001", reason: "credential" }], errors: [], total: 1,
          }),
        },
      },
    );
    check("a refused Calendar event withholds the sync state",
      !existsSync(join(refusedDir, ".brain-ingest-calendar.json")));
    check("a refused Calendar event marks the source receipt incomplete",
      fakeReceipts.at(-1)?.receipt.status === "error" && fakeReceipts.at(-1)?.receipt.issue_code === "INPUT_REFUSED" &&
      /refused/.test(fakeReceipts.at(-1)?.receipt.error || ""),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
    check("a refused Calendar event remains a completed walk with a measured refusal",
      fakeReceipts.at(-1)?.receipt.walk_complete === true &&
      fakeReceipts.at(-1)?.receipt.complete_sweep === false &&
      fakeReceipts.at(-1)?.receipt.docs_refused === 1 &&
      !("confirmed_range" in fakeReceipts.at(-1).receipt),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
  }

  fakeReceipts.length = 0;

  {
    const cleanupDir = join(sandbox, "mark-retry");
    mkdirSync(cleanupDir);
    const cleanupManifest = join(cleanupDir, "brain.manifest.json");
    writeFileSync(cleanupManifest, "{}\n", { mode: 0o600 });
    const impl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_PENDING_MARK", items: [EVENT_CANCELLED] } }],
    });
    let marks = 0;
    await assert.rejects(cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, cleanupManifest, {},
      {
        ...commonOptions(),
        markCalendarCancellations: async ({ cancellations }) => {
          marks += cancellations.length;
          throw Object.assign(new Error("fixture mark unavailable"), { code: "INGEST_FAILED" });
        },
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async () => ({ created: 0, updated: 0, unchanged: 0, refused: [], errors: [], total: 0 }),
        },
      },
    ), { code: "INGEST_FAILED" });
    check("a failed cancellation mark reached storage and withholds the sync state",
      marks === 1 && !existsSync(join(cleanupDir, ".brain-ingest-calendar.json")));
    check("a failed cancellation mark reports a retryable incomplete receipt",
      fakeReceipts.at(-1)?.receipt.status === "error" && /marking was not confirmed/.test(fakeReceipts.at(-1)?.receipt.error || ""),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
    check("a failed mark does not conflate delivery with traversal",
      fakeReceipts.at(-1)?.receipt.walk_complete === true &&
      fakeReceipts.at(-1)?.receipt.complete_sweep === false &&
      !("confirmed_range" in fakeReceipts.at(-1).receipt),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
  }

  fakeReceipts.length = 0;

  /* ---- a malformed event is a measured gap inside an otherwise full walk ---- */
  {
    const gapDir = join(sandbox, "event-gap");
    mkdirSync(gapDir);
    const gapManifest = join(gapDir, "brain.manifest.json");
    writeFileSync(gapManifest, "{}\n", { mode: 0o600 });
    const impl = fakeGoogle({
      calendar: [{ status: 200, body: {
        nextSyncToken: "TOK_WITH_GAP",
        items: [{ id: "evt_missing_start", status: "confirmed", summary: "Undated fixture event" }],
      } }],
    });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, gapManifest, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async () => ({
            created: 0, updated: 0, unchanged: 0, refused: [], errors: [], total: 0,
          }),
        },
      },
    );
    check("a malformed event leaves the Google walk complete but blocks searchable history proof",
      fakeReceipts.at(-1)?.receipt.status === "ready" &&
      fakeReceipts.at(-1)?.receipt.walk_complete === true &&
      fakeReceipts.at(-1)?.receipt.complete_sweep === false &&
      fakeReceipts.at(-1)?.receipt.docs_refused === 1 &&
      !("confirmed_range" in fakeReceipts.at(-1).receipt),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
  }

  fakeReceipts.length = 0;

  /* ---- terminal page without a sync token is a walk, not snapshot proof ---- */
  {
    const noTokenDir = join(sandbox, "no-token");
    mkdirSync(noTokenDir);
    const noTokenManifest = join(noTokenDir, "brain.manifest.json");
    writeFileSync(noTokenManifest, "{}\n", { mode: 0o600 });
    const impl = fakeGoogle({ calendar: [{ status: 200, body: { items: [] } }] });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, noTokenManifest, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async () => ({
            created: 0, updated: 0, unchanged: 0, refused: [], errors: [], total: 0,
          }),
        },
      },
    );
    check("Calendar keeps walk completion separate from authoritative snapshot proof",
      fakeReceipts.at(-1)?.receipt.status === "ready" &&
      fakeReceipts.at(-1)?.receipt.walk_complete === true &&
      fakeReceipts.at(-1)?.receipt.complete_sweep === false &&
      !("confirmed_range" in fakeReceipts.at(-1).receipt),
      JSON.stringify(fakeReceipts.at(-1)?.receipt));
  }

  fakeReceipts.length = 0;

  /* ---- a dead refresh token is reported clearly, not as a crash ---- */
  {
    const impl = fakeGoogle({ token: { status: 400, body: { error: "invalid_grant" } } });
    let threw = null;
    try {
      await cmdIngestCalendar(
        { infrastructure: { cloudflare: {} } }, manifestPath, { "dry-run": true },
        {
          ...commonOptions(),
          getAccessToken: provider(impl).get,
          fetchImpl: impl,
          googleCalendar: { syncAll, ingestEnvelopes: async () => ({}) },
        },
      );
    } catch (error) { threw = error; }
    check("a dead refresh token makes the Calendar preview fail closed",
      /preview incomplete/.test(threw?.message || ""), threw?.message);
    check("the preview failure gives the exact Google reconsent action",
      renderCliCommands(threw?.message || "").includes(renderCliCommands("brain connect google --scopes drive,gmail,calendar")), threw?.message);
    check("the reconsent failure reached the token exchange", impl.calls.token.length === 1);
  }

  for (const scenario of ["partial", "interrupted", "revised", "forgotten", "restored", "older-restore", "unavailable", "one-event", "reset"]) {
    const interrupted = scenario === "interrupted";
    const resumeDir = join(sandbox, scenario + "-window");
    mkdirSync(resumeDir);
    const resumeManifest = join(resumeDir, "brain.manifest.json");
    writeFileSync(resumeManifest, "{}\n");
    const oneEvent = scenario === "one-event";
    const events = Array.from({ length: oneEvent ? 1 : 26 }, (_, i) => ({
      ...EVENT_KICKOFF, id: "synthetic-" + i, description: "Approved budget: $120.99",
      updated: "2026-11-02T12:00:00Z", start: { date: "2026-11-01" }, end: { date: "2026-11-02" },
    }));
    const initialIds = [];
    const retryIds = [];
    const stored = new Map();
    const run = (retry) => {
      const items = retry ? events.toReversed() : events;
      if (retry && scenario === "revised") {
        items[0] = { ...items[0], summary: "Synthetic revised event" };
      }
      const impl = fakeGoogle({ calendar: [{ body: { items, nextSyncToken: "RESUMED" } }] });
      return cmdIngestCalendar({}, resumeManifest, scenario === "reset" ? { reset: true } : {}, {
        ...commonOptions(),
        listStoredSourceFamilies: async () => new Set(stored.keys()),
        ...(oneEvent && !retry ? { saveCalendarState: () => { throw new Error("before cursor save"); } } : {}),
        readCurrentIngestParts: async ({ envelopes }) => {
          if (scenario === "unavailable") throw new Error("synthetic readback unavailable");
          const matches = envelopes.filter((envelope) => {
            const row = stored.get(`calendar:${envelope.source_id}`);
            return row?.metadata.calendar_revision === envelope.metadata.calendar_revision &&
              row?.content === envelope.content && row?.occurred_at === envelope.occurred_at;
          });
          return { parts: matches.map(({ source_id }) => ({ source_id })) };
        },
        fetchImpl: impl,
        getAccessToken: provider(impl).get,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async ({ envelopes }) => {
            const ids = envelopes.map((envelope) => envelope.source_id);
            if (!retry && interrupted && ids.some((id) => id.endsWith("-25"))) {
              throw Object.assign(new Error("synthetic interruption"), { code: "source_ingest_lock_lost" });
            }
            (retry ? retryIds : initialIds).push(...ids);
            const errors = !retry && !interrupted && !oneEvent
              ? ids.filter((id) => id.endsWith("-0")).map((source_id) => ({ source_id, code: "INGEST_FAILED" }))
              : [];
            for (const envelope of envelopes) {
              if (!errors.some(({ source_id }) => source_id === envelope.source_id)) {
                stored.set(`calendar:${envelope.source_id}`, envelope);
              }
            }
            return { created: ids.length - errors.length, updated: 0, unchanged: 0, refused: [], errors };
          },
        },
      });
    };
    if (oneEvent) await assert.rejects(run(false), /before cursor save/);
    else if (interrupted) await assert.rejects(run(false), { code: "source_ingest_lock_lost" });
    else {
      await run(false);
      check("partial catch-up records the product error code", fakeReceipts.at(-1).receipt.issue_code === "INGEST_FAILED");
    }
    const statePath = join(resumeDir, ".brain-ingest-calendar.json");
    check("incomplete delivery keeps the provider cursor uncommitted", !existsSync(statePath));
    if (scenario === "forgotten") stored.clear();
    if (scenario === "restored") stored.delete("calendar:gcal:primary:synthetic-1");
    const restoredUid = "calendar:gcal:primary:synthetic-1";
    if (scenario === "older-restore") {
      const current = stored.get(restoredUid);
      stored.set(restoredUid, { ...current, occurred_at: "2026-10-31",
        content: current.content.replaceAll("2026-11-01", "2026-10-31").replace("$120.99", "$100.01"),
        metadata: { ...current.metadata, updated: "2026-11-01T12:00:00Z" } });
    }
    const resumed = await run(true);
    const expected = interrupted ? "25" : "0";
    const alreadySent = interrupted ? 25 : 26;
    if (oneEvent) {
      check("one-event catch-up reports one verified resume and commits a complete sweep",
        retryIds.length === 0 && fakeReceipts.at(-1).receipt.docs_resumed === 1 &&
        fakeReceipts.at(-1).receipt.complete_sweep === true);
    } else if (scenario === "older-restore") {
      check("same-family restore replays the November 1 revision and its approved $120.99 budget",
        retryIds.length === 2 && retryIds[0].endsWith("-1") && retryIds[1].endsWith("-0") &&
        stored.get(restoredUid)?.occurred_at === "2026-11-01" &&
        stored.get(restoredUid)?.content.includes("$120.99"));
    } else if (scenario === "revised") {
      check("a changed revision is re-sent even when the previously accepted revision was checkpointed",
        retryIds.length === 2 && retryIds[0].endsWith("-25") && retryIds[1].endsWith("-0"));
    } else if (scenario === "forgotten" || scenario === "unavailable" || scenario === "reset") {
      check(`${scenario} catch-up redelivers all events`, retryIds.length === 26 && stored.size === 26);
    } else if (scenario === "restored") {
      check("a partially restored source replays the missing acknowledged family",
        retryIds.length === 2 && retryIds[0].endsWith("-1") && retryIds[1].endsWith("-0") && stored.size === 26);
    } else {
      check(interrupted ? "stopped catch-up resumes at the next saved window" : "partial catch-up resends just the failed item",
        initialIds.length === alreadySent && retryIds.length === 1 && retryIds[0].endsWith("-" + expected));
    }
    const expectedResumed = { partial: 25, interrupted: 25, revised: 24, forgotten: 0, restored: 24, "older-restore": 24, unavailable: 0, "one-event": 1, reset: 0 };
    check(`${scenario} receipt separates resumed skips from server unchanged results`,
      resumed.sent.unchanged === 0 && resumed.sent.resumed_skipped === expectedResumed[scenario] &&
      fakeReceipts.at(-1).receipt.docs_unchanged === 0 &&
      fakeReceipts.at(-1).receipt.detail.includes(`${expectedResumed[scenario]} resumed`));
    check("resumed delivery commits the terminal provider cursor",
      JSON.parse(readFileSync(statePath, "utf8")).primary.sync_token === "RESUMED");
  }

  {
    const impl = fakeGoogle({ calendar: [
      { body: { items: [EVENT_KICKOFF], nextPageToken: "NEXT" } },
      { body: { items: [{ ...EVENT_KICKOFF, summary: "Synthetic newest event", updated: "2026-11-02T12:00:00Z" }], nextSyncToken: "DONE" } },
    ] });
    const delivered = [];
    let finished;
    try {
      finished = await cmdIngestCalendar({}, manifestPath, { source: "duplicate-calendar" }, {
        ...commonOptions(),
        fetchImpl: impl,
        getAccessToken: provider(impl).get,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async ({ envelopes }) => {
            delivered.push(...envelopes);
            return { created: 0, updated: 0, unchanged: 0, refused: [], errors: [
              { source_id: envelopes[0].source_id, code: "INGEST_FAILED" },
            ] };
          },
        },
      });
    } catch (error) {
      check("duplicate failed event reaches the final error receipt", false, error.message);
    }
    if (finished) {
      check("duplicate failed event reaches the final error receipt",
        delivered.length === 1 && delivered[0].title.includes("Synthetic newest event") &&
        fakeReceipts.at(-1).receipt.status === "error" && fakeReceipts.at(-1).receipt.docs_failed === 1);
    }
  }

  for (const order of ["newer-first", "older-first", "ambiguous", "missing-revision", "older-cancellation"]) {
    const ambiguous = order === "ambiguous" || order === "missing-revision";
    const older = { ...EVENT_KICKOFF, description: "Approved budget: $100.01",
      updated: order === "missing-revision" ? undefined : "2026-11-01T12:00:00Z",
      ...(order === "older-cancellation" ? { status: "cancelled" } : {}),
    };
    const newer = { ...EVENT_KICKOFF, description: "Approved budget: $120.99",
      updated: order === "ambiguous" ? older.updated : "2026-11-02T12:00:00Z" };
    const [first, second] = order === "older-first" ? [older, newer] : [newer, older];
    const source = `calendar-${order}`;
    const impl = fakeGoogle({ calendar: [
      { body: { items: [first], nextPageToken: "NEXT" } },
      { body: { items: [second], nextSyncToken: "DUPLICATE_DONE" } },
    ] });
    const delivered = [];
    const outcome = await cmdIngestCalendar({}, manifestPath, { source }, {
      ...commonOptions(), fetchImpl: impl, getAccessToken: provider(impl).get,
      googleCalendar: { syncAll, ingestEnvelopes: async ({ envelopes }) => {
        delivered.push(...envelopes);
        return { created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [] };
      } },
    });
    const saved = join(sandbox, `.brain-ingest-${source}.json`);
    if (ambiguous) {
      check("unordered conflicting revisions hold the cursor and report ambiguity",
        delivered.length === 0 && !outcome.result.calendars[0].state.sync_token &&
        /conflicting event revisions/.test(outcome.result.calendars[0].error?.message ?? "") &&
        fakeReceipts.at(-1).receipt.status === "error");
    } else {
      check(`newest Calendar revision wins with ${order}`,
        delivered.length === 1 && delivered[0].content.includes("$120.99") && outcome.result.deletions.length === 0 &&
        JSON.parse(readFileSync(saved, "utf8")).primary.sync_token === "DUPLICATE_DONE");
    }
  }

  console.log(fail ? `\n${fail} FAILURES` : `\ncalendar-ingest: all ${ran} tests passed`);
} finally {
  store.db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
