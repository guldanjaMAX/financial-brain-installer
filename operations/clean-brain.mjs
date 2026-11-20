// brain clean <manifest> --list <ids-file> [--apply]
//
// "Clean my Brain": remove an exact, reviewed list of Gmail or Drive documents
// through the Brain's own removal route, remember each removal so a full re-read
// cannot load the item again, and take a restore point first.
//
//   sample (default)    previews up to three batches and writes no plan.
//   --preview-all       saves the complete target plan and prints its digest.
//   --apply             requires that digest, takes a restore point and applies
//                       the reviewed batches with an unbroken inventory fence.
//   --restore <file>    forget the removal memory for the listed ids, so the next
//                       ingest can load them again (dry run unless --apply).
//
// Every stop has a support code (operations/clean-brain-codes.mjs).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { CleanError, CLEAN_CODES, formatCleanError } from "./clean-brain-codes.mjs";

export const CLEAN_BATCH_SIZE = 50;
export const CLEAN_STAGE_CAP = 0.2;
// Gmail and Drive only: the two sources whose items can come back on a full re-read.
const ID_SHAPE = /^(?:gmail|drive):[^\s\u0000-\u001f\u007f-\u009f#]+$/u;
export const CLEAN_MISSING_CAP = 0.2;
const MISSING_CHECK_MIN = 50;

const partRoot = (uid) => String(uid).split("#part")[0];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const groups = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Read, shape-check and hash-check the reviewed list. Throws CLEAN_LIST_INVALID. */
export function readCleanList(listPath, { readFile = readFileSync, exists = existsSync } = {}) {
  const invalid = (detail) => new CleanError("CLEAN_LIST_INVALID", { detail });
  let raw;
  try { raw = readFile(listPath, "utf8"); } catch { throw invalid("The id list could not be read."); }
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw invalid("The id list is empty.");
  for (const [index, line] of lines.entries()) {
    if (!ID_SHAPE.test(line)) throw invalid(`Line ${index + 1} is not a gmail:<id> or drive:<id> value.`);
  }
  if (new Set(lines).size !== lines.length) throw invalid("The id list has a duplicate line.");
  const metaPath = resolve(dirname(resolve(listPath)), `${basename(listPath).replace(/\.ids$/, "")}.meta.json`);
  if (!exists(metaPath)) throw invalid("There is no .meta.json next to the list; an unreviewed list is not run.");
  let meta;
  try { meta = JSON.parse(readFile(metaPath, "utf8")); } catch { throw invalid("The .meta.json next to the list is not readable."); }
  const sha = sha256(raw);
  if (meta?.ids_sha256 && meta.ids_sha256 !== sha) throw invalid("The list changed after it was reviewed (sha256 differs).");
  if (!meta?.ids_sha256) throw invalid("The .meta.json has no ids_sha256.");
  if (meta.count !== undefined && meta.count !== lines.length) throw invalid(`The list has ${lines.length} ids but the review says ${meta.count}.`);
  return { ids: lines, sha };
}

function progressPathFor(listPath) {
  return resolve(dirname(resolve(listPath)), `${basename(listPath).replace(/\.ids$/, "")}.progress.json`);
}

function saveJson(path, value, { writeFile = writeFileSync, rename = renameSync } = {}) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flush: true });
  rename(temporary, path);
}

const sameMarker = (a, b) => a?.instance === b?.instance && a?.nonce === b?.nonce &&
  a?.generation === b?.generation && a?.runtime === b?.runtime;
const validMarker = (marker) => /^[a-f0-9]{32}$/.test(marker?.instance) &&
  /^[a-f0-9]{32}$/.test(marker?.nonce) && Number.isSafeInteger(marker?.generation) &&
  marker.generation >= 0 && typeof marker.runtime === "string" && marker.runtime.length > 0;
const sameBrain = (a, b) => a?.url === b?.url && a?.account_id === b?.account_id &&
  a?.database_id === b?.database_id && a?.instance === b?.instance;
const changed = (detail) => new CleanError("CLEAN_PLAN_CHANGED", { detail });
const wrongBrain = () => new CleanError("CLEAN_NOT_ON_THIS_BRAIN", {
  detail: "The Worker, D1 database, reviewed plan and saved restore point must identify the same Brain.",
});
const validBatch = (preview, batch) => {
  if (!validMarker(preview?.marker) || !Array.isArray(preview.targets) ||
      !Number.isSafeInteger(preview.excluded) || preview.excluded < 0 ||
      new Set(preview.targets).size !== preview.targets.length) return false;
  const asked = new Set(batch);
  if (!preview.targets.every((uid) => typeof uid === "string" && asked.has(partRoot(uid)))) return false;
  const roots = new Set(preview.targets.map(partRoot));
  return JSON.stringify(preview.alreadyGone) === JSON.stringify(batch.filter((uid) => !roots.has(uid)));
};

