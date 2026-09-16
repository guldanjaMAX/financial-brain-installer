import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DisposableRecoveryFieldKeychainPrepCliError,
  disposableRecoveryFieldKeychainPrepHelp,
  executeDisposableRecoveryFieldKeychainPrep,
  main,
  parseDisposableRecoveryFieldKeychainPrepArguments,
} from "../operations/disposable-recovery-field-keychain-prep-cli.mjs";

const HASH = (character) => character.repeat(64);
const SHA = "1".repeat(40);
const ACCOUNT = "a".repeat(32);
const EXPECTED_RECEIPT_PATH = join(
  resolve("/private/receipts"),
  "v048-disposable-field-keychain-prep.json",
);
const COMMON = Object.freeze([
  "--account-id", ACCOUNT,
  "--candidate-sha", SHA,
  "--field-receipt", "/private/field-prepare-receipt.json",
  "--package", "/private/candidate.tgz",
  "--wrangler-wrapper", "/private/wrangler-wrapper",
  "--receipt-directory", "/private/receipts",
]);

function cliError(code) {
  return (error) => error instanceof DisposableRecoveryFieldKeychainPrepCliError &&
    error.code === code;
}

function parsed(command, extras = []) {
  return parseDisposableRecoveryFieldKeychainPrepArguments([command, ...COMMON, ...extras]);
}

function dependencies(events = []) {
  return {
    platform: "darwin",
    assertReceiptDirectory(path) {
      events.push(["directory", path]);
      return Object.freeze({ path });
    },
    inspectPreparation(input) {
      events.push(["evidence", input]);
      return Object.freeze({
        binding: Object.freeze({
          candidate_sha: SHA,
          candidate_tree_sha: "2".repeat(40),
          package_sha256: HASH("3"),
          field_receipt_sha256: HASH("4"),
        }),
        revalidate: () => { events.push(["revalidate"]); return true; },
      });
    },
    createKeychain(input) {
      events.push(["keychain", input]);
      return Object.freeze({ marker: true });
    },
    async previewPreparation(input) {
      events.push(["preview", input]);
      assert.equal(input.binding.account_id, ACCOUNT);
      assert.equal(input.keychain.marker, true);
      return Object.freeze({
        schema_version: 1,
        kind: "v048_disposable_recovery_field_keychain_prep_preview",
        status: "ready_for_separate_approval",
        binding: Object.freeze({ account_fingerprint: HASH("5") }),
        keychain_mutation: false,
        provider_access: false,
        provider_mutation: false,
        campaign_items: Object.freeze([]),
        k0_approval_fingerprint: HASH("6"),
      });
    },
    async runPreparation(input) {
      events.push(["execute", input]);
      assert.equal(input.binding.account_id, ACCOUNT);
      assert.equal(input.approvalFingerprint, HASH("6"));
      assert.equal(input.singleOperatorConfirmed, true);
      assert.equal(typeof input.resume, "boolean");
      assert.equal(input.keychain.marker, true);
      assert.equal(input.receiptPath, EXPECTED_RECEIPT_PATH);
      assert.equal(input.revalidate(), true);
      return Object.freeze({
        receipt: Object.freeze({ status: "prepared" }),
        receiptSha256: HASH("7"),
      });
    },
    async previewReset(input) {
      events.push(["reset-preview", input]);
      assert.equal(input.binding.account_id, ACCOUNT);
      return Object.freeze({
        schema_version: 1,
        kind: "v048_disposable_recovery_field_keychain_reset_preview",
        status: "ready_for_separate_approval",
        binding: Object.freeze({ account_fingerprint: HASH("5") }),
        reservation_marker_sha256: HASH("7"),
        campaign_items: Object.freeze([]),
        keychain_mutation: false,
        provider_access: false,
        provider_mutation: false,
        shared_cloudflare_token_touched: false,
        reset_receipt_name: `reset-${HASH("7")}.json`,
        reset_approval_fingerprint: HASH("8"),
      });
    },
    async runReset(input) {
      events.push(["reset-execute", input]);
      assert.equal(input.binding.account_id, ACCOUNT);
      assert.equal(input.approvalFingerprint, HASH("8"));
      assert.equal(input.resume, false);
      return Object.freeze({
        status: "reset_complete",
        receiptSha256: HASH("9"),
        campaignItemsAbsent: 4,
      });
    },
  };
}

test("parser requires one exact local-only preview or approved execute", () => {
  assert.equal(parsed("preview").command, "preview");
  const execute = parsed("execute", [
    "--approve-k0", HASH("6"), "--confirm-single-operator",
  ]);
  assert.equal(execute.approvalFingerprint, HASH("6"));
  assert.equal(execute.singleOperatorConfirmed, true);
  assert.equal(execute.resume, false);
  assert.equal(parsed("execute", [
    "--approve-k0", HASH("6"), "--confirm-single-operator", "--resume",
  ]).resume, true);
  assert.equal(parsed("reset-preview").command, "reset-preview");
  const reset = parsed("reset-execute", [
    "--approve-k0-reset", HASH("8"), "--confirm-single-operator",
  ]);
  assert.equal(reset.approvalFingerprint, HASH("8"));
  assert.equal(reset.resume, false);

  for (const argv of [
    ["preview", ...COMMON.slice(0, -2)],
    ["preview", ...COMMON, "--approve-k0", HASH("6")],
    ["execute", ...COMMON, "--approve-k0", HASH("6")],
    ["execute", ...COMMON, "--approve-k0", "x", "--confirm-single-operator"],
    ["preview", ...COMMON, "--token", "secret"],
    ["preview", ...COMMON, "--account-id", ACCOUNT],
    ["preview", ...COMMON.slice(0, 2), "--candidate-sha=bad", ...COMMON.slice(4)],
  ]) {
    assert.throws(
      () => parseDisposableRecoveryFieldKeychainPrepArguments(argv),
      (error) => error instanceof DisposableRecoveryFieldKeychainPrepCliError,
    );
  }
  assert.deepEqual(parseDisposableRecoveryFieldKeychainPrepArguments(["--help"]), {
    command: "help",
  });
});

