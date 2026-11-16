/** Bounded add/update-only Drive ingestion. Checkpoints contain metadata, never bytes. */
import { readCurrentIngestParts, revalidateIngestProgress } from './ingest-part-proof.mjs';
export const DRIVE_CHANGE_LIMITS = Object.freeze({ pageSize: 50, maxPages: 2, maxFiles: 100, timeBudgetMs: 60_000 });

// Closed admission codes from the paired writer. Never turn an arbitrary
// error string or an unknown retryable=false result into cursor settlement.
const ADMISSION_REASONS = Object.freeze({
  retained_prior_revision_limit: 'The accepted document exceeds the bounded revision snapshot limit; its text is retained. Owner-reviewed recovery is required.',
  retained_incoming_revision_limit: 'The replacement exceeds the bounded chunk limit; the accepted text is retained. Split the source document before retrying.',
  retained_document_retired: 'The accepted document is retired; owner-reviewed recovery is required before accepting a replacement.',
});

function partFailure(item, result) {
  const deterministic = Object.hasOwn(ADMISSION_REASONS, result.code) && result.retryable === false && result.retry_class === 'owner_recovery';
  return { source_id:item.envelope.source_id,
    code:deterministic ? result.code : 'ingest_write_failed', retryable:!deterministic,
    retry_class:deterministic ? 'owner_recovery' : 'retry',
    reason:deterministic ? ADMISSION_REASONS[result.code] : 'The document write failed; retry the same file identity. Accepted text is retained.' };
}

// Only shared access, transport/protocol uncertainty, lost ownership or an
// uncertain checkpoint can stop independent entry work. A held-item provider
// outage retains the R11 recovery rule: the feed is still independently tested.
function runWideFailure(error, recovery) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.checkpointFailure || current.driveRunWide || current.needsReauth ||
        current.system_evidence || current.code === 'source_ingest_lock_lost' ||
        current.code === 'NETWORK_UNREACHABLE' || [401, 403, 429].includes(current.status) ||
        ['tokenRefreshError', 'rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(current.reason)) return true;
    if (!recovery && (current.status === 0 || (current.status >= 500 && !current.driveItemFailure) ||
        ['networkError', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(current.reason || current.code) ||
        ['AbortError', 'TimeoutError'].includes(current.name))) return true;
  }
  return false;
}

function checkpointWriter(persist) {
  return () => {
    try { persist(); }
    catch (error) { throw Object.assign(error, { checkpointFailure:true }); }
  };
}

export function driveIncrementalStatus(state = {}) {
  return {
    mode: "incremental_add_update_only",
    token_saved: Boolean(state.sync_token),
    last_successful_change_token_at: state.drive_change_token_at || null,
    last_run: state.drive_incremental_last_run || null,
    pending_removals: Object.keys(state.drive_pending_removals || {}).length,
    failures: Object.values(state.drive_failures || {}),
    skipped_items: Object.values(state.drive_failures || {}),
    error: state.drive_incremental_error || null,
    page_pending: Boolean(state.drive_change_page),
    recovery_pending: Object.keys(state.drive_restore_pending || {}).length,
    history_backfill_complete: false,
  };
}

export function renderDriveIncrementalStatus(state, display = String) {
  const status = driveIncrementalStatus(state);
  return [
    "Drive: incremental, add/update only",
    `Last successful change-token time: ${status.last_successful_change_token_at || "never"}`,
    `Last run: ${status.last_run?.created || 0} added, ${status.last_run?.updated || 0} updated; ${status.last_run?.feed_caught_up ? "change feed caught up" : "change feed incomplete or not yet checked"}; coverage ${status.last_run?.complete ? "checked for this window" : "incomplete"}`,
    `Pending owner removal decisions: ${status.pending_removals}`,
    `Failures: ${status.failures.length}`,
    `Skipped items: ${status.skipped_items.length} (retry and owner review gaps; later changes continue)`,
    `Database recovery entries pending: ${status.recovery_pending}`,
    ...(status.error ? [`Last check error: ${display(status.error)}`] : []),
    ...status.failures.map((failure) => `  ${display(failure.name || failure.id)} [${display(failure.id)}]: ${display(failure.reason)} [${display(failure.code || 'file_failed')}; ${display(failure.retry_class || (failure.retryable === false ? 'owner_recovery' : 'retry'))}${failure.version ? `; version ${display(failure.version)}` : '; version unavailable'}]${failure.prior_skip ? `; prior skip: ${display(failure.prior_skip.reason)} [${display(failure.prior_skip.code)}]` : ''}`),
    "Existing indexed documents are retained. Historical backfill and semantic-index completion are not proven by this check.",
  ].join("\n");
}

