// "Clean my Brain", CLI side: dry run, apply, resume, stop on error, support
// codes. The CLI runs against the real Worker code on a local SQLite.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClean, readCleanList, parseCleanArgs } from "../operations/clean-brain.mjs";
import { CleanError, maskProviderMessage, formatCleanError } from "../operations/clean-brain-codes.mjs";
import { makeBrain, writeReviewedList, ADMIN_KEY, BASE } from "./helpers/clean-brain-fixture.mjs";

const gmail = (from, count) => Array.from({ length: count }, (_, i) => `gmail:m${from + i}`);

async function scenario(t, { gmailDocs = 400, driveDocs = 600, schema = 70, brainOptions = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "clean-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const brain = makeBrain({ schema, ...brainOptions });
  brain.loadMany("gmail", "m", gmailDocs, 2);
  brain.loadMany("drive", "f", driveDocs, 3);
  const out = [], err = [];
  const restorePoints = [];
  const deps = {
    write: (text) => out.push(text), writeError: (text) => err.push(text),
    loadManifest: () => ({ brain: { domain: "brain.invalid" } }),
    resolveAdminKey: () => ADMIN_KEY,
    resolveBaseUrl: async () => BASE,
    fetchImpl: brain.fetch,
    sleep: async () => {},
    verifyTarget: async ({ url, marker }) => ({
      url, instance: marker.instance, account_id: "fixture-account", database_id: marker.instance,
    }),
    restorePoint: async ({ brain: target }) => {
      restorePoints.push(brain.requests.length);
      return { brain: target, bookmark: "00000085-0000024c-4c0b5f2e8a1d" };
    },
    rollbackHint: (bookmark) => `brain rollback m.json ${bookmark}`,
  };
  const list = async (ids, name = "stage") => writeReviewedList(directory, name, ids);
  const run = async (listPath, { approve = true, ...flags } = {}, extra = {}) => {
    const args = { manifestPath: "m.json", listPath, pauseMs: 0, ...flags };
    if (listPath && flags.apply && approve && !flags.reviewedPlanSha) {
      const path = listPath.replace(/\.ids$/, ".clean-plan.json");
      if (!existsSync(path)) {
        const preview = await runClean({ ...args, apply: false, previewAll: true }, { ...deps, sleep: extra.sleep ?? deps.sleep });
        if (preview.exit_code) return preview;
      }
      args.reviewedPlanSha = require_sha(readFileSync(path));
    }
    return runClean(args, { ...deps, ...extra });
  };
  return { directory, brain, out, err, deps, list, run, restorePoints };
}
const writes = (brain) => brain.requests.filter((r) => r.path.endsWith("ingest-removal-plan") && r.body?.action === "apply");

test("the list must be exact: shape, duplicates, review file and hash", async (t) => {
  const s = await scenario(t);
  const good = await s.list(gmail(1, 5), "good");
  assert.equal(readCleanList(good).ids.length, 5);
  const bad = async (name, text, meta) => {
    const path = join(s.directory, `${name}.ids`);
    writeFileSync(path, text);
    if (meta !== false) writeFileSync(join(s.directory, `${name}.meta.json`), JSON.stringify(meta));
    assert.throws(() => readCleanList(path), (e) => e instanceof CleanError && e.code === "CLEAN_LIST_INVALID", name);
  };
  const sha = (text) => require_sha(text);
  await bad("shape", "gmail:m1\nnot an id\n", { ids_sha256: sha("gmail:m1\nnot an id\n") });
  await bad("dupe", "gmail:m1\ngmail:m1\n", { ids_sha256: sha("gmail:m1\ngmail:m1\n") });
  await bad("nometa", "gmail:m1\n", false);
  await bad("changed", "gmail:m1\ngmail:m2\n", { ids_sha256: sha("gmail:m1\n") });
  await bad("count", "gmail:m1\n", { ids_sha256: sha("gmail:m1\n"), count: 4 });
  await bad("empty", "\n\n", { ids_sha256: sha("\n\n") });
  // Through the command: nothing is contacted when the list is bad.
  const path = join(s.directory, "shape.ids");
  const result = await s.run(path);
  assert.equal(result.code, "CLEAN_LIST_INVALID");
  assert.equal(s.brain.requests.length, 0, "a bad list is refused before the Brain is contacted");
});
import { createHash } from "node:crypto";
const require_sha = (text) => createHash("sha256").update(text).digest("hex");

test("dry run previews and writes nothing", async (t) => {
  const s = await scenario(t);
  const ids = [...gmail(1, 120), "gmail:already-gone-1"];
  const list = await s.list(ids);
  const before = s.brain.totalDocuments();
  const result = await s.run(list);
  assert.equal(result.exit_code, 0);
  assert.equal(result.applied, false);
  assert.equal(result.dry_run.would_remove_documents, 120);
  assert.equal(result.dry_run.already_gone, 1);
  assert.equal(result.dry_run.protected, 0);
  assert.equal(s.brain.totalDocuments(), before);
  assert.deepEqual(s.brain.ledger(), []);
  assert.equal(writes(s.brain).length, 0, "no apply was sent");
  assert.equal(s.restorePoints.length, 0, "a dry run takes no restore point");
  assert.equal(existsSync(join(s.directory, "stage.progress.json")), false);
  assert.match(s.out.join("\n"), /DRY RUN, nothing in the Brain is written/);
  assert.match(s.out.join("\n"), /Sample preview/);
  assert.ok(!s.brain.requests.some((r) => r.body?.action === "remember"), "a dry run does not even remember");
});

test("apply: restore point first, every batch remembered, counters and report at the end", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 120));
  const result = await s.run(list, { apply: true });
  assert.equal(result.exit_code, 0, s.err.join("\n"));
  assert.equal(result.removed, 120);
  assert.equal(result.done, true);
  assert.equal(result.batches, 3);
  assert.equal(s.brain.liveUids("gmail").length, 280);
  assert.equal(s.brain.ledger().length, 120);
  assert.deepEqual(s.brain.stats("gmail"), s.brain.truth("gmail"));
  // The restore point was taken before the first write, and is on disk for a rollback.
  assert.equal(s.restorePoints.length, 1);
  const firstWrite = s.brain.requests.findIndex((r) => r.body?.action === "apply");
  assert.ok(s.restorePoints[0] <= firstWrite);
  const progress = JSON.parse(readFileSync(join(s.directory, "stage.progress.json"), "utf8"));
  assert.equal(progress.restore_point.bookmark, "00000085-0000024c-4c0b5f2e8a1d");
  assert.equal(progress.removed, 120);
  assert.match(s.out.join("\n"), /brain rollback m\.json 00000085/);
  assert.match(s.out.join("\n"), /Done\. Removed 120 document\(s\); the Brain went from 1,000 to 880 documents/);
  assert.equal(result.brain_documents_before, 1000);
  assert.equal(result.brain_documents_after, 880);
  assert.ok(s.brain.requests.some((r) => r.path.endsWith("corpus-stats/verify")), "the counter check ran once at the end");
  assert.deepEqual(result.warnings, []);
  // Every apply carried the memory request, in order, with its own batch number.
  assert.deepEqual(writes(s.brain).map((r) => r.body.batch_no), [0, 1, 2]);
  assert.ok(writes(s.brain).every((r) => r.body.remember_removal === true && r.body.targets.length <= 50));
});

