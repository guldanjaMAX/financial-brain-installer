// Settled D1-D4: add-only retention, mailbox-local time, counted skips, and work accounts only.
import test from "node:test";
import assert from "node:assert/strict";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { runProviderConnector, normalizeProviderResult } from "../connectors/provider-runtime.mjs";
import { parseProviderWithheldReason } from "../worker/src/lib/source-receipt.js";

// Real provider hosts are required by the download allowlist. All fetches are scripted.
globalThis.fetch = async () => { throw new Error("UNSCRIPTED_NETWORK_BLOCKED"); };
const G = "https://graph.microsoft.com/v1.0";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const json = value => Response.json(value);
const terminal = value => json({ value, "@odata.deltaLink": `${G}/terminal` });
const event = (id = "event") => ({ id, subject: "Synthetic meeting", originalStartTimeZone: "Pacific Standard Time",
  start: { dateTime: "2026-11-18T02:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-18T03:00:00.0000000", timeZone: "UTC" } });
const mail = (id = "message") => ({ id, subject: "Synthetic mail", bodyPreview: "Synthetic invoice amount 1200 dollars.",
  receivedDateTime: "2026-11-18T04:00:00Z" });
const opts = { accessToken: "synthetic-access", now: () => NOW, ownerTimeZone: "America/Los_Angeles",
  includePersonalDrive: false, includeCalendar: false, mailFolderIds: [], driveIds: [], siteIds: [] };
async function deliver(result, { stored = new Set(), now = NOW } = {}) {
  const calls = { sync: 0, saved: 0, reviews: 0, removes: 0, batches: 0 };
  const receipts = []; let state;
  const run = await runProviderConnector({ provider: "microsoft", source: "microsoft", now: () => new Date(now),
    resolveAccess: async () => ({ accessToken: "synthetic-access" }),
    sync: async () => { calls.sync++; return result; },
    saveState: async value => { calls.saved++; state = value; }, listStoredFamilies: async () => stored,
    sendBatch: async ({ docs }) => { calls.batches++; return { results: docs.map(doc => ({ source_id: doc.source_id, status: "created" })) }; },
    reviewRemovals: async () => { calls.reviews++; assert.fail("provider signals cannot request removal"); },
    removeDocuments: async () => { calls.removes++; assert.fail("provider signals cannot remove history"); },
    postReceipt: async (_base, _key, receipt) => receipts.push(receipt) });
  assert.equal(calls.sync, 1); assert.equal(calls.saved, 1);
  assert.equal(calls.reviews, 0); assert.equal(calls.removes, 0);
  return { run, calls, receipts, state };
}

test("F1/F2: over-limit metadata is counted before download; readable control is delivered", async () => {
  let pages = 0; const downloads = [];
  const result = await syncMicrosoftGraph({ ...opts, driveIds: ["drive"], fetchImpl: async url => {
    if (String(url).includes("/root/delta")) { pages++; return terminal([
      { id: "large", name: "large.pdf", size: 8.1 * 1024 * 1024, file: { mimeType: "application/pdf" } },
      { id: "readable", name: "readable.txt", size: 7.9 * 1024 * 1024, file: { mimeType: "text/plain" },
        "@microsoft.graph.downloadUrl": "https://fixture.sharepoint.com/readable" } ]); }
    downloads.push(String(url)); assert.equal(String(url), "https://fixture.sharepoint.com/readable");
    return new Response("Synthetic readable document with a fully recorded invoice amount of 1200 dollars.");
  } });
  assert.equal(pages, 1); assert.equal(downloads.length, 1);
  assert.equal(result.documents.length, 1); assert.equal(result.skipped_count, 1);
  assert.deepEqual(result.skip_reasons, { file_too_large: 1 });
  const f = await deliver(result);
  assert.equal(f.run.cursor_advanced, true); assert.equal(f.run.refresh_succeeded, true);
  assert.equal(f.receipts.at(-1).docs_refused, 1); assert.equal(f.receipts.at(-1).complete_sweep, false);
  assert.equal(parseProviderWithheldReason(f.receipts.at(-1).refusal_reason, "microsoft", 1).count, 1);
});

