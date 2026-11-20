/** Microsoft Graph delta adapter for Outlook and OneDrive or SharePoint bodies. */

import {
  createPaginationGuard, ProviderSyncError, providerEnvelope, providerJson, providerSyncResult,
} from "./provider-sync.mjs";
import {
  buildEnvelope as buildGoogleCalendarEnvelope,
  normalizeConfig as normalizeGoogleCalendarConfig,
} from "./google-calendar.mjs";
import { stripMarkup } from "../ingest/quality.mjs";
import { mailReceivedAt, normalizeMailStartAt } from "./microsoft-mail-transition.mjs";
import { restampFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";

import { MICROSOFT_ADD_ONLY, MICROSOFT_SKIP_UNREADABLE_FILES, microsoftFileSkipBeforeDownload } from "./microsoft-week1-rules.mjs";
import { microsoftLocalTimeZone, microsoftMailTime, microsoftEventTime } from "./microsoft-time.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAIL_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';
const CALENDAR_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="UTC"';
const IMMUTABLE_CALENDAR_ID_TYPE = "immutable";
const PENDING_EVENT_IDS_VERSION = 1;
const CALENDAR_EVENT_DEFERRED_REASON = "calendar_event_incomplete";
const tombstoneCause = item => item?.deleted || item?.["@removed"]?.reason === "deleted"
  ? "explicit_deletion" : item?.["@removed"]?.reason === "changed" ? "scope_or_filter_change" : "unknown";
const SAFE_GRAPH_TIME_ZONE = /^[A-Za-z0-9_+./: -]{1,100}$/;
export const OUTLOOK_CALENDAR_PAST_DAYS = 30;
export const OUTLOOK_CALENDAR_FUTURE_DAYS = 90;
export const OUTLOOK_CALENDAR_PENDING_EVENT_MAX_COUNT = 100;
export const OUTLOOK_CALENDAR_PENDING_EVENT_MAX_BYTES = 16 * 1024;

// Keep calendar and mail-only runs independent of the optional document
// extractor bundle. A drive item loads that bundle immediately before use.
const downloadProviderFile = async (options) =>
  (await import("./provider-file.mjs")).downloadProviderFile(options);

function cursorExpired(error) {
  if (error instanceof ProviderSyncError && error.status === 410) {
    return new ProviderSyncError("microsoft", "the saved Graph delta cursor expired; run an explicit reset so the full inventory can be reconciled", {
      kind: "retryable", status: 410, code: "cursor_expired",
    });
  }
  return error;
}

async function deltaCollection({ provider = "microsoft", initialUrl, accessToken, fetchImpl, headers = {} }) {
  const items = [];
  const deletions = [];
  const changes = [];
  const guard = createPaginationGuard(provider);
  let url = initialUrl;
  let deltaLink = null;
  while (url) {
    guard.visit(url);
    let data;
    try {
      ({ data } = await providerJson(provider, url, { accessToken, fetchImpl, headers }));
    } catch (error) {
      throw cursorExpired(error);
    }
    // A cursor from an earlier page or a malformed empty response is not a
    // terminal provider check. Require one well-formed continuation or delta
    // boundary on each page before any cursor can be proposed for persistence.
    const next = data?.["@odata.nextLink"];
    const delta = data?.["@odata.deltaLink"];
    if (!Array.isArray(data?.value) ||
        [next, delta].some(link => link !== undefined && (typeof link !== "string" || !link.trim())) ||
        (next !== undefined && delta !== undefined)) {
      throw new ProviderSyncError(provider, "Graph returned an invalid delta page", {
        kind: "retryable", code: "invalid_delta_page",
      });
    }
    for (const item of data.value) {
      if (item?.["@removed"] || item?.deleted) {
        deletions.push(item);
        changes.push({ kind: "delete", item });
      } else {
        items.push(item);
        changes.push({ kind: "upsert", item });
      }
    }
    deltaLink = delta || null;
    url = next || null;
  }
  if (!deltaLink) {
    throw new ProviderSyncError(provider, "Graph did not return a terminal delta cursor", {
      kind: "retryable", code: "missing_delta_link",
    });
  }
  return { items, deletions, changes, deltaLink };
}

async function pagedGraphValues(url, auth, shape = null) {
  const values = [];
  const guard = createPaginationGuard("microsoft");
  let next = url;
  while (next) {
    guard.visit(next);
    const { data } = await providerJson("microsoft", next, auth);
    if (shape && !Array.isArray(data?.value)) shape.malformed = true;
    values.push(...(data?.value || []));
    next = data["@odata.nextLink"] || null;
  }
  return values;
}

// Discovery that returns 200 without a drive identity or a value array skipped
// an enabled file workload. Report it so the run cannot certify a quiet check.
async function configuredDriveIds({ driveIds, siteIds, includePersonalDrive, accessToken, fetchImpl }) {
  const ids = new Set((driveIds || []).map(String).filter(Boolean));
  const auth = { accessToken, fetchImpl };
  const shape = { malformed: false };
  const validId = (value) => typeof value === "string" && value.length > 0;
  let personalDriveUnavailable = false;
  if (includePersonalDrive) {
    try {
      const { data } = await providerJson("microsoft", `${GRAPH}/me/drive?$select=id`, auth);
      if (validId(data?.id)) ids.add(data.id);
      else shape.malformed = true;
    } catch (error) {
      // An absent optional OneDrive cannot discard mail and calendar progress.
      // Other errors (including authentication and permission) retain their guard.
      if (!(error instanceof ProviderSyncError) || error.status !== 404) throw error;
      personalDriveUnavailable = true;
    }
  }
  for (const siteId of siteIds || []) {
    const drives = await pagedGraphValues(`${GRAPH}/sites/${encodeURIComponent(siteId)}/drives?$select=id`, auth, shape);
    for (const drive of drives) {
      if (validId(drive?.id)) ids.add(drive.id);
      else shape.malformed = true;
    }
  }
  return { ids: [...ids].sort(), discoveryComplete: !shape.malformed, personalDriveUnavailable };
}

function mailContent(message, folderId, ownerTimeZone) {
  const received = microsoftMailTime(message.receivedDateTime, ownerTimeZone);
  const from = message?.from?.emailAddress;
  const to = (message?.toRecipients || []).map((recipient) => recipient?.emailAddress?.address).filter(Boolean);
  const rawBody = String(message?.body?.content || message?.bodyPreview || "");
  const body = message?.body?.contentType === "html" || /<[^>]+>/.test(rawBody)
    ? stripMarkup(rawBody).trim()
    : rawBody.trim();
  return [
    `Outlook folder: ${folderId}`,
    message.subject ? `Subject: ${message.subject}` : null,
    from?.address ? `From: ${from.name || ""} <${from.address}>`.trim() : null,
    to.length ? `To: ${to.join(", ")}` : null,
    message.receivedDateTime ? `Received: ${received?.text || message.receivedDateTime}` : null,
    "",
    body,
  ].filter((value) => value !== null).join("\n").trim();
}

function safeDownloadUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const allowed = [".sharepoint.com", ".1drv.com", ".onedrive.com", ".office.net", ".windows.net"];
  return allowed.some((suffix) => host.endsWith(suffix)) ? url.toString() : null;
}

