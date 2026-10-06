import assert from "node:assert/strict";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import {
  bindMicrosoftConnection,
  buildProviderAuthorizationUrl,
  providerAccessToken,
  providerOAuthConfig,
} from "../connectors/provider-oauth.mjs";
import {
  providerSnapshotRemovalFingerprint,
  runProviderConnector,
} from "../connectors/provider-runtime.mjs";

let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const WINDOW_START = "2026-09-06T00:00:00.000Z";
const WINDOW_END = "2027-01-04T00:00:00.000Z";

const attendees = Array.from({ length: 60 }, (_, index) => ({
  type: "required",
  status: { response: "accepted" },
  emailAddress: {
    name: `Invented attendee ${index + 1}`,
    address: `attendee-${index + 1}@example.invalid`,
  },
}));

const activeEvent = {
  id: "event-stable-1",
  subject: "Invented planning session",
  body: {
    contentType: "html",
    content: `<p>${"Reviewed agenda. ".repeat(180)}</p><p>Join Zoom Meeting</p><p>Passcode: invented-secret</p>`,
  },
  start: { dateTime: "2026-10-07T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-10-07T10:00:00.0000000", timeZone: "UTC" },
  organizer: { emailAddress: { name: "Invented organizer", address: "organizer@example.invalid" } },
  attendees,
  location: { displayName: "Invented room" },
  onlineMeeting: { joinUrl: "https://meet.example.invalid/fixture?pwd=must-not-survive" },
  onlineMeetingProvider: "teamsForBusiness",
  webLink: "https://outlook.office.invalid/calendar/item/fixture",
  lastModifiedDateTime: "2026-10-06T11:00:00.000Z",
  iCalUId: "fixture-ical-uid",
};

async function runCalendarContract(syncImpl) {
  let calendarCalls = 0;
  const result = await syncImpl({
    accessToken: "offline-token",
    mailFolderIds: [],
    driveIds: [],
    siteIds: [],
    includePersonalDrive: false,
    now: () => NOW,
    fetchImpl: async (url, options = {}) => {
      calendarCalls++;
      const target = new URL(String(url));
      assert.equal(target.pathname, "/v1.0/me/calendarView/delta");
      assert.equal(target.searchParams.get("startDateTime"), WINDOW_START);
      assert.equal(target.searchParams.get("endDateTime"), WINDOW_END);
      assert.match(String(options.headers?.Prefer || ""), /outlook\.body-content-type="text"/);
      assert.match(String(options.headers?.Prefer || ""), /IdType="ImmutableId"/);
      return json({
        value: [activeEvent, { id: "event-cancelled-1", isCancelled: true }],
        "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-1",
      });
    },
  });

  assert.equal(calendarCalls, 1, "the calendar decision point must be reached exactly once");
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].source_id, "outlook:event:event-stable-1");
  assert.equal(result.documents[0].source_subtype, "outlook_calendar");
  assert.equal(result.documents[0].metadata.category, "calendar");
  assert.equal(result.documents[0].metadata.attendee_emails.length, 60);
  assert.match(result.documents[0].content, /and 20 more/);
  assert.doesNotMatch(result.documents[0].content, /attendee-41@example\.invalid/);
  assert.doesNotMatch(result.documents[0].content, /must-not-survive|Passcode:/i);
  assert.ok(result.documents[0].content.length <= 6_003);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(result.proposed_cursor.calendar, {
    delta_link: "https://graph.microsoft.com/calendar-delta-1",
    window_start: WINDOW_START,
    window_end: WINDOW_END,
    id_type: "immutable",
    event_ids: ["event-stable-1"],
  });
  assert.equal(result.authoritative_snapshot, true);
  assert.equal(result.cursor_can_advance, true);
  return { result, calendarCalls };
}

{
  let decisionCalls = 0;
  const cursor = {
    mail: {}, drives: {},
    calendar: {
      delta_link: "https://graph.microsoft.com/calendar-delta-malformed",
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      id_type: "immutable",
      event_ids: ["event-malformed-1"],
    },
  };
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor,
    now: () => NOW,
    fetchImpl: async () => {
      decisionCalls++;
      return json({
        value: [{ ...activeEvent, id: "event-malformed-1", start: null }],
        "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-malformed-next",
      });
    },
  });
  check("a malformed known event preserves the prior family and withholds its calendar cursor",
    decisionCalls === 1 && result.deletions.length === 0 &&
    result.proposed_cursor.calendar.event_ids.includes("event-malformed-1") &&
    result.cursor_can_advance === false && result.warnings.length === 1);
}

