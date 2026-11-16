import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { cmdIngestRemote, credentialScannerFingerprint, describeLoadResult } from "../brain.mjs";
import { planDailyRefresh } from "../operations/daily-refresh-plan.mjs";
import * as drive from "../connectors/google-drive.mjs";
import { batchStream, splitOversized, prefetch, loadState as realLoadState, saveState as realSaveState } from "../ingest/run.mjs";

globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };
const stamp = "2026-11-01T00:00:00.000Z";
const content = "The owner reviewed this synthetic project record and approved the next scheduled review. This document records the decision and supporting evidence for the plan.";
const file = (id, parent = "reviewed", extra = {}) => ({ id, name: `${id}.txt`,
  mimeType: "text/plain", parents: [parent], size: String(content.length), modifiedTime: stamp, ...extra });
const folder = (id, parent) => ({ id, name: id, mimeType: drive.FOLDER_MIME, parents: parent ? [parent] : [] });

function harness({ state = {}, pages = {}, entries = [], fault = null } = {}) {
  state = { version: 1, done: {}, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true), ...state };
  const calls = [], sent = [], receipts = [], saves = [];
  const byId = new Map([folder("reviewed", "account-root"), folder("account-root"),
    ...Object.values(pages).flatMap((page) => (page.changes || []).map((change) => change.file).filter(Boolean)),
    ...entries].map((f) => [f.id, f]));
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input), id = decodeURIComponent(url.pathname.split("/").at(-1));
    const page = url.searchParams.get("pageToken");
    calls.push({ id, page, size: url.searchParams.get("pageSize"), media: url.searchParams.get("alt") === "media" });
    if (fault?.(url)) throw new Error("synthetic transport interruption");
    if (id === "startPageToken") return Response.json({ startPageToken: "seed-page" });
    if (id === "changes") { assert.ok(pages[page], "unexpected change page"); return Response.json(pages[page]); }
    assert.notEqual(id, "files", "incremental ingest must never list the corpus");
    if (url.searchParams.get("alt") === "media") return new Response(content);
    assert.ok(byId.has(id === "root" ? "account-root" : id), "unexpected metadata lookup");
    return Response.json(byId.get(id === "root" ? "account-root" : id));
  } };
  const connector = new Proxy(drive, { get(target, name) {
    if (["startPageToken", "getFileMetadata"].includes(name)) return (...args) => target[name](...args, opts);
    if (name === "listChanges") return (get, page) => target[name](get, page, opts);
    if (name === "listChangePage") return (get, page, config) => target[name](get, page, { ...config, ...opts });
    if (name === "changeScope") return (get, f, config) => target[name](get, f, { ...config, opts });
    if (name === "toEnvelope") return (get, f, config) => drive.toEnvelope(get, f, config, opts);
    if (name === "listRootedFiles") return async function* () { calls.push({ id: "full-walk" }); throw new Error("full walk reached"); };
    return target[name];
  } });
  const options = {
    verifyDriveIncrementalWorker: async () => {},
    readDriveFamily: async () => true,
    readCurrentIngestParts: async ({envelopes,proof}) => ({parts:envelopes || proof.parts,
      database:{instance:'1'.repeat(32),nonce:'2'.repeat(32),generation:1}}),
    drive: connector, getAccessToken: async () => randomBytes(16).toString("hex"),
    resolveBaseUrl: async () => "https://owner.invalid", resolveAdminKey: () => readFileSync(fixtureKeyPath, "utf8"),
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state,
      saveState: (_path, value) => saves.push(structuredClone(value)) }),
    sendBatches: async ({ groups, onResult }) => {
      const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
      for (const item of groups.flat()) { sent.push(item.envelope); tally.created++; onResult?.(item, { status: "created" }); }
      return tally;
    },
    listStoredSourceFamilies: async () => { throw new Error("corpus inventory reached"); },
    applyDriveRemovals: async () => { throw new Error("automatic removal reached"); },
    reconcileDocumentFamilies: async () => { throw new Error("automatic family removal reached"); },
    postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); },
    driveNow: () => Date.parse(stamp), write: () => {},
  };
  const manifest = { brain: { domain: "owner.invalid" }, corpora: { google_drive: { enabled: true, root_folder_ids: ["reviewed"] } },
    safety: { ocr: { enabled: false }, credential_scanner: { enabled: true } } };
  mkdirSync(process.env.HOME, { recursive: true });
  const manifestPath = join(mkdtempSync(join(process.env.HOME, "case-")), "manifest.json");
  const fixtureKeyPath = join(manifestPath, "..", ".brain-admin-key");
  const launchctl = join(manifestPath, "..", "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode:0o700 });
  options.launchctl = launchctl;
  writeFileSync(fixtureKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { state, calls, sent, receipts, saves, options, manifest, manifestPath,
    run: (flags = {}) => cmdIngestRemote(manifest, manifestPath, { from: "drive", ...flags }, options) };
}

test("first run seeds a token without a mirror walk or inventory and preserves indexed documents", async () => {
  const h = harness({ state: { done: { "drive:existing": "prior-version" } } });
  const result = await h.run();
  assert.ok(h.calls.some((c) => c.id === "startPageToken"), "token seeding decision reached");
  assert.equal(h.calls.some((c) => c.id === "full-walk"), false);
  assert.equal(h.state.sync_token, "seed-page");
  assert.equal(h.state.done["drive:existing"], "prior-version");
  assert.equal(h.sent.length, 0);
  assert.equal(result.seeded, true);
  assert.equal(h.receipts.at(-1).complete_sweep, false);
});

test("a stale saved token and changed policy still use scoped changes and stable document identity", async () => {
  const active = file("active"), nested = file("nested", "child");
  const h = harness({ state: { sync_token: "old-page", drive_last_full_sweep_at: "2020-01-01T00:00:00Z", drive_policy_fingerprint: "old" },
    pages: { "old-page": { changes: [active, nested].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } },
    entries: [folder("child", "reviewed")] });
  const result = await h.run();
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "feed decision reached");
  assert.equal(h.calls.some((c) => c.id === "startPageToken" || c.id === "full-walk"), false);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["active", "nested"]);
  assert.ok(h.sent.every((e) => e.source_type === "drive"));
  assert.equal(h.sent[1].metadata.folder, "reviewed/child");
  assert.ok(h.state.done["drive:active"]);
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.complete, true);
});

