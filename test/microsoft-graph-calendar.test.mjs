import assert from "node:assert/strict";
import {
  OUTLOOK_CALENDAR_PENDING_EVENT_MAX_BYTES,
  OUTLOOK_CALENDAR_PENDING_EVENT_MAX_COUNT,
  syncMicrosoftGraph,
} from "../connectors/microsoft-graph.mjs";
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

import { createIngestRemovalReview } from "../operations/ingest-removal-plan.mjs";
import { buildDriveRemovalPlan } from "../operations/drive-removal-plan.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

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
  onlineMeeting: {
    joinUrl: [
      "https://meet.example.invalid/fixture",
      ["pwd", "must-not-survive"].join("="),
    ].join("?"),
  },
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
    pending_event_ids: { version: 1, ids: [] },
  });
  assert.equal(result.authoritative_snapshot, true);
  assert.equal(result.cursor_can_advance, true);
  return { result, calendarCalls };
}

{
  const knownEventId = "event-incomplete-known";
  const unrelatedEventId = "event-unrelated-complete";
  const priorStoredFamilies = new Set([`microsoft:outlook:event:${knownEventId}`]);
  const runArm = async ({ knownEvent = null, missingIdentity = false, suffix }) => {
    let classificationCalls = 0;
    const cursor = {
      mail: {}, drives: {},
      calendar: {
        delta_link: `https://graph.microsoft.com/calendar-delta-${suffix}`,
        window_start: WINDOW_START,
        window_end: WINDOW_END,
        id_type: "immutable",
        event_ids: [knownEventId],
      },
    };
    const result = await syncMicrosoftGraph({
      accessToken: "offline-token",
      mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
      cursor,
      now: () => NOW,
      fetchImpl: async () => {
        classificationCalls++;
        return json({
          value: [
            missingIdentity ? { ...activeEvent, id: undefined } : knownEvent,
            { ...activeEvent, id: unrelatedEventId },
          ],
          "@odata.deltaLink": `https://graph.microsoft.com/calendar-delta-${suffix}-next`,
        });
      },
    });
    return { classificationCalls, cursor, result };
  };

  const incomplete = await runArm({
    knownEvent: { ...activeEvent, id: knownEventId, start: null },
    suffix: "known-incomplete",
  });
  assert.equal(incomplete.classificationCalls, 1, "the known-incomplete classification decision must be reached");
  assert.ok(priorStoredFamilies.has(`microsoft:outlook:event:${knownEventId}`), "the prior stored family fixture must exist");
  assert.ok(!incomplete.result.deletions.some((item) => item.source_id === `outlook:event:${knownEventId}`));
  assert.ok(incomplete.result.documents.some((item) => item.source_id === `outlook:event:${unrelatedEventId}`));
  assert.equal(incomplete.result.outcome.kind, "completed");
  assert.equal(incomplete.result.cursor_can_advance, true);
  assert.deepEqual(incomplete.result.proposed_cursor.calendar.pending_event_ids, {
    version: 1,
    ids: [knownEventId],
  });
  assert.equal(incomplete.result.deferred_count, 1);
  assert.equal(incomplete.result.deferred_reason_code, "calendar_event_incomplete");
  assert.deepEqual(incomplete.result.warnings, []);

  const complete = await runArm({
    knownEvent: { ...activeEvent, id: knownEventId },
    suffix: "known-complete",
  });
  assert.equal(complete.classificationCalls, 1, "the complete green control must reach classification");
  assert.equal(complete.result.outcome.kind, "completed");
  assert.equal(complete.result.cursor_can_advance, true);
  assert.equal(complete.result.documents.length, 2);
  assert.deepEqual(complete.result.proposed_cursor.calendar.pending_event_ids, { version: 1, ids: [] });
  assert.equal(complete.result.deferred_count, 0);
  assert.equal(complete.result.deferred_reason_code, null);

  const missingIdentity = await runArm({ missingIdentity: true, suffix: "missing-identity" });
  assert.equal(missingIdentity.classificationCalls, 1, "the missing-identity control must reach classification");
  assert.equal(missingIdentity.result.outcome.kind, "partial");
  assert.equal(missingIdentity.result.cursor_can_advance, false);
  assert.equal(missingIdentity.result.warnings.length, 1);

  check("a known incomplete event is deferred without blocking unrelated calendar progress",
    incomplete.result.outcome.kind === "completed" && incomplete.result.cursor_can_advance === true &&
    incomplete.result.proposed_cursor.calendar.pending_event_ids?.ids?.includes(knownEventId) &&
    incomplete.result.deferred_count === 1);
}