{
  let decisionCalls = 0;
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor: {
      mail: {}, drives: {},
      calendar: {
        delta_link: "https://graph.microsoft.com/calendar-delta-scope",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
        id_type: "immutable",
        event_ids: ["event-known-1"],
      },
    },
    now: () => NOW,
    fetchImpl: async () => {
      decisionCalls++;
      return json({
        value: [
          { id: "event-outside-1", "@removed": { reason: "changed" } },
          { id: "event-known-1", "@removed": { reason: "deleted" } },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-scope-next",
      });
    },
  });
  check("only a tombstone already in the tracked calendar view receives deletion authority",
    decisionCalls === 1 && result.deletions.length === 1 &&
    result.deletions[0].source_id === "outlook:event:event-known-1");
}

{
  const hydratedDates = [
    {
      id: "all-day-positive",
      zone: "Asia/Tokyo",
      initialStart: "2026-10-06T15:00:00.0000000",
      initialEnd: "2026-10-07T15:00:00.0000000",
      hydratedStart: "2026-10-07T00:00:00.0000000",
      hydratedEnd: "2026-10-08T00:00:00.0000000",
      expectedDate: "2026-10-07",
    },
    {
      id: "all-day-negative-dst",
      zone: "America/New_York",
      initialStart: "2026-11-01T04:00:00.0000000",
      initialEnd: "2026-11-03T05:00:00.0000000",
      hydratedStart: "2026-11-01T00:00:00.0000000",
      hydratedEnd: "2026-11-03T00:00:00.0000000",
      expectedDate: "2026-11-01",
    },
  ];
  const calls = [];
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    now: () => NOW,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), prefer: String(options.headers?.Prefer || "") });
      if (String(url).includes("/me/calendarView/delta")) {
        return json({
          value: hydratedDates.map((fixture) => ({
            ...activeEvent,
            id: fixture.id,
            isAllDay: true,
            originalStartTimeZone: fixture.zone,
            originalEndTimeZone: fixture.zone,
            start: { dateTime: fixture.initialStart, timeZone: "UTC" },
            end: { dateTime: fixture.initialEnd, timeZone: "UTC" },
          })),
          "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-all-day",
        });
      }
      const fixture = hydratedDates.find((item) => String(url).endsWith(`/me/events/${item.id}`));
      assert.ok(fixture, `unexpected all-day hydration URL ${url}`);
      assert.match(String(options.headers?.Prefer || ""), new RegExp(`outlook\\.timezone="${fixture.zone.replace("/", "\\/")}"`));
      return json({
        ...activeEvent,
        id: fixture.id,
        isAllDay: true,
        originalStartTimeZone: fixture.zone,
        originalEndTimeZone: fixture.zone,
        start: { dateTime: fixture.hydratedStart, timeZone: fixture.zone },
        end: { dateTime: fixture.hydratedEnd, timeZone: fixture.zone },
      });
    },
  });
  check("all-day positive-offset, negative-offset, DST and multi-day civil dates are recovered before rendering",
    calls.length === 3 && hydratedDates.every((fixture) => result.documents.some((document) =>
      document.source_id === `outlook:event:${fixture.id}` && document.occurred_at === fixture.expectedDate)));
}

{
  const priorCursor = {
    mail: {}, drives: {},
    calendar: {
      delta_link: "https://graph.microsoft.com/legacy-calendar-delta",
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      event_ids: ["legacy-changing-id"],
    },
  };
  const calls = [];
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor: priorCursor,
    now: () => NOW,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), prefer: String(options.headers?.Prefer || "") });
      return json({ value: [{ ...activeEvent, id: "immutable-id" }], "@odata.deltaLink": "https://graph.microsoft.com/immutable-delta" });
    },
  });
  check("a legacy mutable-ID cursor takes a new immutable baseline and plans exact old-family migration",
    calls.length === 1 && calls[0].url.includes("/me/calendarView/delta") &&
    !calls[0].url.includes("legacy-calendar-delta") && calls[0].prefer.includes('IdType="ImmutableId"') &&
    result.deletions.some((item) => item.source_id === "outlook:event:legacy-changing-id") &&
    result.proposed_cursor.calendar.id_type === "immutable");
}

