import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { DriveRemovalReviewRequired, assertDriveRemovalPlanSafe, formatDriveRemovalPlan } from "./drive-removal-plan.mjs";
import { renderCliCommands } from "./cli-guidance.mjs";
import { SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS } from "./source-family-inventory-retry.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const removalDigest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const snapshotState = (state) => {
  const { ingest_removal_plan: _plan, ...rest } = state;
  return removalDigest(rest);
};
const fail = (text) => { throw new DriveRemovalReviewRequired(text); };
const validFingerprint = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Bind code bytes, lockfile and installed dependencies, not a version label. */
export function ingestRemovalRuntime(root = fileURLToPath(new URL("../", import.meta.url))) {
  if (lstatSync(root).isSymbolicLink()) throw new Error("Removal runtime contains an unverified link.");
  const hash = createHash("sha256").update(`ingest-removal-runtime-v2:${process.version}`);
  const present = relative => {
    try { lstatSync(join(root, relative)); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const visited = new Set();
  const checkedPath = (relative) => {
    // package.files is a literal allowlist in this product. Never silently
    // interpret a future glob, parent traversal or absolute path as coverage.
    if (typeof relative !== "string" || !relative ||
        relative.split("/").some(part => !part || part === "." || part === "..") ||
        /[\\:*?\[\]{}!]/.test(relative)) throw new Error("Removal runtime manifest has an unsupported path.");
    const parts = relative.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(join(root, ...parts.slice(0, i)));
      if (stat.isSymbolicLink()) throw new Error("Removal runtime contains an unverified link.");
      if (i < parts.length && !stat.isDirectory()) throw new Error("Removal runtime contains a non-directory parent.");
    }
    return join(root, relative);
  };
  const visit = (relative) => {
    if (visited.has(relative)) return;
    const path = checkedPath(relative);
    const stat = lstatSync(path);
    visited.add(relative);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, stat.size]));
      hash.update(readFileSync(path));
    } else throw new Error("Removal runtime contains a non-file entry.");
  };
  const pkg = JSON.parse(readFileSync(checkedPath("package.json"), "utf8"));
  if (!Array.isArray(pkg.files) || !pkg.files.length) throw new Error("Removal runtime needs the complete package file manifest.");
  const exportedFiles = value => typeof value === "string" ? [value]
    : value && typeof value === "object" ? Object.values(value).flatMap(exportedFiles) : [];
  const entries = ["package.json", ...pkg.files,
    ...exportedFiles(pkg.exports),
    ...readdirSync(root).filter(name => /^(?:readme|licen[cs]e|copying|notice)(?:\.|$)/i.test(name)),
    ...(pkg.main ? [pkg.main] : []),
    ...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin || {}))];
  for (const name of [...new Set(entries.map(entry => {
    if (typeof entry !== "string") throw new Error("Removal runtime manifest has an unsupported path.");
    return entry.replace(/^\.\//, "").replace(/\/$/, "");
  }))].sort()) visit(name);
  // npm intentionally omits the project lockfile from a packed installation.
  // Installed dependency bytes still bind the runtime in that environment.
  if (present("package-lock.json")) visit("package-lock.json");
  else hash.update("package-lock:absent");
  // Bind the installed production dependency closure, including hoisted and
  // optional peers. The root .bin wrappers are not imported module payloads.
  // Dependencies outside this installation are unverifiable and fail closed.
  const packages = new Set();
  const dependencies = (manifest, parent = "") => {
    const names = new Set([...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}), ...Object.keys(manifest.peerDependencies || {})]);
    for (const name of [...names].sort()) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") {
        throw new Error("Removal runtime has an invalid dependency name.");
      }
      let directory = parent;
      let found;
      for (;;) {
        const candidate = [directory, "node_modules", name].filter(Boolean).join("/");
        if (present(candidate)) { found = candidate; break; }
        if (!directory) break;
        directory = posix.dirname(directory);
        if (directory === ".") directory = "";
      }
      if (!found) {
        if (Object.hasOwn(manifest.optionalDependencies || {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true) {
          hash.update(JSON.stringify([parent, name, "optional:absent"]));
          continue;
        }
        throw new Error("Removal runtime is missing an installed dependency.");
      }
      if (packages.has(found)) continue;
      packages.add(found);
      visit(found);
      dependencies(JSON.parse(readFileSync(checkedPath(`${found}/package.json`), "utf8")), found);
    }
  };
  dependencies(pkg);
  return hash.digest("hex");
}