function readSavedJson(path, deps, invalid) {
  try {
    const raw = (deps.readFile ?? readFileSync)(path, "utf8");
    return { value: JSON.parse(raw), digest: sha256(raw) };
  } catch {
    throw invalid();
  }
}

function validateProgress(progress, { plan, planSha, brain, batchSize, ids, sha }) {
  if (!sameBrain(progress?.brain, brain) || !sameBrain(progress?.restore_point?.brain, brain)) throw wrongBrain();
  const { checksum, ...state } = progress;
  if (checksum !== sha256(JSON.stringify(state)) || progress.version !== 2 ||
      progress.plan_sha256 !== planSha || progress.list_sha256 !== sha || progress.batch_size !== batchSize ||
      typeof progress.restore_point.bookmark !== "string" || !progress.restore_point.bookmark ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(progress.run_id) || !Array.isArray(progress.events) ||
      !Number.isSafeInteger(progress.total_at_start) || progress.total_at_start < 1 ||
      !Number.isSafeInteger(progress.calls) || progress.calls < 0 || progress.calls > plan.batches.length ||
      progress.next_index !== Math.min(ids.length, progress.calls * batchSize) ||
      !validMarker(progress.marker) || progress.marker.instance !== brain.instance ||
      progress.marker.runtime !== plan.batches[0].marker.runtime) {
    throw changed("The saved progress or restore receipt does not match this reviewed plan.");
  }
  if (progress.pending !== null) {
    const pending = progress.pending;
    const batch = plan.batches[progress.calls];
    if (!batch || pending?.batch_no !== progress.calls || !/^[a-f0-9]{32}$/.test(pending.nonce) ||
        JSON.stringify(pending.targets) !== JSON.stringify(batch.targets)) {
      throw changed("The pending batch does not match the reviewed targets.");
    }
  }
  return state;
}

/**
 * The route client. One request, one parsed answer; never throws for an HTTP
 * status, so each caller decides what a status means. A transport failure is
 * returned as { network: true } with the system's own message.
 */
function makeClient({ base, adminKey, fetchImpl, timeoutMs = 60_000 }) {
  return async function call(method, path, body) {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method, redirect: "error",
        headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json", "User-Agent": "brain-clean/1" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let json = null;
      try { json = await response.json(); } catch { /* an empty or interrupted body still has a status */ }
      return { ok: response.ok, status: response.status, body: json };
    } catch (error) {
      return { ok: false, status: 0, network: true, body: null,
        message: ["TimeoutError", "AbortError"].includes(error?.name) ? "request timed out" : String(error?.message || error) };
    }
  };
}

const healthy = (response) => response.ok && response.body?.ok === true && response.body?.status === "ok" &&
  response.body?.accepting_documents !== false && response.body?.rollback_write_fence !== true &&
  (response.body?.vector_drain_mode === undefined || response.body.vector_drain_mode === "active");

/** The database's or the route's own words for a failed response, for the support line. */
const providerWords = (response) =>
  response.body?.provider_message || response.message ||
  (response.body?.error ? String(response.body.error) : `HTTP ${response.status}`);

/**
 * Run (or preview) a cleanup. Returns { exit_code, ... }; never throws for a
 * handled stop. `deps` lets tests replace the network, clock, Cloudflare and disk.
 */