{
  const cursor = {
    mail: {}, drives: {},
    calendar: {
      delta_link: "https://graph.microsoft.com/calendar-delta-removal-cap",
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      id_type: "immutable",
      event_ids: ["event-cap-1"],
    },
  };
  const adapter = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor,
    now: () => NOW,
    fetchImpl: async () => json({
      value: [{ id: "event-cap-1", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-removal-cap-next",
    }),
  });
  const stored = new Set([
    "microsoft:outlook:event:event-cap-1",
    ...Array.from({ length: 20 }, (_, index) => `microsoft:outlook:message:unrelated-${index + 1}`),
  ]);
  let inventoryCalls = 0;
  let removalCalls = 0;
  let stateSaves = 0;
  const run = (approvedSnapshotFingerprint = null) => runProviderConnector({
    provider: "microsoft",
    sync: async () => adapter,
    resolveAccess: async () => ({ accessToken: "offline-token", connection: {} }),
    loadState: () => ({ cursor }),
    saveState: () => { stateSaves++; },
    sendBatch: async () => ({ body: { results: [] } }),
    removeDocuments: async ({ uids }) => {
      removalCalls++;
      for (const uid of uids) stored.delete(uid);
      return { applied: uids.length, pending: 0 };
    },
    listStoredFamilies: async () => { inventoryCalls++; return new Set(stored); },
    postReceipt: async () => {},
    base: "https://brain.invalid",
    adminKey: "offline-key",
    approvedSnapshotFingerprint,
    now: () => new Date(NOW),
  });
  await assert.rejects(run(), (error) => error?.code === "provider_removal_review_required");
  check("calendar removal review is not diluted by unrelated mail families",
    inventoryCalls > 0 && removalCalls === 0 && stateSaves === 0);

  const fingerprint = providerSnapshotRemovalFingerprint("microsoft", ["microsoft:outlook:event:event-cap-1"]);
  await run(fingerprint);
  check("the exact approved calendar removal reaches deletion and cursor save as the green control",
    removalCalls === 1 && stateSaves === 1 && !stored.has("microsoft:outlook:event:event-cap-1"));
}

await runCalendarContract(syncMicrosoftGraph);
check("the production Microsoft adapter satisfies the bounded calendar contract", true);

{
  const prior = {
    access_token: "prior-offline-token",
    provider_metadata: { microsoft_account_fingerprint: "a".repeat(64) },
    sync_states: {
      microsoft: {
        cursor: {
          mail: { inbox: "https://graph.microsoft.com/mail-delta-preserved" },
          drives: { D1: "https://graph.microsoft.com/drive-delta-preserved" },
        },
      },
    },
  };
  const candidate = {
    access_token: "renewed-offline-token",
    provider_metadata: { microsoft_account_fingerprint: "a".repeat(64) },
  };
  const renewed = bindMicrosoftConnection({ prior, candidate });
  const calls = [];
  await syncMicrosoftGraph({
    accessToken: renewed.access_token,
    mailFolderIds: ["inbox"], driveIds: ["D1"], siteIds: [], includePersonalDrive: false,
    includeCalendar: false,
    cursor: renewed.sync_states.microsoft.cursor,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return json({ value: [], "@odata.deltaLink": String(url) });
    },
  });
  check("same-account re-consent preserves exact mail and drive cursors through the next sync",
    calls.join(",") === "https://graph.microsoft.com/mail-delta-preserved,https://graph.microsoft.com/drive-delta-preserved");

  assert.throws(
    () => bindMicrosoftConnection({
      prior,
      candidate: {
        ...candidate,
        provider_metadata: { microsoft_account_fingerprint: "b".repeat(64) },
      },
    }),
    (error) => error?.code === "unexpected_account",
  );
  check("a different-account re-consent refuses before protected sync state can move", true);
}

{
  let mutantCalls = 0;
  let mutantRejected = false;
  try {
    await runCalendarContract((options) => {
      mutantCalls++;
      return syncMicrosoftGraph({ ...options, includeCalendar: false });
    });
  } catch {
    mutantRejected = true;
  }
  check("the calendar probe rejects the old no-calendar behavior and proves the mutant ran",
    mutantRejected && mutantCalls === 1);
}

{
  let reached = 0;
  await assert.rejects(
    () => providerAccessToken("microsoft", {
      connection: {
        access_token: "offline-token",
        expires_at: NOW + 60 * 60 * 1000,
        scopes: ["openid", "profile", "offline_access", "User.Read", "Mail.Read", "Files.Read", "Sites.Read.All"],
      },
      now: NOW,
    }).then((value) => { reached++; return value; }),
    (error) => error?.code === "reconsent_required" && /Calendars\.Read/.test(error.message),
  );
  check("an existing pre-calendar Microsoft connection stops with an exact re-consent requirement",
    reached === 0);
}

