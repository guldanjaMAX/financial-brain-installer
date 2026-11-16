// Private source state, never a receipt: retain identities only, not mail bodies.
// The mailbox marker covers the whole window. Pending removals are owner
// decisions; only a durable decision queue lets daily advance past them.
export const GMAIL_BATCH_WINDOW_MAX_IDS = 2_000;

const identity = value => typeof value === "string" && value.length > 0 &&
  value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
const ids = value => Array.isArray(value) && value.length <= GMAIL_BATCH_WINDOW_MAX_IDS &&
  value.every(identity) && new Set(value).size === value.length;
const invalid = () => { throw new Error("saved Gmail batch window is invalid; the history cursor was kept"); };

export function readGmailBatchWindow(state, policyFingerprint) {
  const window = state.gmail_batch_window;
  if (window === undefined) return null;
  if (!window || window.version !== 1 || (window.from_history_id !== null && !identity(window.from_history_id)) ||
      !identity(window.to_history_id) || !/^[a-f0-9]{64}$/.test(window.policy_fingerprint) ||
      !ids(window.ids) || !ids(window.deleted_ids) || !ids(window.remaining_ids) ||
      window.ids.length + window.deleted_ids.length > GMAIL_BATCH_WINDOW_MAX_IDS ||
      typeof window.has_more !== "boolean" ||
      !Number.isSafeInteger(window.completed_batches) || window.completed_batches < 0 ||
      (window.last_processed_at !== null &&
        (typeof window.last_processed_at !== "string" || !Number.isFinite(Date.parse(window.last_processed_at)))) ||
      !window.removal_causes || typeof window.removal_causes !== "object" || Array.isArray(window.removal_causes)) invalid();
  if (window.mode !== undefined && !["history", "bootstrap"].includes(window.mode)) invalid();
  if (window.continuation != null) {
    const c = window.continuation;
    if (c.version !== 1 || c.start_history_id !== window.to_history_id ||
        !Number.isSafeInteger(c.offset) || c.offset < 0 ||
        (c.page_token !== null && (typeof c.page_token !== "string" || !c.page_token || c.page_token.length > 8192)) ||
        (c.digest !== null && !/^[a-f0-9]{64}$/.test(c.digest))) invalid();
  }
  if (window.mode === "bootstrap") {
    const r = window.recovery;
    if (!r || r.version !== 1 || r.policy_fingerprint !== window.policy_fingerprint ||
        r.anchor_history_id !== window.to_history_id || typeof r.complete !== "boolean" ||
        !Number.isSafeInteger(r.pages_completed) || r.pages_completed < 1 ||
        (r.page_token !== null && (typeof r.page_token !== "string" || !r.page_token || r.page_token.length > 8192)) ||
        (r.stage !== undefined && r.stage !== "stored")) invalid();
  }
  const all = new Set(window.ids);
  if (window.inventory !== undefined) {
    const inventory = window.inventory;
    if (!inventory || !Array.isArray(inventory.ids) || inventory.ids.length > 3_000 ||
        !inventory.ids.every(identity) || new Set(inventory.ids).size !== inventory.ids.length ||
        ![...window.ids, ...window.deleted_ids].every(id => inventory.ids.includes(id)) ||
        !Number.isSafeInteger(inventory.next) || inventory.next < 0 ||
        inventory.next >= Math.max(1, inventory.ids.length)) invalid();
  }
  if (window.skip_outcomes !== undefined &&
      (!window.skip_outcomes || typeof window.skip_outcomes !== "object" || Array.isArray(window.skip_outcomes) ||
        Object.entries(window.skip_outcomes).some(([id, kind]) => !all.has(id) ||
          !["credential", "policy", "deleted", "quality", "retained"].includes(kind)))) invalid();
  if (window.refusal_counts !== undefined &&
      (!window.refusal_counts || typeof window.refusal_counts !== "object" || Array.isArray(window.refusal_counts) ||
        Object.entries(window.refusal_counts).some(([id, count]) => !all.has(id) ||
          window.skip_outcomes?.[id] !== "credential" || !Number.isSafeInteger(count) || count < 1))) invalid();
  if (window.policy_results !== undefined) {
    const results = window.policy_results;
    if (!results || typeof results !== "object" || Array.isArray(results) ||
        Object.keys(results).length > window.ids.length || Object.entries(results).some(([id, result]) =>
          !all.has(id) || !result || typeof result.allowed !== "boolean" ||
          (!result.allowed && (typeof result.skip?.reason !== "string" || result.skip.reason.length > 2048)))) invalid();
  }
  if (window.remaining_ids.some(id => !all.has(id)) || window.deleted_ids.some(id => all.has(id)) ||
      Object.entries(window.removal_causes).some(([id, cause]) =>
        !window.deleted_ids.includes(id) || cause !== "explicit_deletion")) invalid();
  // A policy change requires a fresh authoritative sweep. A stale window can
  // never override the saved cursor or reinstate a prior corpus policy.
  if (window.policy_fingerprint !== policyFingerprint || window.from_history_id !== (state.history_id ?? null)) return null;
  return window;
}