{
  const eventId = "event-pending-retry";
  const cursor = {
    mail: {}, drives: {},
    calendar: {
      delta_link: "https://graph.microsoft.com/calendar-delta-after-pending",
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      id_type: "immutable",
      event_ids: [eventId],
      pending_event_ids: { version: 1, ids: [eventId] },
    },
  };
  const runPendingArm = async (kind) => {
    let directCalls = 0;
    let deltaCalls = 0;
    const result = await syncMicrosoftGraph({
      accessToken: "offline-token",
      mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
      cursor,
      now: () => NOW,
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        if (target.includes(`/me/events/${eventId}`)) {
          directCalls++;
          assert.match(String(options.headers?.Prefer || ""), /IdType="ImmutableId"/);
          if (kind === "complete") return json({ ...activeEvent, id: eventId });
          if (kind === "missing") return json({ error: { code: "ErrorItemNotFound" } }, 404);
          return json({ error: { code: "ServiceUnavailable" } }, 503);
        }
        deltaCalls++;
        assert.equal(target, cursor.calendar.delta_link, "the direct pending read must precede the delta walk");
        return json({ value: [], "@odata.deltaLink": `${cursor.calendar.delta_link}-${kind}-next` });
      },
    });
    return { directCalls, deltaCalls, result };
  };

  const complete = await runPendingArm("complete");
  assert.equal(complete.directCalls, 1);
  assert.equal(complete.deltaCalls, 1);
  assert.ok(complete.result.documents.some((item) => item.source_id === `outlook:event:${eventId}`));
  assert.deepEqual(complete.result.proposed_cursor.calendar.pending_event_ids, { version: 1, ids: [] });
  assert.equal(complete.result.deferred_count, 0);

  const missing = await runPendingArm("missing");
  assert.equal(missing.directCalls, 1);
  assert.equal(missing.deltaCalls, 1);
  assert.deepEqual(missing.result.documents, []);
  assert.deepEqual(missing.result.deletions, [{ source_type: "microsoft", source_id: `outlook:event:${eventId}` }]);
  assert.deepEqual(missing.result.proposed_cursor.calendar.pending_event_ids, { version: 1, ids: [] });

  const retryable = await runPendingArm("retryable");
  assert.equal(retryable.directCalls, 4, "the real provider retry boundary must be exhausted");
  assert.equal(retryable.deltaCalls, 1);
  assert.deepEqual(retryable.result.documents, []);
  assert.deepEqual(retryable.result.deletions, []);
  assert.deepEqual(retryable.result.proposed_cursor.calendar.pending_event_ids, { version: 1, ids: [eventId] });
  assert.equal(retryable.result.deferred_count, 1);
  assert.equal(retryable.result.cursor_can_advance, true);
  check("pending calendar IDs resolve, tombstone, or remain durable according to the direct provider response",
    complete.result.cursor_can_advance && missing.result.cursor_can_advance && retryable.result.cursor_can_advance);
}

{
  const eventIds = ["event-pending-z", "event-pending-a"];
  let decisions = 0;
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor: { mail: {}, drives: {}, calendar: {
      delta_link: "https://graph.microsoft.com/calendar-delta-pending-order",
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      id_type: "immutable",
      event_ids: eventIds,
    } },
    now: () => NOW,
    fetchImpl: async () => {
      decisions++;
      return json({
        value: [
          { ...activeEvent, id: eventIds[0], start: null },
          { ...activeEvent, id: eventIds[1], start: null },
          { ...activeEvent, id: eventIds[0], start: null },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-pending-order-next",
      });
    },
  });
  check("new pending IDs are versioned, sorted and deduplicated before cursor persistence",
    decisions === 1 && result.deferred_count === 2 &&
    JSON.stringify(result.proposed_cursor.calendar.pending_event_ids) ===
      JSON.stringify({ version: 1, ids: [...eventIds].sort() }));
}

