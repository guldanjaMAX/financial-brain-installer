/** Microsoft Graph delta adapter for Outlook and OneDrive or SharePoint bodies. */

import {
  createPaginationGuard, ProviderSyncError, providerEnvelope, providerJson, providerSyncResult,
} from "./provider-sync.mjs";
import {
  buildEnvelope as buildGoogleCalendarEnvelope,
  normalizeConfig as normalizeGoogleCalendarConfig,
} from "./google-calendar.mjs";
import { stripMarkup } from "../ingest/quality.mjs";
import { restampFirstPartySourceProvenance } from "../worker/src/lib/provenance-receipt.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAIL_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';
const CALENDAR_PREFER = 'outlook.body-content-type="text", outlook.timezone="UTC"';
export const OUTLOOK_CALENDAR_PAST_DAYS = 30;
export const OUTLOOK_CALENDAR_FUTURE_DAYS = 90;

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
    for (const item of data.value || []) {
      if (item?.["@removed"] || item?.deleted) {
        deletions.push(item);
        changes.push({ kind: "delete", item });
      } else {
        items.push(item);
        changes.push({ kind: "upsert", item });
      }
    }
    deltaLink = data["@odata.deltaLink"] || deltaLink;
    url = data["@odata.nextLink"] || null;
  }
  if (!deltaLink) {
    throw new ProviderSyncError(provider, "Graph did not return a terminal delta cursor", {
      kind: "retryable", code: "missing_delta_link",
    });
  }
  return { items, deletions, changes, deltaLink };
}

async function pagedGraphValues(url, auth) {
  const values = [];
  const guard = createPaginationGuard("microsoft");
  let next = url;
  while (next) {
    guard.visit(next);
    const { data } = await providerJson("microsoft", next, auth);
    values.push(...(data.value || []));
    next = data["@odata.nextLink"] || null;
  }
  return values;
}

async function configuredDriveIds({ driveIds, siteIds, includePersonalDrive, accessToken, fetchImpl }) {
  const ids = new Set((driveIds || []).map(String).filter(Boolean));
  const auth = { accessToken, fetchImpl };
  if (includePersonalDrive) {
    const { data } = await providerJson("microsoft", `${GRAPH}/me/drive?$select=id`, auth);
    if (data?.id) ids.add(String(data.id));
  }
  for (const siteId of siteIds || []) {
    const drives = await pagedGraphValues(`${GRAPH}/sites/${encodeURIComponent(siteId)}/drives?$select=id`, auth);
    for (const drive of drives) if (drive?.id) ids.add(String(drive.id));
  }
  return [...ids].sort();
}

function mailContent(message, folderId) {
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
    message.receivedDateTime ? `Received: ${message.receivedDateTime}` : null,
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
    return { delta_link: value, window_start: null, window_end: null, event_ids: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    delta_link: typeof value.delta_link === "string" && value.delta_link ? value.delta_link : null,
    window_start: typeof value.window_start === "string" ? value.window_start : null,
    window_end: typeof value.window_end === "string" ? value.window_end : null,
    event_ids: Array.isArray(value.event_ids)
      ? [...new Set(value.event_ids.map(String).filter(Boolean))].sort()
      : [],
  };
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

function googleShapedGraphEvent(event) {
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
    status: event?.isCancelled ? "cancelled" : "confirmed",
    summary: event?.subject || "",
    description: event?.body?.content || event?.bodyPreview || "",
    start: graphCalendarTime(event?.start, event?.isAllDay === true),
    end: graphCalendarTime(event?.end, event?.isAllDay === true),
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

function outlookCalendarInstruction(event) {
  const eventId = event?.id ? String(event.id) : null;
  if (!eventId) return { kind: "skip" };
  const sourceId = `outlook:event:${eventId}`;
  const shaped = googleShapedGraphEvent(event);
  const config = normalizeGoogleCalendarConfig({
    calendars: [{ id: "outlook", key: "outlook", label: "Outlook Calendar" }],
  });
  const instruction = buildGoogleCalendarEnvelope(shaped, {
    calendar: config.calendars[0],
    config,
  });
  if (instruction.kind === "delete") {
    return { kind: "delete", event_id: eventId, source_id: sourceId };
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
      metadata: {
        ...envelope.metadata,
        workload: "outlook_calendar",
        microsoft_event_id: eventId,
      },
    }, { sourceType: "microsoft", textSource: "native", textReliable: true }),
  };
}