export async function runClean({
  manifestPath, listPath, apply = false, restorePath = null,
  batchSize = CLEAN_BATCH_SIZE, maxCalls = Infinity, previewBatches = 3,
  previewAll = false, reviewedPlanSha = null,
  pauseMs = 400, healthEvery = 10, backlogMax = 5_000, backlogWaitMs = 10 * 60_000,
  retries = 3, reason = "owner_removal", json = false, allowMissing = false, skipCheck = false,
} = {}, deps = {}) {
  const write = deps.write ?? console.log;
  const sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const line = (text) => { if (!json) write(text); };
  const summary = { exit_code: 0, applied: apply, removed: 0, already_gone: 0, batches: 0 };
  try {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > CLEAN_BATCH_SIZE) {
      throw new CleanError("CLEAN_USAGE", { detail: `--batch must be 1 to ${CLEAN_BATCH_SIZE}.` });
    }
    let manifest, adminKey, base;
    try {
      manifest = deps.loadManifest(manifestPath);
      adminKey = deps.resolveAdminKey(manifestPath);
      if (!adminKey) throw new CleanError("CLEAN_NOT_ON_THIS_BRAIN");
      const url = new URL(await deps.resolveBaseUrl(manifest));
      if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`) {
        throw new Error("The Brain address must be an HTTPS origin.");
      }
      base = url.origin;
    } catch (error) {
      if (error instanceof CleanError) throw error;
      throw new CleanError("CLEAN_SETUP_FAILED", { providerMessage: error?.message, cause: error });
    }
    const call = makeClient({ base, adminKey, fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: deps.timeoutMs });

    if (restorePath) return await restoreRemoved({ restorePath, apply, call, line, summary, deps });

    const { ids, sha } = readCleanList(listPath, deps);
    const progressPath = progressPathFor(listPath);
    const planPath = progressPath.replace(/\.progress\.json$/, ".clean-plan.json");
    const missingPath = progressPath.replace(/\.progress\.json$/, ".already-gone.txt");
    summary.list = { count: ids.length, sha256: sha };
    const sources = [...new Set(ids.map((uid) => uid.slice(0, uid.indexOf(":"))))].sort();

    // 1. Is this Brain able to do the job?
    const capabilities = await call("GET", "/api/admin/brain/ingest-capabilities");
    if (!capabilities.ok || capabilities.body?.owner_removal_ledger !== 1) {
      if (capabilities.network || capabilities.status >= 500) {
        throw new CleanError("CLEAN_HEALTH_NOT_OK", { providerMessage: providerWords(capabilities) });
      }
      throw new CleanError("CLEAN_WORKER_TOO_OLD");
    }
    // The Brain's own health check can flick to "storage unavailable" for a few
    // seconds while the database is busy. Wait and look again before stopping.
    const checkHealth = async () => {
      let health;
      for (let attempt = 0; attempt < 3; attempt++) {
        health = await call("GET", "/health");
        if (healthy(health)) return;
        if (attempt < 2) {
          line(`The Brain's health check was not ok (${providerWords(health)}); checking again in ${5 * (attempt + 1)} seconds.`);
          await sleep(5000 * (attempt + 1));
        }
      }
      throw new CleanError("CLEAN_HEALTH_NOT_OK", { providerMessage: providerWords(health) });
    };
    await checkHealth();
    const readSize = async () => {
      // One cheap read of the per-source counters. The Brain's documents page does
      // not count documents on a large Brain, so it cannot be used for this.
      const size = await call("POST", "/api/admin/brain/owner-removals", { action: "size" });
      if (!size.ok) throw new CleanError("CLEAN_BRAIN_SIZE_UNKNOWN", { providerMessage: providerWords(size) });
      const total = Number(size.body?.documents);
      if (!Number.isSafeInteger(total) || total < 1) throw new CleanError("CLEAN_BRAIN_SIZE_UNKNOWN");
      const queue = size.body?.vector_backlog;
      // A queue the Worker reports as capped is at least 10,001: over any limit set below that.
      const backlog = queue?.pending_is_capped === true ? Number.MAX_SAFE_INTEGER : Number(queue?.pending ?? 0);
      return { total, backlog: Number.isFinite(backlog) && backlog >= 0 ? backlog : 0 };
    };
    const batches = groups(ids, batchSize);
    const currentMarker = (await previewBatch(call, [])).marker;
    let brain;
    if (apply || previewAll) {
      try {
        brain = await deps.verifyTarget({ manifest, url: base, marker: currentMarker });
      } catch {
        throw wrongBrain();
      }
      if (brain?.url !== base || brain?.instance !== currentMarker.instance || !brain.account_id || !brain.database_id) {
        throw wrongBrain();
      }
    }

    let plan;
    let progress = null;
    const hasProgress = (deps.exists ?? existsSync)(progressPath);
    if (apply) {
      const saved = readSavedJson(planPath, deps, () => changed("Run --preview-all and review the complete plan before applying."));
      plan = saved.value;
      if (!sameBrain(plan?.brain, brain)) throw wrongBrain();
      if (saved.digest !== reviewedPlanSha || plan.version !== 1 || plan.list_sha256 !== sha ||
          plan.batch_size !== batchSize || !Array.isArray(plan.batches) || plan.batches.length !== batches.length ||
          !plan.batches.every((batch, index) => validBatch(batch, batches[index]) &&
            sameMarker(batch.marker, plan.batches[0].marker) && batch.marker.instance === brain.instance)) {
        throw changed("The complete plan, list or approved digest does not match.");
      }
      if (hasProgress) {
        const { value } = readSavedJson(progressPath, deps, wrongBrain);
        progress = validateProgress(value, { plan, planSha: reviewedPlanSha, brain, batchSize, ids, sha });
      }
      if ((!progress || !progress.pending) && !sameMarker(progress?.marker ?? plan.batches[0].marker, currentMarker)) {
        throw changed("The Brain inventory changed after review or after the last completed batch.");
      }
    } else if (previewAll && hasProgress) {
      throw changed("This list already has progress. Resume with its approved plan or review the remaining items in a new list.");
    }

    const current = await readSize();
    // The 20% limit and the before/after report use the Brain's size when this
    // stage STARTED: a resumed run sees a smaller Brain and must not be refused.
    const before = { ...current, total: progress?.total_at_start ?? current.total };
    const share = ids.length / before.total;
    summary.brain_documents_before = before.total;
    summary.share = Number(share.toFixed(4));
    line(`Clean my Brain: ${ids.length.toLocaleString("en-US")} item(s) from ${sources.join(", ")}, ` +
      `${(share * 100).toFixed(1)}% of ${before.total.toLocaleString("en-US")} documents. ${apply ? "APPLY" : "DRY RUN, nothing in the Brain is written"}.`);
    if (share > CLEAN_STAGE_CAP) {
      throw new CleanError("CLEAN_STAGE_TOO_LARGE",
        { detail: `This list is ${(share * 100).toFixed(1)}% of the Brain; the limit is ${CLEAN_STAGE_CAP * 100}% per stage.` });
    }
    const fresh = !progress;
    if (!apply) {
      return await dryRun({ ids, batches, call, previewBatches, previewAll, line, summary, allowMissing,
        brain, currentMarker, planPath, sha, batchSize, deps });
    }
    const targetCount = plan.batches.reduce((count, batch) => count + batch.targets.length, 0);
    if (targetCount / before.total > CLEAN_STAGE_CAP) {
      throw new CleanError("CLEAN_STAGE_TOO_LARGE", { detail:
        "The reviewed documents, including parts, exceed the 20% stage limit." });
    }
    if (plan.batches.some((batch) => batch.excluded > 0 || batch.targets.length > CLEAN_BATCH_SIZE)) {
      throw changed("The reviewed plan contains protected documents or a batch exceeds the exact apply limit. Review a revised list or smaller batches.");
    }
    if (fresh && !allowMissing) {
      let seen = 0;
      const gone = [];
      for (const [index, batch] of plan.batches.entries()) {
        seen += batches[index].length;
        gone.push(...batch.alreadyGone);
        if (seen >= Math.min(MISSING_CHECK_MIN, ids.length) && gone.length / seen > CLEAN_MISSING_CAP) {
          writeMissing(missingPath, gone, deps.writeFile);
          throw tooManyMissing(seen, gone.length, missingPath);
        }
      }
    }
    progress ||= { version: 2, brain, plan_sha256: reviewedPlanSha, list_sha256: sha,
      marker: plan.batches[0].marker, pending: null, run_id: `clean_${now().toString(36)}_${randomBytes(16).toString("hex")}`,
      batch_size: batchSize, next_index: 0, removed: 0, already_gone: 0, calls: 0, restore_point: null,
      total_at_start: before.total,
      started_at: new Date(now()).toISOString(), events: [] };
    const persist = () => {
      try { saveJson(progressPath, { ...progress, checksum: sha256(JSON.stringify(progress)) }, deps); }
      catch (error) { throw new CleanError("CLEAN_PROGRESS_NOT_SAVED", { providerMessage: error?.message, cause: error }); }
    };
    if (!progress.restore_point) {
      let restorePoint;
      try { restorePoint = await deps.restorePoint({ brain, marker: currentMarker }); }
      catch (error) { throw new CleanError("CLEAN_RESTORE_POINT_FAILED", { providerMessage: error?.message, cause: error }); }
      if (!sameBrain(restorePoint?.brain, brain)) throw wrongBrain();
      if (typeof restorePoint?.bookmark !== "string" || !restorePoint.bookmark) {
        throw new CleanError("CLEAN_RESTORE_POINT_FAILED", { providerMessage: "Cloudflare returned no bookmark" });
      }
      progress.restore_point = { brain, bookmark: restorePoint.bookmark, taken_at: new Date(now()).toISOString(), ...(restorePoint.saved_at ? { saved_at: restorePoint.saved_at } : {}) };
      persist();
    }
    summary.run_id = progress.run_id;
    summary.restore_point = progress.restore_point.bookmark;
    line(`Restore point saved (${progress.restore_point.bookmark}).`);
    line("To bring back single items: brain clean <manifest> --restore <ids-file> --apply (then ingest again).");
    line(`To undo the WHOLE run: ${deps.rollbackHint?.(progress.restore_point.bookmark) ?? "restore the D1 database to that bookmark"}. ` +
      "That puts the whole database back as it was at this moment: mail loaded and bank-feed rows written since are lost too, " +
      "and brain update must then rebuild the search vectors. Use it only if the run went wrong.");
    line(fresh ? "Starting." : `Resuming at item ${progress.next_index.toLocaleString("en-US")}.`);

    // 3. Batches.
    let calls = 0;
    for (let batchNo = progress.calls; batchNo < batches.length; batchNo++) {
      if (calls >= maxCalls) { line(`Stopped after ${calls} batch(es) as asked (--max-calls). Run again to continue.`); break; }
      if (batchNo > 0 && batchNo % healthEvery === 0) {
        await checkHealth();
        // Wait for the vector clean-up queue to drain rather than pile onto it.
        let waited = 0;
        for (;;) {
          const size = await readSize();
          if (size.backlog <= backlogMax) break;
          if (waited >= backlogWaitMs) throw new CleanError("CLEAN_HEALTH_NOT_OK", { detail: `The clean-up queue holds ${size.backlog.toLocaleString("en-US")} items; it needs to drain first.` });
          line(`Waiting for the clean-up queue (${size.backlog.toLocaleString("en-US")} items) to drain...`);
          await sleep(30_000); waited += 30_000;
        }
      }
      const outcome = await oneBatch({ ids: batches[batchNo], batchNo, call, progress, persist, retries, sleep, reason, line,
        preview: plan.batches[batchNo], missing: {
          allow: allowMissing, path: missingPath, min: Math.min(MISSING_CHECK_MIN, ids.length),
          listed: () => plan.batches.slice(0, batchNo + 1).flatMap((batch) => batch.alreadyGone),
          writeFile: deps.writeFile,
        } });
      progress.marker = outcome.marker;
      progress.pending = null;
      progress.removed += outcome.removed;
      progress.already_gone += outcome.alreadyGone;
      progress.next_index = Math.min(ids.length, (batchNo + 1) * batchSize);
      progress.calls += 1;
      if (outcome.lateReceipt) progress.events.push({ code: "CLEAN_LATE_RECEIPT", batch_no: batchNo });
      persist();
      calls++;
      summary.batches++;
      if (batchNo % 10 === 9 || batchNo === batches.length - 1) {
        line(`Removed ${progress.removed.toLocaleString("en-US")} of ${ids.length.toLocaleString("en-US")}` +
          `${progress.already_gone ? ` (${progress.already_gone.toLocaleString("en-US")} were already gone)` : ""}.`);
      }
      if (pauseMs && batchNo < batches.length - 1) await sleep(pauseMs);
    }
    summary.removed = progress.removed;
    summary.already_gone = progress.already_gone;
    if (progress.already_gone) {
      line(`${progress.already_gone.toLocaleString("en-US")} id(s) were not in the Brain and were remembered as removed; ` +
        `they are listed in ${missingPath}. Check that list if any of them should not be there.`);
      summary.already_gone_list = missingPath;
    }
    summary.done = progress.next_index >= ids.length;

    // 4. Counters, then the before and after report.
    if (summary.done) await finishRun({ sources, call, before, readSize, progress, line, summary, persist, skipCheck });
    return summary;
  } catch (error) {
    if (!(error instanceof CleanError)) throw error;
    summary.exit_code = 1;
    summary.code = error.code;
    summary.provider_message = error.providerMessage;
    for (const text of formatCleanError(error)) (deps.writeError ?? console.error)(text);
    return summary;
  }
}

