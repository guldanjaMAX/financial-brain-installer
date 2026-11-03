import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { importGranolaExport, planGranolaExport, validateGranolaConfig } from "../connectors/granola-export.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const full = JSON.parse(readFileSync(new URL("./fixtures/granola/full.json", import.meta.url)));
function inputs(t, records = [full]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granola-export-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = records.map((record, index) => {
    const path = join(root, `meeting-${index}.json`);
    writeFileSync(path, JSON.stringify(record));
    return path;
  });
  return { config: { enabled: true, source: "meeting-export", owner_email: full.owner_email,
    transport: "file-export", format: "granola.meeting.v1", export_path: root }, files };
}
function localRequest(fixture, calls) {
  return async (path, body) => {
    calls.push({ path, body });
    return fixture.post(path, body, { "X-Admin-Key": fixture.env.ADMIN_KEY });
  };
}

function directoryLink(t, target, path) {
  try { symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Directory link creation is unavailable on this host.");
      return false;
    }
    throw error;
  }
  assert.equal(lstatSync(path).isSymbolicLink(), true, "the link decision point exists");
  return true;
}

test("a regular export root under a linked ancestor uses canonical containment", async t => {
  const input = inputs(t);
  const parent = input.config.export_path;
  const root = join(parent, "exports");
  mkdirSync(root, { mode: 0o700 });
  const file = join(root, "meeting.json");
  writeFileSync(file, JSON.stringify(full));
  const direct = { config: { ...input.config, export_path: root }, files: [file] };
  const green = await planGranolaExport(direct);
  assert.equal(green.documents.length, 1);
  const alias = join(parent, "ancestor-link");
  if (!directoryLink(t, parent, alias)) return;
  const linked = { config: { ...input.config, export_path: join(alias, "exports") },
    files: [join(alias, "exports", "meeting.json")] };
  assert.equal(lstatSync(linked.config.export_path).isSymbolicLink(), false);
  assert.equal(realpathSync(linked.config.export_path), root);
  const plan = await planGranolaExport(linked);
  assert.deepEqual(plan.documents, green.documents);
  assert.equal(plan.files_seen, 1);
  // The ancestor alias also exposes a valid sibling export, outside this root.
  const outside = join(alias, "meeting-0.json");
  assert.equal(realpathSync(outside), input.files[0]);
  await assert.rejects(planGranolaExport({ ...linked, files: [outside] }), error =>
    error.code === "GRANOLA_FILE_UNSAFE" && error.stage === "file");
});

test("a declared root that is itself a link refuses before requests", async t => {
  const input = inputs(t);
  const root = join(input.config.export_path, "exports");
  mkdirSync(root, { mode: 0o700 });
  const file = join(root, "meeting.json");
  writeFileSync(file, JSON.stringify(full));
  assert.equal((await planGranolaExport({ config: { ...input.config, export_path: root }, files: [file] }))
    .documents.length, 1, "green direct-root control");
  const link = join(input.config.export_path, "root-link");
  if (!directoryLink(t, root, link)) return;
  assert.equal(realpathSync(link), root, "the refused root resolves to a valid export");
  let calls = 0;
  await assert.rejects(importGranolaExport({ config: { ...input.config, export_path: link },
    files: [join(link, "meeting.json")] }, { request: async () => { calls++; } }), error =>
    error.code === "GRANOLA_FILE_UNSAFE" && error.stage === "file");
  assert.equal(calls, 0);
});

test("a linked ancestor retargeted after root validation cannot escape canonical custody", async t => {
  const input = inputs(t);
  const parent = input.config.export_path;
  for (const name of ["original", "outside"]) {
    const directory = join(parent, name);
    mkdirSync(directory);
    const root = join(directory, "exports");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, "meeting.json"), JSON.stringify({ ...full, id: name }));
  }
  const alias = join(parent, "ancestor-link");
  if (!directoryLink(t, join(parent, "original"), alias)) return;
  const file = join(alias, "exports", "meeting.json");
  const config = { ...input.config, export_path: join(alias, "exports") };
  assert.equal((await planGranolaExport({ config, files: [file] })).documents.length, 1,
    "green linked-ancestor control before retargeting");
  let selections = 0, calls = 0;
  const files = [file];
  Object.defineProperty(files, "0", { get() {
    selections++;
    unlinkSync(alias);
    symlinkSync(join(parent, "outside"), alias, process.platform === "win32" ? "junction" : "dir");
    assert.notEqual(realpathSync(config.export_path), join(parent, "original", "exports"));
    return file;
  } });
  await assert.rejects(importGranolaExport({ config, files }, { request: async () => { calls++; } }), error =>
    error.code === "GRANOLA_FILE_UNSAFE" && error.stage === "file");
  assert.equal(selections, 1, "the retarget occurred after root validation, at file selection");
  assert.equal(calls, 0);
});