const REMOVAL_RESPONSE_CODES = new Set([
  "INGEST_REMOVAL_CHANGED", "INGEST_REMOVAL_INVALID", "INGEST_REMOVAL_UNAVAILABLE",
  "INGEST_REMOVAL_UNVERIFIED", "INGEST_REMOVAL_CAPACITY",
]);
const reportRemovalProgress = line => console.warn(line);

/** Retry one immutable request, with a shared deadline including apply readback.
 * A failed apply is NOT idempotent. Only an unchanged authenticated marker proves
 * it untouched; the D1 transaction fence still closes the race after that proof.
 */
export async function requestIngestRemovalPlan({
  base, adminKey, body, fetchImpl = fetch, beforeAttempt = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now(), random = Math.random, onProgress = reportRemovalProgress,
}) {
  const deadline = now() + 240_000;
  const original = JSON.parse(JSON.stringify(body));
  const isApply = original.action === "apply";
  let applySent = false;
  const once = async payload => {
    try { beforeAttempt(); }
    catch (cause) {
      if (!applySent) throw cause;
      // A local refusal cannot establish whether the earlier write committed.
      // Keep the refusal terminal, including during marker readback or backoff.
      const error = new DriveRemovalReviewRequired(
        (cause instanceof Error ? cause.message : "Local removal validation failed.") +
        " Some approved removals may have completed. The source cursor was not advanced. " +
        "Run ingestion again and review a fresh removal plan before applying it.",
      );
      error.cause = cause;
      error.removalBatchMayShrink = false;
      throw error;
    }
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) return { failure: { label: "TIMEOUT", retryable: true, capacity: true } };
    try {
      if (payload.action === "apply") applySent = true;
      const response = await fetchImpl(`${base}/api/admin/brain/ingest-removal-plan`, {
        method: "POST", redirect: "error",
        headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.min(60_000, remaining)),
      });
      if (response.ok) return { value: await response.json() };
      // Never surface response text, arbitrary codes, URLs, or transport errors.
      let code;
      try { const value = await response.json(); if (REMOVAL_RESPONSE_CODES.has(value?.code)) code = value.code; }
      catch { /* HTTP status remains useful even for an empty or interrupted body. */ }
      return { failure: {
        label: `HTTP ${response.status}${code ? ` (${code})` : ""}`, code,
        retryable: response.status === 429 || (response.status >= 500 && response.status <= 599),
        capacity: code === "INGEST_REMOVAL_CAPACITY" || [413, 504].includes(response.status),
      } };
    } catch (error) {
      const timeout = ["TimeoutError", "AbortError"].includes(error?.name);
      return { failure: {
        label: timeout ? "TIMEOUT" : error instanceof SyntaxError ? "INVALID_RESPONSE" : "NETWORK_ERROR",
        retryable: !(error instanceof SyntaxError), capacity: timeout,
      } };
    }
  };
  const pause = async (failure, retry) => {
    const delay = Math.round(SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS[retry] * (0.75 + random() * 0.5));
    if (now() + delay >= deadline) return false;
    onProgress(`Removal review: temporary ${failure.label}; retrying in ${delay / 1000} second(s) ` +
      `(retry ${retry + 1} of ${SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS.length}).`);
    await sleep(delay);
    return now() < deadline;
  };
  let proofChanged = false;
  const unchanged = async () => {
    if (!original.marker) return false;
    for (let retry = 0; ; retry++) {
      const result = await once({ action: "preview", families: [], marker: original.marker });
      if (!result.failure) {
        try {
          const proof = checkedPreview(result.value);
          proofChanged = removalDigest(proof.marker) !== removalDigest(original.marker);
          return proof.documents === 0 && !proofChanged;
        } catch { return false; }
      }
      proofChanged = result.failure.code === "INGEST_REMOVAL_CHANGED";
      if (!result.failure.retryable || retry >= SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS.length ||
          !await pause(result.failure, retry)) return false;
    }
  };
  for (let retry = 0; ; retry++) {
    const result = await once(original);
    if (!result.failure) return result.value;
    const failure = result.failure;
    // Even a 5xx can follow a committed delete. Check again after every failure,
    // including the final one before permitting a smaller apply batch.
    const untouched = isApply && (failure.retryable || failure.capacity) && await unchanged();
    if ((!isApply || untouched) && failure.retryable &&
        retry < SOURCE_FAMILY_INVENTORY_RETRY_DELAYS_MS.length && await pause(failure, retry)) continue;
    const changed = failure.code === "INGEST_REMOVAL_CHANGED" || proofChanged;
    const error = new DriveRemovalReviewRequired(
      (changed ? "Stored inventory or runtime changed; run ingestion again. " : "Authenticated removal request failed. ") +
      `${failure.label}. ` + (isApply ? "Some approved removals may have completed. " : "") +
      "The source cursor was not advanced. " +
      (changed ? "Review a fresh removal plan before applying it." :
        "Rerun the same approved command if the stored inventory is unchanged. " +
        "If it changed, run ingestion again and review the new removal plan; an old approval cannot resume a completed batch."),
    );
    error.removalBatchMayShrink = failure.capacity && (!isApply || untouched);
    throw error;
  }
}