async function driveItemDownloadUrl(driveId, item, auth) {
  const supplied = safeDownloadUrl(item?.["@microsoft.graph.downloadUrl"]);
  if (supplied) return supplied;
  const url = new URL(`${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}`);
  url.searchParams.set("$select", "id,name,@microsoft.graph.downloadUrl");
  const { data } = await providerJson("microsoft", url, auth);
  const resolved = safeDownloadUrl(data?.["@microsoft.graph.downloadUrl"]);
  if (!resolved) {
    throw new ProviderSyncError("microsoft", "Graph did not return a bounded HTTPS file download URL", {
      kind: "retryable", code: "download_url_unavailable",
    });
  }
  return resolved;
}

function resultWithSafePartialCursor(options, cursorSafe, extras = {}) {
  const result = providerSyncResult(options);
  return Object.freeze({
    ...result,
    ...extras,
    cursor_can_advance: Boolean(result.cursor_can_advance && cursorSafe && options.proposedCursor),
  });
}

function calendarWindow(now) {
  const value = typeof now === "function" ? now() : now;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError("Microsoft calendar now() returned an invalid time");
  const midnight = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(midnight - OUTLOOK_CALENDAR_PAST_DAYS * day).toISOString(),
    end: new Date(midnight + OUTLOOK_CALENDAR_FUTURE_DAYS * day).toISOString(),
  };
}

function normalizedCalendarCursor(value) {
  if (typeof value === "string" && value) {
    return {
      delta_link: value, window_start: null, window_end: null, id_type: null,
      event_ids: [], pending_event_ids: [],
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eventIds = Array.isArray(value.event_ids)
    ? [...new Set(value.event_ids.map(String).filter(Boolean))].sort()
    : [];
  return {
    delta_link: typeof value.delta_link === "string" && value.delta_link ? value.delta_link : null,
    window_start: typeof value.window_start === "string" ? value.window_start : null,
    window_end: typeof value.window_end === "string" ? value.window_end : null,
    id_type: value.id_type === IMMUTABLE_CALENDAR_ID_TYPE ? IMMUTABLE_CALENDAR_ID_TYPE : null,
    event_ids: eventIds,
    pending_event_ids: normalizePendingEventIds(value, eventIds),
  };
}

function pendingEventStateError() {
  return new ProviderSyncError("microsoft", "the Outlook pending-event cursor state is invalid", {
    kind: "retryable", code: "invalid_pending_event_state",
  });
}

function encodedPendingEventStateBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw pendingEventStateError();
  }
}

