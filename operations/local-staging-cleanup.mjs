/**
 * Local staging-source cleanup.
 *
 * This module deliberately separates proof, planning, and mutation. Callers
 * must obtain exact current document, provenance, and vector readback proof
 * from the Brain before a file may enter a plan. The executor receives a Trash adapter rather than a
 * generic filesystem delete function so no cleanup path can degrade to rm.
 */

import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROLE_ALIASES = Object.freeze({
  ongoing: "ongoing",
  staging: "staging",
  "one-time-import": "staging",
});

export function sourceRole(source = {}) {
  const value = source?.role == null ? "ongoing" : String(source.role);
  const role = ROLE_ALIASES[value];
  if (!role) throw new TypeError("source role must be ongoing, staging, or one-time-import");
  return role;
}

function confirmationFor(confirmations, file) {
  return confirmations?.[`${file.source}:${file.key}`] || null;
}

function safeFile(file) {
  if (!file || typeof file !== "object" || typeof file.source !== "string" ||
      typeof file.key !== "string" || typeof file.path !== "string" ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new TypeError("cleanup candidates need source, key, path, and a non-negative byte count");
  }
  return Object.freeze({ ...file });
}

export function buildLocalCleanupPlan({ files = [], sources = {}, confirmations = {} } = {}) {
  const copies = [];
  const onlyCopies = [];
  let inspected = 0;
  for (const raw of files) {
    const file = safeFile(raw);
    if (sourceRole(sources[file.source] || {}) !== "staging") continue;
    if (sources[file.source]?.retired === true) continue;
    inspected++;
    const proof = confirmationFor(confirmations, file);
    if (proof?.accepted_resolution_current !== true) continue;
    const item = Object.freeze({
      ...file,
      proof: typeof proof.proof === "string" ? proof.proof : null,
      external_original: typeof proof.external_original === "string"
        ? proof.external_original
        : null,
    });
    if (item.external_original) copies.push(item);
    else onlyCopies.push(item);
  }
  const items = Object.freeze([...copies, ...onlyCopies]);
  const plan_id = createHash("sha256").update(JSON.stringify(items.map((item) => ({
    source: item.source,
    key: item.key,
    path: resolve(item.path),
    bytes: item.bytes,
    mtime_ms: item.mtime_ms,
    proof: item.proof,
    external_original: item.external_original,
  })))).digest("hex");
  return Object.freeze({
    version: 1,
    preview: true,
    copies: Object.freeze(copies),
    only_copies: Object.freeze(onlyCopies),
    items,
    plan_id,
    total_files: items.length,
    total_bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    decision_points: inspected,
  });
}

function requireChoice(choice) {
  if (!["keep", "archive", "remove"].includes(choice)) {
    throw new TypeError("an only copy needs an explicit keep, archive, or remove choice");
  }
  return choice;
}

/** Move one file to the operating system's recoverable Trash. Never calls rm. */
export async function moveFileToSystemTrash(path, {
  platform = process.platform,
  spawn = spawnSync,
  stat = lstatSync,
} = {}) {
  const target = resolve(path);
  const before = stat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new TypeError("cleanup can move only one ordinary file to Trash");
  }
  if (platform === "darwin") {
    const script = String.raw`
ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const manager = $.NSFileManager.defaultManager;
  const ok = manager.trashItemAtURLResultingItemURLError(url, undefined, undefined);
  if (!ok) throw new Error('trash failed');
  return 'ok';
}`;
    const result = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, target], {
      encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin" },
    });
    if (result.status !== 0) throw new Error("macOS could not move the file to Trash");
    if (existsSync(target)) throw new Error("macOS did not confirm that the file reached Trash");
    return;
  }
  if (platform === "win32") {
    const script = [
      "$target=$args[0]",
      "(New-Object -ComObject Shell.Application).Namespace(10).MoveHere($target, 16)",
      "$until=(Get-Date).AddSeconds(30)",
      "while ((Test-Path -LiteralPath $target) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }",
      "if (Test-Path -LiteralPath $target) { exit 1 }",
    ].join("; ");
    const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target], {
      encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    if (result.status !== 0) throw new Error("Windows could not move the file to Recycle Bin");
    return;
  }
  const result = spawn("gio", ["trash", "--", target], {
    encoding: "utf8", timeout: 30_000,
  });
  if (result.status !== 0) throw new Error("the system Trash command is unavailable");
  if (existsSync(target)) throw new Error("the system did not confirm that the file reached Trash");
}