function checkedPreview(value) {
  if (!value?.marker || typeof value.marker.instance !== "string" || !value.marker.instance ||
      typeof value.marker.runtime !== "string" || !value.marker.runtime ||
      typeof value.marker.nonce !== "string" || !value.marker.nonce ||
      !Number.isSafeInteger(value.marker.generation) || value.marker.generation < 0 ||
      !Array.isArray(value.targets) || value.targets.some((uid) => typeof uid !== "string" || !uid) ||
      new Set(value.targets).size !== value.targets.length || value.documents !== value.targets.length ||
      (value.excluded_documents !== undefined &&
        (!Number.isSafeInteger(value.excluded_documents) || value.excluded_documents < 0))) {
    fail("The Brain did not return an exact authenticated removal inventory.");
  }
  return value;
}

function checkedApply(result, targets, marker) {
  if (result?.documents !== targets.length || !result.marker ||
      result.marker.instance !== marker.instance || result.marker.runtime !== marker.runtime ||
      typeof result.marker.nonce !== "string" || !result.marker.nonce ||
      !Number.isSafeInteger(result.marker.generation) || result.marker.generation <= marker.generation) {
    fail("Exact removal receipt was not verified. Some approved removals may have completed. Run ingestion again before retrying.");
  }
  return result.marker;
}

// Every exact writer uses this ordering. An exact-target approval does not
// replace the independent aggregate source review, even for structural repair.
async function applyGuardedTargets({ plan, sourceApproval, send, verifyLocal = () => {}, onProgress = reportRemovalProgress }) {
  verifyLocal();
  if (plan.sourcePlan) assertDriveRemovalPlanSafe(plan.sourcePlan,
    plan.providerApproval && sourceApproval === plan.providerApproval ? plan.sourcePlan.fingerprint : sourceApproval,
    { sourceLabel: "Source" });
  if ((plan.requireSourceApproval && sourceApproval !== plan.sourcePlan?.fingerprint) ||
      (plan.providerApproval && sourceApproval !== plan.providerApproval)) {
    fail("The additional source removal approval is missing or changed. Review the saved plan's command.");
  }
  let marker = plan.marker;
  let removed = 0;
  let batchSize = 50;
  for (let index = 0; index < plan.targets.length;) {
    verifyLocal();
    const targets = plan.targets.slice(index, index + batchSize);
    let result;
    try { result = await send({ action: "apply", targets, marker }, verifyLocal); }
    catch (error) {
      if (!error.removalBatchMayShrink || targets.length <= 1) throw error;
      batchSize = Math.ceil(targets.length / 2);
      onProgress(`Removal review: retrying the unchanged batch with at most ${batchSize} targets.`);
      continue;
    }
    marker = checkedApply(result, targets, marker);
    removed += result.documents;
    index += targets.length;
    if (plan.targets.length > 50) onProgress(`Removal review: removed ${removed.toLocaleString("en-US")} of ${plan.targets.length.toLocaleString("en-US")} approved targets.`);
  }
  return { marker, removed };
}

/** Called only after the exact-target repair executor verifies its independent
 * owner approval. Ordinary ingest must use the persisted review below instead.
 * The approval permits one structural replacement family, never source removal.
 * Worker mutations use exact identities and the same inventory transaction fence.
 */