test("removal, trash and moves become decisions while a prior mass-removal pause cannot block additions", async () => {
  const active = file("active"), trashed = file("trashed", "reviewed", { trashed: true }), outside = file("outside", "elsewhere");
  const h = harness({ state: { sync_token: "old-page", done: { "drive:removed": "prior", "drive:outside": "prior" },
    drive_removal_review: { issue_code: "SAFETY_REVIEW_REQUIRED", uids: ["drive:prior-review"] }, removed: { "drive:prior-review": true } },
    entries: [folder("elsewhere", "account-root")], pages: { "old-page": { changes: [
      { fileId: "removed", removed: true }, ...[trashed, outside, active].map((f) => ({ fileId: f.id, file: f })) ], newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.equal(result.scanned, 4, "all decision points reached");
  assert.equal(result.pending_removals, 4);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["active"], "green addition control");
  assert.equal(h.state.done["drive:removed"], "prior");
  assert.equal(h.state.done["drive:outside"], "prior");
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.feed_caught_up, true);
  assert.equal(result.complete, false, "retained removal evidence must not become fresh complete coverage");
});

test("fresh ancestors override stale folder membership and preserve path exclusions", async () => {
  const outside = file("moved", "child"), included = file("control");
  const h = harness({ state: { sync_token: "old-page", drive_folders: { child: { name: "child", parents: ["reviewed"] } } },
    entries: [folder("child", "elsewhere"), folder("elsewhere", "account-root")],
    pages: { "old-page": { changes: [outside, included].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.ok(h.calls.some((c) => c.id === "child" && !c.media), "live ancestor decision reached");
  assert.equal(h.calls.some((c) => c.id === "moved" && c.media), false);
  assert.equal(h.state.drive_pending_removals["drive:moved"].reason, "left_configured_roots");
  assert.equal(result.created, 1);
});

test("large feeds stop after bounded pages and resume from the next saved page", async () => {
  const pages = {};
  for (let p = 0; p < 3; p++) pages[`page-${p}`] = {
    changes: Array.from({ length: 50 }, (_, i) => { const f = file(`item-${p}-${i}`); return { fileId: f.id, file: f }; }),
    ...(p === 2 ? { newStartPageToken: "done-page" } : { nextPageToken: `page-${p + 1}` }),
  };
  const h = harness({ state: { sync_token: "page-0" }, pages });
  const first = await h.run();
  assert.equal(first.scanned, 100);
  assert.equal(first.complete, false);
  assert.equal(h.state.sync_token, "page-2");
  assert.deepEqual(h.calls.filter((c) => c.id === "changes").map((c) => c.size), ["50", "50"]);
  const second = await h.run();
  assert.equal(second.scanned, 50);
  assert.equal(second.complete, true);
  assert.equal(h.sent.length, 150);
  assert.equal(h.state.sync_token, "done-page");
});

test("mid-file transport failure keeps the exact page and offset; resume keeps accepted work", async () => {
  let broken = true;
  const files = [file("first"), file("retry"), file("last")];
  const h = harness({ state: { sync_token: "old-page" }, fault: (url) => broken && url.pathname.endsWith("/retry") && url.searchParams.get("alt") === "media",
    pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  await assert.rejects(h.run());
  assert.ok(h.calls.some((c) => c.id === "retry" && c.media), "failed content decision reached");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["first"], "accepted green control survived");
  assert.equal(h.state.sync_token, "old-page");
  assert.equal(h.state.drive_change_page.offset, 1);
  assert.equal(h.state.drive_failures["drive:retry"].id, "retry");
  broken = false;
  const resumed = await h.run();
  assert.equal(resumed.complete, true);
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "resume consumes durable page metadata");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["first", "retry", "last"]);
  assert.equal(h.state.sync_token, "done-page");
  assert.deepEqual(h.state.drive_failures, {});
});

test("a time bound checkpoints within a page without claiming caught-up status", async () => {
  const files = [file("first"), file("second")];
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  let clock = Date.parse(stamp);
  h.options.driveNow = () => clock;
  h.options.driveLimits = { timeBudgetMs: 10 };
  const send = h.options.sendBatches;
  h.options.sendBatches = async (args) => { const result = await send(args); clock += 11; return result; };
  const first = await h.run();
  assert.equal(h.sent.length, 1, "green control reached writer");
  assert.equal(first.complete, false);
  assert.equal(h.state.sync_token, "old-page");
  assert.equal(h.state.drive_change_page.offset, 1);
  const second = await h.run();
  assert.equal(second.complete, true);
  assert.equal(h.sent.length, 2);
});

test("over-limit files have exact durable reasons and do not hold later additions", async () => {
  const files = [file("oversize", "reviewed", { size: String(drive.DOWNLOAD_LIMIT + 1) }), file("control")];
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.equal(result.scanned, 2, "size and green control decisions reached");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
  assert.equal(h.calls.some((c) => c.id === "oversize" && c.media), false);
  assert.equal(h.state.drive_failures["drive:oversize"].code, "download_limit");
  assert.match(h.state.drive_failures["drive:oversize"].reason, /over the 8MB limit/);
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.complete, false);
});

test("expired change tokens fail visibly and preserve the token without walk or reseed", async () => {
  const h = harness({ state: { sync_token: "expired-page" } });
  let reached = 0;
  h.options.drive = { ...drive, listChangePage: async () => { reached++; throw new drive.DriveError("expired", 410, "expired"); } };
  await assert.rejects(h.run(), (error) => error.status === 410);
  assert.equal(reached, 1);
  assert.equal(h.state.sync_token, "expired-page");
  assert.match(h.state.drive_incremental_error, /No full walk or reseed/);
  assert.equal(h.receipts.at(-1).walk_complete, false);
  assert.equal(h.calls.length, 0);
});

test("local Drive status reads no credential or provider and names exact failed file and reason", async () => {
  const h = harness({ state: { sync_token: "saved-page", drive_change_token_at: stamp,
    drive_pending_removals: { "drive:removed": { id: "removed" } },
    drive_failures: { "drive:oversize": { id: "oversize", name: "oversize.txt", reason: "over the 8MB limit" } } } });
  let output = "";
  h.options.write = (value) => { output += value; };
  h.options.resolveAdminKey = () => { throw new Error("credential path reached"); };
  await h.run({ status: true });
  assert.match(output, /Pending owner removal decisions: 1/);
  assert.match(output, /oversize.txt \[oversize\]: over the 8MB limit/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
});

test("explicit file limits resume within the persisted page and remain partial in load", async () => {
  const files = [file("first"), file("last")];
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": { changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const first = await h.run({ limit: "1" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.state.drive_change_page.offset, 1);
  assert.equal(describeLoadResult(first).refreshSucceeded, false);
  const last = await h.run({ limit: "1" });
  assert.equal(last.complete, true);
  assert.equal(describeLoadResult(last).refreshSucceeded, true);
  assert.equal(h.sent.length, 2);
});

test("a split-document rejection keeps its file checkpoint unaccepted and retries every part", async () => {
  const f = file("split"), h = harness({ state: { sync_token: "old-page" },
    pages: { "old-page": { changes: [{ fileId: f.id, file: f }], newStartPageToken: "done-page" },
      "done-page": { changes:[],newStartPageToken:"done-page" } } });
  const lib = h.options.ingestLib;
  h.options.ingestLib = async () => ({ ...await lib(), splitOversized: (e) => [e, { ...e, source_id: `${e.source_id}:part:2` }] });
  let reject = true, reached = 0;
  const send = h.options.sendBatches;
  h.options.sendBatches = async (args) => {
    reached++;
    if (!reject) return send(args);
    for (const item of args.groups.flat()) args.onResult(item, { status: item.envelope.source_id.includes(":part:") ? "failed" : "created" });
    return { created: 1, failed: 1 };
  };
  // R6 settles the feed independently from this durable retry. Logical
  // acceptance still requires every part, and an ordinary pass retries it.
  const failed = await h.run();
  assert.equal(failed.complete, false);
  assert.equal(h.state.drive_failures['drive:split'].code, 'ingest_write_failed');
  assert.equal(reached, 1, "real writer decision reached");
  assert.equal(h.state.done["drive:split"], undefined);
  assert.equal(h.state.sync_token, "done-page");
  reject = false;
  const resumed = await h.run();
  assert.equal(resumed.feed_caught_up, true);
  assert.equal(resumed.complete, false, "obsolete representation review stays visible");
  assert.equal(resumed.pending_removals, 1);
  assert.equal(resumed.created, 1, "file count must not count physical parts twice");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["split", "split:part:2"]);
});

for (const [label, outcome] of [
  ['unsupported', { skip:{ code:'unsupported_type',reason:'No supported text extractor.' } }],
  ['unreadable', { skip:{ code:'extraction_refused',reason:'The source could not be read.' } }],
  ['too large', { skip:{ code:'oversize',reason:'Over the bounded download limit.' } }],
]) test(`R3 fail-safe: ${label} remains visible while the token and later changes advance`, async()=>{
  const h=harness({ state:{ sync_token:'old-page' },pages:{ 'old-page':{
    changes:[file('held'),file('control')].map(f=>({ fileId:f.id,file:f })),newStartPageToken:'done-page' } } });
  const connector=h.options.drive;
  let decisions=0;
  h.options.drive={ ...connector,toEnvelope:async(get,f,config)=>{
    if(f.id==='held'){ decisions++; return outcome; } return connector.toEnvelope(get,f,config);
  } };
  const result=await h.run();
  assert.equal(decisions,1,'permanent extraction decision reached');
  assert.equal(result.skipped,1); assert.equal(result.complete,false); assert.equal(result.feed_caught_up,true);
  assert.equal(h.state.sync_token,'done-page'); assert.deepEqual(h.sent.map(e=>e.source_id),['control']);
  assert.equal(h.state.drive_failures['drive:held'].reason,outcome.skip.reason);
  assert.equal(h.state.drive_failures['drive:held'].retryable,false);
});

for(const [label,first,second,settles] of [
  ['known admission', { code:'retained_prior_revision_limit',retryable:false,retry_class:'owner_recovery' },null,true],
  ['unknown nonretryable code', { code:'unknown_failure',retryable:false,retry_class:'owner_recovery' },null,false],
  ['contradictory retry flag', { code:'retained_prior_revision_limit',retryable:true,retry_class:'retry' },null,false],
  ['mixed transient and admission', { code:'retained_prior_revision_limit',retryable:false,retry_class:'owner_recovery' },
    { code:'ingest_write_failed',retryable:true,retry_class:'retry' },false],
]) test(`R3 split receipts: ${label} has an explicit cursor decision and an accepted control`, async()=>{
  const h=harness({state:{sync_token:'old-page'},pages:{'old-page':{
    changes:[file('held'),file('control')].map(f=>({fileId:f.id,file:f})),newStartPageToken:'done-page'}}});
  const lib=h.options.ingestLib;
  h.options.ingestLib=async()=>({...await lib(),splitOversized:e=>e.source_id==='held'&&second
    ? [e,{...e,source_id:`${e.source_id}:part:2`}]:[e]});
  const send=h.options.sendBatches; let decisions=0;
  h.options.sendBatches=async args=>{
    if(args.groups[0][0].envelope.source_id==='control') return send(args);
    for(const [i,item] of args.groups.flat().entries()){
      decisions++; args.onResult(item,{status:'failed',...(i===0?first:second),error:'Untrusted storage text is not a recovery explanation.'});
    }
    return {failed:second?2:1};
  };
  await h.run();
  assert.equal(decisions,second?2:1,'all failed-part decisions reached');
  assert.equal(h.state.sync_token,'done-page');
  assert.equal(h.sent.length,1,'durable retry gaps permit the healthy later control');
  assert.equal(h.state.drive_failures['drive:held'].retryable,!settles);
  assert.equal(h.state.drive_failures['drive:held'].parts.length,second?2:1);
  assert.doesNotMatch(h.state.drive_failures['drive:held'].reason,/Untrusted storage/);
  if(!settles){
    h.options.drive={...h.options.drive,listChangePage:async()=>({changes:[],nextToken:'done-page',terminal:true})};
    h.options.sendBatches=send; assert.equal((await h.run()).created,1,'ordinary retry repairs only the failed identity');
    assert.equal(h.state.drive_failures['drive:held'],undefined);
  }
});

test("reset retries held failures without discarding accepted versions or reseeding the feed", async () => {
  const h = harness({ state: { sync_token: "saved-page", done: { "drive:existing": "prior-version" },
    drive_failures: { "drive:held": { id: "held", name: "held.txt", reason: "prior failure" } } },
    entries: [file("held")], pages: { "saved-page": { changes: [], newStartPageToken: "done-page" } } });
  const result = await h.run({ reset: true });
  assert.ok(h.calls.some((c) => c.id === "held" && c.media), "retry decision reached");
  assert.equal(h.state.done["drive:existing"], "prior-version");
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(h.calls.some((c) => c.id === "startPageToken"), false);
  assert.equal(result.complete, true);
});

test("path exclusions use the selected root path and hold the old copy without downloading", async () => {
  const h = harness({ state: { sync_token: "old-page", done: { "drive:excluded": "prior" } }, entries: [folder("sealed", "reviewed")],
    pages: { "old-page": { changes: [file("excluded", "sealed"), file("control")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  h.manifest.corpora.google_drive.exclude_paths = ["reviewed/sealed"];
  const result = await h.run();
  assert.equal(result.scanned, 2);
  assert.equal(h.state.drive_pending_removals["drive:excluded"].reason, "source_policy");
  assert.equal(h.state.done["drive:excluded"], "prior");
  assert.equal(h.calls.some((c) => c.id === "excluded" && c.media), false);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
});

test("direct My Drive files are scoped without following unselected child folders", async () => {
  const h = harness({ state: { sync_token: "old-page" }, entries: [folder("unselected", "account-root")],
    pages: { "old-page": { changes: [file("loose", "account-root"), file("outside", "unselected")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  h.manifest.corpora.google_drive.root_folder_ids = [];
  h.manifest.corpora.google_drive.include_my_drive_root_files = true;
  const result = await h.run();
  assert.equal(result.scanned, 2);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["loose"]);
  assert.equal(h.sent[0].metadata.folder, null);
  assert.equal(h.calls.some((c) => c.id === "outside" && c.media), false);
});

for (const invalid of [
  { changes: [], nextPageToken: "old-page" },
  { changes: [], newStartPageToken: " spaced " },
  { changes: [{ fileId: "wrong", file: file("other") }], newStartPageToken: "done-page" },
  { changes: [ { fileId: "missing-metadata" } ], newStartPageToken: "done-page" },
]) test("invalid feed evidence cannot advance the checkpoint or enter the writer", async () => {
  const h = harness({ state: { sync_token: "old-page" }, pages: { "old-page": invalid } });
  await assert.rejects(h.run());
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "validation decision reached");
  assert.equal(h.state.sync_token, "old-page");
  assert.equal(h.sent.length, 0);
  const control = harness({ state: { sync_token: "old-page" }, pages: { "old-page": {
    changes: [{ fileId: "control", file: file("control") }], newStartPageToken: "done-page" } } });
  assert.equal((await control.run()).created, 1, "green feed control");
});

test("daily plan declares the same add/update-only Drive mode", async () => {
  const h = harness();
  const plan = await planDailyRefresh({ m: h.manifest, manifestPath: "manifest.json", principal: "fixture-principal",
    localTimezone: "UTC", planLoadFn: async () => [{ key: "google_drive", status: "ready", legs: [{ source: "drive" }] }] });
  assert.equal(plan.sources[0].key, "google_drive");
  assert.equal(plan.sources[0].sync_mode, "incremental_add_update_only");
  assert.equal(plan.sources[0].automatic_removals, false);
});

test("an empty terminal page may retain its token and still prove a no-change check", async () => {
  const h = harness({ state: { sync_token: "same-page" }, pages: { "same-page": { changes: [], newStartPageToken: "same-page" } } });
  const result = await h.run();
  assert.equal(h.calls.filter((c) => c.id === "changes").length, 1, "no-change decision reached");
  assert.equal(result.complete, true);
  assert.equal(result.feed_caught_up, true);
  assert.equal(h.state.sync_token, "same-page");
  assert.equal(h.state.drive_change_token_at, stamp);
  const control = harness({ state: { sync_token: "same-page" }, pages: { "same-page": {
    changes: [{ fileId: "control", file: file("control") }], newStartPageToken: "next-page" } } });
  assert.equal((await control.run()).created, 1);
});

test("a resumed page cannot download a file that has since moved out of scope", async () => {
  const h = harness({ state: { sync_token: "old-page" }, entries: [file("moved", "outside"), folder("outside", "account-root")],
    pages: { "old-page": { changes: [file("moved"), file("control")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const result = await h.run();
  assert.equal(result.scanned, 2, "both current scope decisions reached");
  assert.equal(h.calls.some((c) => c.id === "moved" && c.media), false);
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
  assert.equal(h.state.drive_pending_removals["drive:moved"].reason, "left_configured_roots");
});

test("a file no longer returned by metadata lookup is retained for review without holding later additions", async () => {
  const h = harness({ state: { sync_token: "old-page", done: { "drive:missing": "prior-version" } }, pages: { "old-page": {
    changes: [file("missing"), file("control")].map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" } } });
  const connector = h.options.drive;
  let reached = 0;
  h.options.drive = { ...connector, getFileMetadata: async (get, id) => {
    if (id === "missing") { reached++; throw new drive.DriveError("file not returned", 404, "notFound"); }
    return connector.getFileMetadata(get, id);
  } };
  const result = await h.run();
  assert.equal(reached, 1, "current metadata decision reached");
  assert.deepEqual(h.sent.map((e) => e.source_id), ["control"]);
  assert.equal(h.state.done["drive:missing"], "prior-version");
  assert.equal(h.state.drive_failures["drive:missing"].code, "file_unavailable");
  assert.equal(h.state.drive_pending_removals["drive:missing"].reason, "removed_or_access_lost");
  assert.equal(h.state.sync_token, "done-page");
  assert.equal(result.feed_caught_up, true);
  assert.equal(result.complete, false);
});

for (const [label, bytes] of [["malformed JSON", "{"], ["missing done", JSON.stringify({ sync_token: "prior-page" })],
  ["invalid cursor", JSON.stringify({ done: {}, sync_token: 42 })]]) {
  test(`DRIVE-R3: existing ${label} is preserved by the real loader and command`, async () => {
    const h = harness();
    const checkpoint = join(h.manifestPath, "..", ".brain-ingest-drive.json");
    writeFileSync(checkpoint, bytes);
    let decisions = 0;
    h.options.ingestLib = async () => ({ batchStream, splitOversized, prefetch,
      loadState: (path, options) => { decisions++; return realLoadState(path, options); }, saveState: realSaveState });
    await assert.rejects(h.run(), /checkpoint.*recovery|checkpoint.*invalid/i);
    assert.equal(decisions, 1, "real checkpoint recovery decision reached");
    assert.equal(readFileSync(checkpoint, "utf8"), bytes, "failed checkpoint never overwritten");
    assert.equal(h.calls.length, 0, "no token reseed or provider request");
    assert.equal(h.receipts.length, 0, "no false source receipt");
  });
}

test("DRIVE-R3: real loader distinguishes a missing checkpoint seed from a valid cursor resume", async () => {
  for (const prior of [null, { version:1, done:{}, skipped:{}, sync_token:"prior-page" }]) {
    const h = harness({ pages: { "prior-page": { changes:[], newStartPageToken:"next-page" } } });
    const checkpoint = join(h.manifestPath, "..", ".brain-ingest-drive.json");
    if (prior) writeFileSync(checkpoint, JSON.stringify(prior));
    h.options.ingestLib = async () => ({ batchStream, splitOversized, prefetch, loadState:realLoadState, saveState:realSaveState });
    await h.run();
    assert.equal(h.calls.some(c => c.id === "startPageToken"), !prior);
    assert.equal(realLoadState(checkpoint).sync_token, prior ? "next-page" : "seed-page");
  }
});

test('an older or interrupted Worker update is rejected before checkpoint or source writes', async () => {
  const h = harness();
  let compatibility = 0;
  h.options.verifyDriveIncrementalWorker = async () => { compatibility++; throw new Error('retained revision protocol unavailable'); };
  await assert.rejects(h.run(), /retained revision protocol/);
  assert.equal(compatibility, 1, 'paired-runtime decision reached');
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
  assert.equal(h.saves.length, 0);
  const control = harness();
  control.options.verifyDriveIncrementalWorker = async () => { compatibility++; };
  assert.equal((await control.run()).seeded, true, 'compatible Worker green control');
  assert.equal(compatibility, 2);
});


test("DRIVE-R3: an existing broken checkpoint link is a recovery condition, never first use", async () => {
  const h = harness();
  const checkpoint = join(h.manifestPath, "..", ".brain-ingest-drive.json");
  symlinkSync(join(h.manifestPath, "..", "absent-target"), checkpoint);
  let reads = 0;
  h.options.ingestLib = async () => ({ batchStream, splitOversized, prefetch,
    loadState: (path, options) => { reads++; return realLoadState(path, options); }, saveState: realSaveState });
  await assert.rejects(h.run(), /checkpoint.*recovery/i);
  assert.equal(reads, 1, "checkpoint artifact decision reached");
  assert.equal(lstatSync(checkpoint).isSymbolicLink(), true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
});

test('mutating full-walk review cannot reopen an unbounded legacy writer', async () => {
  const h = harness();
  let credentials = 0;
  h.options.resolveAdminKey = () => { credentials++; return 'unreachable'; };
  await assert.rejects(h.run({ 'full-walk-review':true }), error =>
    error.supportCode === 'CONFIG_INVALID' && /full-walk.*read-only/i.test(error.message));
  assert.equal(credentials, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.receipts.length, 0);
  assert.equal(h.saves.length, 0);
  const control = harness();
  assert.equal((await control.run()).seeded, true, 'bounded incremental writer control');
});