export async function executeLocalCleanup(plan, {
  approve = null,
  onlyCopyChoice = null,
  trash = moveFileToSystemTrash,
  archive = null,
  assertCurrent = (file) => {
    const current = lstatSync(file.path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        Number(current.size) !== file.bytes ||
        (Number.isFinite(file.mtime_ms) && Math.trunc(current.mtimeMs) !== Math.trunc(file.mtime_ms))) {
      throw new TypeError("a cleanup candidate changed after preview; preview again");
    }
  },
  now = () => new Date().toISOString(),
} = {}) {
  if (!plan?.preview || !Array.isArray(plan.items)) throw new TypeError("a cleanup preview is required");
  if (approve !== plan.plan_id) throw new TypeError("cleanup requires the exact preview fingerprint");
  const choice = plan.only_copies.length ? requireChoice(onlyCopyChoice) : "keep";
  if (choice === "archive" && typeof archive !== "function") {
    throw new TypeError("archive choice needs an owner-selected encrypted archive destination");
  }
  const selected = [
    ...plan.copies,
    ...(choice === "remove" || choice === "archive" ? plan.only_copies : []),
  ];
  let trashed = 0;
  let archived = 0;
  for (const file of selected) {
    await assertCurrent(file);
    if (choice === "archive" && plan.only_copies.includes(file)) {
      await archive(file.path);
      archived++;
    }
    await trash(file.path);
    trashed++;
  }
  return Object.freeze({
    version: 1,
    operation: "cleanup-local",
    completed_at: now(),
    considered: plan.total_files,
    moved_to_trash: trashed,
    archived,
    kept: choice === "keep" ? plan.only_copies.length : 0,
    bytes_released: selected.reduce((sum, file) => sum + file.bytes, 0),
    recoverable: true,
    deletion_primitive: "system_trash",
  });
}

export function markConsumed(state, { source, key, proof, consumed_at } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("ingest state is required");
  if (typeof source !== "string" || typeof key !== "string" || typeof proof !== "string" || !proof) {
    throw new TypeError("consumed state needs source, key, and proof");
  }
  if (!state.consumed || typeof state.consumed !== "object") state.consumed = {};
  state.consumed[key] = { source, proof, consumed_at };
  return state;
}

export function missingOngoingKeys({ knownKeys = [], presentKeys = [], role = "ongoing", consumed = {} } = {}) {
  const present = presentKeys instanceof Set ? presentKeys : new Set(presentKeys);
  const normalizedRole = sourceRole({ role });
  return [...knownKeys]
    .filter((key) => !present.has(key))
    .filter((key) => normalizedRole === "ongoing" || !consumed?.[key])
    .sort();
}

export function retentionEligible(file, { now_ms = Date.now(), retention_days } = {}) {
  if (!Number.isSafeInteger(retention_days) || retention_days < 1) {
    throw new TypeError("retention_days must be a positive integer");
  }
  if (!Number.isFinite(file?.mtime_ms) || file.mtime_ms < 0) return false;
  return file.mtime_ms <= now_ms - retention_days * 86_400_000;
}

function uploadFolders(manifest) {
  const folders = manifest?.corpora?.upload?.folders;
  return Array.isArray(folders) ? folders : [];
}

export function retireStagingSource(manifest, source, { now = () => new Date().toISOString() } = {}) {
  const matches = uploadFolders(manifest).filter((folder) => folder?.source === source);
  if (matches.length !== 1) throw new TypeError("retirement needs exactly one declared upload folder source");
  const declaration = matches[0];
  if (sourceRole(declaration) !== "staging" || declaration.role !== "one-time-import") {
    throw new TypeError("only a one-time-import source can be retired");
  }
  declaration.retired = true;
  declaration.retired_at = now();
  return Object.freeze({
    version: 1,
    source,
    retired_at: declaration.retired_at,
    decision_points: matches.length,
    future_walks_stopped: true,
    documents_preserved: true,
  });
}