export async function applyApprovedProvenanceFamily({
  families, approvalId, base, adminKey, assertOwned,
  sourcePlan = null, sourceApproval, onExcluded = () => {},
  fetchImpl = fetch, request = requestIngestRemovalPlan,
}) {
  if (!validFingerprint(approvalId) || !Array.isArray(families) || families.length !== 1 ||
      typeof families[0]?.base_doc_uid !== "string" || !families[0].base_doc_uid ||
      !Array.isArray(families[0].keep_doc_uids) || !families[0].keep_doc_uids.length ||
      (families[0].family_kind !== undefined && families[0].family_kind !== "structural")) {
    fail("Exact family cleanup needs a separately approved provenance repair.");
  }
  const selectors = [{ ...families[0], family_kind: "structural" }];
  const send = (body, beforeAttempt = () => assertOwned?.()) => {
    beforeAttempt();
    return request({ base, adminKey, body, fetchImpl, beforeAttempt });
  };
  const observed = checkedPreview(await send({ action: "preview", families: selectors }));
  onExcluded(observed.excluded_documents ?? 0);
  // The current provenance executor only repairs local uploads. A caller
  // extending it to Drive must also supply the reviewed aggregate inventory
  // covering this family; absent or unrelated context cannot waive that gate.
  const baseUid = selectors[0].base_doc_uid;
  if (observed.targets.length && baseUid.startsWith("drive:") &&
      !Object.values(sourcePlan?.targets || {}).flat().includes(baseUid)) {
    fail("Drive family cleanup needs an aggregate source removal plan covering this family.");
  }
  const { marker } = await applyGuardedTargets({
    plan: { ...observed, sourcePlan }, sourceApproval, send, verifyLocal: () => assertOwned?.(),
  });
  const after = checkedPreview(await send({ action: "preview", families: selectors, marker }));
  if (after.targets.length || removalDigest(after.marker) !== removalDigest(marker)) {
    fail("Exact family cleanup readback changed. Review a fresh provenance repair.");
  }
  return observed.targets.length;
}