test("F2: unsupported, scanned, encrypted and unreadable files skip with reasons and save the cursor", async () => {
  let pages = 0; let downloads = 0;
  const extensions = ["jpg", "zip", "mp4", "doc", "pdf", "docx"];
  const result = await syncMicrosoftGraph({ ...opts, driveIds: ["drive"], fetchImpl: async url => {
    if (String(url).includes("/root/delta")) { pages++; return terminal([
      ...extensions.map(ext => ({ id: ext, name: `synthetic.${ext}`, size: 12, file: { mimeType: "application/octet-stream" },
        "@microsoft.graph.downloadUrl": `https://fixture.sharepoint.com/${ext}` })),
      { id: "control", name: "control.txt", file: {}, "@microsoft.graph.downloadUrl": "https://fixture.sharepoint.com/control" } ]); }
    downloads++; return new Response(String(url).endsWith("/control")
      ? "Synthetic readable control with enough useful words to be indexed and checked."
      : new Uint8Array([1, 2, 3]));
  } });
  assert.equal(pages, 1); assert.ok(downloads > 0);
  assert.equal(result.skipped_count, extensions.length); assert.equal(result.documents.length, 1);
  assert.equal(Object.values(result.skip_reasons).reduce((a, b) => a + b, 0), extensions.length);
  const f = await deliver(result); assert.equal(f.run.cursor_advanced, true);
});

for (const reason of ["deleted", "changed", "not_found"]) {
  test(`M3/M4: Outlook ${reason} tombstone retains text, has qualified status and no removal review`, async () => {
    let calls = 0;
    const result = await syncMicrosoftGraph({ ...opts, mailFolderIds: ["inbox"], fetchImpl: async () => {
      calls++; return terminal([{ id: "prior", "@removed": { reason } }, mail()]);
    } });
    assert.equal(calls, 1); assert.deepEqual(result.deletions, []);
    assert.equal(result.authoritative_snapshot, false);
    const status = result.documents.find(doc => doc.metadata?.retained_source_id === "outlook:message:prior");
    assert.ok(status); assert.match(status.content, /deleted|moved/i); assert.doesNotMatch(status.content, /confirmed deleted/i);
    assert.ok(result.documents.some(doc => doc.source_id === "outlook:message:message"));
    const f = await deliver(result, { stored: new Set(["microsoft:outlook:message:prior"]) });
    assert.equal(f.run.removed, 0);
  });
}

test("M5/F3: last duplicate wins before shared identity validation", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, mailFolderIds: ["inbox"], fetchImpl: async () => {
    calls++; return terminal([mail(), { ...mail(), subject: "Latest synthetic subject" }]);
  } });
  assert.equal(calls, 1); normalizeProviderResult("microsoft", result);
  assert.equal(result.documents.length, 1); assert.match(result.documents[0].title, /Latest/);
  await deliver(result);
});

test("F4: personal drive 404 keeps mail and calendar and names the file gap", async () => {
  const calls = [];
  const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, includePersonalDrive: true,
    mailFolderIds: ["inbox"], fetchImpl: async url => {
      calls.push(new URL(url).pathname);
      if (String(url).includes("/me/drive?")) return Response.json({ error: { code: "ResourceNotFound", message: "Synthetic drive unavailable" } }, { status: 404 });
      return terminal(String(url).includes("calendarView") ? [event()] : [mail()]);
    } });
  assert.equal(calls.length, 3); assert.equal(result.documents.length, 2);
  assert.ok(result.warnings.some(line => /MICROSOFT_DRIVE_UNAVAILABLE/.test(line)));
  const f = await deliver(result); assert.ok(f.state.cursor.mail.inbox); assert.ok(f.state.cursor.calendar.delta_link);
  assert.equal(f.receipts.at(-1).provider_check_complete, false, "missing file workload is not a complete provider check");
});

for (const [zone, expectedDate, expectedTime, expectedZone] of [
  ["Pacific Standard Time", "2026-11-17", "6:00 PM", "America/Los_Angeles"],
  ["US Mountain Standard Time", "2026-11-17", "7:00 PM", "America/Phoenix"],
  ["tzone://Microsoft/Custom", "2026-11-17", "6:00 PM", "America/Los_Angeles"],
  ["Customized Time Zone", "2026-11-17", "6:00 PM", "America/Los_Angeles"],
  ["India Standard Time", "2026-11-18", "7:30 AM", "Asia/Kolkata"],
]) {
  test(`C2/C3: timed event uses civil date and named zone (${zone})`, async () => {
    let calls = 0;
    const result = await syncMicrosoftGraph({ ...opts, ownerTimeZone: ["tzone://Microsoft/Custom", "Customized Time Zone"].includes(zone) ? opts.ownerTimeZone : null,
      includeCalendar: true, fetchImpl: async () => {
      calls++; return terminal([{ ...event(), originalStartTimeZone: zone }]);
    } });
    assert.equal(calls, 1); assert.equal(result.documents[0].occurred_at, expectedDate);
    assert.ok(result.documents[0].content.includes(expectedTime)); assert.ok(result.documents[0].content.includes(expectedZone));
  });
}