function normalizePendingEventIds(calendarCursor, eventIds) {
  if (!Object.hasOwn(calendarCursor, "pending_event_ids")) return [];
  const state = calendarCursor.pending_event_ids;
  if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== PENDING_EVENT_IDS_VERSION ||
      !Array.isArray(state.ids) || Object.keys(state).sort().join(",") !== "ids,version" ||
      state.ids.some((id) => typeof id !== "string" || id.length === 0) ||
      state.ids.length > OUTLOOK_CALENDAR_PENDING_EVENT_MAX_COUNT ||
      encodedPendingEventStateBytes(state) > OUTLOOK_CALENDAR_PENDING_EVENT_MAX_BYTES) {
    throw pendingEventStateError();
  }
  const normalized = [...new Set(state.ids)].sort();
  const eventInventory = new Set(eventIds);
  if (normalized.length !== state.ids.length || normalized.some((id, index) => id !== state.ids[index]) ||
      normalized.some((id) => !eventInventory.has(id))) {
    throw pendingEventStateError();
  }
  return normalized;
}

function pendingEventCursorState(eventIds) {
  const ids = [...new Set(eventIds)].sort();
  const state = { version: PENDING_EVENT_IDS_VERSION, ids };
  if (ids.length > OUTLOOK_CALENDAR_PENDING_EVENT_MAX_COUNT ||
      encodedPendingEventStateBytes(state) > OUTLOOK_CALENDAR_PENDING_EVENT_MAX_BYTES) {
    throw pendingEventStateError();
  }
  return state;
}

function calendarPrefer(timeZone = "UTC") {
  if (!SAFE_GRAPH_TIME_ZONE.test(String(timeZone || ""))) {
    throw new ProviderSyncError("microsoft", "an Outlook event returned an invalid original time zone", {
      kind: "retryable", code: "invalid_event_time_zone",
    });
  }
  return `IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="${timeZone}"`;
}

async function eventWithCivilAllDayTime(event, { accessToken, fetchImpl, ownerTimeZone }) {
  if (event?.isAllDay !== true || !event?.id) return event;
  const originalZone = microsoftLocalTimeZone(event.originalStartTimeZone || event?.start?.timeZone, ownerTimeZone);
  const returnedZone = String(event?.start?.timeZone || "");
  if (!originalZone || originalZone === returnedZone) return event;
  const url = `${GRAPH}/me/events/${encodeURIComponent(String(event.id))}`;
  const { data } = await providerJson("microsoft", url, {
    accessToken,
    fetchImpl,
    headers: { Prefer: calendarPrefer(originalZone) },
  });
  if (String(data?.id || "") !== String(event.id)) {
    throw new ProviderSyncError("microsoft", "the Outlook all-day event identity changed during civil-date recovery", {
      kind: "retryable", code: "event_identity_changed",
    });
  }
  return data;
}

async function fetchPendingCalendarChange(eventId, { accessToken, fetchImpl, ownerTimeZone }) {
  const url = `${GRAPH}/me/events/${encodeURIComponent(eventId)}`;
  try {
    const { data } = await providerJson("microsoft", url, {
      accessToken,
      fetchImpl,
      headers: { Prefer: CALENDAR_PREFER },
    });
    if (String(data?.id || "") !== eventId) {
      throw new ProviderSyncError("microsoft", "the Outlook pending event identity changed during retry", {
        kind: "retryable", code: "event_identity_changed",
      });
    }
    return {
      kind: "upsert",
      item: await eventWithCivilAllDayTime(data, { accessToken, fetchImpl, ownerTimeZone }),
    };
  } catch (error) {
    if (error instanceof ProviderSyncError && error.status === 404) {
      return { kind: "delete", removal_cause: "explicit_deletion",
        item: { id: eventId, "@removed": { reason: "not_found" } } };
    }
    if (error instanceof ProviderSyncError && error.outcome?.kind === "retryable") return null;
    throw error;
  }
}

function graphCalendarPerson(value) {
  const address = value?.emailAddress;
  if (!address?.address && !address?.name) return null;
  return {
    email: address.address || null,
    displayName: address.name || null,
  };
}

function graphCalendarTime(value, allDay) {
  if (!value?.dateTime) return null;
  return allDay
    ? { date: String(value.dateTime).slice(0, 10), timeZone: value.timeZone || null }
    : { dateTime: String(value.dateTime), timeZone: value.timeZone || null };
}

function googleShapedGraphEvent(event, ownerTimeZone) {
  // D2: the configured mailbox zone wins over the organizer's event origin.
  const zone = microsoftLocalTimeZone(ownerTimeZone, event?.originalStartTimeZone);
  const time = slot => event?.isAllDay === true ? graphCalendarTime(slot, true) : microsoftEventTime(slot, zone);
  const organizer = graphCalendarPerson(event?.organizer);
  const attendees = (event?.attendees || []).map((attendee) => {
    const person = graphCalendarPerson(attendee);
    if (!person) return null;
    return {
      ...person,
      resource: attendee?.type === "resource",
      responseStatus: attendee?.status?.response || "needsAction",
    };
  }).filter(Boolean);
  const joinUrl = event?.onlineMeeting?.joinUrl || null;
  const provider = event?.onlineMeetingProvider;
  const solution = provider === "teamsForBusiness" ? "Microsoft Teams" : provider || null;
  return {
    id: event?.id || null,
    status: MICROSOFT_ADD_ONLY ? "confirmed" : event?.isCancelled ? "cancelled" : "confirmed",
    summary: event?.subject || "",
    description: event?.body?.content || event?.bodyPreview || "",
    start: time(event?.start),
    end: time(event?.end),
    organizer,
    attendees,
    location: event?.location?.displayName || null,
    conferenceData: joinUrl || solution ? {
      entryPoints: joinUrl ? [{ entryPointType: "video", uri: joinUrl }] : [],
      conferenceSolution: solution ? { name: solution } : null,
    } : null,
    htmlLink: event?.webLink || null,
    updated: event?.lastModifiedDateTime || null,
    iCalUID: event?.iCalUId || null,
    recurringEventId: event?.seriesMasterId || null,
    originalStartTime: event?.originalStart ? graphCalendarTime({
      dateTime: event.originalStart,
      timeZone: event?.start?.timeZone || null,
    }, event?.isAllDay === true) : null,
    eventType: "default",
  };
}

