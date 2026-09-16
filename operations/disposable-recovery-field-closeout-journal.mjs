/**
 * Durable, hash-only A17 Keychain deletion journal.
 *
 * This module is intentionally independent from both the A17 producer and its
 * final acceptance reader. It can therefore authenticate the retained journal
 * from either side without creating an import cycle.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  assertNoDarwinReceiptAcl,
  assertPrivateAggregateEmptyReceiptFile,
  assertPrivateAggregateReceiptDirectory,
  syncPrivateReceiptDirectory,
} from "./private-aggregate-receipt.mjs";

export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME =
  "v048-disposable-field-closeout-deletion-journal.jsonl";
export const DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL =
  "v048-disposable-recovery-field-closeout-deletion-journal-v1";

const ERROR_CODE =
  "DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_INVALID";
const MAX_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const RECORD_FIELDS = Object.freeze([
  "schema_version", "protocol", "sequence", "item_index", "purpose",
  "locator_sha256", "state", "a17_approval_fingerprint",
  "retained_evidence_inventory_sha256", "keychain_binding_sha256",
  "reservation_marker_sha256", "receipt_path_sha256",
  "receipt_directory_path_sha256", "previous_record_sha256",
]);
const STATES = new Set([
  "planned", "sent_unconfirmed", "confirmed_absent", "reconciled_absent",
]);
const JOURNAL_IO_KEYS = Object.freeze([
  "open", "write", "sync", "chmod", "stat", "close", "syncDirectory",
]);
const ITEM_DEFINITIONS = Object.freeze([
  Object.freeze({
    reference: "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
    purpose: "source_admin_key",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
    purpose: "target_admin_key",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
    purpose: "recovery_artifact_key",
  }),
  Object.freeze({
    reference: "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
    purpose: "bank_access_wrapping_key_v2",
  }),
].map((item) => Object.freeze({
  purpose: item.purpose,
  locator_sha256: sha256(item.reference),
})));

export class DisposableRecoveryFieldCloseoutJournalError extends Error {
  constructor(code = ERROR_CODE) {
    super(code);
    this.name = "DisposableRecoveryFieldCloseoutJournalError";
    this.code = code;
  }
}

function refuse() {
  throw new DisposableRecoveryFieldCloseoutJournalError();
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

function sameInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameStablePrivateFile(left, right) {
  return left?.isFile?.() === true && right?.isFile?.() === true &&
    sameInode(left, right) && left.size === right.size &&
    left.nlink === 1 && right.nlink === 1 && left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function checkedJournalIo(value) {
  if (!plainObject(value) || Object.keys(value).some((key) =>
    !JOURNAL_IO_KEYS.includes(key) || typeof value[key] !== "function")) {
    refuse();
  }
  return Object.freeze({
    open: value.open ?? openSync,
    write: value.write ?? writeSync,
    sync: value.sync ?? fsyncSync,
    chmod: value.chmod ?? fchmodSync,
    stat: value.stat ?? fstatSync,
    close: value.close ?? closeSync,
    syncDirectory: value.syncDirectory ?? syncPrivateReceiptDirectory,
  });
}

function checkedBinding(value) {
  if (!exactKeys(value, [
    "a17_approval_fingerprint", "retained_evidence_inventory_sha256",
    "keychain_binding_sha256", "reservation_marker_sha256",
  ]) || Object.values(value).some((hash) => !SHA256_RE.test(String(hash || "")))) {
    refuse();
  }
  return Object.freeze({ ...value });
}

function checkedContext({
  journalPath,
  receiptPath,
  expectedReceiptDirectory,
  binding,
  expectedReceiptDirectoryInfo = null,
}) {
  let directory;
  try {
    directory = assertPrivateAggregateReceiptDirectory(
      realpathSync(resolve(expectedReceiptDirectory)),
      { code: ERROR_CODE },
    );
  } catch {
    refuse();
  }
  if (expectedReceiptDirectoryInfo &&
      !sameInode(directory.info, expectedReceiptDirectoryInfo)) {
    refuse();
  }
  const path = resolve(journalPath);
  const receipt = resolve(receiptPath);
  if (dirname(path) !== directory.path ||
      basename(path) !== DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME ||
      dirname(receipt) !== directory.path) {
    refuse();
  }
  return Object.freeze({
    path,
    receiptPath: receipt,
    directory,
    binding: checkedBinding(binding),
  });
}

function checkedRecord(record, index, context, previousRecord) {
  const item = ITEM_DEFINITIONS[record?.item_index];
  if (!exactKeys(record, RECORD_FIELDS) || record.schema_version !== 1 ||
      record.protocol !== DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL ||
      record.sequence !== index + 1 || !Number.isSafeInteger(record.item_index) ||
      !item || record.purpose !== item.purpose ||
      record.locator_sha256 !== item.locator_sha256 ||
      !STATES.has(record.state) ||
      record.a17_approval_fingerprint !==
        context.binding.a17_approval_fingerprint ||
      record.retained_evidence_inventory_sha256 !==
        context.binding.retained_evidence_inventory_sha256 ||
      record.keychain_binding_sha256 !== context.binding.keychain_binding_sha256 ||
      record.reservation_marker_sha256 !==
        context.binding.reservation_marker_sha256 ||
      record.receipt_path_sha256 !== sha256(context.receiptPath) ||
      record.receipt_directory_path_sha256 !== sha256(context.directory.path) ||
      record.previous_record_sha256 !== (previousRecord === null
        ? null
        : sha256(canonical(previousRecord)))) {
    refuse();
  }
  return record;
}

function analyzed(records, context) {
  if (!Array.isArray(records) || records.length > ITEM_DEFINITIONS.length * 3) {
    refuse();
  }
  records.forEach((record, index) => checkedRecord(
    record,
    index,
    context,
    index === 0 ? null : records[index - 1],
  ));
  let position = 0;
  let completed = 0;
  let pending = null;
  for (let itemIndex = 0; itemIndex < ITEM_DEFINITIONS.length; itemIndex += 1) {
    if (position === records.length) break;
    const planned = records[position];
    if (planned.item_index !== itemIndex || planned.state !== "planned") refuse();
    position += 1;
    if (position === records.length) {
      pending = Object.freeze({ itemIndex, state: "planned" });
      break;
    }
    const sent = records[position];
    if (sent.item_index !== itemIndex || sent.state !== "sent_unconfirmed") refuse();
    position += 1;
    if (position === records.length) {
      pending = Object.freeze({ itemIndex, state: "sent_unconfirmed" });
      break;
    }
    const terminal = records[position];
    if (terminal.item_index !== itemIndex ||
        !["confirmed_absent", "reconciled_absent"].includes(terminal.state)) {
      refuse();
    }
    position += 1;
    completed += 1;
  }
  if (position !== records.length) refuse();
  return Object.freeze({ completed, pending });
}

export function assertDisposableRecoveryFieldCloseoutDeletionJournalRecords({
  records,
  journalPath,
  receiptPath,
  expectedReceiptDirectory,
  expectedReceiptDirectoryInfo = null,
  binding,
}) {
  const context = checkedContext({
    journalPath,
    receiptPath,
    expectedReceiptDirectory,
    expectedReceiptDirectoryInfo,
    binding,
  });
  return analyzed(records, context);
}

function checkedFileInfo(path, runAclInspection, expected = null) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        info.size < 1 || info.size > MAX_BYTES || realpathSync(path) !== path ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
        (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
        (expected && !sameStablePrivateFile(info, expected))) {
      refuse();
    }
    return assertNoDarwinReceiptAcl(path, info, {
      code: ERROR_CODE,
      run: runAclInspection,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutJournalError) throw error;
    refuse();
  }
}

function summaryFor(records, state, context, journalSha256) {
  if (state.completed !== ITEM_DEFINITIONS.length || state.pending !== null ||
      records.length !== ITEM_DEFINITIONS.length * 3) {
    return null;
  }
  return Object.freeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL,
    path_sha256: sha256(context.path),
    event_count: records.length,
    head_sha256: sha256(canonical(records.at(-1))),
    journal_sha256: journalSha256,
    terminal_state: "all_campaign_items_confirmed_absent",
  });
}

export function readDisposableRecoveryFieldCloseoutDeletionJournal({
  journalPath,
  receiptPath,
  expectedReceiptDirectory,
  binding,
  expectedReceiptDirectoryInfo = null,
  expectedJournalInfo = null,
  expectedSummary = null,
  allowAbsent = false,
  runAclInspection,
}) {
  const context = checkedContext({
    journalPath,
    receiptPath,
    expectedReceiptDirectory,
    binding,
    expectedReceiptDirectoryInfo,
  });
  if (!existsSync(context.path)) {
    if (allowAbsent) {
      return Object.freeze({ records: Object.freeze([]), state: Object.freeze({
        completed: 0,
        pending: null,
      }), summary: null, info: null });
    }
    refuse();
  }
  let descriptor;
  let bytes;
  try {
    const before = checkedFileInfo(
      context.path,
      runAclInspection,
      expectedJournalInfo,
    );
    descriptor = openSync(
      context.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (!sameStablePrivateFile(before, opened)) refuse();
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1) refuse();
      offset += count;
    }
    const after = checkedFileInfo(context.path, runAclInspection, opened);
    if (!sameStablePrivateFile(after, fstatSync(descriptor)) || bytes.at(-1) !== 0x0a) {
      refuse();
    }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { refuse(); }
    const lines = text.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) refuse();
    const records = lines.map((line) => {
      let record;
      try { record = JSON.parse(line); } catch { refuse(); }
      if (canonical(record) !== line) refuse();
      return Object.freeze(record);
    });
    const state = analyzed(records, context);
    const summary = summaryFor(records, state, context, sha256(bytes));
    if (expectedSummary !== null &&
        canonical(summary) !== canonical(expectedSummary)) {
      refuse();
    }
    return Object.freeze({
      records: Object.freeze(records),
      state,
      summary,
      info: after,
    });
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutJournalError) throw error;
    refuse();
  } finally {
    if (bytes) bytes.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* every use reopens and revalidates */ }
    }
  }
}

