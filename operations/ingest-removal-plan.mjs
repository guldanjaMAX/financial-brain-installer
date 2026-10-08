import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DriveRemovalReviewRequired, assertDriveRemovalPlanSafe } from "./drive-removal-plan.mjs";

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
export function ingestRemovalRuntime() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hash = createHash("sha256").update(`ingest-removal-runtime-v1:${process.version}`);
  const visit = (relative) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Removal runtime contains an unverified link.");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, stat.size]));
      hash.update(readFileSync(path));
    } else throw new Error("Removal runtime contains a non-file entry.");
  };
  for (const name of [...readdirSync(root).filter((name) => name.endsWith(".mjs")).sort(),
    "package.json", "operations", "connectors", "ingest", "worker/src"]) visit(name);
  // npm intentionally omits the project lockfile from a packed installation.
  // Installed dependency bytes still bind the runtime in that environment.
  if (existsSync(join(root, "package-lock.json"))) visit("package-lock.json");
  else hash.update("package-lock:absent");
  // npm's .bin entries are generated links, not executable module payloads.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {}).sort()) visit(`node_modules/${name}`);
  return hash.digest("hex");
}

export async function requestIngestRemovalPlan({ base, adminKey, body, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${base}/api/admin/brain/ingest-removal-plan`, {
      method: "POST", redirect: "error",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("removal request refused");
    return await response.json();
  } catch {
    fail("The authenticated removal plan is unavailable or changed. " +
      (body.action === "apply" ? "Some approved removals may have completed. " : "") +
      "The source cursor was not advanced. Run ingestion again after verifying the Brain's migration and runtime.");
  }
}

function checkedPreview(value) {
  if (!value?.marker || typeof value.marker.instance !== "string" || !value.marker.instance ||
      typeof value.marker.runtime !== "string" || !value.marker.runtime ||
      typeof value.marker.nonce !== "string" || !value.marker.nonce ||
      !Number.isSafeInteger(value.marker.generation) || value.marker.generation < 0 ||
      !Array.isArray(value.targets) || value.targets.some((uid) => typeof uid !== "string" || !uid) ||
      new Set(value.targets).size !== value.targets.length || value.documents !== value.targets.length) {
    fail("The Brain did not return an exact authenticated removal inventory.");
  }
  return value;
}

/** One boundary shared by folder, remote and provider ingestion. */
export function createIngestRemovalReview({
  state, saveState, source, manifest, manifestPath, base, adminKey, assertOwned,
  request = requestIngestRemovalPlan, runtime = ingestRemovalRuntime, kind = "upload", policy = () => null, now = () => Date.now(),
}) {
  const binding = () => removalDigest({ manifest, manifestPath, source, base, kind, policy: policy() });
  const send = (body) => { assertOwned?.(); return request({ base, adminKey, body }); };
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
    for (let index = 0; index < families.length || index === 0; index += 50) {
      const part = checkedPreview(await send({ action: "preview", families: families.slice(index, index + 50), marker }));
      if (marker && removalDigest(marker) !== removalDigest(part.marker)) fail("Stored inventory or runtime changed; run ingestion again.");
      marker = part.marker;
      for (const uid of part.targets) targets.add(uid);
    }
    return { marker, targets: [...targets].sort() };
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
    fail(
      (notice ? `${notice}\n` : "") +
      `Source ${source}: ${observed.targets.length} stored document(s) would be removed ` +
      `across ${sourceTargets.length} source removal(s) and ${families.length - sourceTargets.length} replacement family review(s).\n` +
      "Accepted additions and updates are saved. No removal was applied; the source cursor was kept.\n" +
      (extraApproval ? "The additional source removal safety review also requires approval.\n" : "") +
      `Review this plan, then run: brain ingest <manifest>${state.ingest_provider ? ` --from ${state.ingest_provider}` : ""} --source ${source} --apply-removals ${plan.fingerprint}` +
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
    if (plan.sourcePlan) assertDriveRemovalPlanSafe(plan.sourcePlan,
      plan.providerApproval && sourceApproval === plan.providerApproval ? plan.sourcePlan.fingerprint : sourceApproval,
      { sourceLabel: "Source" });
    if ((plan.requireSourceApproval && sourceApproval !== plan.sourcePlan?.fingerprint) ||
        (plan.providerApproval && sourceApproval !== plan.providerApproval)) {
      fail("The additional source removal approval is missing or changed. Review the saved plan's command.");
    }
    const observed = await preview(plan.families, plan.marker);
    if (removalDigest(observed.targets) !== removalDigest(plan.targets)) fail("Exact removal targets changed; run ingestion again.");
    let marker = observed.marker;
    let removed = 0;
    for (let index = 0; index < plan.targets.length; index += 50) {
      verifyLocal();
      const targets = plan.targets.slice(index, index + 50);
      const result = await send({ action: "apply", targets, marker });
      if (result?.documents !== targets.length || !result.marker ||
          result.marker.instance !== marker.instance || result.marker.runtime !== marker.runtime ||
          typeof result.marker.nonce !== "string" || !result.marker.nonce ||
          !Number.isSafeInteger(result.marker.generation) || result.marker.generation <= marker.generation) {
        fail("Exact removal receipt was not verified. Run ingestion again before retrying.");
      }
      marker = result.marker;
      removed += result.documents;
    }
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