test("apply refuses a stage over 20% before touching anything", async (t) => {
  const s = await scenario(t, { gmailDocs: 100, driveDocs: 0 });
  const result = await s.run(await s.list(gmail(1, 30)), { apply: true });
  assert.equal(result.code, "CLEAN_STAGE_TOO_LARGE");
  assert.equal(result.exit_code, 1);
  assert.equal(s.brain.liveUids("gmail").length, 100);
  assert.equal(s.restorePoints.length, 0);
  assert.match(s.err.join("\n"), /More: https:\/\/financialbrain\.ai\/help\/CLEAN_STAGE_TOO_LARGE/);
  // The same list is fine as a smaller stage.
  const ok = await s.run(await s.list(gmail(1, 19), "small"), { apply: true });
  assert.equal(ok.exit_code, 0);
});

test("a Brain that cannot remember removals yet is refused with an update message", async (t) => {
  const s = await scenario(t, { schema: 68 });
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true });
  assert.equal(result.code, "CLEAN_WORKER_TOO_OLD");
  assert.equal(s.brain.liveUids("gmail").length, 400);
  assert.equal(writes(s.brain).length, 0);
  assert.match(s.err.join("\n"), /Run brain update first/);
});

test("an unhealthy Brain stops the run before any write", async (t) => {
  const s = await scenario(t);
  s.brain.health = { ok: false, status: "storage-unavailable" };
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true });
  assert.equal(result.code, "CLEAN_HEALTH_NOT_OK");
  assert.equal(s.brain.liveUids("gmail").length, 400);
  assert.equal(s.restorePoints.length, 0);
});

