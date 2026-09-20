import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateEmptyReceiptFile,
  assertPrivateAggregateReceiptDirectory,
  privateAggregateReceiptStagedPath,
  readPrivateAggregateReceipt,
  syncPrivateReceiptDirectory,
} from "./private-aggregate-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL,
} from "./disposable-recovery-field-closeout-journal.mjs";

export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME =
  "v048-disposable-field-closeout-terminal-anchor.json";
export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_PROTOCOL =
  "v048-disposable-recovery-field-closeout-terminal-anchor-v1";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const MAX_ANCHOR_BYTES = 256 * 1024;

export class DisposableRecoveryFieldCloseoutTerminalAnchorError extends Error {
  constructor(code) {
    super(code);
    this.name = "DisposableRecoveryFieldCloseoutTerminalAnchorError";
    this.code = code;
  }
}

function refuse(code = "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID") {
  throw new DisposableRecoveryFieldCloseoutTerminalAnchorError(code);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields) {
  return plainObject(value) && Object.keys(value).sort().join("\0") ===
    [...fields].sort().join("\0");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutable(value) {
  const copy = structuredClone(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    Object.freeze(entry);
    for (const child of Object.values(entry)) freeze(child);
    return entry;
  };
  return freeze(copy);
}

function exactIso(value) {
  try { return typeof value === "string" && new Date(value).toISOString() === value; }
  catch { return false; }
}

function sameStableFile(left, right) {
  return left?.isFile?.() === true && right?.isFile?.() === true &&
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === 1 && right.nlink === 1 &&
    left.mode === right.mode && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertOwner(info, code) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) refuse(code);
}

function checkedJournal(value, code) {
  if (!exactKeys(value, [
    "schema_version", "protocol", "path_sha256", "event_count",
    "head_sha256", "journal_sha256", "terminal_state",
  ]) || value.schema_version !== 1 ||
      value.protocol !==
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL ||
      !SHA256_RE.test(String(value.path_sha256 || "")) ||
      !Number.isSafeInteger(value.event_count) || value.event_count < 1 ||
      !SHA256_RE.test(String(value.head_sha256 || "")) ||
      !SHA256_RE.test(String(value.journal_sha256 || "")) ||
      value.terminal_state !== "all_campaign_items_confirmed_absent") {
    refuse(code);
  }
  return immutable(value);
}

function checkedContext(receiptPath, expectedReceiptDirectory, code) {
  let parent;
  try {
    parent = assertPrivateAggregateReceiptDirectory(
      realpathSync(resolve(expectedReceiptDirectory)),
      { code },
    );
  } catch {
    refuse(code);
  }
  const receipt = resolve(receiptPath);
  if (dirname(receipt) !== parent.path) refuse(code);
  const anchorPath = join(
    parent.path,
    DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
  );
  if (basename(anchorPath) !==
      DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME) refuse(code);
  return Object.freeze({ receiptPath: receipt, anchorPath, parent });
}