test("ADD-3: 8 pm Pacific mail keeps local civil date and named Received zone", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, mailFolderIds: ["inbox"], fetchImpl: async () => { calls++; return terminal([mail()]); } });
  assert.equal(calls, 1); assert.equal(result.documents[0].occurred_at, "2026-11-17");
  assert.match(result.documents[0].content, /Received:.*2026-11-17.*20:00.*America\/Los_Angeles/);
});

test("C4: a movable clock crossing UTC midnight never reconciles window exits as removals", async () => {
  let clock = Date.parse("2026-11-17T23:55:00Z"); let fetches = 0;
  const sync = cursor => syncMicrosoftGraph({ ...opts, cursor, now: () => clock, includeCalendar: true,
    fetchImpl: async () => { fetches++; return terminal(fetches === 1 ? [event("aged")] : [event("control")]); } });
  const first = await sync(null); clock += 10 * 60 * 1000;
  const second = await sync(first.proposed_cursor);
  assert.equal(fetches, 2); assert.notEqual(first.proposed_cursor.calendar.window_start, second.proposed_cursor.calendar.window_start);
  assert.deepEqual(second.deletions, []); assert.equal(second.authoritative_snapshot, false);
  await deliver(second, { stored: new Set(["microsoft:outlook:event:aged"]) });
});

test("C6: organizer cancellation is kept and clearly marked cancelled", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, fetchImpl: async () => {
    calls++; return terminal([{ ...event("cancelled"), isCancelled: true }, event("control")]);
  } });
  assert.equal(calls, 1); assert.deepEqual(result.deletions, []);
  const cancelled = result.documents.find(doc => doc.source_id === "outlook:event:cancelled");
  assert.ok(cancelled); assert.equal(cancelled.metadata.status, "cancelled"); assert.match(cancelled.content, /cancelled/i);
  await deliver(result);
});

test("F3/C6: sparse cancellation and tombstone keep prior text through separate status evidence", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, fetchImpl: async () => {
    calls++; return terminal([{ id: "cancelled", isCancelled: true }, { id: "removed", "@removed": { reason: "deleted" } }, event("control")]);
  } });
  assert.equal(calls, 1); assert.deepEqual(result.deletions, []);
  assert.ok(result.documents.some(doc => doc.metadata.retained_source_id === "outlook:event:cancelled" && /cancelled/i.test(doc.content)));
  assert.ok(result.documents.some(doc => doc.metadata.retained_source_id === "outlook:event:removed" && !/confirmed deleted/i.test(doc.content)));
  await deliver(result, { stored: new Set(["microsoft:outlook:event:cancelled", "microsoft:outlook:event:removed"]) });
});

test("M4/C6: restore after a reset supersedes retained removal and cancellation status", async () => {
  for (const workload of ["mail", "calendar"]) {
    const stored = new Map(); let calls = 0;
    const sync = rows => syncMicrosoftGraph({ ...opts, includeCalendar: workload === "calendar",
      mailFolderIds: workload === "mail" ? ["inbox"] : [], cursor: null,
      fetchImpl: async () => { calls++; return terminal(rows); } });
    const first = await sync([{ id: "restored", ...(workload === "mail" ? { "@removed": { reason: "deleted" } } : { isCancelled: true }) }]);
    const run = result => runProviderConnector({ provider: "microsoft", source: "microsoft", now: () => new Date(NOW),
      resolveAccess: async () => ({ accessToken: "synthetic-access" }), sync: async () => result,
      saveState() {}, listStoredFamilies: async () => new Set([...stored.keys()].map(id => `microsoft:${id}`)),
      sendBatch: async ({ docs }) => { docs.forEach(doc => stored.set(doc.source_id, doc));
        return { results: docs.map(doc => ({ source_id: doc.source_id, status: "updated" })) }; }, postReceipt() {} });
    await run(first);
    const original = `outlook:${workload === "mail" ? "message" : "event"}:restored`;
    assert.notEqual(stored.get(`status:${original}`).metadata.microsoft_status, "active");
    await run(await sync([workload === "mail" ? mail("restored") : event("restored")]));
    assert.equal(calls, 2, "the reset took a fresh provider baseline");
    assert.equal(stored.get(`status:${original}`).metadata.microsoft_status, "active", "old status must not survive a live restore");
    assert.ok(stored.has(original), "restored source text is retained too");
  }
});