test("no restore point, no removal: Cloudflare's own message is shown, masked", async (t) => {
  const s = await scenario(t);
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true }, {
    restorePoint: async () => { throw new Error('Authentication error [code: 10000] for token "cfut_abcdef123456" user me@example.com'); } });
  assert.equal(result.code, "CLEAN_RESTORE_POINT_FAILED");
  assert.equal(s.brain.liveUids("gmail").length, 400);
  const shown = s.err.join("\n");
  assert.match(shown, /Authentication error \[code: 10000\] for token \.\.\. user \.\.\./);
  assert.doesNotMatch(shown, /cfut_|me@example/);
});

test("resume: progress is keyed to the list, the restore point is not retaken", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 120));
  const first = await s.run(list, { apply: true, maxCalls: 1 });
  assert.equal(first.removed, 50);
  assert.equal(first.done, false);
  assert.equal(s.brain.liveUids("gmail").length, 350);
  const second = await s.run(list, { apply: true });
  assert.equal(second.exit_code, 0);
  assert.equal(second.removed, 120, "progress carries the running total");
  assert.equal(s.restorePoints.length, 1, "one restore point for the whole stage");
  assert.equal(s.brain.liveUids("gmail").length, 280);
  assert.equal(second.run_id, first.run_id);
  assert.match(s.out.join("\n"), /Resuming at item 50/);
  assert.deepEqual(writes(s.brain).map((r) => r.body.batch_no), [0, 1, 2], "batch numbers never repeat across a resume");
  // A different list starts over, with its own restore point.
  const other = await s.run(await s.list(gmail(200, 10), "other"), { apply: true });
  assert.equal(other.exit_code, 0);
  assert.equal(s.restorePoints.length, 2);
});

test("a 503 after the delete committed is proved and the run continues", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 120));
  s.brain.hooks.beforeRequest = (path, body) => {
    if (body?.action === "apply" && body.batch_no === 1) {
      s.brain.hooks.failAfterCommit = new Error('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset');
    }
  };
  const result = await s.run(list, { apply: true });
  assert.equal(result.exit_code, 0, s.err.join("\n"));
  assert.equal(result.removed, 120, "the lost-receipt batch is counted exactly once");
  assert.equal(s.brain.liveUids("gmail").length, 280);
  assert.equal(s.brain.ledger().length, 120);
  assert.match(s.out.join("\n"), /CLEAN_LATE_RECEIPT/);
  const progress = JSON.parse(readFileSync(join(s.directory, "stage.progress.json"), "utf8"));
  assert.deepEqual(progress.events, [{ code: "CLEAN_LATE_RECEIPT", batch_no: 1 }]);
  assert.equal(writes(s.brain).length, 3, "the committed batch was not sent again");
});

test("a database that stays busy stops with its own message, nothing half-done, and resumes", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 120));
  s.brain.hooks.beforeRequest = (path, body) => {
    if (body?.action === "apply" && body.batch_no === 1) s.brain.hooks.failAlways = /DELETE FROM documents/;
  };
  const result = await s.run(list, { apply: true, retries: 2 });
  assert.equal(result.code, "CLEAN_D1_BUSY");
  assert.equal(result.exit_code, 1);
  assert.match(result.provider_message, /D1 DB is overloaded/);
  assert.match(s.err.join("\n"), /The system said: D1_ERROR: D1 DB is overloaded/);
  assert.equal(s.brain.liveUids("gmail").length, 350, "only the first batch was removed");
  assert.equal(s.brain.ledger().length, 50, "and only that batch is remembered");
  assert.equal(JSON.parse(readFileSync(join(s.directory, "stage.progress.json"), "utf8")).next_index, 50);
  // The database recovers; the same command resumes.
  s.brain.hooks.failAlways = null; s.brain.hooks.beforeRequest = null;
  const resumed = await s.run(list, { apply: true });
  assert.equal(resumed.exit_code, 0);
  assert.equal(s.brain.liveUids("gmail").length, 280);
  assert.equal(s.restorePoints.length, 1);
});