// Operation annotations identify the read, not the blast radius. An item parse
// or a known item permission error must not acquire account-wide stop semantics
// merely because the connector attached its operation class.
export function isGmailItemFailure(error) {
  if (!error || typeof error !== "object" || error.fatal || error.needsReauth || error.ingestStateWriteFailed ||
      ["Fatal", "SourceIngestLockError", "GoogleAuthError"].includes(error.name) ||
      String(error.code || "").startsWith("source_ingest_lock_")) return false;
  if (error.name === "DriveError") {
    const status = error.providerStatus ?? error.status;
    return status === 200 || status === 404 ||
      (status === 403 && ["insufficientFilePermissions", "appNotAuthorizedToFile"].includes(error.providerReason));
  }
  if (error.transport || error.retryable || Number.isInteger(error.providerStatus) ||
      ["AbortError", "TimeoutError", "HttpError"].includes(error.name) ||
      /^(?:EACCES|EPERM|EIO|ENOSPC|EROFS|ECONN.*|ENET.*|ENOTFOUND|EPIPE|ETIMEDOUT)$/.test(String(error.code || ""))) return false;
  return !error.cause || error.cause === error || isGmailItemFailure(error.cause);
}

export function openGmailBatchWindow(state, history, policyFingerprint, retryIds = []) {
  const window = {
    version: 1, from_history_id: state.history_id ?? null, to_history_id: history.historyId,
    policy_fingerprint: policyFingerprint,
    mode: history.mode || "history", policy_all: history.policy_all === true, continuation: history.continuation || null,
    recovery: history.recovery || null,
    ids: [...new Set([...retryIds, ...history.ids])], deleted_ids: [...history.deletedIds],
    removal_causes: { ...(history.removal_causes || {}) }, has_more: history.hasMore === true,
    remaining_ids: [], completed_batches: 0, last_processed_at: null,
  };
  window.remaining_ids = [...window.ids];
  // Validate before mutating durable state, including injected provider seams.
  readGmailBatchWindow({ ...state, gmail_batch_window: window }, policyFingerprint);
  state.gmail_batch_window = window;
  return window;
}

export function checkpointGmailBatch(state, stateKeys, source, now = () => new Date().toISOString()) {
  if (!stateKeys.length) return;
  const timestamp = now();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) invalid();
  state.gmail_last_batch_at = timestamp;
  const window = state.gmail_batch_window;
  if (!window) return;
  const accepted = new Set(stateKeys.map(key => key.slice(source.length + 1)));
  for (const key of stateKeys) if (!Object.hasOwn(state.skipped || {}, key) && window.skip_outcomes) {
    delete window.skip_outcomes[key.slice(source.length + 1)];
    if (window.refusal_counts) delete window.refusal_counts[key.slice(source.length + 1)];
  }
  window.remaining_ids = window.remaining_ids.filter(id => !accepted.has(id));
  window.completed_batches++;
  window.last_processed_at = timestamp;
}

export function gmailNeedsFamilyReconciliation(plan) {
  return !(plan.family_kind === "structural" && plan.keep_doc_uids?.length === 1 &&
    plan.keep_doc_uids[0] === plan.base_doc_uid);
}

export function pruneGmailSinglePartPlans(state, source) {
  for (const [base, entry] of Object.entries(state.ingest_pending_families || {})) {
    if (base.startsWith(`${source}:`) && entry.family?.base_doc_uid === base &&
        state.done?.[entry.stateKey] === entry.hash && !state.skipped?.[entry.stateKey] &&
        !gmailNeedsFamilyReconciliation(entry.family)) delete state.ingest_pending_families[base];
  }
}
