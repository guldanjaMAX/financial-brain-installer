/**
 * Simple Drive sync helpers (packet 10).
 *
 * The daily Drive refresh reads Google's changes feed and acts on each change
 * directly: a changed file under a configured root is loaded, a trashed,
 * deleted or moved-out file has its stored document removed at once. There is
 * no removal plan to approve. The Worker still requires its two-step
 * preview/apply removal route, so each removal batch is previewed and then
 * applied with the exact marker the preview returned.
 */
import { requestIngestRemovalPlan } from "./ingest-removal-plan.mjs";

/** The base Drive file id of a stored family uid such as `drive:abc#part1of2`. */
export function driveFileIdOf(uid, sourceName = "drive") {
  const prefix = `${sourceName}:`;
  if (typeof uid !== "string" || !uid.startsWith(prefix)) return null;
  const id = uid.slice(prefix.length).replace(/#part\d+of\d+$/, "");
  return id || null;
}

/**
 * Is this file under a configured root, using the saved folder index?
 *
 * `myDriveRootId` admits only DIRECT children of My Drive, matching the
 * rooted walk's include_my_drive_root_files contract.
 */
export function driveFileInRoots(file, { rootFolderIds = [], folders = {}, myDriveRootId = null } = {}) {
  const roots = new Set(rootFolderIds);
  const parents = Array.isArray(file?.parents) ? file.parents.map(String) : [];
  if (myDriveRootId && parents.includes(myDriveRootId)) return true;
  const queue = [...parents];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (roots.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(folders?.[id]?.parents || []));
  }
  return false;
}

/** A short, content-free reason for one failed Drive load. */
export function driveFailureText(error) {
  const parts = [String(error?.name || "Error")];
  if (Number.isInteger(error?.status) && error.status > 0) parts.push(`HTTP ${error.status}`);
  if (typeof error?.reason === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.reason)) parts.push(error.reason);
  if (typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)) parts.push(error.code);
  // Google's own API messages describe the request, not the document. Other
  // errors can quote parsed bytes, so only their class and code are printed.
  if (error?.name === "DriveError" && error?.message) parts.push(String(error.message).replace(/\s+/g, " ").slice(0, 160));
  return parts.join(": ");
}

/**
 * Remove stored families now, in batches of 50, and return the counts.
 *
 * Each batch is previewed (which resolves split parts and drops anything not
 * stored), applied with the preview's marker, then previewed again to prove
 * nothing is left. `dryRun` previews only. Gmail and Calendar use this same
 * path for a trashed, spam, deleted or cancelled item.
 */
export async function removeDriveFamilies({
  families,
  base,
  adminKey,
  dryRun = false,
  assertOwned = null,
  request = requestIngestRemovalPlan,
  onProgress = (line) => console.log(line),
}) {
  let matched = 0;
  let removed = 0;
  let preserved = 0;
  const send = (body) => {
    assertOwned?.();
    return request({ base, adminKey, body, beforeAttempt: () => assertOwned?.() });
  };
  for (let index = 0; index < families.length; index += 50) {
    const group = families.slice(index, index + 50);
    const preview = await send({ action: "preview", families: group });
    if (!preview?.marker || !Array.isArray(preview.targets)) {
      throw new Error("the Brain did not return a removal preview; nothing in this batch was removed");
    }
    matched += preview.targets.length;
    preserved += Number(preview.excluded_documents || 0);
    let marker = preview.marker;
    if (!dryRun) {
      for (let at = 0; at < preview.targets.length; at += 50) {
        const targets = preview.targets.slice(at, at + 50);
        const out = await send({ action: "apply", targets, marker });
        if (out?.documents !== targets.length || !out?.marker) {
          throw new Error(`the Brain confirmed ${Number(out?.documents || 0)} of ${targets.length} removal(s) in one batch; run again to finish`);
        }
        marker = out.marker;
        removed += out.documents;
      }
      // Read the batch back. A family still present was not removed, so the
      // caller keeps its cursor and the next run tries again.
      if (preview.targets.length) {
        const after = await send({ action: "preview", families: group });
        if (!Array.isArray(after?.targets) || after.targets.length) {
          throw new Error("Removal readback found remaining targets; the cursor was not advanced. Run again to finish.");
        }
      }
    }
    if (families.length > 50) {
      onProgress(`  removal: ${Math.min(index + 50, families.length)} of ${families.length} file(s) checked, ` +
        `${dryRun ? `${matched} document(s) would be removed` : `${removed} document(s) removed`}`);
    }
  }
  return { matched, removed, preserved };
}

/**
 * The one-time cleanup decision. Walks the configured roots once, then asks
 * Google about every stored Drive file the walk did not see. A file is a
 * target only when Google says it is trashed or not found, or when it is
 * visible and its parents are outside every walked folder. Anything else,
 * including access denied and transient errors, is kept.
 *
 * A stored file the walk did see is also a target when the current settings
 * exclude it (`exclusionOf`) or the current credential scanner refuses it
 * (`credentialRefused`). These are the scope changes the daily run never
 * removes in bulk; this one command is where they are cleaned up.
 */
export async function findDriveCleanupTargets({
  drive,
  getToken,
  stored,
  rootFolderIds,
  includeMyDriveRootFiles = false,
  sourceName = "drive",
  exclusionOf = () => null,
  credentialRefused = async () => false,
  onProgress = (line) => console.log(line),
}) {
  const walked = new Map();
  const folders = new Set(rootFolderIds);
  for await (const file of drive.listRootedFiles(getToken, { rootFolderIds, includeMyDriveRootFiles })) {
    walked.set(String(file.id), file);
    if (file.mimeType === drive.FOLDER_MIME) folders.add(String(file.id));
  }
  const folderIndex = drive.updateFolderIndex([...walked.values()]);
  const storedIds = [...new Set([...stored].map((uid) => driveFileIdOf(uid, sourceName)).filter(Boolean))].sort();
  const fileIds = storedIds.filter((id) => !walked.has(id));
  const counts = { stored: stored.size, in_roots: 0, gone: 0, outside_roots: 0, excluded: 0, credential_refused: 0, kept: 0 };
  const excluded = [];
  const refused = [];
  for (const id of storedIds.filter((entry) => walked.has(entry))) {
    const file = walked.get(id);
    if (exclusionOf(file, folderIndex)) excluded.push(`${sourceName}:${id}`);
    else if (await credentialRefused(file, folderIndex)) refused.push(`${sourceName}:${id}`);
    else counts.in_roots++;
  }
  counts.excluded = excluded.length;
  counts.credential_refused = refused.length;
  const gone = [];
  const outside = [];
  let checked = 0;
  for (const id of fileIds) {
    let kind;
    try {
      ({ kind } = await drive.classifyScopedAbsence(getToken, id, { scopedFolderIds: folders }));
    } catch (error) {
      if (error?.name !== "DriveError" || error?.retryable !== true) throw error;
      kind = "transient";
    }
    if (kind === "source_deleted" || kind === "unresolved_not_returned") gone.push(`${sourceName}:${id}`);
    else if (kind === "left_scope") outside.push(`${sourceName}:${id}`);
    else counts.kept++;
    if (++checked % 100 === 0) onProgress(`  cleanup: checked ${checked} of ${fileIds.length} stored file(s) not under a root`);
  }
  counts.gone = gone.length;
  counts.outside_roots = outside.length;
  return { gone, outside, excluded, refused, counts };
}