test("reset commands are separate, exact-approved, and never expose provider access", async () => {
  const previewEvents = [];
  const preview = await executeDisposableRecoveryFieldKeychainPrep(
    parsed("reset-preview"),
    dependencies(previewEvents),
  );
  assert.equal(preview.reset_approval_fingerprint, HASH("8"));
  assert.equal(preview.keychain_mutation, false);
  assert.equal(preview.provider_access, false);
  assert.deepEqual(previewEvents.map(([name]) => name), [
    "directory", "evidence", "keychain", "reset-preview",
  ]);

  const executeEvents = [];
  const result = await executeDisposableRecoveryFieldKeychainPrep(
    parsed("reset-execute", [
      "--approve-k0-reset", HASH("8"), "--confirm-single-operator",
    ]),
    dependencies(executeEvents),
  );
  assert.deepEqual(result, {
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_reset",
    status: "reset_complete",
    receipt_sha256: HASH("9"),
    campaign_keychain_items_absent: 4,
    shared_cloudflare_token_touched: false,
    provider_access: false,
    provider_mutation: false,
    resumed: false,
  });
  assert.deepEqual(executeEvents.map(([name]) => name), [
    "directory", "evidence", "keychain", "reset-execute",
  ]);
});

test("preview binds sealed candidate evidence and performs fixed-item inspection only", async () => {
  const events = [];
  const result = await executeDisposableRecoveryFieldKeychainPrep(parsed("preview"),
    dependencies(events));
  assert.equal(result.status, "ready_for_separate_approval");
  assert.equal(result.keychain_mutation, false);
  assert.equal(result.provider_access, false);
  assert.equal(result.keychain_access, "fixed_item_presence_only");
  assert.equal(result.receipt_path, EXPECTED_RECEIPT_PATH);
  assert.deepEqual(events.map(([name]) => name), [
    "directory", "evidence", "keychain", "preview",
  ]);
  assert.equal(JSON.stringify(result).includes(ACCOUNT), false);
});

test("execute passes only exact approval, confirmation, binding, and private output", async () => {
  const events = [];
  const result = await executeDisposableRecoveryFieldKeychainPrep(parsed("execute", [
    "--approve-k0", HASH("6"), "--confirm-single-operator",
  ]), dependencies(events));
  assert.deepEqual(result, {
    schema_version: 1,
    kind: "v048_disposable_recovery_field_keychain_prep",
    status: "prepared",
    receipt_sha256: HASH("7"),
    local_keychain_mutation: true,
    provider_access: false,
    provider_mutation: false,
  });
  assert.deepEqual(events.map(([name]) => name), [
    "directory", "evidence", "keychain", "execute", "revalidate",
  ]);
  assert.equal(JSON.stringify(result).includes(ACCOUNT), false);
});

test("wrong platform and preparation failure stop before Keychain inspection", async () => {
  const events = [];
  await assert.rejects(
    executeDisposableRecoveryFieldKeychainPrep(parsed("preview"), {
      ...dependencies(events),
      platform: "win32",
    }),
    cliError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_MACOS_REQUIRED"),
  );
  assert.deepEqual(events, []);

  const preparationEvents = [];
  await assert.rejects(
    executeDisposableRecoveryFieldKeychainPrep(parsed("preview"), {
      ...dependencies(preparationEvents),
      inspectPreparation() { throw new Error("changed"); },
    }),
    cliError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_PREPARATION_FAILED"),
  );
  assert.deepEqual(preparationEvents.map(([name]) => name), ["directory"]);
});

test("main prints one JSON result and sanitized failures", async () => {
  let stdout = "";
  let stderr = "";
  assert.equal(await main(["preview", ...COMMON], {
    ...dependencies(),
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  }), 0);
  assert.equal(JSON.parse(stdout).status, "ready_for_separate_approval");
  assert.equal(stderr, "");

  stdout = "";
  stderr = "";
  assert.equal(await main(["preview", ...COMMON, "--token", "do-not-print"], {
    ...dependencies(),
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += `${value}\n`; },
  }), 1);
  assert.equal(stdout, "");
  assert.match(stderr, /DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLI_OPTION_INVALID/u);
  assert.equal(stderr.includes("do-not-print"), false);
});

test("help states the approval and secret boundaries", () => {
  const text = disposableRecoveryFieldKeychainPrepHelp().join("\n");
  assert.match(text, /approve-k0/u);
  assert.match(text, /confirm-single-operator/u);
  assert.match(text, /--resume/u);
  assert.match(text, /approve-k0-reset/u);
  assert.match(text, /never touches the shared Cloudflare token/u);
  assert.match(text, /makes no writes or provider requests/u);
  assert.match(text, /Never put a token, password, admin key, or recovery value/u);
});