async function dryRun({ ids, batches, call, previewBatches, previewAll, line, summary, allowMissing,
  brain, currentMarker, planPath, sha, batchSize, deps }) {
  let would = 0, gone = 0, protectedDocs = 0;
  const missingExamples = [];
  const reviewed = [];
  const sample = previewAll ? batches : batches.slice(0, previewBatches);
  for (const batch of sample) {
    const preview = await previewBatch(call, batch, currentMarker);
    if (!sameMarker(preview.marker, currentMarker)) throw changed("The Brain changed during preview.");
    if (previewAll) reviewed.push(preview);
    would += preview.targets.length;
    gone += preview.alreadyGone.length;
    protectedDocs += preview.excluded;
    for (const uid of preview.alreadyGone) if (missingExamples.length < 5) missingExamples.push(uid);
  }
  const sampled = sample.reduce((n, batch) => n + batch.length, 0);
  const missingShare = sampled ? gone / sampled : 0;
  let prefixSeen = 0, prefixGone = 0;
  const wouldStop = !allowMissing && (previewAll ? reviewed.some((batch, index) => {
    prefixSeen += batches[index].length;
    prefixGone += batch.alreadyGone.length;
    return prefixSeen >= Math.min(MISSING_CHECK_MIN, ids.length) && prefixGone / prefixSeen > CLEAN_MISSING_CAP;
  }) : sampled >= Math.min(MISSING_CHECK_MIN, ids.length) && missingShare > CLEAN_MISSING_CAP);
  summary.dry_run = { sample: !previewAll, previewed_items: sampled, would_remove_documents: would, already_gone: gone, protected: protectedDocs,
    ...(wouldStop ? { would_stop: "CLEAN_MANY_MISSING" } : {}) };
  line(`${previewAll ? "Complete preview" : "Sample preview"}: ${sample.length} of ${batches.length} batch(es): ${would.toLocaleString("en-US")} document(s) would be removed, ` +
    `${gone.toLocaleString("en-US")} of ${sampled.toLocaleString("en-US")} item(s) not in the Brain, ${protectedDocs.toLocaleString("en-US")} protected.`);
  if (gone) {
    line(`Not in the Brain, for example: ${missingExamples.join(", ")}. With --apply they are remembered as removed, so check that they are right.`);
  }
  if (wouldStop) {
    line("The missing-ID limit would stop --apply with CLEAN_MANY_MISSING " +
      "unless you add --allow-missing (use that only if you removed them earlier on purpose).");
  }
  if (previewAll) {
    const plan = { version: 1, brain, list_sha256: sha, batch_size: batchSize, batches: reviewed };
    try { saveJson(planPath, plan, deps); }
    catch (error) { throw new CleanError("CLEAN_PROGRESS_NOT_SAVED", { providerMessage: error?.message }); }
    const digest = sha256(JSON.stringify(plan, null, 2) + "\n");
    summary.reviewed_plan = { path: planPath, sha256: digest };
    line(`Review the exact targets in ${planPath}. If approved, rerun with --apply --plan-sha256 ${digest}.`);
  } else {
    line("Run --preview-all to create a complete plan for review before applying.");
  }
  return summary;
}