for (const fileGap of ["skip", "missing-drive"]) {
  test(`F1/F4: known calendar deferral survives independent file ${fileGap}`, async () => {
    let fetches = 0;
    const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, includePersonalDrive: fileGap === "missing-drive",
      driveIds: fileGap === "skip" ? ["drive"] : [], cursor: { calendar: { event_ids: ["pending"], id_type: "immutable" } },
      fetchImpl: async url => {
        fetches++;
        if (String(url).includes("calendarView")) return terminal([{ id: "pending", subject: "Synthetic pending event", start: null }]);
        if (String(url).includes("/me/drive?")) return Response.json({}, { status: 404 });
        assert.match(String(url), /root\/delta/);
        return terminal([{ id: "too-large", name: "synthetic.pdf", size: 9 * 1024 * 1024, file: {} }]);
      } });
    assert.equal(fetches, 2); assert.equal(result.deferred_count, 1);
    const f = await deliver(result);
    assert.equal(f.run.cursor_advanced, true); assert.deepEqual(f.state.cursor.calendar.pending_event_ids.ids, ["pending"]);
    assert.equal(f.receipts.at(-1).provider_check_complete, fileGap === "skip");
  });
}

test("F1: missing size metadata still respects the streaming cap and saves a counted skip", async () => {
  let pages = 0; let downloads = 0;
  const result = await syncMicrosoftGraph({ ...opts, driveIds: ["drive"], fetchImpl: async url => {
    if (String(url).includes("/root/delta")) { pages++; return terminal([{ id: "stream", name: "synthetic.txt", file: {},
      "@microsoft.graph.downloadUrl": "https://fixture.sharepoint.com/stream" }]); }
    downloads++; return new Response(new Uint8Array(8 * 1024 * 1024 + 1));
  } });
  assert.equal(pages, 1); assert.equal(downloads, 1); assert.deepEqual(result.skip_reasons, { file_too_large: 1 });
  const f = await deliver(result); assert.equal(f.run.cursor_advanced, true); assert.equal(f.receipts.at(-1).docs_refused, 1);
});

test("F3: repeated drive items deliver only the last version", async () => {
  let pages = 0; const downloads = [];
  const item = version => ({ id: "repeated", name: "synthetic.txt", file: {},
    "@microsoft.graph.downloadUrl": `https://fixture.sharepoint.com/${version}` });
  const result = await syncMicrosoftGraph({ ...opts, driveIds: ["drive"], fetchImpl: async url => {
    if (String(url).includes("/root/delta")) { pages++; return json({ value: [item("first")], "@odata.nextLink": `${G}/drive-page-two` }); }
    if (String(url).endsWith("drive-page-two")) { pages++; return terminal([item("last")]); }
    downloads.push(String(url)); return new Response("Synthetic latest readable drive content with complete financial evidence.");
  } });
  assert.equal(pages, 2); assert.deepEqual(downloads, ["https://fixture.sharepoint.com/last"]);
  assert.equal(result.documents.length, 1); normalizeProviderResult("microsoft", result); await deliver(result);
});

for (const original of ["Pacific Standard Time", "tzone://Microsoft/Custom", "Customized Time Zone"]) {
  test(`C3/C10: all-day civil date uses a supported recovery zone (${original})`, async () => {
    const calls = [];
    const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, fetchImpl: async (url, init) => {
      calls.push({ path: new URL(url).pathname, prefer: init.headers.Prefer });
      const base = { id: "all-day", subject: "Synthetic all-day event", isAllDay: true, originalStartTimeZone: original };
      if (String(url).includes("calendarView")) return terminal([{ ...base,
        start: { dateTime: "2026-11-18T08:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-19T08:00:00", timeZone: "UTC" } }]);
      assert.match(init.headers.Prefer, /outlook.timezone="America\/Los_Angeles"/);
      assert.doesNotMatch(init.headers.Prefer, /tzone:|Customized/);
      return json({ ...base, start: { dateTime: "2026-11-18T00:00:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-11-19T00:00:00", timeZone: "America/Los_Angeles" } });
    } });
    assert.equal(calls.length, 2); assert.equal(result.documents[0].occurred_at, "2026-11-18");
    assert.match(result.documents[0].content, /all day/); assert.deepEqual(result.deletions, []);
  });
}