test("one transient database failure before commit is retried, not fatal", async (t) => {
  const s = await scenario(t);
  s.brain.hooks.beforeRequest = (path, body) => {
    if (body?.action === "apply" && body.batch_no === 0 && !s.brain.hooks.failOnSql && !s.brain.once) {
      s.brain.once = true; s.brain.hooks.failOnSql = /DELETE FROM documents/;
    }
  };
  const result = await s.run(await s.list(gmail(1, 50)), { apply: true });
  assert.equal(result.exit_code, 0, s.err.join("\n"));
  assert.equal(result.removed, 50);
  assert.equal(s.brain.liveUids("gmail").length, 350);
  assert.match(s.out.join("\n"), /the database was busy/);
});

test("new mail mid-run invalidates the reviewed plan on rerun", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 120));
  let armed = true;
  s.brain.hooks.beforeRequest = (path, body) => {
    if (armed && body?.action === "apply" && body.batch_no === 1) {
      armed = false;
      s.brain.loadMany("drive", "late", 1, 1);   // any corpus change moves the removal marker
    }
  };
  const result = await s.run(list, { apply: true });
  assert.equal(result.code, "CLEAN_PLAN_CHANGED");
  assert.equal(s.brain.liveUids("gmail").length, 350);
  const again = await s.run(list, { apply: true });
  assert.equal(again.code, "CLEAN_PLAN_CHANGED");
  assert.equal(s.brain.liveUids("gmail").length, 350);
});

test("ids already gone are remembered, never an error", async (t) => {
  const s = await scenario(t);
  const pilot = gmail(1, 10);
  s.brain.db.exec("DELETE FROM documents WHERE doc_uid IN (" + pilot.map((u) => `'${u}'`).join(",") + ")");
  const result = await s.run(await s.list([...pilot, ...gmail(11, 5)]), { apply: true, allowMissing: true });
  assert.equal(result.exit_code, 0, s.err.join("\n"));
  assert.equal(result.removed, 5);
  assert.equal(result.already_gone, 10);
  assert.equal(s.brain.ledger().length, 15, "the pilot's removals are remembered too");
  // Every remembered missing id is written down for the owner to read.
  assert.equal(result.already_gone_list, join(s.directory, "stage.already-gone.txt"));
  assert.deepEqual(readFileSync(result.already_gone_list, "utf8").trim().split("\n"), pilot);
  assert.match(s.out.join("\n"), /10 id\(s\) were not in the Brain and were remembered as removed/);
});

test("a list with many ids that are not in the Brain stops before remembering any, unless allowed", async (t) => {
  const s = await scenario(t);
  const typos = Array.from({ length: 30 }, (_, i) => `gmail:typo${i}`);
  const list = await s.list([...gmail(1, 70), ...typos]);
  // The dry run shows examples and says the apply would stop.
  const dry = await s.run(list, { previewBatches: 3 });
  assert.equal(dry.dry_run.already_gone, 30);
  assert.equal(dry.dry_run.would_stop, "CLEAN_MANY_MISSING");
  assert.match(s.out.join("\n"), /Not in the Brain, for example: gmail:typo0/);
  assert.equal(s.brain.ledger().length, 0);
  // Applying stops at the first batch whose share is too high, nothing remembered from it.
  const stopped = await s.run(list, { apply: true, batchSize: 50 });
  assert.equal(stopped.code, "CLEAN_MANY_MISSING");
  assert.equal(stopped.exit_code, 1);
  assert.equal(s.brain.ledger().filter((row) => row.family_uid.startsWith("gmail:typo")).length, 0, "no typo was remembered");
  assert.equal(existsSync(join(s.directory, "stage.already-gone.txt")), true);
  assert.match(s.err.join("\n"), /--allow-missing/);
  assert.match(s.err.join("\n"), /More: https:\/\/financialbrain\.ai\/help\/CLEAN_MANY_MISSING/);
  // A few missing ids inside a mostly real list are fine.
  const s2 = await scenario(t);
  const fine = await s2.run(await s2.list([...gmail(1, 90), "gmail:typo1", "gmail:typo2"]), { apply: true });
  assert.equal(fine.exit_code, 0, s2.err.join("\n"));
  assert.equal(fine.already_gone, 2);
});