export async function runDriveIncremental({
  drive, getToken, state, save, sourceName, policy, processFile,
  now = Date.now, limits = {}, retryFailures = false, display = String,
  validateProgress = async () => true,
}) {
  const budget = { ...DRIVE_CHANGE_LIMITS, ...limits };
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DRIVE_CHANGE_LIMITS[key]) {
      throw new TypeError(`Drive ${key} must be bounded by ${DRIVE_CHANGE_LIMITS[key]}`);
    }
  }
  const started = now();
  const timestamp = () => new Date(now()).toISOString();
  save = checkpointWriter(save);
  state.done ||= {};
  state.skipped ||= {};
  state.drive_failures ||= {};
  state.drive_pending_removals ||= {};
  state.drive_restore_pending ||= {};
  // Old mass-removal reviews are retained as decisions. They cannot hold the
  // new feed, authorize a forget, or erase an accepted source version.
  if (!state.drive_incremental_started_at) {
    const legacy = new Set([
      ...Object.keys(state.removed || {}),
      ...(state.ingest_removal_plan?.targets || []),
      ...(state.drive_removal_review?.uids || []),
    ]);
    for (const uid of legacy) if (typeof uid === "string" && uid.startsWith(`${sourceName}:`)) {
      state.drive_pending_removals[uid] ||= { id: uid.slice(sourceName.length + 1), reason: "legacy_owner_review", observed_at: timestamp() };
    }
    state.drive_incremental_started_at = timestamp();
    save();
  }
  const result = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0, scanned: 0, skipped: 0,
    complete: false, seeded: false, pages: 0 };
  const withinBudget = () => result.scanned < budget.maxFiles && now() - started < budget.timeBudgetMs;
  const failure = (file, reason, code = "file_failed", retryable = true, details = {}) => {
    const uid = `${sourceName}:${file.id}`;
    const previous = state.drive_failures[uid];
    const version = details.version || previous?.version || state.done[uid];
    // A transient retry must surface as retryable without destroying the
    // earlier unresolved version/reason. Keep one prior skip, never a chain.
    const priorSkip = retryable ? (previous?.retryable === false ? previous : previous?.prior_skip) : null;
    state.drive_failures[uid] = { id: file.id, name: display(file.name || file.id),
      reason: display(reason), code, retryable, retry_class:retryable ? 'retry' : 'owner_recovery',
      version:version || null, version_basis:details.version ? 'observed' : previous?.version ? 'previous_failure' : state.done[uid] ? 'accepted' : 'unavailable',
      ...(priorSkip ? { prior_skip: { reason:priorSkip.reason, code:priorSkip.code, version:priorSkip.version,
        retry_class:priorSkip.retry_class, observed_at:priorSkip.observed_at,
        ...(priorSkip.parts ? { parts:priorSkip.parts } : {}) } } : {}),
      ...(details.parts ? { parts:details.parts } : {}), observed_at: timestamp() };
    state.skipped[uid] = display(reason);
    if (code === "credential_refused") result.refused++; else result.failed++;
    save();
  };
  const pending = (id, reason, name = null) => {
    state.drive_pending_removals[`${sourceName}:${id}`] = { id, reason, ...(name ? { name: display(name) } : {}), observed_at: timestamp() };
  };
  const metadata = new Map();
  // This is the ONE entry boundary, shared by saved-page work and fair
  // retries. Every delegated step and synchronous decision lives inside it.
  // Feed settlement follows only a successful result or a durable visible gap.
  const process = async (change, { recovery = false } = {}) => {
    const id = change.fileId, uid = `${sourceName}:${id}`;
    let file = change.file, version, folder = '', metadataRead = false, written = false;
    result.scanned++;
    try {
      if (change.removed === true || file?.trashed === true) {
        pending(id, change.removed ? "removed_or_access_lost" : "trashed", file?.name);
        delete state.drive_failures[uid];
        return;
      }
      // A saved page may be old: scope and admission always use current metadata.
      file = await drive.getFileMetadata(getToken, id);
      metadataRead = true;
      if (file?.id !== id || (file.trashed !== true &&
          (!Array.isArray(file.parents) || file.parents.length > 1))) {
        throw new Error("Drive current file metadata is incomplete or mismatched");
      }
      if (file.trashed === true) { pending(id, "trashed", file.name); delete state.drive_failures[uid]; return; }
      const scope = await drive.changeScope(getToken, file, { ...policy, metadata });
      if (scope.unresolved) {
        failure(file, scope.unresolved.reason, scope.unresolved.code, false,
          { version: drive.driveVersion(file, '') });
        result.skipped++;
        return;
      }
      if (!scope.inScope) {
        pending(id, "left_configured_roots", file.name);
        delete state.drive_failures[uid];
        return;
      }
      const priorDecision = state.drive_pending_removals[uid];
      if (priorDecision?.reason !== "replacement_family_needs_review") delete state.drive_pending_removals[uid];
      if (file.mimeType === drive.FOLDER_MIME) {
        pending(id, "folder_change_needs_descendant_review", file.name);
        return;
      }
      folder = drive.folderPathFor(file, scope.folders);
      const excluded = drive.exclusionReason(file, folder, policy);
      if (excluded) { pending(id, "source_policy", file.name); delete state.drive_failures[uid]; result.skipped++; return; }
      const outcome = await processFile({ ...file, scope_root_ids: scope.rootIds }, folder, tally => {
        written = true;
        for (const key of ["created", "updated", "unchanged", "refused"]) result[key] += tally[key] || 0;
      });
      if (outcome.familyReview) pending(id, "replacement_family_needs_review", file.name);
      else if (outcome.familyVerified && state.drive_pending_removals[uid]?.reason === 'replacement_family_needs_review') {
        delete state.drive_pending_removals[uid];
      }
      if (outcome.skip) {
        failure(file, outcome.skip.reason, outcome.skip.code, outcome.skip.retryable === true,
          { version:outcome.version || drive.driveVersion(file, folder), parts:outcome.skip.parts });
        result.skipped++;
        if (outcome.skip.retryable === true) state.drive_retry_feed_pending = true;
        return;
      }
      if (!written) for (const key of ["created", "updated", "unchanged", "refused"]) result[key] += outcome[key] || 0;
      delete state.drive_failures[uid];
      delete state.skipped[uid];
      delete state.drive_restore_pending[uid];
    } catch (error) {
      if (error.checkpointFailure || error.code === 'source_ingest_lock_lost') throw error;
      const permanent = drive.isPermanentFileFailure(error);
      if (permanent) pending(id, "removed_or_access_lost", file?.name);
      // A failure in version calculation must not defeat the failure recorder.
      // Accepted-version fallback is marked when current metadata is unavailable.
      try { if (metadataRead) version = drive.driveVersion(file, folder); } catch { /* prior accepted version remains evidence */ }
      const held = error.driveFailure;
      failure({ ...(file || change.file), id }, held?.reason || error.message || "Drive file processing failed",
        permanent ? 'file_unavailable' : held?.code, permanent ? false : held?.retryable ?? true,
        { version, ...held });
      if (!permanent && runWideFailure(error, recovery)) throw error;
      result.skipped++;
      state.drive_retry_feed_pending = true;
    }
  };
  try {
    if (!state.sync_token) {
      // Deliberately seed only: no claim that the old corpus or missed history
      // has been rebuilt. Never replace a saved token with a newer one here.
      state.sync_token = await drive.startPageToken(getToken);
      state.drive_change_token_at = timestamp();
      result.seeded = true;
      save();
      return result;
    }
    const progressChecked = await validateProgress({deadlineAt:started + budget.timeBudgetMs / 3, maxEntries:100});
    {
      // Rotate over every held identity, retaining entries and checkpointing
      // admission BEFORE a request can interrupt. A failed prefix cannot own
      // every later run. Ordinary runs also resolve old false family holds.
      const candidates = [...new Set([
        ...Object.keys(state.drive_failures).filter(uid => retryFailures || state.drive_failures[uid].retryable === true),
        ...Object.keys(state.drive_pending_removals).filter(uid =>
          state.drive_pending_removals[uid].reason === 'replacement_family_needs_review'),
        ...Object.keys(state.drive_restore_pending),
      ])].filter(uid => !state.drive_change_page?.changes.slice(state.drive_change_page.offset)
        .some(change => `${sourceName}:${change.fileId}` === uid)).sort();
      const after = candidates.findIndex(uid => uid > (state.drive_retry_after || ''));
      const start = after < 0 ? 0 : after;
      // At the one-slot minimum, persist alternating turns so a genuine
      // family hold cannot monopolize ordinary runs and starve the feed.
      const feedTurn = state.drive_retry_feed_pending === true ||
        (budget.maxFiles === 1 && state.drive_retry_single_turn === 'feed');
      if (feedTurn) { state.drive_retry_single_turn = 'retry'; save(); }
      // Reserve an admission for the feed except at the one-item minimum.
      const retryLimit = feedTurn ? 0 : Math.min(10, budget.maxFiles > 1 ? budget.maxFiles - 1 : 1, candidates.length);
      for (let i = 0; i < retryLimit; i++) {
        if (!withinBudget()) break;
        const uid = candidates[(start + i) % candidates.length];
        const entry = state.drive_failures[uid] || state.drive_pending_removals[uid] || state.drive_restore_pending[uid];
        state.drive_retry_after = uid;
        // Save before any interruptible item step. Even a request that spends
        // the whole time budget cannot take the next run's feed opportunity.
        state.drive_retry_feed_pending = true;
        if (budget.maxFiles === 1) state.drive_retry_single_turn = 'feed';
        save();
        await process({ fileId: entry.id, file: { id: entry.id, name: entry.name } }, { recovery:true });
        save();
      }
    }
    const requested = new Set();
    while (withinBudget() && result.pages < budget.maxPages) {
      if (!state.drive_change_page) {
        if (requested.has(state.sync_token)) throw new Error("Drive repeated a change page token");
        requested.add(state.sync_token);
        const page = await drive.listChangePage(getToken, state.sync_token, { pageSize: budget.pageSize });
        // Persist the exact page before sending anything. An offset alone is
        // unsafe if the provider compacts or changes a repeated page response.
        state.drive_change_page = { token: state.sync_token, ...page, offset: 0 };
        save();
      }
      const page = state.drive_change_page;
      if (page.token !== state.sync_token || !Array.isArray(page.changes) ||
          !Number.isInteger(page.offset) || page.offset < 0 || page.offset > page.changes.length ||
          typeof page.nextToken !== "string" || !page.nextToken ||
          (page.nextToken === page.token && (!page.terminal || page.changes.length > 0))) {
        throw new Error("Drive saved page checkpoint is invalid; preserve it for review");
      }
      // Older checkpoints have no exact part proof. A bare page offset never
      // certifies an accepted version, even when the family still exists.
      for (let i = 0; i < page.offset; i++) {
        const change = page.changes[i], uid = `${sourceName}:${change.fileId}`;
        if (!change.removed && !state.skipped[uid] && !state.drive_pending_removals[uid] &&
            !state.drive_failures[uid] && !state.drive_accepted_parts?.[uid]) {
          page.offset = i; save(); break;
        }
      }
      while (page.offset < page.changes.length && withinBudget()) {
        state.drive_retry_feed_pending = false;
        save();
        await process(page.changes[page.offset]);
        page.offset++;
        try { save(); }
        catch (error) { page.offset--; throw error; }
      }
      if (page.offset !== page.changes.length) break;
      const previousCheckedAt = state.drive_change_token_at;
      const previousFeedTurn = state.drive_retry_feed_pending;
      state.drive_retry_feed_pending = false;
      state.sync_token = page.nextToken;
      delete state.drive_change_page;
      result.pages++;
      if (page.terminal) {
        state.drive_change_token_at = timestamp();
        result.feed_caught_up = true;
        result.complete = progressChecked && Object.keys(state.drive_restore_pending).length === 0 &&
          Object.keys(state.drive_failures).length === 0 && Object.keys(state.drive_pending_removals).length === 0;
      }
      try { save(); }
      catch (error) {
        // Later error/finally saves must never accidentally commit a token
        // whose own persistence failed. Replaying the full page is idempotent.
        state.sync_token = page.token;
        state.drive_change_page = page;
        if (previousCheckedAt === undefined) delete state.drive_change_token_at;
        else state.drive_change_token_at = previousCheckedAt;
        state.drive_retry_feed_pending = previousFeedTurn;
        result.pages--;
        result.feed_caught_up = false;
        result.complete = false;
        throw error;
      }
      if (page.terminal) break;
    }
    return result;
  } catch (error) {
    state.drive_incremental_error = display(error?.status === 410
      ? "Saved Drive change token expired; additions before a replacement token require owner-reviewed recovery. No full walk or reseed was attempted."
      : error.message || "Drive incremental sync failed");
    save();
    throw error;
  } finally {
    result.pending_removals = Object.keys(state.drive_pending_removals).length;
    result.failures = Object.keys(state.drive_failures).length;
    result.retryable_failures = Object.values(state.drive_failures).filter(failure => failure.retryable === true).length;
    result.recovery_pending = Object.keys(state.drive_restore_pending).length;
    state.drive_incremental_last_run = { ...result, completed_at: timestamp() };
    save();
  }
}