/** Fresh preview for one batch of base ids. Stops on anything not asked for. */
async function previewBatch(call, batch, marker = null) {
  const response = await call("POST", "/api/admin/brain/ingest-removal-plan", {
    action: "preview", marker,
    families: batch.map((uid) => ({ base_doc_uid: uid, keep_doc_uids: [], family_kind: "structural" })),
  });
  if (!response.ok) throw failedRoute(response);
  const body = response.body;
  const excluded = body?.excluded_documents ?? 0;
  if (!validMarker(body?.marker) || !Array.isArray(body.targets) || body.documents !== body.targets.length ||
      body.targets.some((uid) => typeof uid !== "string") || new Set(body.targets).size !== body.targets.length ||
      !Number.isSafeInteger(excluded) || excluded < 0) {
    throw new CleanError("CLEAN_BATCH_UNVERIFIED", { detail: "The Brain did not return an exact preview." });
  }
  const asked = new Set(batch);
  const roots = new Set();
  for (const target of body.targets) {
    const root = partRoot(target);
    if (!asked.has(root)) {
      throw new CleanError("CLEAN_PLAN_CHANGED", { detail: "The preview named a document that is not on the list; nothing was removed." });
    }
    roots.add(root);
  }
  return {
    marker: body.marker, targets: [...body.targets].sort(),
    alreadyGone: batch.filter((uid) => !roots.has(uid)),
    excluded,
  };
}