{
  const baseCalendar = {
    delta_link: "https://graph.microsoft.com/calendar-delta-pending-state",
    window_start: WINDOW_START,
    window_end: WINDOW_END,
    id_type: "immutable",
  };
  const tooManyIds = Array.from({ length: OUTLOOK_CALENDAR_PENDING_EVENT_MAX_COUNT + 1 },
    (_, index) => `event-pending-${String(index).padStart(3, "0")}`);
  const oversizedId = `event-${"x".repeat(OUTLOOK_CALENDAR_PENDING_EVENT_MAX_BYTES)}`;
  const refused = [
    {
      label: "malformed version",
      calendar: { ...baseCalendar, event_ids: ["event-one"], pending_event_ids: { version: 2, ids: ["event-one"] } },
    },
    {
      label: "identity outside inventory",
      calendar: { ...baseCalendar, event_ids: ["event-one"], pending_event_ids: { version: 1, ids: ["event-other"] } },
    },
    {
      label: "count overflow",
      calendar: { ...baseCalendar, event_ids: tooManyIds, pending_event_ids: { version: 1, ids: tooManyIds } },
    },
    {
      label: "encoded-size overflow",
      calendar: { ...baseCalendar, event_ids: [oversizedId], pending_event_ids: { version: 1, ids: [oversizedId] } },
    },
  ];
  let decisions = 0;
  let graphCalls = 0;
  for (const fixture of refused) {
    await assert.rejects(async () => {
      decisions++;
      await syncMicrosoftGraph({
        accessToken: "offline-token",
        mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
        cursor: { mail: {}, drives: {}, calendar: fixture.calendar },
        now: () => NOW,
        fetchImpl: async () => { graphCalls++; return json({}); },
      });
    }, (error) => error?.code === "invalid_pending_event_state", fixture.label);
  }
  assert.equal(decisions, refused.length, "every pending-state refusal must reach validation");
  assert.equal(graphCalls, 0, "invalid pending state must refuse before any provider request");

  let outputBoundDecisions = 0;
  for (const [eventIds, label] of [
    [tooManyIds, "new pending count overflow"],
    [[oversizedId], "new pending encoded-size overflow"],
  ]) {
    await assert.rejects(async () => {
      outputBoundDecisions++;
      await syncMicrosoftGraph({
        accessToken: "offline-token",
        mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
        cursor: { mail: {}, drives: {}, calendar: { ...baseCalendar, event_ids: eventIds } },
        now: () => NOW,
        fetchImpl: async () => {
          graphCalls++;
          return json({
            value: eventIds.map((id) => ({ ...activeEvent, id, start: null })),
            "@odata.deltaLink": `${baseCalendar.delta_link}-overflow-next`,
          });
        },
      });
    }, (error) => error?.code === "invalid_pending_event_state", label);
  }
  assert.equal(outputBoundDecisions, 2, "both proposed-cursor bounds must reach validation");
  assert.equal(graphCalls, 2, "both proposed-cursor overflow cases must reach event classification");

  const valid = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor: { mail: {}, drives: {}, calendar: {
      ...baseCalendar,
      event_ids: [],
      pending_event_ids: { version: 1, ids: [] },
    } },
    now: () => NOW,
    fetchImpl: async () => {
      graphCalls++;
      return json({ value: [], "@odata.deltaLink": `${baseCalendar.delta_link}-next` });
    },
  });
  check("malformed, foreign, over-count and oversized pending state refuse while the bounded green control advances",
    graphCalls === 3 && valid.cursor_can_advance === true &&
    valid.proposed_cursor.calendar.pending_event_ids.ids.length === 0);
}