async function syncOutlookCalendar({ accessToken, fetchImpl, cursor, now }) {
  const window = calendarWindow(now);
  const prior = normalizedCalendarCursor(cursor);
  const sameWindow = prior?.window_start === window.start && prior?.window_end === window.end;
  let baseline = !prior?.delta_link || !sameWindow;
  const initialUrl = () => {
    const url = new URL(`${GRAPH}/me/calendarView/delta`);
    url.searchParams.set("startDateTime", window.start);
    url.searchParams.set("endDateTime", window.end);
    return url.toString();
  };
  let page;
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
    page = await deltaCollection({
      initialUrl: initialUrl(), accessToken, fetchImpl,
      headers: { Prefer: CALENDAR_PREFER },
    });
  }

  const inventory = new Set(baseline ? [] : prior?.event_ids || []);
  const documents = new Map();
  const deletions = new Map();
  for (const change of page.changes) {
    const eventId = change.item?.id ? String(change.item.id) : null;
    if (!eventId) continue;
    const sourceId = `outlook:event:${eventId}`;
    const instruction = change.kind === "delete"
      ? { kind: "delete", event_id: eventId, source_id: sourceId }
      : outlookCalendarInstruction(change.item);
    if (instruction.kind === "delete") {
      inventory.delete(eventId);
      documents.delete(eventId);
      deletions.set(eventId, { source_type: "microsoft", source_id: sourceId });
    } else if (instruction.kind === "upsert") {
      inventory.add(eventId);
      deletions.delete(eventId);
      documents.set(eventId, instruction.envelope);
    } else if (inventory.has(eventId)) {
      // A changed event whose searchable fields were all blanked must not
      // leave its prior document behind. The common provider runner applies
      // the same aggregate removal cap and exact readback as a cancellation.
      inventory.delete(eventId);
      documents.delete(eventId);
      deletions.set(eventId, { source_type: "microsoft", source_id: sourceId });
    }
  }
  if (baseline) {
    for (const eventId of prior?.event_ids || []) {
      if (!inventory.has(eventId)) {
        deletions.set(eventId, {
          source_type: "microsoft",
          source_id: `outlook:event:${eventId}`,
        });
      }
    }
  }
  return {
    documents: [...documents.values()],
    deletions: [...deletions.values()],
    eventIds: [...inventory].sort(),
    deltaLink: page.deltaLink,
    baseline,
    window,
  };
}

export async function syncMicrosoftGraph({
  accessToken,
  fetchImpl = fetch,
  mailFolderIds = ["inbox"],
  driveIds = [],
  siteIds = [],
  includePersonalDrive = true,
  includeCalendar = true,
  cursor = null,
  now = Date.now,
} = {}) {
  if (!accessToken) throw new TypeError("Microsoft Graph accessToken is required");
  const documents = [];
  const deletions = [];
  const proposed = { mail: {}, drives: {} };
  const snapshotSourceIds = [];
  const gapCounts = new Map();
  const warnings = [];
  const auth = { accessToken, fetchImpl };
  const prior = cursor && typeof cursor === "object" ? cursor : {};
  let authoritativeSnapshot = true;

  if (includeCalendar) {
    const calendar = await syncOutlookCalendar({
      accessToken, fetchImpl, cursor: prior.calendar, now,
    });
    documents.push(...calendar.documents);
    deletions.push(...calendar.deletions);
    snapshotSourceIds.push(...calendar.eventIds.map((eventId) => `outlook:event:${eventId}`));
    proposed.calendar = {
      delta_link: calendar.deltaLink,
      window_start: calendar.window.start,
      window_end: calendar.window.end,
      event_ids: calendar.eventIds,
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
    for (const message of page.items) {
      if (!message?.id) continue;
      const sourceId = `outlook:message:${message.id}`;
      snapshotSourceIds.push(sourceId);
      documents.push(providerEnvelope("microsoft", sourceId, {
        title: message.subject || "Outlook message",
        content: mailContent(message, folderId),
        occurredAt: message.receivedDateTime || null,
        uri: message.webLink || `outlook://message/${encodeURIComponent(message.id)}`,
        metadata: { workload: "outlook", message_id: message.id, folder_id: folderId },
      }));
    }
    deletions.push(...page.deletions.filter((message) => message?.id).map((message) => ({
      source_type: "microsoft", source_id: `outlook:message:${message.id}`,
    })));
    proposed.mail[folderId] = page.deltaLink;
  }

  const selectedDriveIds = await configuredDriveIds({
    driveIds, siteIds, includePersonalDrive, accessToken, fetchImpl,
  });
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
    for (const item of page.items) {
      if (!item?.file || !item?.id) continue;
      const sourceId = `drive:item:${driveId}:${item.id}`;
      snapshotSourceIds.push(sourceId);
      const downloadUrl = await driveItemDownloadUrl(driveId, item, auth);
      const extracted = await downloadProviderFile({
        provider: "microsoft", url: downloadUrl, accessToken: null, fetchImpl, name: item.name,
      });
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
    deletions.push(...page.deletions.filter((item) => item?.id).map((item) => ({
      source_type: "microsoft", source_id: `drive:item:${driveId}:${item.id}`,
    })));
    proposed.drives[driveId] = page.deltaLink;
  }

  for (const [code, count] of gapCounts) {
    warnings.push(`${count} Microsoft drive file(s) were inventoried but not indexed because of ${code}.`);
  }
  const cursorSafe = Object.keys(proposed.mail).length + Object.keys(proposed.drives).length > 0 ||
    Boolean(proposed.calendar?.delta_link);
  return resultWithSafePartialCursor({
    provider: "microsoft", documents, deletions, warnings,
    proposedCursor: proposed,
    deletionAuthority: "authoritative",
    complete: warnings.length === 0,
  }, cursorSafe, {
    authoritative_snapshot: authoritativeSnapshot,
    snapshot_source_ids: snapshotSourceIds,
  });
}