function outlookCalendarInstruction(event, ownerTimeZone) {
  const eventId = event?.id ? String(event.id) : null;
  if (!eventId) return { kind: "skip" };
  const sourceId = `outlook:event:${eventId}`;
  const shaped = googleShapedGraphEvent(event, ownerTimeZone);
  const config = normalizeGoogleCalendarConfig({
    calendars: [{ id: "outlook", key: "outlook", label: "Outlook Calendar" }],
  });
  const instruction = buildGoogleCalendarEnvelope(shaped, {
    calendar: config.calendars[0],
    config,
  });
  if (instruction.kind === "delete") {
    return { kind: "delete", event_id: eventId, source_id: sourceId, removal_cause: instruction.removal_cause };
  }
  if (instruction.kind !== "upsert") return { ...instruction, event_id: eventId, source_id: sourceId };
  const envelope = instruction.envelope;
  return {
    kind: "upsert",
    event_id: eventId,
    source_id: sourceId,
    envelope: restampFirstPartySourceProvenance({
      ...envelope,
      source_type: "microsoft",
      source_id: sourceId,
      source_subtype: "outlook_calendar",
      title: envelope.title.replace(/ \u2014 /g, " - "),
      ...(event?.isCancelled && MICROSOFT_ADD_ONLY ? { content: `Status: Cancelled in Outlook. This meeting is not upcoming.\n${envelope.content}` } : {}),
      metadata: {
        ...envelope.metadata,
        workload: "outlook_calendar",
        status: event?.isCancelled ? "cancelled" : "confirmed",
        microsoft_event_id: eventId,
        microsoft_original_start_time_zone: event?.originalStartTimeZone || null,
        microsoft_original_end_time_zone: event?.originalEndTimeZone || null,
      },
    }, { sourceType: "microsoft", textSource: "native", textReliable: true }),
  };
}

// Status evidence has its own identity: a sparse provider signal must never
// overwrite retained source text. A later live update supersedes this record.
function retainedStatusDocument(sourceId, status, now) {
  const text = status === "cancelled" ? "Cancelled in Outlook. This meeting is not upcoming."
    : status === "active" ? "Present in the current Microsoft provider view. Earlier removal or cancellation observations are superseded."
    : "Deleted or moved out of the Microsoft provider view. The provider observation does not confirm deletion. Current location or schedule is unknown; retained calendar times are historical, not an upcoming appointment.";
  return providerEnvelope("microsoft", `status:${sourceId}`, {
    title: "Microsoft retained-item status",
    content: `Status: ${text}\nPrior source text remains in the Brain.`,
    occurredAt: new Date(typeof now === "function" ? now() : now).toISOString(),
    metadata: { workload: "retained_status", retained_source_id: sourceId, microsoft_status: status },
  });
}

