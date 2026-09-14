import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  disposableRecoveryFieldKeychainPrepApprovalFingerprint,
  runDisposableRecoveryFieldKeychainPrep,
  verifyDisposableRecoveryFieldKeychainPrep,
} from "../../operations/disposable-recovery-field-keychain-prep.mjs";

const REFERENCES = Object.freeze([
  "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
]);

const retainedDirectories = new Set();
process.once("exit", () => {
  for (const directory of retainedDirectories) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* temporary test evidence only */ }
  }
});

function reference(locator) {
  return locator?.reference ?? `keychain://${locator?.service}/${locator?.account}`;
}

function testKeychain() {
  const values = new Map(REFERENCES.map((item) => [item, null]));
  return {
    values,
    adapter: {
      inspect: async (locator) => {
        const item = reference(locator);
        if (!values.has(item)) throw new Error("unexpected test Keychain locator");
        return values.get(item) === null ? "item_not_found" : "present";
      },
      read: async (locator) => {
        const item = reference(locator);
        if (!values.has(item)) throw new Error("unexpected test Keychain locator");
        const value = values.get(item);
        return value === null ? null : Buffer.from(value);
      },
      write: async (locator, value) => {
        const item = reference(locator);
        if (!values.has(item) || values.get(item) !== null) {
          throw new Error("unexpected test Keychain write");
        }
        values.set(item, Buffer.from(value));
        return true;
      },
      delete: async (locator) => {
        const item = reference(locator);
        if (!values.has(item)) throw new Error("unexpected test Keychain locator");
        values.get(item)?.fill(0);
        values.set(item, null);
        return true;
      },
    },
  };
}

/**
 * Produce a genuine verifier-minted K0 capability for lower-level tests.
 * This uses the production K0 receipt and verifier with an in-memory Keychain;
 * it is not a production mint or a capability bypass.
 */
export async function createTestDisposableRecoveryK0Capability(binding) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-test-k0-")));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  retainedDirectories.add(directory);
  const keychain = testKeychain();
  let call = 0;
  const receiptPath = join(
    directory,
    DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  );
  await runDisposableRecoveryFieldKeychainPrep({
    binding,
    approvalFingerprint:
      disposableRecoveryFieldKeychainPrepApprovalFingerprint(binding),
    singleOperatorConfirmed: true,
    receiptPath,
    expectedReceiptDirectory: directory,
    keychain: keychain.adapter,
    platform: "darwin",
    randomBytesImpl: (length) => Buffer.alloc(length, ++call),
    revalidate: () => true,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  });
  const proof = await verifyDisposableRecoveryFieldKeychainPrep({
    binding,
    receiptPath,
    expectedReceiptDirectory: directory,
    keychain: {
      inspect: keychain.adapter.inspect,
      read: keychain.adapter.read,
    },
    platform: "darwin",
  });
  return Object.freeze({ proof, directory, keychain });
}