/** Map a failed route response to a support code, keeping the system's own words. */
function failedRoute(response) {
  const code = response.body?.code;
  if (response.status === 409 && code === "INGEST_REMOVAL_CHANGED") return new CleanError("CLEAN_PLAN_CHANGED");
  if (response.status === 409 && code === "INGEST_REMOVAL_UNVERIFIED") return new CleanError("CLEAN_BATCH_UNVERIFIED", { providerMessage: providerWords(response) });
  if (response.status === 400 && code === "INGEST_REMOVAL_INVALID") return new CleanError("CLEAN_WORKER_TOO_OLD", { providerMessage: providerWords(response) });
  if (response.status === 403 || response.status === 401) return new CleanError("CLEAN_NOT_ON_THIS_BRAIN", { providerMessage: providerWords(response) });
  if (code === "OWNER_REMOVAL_SOURCE_UNSUPPORTED") return new CleanError("CLEAN_SOURCE_UNSUPPORTED", { providerMessage: providerWords(response) });
  if (code === "OWNER_REMOVAL_FAMILY_LIVE") return new CleanError("CLEAN_PLAN_CHANGED", { providerMessage: providerWords(response) });
  if (response.status === 404 || code === "OWNER_REMOVAL_INVALID") return new CleanError("CLEAN_WORKER_TOO_OLD", { providerMessage: providerWords(response) });
  const busy = response.network || response.status >= 500 || response.status === 429;
  return new CleanError(busy ? "CLEAN_D1_BUSY" : "CLEAN_HEALTH_NOT_OK", {
    providerMessage: providerWords(response),
  });
}

function writeMissing(path, ids, writeFile = writeFileSync) {
  try { writeFile(path, ids.join("\n") + "\n", { mode: 0o600 }); }
  catch (error) { throw new CleanError("CLEAN_PROGRESS_NOT_SAVED", { providerMessage: error?.message, cause: error }); }
}

function tooManyMissing(seen, gone, path) {
  return new CleanError("CLEAN_MANY_MISSING", { detail:
    `${gone.toLocaleString("en-US")} of the first ${seen.toLocaleString("en-US")} ids are not in the Brain (more than ${CLEAN_MISSING_CAP * 100}%). ` +
    `No additional ids were remembered. The ids are listed in ${path}.` });
}