test("only gmail: and drive: ids are accepted, in the list and in the restore list", async (t) => {
  const s = await scenario(t);
  for (const bad of ["whatsapp:message:a", "gmail:m1#part1of2", "imessage:x"]) {
    const list = await s.list([bad], "other");
    const result = await s.run(list, { apply: true });
    assert.equal(result.code, "CLEAN_LIST_INVALID", bad);
  }
  assert.equal(s.brain.requests.length, 0);
});

test("the Brain size comes from the real counters route, and a capped clean-up queue is waited on", async (t) => {
  const s = await scenario(t);
  const dry = await s.run(await s.list(gmail(1, 20)));
  assert.equal(dry.brain_documents_before, 1000, "the real Worker answered the size read");
  assert.ok(s.brain.requests.some((r) => r.path.endsWith("owner-removals") && r.body?.action === "size"));
  assert.ok(!s.brain.requests.some((r) => r.path.endsWith("/documents")), "the documents page is never asked");
  // The Worker reports at most 10,001 pending; that must count as over the limit.
  s.brain.queue(10_001);
  const result = await s.run(await s.list(gmail(21, 40), "queued"), { apply: true, batchSize: 10, healthEvery: 1, backlogWaitMs: 0 });
  assert.equal(result.code, "CLEAN_HEALTH_NOT_OK");
  assert.match(s.err.join("\n"), /clean-up queue/);
  assert.equal(s.brain.liveUids("gmail").length, 390, "stopped before the second batch");
});

test("a short health blip is waited out, a lasting one stops the run", async (t) => {
  const s = await scenario(t);
  const sleeps = [];
  let healthCalls = 0;
  const bad = { ok: false, status: "storage-unavailable" };
  const good = s.brain.health;
  s.brain.hooks.beforeRequest = (path) => {
    if (path !== "/health") return;
    healthCalls++;
    s.brain.health = healthCalls <= 2 ? bad : good;      // two bad reads, then fine
  };
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true }, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result.exit_code, 0, s.err.join("\n"));
  assert.ok(sleeps.length >= 2, "it waited before looking again");
  assert.match(s.out.join("\n"), /health check was not ok .*checking again/);
  // A health problem that does not clear stops with the code and the system's words.
  const s2 = await scenario(t);
  s2.brain.health = bad;
  const stopped = await s2.run(await s2.list(gmail(1, 10)), { apply: true });
  assert.equal(stopped.code, "CLEAN_HEALTH_NOT_OK");
  assert.equal(s2.brain.requests.filter((r) => r.path === "/health").length, 3, "three looks, then stop");
});

test("setup and disk failures are support codes, not raw errors", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 10));
  const setup = await s.run(list, {}, { loadManifest: () => { throw new Error("ENOENT: no such file, open '/x/manifest.json'"); } });
  assert.equal(setup.code, "CLEAN_SETUP_FAILED");
  const noDisk = await s.run(list, { apply: true }, { writeFile: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } });
  assert.equal(noDisk.code, "CLEAN_PROGRESS_NOT_SAVED");
  assert.match(s.err.join("\n"), /EPERM/);
  const unreadable = await s.run(null, { restorePath: join(s.directory, "missing.ids") });
  assert.equal(unreadable.code, "CLEAN_LIST_INVALID");
});

test("--skip-check leaves out the end-of-run counter check", async (t) => {
  const s = await scenario(t);
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true, skipCheck: true });
  assert.equal(result.exit_code, 0, s.err.join("\n"));
  assert.ok(!s.brain.requests.some((r) => r.path.endsWith("corpus-stats/verify")));
  assert.equal(parseCleanArgs(["m.json", "--list", "a.ids", "--skip-check", "--allow-missing"]).skipCheck, true);
});

test("the restore and rollback hints say what they really do", async (t) => {
  const s = await scenario(t);
  await s.run(await s.list(gmail(1, 10)), { apply: true });
  const text = s.out.join("\n");
  assert.match(text, /To bring back single items: .*--restore <ids-file> --apply/);
  assert.match(text, /WHOLE run: .*m\.json .*mail loaded and bank-feed rows written since are lost too.*rebuild the search vectors/);
});

test("a protected document in a batch stops the run before that batch is removed", async (t) => {
  const s = await scenario(t);
  // A part whose stored provenance does not match its family is excluded by the Worker.
  s.brain.db.prepare(`INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
    VALUES ('gmail:m3#part2of2', 'gmail', 'm3#part2of2', 'odd', 1, 'h', '{"part_of":"somebody-else"}')`).run();
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true });
  assert.equal(result.code, "CLEAN_PLAN_CHANGED");
  assert.match(s.err.join("\n"), /protected/);
  assert.equal(s.brain.liveUids("gmail").length, 401);
  assert.equal(s.brain.ledger().length, 0);
});