async function syncOutlookCalendar({ accessToken, fetchImpl, cursor, now, ownerTimeZone, statusUpdates }) {
  const window = calendarWindow(now);
  const prior = normalizedCalendarCursor(cursor);
  const priorEventIds = new Set(prior?.event_ids || []);
  const pendingEventIds = new Set(prior?.pending_event_ids || []);
  const pendingChanges = [];
  for (const eventId of pendingEventIds) {
    const change = await fetchPendingCalendarChange(eventId, { accessToken, fetchImpl, ownerTimeZone });
    if (change) pendingChanges.push(change);
  }
  const sameWindow = prior?.window_start === window.start && prior?.window_end === window.end;
  let baseline = !prior?.delta_link || !sameWindow || prior?.id_type !== IMMUTABLE_CALENDAR_ID_TYPE;
  const initialUrl = () => {
    const url = new URL(`${GRAPH}/me/calendarView/delta`);
    url.searchParams.set("startDateTime", window.start);
    url.searchParams.set("endDateTime", window.end);
    return url.toString();
  };
  let page;
  let cursorRecovered = false;
  try {
    page = await deltaCollection({
      initialUrl: baseline ? initialUrl() : prior.delta_link,
      accessToken,
      fetchImpl,
      headers: { Prefer: CALENDAR_PREFER },
    });
  } catch (error) {
    if (!(!baseline && error instanceof ProviderSyncError && error.code === "cursor_expired")) throw error;
    baseline = true;
    cursorRecovered = true;
    page = await deltaCollection({
      initialUrl: initialUrl(), accessToken, fetchImpl,
      headers: { Prefer: CALENDAR_PREFER },
    });
  }

  const inventory = new Set(baseline ? [] : priorEventIds);
  const pending = new Set(pendingEventIds);
  for (const eventId of pending) inventory.add(eventId);
  const documents = new Map();
  const deletions = new Map();
  const warnings = [];
  let baselineIdentityIncomplete = false;
  for (const change of [...pendingChanges, ...page.changes]) {
    const eventId = change.item?.id ? String(change.item.id) : null;
    if (!eventId) {
      baselineIdentityIncomplete = true;
      warnings.push("An Outlook calendar event had no stable identity, so its cursor was withheld for retry.");
      continue;
    }
    const sourceId = `outlook:event:${eventId}`;
    const scopedDeletion = change.kind === "delete" &&
      (priorEventIds.has(eventId) || inventory.has(eventId));
    const event = change.kind === "upsert"
      ? await eventWithCivilAllDayTime(change.item, { accessToken, fetchImpl, ownerTimeZone })
      : change.item;
    if (MICROSOFT_ADD_ONLY && (change.kind === "delete" || event?.isCancelled)) {
      pending.delete(eventId);
      inventory.add(eventId);
      statusUpdates.delete(sourceId);
      deletions.delete(eventId);
      // Cancellation fields can be incomplete even with a start and subject.
      // Keep status separate; the runner admits complete first-seen evidence
      // only when authenticated inventory proves no prior text can be replaced.
      if (event?.isCancelled && !documents.has(eventId)) {
        const instruction = outlookCalendarInstruction(event, ownerTimeZone);
        if (instruction.kind === "upsert") documents.set(eventId, instruction.envelope);
      }
      documents.set(`status:${eventId}`, retainedStatusDocument(sourceId,
        event?.isCancelled ? "cancelled" : "removed_from_view", now));
      continue;
    }
    const instruction = change.kind === "delete"
      ? { kind: "delete", event_id: eventId, source_id: sourceId }
      : outlookCalendarInstruction(event, ownerTimeZone);
    if (instruction.kind === "delete") {
      if (change.kind === "delete" && !scopedDeletion) continue;
      if (change.kind !== "delete" && !priorEventIds.has(eventId) && !inventory.has(eventId)) continue;
      pending.delete(eventId);
      inventory.delete(eventId);
      documents.delete(eventId);
      deletions.set(eventId, { source_type: "microsoft", source_id: sourceId,
        removal_cause: change.kind === "delete" ? change.removal_cause || tombstoneCause(change.item)
          : instruction.removal_cause });
    } else if (instruction.kind === "upsert") {
      pending.delete(eventId);
      inventory.add(eventId);
      deletions.delete(eventId);
      documents.set(eventId, instruction.envelope);
      statusUpdates.set(sourceId, retainedStatusDocument(sourceId, event?.isCancelled ? "cancelled" : "active", now));
    } else if (instruction.reason === "no title, attendees or description; nothing to retrieve" &&
        (inventory.has(eventId) || priorEventIds.has(eventId))) {
      // A changed event whose searchable fields were all blanked must not
      // leave its prior document behind. Calendar-scoped removal review below
      // prevents unrelated mail or drive families from diluting this decision.
      pending.delete(eventId);
      inventory.delete(eventId);
      documents.delete(eventId);
      deletions.set(eventId, { source_type: "microsoft", source_id: sourceId, removal_cause: "blank_or_quality" });
    } else if (instruction.reason === "event has no start time" &&
        (inventory.has(eventId) || priorEventIds.has(eventId))) {
      // Missing start/time evidence is malformed provider data, not proof that
      // the owner intentionally blanked the event. Keep the known prior family
      // while the versioned pending set gives the next run an exact retry.
      inventory.add(eventId);
      pending.add(eventId);
      documents.delete(eventId);
      deletions.delete(eventId);
    } else {
      warnings.push("An Outlook calendar event was incomplete, so its prior document was retained and its cursor was withheld for retry.");
    }
  }
  if (baseline && !MICROSOFT_ADD_ONLY) {
    for (const eventId of prior?.event_ids || []) {
      if (!inventory.has(eventId)) {
        if (baselineIdentityIncomplete && !deletions.has(eventId)) {
          // A row with no immutable ID means absence cannot distinguish a
          // genuinely aged-out event from the malformed row. Keep unmatched
          // prior families visible for retry, while honoring exact tombstones.
          inventory.add(eventId);
        } else if (!deletions.has(eventId)) {
          deletions.set(eventId, {
            source_type: "microsoft",
            source_id: `outlook:event:${eventId}`,
            // A new window can omit a still-existing item. Cursor recovery with
            // the same window is even less specific; neither proves deletion.
            removal_cause: !sameWindow ? "window_exit" : "unknown",
          });
        }
      }
    }
  }
  return {
    documents: [...documents.values()],
    deletions: [...deletions.values()],
    eventIds: [...inventory].sort(),
    pendingEventState: pendingEventCursorState(pending),
    deferred_count: pending.size,
    deferred_reason_code: pending.size ? CALENDAR_EVENT_DEFERRED_REASON : null,
    deltaLink: page.deltaLink,
    provider_check_complete: !cursorRecovered,
    baseline,
    window,
    warnings,
    priorEventIds: [...priorEventIds].sort(),
  };
}