test("file and directory links inside the declared root refuse before requests", async t => {
  const input = inputs(t);
  assert.equal((await planGranolaExport(input)).documents.length, 1, "green regular-file control");
  const root = input.config.export_path;
  const link = join(root, "linked.json");
  try { symlinkSync(input.files[0], link, "file"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("File link creation is unavailable on this host.");
    throw error;
  }
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(realpathSync(link), input.files[0], "the refused file link has a valid target");
  let calls = 0;
  const refused = async file => {
    await assert.rejects(importGranolaExport({ ...input, files: [file] }, {
      request: async () => { calls++; },
    }), error => error.code === "GRANOLA_FILE_UNSAFE" && error.stage === "file");
    assert.equal(calls, 0);
  };
  await refused(link);
  const directory = join(root, "nested-link");
  if (!directoryLink(t, root, directory)) return;
  assert.equal(realpathSync(join(directory, "meeting-0.json")), input.files[0]);
  await refused(join(directory, "meeting-0.json"));
});

test("file export uses the real registered-source and common batch path; replay and metadata revision", async t => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const input = inputs(t);
  const calls = [];
  const request = localRequest(fixture, calls);
  const first = await importGranolaExport(input, { request });
  assert.equal(first.created, 1);
  assert.equal(first.complete, true);
  assert.deepEqual(calls.map(call => call.path), ["/api/admin/brain/source-register", "/api/admin/brain/ingest/batch"]);
  const planned = await planGranolaExport(input);
  const doc = planned.documents[0];
  const stored = () => fixture.first("SELECT * FROM documents WHERE doc_uid=?", `${doc.source_type}:${doc.source_id}`);
  assert.equal(stored().title, full.title);
  assert.equal(JSON.parse(stored().meta).granola.meeting_at, full.meeting_at);
  assert.equal(JSON.parse(stored().meta).provenance_receipt.status, "complete");
  assert.equal(stored().date_reliable, 1);
  assert.ok(fixture.first("SELECT count(*) n FROM vector_outbox").n > 0);
  assert.equal(first.semantic_index, "not_verified");
  assert.equal((await importGranolaExport(input, { request })).unchanged, 1);
  const before = fixture.first("SELECT count(*) n FROM documents").n;
  writeFileSync(input.files[0], JSON.stringify({ ...full, title: "Corrected session title", attendees: ["Observer"] }));
  assert.equal((await importGranolaExport(input, { request })).updated, 1);
  assert.equal(fixture.first("SELECT count(*) n FROM documents").n, before);
  assert.equal(stored().title, "Corrected session title");
  assert.deepEqual(JSON.parse(stored().meta).granola.attendees, ["Observer"]);
  const priorEnvelope = (await planGranolaExport(input)).documents[0];
  writeFileSync(input.files[0], JSON.stringify({ ...full, title: "Corrected session title", attendees: ["Observer", "Invitee"] }));
  assert.equal((await planGranolaExport(input)).documents[0].content, priorEnvelope.content);
  assert.equal((await importGranolaExport(input, { request })).updated, 1, "attendee-only correction is a metadata revision");
  assert.deepEqual(JSON.parse(stored().meta).granola.attendees, ["Observer", "Invitee"]);
  assert.equal(fixture.first("SELECT count(*) n FROM documents").n, before);
  assert.ok(fixture.seen.sql.some(sql => /INSERT INTO source_events/.test(sql)));
});

test("duplicate IDs collapse identical exports, while conflicting copies refuse before requests", async t => {
  const input = inputs(t, [full, full]);
  const plan = await planGranolaExport(input);
  assert.equal(plan.documents.length, 1);
  assert.equal(plan.duplicate_exports, 1);
  writeFileSync(input.files[1], JSON.stringify(Object.fromEntries(Object.entries(full).reverse())));
  const reordered = await planGranolaExport(input);
  assert.equal(reordered.documents.length, 1);
  assert.equal(reordered.duplicate_exports, 1, "JSON member order is not a meeting revision");
  writeFileSync(input.files[1], JSON.stringify({ ...full, title: "Conflicting revision" }));
  let calls = 0;
  await assert.rejects(importGranolaExport(input, { request: async () => { calls++; } }), error =>
    error.code === "GRANOLA_DUPLICATE_CONFLICT" && error.stage === "dedupe");
  assert.equal(calls, 0);
});

test("notes-only storage keeps missing coverage, then a transcript revises the same durable meeting", async t => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const notes = JSON.parse(readFileSync(new URL("./fixtures/granola/notes-only.json", import.meta.url)));
  const input = inputs(t, [notes]);
  const request = localRequest(fixture, []);
  assert.equal((await importGranolaExport(input, { request })).created, 1);
  let rows = fixture.rows("SELECT doc_uid,meta FROM documents WHERE deleted_at IS NULL");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].meta).granola.notes_only, true);
  const uid = rows[0].doc_uid;
  writeFileSync(input.files[0], JSON.stringify({ ...notes, transcript: full.transcript }));
  assert.equal((await importGranolaExport(input, { request })).updated, 1);
  rows = fixture.rows("SELECT doc_uid,meta FROM documents WHERE deleted_at IS NULL");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doc_uid, uid);
  assert.equal(JSON.parse(rows[0].meta).granola.notes_only, false);
  assert.equal(JSON.parse(rows[0].meta).granola.transcript_status, "available");
});