/** Adapter retains the existing envelope identity, scanner and batch writer. */
export async function driveIncrementalCommand({
  drive, getToken, state, save, sourceName, policy, policyFingerprint,
  scannerOn, scannerFingerprint, ocr, batchStream, splitOversized, sendBatches,
  sanitize, refusalOf, rememberAccepted, rememberFamily, acknowledgeOcr, display, receipt,
  base, adminKey, statePath, assertOwned, flags, now, limits, write, translateFailure = (error) => error,
  readDriveFamily = readDriveSingleFamily, readCurrentParts = readCurrentIngestParts, request = fetch,
}) {
  save = checkpointWriter(save);
  const startedAt = new Date(now()).toISOString();
  const checkSingleFamily = async (file, version, keep) => {
    const uid = `${sourceName}:${file.id}`;
    if (keep.length !== 1 || keep[0] !== uid) return false;
    const verified = await readDriveFamily({ base, adminKey, source: sourceName, id: file.id, request, assertOwned });
    if (!verified) return false;
    const plan = state.ingest_pending_families?.[uid];
    if (plan) {
      if (plan.stateKey !== uid || plan.hash !== version || plan.family?.base_doc_uid !== uid ||
          plan.family?.family_kind !== 'structural' || plan.family?.keep_doc_uids?.length !== 1 ||
          plan.family.keep_doc_uids[0] !== uid) return false;
      delete state.ingest_pending_families[uid];
    }
    return true;
  };
  const processFile = async (file, folder, recordWritten) => {
    const uid = `${sourceName}:${file.id}`, version = drive.driveVersion(file, folder);
    const scanned = state.drive_scanned_versions?.[uid];
    if ((state.credential_scanner_fingerprint === scannerFingerprint ||
        (scanned?.fingerprint === scannerFingerprint && scanned.version === version)) && state.done[uid] === version) {
      const saved = state.drive_accepted_parts?.[uid];
      const proof = saved?.revision === version && saved.policy_fingerprint === policyFingerprint
        ? await readCurrentParts({base,adminKey,source:sourceName,proof:saved,request,assertOwned}) : null;
      if (!proof || proof.parts.length !== saved.parts.length) {
        // A restored database can retain the family while losing one part.
        // Invalidate only this version and fall through to the normal writer.
        delete state.done[uid];
        if (state.drive_accepted_parts) delete state.drive_accepted_parts[uid];
        save();
      } else {
        state.drive_accepted_parts[uid] = {...saved,...proof};
        if (state.drive_pending_removals?.[uid]?.reason === 'replacement_family_needs_review' || state.ingest_pending_families?.[uid]) {
          const familyVerified = await checkSingleFamily(file, version, [uid]);
          return { unchanged: 1, familyVerified, familyReview: !familyVerified };
        }
        return { unchanged: 1 };
      }
    }
    let prepared;
    try { prepared = await drive.toEnvelope(getToken, file, { sourceName, pathOf: () => folder, ocr }); }
    catch (error) {
      // Unexpected extractor exceptions may contain source text or paths. Keep
      // typed provider/OCR/ownership failures intact for the shared boundary.
      if (error && !error.code && !error.reason && !error.status &&
          !error.providerStatus && !error.fatal && !error.driveFailure &&
          !error.needsReauth && !error.system_evidence &&
          !['AbortError','TimeoutError'].includes(error.name)) {
        error.driveFailure = { reason:'Drive item processing failed; its prior family was retained for retry',
          code:'file_failed', retryable:true };
      }
      throw error;
    }
    if (!prepared) throw new Error("Drive produced no document outcome");
    if (prepared.skip) return prepared;
    const envelope = sanitize(prepared.envelope);
    envelope.metadata = { ...envelope.metadata, brain_retained_ingest: 1 };
    const refusal = refusalOf(envelope, scannerOn);
    if (refusal) return { skip: { reason: refusal.reason, code: "credential_refused" } };
    const parts = splitOversized(envelope);
    const accepted = new Set();
    const failures = [];
    const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
    for await (const group of batchStream([file], async () => ({ envelopes: parts,
      hash: prepared.version, stateKey: uid, deferState: true }))) {
      const part = await sendBatches({ base, adminKey, groups: [group], state, statePath, skips: [], quiet: true,
        saveState: (_path, _state) => save(), assertOwned,
        onResult: (item, result) => {
          if (["created", "updated", "unchanged"].includes(result.status)) accepted.add(item.envelope.source_id);
          else failures.push(partFailure(item,result));
        } });
      for (const key of Object.keys(tally)) tally[key] += Number(part?.[key] || 0);
    }
    if (accepted.size !== parts.length || tally.failed || tally.refused) {
      const retry=failures.find(f=>f.retryable);
      const held={ ...(retry || failures[0] || partFailure({ envelope:{ source_id:file.id } },{})),
        version:prepared.version, parts:failures };
      if (failures.length > 0 && !retry) return { skip:held, version:prepared.version };
      throw Object.assign(new Error(held.reason),{ driveFailure:held });
    }
    // Successful retained writes remain measured even when later settlement
    // (OCR acknowledgement or family readback) leaves this identity retryable.
    const written = { created:tally.created > 0 ? 1 : 0, updated:tally.created === 0 && tally.updated > 0 ? 1 : 0,
      unchanged:tally.created === 0 && tally.updated === 0 ? 1 : 0 };
    recordWritten(written);
    const proof = await readCurrentParts({base,adminKey,source:sourceName,envelopes:parts,request,assertOwned});
    if (proof?.parts.length !== parts.length) throw new Error('Drive parts are not all readable in the current database; retry the file.');
    state.drive_accepted_parts ||= {};
    state.drive_accepted_parts[uid] = {...proof,revision:prepared.version,policy_fingerprint:policyFingerprint};
    await acknowledgeOcr(prepared.ocrPageRequestIds || []);
    const keep = parts.map((part) => `${part.source_type}:${part.source_id}`);
    rememberFamily([{ stateKey: uid, hash: prepared.version, base_doc_uid: uid,
      keep_doc_uids: keep, family_kind: "structural" }]);
    rememberAccepted(state, { stateKey: uid, hash: prepared.version, skipKeys: [file.id], legacyPartRoot: file.id });
    state.drive_scanned_versions ||= {};
    state.drive_scanned_versions[uid] = { fingerprint: scannerFingerprint, version: prepared.version };
    // Save a conservative hold with acceptance before readback can interrupt.
    state.drive_pending_removals[uid] = { id: file.id, reason: 'replacement_family_needs_review',
      name: display(file.name), observed_at: new Date(now()).toISOString() };
    save();
    const familyVerified = await checkSingleFamily(file, prepared.version, keep);
    return { ...written, familyVerified, familyReview: !familyVerified };
  };
  let result;
  try {
    await receipt({ source: sourceName, kind: "drive", status: "indexing", lane: "incremental", started_at: startedAt,
      detail: "Drive bounded add/update-only changes check started" });
    result = await runDriveIncremental({ drive, getToken, state, save, sourceName, policy, processFile, now,
      validateProgress:({deadlineAt,maxEntries}) => revalidateIngestProgress({
        state,source:sourceName,proofs:state.drive_accepted_parts,checkpointKey:'drive_progress_recheck',policyFingerprint,
        maxEntries,expired:() => now() >= deadlineAt,
        read:args => readCurrentParts({base,adminKey,source:sourceName,request,assertOwned,deadlineAt,now,...args}),
        invalidate:uid => {
          delete state.done[uid];
          state.drive_restore_pending[uid] = {id:uid.slice(sourceName.length+1),reason:'current_database_unconfirmed'};
        },save,
      }),
      display, limits: { ...limits, ...(flags.limit ? { maxFiles: Number(flags.limit) } : {}) }, retryFailures: !!flags.reset });
    state.drive_policy_fingerprint = policyFingerprint;
    // Incremental work does not prove every old document passed a new scanner.
    // Retain the old global fingerprint until a separately reviewed migration.
    delete state.drive_incremental_error;
    save();
    await receipt({ source: sourceName, kind: "drive", status: result.complete ? "ready" : "error", lane: "incremental",
      started_at: startedAt, completed_at: new Date(now()).toISOString(), walk_complete: result.complete, complete_sweep: false,
      files_seen: result.scanned, docs_added: result.created, docs_updated: result.updated,
      docs_unchanged: result.unchanged,
      docs_refused: Object.values(state.drive_failures || {}).filter(f => f.code === "credential_refused").length,
      docs_failed: Object.values(state.drive_failures || {}).filter(f => f.code !== "credential_refused").length,
      provider_check_complete: result.feed_caught_up === true,
      ...(result.complete ? { detail: `Drive changes caught up; pending_owner_decisions=${result.pending_removals}; historical_backfill_unproven=1` }
        : { issue_code: result.pending_removals ? "SAFETY_REVIEW_REQUIRED" : "INGEST_FAILED" }) });
    write(renderDriveIncrementalStatus(state, display));
    return result;
  } catch (error) {
    if (error?.code === "source_ingest_lock_lost") throw error;
    write(renderDriveIncrementalStatus(state, display));
    try {
      await receipt({ source: sourceName, kind: "drive", status: "error", lane: "incremental", started_at: startedAt,
        completed_at: new Date(now()).toISOString(), complete_sweep: false, walk_complete: false, provider_check_complete: false,
        docs_refused: Object.values(state.drive_failures || {}).filter(f => f.code === "credential_refused").length,
        docs_failed: Math.max(1, Object.values(state.drive_failures || {}).filter(f => f.code !== "credential_refused").length), issue_code: "INGEST_FAILED" });
    } catch (receiptError) {
      if (receiptError?.code === "source_ingest_lock_lost") throw receiptError;
      write("The failed check's source receipt could not be recorded. The local checkpoint remains authoritative.");
    }
    throw translateFailure(error, { settled: Boolean(result) });
  }
}