test("C3: Phoenix has no DST while Pacific uses the offset at the event instant", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, fetchImpl: async () => {
    calls++; return terminal(["Pacific Standard Time", "US Mountain Standard Time"].map((zone, index) => ({ ...event(`summer-${index}`),
      originalStartTimeZone: zone, start: { dateTime: "2027-07-18T02:00:00", timeZone: "UTC" },
      end: { dateTime: "2027-07-18T03:00:00", timeZone: "UTC" } })));
  } });
  assert.equal(calls, 1); assert.equal(result.documents.length, 2);
  assert.ok(result.documents.every(doc => doc.occurred_at === "2027-07-17" && /7:00 PM/.test(doc.content)));
});

test("C2/C3: stored local time keeps the exact UTC offset for DST-fold ordering", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, includeCalendar: true, fetchImpl: async () => {
    calls++; return terminal([event()]);
  } });
  assert.equal(calls, 1); assert.match(result.documents[0].metadata.start, /2026-11-17T18:00:00-08:00$/);
});

test("F2: real scan bytes and a scripted password-locked parser outcome are counted skips", async () => {
  const { scanPdf } = await import("./fixtures/scan-pdf.mjs");
  const { extractProviderFile } = await import("../connectors/provider-file.mjs");
  const { extractPdf } = await import("../ingest/formats.mjs");
  const { register } = await import("../ingest/extract.mjs");
  let lockedParserCalls = 0; let downloads = 0;
  // A real encrypted source is a field gate. Script its parser's documented
  // PasswordException at the existing extraction seam, keeping delivery real.
  register(".pdf", async (bytes, options) => {
    if (bytes.toString() !== "synthetic-locked-parser-input") return extractPdf(bytes, options);
    return extractPdf(bytes, options, { pdfPassImpl: async () => {
      lockedParserCalls++; throw Object.assign(new Error("Synthetic password required"), { name: "PasswordException" });
    } });
  }, "pdf", { binary: true });
  try {
    const bodies = { scan: scanPdf(), locked: Buffer.from("synthetic-locked-parser-input"),
      readable: Buffer.from("Synthetic invoice records the approved amount of 1200 dollars with complete readable evidence.") };
    const readableProbe = await extractProviderFile(bodies.readable, "readable.txt", { provider: "microsoft" });
    assert.ok(readableProbe.ok, JSON.stringify({ code: readableProbe.code, reason: readableProbe.reason }));
    const result = await syncMicrosoftGraph({ ...opts, driveIds: ["drive"], fetchImpl: async url => {
      if (String(url).includes("/root/delta")) return terminal(Object.keys(bodies).map(id => ({ id, name: `${id}.${id === "readable" ? "txt" : "pdf"}`, file: {},
        "@microsoft.graph.downloadUrl": `https://fixture.sharepoint.com/${id}` })));
      downloads++; return new Response(bodies[new URL(url).pathname.slice(1)]);
    } });
    assert.equal(downloads, 3); assert.equal(lockedParserCalls, 1);
    assert.equal(result.skipped_count, 2); assert.equal(result.documents.length, 1);
    assert.ok(result.documents[0].content.includes("1200")); await deliver(result);
  } finally { register(".pdf", extractPdf, "pdf", { binary: true }); }
});

