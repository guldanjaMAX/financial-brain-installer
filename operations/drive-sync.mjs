/**
 * Simple Drive sync helpers (packet 10).
 *
 * The daily Drive refresh reads Google's changes feed and acts on each change
 * directly: a changed file under a configured root is loaded, a trashed or
 * moved-out file has its stored document removed at once, and a file that
 * only left this account's view keeps it until --cleanup. There is no removal
 * plan to approve. The Worker still requires its two-step
 * preview/apply removal route, so each removal batch is previewed and then
 * applied with the exact marker the preview returned.
 */
import { requestIngestRemovalPlan } from "./ingest-removal-plan.mjs";

/** The support and receipt code for an at-once removal that did not finish. */
export const REMOVAL_RETRY_PENDING = "REMOVAL_RETRY_PENDING";

/**
 * A removal the daily run makes at once (a Calendar cancellation, a Gmail spam
 * message) failed. Nothing asks for a review: the item stays pending, the
 * cursor is held, and the next run retries it. The Worker's own wording about
 * reviewing a fresh plan is dropped, so the error, the receipt and `brain
 * support --explain` all say retry. A lost source lock is passed through
 * untouched so the caller still leaves the newer owner's receipt alone.
 */
export function removalRetryPending(error, { count = 1, what = "removal(s)" } = {}) {
  if (error?.code === "source_ingest_lock_lost") return error;
  const reason = String(error?.message || "the removal did not finish")
    .split(/\s+(?=(?:Some approved|The source cursor|Rerun|Review|Run again|run ingestion)\b)|;\s*(?=(?:the cursor|run again|run ingestion)\b)/i)[0]
    .replace(/[\s.;]+$/, "")
    .slice(0, 200);
  const wrapped = new Error(
    `${count} ${what} were not removed yet (${reason}). They stay pending, the cursor was not advanced, ` +
      "and the next run retries them.",
    { cause: error },
  );
  wrapped.name = "RemovalRetryPending";
  wrapped.code = REMOVAL_RETRY_PENDING;
  wrapped.supportCode = REMOVAL_RETRY_PENDING;
  return wrapped;
}

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
 * nothing is left. `dryRun` previews only. Gmail uses this same path for a
 * spam message, and Google and Outlook Calendar for a cancelled or deleted
 * event.
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
 * including access denied and transient errors, is kept. Trashed files are
 * `gone`; not-found files (no longer visible to this account, which the daily
 * run keeps) are `notVisible`, counted on their own.
 *
 * A stored file the walk did see is also a target when the current settings
 * exclude it (`exclusionOf`) or the current credential scanner refuses it
 * (`credentialRefused`). These are the scope changes the daily run never
 * removes in bulk; this one command is where they are cleaned up.
 * `credentialRefused` answers "unreadable" for a marked file it could not
 * re-read; that file is kept and counted on its own, never as in a root.
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
  const counts = {
    stored: stored.size, in_roots: 0, gone: 0, not_visible: 0, outside_roots: 0, excluded: 0, credential_refused: 0,
    credential_unreadable: 0, kept: 0,
  };
  const excluded = [];
  const refused = [];
  const unreadable = [];
  for (const id of storedIds.filter((entry) => walked.has(entry))) {
    const file = walked.get(id);
    if (exclusionOf(file, folderIndex)) {
      excluded.push(`${sourceName}:${id}`);
      continue;
    }
    const verdict = await credentialRefused(file, folderIndex);
    if (verdict === "unreadable") unreadable.push(`${sourceName}:${id}`);
    else if (verdict) refused.push(`${sourceName}:${id}`);
    else counts.in_roots++;
  }
  counts.excluded = excluded.length;
  counts.credential_refused = refused.length;
  counts.credential_unreadable = unreadable.length;
  const gone = [];
  const notVisible = [];
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
    if (kind === "source_deleted") gone.push(`${sourceName}:${id}`);
    else if (kind === "unresolved_not_returned") notVisible.push(`${sourceName}:${id}`);
    else if (kind === "left_scope") outside.push(`${sourceName}:${id}`);
    else counts.kept++;
    if (++checked % 100 === 0) onProgress(`  cleanup: checked ${checked} of ${fileIds.length} stored file(s) not under a root`);
  }
  counts.gone = gone.length;
  counts.not_visible = notVisible.length;
  counts.outside_roots = outside.length;
  return { gone, notVisible, outside, excluded, refused, unreadable, counts };
}