export function disposableRecoveryFieldCloseoutFinalizationCommitSha256({
  receiptPath,
  reservationMarkerSha256,
  finalReceiptSha256,
  finalReceiptBytes,
}) {
  if (typeof receiptPath !== "string" || !receiptPath.startsWith("/") ||
      !SHA256_RE.test(String(reservationMarkerSha256 || "")) ||
      !SHA256_RE.test(String(finalReceiptSha256 || "")) ||
      !Number.isSafeInteger(finalReceiptBytes) || finalReceiptBytes < 1 ||
      finalReceiptBytes > 2 * 1024 * 1024) refuse();
  const finalPath = resolve(receiptPath);
  const stagedPath = privateAggregateReceiptStagedPath(finalPath);
  const value = {
    schema_version: 1,
    kind: "private_aggregate_receipt_finalization_commit",
    reservation_marker_sha256: reservationMarkerSha256,
    final_receipt_sha256: finalReceiptSha256,
    final_receipt_bytes: finalReceiptBytes,
    final_receipt_path_sha256: sha256(finalPath),
    staged_receipt_path_sha256: sha256(stagedPath),
  };
  return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export function disposableRecoveryFieldCloseoutTerminalAnchorValue({
  receiptPath,
  expectedReceiptDirectory,
  reservationMarkerSha256,
  finalReceiptSha256,
  finalReceiptBytes,
  finalizationCommitReceiptSha256,
  completedAt,
  approvalFingerprint,
  retainedEvidenceInventorySha256,
  keychainBindingSha256,
  terminalJournal,
}) {
  const code = "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID";
  const context = checkedContext(receiptPath, expectedReceiptDirectory, code);
  const stagedPathSha256 = sha256(
    privateAggregateReceiptStagedPath(context.receiptPath),
  );
  const journal = checkedJournal(terminalJournal, code);
  const hashes = [
    reservationMarkerSha256,
    finalReceiptSha256,
    finalizationCommitReceiptSha256,
    approvalFingerprint,
    retainedEvidenceInventorySha256,
    keychainBindingSha256,
  ];
  if (hashes.some((value) => !SHA256_RE.test(String(value || ""))) ||
      !Number.isSafeInteger(finalReceiptBytes) || finalReceiptBytes < 1 ||
      finalReceiptBytes > 2 * 1024 * 1024 || !exactIso(completedAt) ||
      finalizationCommitReceiptSha256 !==
        disposableRecoveryFieldCloseoutFinalizationCommitSha256({
          receiptPath: context.receiptPath,
          reservationMarkerSha256,
          finalReceiptSha256,
          finalReceiptBytes,
        })) {
    refuse(code);
  }
  return immutable({
    schema_version: 1,
    kind: "v048_disposable_recovery_field_closeout_terminal_anchor",
    protocol: DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_PROTOCOL,
    state: "terminal_finalization_authority",
    anchor_path_sha256: sha256(context.anchorPath),
    receipt_path_sha256: sha256(context.receiptPath),
    staged_receipt_path_sha256: stagedPathSha256,
    receipt_directory_path_sha256: sha256(context.parent.path),
    reservation_marker_sha256: reservationMarkerSha256,
    final_receipt_sha256: finalReceiptSha256,
    final_receipt_bytes: finalReceiptBytes,
    finalization_commit_receipt_sha256: finalizationCommitReceiptSha256,
    completed_at: completedAt,
    a17_approval_fingerprint: approvalFingerprint,
    retained_evidence_inventory_sha256: retainedEvidenceInventorySha256,
    keychain_binding_sha256: keychainBindingSha256,
    terminal_deletion_journal: journal,
  });
}

export function assertDisposableRecoveryFieldCloseoutTerminalAnchor(
  value,
  expected,
) {
  const code = "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID";
  const fields = [
    "schema_version", "kind", "protocol", "state", "anchor_path_sha256",
    "receipt_path_sha256", "staged_receipt_path_sha256",
    "receipt_directory_path_sha256",
    "reservation_marker_sha256", "final_receipt_sha256", "final_receipt_bytes",
    "finalization_commit_receipt_sha256", "completed_at",
    "a17_approval_fingerprint", "retained_evidence_inventory_sha256",
    "keychain_binding_sha256", "terminal_deletion_journal",
  ];
  if (!exactKeys(value, fields) || value.schema_version !== 1 ||
      value.kind !== "v048_disposable_recovery_field_closeout_terminal_anchor" ||
      value.protocol !== DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_PROTOCOL ||
      value.state !== "terminal_finalization_authority" ||
      fields.slice(4, 11).filter((field) => field !== "final_receipt_bytes")
        .some((field) => !SHA256_RE.test(String(value[field] || ""))) ||
      !Number.isSafeInteger(value.final_receipt_bytes) ||
      value.final_receipt_bytes < 1 || value.final_receipt_bytes > 2 * 1024 * 1024 ||
      !exactIso(value.completed_at) ||
      [value.a17_approval_fingerprint,
        value.retained_evidence_inventory_sha256,
        value.keychain_binding_sha256].some((entry) =>
        !SHA256_RE.test(String(entry || ""))) ||
      value.finalization_commit_receipt_sha256 !== sha256(Buffer.from(
        `${JSON.stringify({
          schema_version: 1,
          kind: "private_aggregate_receipt_finalization_commit",
          reservation_marker_sha256: value.reservation_marker_sha256,
          final_receipt_sha256: value.final_receipt_sha256,
          final_receipt_bytes: value.final_receipt_bytes,
          final_receipt_path_sha256: value.receipt_path_sha256,
          staged_receipt_path_sha256: value.staged_receipt_path_sha256,
        }, null, 2)}\n`,
        "utf8",
      ))) {
    refuse(code);
  }
  checkedJournal(value.terminal_deletion_journal, code);
  if (expected && canonical(value) !== canonical(expected)) refuse(code);
  return immutable(value);
}

/**
 * Install the permanent terminal anchor. Any existing bytes, including an
 * interrupted prefix, are preserved and refused. Only a completely absent
 * anchor may be created; terminal acceptance requires an exact full readback.
 */
export function createDisposableRecoveryFieldCloseoutTerminalAnchor({
  receiptPath,
  expectedReceiptDirectory,
  expected,
  resume = false,
}) {
  const code = "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID";
  if (resume !== false) refuse(code);
  const context = checkedContext(receiptPath, expectedReceiptDirectory, code);
  const value = assertDisposableRecoveryFieldCloseoutTerminalAnchor(expected);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_ANCHOR_BYTES) {
    bytes.fill(0);
    refuse(code);
  }
  let descriptor;
  let offset = 0;
  try {
    descriptor = openSync(
      context.anchorPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    assertPrivateAggregateEmptyReceiptFile(context.anchorPath, descriptor, { code });
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1) refuse(code);
      offset += count;
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    const current = lstatSync(context.anchorPath);
    if (opened.size !== bytes.length || !sameStableFile(opened, current)) refuse(code);
    assertOwner(opened, code);
    assertNoDarwinReceiptAcl(context.anchorPath, current, { code });
    const readback = Buffer.alloc(bytes.length);
    try {
      let readOffset = 0;
      while (readOffset < readback.length) {
        const count = readSync(
          descriptor,
          readback,
          readOffset,
          readback.length - readOffset,
          readOffset,
        );
        if (!Number.isSafeInteger(count) || count < 1) refuse(code);
        readOffset += count;
      }
      if (!readback.equals(bytes) || !sameStableFile(opened, fstatSync(descriptor)) ||
          !sameStableFile(opened, lstatSync(context.anchorPath))) refuse(code);
    } finally {
      readback.fill(0);
    }
    syncPrivateReceiptDirectory(
      context.parent.path,
      context.parent.info,
      context.anchorPath,
      opened,
      code,
    );
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutTerminalAnchorError) throw error;
    refuse(code);
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* permanent anchor is re-read below */ }
    }
  }
  return readDisposableRecoveryFieldCloseoutTerminalAnchor({
    receiptPath,
    expectedReceiptDirectory,
    expected: value,
  });
}