test("F4 CLI: optional drive 404 prints the named gap and help link after saving Outlook progress", async t => {
  const { cmdIngestProvider } = await import("../brain.mjs");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(homedir(), "drive-gap-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const keyPath = join(home, "fixture-admin-key"); writeFileSync(keyPath, ["synthetic", "admin", "proof"].join("-"), { mode: 0o600 });
  const manifestPath = join(home, "brain.manifest.json");
  const manifest = { client: { timezone: "America/Los_Angeles" }, brain: { domain: "brain.invalid" },
    operations: { admin_key_secret: keyPath }, corpora: { microsoft: { enabled: true, mail_folder_ids: ["inbox"] } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const lines = []; let saves = 0; let sent = 0; let providerCalls = 0;
  t.mock.method(console, "log", line => lines.push(String(line)));
  t.mock.method(console, "warn", line => lines.push(String(line)));
  const result = await cmdIngestProvider(manifest, manifestPath, { from: "microsoft" }, {
    withSourceIngestLock: async (_options, run) => run({ assertOwned() {} }),
    resolveAdminKey: () => readFileSync(keyPath, "utf8"), resolveBaseUrl: async () => "https://brain.invalid",
    oauth: { providerAccessToken: async () => ({ accessToken: "synthetic-access" }), loadProviderSyncState: () => ({}),
      saveProviderSyncState: () => { saves++; } },
    sync: options => syncMicrosoftGraph({ ...options, now: () => NOW }),
    fetchImpl: async url => {
      providerCalls++;
      if (String(url).includes("/me/drive?")) return Response.json({}, { status: 404 });
      return terminal(String(url).includes("calendarView") ? [event()] : [mail()]);
    },
    requestIngestBatch: async ({ docs }) => { sent += docs.length; return { results: docs.map(doc => ({ source_id: doc.source_id, status: "created" })) }; },
    listStoredSourceFamilies: async () => new Set(), postSourceReceipt() {},
  });
  assert.equal(providerCalls, 3); assert.equal(saves, 1); assert.equal(sent, 2); assert.equal(result.cursor_advanced, true);
  assert.match(lines.join("\n"), /MICROSOFT_DRIVE_UNAVAILABLE/);
  assert.match(lines.join("\n"), /\/help\/MICROSOFT_DRIVE_UNAVAILABLE/);
  assert.doesNotMatch(lines.join("\n"), /0 item\(s\) withheld by design/);
});


test("D2: calendar display uses the mailbox zone when the event origin differs", async () => {
  let calls = 0;
  const result = await syncMicrosoftGraph({ ...opts, ownerTimeZone: "America/Phoenix", includeCalendar: true,
    fetchImpl: async () => { calls++; return terminal([event()]); } });
  assert.equal(calls, 1); assert.equal(result.documents[0].occurred_at, "2026-11-17");
  assert.match(result.documents[0].content, /7:00 PM/); assert.match(result.documents[0].content, /America\/Phoenix/);
  assert.match(result.documents[0].metadata.start, /19:00:00-07:00$/);
});

test("A7/D1: a replacement binding cannot overwrite old mail, event, file or status identities", async () => {
  const id = "c".repeat(32);
  const connection = { provider_metadata: { microsoft_account_fingerprint: "d".repeat(64) },
    microsoft_binding: { schema_version: 1, active_binding_id: id, bindings: {
      legacy: { state: "replaced", replaced_by: id, sync_states: {} },
      [id]: { state: "active", account_fingerprint: "d".repeat(64) } } } };
  let pages = 0;
  const result = await syncMicrosoftGraph({ ...opts, connection, includeCalendar: true, mailFolderIds: ["inbox"], driveIds: ["drive"],
    fetchImpl: async url => { pages++;
      if (String(url).includes("calendarView")) return terminal([event(), { id: "prior", isCancelled: true }]);
      if (String(url).includes("/messages/")) return terminal([mail(), { id: "prior", "@removed": { reason: "deleted" } }]);
      if (String(url).includes("/root/delta")) return terminal([{ id: "file", name: "synthetic.txt", file: {},
        "@microsoft.graph.downloadUrl": "https://fixture.sharepoint.com/control" }]);
      return new Response("Synthetic retained document with a recorded amount of 1200 dollars.");
    } });
  assert.equal(pages, 4); assert.deepEqual(result.deletions, []); assert.equal(result.authoritative_snapshot, false);
  const scoped = value => value.replace(/^(outlook:(?:event|message):|drive:item:)/, `$1binding:${id}:`);
  for (const raw of ["outlook:event:event", "outlook:message:message", "drive:item:drive:file"]) {
    assert.ok(result.documents.some(doc => doc.source_id === scoped(raw)), `new binding namespaces ${raw}`);
    assert.ok(!result.documents.some(doc => doc.source_id === raw));
  }
  for (const status of result.documents.filter(doc => doc.metadata?.workload === "retained_status")) {
    assert.equal(status.source_id, `status:${status.metadata.retained_source_id}`);
    assert.match(status.metadata.retained_source_id, new RegExp(`:binding:${id}:`));
  }
  const { provenanceReceiptValidationError } = await import("../worker/src/lib/provenance-receipt.js");
  for (const doc of [...result.documents, ...result.status_updates]) {
    assert.equal(provenanceReceiptValidationError(doc), null);
    assert.deepEqual(doc.metadata.provenance_receipt.root_ids, [`microsoft:${doc.source_id}`], "the namespace also binds provenance");
  }
  normalizeProviderResult("microsoft", result);
  await deliver(result, { stored: new Set(["microsoft:outlook:event:event", "microsoft:outlook:message:message", "microsoft:drive:item:drive:file"]) });
});