export async function syncMicrosoftGraph({
  accessToken,
  connection = null,
  fetchImpl = fetch,
  mailFolderIds = ["inbox"],
  mailStartAt = null,
  driveIds = [],
  siteIds = [],
  includePersonalDrive = true,
  includeCalendar = true,
  cursor = null,
  now = Date.now,
  ownerTimeZone = null,
} = {}) {
  if (!accessToken) throw new TypeError("Microsoft Graph accessToken is required");
  const mailStart = normalizeMailStartAt(mailStartAt);
  const mailTransition = mailStart === null ? null : {
    mail_start_at: mailStart, boundary: "inclusive", excluded_messages: 0, retained_tombstones: 0,
  };
  const documents = [];
  const deletions = [];
  const proposed = { mail: {}, drives: {} };
  const snapshotSourceIds = [];
  const gapCounts = new Map();
  const warnings = [];
  const auth = { accessToken, fetchImpl };
  const prior = cursor && typeof cursor === "object" ? cursor : {};
  const statusUpdates = new Map();
  const mailFolderLiveIds = [];
  let calendarCheckComplete = false;
  let deferredCount = 0;
  let deferredReasonCode = null;
  // A bounded mail walk cannot authorize absence-based deletion of an older
  // stored family, including after a reset or a configuration fingerprint change.
  let authoritativeSnapshot = !MICROSOFT_ADD_ONLY && mailStart === null;
  let providerCheckComplete = true;

  if (includeCalendar) {
    const calendar = await syncOutlookCalendar({
      accessToken, fetchImpl, cursor: prior.calendar, now, ownerTimeZone, statusUpdates,
    });
    providerCheckComplete = calendar.provider_check_complete;
    calendarCheckComplete = calendar.provider_check_complete && calendar.warnings.length === 0;
    documents.push(...calendar.documents);
    deletions.push(...calendar.deletions);
    warnings.push(...calendar.warnings);
    deferredCount = calendar.deferred_count;
    deferredReasonCode = calendar.deferred_reason_code;
    snapshotSourceIds.push(...calendar.eventIds.map((eventId) => `outlook:event:${eventId}`));
    proposed.calendar = {
      delta_link: calendar.deltaLink,
      window_start: calendar.window.start,
      window_end: calendar.window.end,
      id_type: IMMUTABLE_CALENDAR_ID_TYPE,
      event_ids: calendar.eventIds,
      pending_event_ids: calendar.pendingEventState,
    };
    if (!calendar.baseline) authoritativeSnapshot = false;
  }

  for (const folderValue of mailFolderIds || []) {
    const folderId = String(folderValue);
    const saved = prior?.mail?.[folderId] || null;
    if (saved) authoritativeSnapshot = false;
    const url = new URL(`${GRAPH}/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`);
    url.searchParams.set("$select", "id,subject,body,bodyPreview,receivedDateTime,webLink,parentFolderId,from,toRecipients");
    const page = await deltaCollection({
      initialUrl: saved || url.toString(), accessToken, fetchImpl,
      headers: { Prefer: MAIL_PREFER },
    });
    const latestMessages = new Map(page.items.map(message => [message?.id ? String(message.id) : Symbol("missing-message-identity"), message]));
    for (const message of latestMessages.values()) {
      if (mailTransition && mailReceivedAt(message?.receivedDateTime) < Date.parse(mailStart)) {
        mailTransition.excluded_messages++;
        continue;
      }
      if (mailTransition && (typeof message?.id !== "string" || !message.id.trim())) {
        throw new TypeError("Outlook mail has no immutable message identity; no mail cutover cursor may advance");
      }
      if (!message?.id) continue;
      const sourceId = `outlook:message:${message.id}`;
      snapshotSourceIds.push(sourceId);
      documents.push(providerEnvelope("microsoft", sourceId, {
        title: message.subject || "Outlook message",
        content: mailContent(message, folderId, ownerTimeZone),
        occurredAt: microsoftMailTime(message.receivedDateTime, ownerTimeZone)?.date || message.receivedDateTime || null,
        uri: message.webLink || `outlook://message/${encodeURIComponent(message.id)}`,
        metadata: { workload: "outlook", message_id: message.id, folder_id: folderId,
          original_received_at: message.receivedDateTime || null,
          time_zone: microsoftMailTime(message.receivedDateTime, ownerTimeZone)?.zone || null },
      }));
    }
    mailFolderLiveIds.push(new Set([...new Map(page.changes.filter(change => change.item?.id)
      .map(change => [String(change.item.id), change])).values()].filter(change => change.kind === "upsert")
      .map(change => `outlook:message:${change.item.id}`)));
    if (mailTransition) {
      // Tombstones lack receivedDateTime. The handover retains mail history;
      // removing it is a separate owner-approved operation, never a sync effect.
      mailTransition.retained_tombstones += page.deletions.length;
    }
    if (MICROSOFT_ADD_ONLY) {
      for (const message of page.deletions.filter(message => message?.id)) {
        const sourceId = `outlook:message:${message.id}`;
        documents.push(retainedStatusDocument(sourceId, "removed_from_view", now));
      }
    } else if (!mailTransition) {
      deletions.push(...page.deletions.filter((message) => message?.id).map((message) => ({
        source_type: "microsoft", source_id: `outlook:message:${message.id}`,
        removal_cause: tombstoneCause(message),
      })));
    }
    proposed.mail[folderId] = page.deltaLink;
  }

  // A live message in another configured folder supersedes a folder-scoped
  // tombstone. Such a move is never a provider identity conflict.
  const liveMail = new Set(mailFolderLiveIds.flatMap(ids => [...ids]));
  const deliveredMailIds = new Set(documents.filter(doc => doc.metadata?.workload === "outlook").map(doc => doc.source_id));
  for (const sourceId of liveMail) if (deliveredMailIds.has(sourceId)) {
    statusUpdates.set(sourceId, retainedStatusDocument(sourceId, "active", now));
  }

  const { ids: selectedDriveIds, discoveryComplete, personalDriveUnavailable } = await configuredDriveIds({
    driveIds, siteIds, includePersonalDrive, accessToken, fetchImpl,
  });
  if (personalDriveUnavailable) {
    providerCheckComplete = false;
    warnings.push("MICROSOFT_DRIVE_UNAVAILABLE: Microsoft returned HTTP 404 for OneDrive. Mail and calendar continued; files were not checked. https://financialbrain.ai/help/MICROSOFT_DRIVE_UNAVAILABLE");
  }
  if (!discoveryComplete) {
    providerCheckComplete = false;
    warnings.push("Microsoft drive discovery returned an unexpected response, so some configured files were not checked this run.");
  }
  for (const [priorDriveId, priorCursor] of Object.entries(prior?.drives || {})) {
    if (selectedDriveIds.includes(priorDriveId)) continue;
    authoritativeSnapshot = false;
    proposed.drives[priorDriveId] = priorCursor;
    warnings.push(
      `Microsoft drive ${priorDriveId} is not currently visible in the configured drive inventory. ` +
      "Its prior cursor and indexed documents were retained instead of treating lost access as deletion.",
    );
  }
  for (const driveId of selectedDriveIds) {
    const saved = prior?.drives?.[driveId] || null;
    if (saved) authoritativeSnapshot = false;
    const url = new URL(`${GRAPH}/drives/${encodeURIComponent(driveId)}/root/delta`);
    url.searchParams.set("$select", "id,name,file,folder,deleted,lastModifiedDateTime,webUrl,size,parentReference,@microsoft.graph.downloadUrl");
    const page = await deltaCollection({ initialUrl: saved || url.toString(), accessToken, fetchImpl });
    const latestItems = new Map(page.items.filter(item => item?.id).map(item => [String(item.id), item]));
    for (const item of latestItems.values()) {
      if (!item?.file || !item?.id) continue;
      const sourceId = `drive:item:${driveId}:${item.id}`;
      snapshotSourceIds.push(sourceId);
      const earlySkip = MICROSOFT_SKIP_UNREADABLE_FILES && microsoftFileSkipBeforeDownload(item);
      if (earlySkip) {
        gapCounts.set(earlySkip, (gapCounts.get(earlySkip) || 0) + 1);
        continue;
      }
      const downloadUrl = await driveItemDownloadUrl(driveId, item, auth);
      let extracted;
      try {
        extracted = await downloadProviderFile({
          provider: "microsoft", url: downloadUrl, accessToken: null, fetchImpl, name: item.name,
        });
      } catch (error) {
        // Metadata can be stale or absent. Keep the streaming byte guard too;
        // transport, auth, redirects and other safety failures still stop.
        if (!MICROSOFT_SKIP_UNREADABLE_FILES || error?.code !== "response_too_large") throw error;
        extracted = { ok: false, code: "file_too_large" };
      }
      if (!extracted.ok) {
        gapCounts.set(extracted.code, (gapCounts.get(extracted.code) || 0) + 1);
        continue;
      }
      documents.push(providerEnvelope("microsoft", sourceId, {
        title: item.name || "Microsoft drive item",
        content: extracted.content,
        occurredAt: item.lastModifiedDateTime || null,
        uri: item.webUrl || `microsoft-drive://drive/${encodeURIComponent(driveId)}/item/${encodeURIComponent(item.id)}`,
        metadata: {
          workload: "drive", drive_id: driveId, item_id: item.id,
          mime_type: item.file?.mimeType || extracted.response_media_type || null,
          size: Number(item.size || 0),
          ...extracted.provenance,
        },
        textSource: extracted.provenance.text_source,
        textReliable: extracted.provenance.text_reliable,
      }));
    }
    if (!MICROSOFT_ADD_ONLY) deletions.push(...page.deletions.filter((item) => item?.id).map((item) => ({
      source_type: "microsoft", source_id: `drive:item:${driveId}:${item.id}`,
      removal_cause: tombstoneCause(item),
    })));
    proposed.drives[driveId] = page.deltaLink;
  }

  for (const [code, count] of gapCounts) {
    warnings.push(`MICROSOFT_FILE_SKIPPED: ${count} Microsoft drive file(s) were inventoried but not indexed because of ${code}. https://financialbrain.ai/help/MICROSOFT_FILE_SKIPPED`);
  }
  const skippedCount = [...gapCounts.values()].reduce((sum, count) => sum + count, 0);
  const operationalComplete = (MICROSOFT_SKIP_UNREADABLE_FILES || skippedCount === 0) && !warnings.some(warning => !warning.startsWith("MICROSOFT_FILE_SKIPPED:") &&
    !warning.startsWith("MICROSOFT_DRIVE_UNAVAILABLE:"));
  const uniqueDocuments = [...new Map(documents.map(doc => [doc.source_id, doc])).values()];
  const cursorSafe = Object.keys(proposed.mail).length + Object.keys(proposed.drives).length > 0 ||
    Boolean(proposed.calendar?.delta_link);
  const result = resultWithSafePartialCursor({
    provider: "microsoft", documents: uniqueDocuments, deletions, warnings,
    proposedCursor: proposed,
    deletionAuthority: "authoritative",
    complete: operationalComplete,
    walkComplete: operationalComplete,
    outcomeKind: operationalComplete ? "completed" : "partial",
  }, cursorSafe, {
    // A recovered 410 may save its new baseline, but the failed window is not
    // evidence of a quiet check. The runner also requires durable cursor save.
    provider_check_complete: cursorSafe && providerCheckComplete && operationalComplete,
    // The runner checks for preexisting status families before delivering
    // these replacements, including on reset. No source text is read back.
    status_updates: [...statusUpdates.values()],
    coverage_incomplete: personalDriveUnavailable || skippedCount > 0,
    skipped_count: skippedCount,
    skip_reasons: Object.fromEntries(gapCounts),
    calendar_check_complete: calendarCheckComplete,
    deferred_count: deferredCount,
    deferred_reason_code: deferredReasonCode,
    ...(mailTransition ? { mail_transition: mailTransition } : {}),
    authoritative_snapshot: authoritativeSnapshot,
    snapshot_source_ids: snapshotSourceIds,
    removal_review_scopes: includeCalendar && proposed.calendar ? [{
      label: "Outlook calendar",
      prior_source_ids: (prior?.calendar?.event_ids || []).map((eventId) => `outlook:event:${eventId}`),
      deletion_source_ids: deletions
        .map((item) => String(item?.source_id || ""))
        .filter((sourceId) => sourceId.startsWith("outlook:event:")),
    }] : [],
  });
  return scopeMicrosoftBindingResult(result, connection);
}