async function oneBatch({ ids, batchNo, call, progress, persist, preview, retries, sleep, reason, line, missing }) {
  const { targets, alreadyGone } = preview;
  const before = progress.marker;
  const proofOfCommit = async () => {
    const proof = await readProof(call, progress.run_id, batchNo, targets, sleep);
    if (proof === "untouched") return null;
    if (proof !== "committed") throw new CleanError("CLEAN_BATCH_UNVERIFIED");
    const marker = (await previewBatch(call, [])).marker;
    if (!isBatchReceipt(marker)) throw changed("The batch committed, but the inventory moved after its receipt.");
    line(`Batch ${batchNo + 1}: the receipt was lost but the read-back proves it was removed (CLEAN_LATE_RECEIPT).`);
    return { removed: targets.length, alreadyGone: alreadyGone.length, lateReceipt: true, marker };
  };
  const isBatchReceipt = (marker) => validMarker(marker) && marker.instance === before.instance &&
    marker.runtime === before.runtime && marker.nonce === progress.pending.nonce &&
    marker.generation > before.generation;

  // Reconcile a saved attempt before interpreting missing IDs or retrying a write.
  if (progress.pending && targets.length) {
    const outcome = await proofOfCommit();
    if (outcome) return outcome;
  }
  await previewBatch(call, [], before);

  if (alreadyGone.length) {
    const seen = progress.next_index + ids.length;
    const gone = progress.already_gone + alreadyGone.length;
    writeMissing(missing.path, missing.listed(), missing.writeFile);
    if (!missing.allow && seen >= missing.min && gone / seen > CLEAN_MISSING_CAP) {
      throw tooManyMissing(seen, gone, missing.path);
    }
  }

  if (!progress.pending) {
    progress.pending = { batch_no: batchNo, targets, nonce: randomBytes(16).toString("hex") };
    persist();
  }
  if (alreadyGone.length) {
    const remembered = await call("POST", "/api/admin/brain/owner-removals", {
      action: "remember", families: alreadyGone, run_id: progress.run_id, reason, marker: before });
    if (!remembered.ok) throw failedRoute(remembered);
    if (remembered.body?.remembered !== alreadyGone.length) throw new CleanError("CLEAN_BATCH_UNVERIFIED");
  }
  if (!targets.length) return { removed: 0, alreadyGone: alreadyGone.length, lateReceipt: false, marker: before };

  let lastFailure;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const applied = await call("POST", "/api/admin/brain/ingest-removal-plan", {
      action: "apply", targets, marker: before, receipt_nonce: progress.pending.nonce,
      remember_removal: true, run_id: progress.run_id, batch_no: batchNo, reason });
    if (applied.ok) {
      const receipt = applied.body;
      if (receipt?.documents !== targets.length || receipt.remembered !== true ||
          receipt.run_id !== progress.run_id || receipt.batch_no !== batchNo || !isBatchReceipt(receipt.marker)) {
        throw new CleanError("CLEAN_BATCH_UNVERIFIED", { detail: "The Brain's receipt did not match the batch." });
      }
      return { removed: receipt.documents, alreadyGone: alreadyGone.length, lateReceipt: false, marker: receipt.marker };
    }
    if (applied.status >= 400 && applied.status < 500 && applied.status !== 429) throw failedRoute(applied);

    const outcome = await proofOfCommit();
    if (outcome) return outcome;
    lastFailure = applied;
    if (attempt < retries) {
      line(`Batch ${batchNo + 1}: the database was busy (${providerWords(applied)}); retrying.`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw failedRoute(lastFailure);
}

/** "committed", "untouched", "partial" or "unknown" from the exact batch proof. */
async function readProof(call, runId, batchNo, targets, sleep) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const proof = await call("POST", "/api/admin/brain/owner-removals", {
      action: "proof", run_id: runId, batch_no: batchNo, targets });
    if (proof.ok && proof.body) {
      if (proof.body.committed === true) return "committed";
      if (proof.body.remaining_documents === targets.length && proof.body.ledger_rows === 0) return "untouched";
      return "partial";
    }
    await sleep(1500 * (attempt + 1));
  }
  return "unknown";
}

async function finishRun({ sources, call, before, readSize, progress, line, summary, persist, skipCheck = false }) {
  const warnings = [];
  // The check reads every Gmail or Drive row once through an index; --skip-check leaves it out.
  for (const source of skipCheck ? [] : sources) {
    const check = await call("POST", "/api/admin/brain/corpus-stats/verify", { source });
    if (check.ok && check.body?.matches === false) {
      const repaired = await call("POST", "/api/admin/brain/corpus-stats/verify", { source, repair: true, instance: progress.brain.instance });
      warnings.push(new CleanError("CLEAN_COUNTERS_DRIFTED", {
        detail: `${source}: the stored counts were ${repaired.ok && repaired.body?.repaired ? "repaired" : "not repaired"}.` }));
    }
  }
  let after = null;
  try { after = await readSize(); } catch { /* the report below says it could not be read */ }
  summary.brain_documents_after = after?.total ?? null;
  if (after && before.total - after.total !== progress.removed) {
    warnings.push(new CleanError("CLEAN_COUNT_MISMATCH", {
      detail: `Before ${before.total.toLocaleString("en-US")}, after ${after.total.toLocaleString("en-US")}, removed ${progress.removed.toLocaleString("en-US")}.` }));
  }
  progress.finished_at = new Date().toISOString();
  persist();
  line(`Done. Removed ${progress.removed.toLocaleString("en-US")} document(s)` +
    `${after ? `; the Brain went from ${before.total.toLocaleString("en-US")} to ${after.total.toLocaleString("en-US")} documents` : ""}. ` +
    "Removed items are remembered, so a full re-read will not load them again.");
  summary.warnings = warnings.map((w) => w.code);
  for (const warning of warnings) for (const text of formatCleanError(warning)) line(text);
}