{
  const config = providerOAuthConfig("microsoft");
  const authorization = new URL(buildProviderAuthorizationUrl("microsoft", {
    clientId: "fixture-client",
    state: "fixture-state",
    challenge: "fixture-challenge",
  }));
  const scopes = authorization.searchParams.get("scope")?.split(" ") || [];
  check("Microsoft consent adds delegated Calendars.Read without a write scope",
    config.scopes.includes("Calendars.Read") && scopes.includes("Calendars.Read") &&
    !scopes.some((scope) => /\.ReadWrite$/.test(scope)));
  check("the owner consent notice names calendar access and the read-only boundary",
    /calendar events/i.test(config.consentNotice || "") && /cannot create, edit, send, or delete/i.test(config.consentNotice || ""));
}

{
  const calls = [];
  const cursor = {
    mail: { inbox: "https://graph.microsoft.com/mail-delta-prior" },
    drives: { D1: "https://graph.microsoft.com/drive-delta-prior" },
    calendar: {
      delta_link: "https://graph.microsoft.com/calendar-delta-prior",
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      id_type: "immutable",
      event_ids: ["event-update-1", "event-cancel-1", "event-removed-1", "event-blank-1"],
    },
  };
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: ["inbox"],
    driveIds: ["D1"],
    siteIds: [],
    includePersonalDrive: false,
    cursor,
    now: () => NOW,
    fetchImpl: async (url) => {
      const target = String(url);
      calls.push(target);
      if (target === cursor.mail.inbox) {
        return json({ value: [], "@odata.deltaLink": cursor.mail.inbox });
      }
      if (target === cursor.drives.D1) {
        return json({ value: [], "@odata.deltaLink": cursor.drives.D1 });
      }
      if (target === cursor.calendar.delta_link) {
        return json({ value: [
          {
            ...activeEvent,
            id: "event-update-1",
            subject: "Invented planning session, updated",
            lastModifiedDateTime: "2026-10-06T12:00:00.000Z",
          },
          { id: "event-cancel-1", isCancelled: true },
          { id: "event-removed-1", "@removed": { reason: "deleted" } },
          {
            id: "event-blank-1", subject: "", body: { contentType: "text", content: "" },
            start: { dateTime: "2026-10-08T09:00:00.000Z", timeZone: "UTC" },
            end: { dateTime: "2026-10-08T10:00:00.000Z", timeZone: "UTC" },
          },
        ], "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-next" });
      }
      throw new Error(`unexpected offline URL ${target}`);
    },
  });

  check("calendar updates keep the stable document identity",
    result.documents.some((document) => document.source_id === "outlook:event:event-update-1" &&
      /updated/.test(document.title)));
  check("blank cancellations and removed records target exact stable event identities",
    result.deletions.map((item) => item.source_id).sort().join(",") ===
      "outlook:event:event-blank-1,outlook:event:event-cancel-1,outlook:event:event-removed-1");
  check("the calendar inventory advances independently after update and cancellation",
    result.proposed_cursor.calendar.delta_link === "https://graph.microsoft.com/calendar-delta-next" &&
    result.proposed_cursor.calendar.event_ids.join(",") === "event-update-1");
  check("existing mail and drive cursor members retain their exact bytes",
    result.proposed_cursor.mail.inbox === cursor.mail.inbox &&
    result.proposed_cursor.drives.D1 === cursor.drives.D1);
  check("the incremental probe reached all three independent Graph lanes", calls.length === 3);
}

{
  let calendarCalls = 0;
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor: {
      mail: {}, drives: {},
      calendar: {
        delta_link: "https://graph.microsoft.com/calendar-delta-expired",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
        id_type: "immutable",
        event_ids: ["event-aged-out-1"],
      },
    },
    now: () => NOW,
    fetchImpl: async (url) => {
      calendarCalls++;
      if (String(url).includes("calendar-delta-expired")) {
        return json({ error: { code: "SyncStateNotFound" } }, 410);
      }
      const target = new URL(String(url));
      assert.equal(target.pathname, "/v1.0/me/calendarView/delta");
      return json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-recovered" });
    },
  });
  check("an expired calendar cursor performs one bounded baseline recovery",
    calendarCalls === 2 && result.proposed_cursor.calendar.delta_link.endsWith("calendar-delta-recovered"));
  check("baseline recovery removes an event absent from the renewed rolling window",
    result.deletions.length === 1 && result.deletions[0].source_id === "outlook:event:event-aged-out-1");
}

console.log(`\nmicrosoft graph calendar: all ${ran} checks passed`);