/** Exact bounded physical-family proof. Unknown replies cannot clear a hold. */
export async function readDriveSingleFamily({ base, adminKey, source, id, request = fetch, assertOwned }) {
  assertOwned?.();
  const response = await request(`${base}/api/admin/brain/drive-family`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify({ source, file_id: id }), signal: AbortSignal.timeout(30_000),
  });
  assertOwned?.();
  if (!response.ok) throw Object.assign(new Error('Drive family readback failed; the accepted family remains held.'), { ...(response.status >= 500 ? { driveItemFailure:true } : {}), status:response.status });
  const body = await response.json();
  return body?.source === source && body.file_id === id && body.base_doc_uid === `${source}:${id}` &&
    body.same_identity_single_part === true;
}

/** Reject mixed CLI/Worker generations before a single receipt or batch write. */
export async function verifyDriveIncrementalWorker(base, adminKey, { request = fetch, assertOwned = null } = {}) {
  assertOwned?.();
  const response = await request(`${base}/api/admin/brain/ingest-capabilities`, {
    method: 'GET', headers: { 'X-Admin-Key': adminKey }, signal: AbortSignal.timeout(30_000),
  });
  const body = response.ok ? await response.json() : null;
  if (body?.retained_revision_protocol !== 1 || body?.bounded_source_receipts !== true ||
      (!Number.isSafeInteger(body?.schema_version) || body.schema_version < 65) || body?.writes_paused !== false) {
    throw new Error('Drive retained revision protocol unavailable; complete the verified paired Worker update before retrying. No source write was started.');
  }
}