export function appendDisposableRecoveryFieldCloseoutDeletionJournal({
  journalPath,
  receiptPath,
  expectedReceiptDirectory,
  expectedReceiptDirectoryInfo = null,
  binding,
  records,
  itemIndex,
  state,
  runAclInspection,
  io = {},
}) {
  const journalIo = checkedJournalIo(io);
  const context = checkedContext({
    journalPath,
    receiptPath,
    expectedReceiptDirectory,
    binding,
    expectedReceiptDirectoryInfo,
  });
  const loaded = readDisposableRecoveryFieldCloseoutDeletionJournal({
    journalPath: context.path,
    receiptPath: context.receiptPath,
    expectedReceiptDirectory: context.directory.path,
    expectedReceiptDirectoryInfo: context.directory.info,
    binding: context.binding,
    allowAbsent: true,
    runAclInspection,
  });
  if (canonical(loaded.records) !== canonical(records) ||
      !Number.isSafeInteger(itemIndex) || !ITEM_DEFINITIONS[itemIndex] ||
      !STATES.has(state)) {
    refuse();
  }
  const item = ITEM_DEFINITIONS[itemIndex];
  const record = Object.freeze({
    schema_version: 1,
    protocol: DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_PROTOCOL,
    sequence: records.length + 1,
    item_index: itemIndex,
    purpose: item.purpose,
    locator_sha256: item.locator_sha256,
    state,
    a17_approval_fingerprint: context.binding.a17_approval_fingerprint,
    retained_evidence_inventory_sha256:
      context.binding.retained_evidence_inventory_sha256,
    keychain_binding_sha256: context.binding.keychain_binding_sha256,
    reservation_marker_sha256: context.binding.reservation_marker_sha256,
    receipt_path_sha256: sha256(context.receiptPath),
    receipt_directory_path_sha256: sha256(context.directory.path),
    previous_record_sha256: records.length === 0
      ? null
      : sha256(canonical(records.at(-1))),
  });
  const expected = [...records, record];
  analyzed(expected, context);
  const line = Buffer.from(`${canonical(record)}\n`, "utf8");
  let descriptor;
  try {
    if (records.length === 0) {
      descriptor = journalIo.open(
        context.path,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
          fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      assertPrivateAggregateEmptyReceiptFile(context.path, descriptor, {
        code: ERROR_CODE,
      });
    } else {
      const before = checkedFileInfo(context.path, runAclInspection);
      descriptor = journalIo.open(
        context.path,
        fsConstants.O_RDWR | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0),
      );
      if (!sameStablePrivateFile(before, journalIo.stat(descriptor))) refuse();
    }
    const beforeSize = journalIo.stat(descriptor).size;
    if (beforeSize + line.length > MAX_BYTES ||
        journalIo.write(descriptor, line, 0, line.length, null) !== line.length) {
      refuse();
    }
    journalIo.sync(descriptor);
    journalIo.chmod(descriptor, 0o600);
    const opened = journalIo.stat(descriptor);
    const after = checkedFileInfo(context.path, runAclInspection, opened);
    if (opened.size !== beforeSize + line.length ||
        !sameStablePrivateFile(opened, after)) {
      refuse();
    }
    journalIo.syncDirectory(
      context.directory.path,
      context.directory.info,
      context.path,
      after,
      ERROR_CODE,
    );
  } catch (error) {
    if (error instanceof DisposableRecoveryFieldCloseoutJournalError) throw error;
    refuse();
  } finally {
    line.fill(0);
    if (descriptor !== undefined) {
      try { journalIo.close(descriptor); } catch { /* persisted state is re-read below */ }
    }
  }
  const persisted = readDisposableRecoveryFieldCloseoutDeletionJournal({
    journalPath: context.path,
    receiptPath: context.receiptPath,
    expectedReceiptDirectory: context.directory.path,
    expectedReceiptDirectoryInfo: context.directory.info,
    binding: context.binding,
    runAclInspection,
  });
  if (canonical(persisted.records) !== canonical(expected)) refuse();
  return persisted;
}