test("a preview that names a document not on the list is refused", async (t) => {
  const s = await scenario(t);
  s.deps.fetchImpl = async (url, options) => {
    const response = await s.brain.fetch(url, options);
    if (JSON.parse(options.body || "{}").action !== "preview") return response;
    const body = await response.json();
    body.targets.push("gmail:m399"); body.documents = body.targets.length;
    return Response.json(body);
  };
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true });
  assert.equal(result.code, "CLEAN_PLAN_CHANGED");
  assert.equal(s.brain.liveUids("gmail").length, 400);
});

test("restore lets removed items load again: dry run first", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 20));
  await s.run(list, { apply: true });
  assert.equal(s.brain.ledger().filter((r) => r.restored_at === null).length, 20);
  const dry = await s.run(null, { restorePath: list });
  assert.equal(dry.dry_run.remembered_removals, 20);
  assert.equal(s.brain.ledger().filter((r) => r.restored_at === null).length, 20, "dry run changed nothing");
  const done = await s.run(null, { restorePath: list, apply: true });
  assert.equal(done.restored, 20);
  assert.equal(s.brain.ledger().filter((r) => r.restored_at === null).length, 0);
});

test("a network failure is a support code with the system's own words", async (t) => {
  const s = await scenario(t);
  s.brain.hooks.network = /ingest-capabilities/;
  const result = await s.run(await s.list(gmail(1, 10)), { apply: true });
  assert.equal(result.code, "CLEAN_HEALTH_NOT_OK");
  assert.match(result.provider_message, /fetch failed/);
});

test("arguments: usage errors are coded, flags are strict", () => {
  assert.deepEqual(parseCleanArgs(["m.json", "--list", "a.ids"]), { manifestPath: "m.json", apply: false, json: false, listPath: "a.ids" });
  assert.equal(parseCleanArgs(["m.json", "--list", "a.ids", "--apply", "--max-calls", "2", "--json"]).maxCalls, 2);
  for (const bad of [[], ["--list", "x"], ["m.json"], ["m.json", "--list"], ["m.json", "--list", "a", "--apply2"],
    ["m.json", "--list", "a", "--restore", "b"], ["m.json", "--list", "a", "--max-calls", "0"], ["m.json", "--list", "a", "--batch", "x"]]) {
    assert.throws(() => parseCleanArgs(bad), (e) => e instanceof CleanError && e.code === "CLEAN_USAGE", JSON.stringify(bad));
  }
});

test("provider messages are masked and every code prints a help link", () => {
  assert.equal(maskProviderMessage('boom "user@example.com" Bearer abc.def 0123456789abcdef0123 id 123456789'), "boom ... Bearer ... # id #");
  const lines = formatCleanError(new CleanError("CLEAN_D1_BUSY", { providerMessage: "D1_ERROR: D1 DB is overloaded.\nsecond line" }));
  assert.equal(lines[0].startsWith("CLEAN_D1_BUSY:"), true);
  assert.match(lines.join("\n"), /The system said: D1_ERROR: D1 DB is overloaded\./);
  assert.doesNotMatch(lines.join("\n"), /second line/);
  assert.match(lines.at(-1), /^ {2}More: https:\/\/financialbrain\.ai\/help\/CLEAN_D1_BUSY$/);
});

test("a resumed run is judged against the Brain's size when the stage started", async (t) => {
  // 190 of 1,000 is 19%. After 150 are gone the Brain holds 850, and 190/850 would be 22%.
  const s = await scenario(t, { gmailDocs: 400, driveDocs: 600 });
  const list = await s.list(gmail(1, 190));
  const first = await s.run(list, { apply: true, maxCalls: 3 });
  assert.equal(first.removed, 150);
  const second = await s.run(list, { apply: true });
  assert.equal(second.exit_code, 0, s.err.join("\n"));
  assert.equal(second.removed, 190);
  assert.equal(second.brain_documents_before, 1000);
  assert.equal(second.brain_documents_after, 810);
  assert.deepEqual(second.warnings, [], "the before/after check uses the start size too");
});