export function readDisposableRecoveryFieldCloseoutTerminalAnchor({
  receiptPath,
  expectedReceiptDirectory,
  expected,
}) {
  const code = "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID";
  const context = checkedContext(receiptPath, expectedReceiptDirectory, code);
  let loaded;
  try {
    loaded = readPrivateAggregateReceipt(context.anchorPath, { code });
    assertDisposableRecoveryFieldCloseoutTerminalAnchor(loaded.value, expected);
    if (loaded.value.anchor_path_sha256 !== sha256(context.anchorPath) ||
        loaded.value.receipt_path_sha256 !== sha256(context.receiptPath) ||
        loaded.value.staged_receipt_path_sha256 !== sha256(
          privateAggregateReceiptStagedPath(context.receiptPath),
        ) ||
        loaded.value.receipt_directory_path_sha256 !== sha256(context.parent.path)) {
      refuse(code);
    }
    const current = lstatSync(context.anchorPath);
    if (!sameStableFile(loaded.info, current)) refuse(code);
    const parent = assertPrivateAggregateReceiptDirectory(context.parent.path, { code });
    if (parent.info.dev !== context.parent.info.dev ||
        parent.info.ino !== context.parent.info.ino) refuse(code);
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutTerminalAnchorError) throw error;
    refuse(code);
  }
  return Object.freeze({
    path: context.anchorPath,
    value: immutable(loaded.value),
    sha256: loaded.sha256,
    bytes: loaded.info.size,
    info: loaded.info,
  });
}