{
  const priorEventIds = Array.from({ length: 20 }, (_, index) => `event-baseline-${index + 1}`);
  const cursor = {
    mail: { inbox: "https://graph.microsoft.com/mail-delta-baseline-control" }, drives: {},
    calendar: {
      delta_link: "https://graph.microsoft.com/calendar-delta-old-window",
      window_start: "2026-09-05T00:00:00.000Z",
      window_end: "2027-01-03T00:00:00.000Z",
      id_type: "immutable",
      event_ids: priorEventIds,
    },
  };
  let graphCalls = 0;
  const adapter = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: ["inbox"], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor,
    now: () => NOW,
    fetchImpl: async (url) => {
      graphCalls++;
      if (String(url) === cursor.mail.inbox) {
        return json({
          value: [{ id: "mail-not-stored", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": cursor.mail.inbox,
        });
      }
      return json({
        value: [
          { ...activeEvent, id: undefined },
          ...priorEventIds.slice(1).map((id) => ({ ...activeEvent, id })),
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-renewed",
      });
    },
  });
  const stored = new Set(priorEventIds.map((id) => `microsoft:outlook:event:${id}`));
  let inventoryCalls = 0;
  let removalCalls = 0;
  let stateSaves = 0;
  await runProviderConnector({
    provider: "microsoft",
    sync: async () => adapter,
    resolveAccess: async () => ({ accessToken: "offline-token", connection: {} }),
    loadState: () => ({ cursor }),
    saveState: () => { stateSaves++; },
    sendBatch: async ({ docs }) => ({
      body: { results: docs.map((document) => ({ source_id: document.source_id, status: "unchanged" })) },
    }),
    removeDocuments: async ({ uids }) => {
      removalCalls++;
      for (const uid of uids) stored.delete(uid);
      return { applied: uids.length, pending: 0 };
    },
    listStoredFamilies: async () => { inventoryCalls++; return new Set(stored); },
    postReceipt: async () => {},
    base: "https://brain.invalid",
    adminKey: "offline-key",
    now: () => new Date(NOW),
  });
  check("an incomplete baseline reaches reconciliation without treating unmatched prior identity as deletion",
    graphCalls === 2 && inventoryCalls > 0 && adapter.warnings.length === 1 &&
    adapter.cursor_can_advance === false && removalCalls === 0 && stateSaves === 0 &&
    priorEventIds.every((id) => stored.has(`microsoft:outlook:event:${id}`)));
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
  const runPagedTerminalChange = async (terminalChange) => {
    let pageCalls = 0;
    const result = await syncMicrosoftGraph({
      accessToken: "offline-token",
      mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
      now: () => NOW,
      fetchImpl: async () => {
        pageCalls++;
        if (pageCalls === 1) {
          return json({
            value: [{ ...activeEvent, id: "event-paged-terminal" }],
            "@odata.nextLink": "https://graph.microsoft.com/calendar-page-2",
          });
        }
        assert.equal(pageCalls, 2, "the paged deletion probe must stop after its terminal page");
        return json({
          value: [{ id: "event-paged-terminal", ...terminalChange }],
          "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-paged-terminal",
        });
      },
    });
    return { result, pageCalls };
  };

  const removed = await runPagedTerminalChange({ "@removed": { reason: "deleted" } });
  const cancelled = await runPagedTerminalChange({ isCancelled: true });
  check("a later-page removal clears an event proven live earlier in the same completed walk",
    removed.pageCalls === 2 && removed.result.documents.length === 0 &&
    removed.result.deletions.length === 1 &&
    removed.result.deletions[0].source_id === "outlook:event:event-paged-terminal" &&
    removed.result.proposed_cursor.calendar.event_ids.length === 0 &&
    removed.result.cursor_can_advance === true);
  check("the same paged walk reaches cancellation handling as the green control",
    cancelled.pageCalls === 2 && cancelled.result.documents.length === 0 &&
    cancelled.result.deletions.length === 1 &&
    cancelled.result.deletions[0].source_id === "outlook:event:event-paged-terminal" &&
    cancelled.result.proposed_cursor.calendar.event_ids.length === 0 &&
    cancelled.result.cursor_can_advance === true);
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
  const store = ingestPlanStore();
  for (const uid of stored) store.put(uid);
  const state = { done: {}, skipped: {} };
  const review = createIngestRemovalReview({ state, saveState() {}, source: "microsoft", manifest: {},
    manifestPath: "/fixture/manifest.json", base: "https://fixture.invalid",
    request: async (input) => { if (input.body.action === "apply") removalCalls++; return store.request(input); },
    runtime: () => "fixture-runtime" });
  const run = () => runProviderConnector({
    provider: "microsoft",
    sync: async () => adapter,
    resolveAccess: async () => ({ accessToken: "offline-token", connection: {} }),
    loadState: () => ({ cursor }),
    saveState: () => { stateSaves++; },
    sendBatch: async () => ({ body: { results: [] } }),
    removeDocuments: async () => { throw new Error("unreviewed removal"); },
    listStoredFamilies: async () => { inventoryCalls++; return new Set(store.uids()); },
    reviewRemovals: ({ uids, storedFamilies, requiredApproval }) => review.finish({
      sourcePlan: buildDriveRemovalPlan({ storedFamilies, vanishedCandidates: uids }),
      providerApproval: requiredApproval,
    }),
    postReceipt: async () => {},
    base: "https://brain.invalid",
    adminKey: "offline-key",
    now: () => new Date(NOW),
  });
  try {
    await assert.rejects(run(), (error) => error?.code === "SAFETY_REVIEW_REQUIRED");
    check("calendar removal review is not diluted by unrelated mail families",
      inventoryCalls > 0 && removalCalls === 0 && stateSaves === 0);
    const fingerprint = providerSnapshotRemovalFingerprint("microsoft", ["microsoft:outlook:event:event-cap-1"]);
    assert.equal(state.ingest_removal_plan.providerApproval, fingerprint);
    assert.deepEqual(state.ingest_removal_plan.targets, ["microsoft:outlook:event:event-cap-1"]);
    await assert.rejects(review.apply(state.ingest_removal_plan.fingerprint), { code: "SAFETY_REVIEW_REQUIRED" });
    assert.equal(removalCalls, 0);
    await review.apply(state.ingest_removal_plan.fingerprint, fingerprint);
    await run();
    check("the exact approved calendar removal reaches deletion and resumed cursor save as the green control",
      removalCalls === 1 && stateSaves === 1 && !store.uids().includes("microsoft:outlook:event:event-cap-1"));
  } finally { store.db.close(); }
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

{
  const knownEventId = "event-red-probe-known";
  const runArm = async ({ event, suffix }) => {
    let classificationCalls = 0;
    const result = await syncMicrosoftGraph({
      accessToken: "offline-token",
      mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
      cursor: {
        mail: {}, drives: {},
        calendar: {
          delta_link: `https://graph.microsoft.com/calendar-delta-red-${suffix}`,
          window_start: WINDOW_START,
          window_end: WINDOW_END,
          id_type: "immutable",
          event_ids: [knownEventId],
        },
      },
      now: () => NOW,
      fetchImpl: async () => {
        classificationCalls++;
        return json({
          value: [event],
          "@odata.deltaLink": `https://graph.microsoft.com/calendar-delta-red-${suffix}-next`,
        });
      },
    });
    return { classificationCalls, result };
  };

  const complete = await runArm({ event: { ...activeEvent, id: knownEventId }, suffix: "complete" });
  check("the calendar deferral red probe has a completed-event green control",
    complete.classificationCalls === 1 && complete.result.documents.length === 1 &&
    complete.result.cursor_can_advance === true && complete.result.warnings.length === 0);

  const incomplete = await runArm({
    event: { ...activeEvent, id: knownEventId, start: null },
    suffix: "incomplete",
  });
  check("an incomplete known event reaches classification and emits the closed calendar deferral",
    incomplete.classificationCalls === 1 && incomplete.result.deletions.length === 0 &&
    incomplete.result.deferred_count === 1 &&
    incomplete.result.deferred_reason_code === "calendar_event_incomplete" &&
    incomplete.result.cursor_can_advance === true);
}

console.log(`\nmicrosoft graph calendar: all ${ran} checks passed`);