async function restoreRemoved({ restorePath, apply, call, line, summary, deps }) {
  let raw;
  try { raw = (deps.readFile ?? readFileSync)(restorePath, "utf8"); }
  catch { throw new CleanError("CLEAN_LIST_INVALID", { detail: "The restore list could not be read." }); }
  const ids = [...new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.some((uid) => !ID_SHAPE.test(uid))) {
    throw new CleanError("CLEAN_LIST_INVALID", { detail: "The restore list is empty or has a line that is not gmail:<id> or drive:<id>." });
  }
  const capabilities = await call("GET", "/api/admin/brain/ingest-capabilities");
  if (!capabilities.ok || capabilities.body?.owner_removal_ledger !== 1) throw new CleanError("CLEAN_WORKER_TOO_OLD");
  if (!apply) {
    let remembered = 0;
    for (const source of [...new Set(ids.map((uid) => uid.slice(0, uid.indexOf(":"))))]) {
      const ofSource = ids.filter((uid) => uid.startsWith(`${source}:`));
      for (const batch of groups(ofSource, 97)) {
        const check = await call("POST", "/api/admin/brain/owner-removals", { action: "check", source, uids: batch });
        if (!check.ok) throw failedRoute(check);
        remembered += check.body.owner_removed.length;
      }
    }
    summary.dry_run = { remembered_removals: remembered };
    line(`${remembered.toLocaleString("en-US")} of ${ids.length.toLocaleString("en-US")} item(s) are remembered as removed. Nothing was written. Add --apply to allow them to load again.`);
    return summary;
  }
  let restored = 0;
  for (const batch of groups(ids, 50)) {
    const response = await call("POST", "/api/admin/brain/owner-removals", { action: "restore", families: batch });
    if (!response.ok) throw failedRoute(response);
    restored += response.body.restored;
  }
  summary.restored = restored;
  line(`Restored ${restored.toLocaleString("en-US")} item(s): they are no longer blocked. ` +
    "A Gmail item comes back when a full read reaches it again; a Drive item comes back the next time it is edited " +
    "(or after a full Drive re-read). Run brain ingest to start that. Nothing is loaded by this command itself.");
  return summary;
}

const USAGE = "usage: brain clean <manifest> --list <ids-file> [--apply] [--max-calls N] [--batch N] [--preview N | --preview-all] [--plan-sha256 SHA256] [--allow-missing] [--skip-check] [--json]\n" +
  "       brain clean <manifest> --restore <ids-file> [--apply]";

/** Parse `brain clean` arguments. Throws CLEAN_LIST_INVALID with the usage text. */
export function parseCleanArgs(argv) {
  const bad = (detail) => new CleanError("CLEAN_USAGE", { detail: `${detail}\n  ${USAGE}` });
  if (!Array.isArray(argv) || !argv[0] || argv[0].startsWith("--")) throw bad("A manifest path is required.");
  const out = { manifestPath: argv[0], apply: false, json: false };
  const valued = { "--list": "listPath", "--restore": "restorePath", "--max-calls": "maxCalls", "--batch": "batchSize",
    "--preview": "previewBatches", "--plan-sha256": "reviewedPlanSha", "--pause-ms": "pauseMs" };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--apply") out.apply = true;
    else if (flag === "--preview-all") out.previewAll = true;
    else if (flag === "--json") out.json = true;
    else if (flag === "--allow-missing") out.allowMissing = true;
    else if (flag === "--skip-check") out.skipCheck = true;
    else if (Object.hasOwn(valued, flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw bad(`${flag} needs a value.`);
      const key = valued[flag];
      if (["maxCalls", "batchSize", "previewBatches", "pauseMs"].includes(key)) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < (key === "pauseMs" ? 0 : 1)) throw bad(`${flag} needs a whole number.`);
        out[key] = number;
      } else out[key] = value;
    } else throw bad(`Unknown option ${String(flag).slice(0, 40)}.`);
  }
  if (!out.listPath && !out.restorePath) throw bad("Give --list <ids-file> (or --restore <ids-file>).");
  if (out.listPath && out.restorePath) throw bad("Use --list or --restore, not both.");
  if (out.previewAll && (out.apply || out.restorePath || out.previewBatches)) throw bad("--preview-all is for a list preview.");
  if (out.reviewedPlanSha !== undefined && (!out.listPath || !out.apply || !/^[a-f0-9]{64}$/.test(out.reviewedPlanSha))) {
    throw bad("--plan-sha256 needs the complete plan digest and --list --apply.");
  }
  return out;
}

export { CLEAN_CODES };