test("end-of-run checks report, never fail the run: count mismatch and repaired counters", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 60));
  let armed = true;
  s.brain.hooks.beforeRequest = (path) => {
    if (path.endsWith("corpus-stats/verify") && armed) {
      armed = false;
      s.brain.loadMany("drive", "arrived", 7, 1);                                        // mail arrived mid-run
      s.brain.db.exec("UPDATE corpus_stats SET documents = documents + 5 WHERE source = 'gmail'"); // and a counter drifted
    }
  };
  const result = await s.run(list, { apply: true });
  assert.equal(result.exit_code, 0, "the removal itself succeeded");
  assert.deepEqual([...result.warnings].sort(), ["CLEAN_COUNTERS_DRIFTED", "CLEAN_COUNT_MISMATCH"]);
  assert.deepEqual(s.brain.stats("gmail"), s.brain.truth("gmail"), "the drifted counter was repaired from the real rows");
  assert.match(s.out.join("\n"), /More: https:\/\/financialbrain\.ai\/help\/CLEAN_COUNT_MISMATCH/);
});

test("an older CLI (the 0.4.28 removal client) still works against the new Worker, without writing the ledger", async (t) => {
  const { requestIngestRemovalPlan } = await import("../operations/ingest-removal-plan.mjs");
  const s = await scenario(t);
  const send = (body) => requestIngestRemovalPlan({ base: BASE, adminKey: ADMIN_KEY, body, fetchImpl: s.brain.fetch,
    sleep: async () => {}, onProgress() {} });
  const families = gmail(1, 50).map((uid) => ({ base_doc_uid: uid, keep_doc_uids: [], family_kind: "structural" }));
  const preview = await send({ action: "preview", families });
  const applied = await send({ action: "apply", targets: preview.targets, marker: preview.marker });
  assert.equal(applied.documents, 50);
  assert.equal(s.brain.liveUids("gmail").length, 350);
  assert.deepEqual(s.brain.ledger(), [], "an old client never writes the memory");
  assert.deepEqual(s.brain.stats("gmail"), s.brain.truth("gmail"));
});

test("a staged clean cannot resume on another Brain with the same list", async (t) => {
  const first = await scenario(t);
  const second = await scenario(t);
  const list = await first.list(gmail(1, 2));
  await first.run(list, { previewAll: true, batchSize: 1 });
  const stage = await first.run(list, { apply: true, batchSize: 1, maxCalls: 1 });
  assert.equal(stage.removed, 1);
  const foreign = await second.run(list, { apply: true, batchSize: 1 });
  assert.equal(foreign.code, "CLEAN_NOT_ON_THIS_BRAIN");
  assert.equal(writes(second.brain).length, 0);
  assert.equal(second.restorePoints.length, 0);
});

test("a sample cannot authorize apply", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 160));
  const sample = await s.run(list);
  assert.equal(sample.dry_run.previewed_items, 150);
  assert.equal(sample.dry_run.sample, true);
  const result = await s.run(list, { apply: true, approve: false });
  assert.equal(result.code, "CLEAN_PLAN_CHANGED");
  assert.equal(s.restorePoints.length, 0);
  assert.equal(writes(s.brain).length, 0);
});

test("a crash after the 50-ID commit resumes from the same batch proof", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 50));
  await s.run(list, { previewAll: true });
  const stopped = await s.run(list, { apply: true }, {
    writeFile(path, data, options) {
      if (path.includes(".progress.") && JSON.parse(data).removed === 50) throw new Error("simulated interruption");
      writeFileSync(path, data, options);
    },
  });
  assert.equal(stopped.code, "CLEAN_PROGRESS_NOT_SAVED");
  assert.equal(s.brain.ledger().length, 50);
  const resumed = await s.run(list, { apply: true });
  assert.equal(resumed.exit_code, 0, s.err.join("\n"));
  assert.equal(resumed.removed, 50);
  assert.equal(writes(s.brain).length, 1);
  assert.equal(s.restorePoints.length, 1);
});

test("apply requires the approved digest and the reviewed inventory", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 160));
  const preview = await s.run(list, { previewAll: true });
  assert.equal(preview.dry_run.previewed_items, 160);
  assert.equal(preview.dry_run.sample, false);
  const wrongDigest = await s.run(list, { apply: true, reviewedPlanSha: "0".repeat(64) });
  assert.equal(wrongDigest.code, "CLEAN_PLAN_CHANGED");
  s.brain.db.prepare("UPDATE documents SET title='Changed synthetic revision' WHERE doc_uid='gmail:m160'").run();
  const stale = await s.run(list, { apply: true, reviewedPlanSha: preview.reviewed_plan.sha256 });
  assert.equal(stale.code, "CLEAN_PLAN_CHANGED");
  assert.equal(writes(s.brain).length, 0);
  assert.equal(s.restorePoints.length, 0);
});