function scopeMicrosoftBindingResult(result, connection) {
  const binding = connection?.microsoft_binding;
  if (!binding) return result; // Existing installed identities remain byte-for-byte stable.
  const id = binding.active_binding_id;
  if (binding.schema_version !== 1 || !/^[a-f0-9]{32}$/.test(id || "") ||
      binding.bindings?.[id]?.state !== "active" ||
      !/^[a-f0-9]{64}$/.test(binding.bindings[id].account_fingerprint || "") ||
      binding.bindings[id].account_fingerprint !== connection.provider_metadata?.microsoft_account_fingerprint) {
    throw new ProviderSyncError("microsoft", "the active mailbox binding could not be verified", {
      kind: "unavailable", code: "account_identity_corrupt",
    });
  }
  const sourceId = value => String(value).replace(/^(outlook:(?:event|message):|drive:item:)/, `$1binding:${id}:`);
  const document = doc => {
    const retained = doc.metadata?.retained_source_id;
    return restampFirstPartySourceProvenance({
      ...doc,
      source_id: retained ? `status:${sourceId(retained)}` : sourceId(doc.source_id),
      metadata: { ...doc.metadata, microsoft_binding_id: id,
        ...(retained ? { retained_source_id: sourceId(retained) } : {}) },
    }, { sourceType: "microsoft", textSource: doc.text_source, textReliable: doc.text_reliable });
  };
  // New identities cannot overwrite retained legacy text or its status siblings.
  // Provider event IDs and delta URLs inside the cursor stay in Graph's namespace.
  return {
    ...result,
    documents: result.documents.map(document),
    deletions: result.deletions.map(item => ({ ...item, source_id: sourceId(item.source_id) })),
    status_updates: result.status_updates.map(document),
    snapshot_source_ids: result.snapshot_source_ids.map(sourceId),
    removal_review_scopes: result.removal_review_scopes.map(scope => ({ ...scope,
      prior_source_ids: scope.prior_source_ids.map(sourceId), deletion_source_ids: scope.deletion_source_ids.map(sourceId) })),
  };
}