/** One boundary shared by folder, remote and provider ingestion. */
export function createIngestRemovalReview({
  state, saveState, source, manifest, manifestPath, base, adminKey, assertOwned,
  request = requestIngestRemovalPlan, runtime = ingestRemovalRuntime, kind = "upload", policy = () => null, now = () => Date.now(),
  onProgress = reportRemovalProgress,
}) {
  const binding = () => removalDigest({ manifest, manifestPath, source, base, kind, policy: policy() });
  const send = (body, beforeAttempt = () => assertOwned?.()) => {
    beforeAttempt();
    return request({ base, adminKey, body, beforeAttempt, onProgress });
  };
  const pending = () => Object.values(state.ingest_pending_families || {}).filter(
    (entry) => state.done?.[entry.stateKey] === entry.hash && !state.skipped?.[entry.stateKey],
  ).map((entry) => entry.family);

  const remember = (plans) => {
    state.ingest_pending_families ||= {};
    for (const plan of plans) {
      state.ingest_pending_families[plan.base_doc_uid] = {
        stateKey: plan.stateKey, hash: plan.hash,
        family: { base_doc_uid: plan.base_doc_uid, keep_doc_uids: plan.keep_doc_uids,
          ...(plan.family_kind ? { family_kind: plan.family_kind } : {}) },
      };
    }
  };

  const preview = async (families, expectedMarker = null) => {
    let marker = expectedMarker;
    const targets = new Set();
    let excluded = 0;
    let batchSize = 50;
    for (let index = 0; index < families.length || index === 0;) {
      const group = families.slice(index, index + batchSize);
      let response;
      try { response = await send({ action: "preview", families: group, marker }); }
      catch (error) {
        if (!error.removalBatchMayShrink || group.length <= 1) throw error;
        batchSize = Math.ceil(group.length / 2);
        onProgress(`Removal review: retrying the preview with at most ${batchSize} families.`);
        continue;
      }
      const part = checkedPreview(response);
      if (marker && removalDigest(marker) !== removalDigest(part.marker)) fail("Stored inventory or runtime changed; run ingestion again.");
      marker = part.marker;
      excluded += part.excluded_documents ?? 0;
      for (const uid of part.targets) targets.add(uid);
      index += group.length;
      if (families.length > 50) onProgress(`Removal review: checked ${index.toLocaleString("en-US")} of ${families.length.toLocaleString("en-US")} families.`);
      if (!families.length) break;
    }
    return { marker, targets: [...targets].sort(), excluded_documents: excluded };
  };

  const finish = async ({ sourcePlan = null, requireSourceApproval = false, familyKind = "structural", providerApproval = null, expiresAt = null, notice = "" } = {}) => {
    const sourceTargets = sourcePlan ? [...new Set(Object.values(sourcePlan.targets).flat())].sort() : [];
    const sourceSet = new Set(sourceTargets);
    const families = [
      ...pending().filter((family) => !sourceSet.has(family.base_doc_uid)),
      ...sourceTargets.map((uid) => ({ base_doc_uid: uid, keep_doc_uids: [], family_kind: familyKind })),
    ];
    if (!families.length) {
      delete state.ingest_removal_plan;
      delete state.ingest_pending_families;
      saveState();
      return;
    }
    const observed = await preview(families);
    // An excluded source target is still stored. Recheck only source removals
    // so unrelated replacement-family exclusions cannot block cursor progress.
    if (observed.excluded_documents && sourceTargets.length) {
      const sourceObserved = await preview(sourceTargets.map((uid) => ({ base_doc_uid: uid, keep_doc_uids: [], family_kind: familyKind })));
      if (sourceObserved.excluded_documents) fail(
        `Source ${source}: ${sourceObserved.excluded_documents} stored document(s) planned for removal could not be verified, so they were kept.\n` +
        "Nothing was removed. Accepted additions and updates are saved; the source cursor and scanner progress were kept.\n" +
        "For help, run: brain support --explain SAFETY_REVIEW_REQUIRED");
    }
    if (observed.excluded_documents) {
      console.warn(renderCliCommands(`Source ${source}: preserved ${observed.excluded_documents} stored document(s) whose names overlap a family but whose membership was not verified.\n` +
        "Nothing was lost. Review the preserved documents with support before retrying.\n" +
        "For help, run: brain support --explain SAFETY_REVIEW_REQUIRED"));
    }
    if (!observed.targets.length) {
      delete state.ingest_removal_plan;
      delete state.ingest_pending_families;
      saveState();
      return;
    }
    const plan = {
      version: 1, source, kind, families, sourceTargets, ...observed,
      state: snapshotState(state), policy: binding(), runtime: runtime(),
      sourcePlan, requireSourceApproval, providerApproval, expiresAt,
    };
    plan.fingerprint = removalDigest(plan);
    state.ingest_removal_plan = plan;
    saveState();
    const extraApproval = providerApproval || (sourcePlan?.tooLarge || requireSourceApproval
      ? sourcePlan.fingerprint : null);
    const from = state.ingest_provider || (kind !== "upload" ? kind : null);
    fail(
      (notice ? `${notice}\n` : "") +
      `Source ${source}: ${observed.targets.length} stored document(s) would be removed ` +
      `across ${sourceTargets.length} source removal(s) and ${families.length - sourceTargets.length} replacement family review(s).\n` +
      (sourcePlan ? `Source cleanup would remove ${formatDriveRemovalPlan(sourcePlan)}\n` : "") +
      "Accepted additions and updates are saved. No removal was applied; the source cursor was kept.\n" +
      (extraApproval ? "The additional source removal safety review also requires approval.\n" : "") +
      `Review this plan, then run: brain ingest <manifest>${from ? ` --from ${from}` : ""} --source ${source} --apply-removals ${plan.fingerprint}` +
      (extraApproval ? ` --approve-removals ${extraApproval}` : ""),
    );
  };

  const apply = async (fingerprint, sourceApproval) => {
    const plan = state.ingest_removal_plan;
    if (!validFingerprint(fingerprint) || !plan || plan.fingerprint !== fingerprint) {
      fail("No matching saved removal plan. Run ingestion again and review its exact fingerprint.");
    }
    const { fingerprint: _fingerprint, ...payload } = plan;
    const verifyLocal = () => {
      assertOwned?.();
      if (plan.expiresAt !== null && (!Number.isFinite(Date.parse(plan.expiresAt)) || now() >= Date.parse(plan.expiresAt))) {
        fail("The source removal observation expired. Run ingestion again and review a fresh plan.");
      }
      if (removalDigest(payload) !== fingerprint || plan.state !== snapshotState(state) ||
          plan.policy !== binding() || plan.runtime !== runtime()) {
        fail("Removal plan changed: state, policy or runtime no longer matches. Run ingestion again; no further removal was applied.");
      }
    };
    verifyLocal();
    const observed = await preview(plan.families, plan.marker);
    if (removalDigest(observed.targets) !== removalDigest(plan.targets)) fail("Exact removal targets changed; run ingestion again.");
    const { marker, removed } = await applyGuardedTargets({ plan, sourceApproval, send, verifyLocal, onProgress });
    const after = await preview(plan.families, marker);
    if (after.targets.length) fail("Removal readback found remaining targets. Run ingestion again.");
    verifyLocal();
    for (const uid of plan.sourceTargets) {
      delete state.done?.[uid];
      delete state.done?.[uid.slice(source.length + 1)];
      delete state.removed?.[uid];
    }
    delete state.ingest_pending_families;
    delete state.ingest_removal_plan;
    saveState();
    return { removed, cursor_advanced: false };
  };
  return { remember, finish, apply };
}
