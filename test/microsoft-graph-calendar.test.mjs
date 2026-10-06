import assert from "node:assert/strict";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import {
  buildProviderAuthorizationUrl,
  providerAccessToken,
  providerOAuthConfig,
} from "../connectors/provider-oauth.mjs";

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
  assert.deepEqual(result.deletions, [{
    source_type: "microsoft",
    source_id: "outlook:event:event-cancelled-1",
  }]);
  assert.deepEqual(result.proposed_cursor.calendar, {
    delta_link: "https://graph.microsoft.com/calendar-delta-1",
    window_start: WINDOW_START,
    window_end: WINDOW_END,
    event_ids: ["event-stable-1"],
  });
  assert.equal(result.authoritative_snapshot, true);
  assert.equal(result.cursor_can_advance, true);
  return { result, calendarCalls };
}

await runCalendarContract(syncMicrosoftGraph);
check("the production Microsoft adapter satisfies the bounded calendar contract", true);

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
