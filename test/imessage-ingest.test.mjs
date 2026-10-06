// test/imessage-ingest.test.mjs
//
// The CLI wiring for WP-06, driven the way test/calendar-ingest.test.mjs
// drives calendar: the REAL command functions (cmdIngestImessage,
// cmdConnectImessage, cmdDisconnectImessage) run against a REAL synthetic
// chat.db (built here with node:sqlite, invented personas only), with only
// the outside world faked — the brain's batch-ingest endpoint, the source
// receipts, the freshness expectation, the admin key, and launchd (via a
// fake scheduler module). What this cannot prove: a genuine TCC denial from
// launchd and a live worker's credential gate; both are named in
// evidence/WP-06.md rather than papered over.

import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as imessage from "../connectors/imessage.mjs";
import {
  cmdConnectImessage,
  cmdDisconnectImessage,
  cmdIngestImessage,
  imessageRunReport,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };

/* The worker's own gate on `sources.last_complete_sweep_at`, restated here
   from worker/src/index.js handleSourceReceipt. A receipt that sets
   complete_sweep but cannot pass this is a flag that never lands, which is
   the shape of the defect this file now pins. */
const receiptEarnsSweep = (receipt) => receipt?.status === "ready" &&
  receipt?.complete_sweep === true && receipt?.walk_complete === true &&
  Object.hasOwn(receipt, "docs_refused") && Object.hasOwn(receipt, "docs_failed") &&
  receipt.docs_refused === 0 && receipt.docs_failed === 0 && !receipt.refusal_reason;

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-imessage-ingest-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = {
  manifest_version: 1,
  client: { slug: "acme", display_name: "Chris Vale", timezone: "America/Phoenix" },
  brain: { version: "0.1.21", domain: "brain.acme-example.test", worker_name: "acme-brain" },
  corpora: { imessage: { enabled: true } },
  operations: {},
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

/* ------------------------------------------------- the synthetic chat.db */
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
const macNs = (iso) => (Date.parse(iso) - MAC_EPOCH_MS) * 1e6;
const dbPath = join(sandbox, "chat.db");
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
    date INTEGER, is_from_me INTEGER, handle_id INTEGER
  );
  INSERT INTO handle (ROWID, id, country, service) VALUES
    (1, '+15551234567', 'us', 'iMessage'), (2, '+15559876543', 'us', 'SMS');
  INSERT INTO chat (ROWID, guid, display_name, style) VALUES
    (1, 'iMessage;-;+15551234567', NULL, 45), (2, 'SMS;-;+15559876543', NULL, 45);
  INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1),(2,2);