test("an incompatible renamed source reaches the registry and writes no document", async t => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const input = inputs(t);
  const calls = [];
  const request = localRequest(fixture, calls);
  const registered = await request("/api/admin/brain/source-register", { source: input.config.source, kind: "upload" });
  assert.equal(registered.status, 200);
  assert.equal((await planGranolaExport(input)).documents.length, 1);
  await assert.rejects(importGranolaExport(input, { request }), error => error.code === "GRANOLA_SOURCE_KIND_CONFLICT");
  assert.equal(calls.filter(call => call.path.endsWith("source-register")).length, 2);
  assert.equal(calls.filter(call => call.path.endsWith("/batch")).length, 0);
  assert.ok(fixture.seen.sql.some(sql => /FROM sources s WHERE s.name/.test(sql)));
  assert.equal(fixture.first("SELECT count(*) n FROM documents").n, 0);
});

test("wrong account, summary-only and malformed files are assessed before any request", async t => {
  const input = inputs(t);
  assert.equal((await planGranolaExport(input)).documents.length, 1);
  let calls = 0;
  const request = async () => { calls++; };
  for (const record of [
    { ...full, owner_email: "other-owner@example.invalid" },
    { ...full, transcript: null, notes: "" }, { ...full, meeting_at: undefined },
  ]) {
    writeFileSync(input.files[0], JSON.stringify(record));
    await assert.rejects(importGranolaExport(input, { request }), error => ["account", "content", "schema"].includes(error.stage));
  }
  writeFileSync(input.files[0], "{");
  await assert.rejects(importGranolaExport(input, { request }), error => error.code === "GRANOLA_EXPORT_INVALID");
  assert.equal(calls, 0);
});

test("fixed registration identity and exact per-item receipts are required for completion", async t => {
  const input = inputs(t);
  const plan = await planGranolaExport(input);
  assert.equal(plan.documents.length, 1);
  const doc = plan.documents[0];
  const validRegistration = { source: input.config.source, kind: "granola", registered: true,
    registry_event_recorded: true, operation_id: "synthetic-operation" };
  const validBatch = { total: 1, results: [{ source_type: doc.source_type, source_id: doc.source_id,
    doc_uid: `${doc.source_type}:${doc.source_id}`, status: "created" }] };
  const run = async (registration, batch) => {
    const calls = [];
    const promise = importGranolaExport(input, { request: async (path, body) => {
      calls.push({ path, body });
      return Response.json(path.endsWith("source-register") ? registration : batch);
    } });
    return { calls, promise };
  };
  const green = await run(validRegistration, validBatch);
  assert.equal((await green.promise).created, 1);
  assert.equal(green.calls.length, 2);
  for (const registration of [{ ...validRegistration, source: "renamed" }, { ...validRegistration, kind: "upload" }]) {
    const arm = await run(registration, validBatch);
    await assert.rejects(arm.promise, error => error.code === "GRANOLA_REGISTRATION_UNVERIFIED");
    assert.equal(arm.calls.length, 1);
  }
  for (const batch of [
    { total: 1, results: [] }, { ...validBatch, total: 0 },
    { total: 1, results: [{ ...validBatch.results[0], source_type: "renamed" }] },
    { total: 1, results: [{ ...validBatch.results[0], source_id: "unrelated" }] },
    { total: 1, results: [{ ...validBatch.results[0], status: "refused" }] },
  ]) {
    const arm = await run(validRegistration, batch);
    await assert.rejects(arm.promise, error => error.code === "GRANOLA_IMPORT_INCOMPLETE");
    assert.equal(arm.calls.length, 2);
  }
});

test("declared file root, regular-file bounds and config fail closed", async t => {
  const input = inputs(t);
  assert.equal((await planGranolaExport(input)).documents.length, 1);
  for (const patch of [{ enabled: false }, { transport: "mcp" }, { source: " Meeting-export" },
    { owner_email: "" }, { export_path: "relative" }, { format: "unknown" }, { surprise: true }]) {
    assert.throws(() => validateGranolaConfig({ ...input.config, ...patch }), error => error.code === "GRANOLA_CONFIG_INVALID");
  }
  await assert.rejects(planGranolaExport({ ...input, files: [] }), /file selection/);
  const nested = join(input.config.export_path, "nested");
  mkdirSync(nested);
  const link = join(input.config.export_path, "linked.json");
  try { symlinkSync(input.files[0], link); }
  catch (error) { if (error.code === "EPERM") return; throw error; }
  await assert.rejects(planGranolaExport({ ...input, files: [link] }), error => error.code === "GRANOLA_FILE_UNSAFE");
  await assert.rejects(planGranolaExport({ ...input, files: [nested] }), error => error.code === "GRANOLA_FILE_UNSAFE");
  await assert.rejects(planGranolaExport({ ...input, files: [join(input.config.export_path, "..", "outside.json")] }),
    error => error.code === "GRANOLA_FILE_UNSAFE");
});