test("a foreign bookmark and unbound progress are refused before writes", async (t) => {
  const s = await scenario(t);
  const list = await s.list(gmail(1, 2));
  const receipt = await s.run(list, { apply: true }, {
    restorePoint: async ({ brain }) => ({ brain: { ...brain, database_id: "other" }, bookmark: "synthetic" }),
  });
  assert.equal(receipt.code, "CLEAN_NOT_ON_THIS_BRAIN");
  assert.equal(writes(s.brain).length, 0);
  writeFileSync(join(s.directory, "stage.progress.json"), "{}");
  const progress = await s.run(list, { apply: true });
  assert.equal(progress.code, "CLEAN_NOT_ON_THIS_BRAIN");
  assert.equal(writes(s.brain).length, 0);
  assert.equal(s.restorePoints.length, 0);
});

test("the CLI verifies the live Worker DB binding and bookmarks precisely that D1", async (t) => {
  const { cmdClean } = await import("../brain.mjs");
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  const s = await scenario(t);
  const manifest = join(s.directory, "brain.manifest.json");
  const list = await s.list(gmail(1, 2));
  const accountId = "a".repeat(32);
  const databaseId = "11111111-1111-4111-8111-111111111111";
  const foreignId = "22222222-2222-4222-8222-222222222222";
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.invalid", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: accountId, d1_database_id: databaseId } },
  }));
  const home = `/accounts/${accountId}`;
  const bookmarkPath = `${home}/d1/database/${databaseId}/time_travel/bookmark`;
  const saved = [];
  const calls = [];
  let boundDatabase = databaseId;
  let foreignMarker = false;
  const options = {
    resolveAdminKey: () => ADMIN_KEY,
    resolveAccount: async () => ({ id: accountId }),
    withManifestControl: (_path, action) => action(),
    withBrainLifecycleLock: (_lock, action) => action(),
    saveBookmark: (receipt) => { saved.push(receipt); },
    cloudflare: async (path) => {
      calls.push(path);
      if (path === `${home}/workers/domains?service=fixture-brain`) {
        return [{ service: "fixture-brain", hostname: "brain.invalid" }];
      }
      if (path === `${home}/workers/scripts/fixture-brain/settings`) {
        return { bindings: [{ type: "d1", name: "DB", database_id: boundDatabase }] };
      }
      assert.equal(path, bookmarkPath);
      return { bookmark: "00000085-0000024c-4c0b5f2e8a1d" };
    },
    d1Query: async (account, db, sql) => {
      assert.equal(account, accountId);
      assert.equal(db, databaseId);
      const row = s.brain.db.prepare(sql).get();
      if (foreignMarker) row.instance = "0".repeat(32);
      return { results: [row] };
    },
    deps: { fetchImpl: s.brain.fetch, write: () => {}, writeError: () => {} },
  };
  const args = [manifest, "--list", list];
  const preview = await cmdClean([...args, "--preview-all"], options);
  assert.equal(preview.exit_code, 0);
  const apply = [...args, "--apply", "--plan-sha256", preview.reviewed_plan.sha256];
  boundDatabase = foreignId;
  assert.equal((await cmdClean(apply, options)).code, "CLEAN_NOT_ON_THIS_BRAIN");
  boundDatabase = databaseId;
  foreignMarker = true;
  assert.equal((await cmdClean(apply, options)).code, "CLEAN_NOT_ON_THIS_BRAIN");
  assert.equal(writes(s.brain).length, 0);
  assert.equal(calls.includes(bookmarkPath), false);
  foreignMarker = false;
  assert.equal((await cmdClean(apply, options)).removed, 2);
  assert.deepEqual(calls.filter((path) => path.includes("time_travel/bookmark")), [bookmarkPath]);
  assert.equal(saved[0].database_id, databaseId);
  assert.equal(saved[0].worker_url, BASE);
  assert.equal(saved[0].d1_instance, s.brain.db.prepare("SELECT instance FROM ingest_removal_generation").get().instance);
});