`);
let rowid = 0;
const addMessage = ({ guid, text, ts, fromMe = 0, handle = 1, chat = 1 }) => {
  rowid++;
  db.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
    .run(rowid, guid, text, macNs(ts), fromMe, handle);
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(chat, rowid);
};
addMessage({ guid: "IG-A1", text: "Are we still on for the Henderson kickoff Tuesday?", ts: "2026-03-02T17:00:00Z" });
addMessage({ guid: "IG-A2", text: "Yes, 2pm. Bringing the numbers.", ts: "2026-03-02T17:03:00Z", fromMe: 1 });
addMessage({ guid: "IG-B1", text: "Invoice #4521 cleared this morning", ts: "2026-03-02T18:00:00Z", handle: 2, chat: 2 });

/* ------------------------------------------------------- the fake brain */
function makeBrainFakes({ script = null } = {}) {
  const receipts = [];
  const batches = [];
  let call = 0;
  return {
    receipts,
    batches,
    options: {
      platform: "darwin",
      resolveAdminKey: () => "fixture-admin-key",
      resolveBaseUrl: async () => "https://brain.acme-example.test",
      postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return receipt; },
      requestIngestBatch: async ({ docs }) => {
        call++;
        batches.push(docs);
        const results = docs.map((doc, i) => ({
          source_id: doc.source_id,
          status: script ? script(doc, i, call) : "created",
          ...(script && script(doc, i, call) === "failed" ? { error: "scripted failure" } : {}),
        }));
        return { res: { ok: true, status: 200 }, raw: JSON.stringify({ results }) };
      },
    },
  };
}

function withImessageClock(fakes, nowIso) {
  const nowMs = Date.parse(nowIso);
  fakes.options.imessage = {
    ...imessage,
    captureOnce: (options) => imessage.captureOnce({ ...options, now: () => nowMs }),
  };
  return fakes;
}

try {
  /* ================= one capture pass through the real command ========== */
  {
    const fakes = makeBrainFakes();
    const result = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, fakes.options);
    check("the capture pass reads the synthetic history and reports counts",
      result.rows_seen === 3 && result.rows_pushed === 3 && result.watermark === 3, JSON.stringify(result));
    const sent = fakes.batches.flat();
    check("both conversations were sent as session documents keyed by first GUID",
      sent.length === 2 && sent.some((d) => d.source_id === "IG-A1") && sent.some((d) => d.source_id === "IG-B1"),
      JSON.stringify(sent.map((d) => d.source_id)));
    check("every document carries source_type imessage, so forget --source imessage scopes to it",
      sent.every((d) => d.source_type === "imessage"), JSON.stringify(sent.map((d) => d.source_type)));
    check("every native iMessage/SMS session carries its final imessage family identity",
      sent.every((d) => d.text_source === "native" && d.text_reliable === true &&
        d.metadata.provenance_receipt.status === "complete" &&
        JSON.stringify(d.metadata.provenance_receipt.root_ids) === JSON.stringify([`imessage:${d.source_id}`])),
      JSON.stringify(sent.map((d) => d.metadata.provenance_receipt)));
    check("the SMS thread stays tagged platform sms inside the imessage source",
      sent.find((d) => d.source_id === "IG-B1").metadata.platform === "sms");
    check("the owner's display name speaks for outbound messages",
      sent.find((d) => d.source_id === "IG-A1").content.includes("Chris Vale:"));
    check("an indexing receipt opened and a ready receipt closed the run, kind imessage",
      fakes.receipts.length === 2 && fakes.receipts[0].status === "indexing" &&
      fakes.receipts[1].status === "ready" && fakes.receipts.every((r) => r.kind === "imessage" && r.source === "imessage"),
      JSON.stringify(fakes.receipts));
    check("the ready receipt carries the document counts",
      fakes.receipts[1].docs_added === 2 && /2 conversation document\(s\) sent/.test(fakes.receipts[1].detail),
      JSON.stringify(fakes.receipts[1]));
    check("a full local database walk is measured without claiming all-time iMessage history",
      fakes.receipts[1].walk_complete === true && fakes.receipts[1].complete_sweep === true &&
      fakes.receipts[1].files_seen === 3 && fakes.receipts[1].docs_refused === 0 &&
      fakes.receipts[1].docs_failed === 0 &&
      !("confirmed_range" in fakes.receipts[1]) &&
      fakes.receipts[1].target_range?.from === "2026-03-02T17:00:00.000Z" &&
      fakes.receipts[1].target_range?.through === "2026-03-02T18:00:00.000Z" &&
      /cannot prove deleted, unavailable-device, or all-time provider history/.test(fakes.receipts[1].detail),
      JSON.stringify(fakes.receipts[1]));
    check("an unbounded walk from an empty watermark records the sweep the owner remedy promises",
      fakes.receipts[1].complete_sweep === true &&
      /this Mac's local Messages database is swept complete end to end/.test(fakes.receipts[1].detail),
      JSON.stringify(fakes.receipts[1]));
    check("that receipt passes the worker's own complete-sweep gate, so the flag can land",
      receiptEarnsSweep(fakes.receipts[1]), JSON.stringify(fakes.receipts[1]));
    check("capture state landed beside the manifest under the source's name",
      existsSync(join(sandbox, ".brain-ingest-imessage.json")));
  }
  {
    const fakes = makeBrainFakes();
    const again = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, fakes.options);
    check("a second pass is incremental: zero rows re-read, zero documents re-sent",
      again.rows_seen === 0 && fakes.batches.length === 0, JSON.stringify(again));
    check("an incremental catch-up closes its walk but does not invent a new historical range",
      fakes.receipts[1].walk_complete === true && fakes.receipts[1].complete_sweep === false &&
      !("confirmed_range" in fakes.receipts[1]) && !("target_range" in fakes.receipts[1]),
      JSON.stringify(fakes.receipts[1]));
    check("an incremental pass resumed from a watermark claims no sweep at all",
      receiptEarnsSweep(fakes.receipts[1]) === false, JSON.stringify(fakes.receipts[1]));
  }
  {
    const fakes = makeBrainFakes();
    const preview = await cmdIngestImessage(
      manifest, manifestPath,
      { "chat-db": dbPath, source: "imessage-preview", "dry-run": true },
      fakes.options,
    );
    check("an iMessage preview reports would-send volume without a key, receipt, send, or state write",
      preview.dry_run === true && preview.would_send === 2 &&
      fakes.receipts.length === 0 && fakes.batches.length === 0 &&
      !existsSync(join(sandbox, ".brain-ingest-imessage-preview.json")),
      JSON.stringify(preview));
  }

  /* ===== what "swept complete" means for a database that is only this Mac ===== */
  {
    // A second synthetic database, so the main one's watermark is untouched.
    // It carries the three row shapes a real chat.db always mixes together:
    // ordinary messages, tapback/attachment-only rows with no text, and rows
    // the walk cannot place in history at all.
    const rowsDbPath = join(sandbox, "chat-rows.db");
    const rowsDb = new DatabaseSync(rowsDbPath);
    rowsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
        date INTEGER, is_from_me INTEGER, handle_id INTEGER
      );
      INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15550001111', 'us', 'iMessage');
      INSERT INTO chat (ROWID, guid, display_name, style) VALUES (1, 'iMessage;-;+15550001111', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1);
    `);
    let rowsRowid = 0;
    const addRow = ({ guid, text, ts }) => {
      rowsRowid++;
      rowsDb.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
        .run(rowsRowid, guid, text, ts === null ? null : macNs(ts), 0, 1);
      rowsDb.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(1, rowsRowid);
      return rowsRowid;
    };
    addRow({ guid: "RW-1", text: "The Kessler estimate is ready whenever you are", ts: "2026-04-01T15:00:00Z" });
    // A tapback: a real row, read and classified, carrying no message text.
    addRow({ guid: "RW-2", text: null, ts: "2026-04-01T15:01:00Z" });
    addRow({ guid: "RW-3", text: "Thanks, opening it now", ts: "2026-04-01T15:02:00Z" });

    {
      const fakes = makeBrainFakes();
      await cmdIngestImessage(
        manifest, manifestPath,
        { "chat-db": rowsDbPath, source: "imessage-rows" },
        fakes.options,
      );
      const receipt = fakes.receipts.at(-1);
      check("tapbacks and attachment-only rows are named but do not withhold the sweep",
        receipt.complete_sweep === true && receipt.docs_refused === 0 &&
        /1 without text \(tapbacks\/attachments\)/.test(receipt.detail) &&
        /1 row\(s\) remain deliberately non-searchable/.test(receipt.detail) &&
        receiptEarnsSweep(receipt), JSON.stringify(receipt));
    }

    {
      // A row with no timestamp cannot be placed in history. That is a hole
      // the walk cannot describe, so it is a lost document and the sweep stops.
      addRow({ guid: "RW-4", text: "undated and therefore unplaceable", ts: null });
      const fakes = makeBrainFakes();
      await cmdIngestImessage(
        manifest, manifestPath,
        { "chat-db": rowsDbPath, source: "imessage-rows", reset: true },
        fakes.options,
      );
      const receipt = fakes.receipts.at(-1);
      check("a row the walk cannot place in history is a loss, and withholds the sweep",
        receipt.complete_sweep === false && receipt.docs_refused === 1 &&
        /1 unusable/.test(receipt.detail) && receiptEarnsSweep(receipt) === false,
        JSON.stringify(receipt));
    }

    {
      // --limit is the other half of the owner remedy. A capped pass has not
      // seen the whole database and must not claim it has.
      const fakes = makeBrainFakes();
      await cmdIngestImessage(
        manifest, manifestPath,
        { "chat-db": rowsDbPath, source: "imessage-rows", reset: true, limit: "2" },
        fakes.options,
      );
      const receipt = fakes.receipts.at(-1);
      check("--limit bounds the pass, so neither the walk nor the sweep is claimed",
        receipt.walk_complete === false && receipt.complete_sweep === false &&
        receiptEarnsSweep(receipt) === false, JSON.stringify(receipt));
    }

    rowsDb.close();
  }

  /* ===== what a sweep may claim: read end to end, delivered only this far ===== */
  {
    // Every fixture above is dated months in the past, so the six-hour quiet
    // rule drains it and the difference between "read" and "delivered" cannot
    // show. A real owner's Mac is never like that: the thread they were
    // texting on ten minutes ago survives finishStaleSessions, stays in local
    // state, and is not searchable yet. This database reproduces exactly that.
    const liveDbPath = join(sandbox, "chat-live.db");
    const liveDb = new DatabaseSync(liveDbPath);
    liveDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
        date INTEGER, is_from_me INTEGER, handle_id INTEGER
      );
      INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15552223333', 'us', 'iMessage');
      INSERT INTO chat (ROWID, guid, display_name, style) VALUES (1, 'iMessage;-;+15552223333', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1);
    `);
    let liveRowid = 0;
    const addLiveRow = ({ guid, text, ts }) => {
      liveRowid++;
      liveDb.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
        .run(liveRowid, guid, text, macNs(ts), 0, 1);
      liveDb.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(1, liveRowid);
    };
    const liveNow = "2026-09-25T22:00:00.000Z";
    const liveNowMs = Date.parse(liveNow);
    const minutesAgo = (n) => new Date(liveNowMs - n * 60_000).toISOString();
    const settledTs = "2026-05-04T12:00:00.000Z";
    addLiveRow({ guid: "LV-1", text: "Settled thread from last spring", ts: settledTs });
    addLiveRow({ guid: "LV-2", text: "still talking about the Danforth quote right now", ts: minutesAgo(10) });

    {
      const fakes = withImessageClock(makeBrainFakes(), liveNow);
      const result = await cmdIngestImessage(
        manifest, manifestPath,
        { "chat-db": liveDbPath, source: "imessage-live", reset: true },
        fakes.options,
      );
      const receipt = fakes.receipts.at(-1);
      const sent = fakes.batches.flat().map((d) => d.source_id);
      check("the live conversation is held, not closed early, so the walk changes no boundary",
        result.sessions_open === 1 && !("sessions_flushed" in result) &&
        sent.length === 1 && sent.includes("LV-1"), JSON.stringify({ result, sent }));
      check("an end-to-end walk with nothing lost still records the sweep its remedy promises",
        receipt.complete_sweep === true && receiptEarnsSweep(receipt), JSON.stringify(receipt));
      check("the sweep declares only what it delivered, and stops before the held conversation",
        receipt.target_range?.from === settledTs && receipt.target_range?.through === settledTs &&
        new RegExp(`swept complete end to end, delivered through ${settledTs}`).test(receipt.detail),
        JSON.stringify({ target_range: receipt.target_range, detail: receipt.detail }));
      check("the receipt says how many conversations are still open and what releases them",
        /1 conversation\(s\) still open; the capture ticks deliver each after six quiet hours or at the day boundary/
          .test(receipt.detail), receipt.detail);
      check("the receipt detail still fits the worker's 500-character column, caveat included",
        receipt.detail.length <= 500 &&
        /cannot prove deleted, unavailable-device, or all-time provider history/.test(receipt.detail),
        `${receipt.detail.length}: ${receipt.detail}`);
    }

    {
      // The normal every-minute tick: a resumed pass claims no sweep, and it
      // holds the open conversation exactly as the sweep did.
      addLiveRow({ guid: "LV-3", text: "one more thought before you send it", ts: minutesAgo(2) });
      const fakes = withImessageClock(makeBrainFakes(), liveNow);
      const result = await cmdIngestImessage(
        manifest, manifestPath,
        { "chat-db": liveDbPath, source: "imessage-live" },
        fakes.options,
      );
      const receipt = fakes.receipts.at(-1);
      check("an incremental tick still holds the open conversation and claims no sweep",
        result.sessions_open === 1 && fakes.batches.length === 0 &&
        receipt.complete_sweep === false && receiptEarnsSweep(receipt) === false,
        JSON.stringify({ result, receipt }));
    }

    {
      // --flush-sessions is the deliberate early close (disconnect uses it).
      // It sends the live conversation, and it claims no sweep at all: it read
      // no chat.db row, so it can prove nothing about the database.
      const fakes = withImessageClock(makeBrainFakes(), liveNow);
      await cmdIngestImessage(
        manifest, manifestPath,
        { source: "imessage-live", "flush-sessions": true },
        fakes.options,
      );
      const receipt = fakes.receipts.at(-1);
      check("a flush-only pass delivers the open conversation and claims no sweep",
        fakes.batches.flat().map((d) => d.source_id).includes("LV-2") &&
        receipt.complete_sweep === false && receipt.walk_complete === false &&
        !("target_range" in receipt) && receiptEarnsSweep(receipt) === false,
        JSON.stringify(receipt));
    }

    {
      // A preview must not report work it did not do, and must not invent an
      // early close to make the numbers look finished.
      const fakes = withImessageClock(makeBrainFakes(), liveNow);
      const chunks = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); return true; };
      let preview;
      try {
        preview = await cmdIngestImessage(
          manifest, manifestPath,
          { "chat-db": liveDbPath, source: "imessage-live-preview", "dry-run": true },
          fakes.options,
        );
      } finally {
        process.stdout.write = write;
      }
      const printed = chunks.join("");
      check("a dry run reports the held conversation and no early close it did not perform",
        preview.dry_run === true && preview.would_send === 1 &&
        !/closed early/.test(printed) && !/sessions_flushed/.test(printed) &&
        /1 conversation\(s\) still open/.test(printed) &&
        fakes.receipts.length === 0 && fakes.batches.length === 0,
        JSON.stringify({ preview, printed }));
    }

    liveDb.close();
  }

  /* ===== the detail the worker stores is built to its column, not hoped into it ===== */
  {
    // Every fixture here is small enough that the old single-string detail
    // fit by luck. A real Mac is not: 40k rows read in nine pages, five-digit
    // counts and three conversations still open measures 529 characters
    // against a 500-character column, and what fell off the end was the last
    // clause — the caveat about what chat.db cannot prove, which is the only
    // claim on this receipt that no structured field carries.
    const big = imessageRunReport({
      rowsSeen: 40_217, pages: 9, rowsPushed: 38_412, withoutText: 1588, unusable: 0,
      documentsSent: 2611, sessionsOpen: 3, watermark: 40_217,
      refusedDocs: 0, rowRefusals: 1588,
      completeSweep: true, walkComplete: true,
      deliveredThrough: "2026-09-16T22:41:09.000Z",
    });
    check("a 40k-row Mac with three open conversations fits the 500-character detail column",
      big.detail.length <= 500, `${big.detail.length}: ${big.detail}`);
    check("the caveat and the sweep claim are what the budget keeps, whole and last",
      /local chat\.db cannot prove deleted, unavailable-device, or all-time provider history$/.test(big.detail) &&
      /swept complete end to end, delivered through 2026-09-16T22:41:09\.000Z/.test(big.detail),
      `${big.detail.length}: ${big.detail}`);
    check("the still-open conversations are still counted, even when their release rule yields",
      /3 conversation\(s\) still open/.test(big.detail), big.detail);
    check("the console summary is unbudgeted and still names every count and the release rule",
      big.summary === "40217 new row(s) read in 9 page(s); 38412 sessionized; " +
        "1588 without text (tapbacks/attachments), 0 unusable; 2611 conversation document(s) sent; " +
        "3 conversation(s) still open; the capture ticks deliver each after six quiet hours or at the day boundary; " +
        "watermark 40217", big.summary);
  }

  /* ===== a media-marker row is read, never delivered, and never a bound ===== */
  {
    // MessageSessionizer.push drops a row whose whole text is a media marker,
    // so such a row produces no document and cannot be searched. The capture
    // loop nonetheless counted it as sessionized and let it advance the
    // delivered watermark, which put the receipt's target_range.through on a
    // message the owner can never retrieve — the exact over-claim the
    // delivered bound exists to prevent.
    const markerPath = join(sandbox, "chat-marker.db");
    const markerDb = new DatabaseSync(markerPath);
    markerDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
        date INTEGER, is_from_me INTEGER, handle_id INTEGER
      );
      INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15554443333', 'us', 'iMessage');
      INSERT INTO chat (ROWID, guid, display_name, style) VALUES (1, 'iMessage;-;+15554443333', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1);
    `);
    let markerRowid = 0;
    const addMarkerRow = ({ guid, text, ts }) => {
      markerRowid++;
      markerDb.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
        .run(markerRowid, guid, text, macNs(ts), 0, 1);
      markerDb.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(1, markerRowid);
    };
    const lastDelivered = "2026-05-04T12:05:00.000Z";
    addMarkerRow({ guid: "MK-1", text: "Sending the roof photos over now", ts: "2026-05-04T12:00:00.000Z" });
    addMarkerRow({ guid: "MK-2", text: "That is the flashing I meant", ts: lastDelivered });
    // The newest row in the database, and nothing but a marker.
    addMarkerRow({ guid: "MK-3", text: "[image]", ts: "2026-05-04T12:09:00.000Z" });

    const fakes = makeBrainFakes();
    const result = await cmdIngestImessage(
      manifest, manifestPath,
      { "chat-db": markerPath, source: "imessage-marker", reset: true },
      fakes.options,
    );
    const receipt = fakes.receipts.at(-1);
    const sent = fakes.batches.flat();
    check("a media-marker row is read and counted as attachment-only, not as sessionized",
      result.rows_seen === 3 && result.rows_pushed === 2 &&
      result.rows_skipped.no_text === 1, JSON.stringify(result));
    check("no document carries the bare media marker",
      sent.length === 1 && !/\[image\]/.test(sent[0].content), JSON.stringify(sent));
    check("the declared range ends at the last DELIVERED message, not the newest row",
      receipt.target_range?.through === lastDelivered &&
      receipt.target_range?.from === "2026-05-04T12:00:00.000Z",
      JSON.stringify({ target_range: receipt.target_range, detail: receipt.detail }));
    check("the sweep is still claimed: an attachment-only row is not a lost document",
      receipt.complete_sweep === true && receiptEarnsSweep(receipt) &&
      new RegExp(`delivered through ${lastDelivered}`).test(receipt.detail), receipt.detail);

    markerDb.close();
  }

  /* ===== the same chat.db, swept twice, must produce the same documents ===== */
  {
    // The reviewer's scenario, and the reason nothing is closed early: every
    // other split in message-session.mjs is decided by the data (the incoming
    // row's day and gap), so a re-walk of the same rows reproduces the same
    // source_ids. A wall-clock close does not: it would cut this thread at the
    // moment of the first sweep, then the re-sweep would group all four
    // messages into the FIRST document and leave the tail document orphaned
    // forever — nothing in worker/src dedupes or overlaps a
    // bounded_conversation_session. The six-hour quiet close is stood in for
    // by --flush-sessions here, which builds the identical envelope.
    const twicePath = join(sandbox, "chat-twice.db");
    const twiceDb = new DatabaseSync(twicePath);
    twiceDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
        date INTEGER, is_from_me INTEGER, handle_id INTEGER
      );
      INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15554445555', 'us', 'iMessage');
      INSERT INTO chat (ROWID, guid, display_name, style) VALUES (1, 'iMessage;-;+15554445555', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1);
    `);
    let twiceRowid = 0;
    const fixedAfternoon = Date.parse("2026-06-15T22:00:00.000Z"); // 15:00 America/Phoenix
    const addTwiceRow = ({ guid, text, minutes }) => {
      twiceRowid++;
      twiceDb.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
        .run(twiceRowid, guid, text, macNs(new Date(fixedAfternoon - minutes * 60_000).toISOString()), 0, 1);
      twiceDb.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(1, twiceRowid);
    };
    const sweepFlags = { "chat-db": twicePath, source: "imessage-twice", reset: true };
    const tickFlags = { "chat-db": twicePath, source: "imessage-twice" };
    const flushFlags = { source: "imessage-twice", "flush-sessions": true };
    const delivered = (fakes) => fakes.batches.flat().map((d) => ({
      source_id: d.source_id, messages: d.metadata.message_count,
    }));

    addTwiceRow({ guid: "TW-1", text: "Did the Ferris permit come back?", minutes: 100 });
    addTwiceRow({ guid: "TW-2", text: "Not yet, chasing it this afternoon", minutes: 90 });
    const firstPass = withImessageClock(makeBrainFakes(), "2026-06-15T23:00:00.000Z");
    await cmdIngestImessage(manifest, manifestPath, sweepFlags, firstPass.options);

    // Two ordinary cron ticks while the same conversation is still going.
    addTwiceRow({ guid: "TW-3", text: "They want the revised site plan first", minutes: 80 });
    const tickOne = withImessageClock(makeBrainFakes(), "2026-06-15T23:00:00.000Z");
    await cmdIngestImessage(manifest, manifestPath, tickFlags, tickOne.options);
    addTwiceRow({ guid: "TW-4", text: "Sending it over tonight", minutes: 70 });
    const tickTwo = withImessageClock(makeBrainFakes(), "2026-06-15T23:00:00.000Z");
    await cmdIngestImessage(manifest, manifestPath, tickFlags, tickTwo.options);

    // The quiet spell arrives and the conversation is delivered.
    const settle = withImessageClock(makeBrainFakes(), "2026-06-16T05:30:00.000Z");
    await cmdIngestImessage(manifest, manifestPath, flushFlags, settle.options);
    const firstRun = [firstPass, tickOne, tickTwo, settle].flatMap(delivered);

    // The owner runs the remedy again: --reset, no --limit, same database.
    const reSweep = withImessageClock(makeBrainFakes(), "2026-06-16T05:30:00.000Z");
    await cmdIngestImessage(manifest, manifestPath, sweepFlags, reSweep.options);
    const reSettle = withImessageClock(makeBrainFakes(), "2026-06-16T05:30:00.000Z");
    await cmdIngestImessage(manifest, manifestPath, flushFlags, reSettle.options);
    const secondRun = [reSweep, reSettle].flatMap(delivered);

    check("a re-sweep of the same chat.db produces the same conversation documents",
      JSON.stringify(firstRun) === JSON.stringify(secondRun) &&
      firstRun.length === 1 && firstRun[0].source_id === "TW-1" && firstRun[0].messages === 4,
      JSON.stringify({ firstRun, secondRun }));
    check("no document from the first sweep is orphaned by the second",
      firstRun.every((doc) => secondRun.some((later) => later.source_id === doc.source_id)),
      JSON.stringify({ firstRun, secondRun }));

    twiceDb.close();
  }

  /* ===== a local-midnight split is stable across a re-sweep ===== */
  {
    const midnightPath = join(sandbox, "chat-midnight.db");
    const midnightDb = new DatabaseSync(midnightPath);
    midnightDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
        date INTEGER, is_from_me INTEGER, handle_id INTEGER
      );
      INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15554446666', 'us', 'iMessage');
      INSERT INTO chat (ROWID, guid, display_name, style) VALUES (1, 'iMessage;-;+15554446666', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1);
    `);
    const midnightRows = [
      ["MD-1", "Still awake?", "2026-06-16T06:50:00.000Z"], // 23:50 Phoenix
      ["MD-2", "Yes, finishing the permit notes", "2026-06-16T06:55:00.000Z"],
      ["MD-3", "It just turned midnight", "2026-06-16T07:05:00.000Z"], // 00:05 Phoenix
      ["MD-4", "I will send them in the morning", "2026-06-16T07:10:00.000Z"],
    ];
    for (const [index, [guid, text, timestamp]] of midnightRows.entries()) {
      const row = index + 1;
      midnightDb.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
        .run(row, guid, text, macNs(timestamp), 0, 1);
      midnightDb.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(1, row);
    }

    const flags = { "chat-db": midnightPath, source: "imessage-midnight", reset: true };
    const flush = { source: "imessage-midnight", "flush-sessions": true };
    const sweepDocuments = async () => {
      const pass = withImessageClock(makeBrainFakes(), "2026-06-16T08:00:00.000Z");
      await cmdIngestImessage(manifest, manifestPath, flags, pass.options);
      const settle = withImessageClock(makeBrainFakes(), "2026-06-16T08:00:00.000Z");
      await cmdIngestImessage(manifest, manifestPath, flush, settle.options);
      return [pass, settle].flatMap((fakes) => fakes.batches.flat()).map((document) => ({
        source_id: document.source_id,
        messages: document.metadata.message_count,
      }));
    };

    const first = await sweepDocuments();
    const second = await sweepDocuments();
    check("a thread crossing local midnight is split into two stable documents",
      JSON.stringify(first) === JSON.stringify(second) &&
      JSON.stringify(first) === JSON.stringify([
        { source_id: "MD-1", messages: 2 },
        { source_id: "MD-3", messages: 2 },
      ]), JSON.stringify({ first, second }));

    midnightDb.close();
  }

  /* ===== a trailing tapback is not a delivered message ===== */
  {
    // first_row_at/last_row_at are recorded before the no-text skip, so the
    // newest ROW in a chat.db is routinely a tapback that never became a
    // document. The declared range must end at the newest message actually
    // delivered, not at that row.
    const tapbackPath = join(sandbox, "chat-tapback.db");
    const tapbackDb = new DatabaseSync(tapbackPath);
    tapbackDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
        date INTEGER, is_from_me INTEGER, handle_id INTEGER
      );
      INSERT INTO handle (ROWID, id, country, service) VALUES (1, '+15556667777', 'us', 'iMessage');
      INSERT INTO chat (ROWID, guid, display_name, style) VALUES (1, 'iMessage;-;+15556667777', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1);
    `);
    let tapbackRowid = 0;
    const addTapbackRow = ({ guid, text, ts }) => {
      tapbackRowid++;
      tapbackDb.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
        .run(tapbackRowid, guid, text, macNs(ts), 0, 1);
      tapbackDb.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(1, tapbackRowid);
    };
    addTapbackRow({ guid: "TP-1", text: "Roof crew confirmed for the 14th", ts: "2026-04-10T10:00:00Z" });
    addTapbackRow({ guid: "TP-2", text: "Perfect, I will tell the owner", ts: "2026-04-10T10:05:00Z" });
    addTapbackRow({ guid: "TP-3", text: null, ts: "2026-04-10T10:10:00Z" });

    const fakes = makeBrainFakes();
    await cmdIngestImessage(
      manifest, manifestPath,
      { "chat-db": tapbackPath, source: "imessage-tapback", reset: true },
      fakes.options,
    );
    const receipt = fakes.receipts.at(-1);
    check("the declared range ends on the newest delivered message, not on a trailing tapback",
      receipt.complete_sweep === true &&
      receipt.target_range?.through === "2026-04-10T10:05:00.000Z" &&
      /1 without text \(tapbacks\/attachments\)/.test(receipt.detail) &&
      receiptEarnsSweep(receipt), JSON.stringify(receipt));

    tapbackDb.close();
  }

  /* ================= refusals count; failures stop the watermark ======== */
  {
    addMessage({ guid: "IG-C1", text: "Here is that key: sk-fixture-notreal", ts: "2026-03-04T10:00:00Z" });
    const refusing = makeBrainFakes({ script: () => "refused" });
    const result = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, refusing.options);
    check("a credential-gate refusal is explicit and never completion-shaped",
      result.watermark === 4 && result.refused === 1 && result.documents_accepted === 0 &&
      result.outcome?.kind === "partial" && result.outcome?.complete === false &&
      refusing.receipts[1].status === "ready" && /credential gate/.test(refusing.receipts[1].refusal_reason || ""),
      JSON.stringify({ result, receipt: refusing.receipts[1] }));

    addMessage({ guid: "IG-D1", text: "And one more for the failure case", ts: "2026-03-05T10:00:00Z" });
    const failing = makeBrainFakes({ script: () => "failed" });
    let thrown = null;
    try {
      await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, failing.options);
    } catch (error) { thrown = error; }
    check("a document failure throws instead of silently advancing the watermark",
      /scripted failure/.test(thrown?.message), thrown?.message);
    check("the failed run closed its receipt as an error",
      failing.receipts.at(-1).status === "error" && /watermark stayed/.test(failing.receipts.at(-1).detail),
      JSON.stringify(failing.receipts));
    const retry = makeBrainFakes();
    const retried = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, retry.options);
    check("the next run retries exactly the unadvanced rows",
      retried.watermark === 5 && retry.batches.flat().some((d) => d.source_id === "IG-D1"),
      JSON.stringify(retried));
  }

  /* ================= the non-Mac refusal ================= */
  {
    let thrown = null;
    try {
      await cmdIngestImessage(manifest, manifestPath, {}, { platform: "win32" });
    } catch (error) { thrown = error; }
    check("a non-Mac machine gets the honest Mac-only statement, not a file error",
      /exists only on macOS/.test(thrown?.message), thrown?.message);
  }

  /* ================= brain connect imessage ================= */
  {
    // FDA denied: the walkthrough prints, nothing installs.
    const installs = [];
    const deniedModule = {
      ...imessage,
      defaultChatDbPath: () => dbPath,
      probeChatDb: () => ({
        ok: false, reason: "full_disk_access_denied",
        message: "macOS refused to open chat.db (EPERM). This is the Full Disk Access gate, not a missing file.",
      }),
    };
    const fakeScheduler = {
      installImessageScheduler: (path, opts) => {
        installs.push(path);
        return {
          cron: "* * * * *", expectedRefreshSeconds: 60, warnings: [],
          plistPath: "/fixture/plist", stdoutPath: "/fixture/out", stderrPath: "/fixture/err",
        };
      },
      removeImessageScheduler: () => ({ removed: true, loaded: false, stdoutPath: "/fixture/out", stderrPath: "/fixture/err" }),
    };
    let thrown = null;
    try {
      await cmdConnectImessage(manifestPath, {}, {
        platform: "darwin", imessage: deniedModule, imessageScheduler: fakeScheduler,
        resolveAdminKey: () => "fixture-admin-key",
        resolveBaseUrl: async () => "https://brain.acme-example.test",
        postSourceExpectation: async () => ({}),
      });
    } catch (error) { thrown = error; }
    check("connect refuses honestly when Full Disk Access is denied, and installs nothing",
      /Full Disk Access is not granted yet/.test(thrown?.message) && installs.length === 0, thrown?.message);
  }
  {
    // Happy path: probe passes, initial load runs, agent installs, freshness set.
    addMessage({ guid: "IG-E1", text: "Fresh message before connect", ts: "2026-03-06T10:00:00Z" });
    const fakes = makeBrainFakes();
    const expectations = [];
    const installs = [];
    const okModule = { ...imessage, defaultChatDbPath: () => dbPath };
    const fakeScheduler = {
      installImessageScheduler: (path) => {
        installs.push(path);
        return {
          cron: "* * * * *", expectedRefreshSeconds: 60, warnings: [],
          plistPath: "/fixture/plist", stdoutPath: "/fixture/out", stderrPath: "/fixture/err",
        };
      },
    };
    const installed = await cmdConnectImessage(manifestPath, {}, {
      ...fakes.options,
      imessage: okModule,
      imessageScheduler: fakeScheduler,
      postSourceExpectation: async (_base, _key, body) => { expectations.push(body); return body; },
    });
    check("connect runs the initial load before installing the agent",
      fakes.receipts.some((r) => r.status === "ready") && installs.length === 1 && installs[0] === manifestPath,
      JSON.stringify({ receipts: fakes.receipts.length, installs }));
    check("connect sets the every-minute freshness expectation on the brain",
      expectations.length === 1 && expectations[0].source === "imessage" &&
      expectations[0].kind === "imessage" && expectations[0].expected_refresh_seconds === 60,
      JSON.stringify(expectations));
    check("connect returns the installed plan", installed.cron === "* * * * *");
  }
  {
    // The manifest gate: connect refuses when the corpus is not declared.
    const disabledPath = join(sandbox, "disabled.manifest.json");
    writeFileSync(disabledPath, JSON.stringify({ ...manifest, corpora: {} }, null, 2));
    let thrown = null;
    try {
      await cmdConnectImessage(disabledPath, {}, { platform: "darwin" });
    } catch (error) { thrown = error; }
    check("connect requires corpora.imessage.enabled in the install record first",
      /corpora\.imessage\.enabled is not true/.test(thrown?.message), thrown?.message);
  }

  /* ================= brain disconnect imessage ================= */
  {
    // Leave one session open in the state file, then disconnect: the agent is
    // removed, the open session is flushed to the brain, and the freshness
    // expectation is cleared — in that order.
    const statePath = join(sandbox, ".brain-ingest-imessage.json");
    // Build the open-session snapshot through the real capture core: reset
    // state, run with "now" inside the gap so the last conversation stays open.
    rmSync(statePath, { force: true });
    const preload = makeBrainFakes();
    await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath, reset: true }, preload.options);
    const openState = imessage.loadCaptureState(statePath);
    // Force an open session deterministically: put one back.
    openState.sessionizer = [{
      platform: "imessage", thread_id: "iMessage;-;+15551234567", thread_title: "",
      category: "message", day: "2026-03-06", first_id: "IG-OPEN-1", last_id: "IG-OPEN-1",
      first_ts: "2026-03-06T10:00:00.000Z", last_ts: "2026-03-06T10:00:00.000Z",
      message_count: 1, content_chars: 20, participants: ["+15551234567"],
      lines: ["[2026-03-06T10:00:00.000Z] +15551234567: still thinking it over"],
    }];
    imessage.saveCaptureState(statePath, openState);

    const fakes = makeBrainFakes();
    const removals = [];
    const expectations = [];
    const fakeScheduler = {
      removeImessageScheduler: (path) => {
        removals.push(path);
        return { removed: true, loaded: false, stdoutPath: "/fixture/out", stderrPath: "/fixture/err" };
      },
    };
    const removed = await cmdDisconnectImessage(manifestPath, {}, {
      ...fakes.options,
      imessageScheduler: fakeScheduler,
      postSourceExpectation: async (_base, _key, body) => { expectations.push(body); return body; },
    });
    check("disconnect removes the LaunchAgent through the scheduler module",
      removed.removed === true && removals.length === 1 && removals[0] === manifestPath, JSON.stringify(removals));
    check("disconnect flushes the open session so the dormant thread becomes searchable",
      fakes.batches.flat().some((d) => d.source_id === "IG-OPEN-1") &&
      imessage.loadCaptureState(statePath).sessionizer.length === 0,
      JSON.stringify(fakes.batches.flat().map((d) => d.source_id)));
    check("the flush is a flush, not a capture: no chat.db rows were re-read",
      fakes.receipts.some((r) => /open-session flush/.test(r.detail || "")), JSON.stringify(fakes.receipts));
    check("disconnect clears the freshness expectation",
      expectations.length === 1 && expectations[0].expected_refresh_seconds === null, JSON.stringify(expectations));
  }
  {
    // Removal stays reachable when the brain is unreachable: the flush and
    // the expectation clear both fail, and removal still succeeds.
    const removals = [];
    const fakeScheduler = {
      removeImessageScheduler: (path) => {
        removals.push(path);
        return { removed: true, loaded: false, stdoutPath: "/fixture/out", stderrPath: "/fixture/err" };
      },
    };
    const removed = await cmdDisconnectImessage(manifestPath, {}, {
      platform: "darwin",
      imessageScheduler: fakeScheduler,
      resolveAdminKey: () => undefined,
      resolveBaseUrl: async () => { throw new Error("no route to brain"); },
      postSourceExpectation: async () => { throw new Error("unreachable"); },
    });
    check("disconnect still removes the agent when the brain is unreachable",
      removed.removed === true && removals.length === 1);
  }

  db.close();
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nimessage ingest wiring: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
