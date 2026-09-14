import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAdminKeySecretReference } from "../operations/admin-key-persistence.mjs";
import { privateAggregateReceiptPendingPath } from
  "../operations/private-aggregate-receipt.mjs";
import {
  finalizePrivateAggregateReceipt,
  reservePrivateAggregateReceipt,
} from
  "../operations/private-aggregate-receipt.mjs";
import {
  assertDisposableRecoveryFieldKeychainPreparedReceiptCapability,
  assertDisposableRecoveryFieldKeychainVerificationCapability,
  createDisposableRecoveryFieldKeychainPrep,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX,
  DisposableRecoveryFieldKeychainPrepError,
  disposableRecoveryFieldKeychainPrepApprovalFingerprint,
  disposableRecoveryFieldKeychainPreparationFingerprint,
  previewDisposableRecoveryFieldKeychainPrep,
  previewDisposableRecoveryFieldKeychainReset,
  readDisposableRecoveryFieldKeychainPreparedReceipt,
  runDisposableRecoveryFieldKeychainPrep,
  runDisposableRecoveryFieldKeychainReset,
  verifyDisposableRecoveryFieldKeychainPrep,
  verifyDisposableRecoveryFieldKeychainResetJournal,
} from "../operations/disposable-recovery-field-keychain-prep.mjs";

if (process.platform === "win32") {
  test("macOS-only disposable recovery field Keychain preparation suite", {
    skip: "private aggregate receipt DACL proof is intentionally unavailable on Windows",
  }, () => {});
} else {

const HASH = (character) => character.repeat(64);
const ACCOUNT_ID = "a".repeat(32);
const REFERENCES = Object.freeze([
  "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
  "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/bank-wrapping-v2",
]);
const PURPOSES = Object.freeze([
  "source_admin_key",
  "target_admin_key",
  "recovery_artifact_key",
  "bank_access_wrapping_key_v2",
]);
const FORMATS = Object.freeze([
  "lowercase_hex_48",
  "lowercase_hex_48",
  "recovery_artifact_v1",
  "bank_access_wrapping_v2",
]);

function binding(overrides = {}) {
  return {
    candidate_sha: "1".repeat(40),
    candidate_tree_sha: "2".repeat(40),
    package_sha256: HASH("3"),
    field_receipt_sha256: HASH("4"),
    account_id: ACCOUNT_ID,
    ...overrides,
  };
}

function prepError(code) {
  return (error) => error instanceof DisposableRecoveryFieldKeychainPrepError &&
    error.code === code;
}

function reference(locator) {
  return locator?.reference ?? `keychain://${locator?.service}/${locator?.account}`;
}

function fakeKeychain({
  initial = {},
  failWriteAt = -1,
  corruptAndFailAt = -1,
  failDeleteAt = -1,
  deleteThenFailAt = -1,
  corruptReadAt = -1,
} = {}) {
  const state = new Map(REFERENCES.map((item) => [
    item,
    initial[item] === undefined || initial[item] === null
      ? null
      : Buffer.from(initial[item]),
  ]));
  const events = [];
  const writes = [];
  let reads = 0;
  return {
    state,
    events,
    writes,
    adapter: {
      inspect: async (locator) => {
        const item = reference(locator);
        events.push(["inspect", item]);
        assert.ok(state.has(item), "only a fixed locator may be inspected");
        return state.get(item) === null ? "item_not_found" : "present";
      },
      read: async (locator) => {
        const item = reference(locator);
        reads += 1;
        events.push(["read", item]);
        assert.ok(state.has(item), "only a fixed locator may be read");
        if (reads === corruptReadAt) {
          state.get(item)?.fill(0);
          state.set(item, Buffer.from("different-value"));
        }
        return state.get(item) === null ? null : Buffer.from(state.get(item));
      },
      write: async (locator, secret) => {
        const item = reference(locator);
        const index = REFERENCES.indexOf(item);
        events.push(["write", item]);
        assert.ok(index >= 0, "only a fixed locator may be written");
        assert.equal(state.get(item), null, "preexisting values must never be overwritten");
        const copy = Buffer.from(secret);
        writes.push({ item, value: Buffer.from(copy) });
        if (index === corruptAndFailAt) {
          state.set(item, Buffer.from("different-value"));
          copy.fill(0);
          throw new Error("simulated ambiguous corrupt write");
        }
        state.set(item, copy);
        if (index === failWriteAt) throw new Error("simulated write interruption");
        return true;
      },
      delete: async (locator) => {
        const item = reference(locator);
        const index = REFERENCES.indexOf(item);
        events.push(["delete", item]);
        if (index === failDeleteAt) throw new Error("simulated rollback deletion failure");
        state.get(item)?.fill(0);
        state.set(item, null);
        if (index === deleteThenFailAt) {
          throw new Error("simulated ambiguous successful deletion");
        }
        return true;
      },
    },
  };
}

function deterministicRandom({ collideAdmins = false } = {}) {
  const buffers = [];
  let call = 0;
  return {
    buffers,
    randomBytesImpl(length) {
      call += 1;
      const fill = collideAdmins && call <= 2 ? 1 : call;
      const value = Buffer.alloc(length, fill);
      buffers.push(value);
      return value;
    },
  };
}

function workspace() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-keychain-prep-")));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function paths(directory) {
  return {
    receiptPath: join(directory, DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME),
    expectedReceiptDirectory: directory,
  };
}

function runArguments(directory, checkedBinding, keychain, randomSource, overrides = {}) {
  return {
    binding: checkedBinding,
    approvalFingerprint:
      disposableRecoveryFieldKeychainPrepApprovalFingerprint(checkedBinding),
    singleOperatorConfirmed: true,
    ...paths(directory),
    keychain,
    platform: "darwin",
    randomBytesImpl: randomSource.randomBytesImpl,
    revalidate: () => true,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  };
}

function decodedWrites(keychain) {
  return keychain.writes.map(({ value }) => value.toString("utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resetJournalNames(directory) {
  return readdirSync(directory)
    .filter((name) => name.startsWith(
      DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX,
    ))
    .sort();
}

async function preparedResetFixture(directory, keychainOptions = {}) {
  const checkedBinding = binding();
  const keychain = fakeKeychain(keychainOptions);
  await assert.rejects(
    runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      deterministicRandom(),
      {
        onTransition(name) {
          if (name === "before_finalization") throw new Error("simulated death");
        },
      },
    )),
    (error) => error?.code ===
      "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
  );
  const preview = await previewDisposableRecoveryFieldKeychainReset({
    binding: checkedBinding,
    ...paths(directory),
    keychain: keychain.adapter,
    platform: "darwin",
  });
  return { checkedBinding, keychain, preview };
}

function resetRunArguments(directory, fixture, overrides = {}) {
  return {
    binding: fixture.checkedBinding,
    approvalFingerprint: fixture.preview.reset_approval_fingerprint,
    singleOperatorConfirmed: true,
    ...paths(directory),
    keychain: fixture.keychain.adapter,
    platform: "darwin",
    revalidate: () => true,
    now: () => new Date("2026-09-13T12:30:00.000Z"),
    ...overrides,
  };
}

test("preview is macOS-only and binds one strict immutable preparation approval", async () => {
  const checkedBinding = binding();
  const keychain = fakeKeychain();
  await assert.rejects(
    previewDisposableRecoveryFieldKeychainPrep({
      binding: checkedBinding,
      keychain: keychain.adapter,
      platform: "linux",
    }),
    prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_MACOS_REQUIRED"),
  );
  assert.deepEqual(keychain.events, []);

  const preview = await previewDisposableRecoveryFieldKeychainPrep({
    binding: checkedBinding,
    keychain: keychain.adapter,
    platform: "darwin",
  });
  assert.equal(preview.status, "ready_for_separate_approval");
  assert.equal(preview.action, "K0");
  assert.equal(preview.keychain_mutation, false);
  assert.equal(preview.provider_access, false);
  assert.equal(preview.provider_mutation, false);
  assert.equal(preview.k0_approval_fingerprint,
    disposableRecoveryFieldKeychainPrepApprovalFingerprint(checkedBinding));
  assert.equal(preview.binding.preparation_fingerprint,
    disposableRecoveryFieldKeychainPreparationFingerprint(checkedBinding));
  assert.equal("campaign_fingerprint" in preview.binding, false);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.binding), true);
  assert.deepEqual(preview.campaign_items.map((item) => item.purpose), PURPOSES);
  assert.deepEqual(preview.campaign_items.map((item) => item.format), FORMATS);
  assert.deepEqual(preview.campaign_items.map((item) => item.lookup),
    Array(4).fill("item_not_found"));
  assert.deepEqual(preview.campaign_items.map((item) => item.locator_sha256),
    REFERENCES.map((item) => sha256(item)));
  const serialized = JSON.stringify(preview);
  assert.doesNotMatch(serialized, new RegExp(ACCOUNT_ID));
  for (const item of REFERENCES) assert.equal(serialized.includes(item), false);

  for (const invalid of [
    { ...checkedBinding, extra: true },
    { ...checkedBinding, campaign_fingerprint: HASH("5") },
    { ...checkedBinding, account_id: "f".repeat(31) },
    { ...checkedBinding, candidate_sha: "A".repeat(40) },
  ]) {
    assert.throws(
      () => disposableRecoveryFieldKeychainPrepApprovalFingerprint(invalid),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_BINDING_INVALID"),
    );
  }
  for (const changed of [
    binding({ candidate_sha: "6".repeat(40) }),
    binding({ candidate_tree_sha: "7".repeat(40) }),
    binding({ package_sha256: HASH("8") }),
    binding({ field_receipt_sha256: HASH("9") }),
    binding({ account_id: "b".repeat(32) }),
  ]) {
    assert.notEqual(disposableRecoveryFieldKeychainPreparationFingerprint(changed),
      preview.binding.preparation_fingerprint);
    assert.notEqual(disposableRecoveryFieldKeychainPrepApprovalFingerprint(changed),
      preview.k0_approval_fingerprint);
  }
});

test("partial or power-loss state requires a separate reset and is never overwritten", async () => {
  const checkedBinding = binding();
  const keychain = fakeKeychain({
    initial: { [REFERENCES[0]]: "preexisting-value" },
  });
  await assert.rejects(
    previewDisposableRecoveryFieldKeychainPrep({
      binding: checkedBinding,
      keychain: keychain.adapter,
      platform: "darwin",
    }),
    prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED"),
  );
  const directory = workspace();
  try {
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED"),
    );
    assert.equal(keychain.events.some(([event]) => event === "write"), false);
    assert.equal(keychain.state.get(REFERENCES[0]).toString("utf8"), "preexisting-value");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wrong K0 approval or missing single-operator confirmation performs no write", async () => {
  for (const overrides of [
    { approvalFingerprint: HASH("f") },
    { singleOperatorConfirmed: false },
  ]) {
    const directory = workspace();
    try {
      const keychain = fakeKeychain();
      await assert.rejects(
        runDisposableRecoveryFieldKeychainPrep(runArguments(
          directory,
          binding(),
          keychain.adapter,
          deterministicRandom(),
          overrides,
        )),
        (error) => error instanceof DisposableRecoveryFieldKeychainPrepError,
      );
      assert.deepEqual(keychain.events, []);
      assert.equal(existsSync(paths(directory).receiptPath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("execute generates four independent exact formats and writes a private hash-only receipt", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    const randomSource = deterministicRandom();
    let revalidations = 0;
    const result = await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      randomSource,
      { revalidate: () => { revalidations += 1; return true; } },
    ));
    const values = decodedWrites(keychain);
    assert.equal(values.length, 4);
    assert.equal(new Set(values).size, 4);
    assert.match(values[0], /^[a-f0-9]{48}$/u);
    assert.match(values[1], /^[a-f0-9]{48}$/u);
    assert.match(values[2], /^v1\.[A-Za-z0-9_-]{43}$/u);
    assert.match(values[3], /^v2\.[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "write").map(([, item]) => item),
      REFERENCES,
    );
    for (const item of REFERENCES) {
      assert.equal(keychain.events.filter(([event, seen]) =>
        event === "read" && seen === item).length, 3,
      "each value is read after its write, before receipt construction, and after finalization");
    }
    assert.ok(revalidations >= 11,
      "binding must be revalidated around initial state, every write, and finalization");
    for (const randomBuffer of randomSource.buffers) {
      assert.equal(randomBuffer.every((byte) => byte === 0), true,
        "owned random buffers are zeroed after use");
    }
    assert.equal(result.receipt.status, "prepared");
    assert.equal(result.receipt.binding.preparation_fingerprint,
      disposableRecoveryFieldKeychainPreparationFingerprint(checkedBinding));
    assert.equal("campaign_fingerprint" in result.receipt.binding, false);
    assert.deepEqual(result.receipt.campaign_items.map((item) => item.purpose), PURPOSES);
    assert.deepEqual(result.receipt.campaign_items.map((item) => item.format), FORMATS);
    assert.equal(new Set(result.receipt.campaign_items.map((item) =>
      item.value_sha256)).size, 4);
    assert.deepEqual(result.receipt.campaign_items.map((item) => item.value_sha256),
      values.map((value) => sha256(value)));
    assert.equal(result.receipt.independent_values, true);
    assert.equal(result.receipt.provider_access, false);
    assert.equal(result.receipt.provider_mutation, false);
    const serialized = readFileSync(paths(directory).receiptPath, "utf8");
    assert.equal(JSON.stringify(result).includes(ACCOUNT_ID), false);
    assert.doesNotMatch(serialized, new RegExp(ACCOUNT_ID));
    assert.doesNotMatch(serialized, /provider[_ -]?id|worker[_ -]?id/iu);
    for (const item of REFERENCES) assert.equal(serialized.includes(item), false);
    for (const value of values) assert.equal(serialized.includes(value), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin-key collision stops before the first Keychain write", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom({ collideAdmins: true }),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RANDOM_COLLISION"),
    );
    assert.equal(keychain.events.some(([event]) => event === "write"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal caught failure rolls back only exact values created in this run", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain({ failWriteAt: 2 });
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_EXECUTION_FAILED"),
    );
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "delete").map(([, item]) => item),
      [REFERENCES[2], REFERENCES[1], REFERENCES[0]],
    );
    for (const item of REFERENCES) assert.equal(keychain.state.get(item), null);
    assert.equal(existsSync(paths(directory).receiptPath), true,
      "the exact durable start marker precedes every Keychain write");
    assert.equal(
      existsSync(privateAggregateReceiptPendingPath(paths(directory).receiptPath)),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unprovable rollback leaves a clear stop-ship and never deletes the unknown value", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain({ corruptAndFailAt: 2 });
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ROLLBACK_UNPROVEN"),
    );
    assert.notEqual(keychain.state.get(REFERENCES[2]), null);
    assert.equal(
      keychain.events.some(([event, item]) => event === "delete" && item === REFERENCES[2]),
      false,
    );
    assert.equal(keychain.state.get(REFERENCES[0]), null);
    assert.equal(keychain.state.get(REFERENCES[1]), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-write revalidation failure rolls back the exact created value", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain();
    let boundaries = 0;
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom(),
        { revalidate: () => { boundaries += 1; return boundaries !== 6; } },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_EVIDENCE_CHANGED"),
    );
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "write").map(([, item]) => item),
      [REFERENCES[0]],
    );
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "delete").map(([, item]) => item),
      [REFERENCES[0]],
    );
    for (const item of REFERENCES) assert.equal(keychain.state.get(item), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reservation drift after a write is detected and the exact value is rolled back", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain();
    let boundaries = 0;
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom(),
        {
          revalidate() {
            boundaries += 1;
            if (boundaries === 6) {
              writeFileSync(paths(directory).receiptPath, "{}\n", { mode: 0o600 });
            }
            return true;
          },
        },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_CHANGED"),
    );
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "write").map(([, item]) => item),
      [REFERENCES[0]],
    );
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "delete").map(([, item]) => item),
      [REFERENCES[0]],
    );
    for (const item of REFERENCES) assert.equal(keychain.state.get(item), null);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid completion clock rolls back all exact created values and leaves review markers", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom(),
        { now: () => new Date(Number.NaN) },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_CLOCK_INVALID"),
    );
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "delete").map(([, item]) => item),
      [...REFERENCES].reverse(),
    );
    for (const item of REFERENCES) assert.equal(keychain.state.get(item), null);
    assert.equal(existsSync(paths(directory).receiptPath), true);
    assert.equal(existsSync(
      privateAggregateReceiptPendingPath(paths(directory).receiptPath)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("process death at every mutation boundary leaves a durable marker and reentry fail-closed", async () => {
  const transitions = [
    "pending_reserved",
    ...PURPOSES.flatMap((purpose) => [
      `before_write:${purpose}`,
      `after_write:${purpose}`,
    ]),
    "before_finalization",
    "after_finalization",
  ];
  for (const target of transitions) {
    const directory = workspace();
    try {
      const checkedBinding = binding();
      const keychain = fakeKeychain();
      await assert.rejects(
        runDisposableRecoveryFieldKeychainPrep(runArguments(
          directory,
          checkedBinding,
          keychain.adapter,
          deterministicRandom(),
          {
            onTransition(name) {
              if (name === target) throw new Error("simulated process death");
            },
          },
        )),
        (error) => error?.code ===
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
        target,
      );

      const purpose = target.split(":", 2)[1];
      const purposeIndex = purpose ? PURPOSES.indexOf(purpose) : -1;
      const expectedWrites = target.startsWith("before_write:")
        ? purposeIndex
        : target.startsWith("after_write:")
          ? purposeIndex + 1
          : target === "pending_reserved" ? 0 : 4;
      assert.equal(keychain.writes.length, expectedWrites, target);
      assert.equal(
        keychain.events.some(([event]) => event === "delete"),
        false,
        target,
      );

      const finalPath = paths(directory).receiptPath;
      const pendingPath = privateAggregateReceiptPendingPath(finalPath);
      const finalized = target === "after_finalization";
      assert.equal(existsSync(finalPath), true, target);
      assert.equal(existsSync(pendingPath), !finalized, target);
      if (!finalized) {
        const marker = JSON.parse(readFileSync(finalPath, "utf8"));
        assert.equal(marker.kind,
          "v048_disposable_recovery_field_keychain_prep_pending");
        assert.equal(marker.binding.preparation_fingerprint,
          disposableRecoveryFieldKeychainPreparationFingerprint(checkedBinding));
        assert.deepEqual(
          marker.campaign_keychain_value_sha256.map((value) =>
            /^[a-f0-9]{64}$/u.test(value)),
          Array(4).fill(true),
        );
        assert.equal(new Set(marker.campaign_keychain_value_sha256).size, 4);
        for (let index = 0; index < expectedWrites; index += 1) {
          assert.equal(marker.campaign_keychain_value_sha256[index],
            sha256(keychain.writes[index].value));
        }
        const markerText = JSON.stringify(marker);
        assert.equal(markerText.includes(ACCOUNT_ID), false);
        assert.equal(markerText.includes("campaign_fingerprint"), false);
        for (const locator of REFERENCES) assert.equal(markerText.includes(locator), false);
        for (const value of decodedWrites(keychain)) {
          assert.equal(markerText.includes(value), false);
        }
      }

      const mutationsBefore = keychain.events.filter(([event]) =>
        event === "write" || event === "delete").length;
      if (finalized) {
        const reused = await runDisposableRecoveryFieldKeychainPrep(runArguments(
          directory,
          checkedBinding,
          keychain.adapter,
          { randomBytesImpl: () => { throw new Error("must not regenerate"); } },
        ));
        assert.equal(reused.receipt.status, "prepared");
      } else {
        const eventsBefore = keychain.events.length;
        await assert.rejects(
          runDisposableRecoveryFieldKeychainPrep(runArguments(
            directory,
            checkedBinding,
            keychain.adapter,
            deterministicRandom(),
          )),
          prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESUME_REQUIRED"),
          target,
        );
        assert.equal(keychain.events.length, eventsBefore,
          "pending-marker reentry must not inspect or mutate Keychain");
      }
      assert.equal(keychain.events.filter(([event]) =>
        event === "write" || event === "delete").length, mutationsBefore, target);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("an exact all-written interruption resumes without regenerating or rewriting values", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        {
          onTransition(name) {
            if (name === "before_finalization") throw new Error("simulated death");
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const writesBefore = keychain.writes.length;
    const result = await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      { randomBytesImpl: () => { throw new Error("must not regenerate"); } },
      { resume: true },
    ));
    assert.equal(result.receipt.status, "prepared");
    assert.equal(keychain.writes.length, writesBefore);
    assert.equal(keychain.events.some(([event]) => event === "delete"), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a partial-write interruption cannot use full resume and performs no new mutation", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        {
          onTransition(name) {
            if (name === `after_write:${PURPOSES[0]}`) throw new Error("simulated death");
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const mutationsBefore = keychain.events.filter(([event]) =>
      event === "write" || event === "delete").length;
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        { resume: true },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESET_REQUIRED"),
    );
    assert.equal(keychain.events.filter(([event]) =>
      event === "write" || event === "delete").length, mutationsBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finalization commitment crashes recover exact receipt without rolling back keys", async () => {
  for (const crash of ["before_rename", "after_final_sync"]) {
    const directory = workspace();
    try {
      const checkedBinding = binding();
      const keychain = fakeKeychain();
      await assert.rejects(
        runDisposableRecoveryFieldKeychainPrep(runArguments(
          directory,
          checkedBinding,
          keychain.adapter,
          deterministicRandom(),
          {
            finalizeReceipt(reservation, receipt) {
              return finalizePrivateAggregateReceipt(reservation, receipt,
                crash === "before_rename"
                  ? { rename: () => { throw new Error("simulated death"); } }
                  : { removePending: () => { throw new Error("simulated death"); } });
            },
          },
        )),
        prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_FINALIZATION_FAILED"),
        crash,
      );
      assert.equal(keychain.events.some(([event]) => event === "delete"), false, crash);
      const writesBefore = keychain.writes.length;
      const recovered = await runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        { randomBytesImpl: () => { throw new Error("must not regenerate"); } },
        { resume: true },
      ));
      assert.equal(recovered.receipt.status, "prepared", crash);
      assert.equal(keychain.writes.length, writesBefore, crash);
      assert.equal(keychain.events.some(([event]) => event === "delete"), false, crash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("partial K0 reset preview binds exact current states and refuses a replaced value", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        {
          onTransition(name) {
            if (name === `after_write:${PURPOSES[1]}`) throw new Error("simulated death");
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const preview = await previewDisposableRecoveryFieldKeychainReset({
      binding: checkedBinding,
      ...paths(directory),
      keychain: keychain.adapter,
      platform: "darwin",
    });
    assert.equal(preview.status, "ready_for_separate_approval");
    assert.deepEqual(preview.campaign_items.map((item) => item.lookup), [
      "present", "present", "item_not_found", "item_not_found",
    ]);
    assert.match(preview.reset_approval_fingerprint, /^[a-f0-9]{64}$/u);
    assert.match(preview.reset_receipt_name, new RegExp(
      `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}[a-f0-9]{64}\\.json$`,
      "u",
    ));
    assert.equal(preview.provider_access, false);
    assert.equal(preview.shared_cloudflare_token_touched, false);
    assert.equal(JSON.stringify(preview).includes(ACCOUNT_ID), false);

    keychain.state.get(REFERENCES[0]).fill(0);
    keychain.state.set(REFERENCES[0], Buffer.from("f".repeat(48)));
    const mutationsBefore = keychain.events.filter(([event]) =>
      event === "write" || event === "delete").length;
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        approvalFingerprint: preview.reset_approval_fingerprint,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_ARGUMENTS_INVALID"),
    );
    await assert.rejects(
      previewDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_VALUE_CHANGED"),
    );
    assert.equal(keychain.events.filter(([event]) =>
      event === "write" || event === "delete").length, mutationsBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact-approved partial K0 reset deletes only matching campaign values and retains proof", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        {
          onTransition(name) {
            if (name === `after_write:${PURPOSES[1]}`) throw new Error("simulated death");
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const preview = await previewDisposableRecoveryFieldKeychainReset({
      binding: checkedBinding,
      ...paths(directory),
      keychain: keychain.adapter,
      platform: "darwin",
    });
    const mutationsBefore = keychain.events.filter(([event]) =>
      event === "write" || event === "delete").length;
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        singleOperatorConfirmed: true,
        approvalFingerprint: HASH("f"),
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_APPROVAL_INVALID"),
    );
    assert.equal(keychain.events.filter(([event]) =>
      event === "write" || event === "delete").length, mutationsBefore);

    const result = await runDisposableRecoveryFieldKeychainReset({
      binding: checkedBinding,
      singleOperatorConfirmed: true,
      approvalFingerprint: preview.reset_approval_fingerprint,
      ...paths(directory),
      keychain: keychain.adapter,
      platform: "darwin",
      revalidate: () => true,
      now: () => new Date("2026-09-13T12:30:00.000Z"),
    });
    assert.equal(result.status, "reset_complete");
    assert.equal(result.campaignItemsAbsent, 4);
    assert.deepEqual(
      keychain.events.filter(([event]) => event === "delete").map(([, item]) => item),
      REFERENCES.slice(0, 2),
    );
    for (const item of REFERENCES) assert.equal(keychain.state.get(item), null);
    assert.equal(existsSync(paths(directory).receiptPath), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), false);
    const resetPath = join(directory, preview.reset_receipt_name);
    assert.equal(existsSync(resetPath), true);
    const resetText = readFileSync(resetPath, "utf8");
    assert.equal(resetText.includes(ACCOUNT_ID), false);
    for (const locator of REFERENCES) assert.equal(resetText.includes(locator), false);
    for (const { value } of keychain.writes) {
      assert.equal(resetText.includes(value.toString("utf8")), false);
    }
    const journalNames = resetJournalNames(directory);
    assert.equal(journalNames.length, 7);
    assert.equal(journalNames.every((name, index) => new RegExp(
      `^${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
        `[a-f0-9]{64}-${String(index).padStart(2, "0")}-` +
        `(planned|sent-unconfirmed|confirmed|reconciled|complete)\\.json$`,
      "u",
    ).test(name)), true);
    for (const name of journalNames) {
      const text = readFileSync(join(directory, name), "utf8");
      assert.equal(text.includes(ACCOUNT_ID), false);
      for (const locator of REFERENCES) assert.equal(text.includes(locator), false);
      for (const { value } of keychain.writes) {
        assert.equal(text.includes(value.toString("utf8")), false);
      }
    }
    const journalProof = verifyDisposableRecoveryFieldKeychainResetJournal({
      binding: checkedBinding,
      resetReceiptPath: resetPath,
      expectedReceiptDirectory: directory,
    });
    assert.equal(journalProof.status, "complete");
    assert.equal(journalProof.event_count, journalNames.length);
    assert.equal(journalProof.event_count <=
      DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS, true);
    assert.equal(journalProof.total_bytes <=
      DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_TOTAL_BYTES, true);
    assert.equal(journalProof.event_receipt_sha256.length, journalNames.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial K0 reset resumes after deletion and marker-cleanup crash boundaries", async () => {
  for (const crashAt of [
    ...PURPOSES.flatMap((purpose) => [
      `before_reset_delete:${purpose}`,
      `after_reset_delete:${purpose}`,
    ]),
    "reset_final_marker_removed",
    "reset_pending_marker_removed",
  ]) {
    const directory = workspace();
    try {
      const checkedBinding = binding();
      const keychain = fakeKeychain();
      await assert.rejects(
        runDisposableRecoveryFieldKeychainPrep(runArguments(
          directory,
          checkedBinding,
          keychain.adapter,
          deterministicRandom(),
          {
            onTransition(name) {
              if (name === "before_finalization") throw new Error("simulated death");
            },
          },
        )),
        (error) => error?.code ===
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
      );
      const preview = await previewDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
      });
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset({
          binding: checkedBinding,
          singleOperatorConfirmed: true,
          approvalFingerprint: preview.reset_approval_fingerprint,
          ...paths(directory),
          keychain: keychain.adapter,
          platform: "darwin",
          onTransition(name) {
            if (name === crashAt) throw new Error("simulated reset death");
          },
        }),
        crashAt.includes("reset_delete:")
          ? (error) => error?.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH"
          : (error) => error?.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RESERVATION_INVALID",
        crashAt,
      );
      const writesBefore = keychain.writes.length;
      const resumed = await runDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        singleOperatorConfirmed: true,
        approvalFingerprint: preview.reset_approval_fingerprint,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
        resume: true,
      });
      assert.equal(resumed.status, "reset_complete", crashAt);
      assert.equal(keychain.writes.length, writesBefore, crashAt);
      for (const item of REFERENCES) assert.equal(keychain.state.get(item), null, crashAt);
      for (const item of REFERENCES) {
        assert.equal(
          keychain.events.filter(([event, locator]) =>
            event === "delete" && locator === item).length,
          1,
          `${crashAt}: ${item} must be deleted exactly once`,
        );
      }
      assert.equal(existsSync(paths(directory).receiptPath), false, crashAt);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("K0 reset refuses completion when a deleted value reappears during final marker cleanup", async () => {
  for (const recreateAt of [
    "reset_final_marker_removed",
    "reset_pending_marker_removed",
    "final_revalidate",
  ]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory);
      const original = Buffer.from(fixture.keychain.state.get(REFERENCES[0]));
      let markerCleanupFinished = false;
      let recreated = false;
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          {
            onTransition(name) {
              if (name === "reset_pending_marker_removed") {
                markerCleanupFinished = true;
              }
              if (name === recreateAt) {
                fixture.keychain.state.set(REFERENCES[0], Buffer.from(original));
                recreated = true;
              }
            },
            revalidate: () => {
              if (recreateAt === "final_revalidate" && markerCleanupFinished &&
                  !recreated) {
                fixture.keychain.state.set(REFERENCES[0], Buffer.from(original));
                recreated = true;
              }
              return true;
            },
          },
        )),
        prepError(
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETED_VALUE_REAPPEARED",
        ),
        recreateAt,
      );
      original.fill(0);
      assert.equal(recreated, true, recreateAt);
      assert.notEqual(fixture.keychain.state.get(REFERENCES[0]), null, recreateAt);
      assert.equal(
        fixture.keychain.events.filter(([event, item]) =>
          event === "delete" && item === REFERENCES[0]).length,
        1,
        recreateAt,
      );
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          { resume: true },
        )),
        prepError(
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETED_VALUE_REAPPEARED",
        ),
        `${recreateAt}: retained authorization and journal must block a retry`,
      );
      assert.equal(
        fixture.keychain.events.filter(([event, item]) =>
          event === "delete" && item === REFERENCES[0]).length,
        1,
        `${recreateAt}: reentry must perform zero new deletes`,
      );
      assert.equal(existsSync(paths(directory).receiptPath), false, recreateAt);
      assert.equal(
        existsSync(join(directory, fixture.preview.reset_receipt_name)),
        true,
        recreateAt,
      );
      assert.equal(resetJournalNames(directory).length > 0, true, recreateAt);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("K0_RESET never retries an ambiguous delete and reconciles only proven absence", async () => {
  for (const deletionOutcome of ["present", "absent"]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory, deletionOutcome === "present"
        ? { failDeleteAt: 0 }
        : { deleteThenFailAt: 0 });
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(directory, fixture)),
        prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS"),
      );
      assert.equal(fixture.keychain.events.filter(([event, locator]) =>
        event === "delete" && locator === REFERENCES[0]).length, 1);
      const journalBefore = resetJournalNames(directory);
      assert.equal(journalBefore.some((name) => name.endsWith(
        "-01-sent-unconfirmed.json",
      )), true);
      assert.equal(existsSync(paths(directory).receiptPath), true);
      assert.equal(existsSync(privateAggregateReceiptPendingPath(
        paths(directory).receiptPath)), true);

      if (deletionOutcome === "present") {
        await assert.rejects(
          runDisposableRecoveryFieldKeychainReset(resetRunArguments(
            directory,
            fixture,
            { resume: true },
          )),
          prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS"),
        );
        assert.equal(fixture.keychain.events.filter(([event, locator]) =>
          event === "delete" && locator === REFERENCES[0]).length, 1,
        "an ambiguous present value must never be retried");
        assert.deepEqual(resetJournalNames(directory), journalBefore);
        assert.equal(existsSync(paths(directory).receiptPath), true);
      } else {
        const resumed = await runDisposableRecoveryFieldKeychainReset(
          resetRunArguments(directory, fixture, { resume: true }),
        );
        assert.equal(resumed.status, "reset_complete");
        assert.equal(fixture.keychain.events.filter(([event, locator]) =>
          event === "delete" && locator === REFERENCES[0]).length, 1,
        "an ambiguous successful delete must reconcile without retry");
        assert.equal(resetJournalNames(directory).some((name) => name.endsWith(
          "-02-reconciled.json",
        )), true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("sent_unconfirmed and terminal journal states reject recreated values with zero new deletes", async () => {
  for (const terminalState of ["sent_unconfirmed", "confirmed", "reconciled"]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory);
      const original = Buffer.from(fixture.keychain.state.get(REFERENCES[0]));
      if (terminalState === "sent_unconfirmed") {
        await assert.rejects(
          runDisposableRecoveryFieldKeychainReset(resetRunArguments(
            directory,
            fixture,
            {
              onTransition(name) {
                if (name === "after_reset_journal:1:sent_unconfirmed") {
                  throw new Error("simulated death after sent intent");
                }
              },
            },
          )),
          (error) => error?.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
        );
      } else if (terminalState === "confirmed") {
        await assert.rejects(
          runDisposableRecoveryFieldKeychainReset(resetRunArguments(
            directory,
            fixture,
            {
              onTransition(name) {
                if (name === "after_reset_journal:2:confirmed") {
                  throw new Error("simulated death after confirmation");
                }
              },
            },
          )),
          (error) => error?.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
        );
      } else {
        await assert.rejects(
          runDisposableRecoveryFieldKeychainReset(resetRunArguments(
            directory,
            fixture,
            {
              onTransition(name) {
                if (name === `after_reset_delete:${PURPOSES[0]}`) {
                  throw new Error("simulated death after delete");
                }
              },
            },
          )),
          (error) => error?.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
        );
        await assert.rejects(
          runDisposableRecoveryFieldKeychainReset(resetRunArguments(
            directory,
            fixture,
            {
              resume: true,
              onTransition(name) {
                if (name === "after_reset_journal:2:reconciled") {
                  throw new Error("simulated death after reconciliation");
                }
              },
            },
          )),
          (error) => error?.code ===
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
        );
      }

      fixture.keychain.state.get(REFERENCES[0])?.fill(0);
      fixture.keychain.state.set(REFERENCES[0], Buffer.from(original));
      original.fill(0);
      const deletesBefore = fixture.keychain.events.filter(([event]) =>
        event === "delete").length;
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          { resume: true },
        )),
        terminalState === "sent_unconfirmed"
          ? prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS")
          : prepError(
            "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETED_VALUE_REAPPEARED",
          ),
      );
      assert.equal(fixture.keychain.events.filter(([event]) =>
        event === "delete").length, deletesBefore);
      assert.equal(existsSync(paths(directory).receiptPath), true);
      assert.equal(existsSync(privateAggregateReceiptPendingPath(
        paths(directory).receiptPath)), true);
      assert.equal(resetJournalNames(directory).length >= 2, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("K0_RESET journal power cuts never duplicate a deletion", async () => {
  for (const crashAt of [
    "before_reset_journal:0:planned",
    "after_reset_journal:0:planned",
    "before_reset_journal:1:sent_unconfirmed",
    "before_reset_journal:2:confirmed",
    "after_reset_journal:2:confirmed",
    "before_reset_journal:12:complete",
    "after_reset_journal:12:complete",
  ]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory);
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          {
            onTransition(name) {
              if (name === crashAt) throw new Error("simulated journal power cut");
            },
          },
        )),
        (error) => error?.code ===
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
        crashAt,
      );
      const resumed = await runDisposableRecoveryFieldKeychainReset(
        resetRunArguments(directory, fixture, { resume: true }),
      );
      assert.equal(resumed.status, "reset_complete", crashAt);
      for (const reference of REFERENCES) {
        assert.equal(fixture.keychain.events.filter(([event, locator]) =>
          event === "delete" && locator === reference).length, 1, crashAt);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("K0_RESET journal write and fsync failures happen before Keychain deletion", async () => {
  for (const failure of ["write", "sync"]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory);
      let injected = false;
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          {
            finalizeJournalReceipt(reservation, receipt) {
              if (receipt.state !== "sent_unconfirmed" || injected) {
                return finalizePrivateAggregateReceipt(reservation, receipt);
              }
              injected = true;
              return finalizePrivateAggregateReceipt(reservation, receipt, failure === "write"
                ? { writeBytes: () => { throw new Error("journal write failed"); } }
                : { syncFile: () => { throw new Error("journal sync failed"); } });
            },
          },
        )),
      );
      assert.equal(fixture.keychain.events.some(([event]) => event === "delete"), false);
      assert.equal(existsSync(paths(directory).receiptPath), true);
      assert.equal(resetJournalNames(directory).some((name) =>
        name.includes("-01-sent-unconfirmed")), true);
      assert.equal(resetJournalNames(directory).some((name) =>
        name.endsWith("-01-sent-unconfirmed.staged.json")), true,
      "the deterministic staging guard must remain visible before recovery");

      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          { resume: true },
        )),
        prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_DELETE_AMBIGUOUS"),
      );
      assert.equal(fixture.keychain.events.some(([event]) => event === "delete"), false,
        "a recovered sent intent must not authorize a retry");
      assert.equal(resetJournalNames(directory).some((name) =>
        name.endsWith("-01-sent-unconfirmed.json")), true,
      "the sent-intent guard must remain after the ambiguous-delete refusal");
      if (failure === "write") {
        assert.equal(resetJournalNames(directory).some((name) =>
          name.endsWith("-01-sent-unconfirmed.staged.json")), true,
        "an invalid partial staged receipt must remain available for manual review");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("the last reset boundary rejects post-sent journal removal, truncation, substitution, and ACL drift", async () => {
  for (const mutation of ["remove", "truncate", "substitute", "acl"]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory);
      let mutated = false;
      const mutateJournal = () => {
        const name = resetJournalNames(directory).find((entry) =>
          entry.endsWith("-01-sent-unconfirmed.json"));
        if (!name) return;
        const path = join(directory, name);
        if (mutation === "remove") rmSync(path, { force: true });
        else if (mutation === "truncate") writeFileSync(path, "", { mode: 0o600 });
        else if (mutation === "substitute") {
          const value = JSON.parse(readFileSync(path, "utf8"));
          value.raw_secret = "must never be accepted";
          writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        } else chmodSync(path, 0o644);
        mutated = true;
      };
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          mutation === "substitute"
            ? {
              revalidate() {
                if (!mutated) mutateJournal();
                return true;
              },
            }
            : {
              onTransition(name) {
                if (name === "after_reset_journal:1:sent_unconfirmed" && !mutated) {
                  mutateJournal();
                }
              },
            },
        )),
      );
      assert.equal(mutated, true, mutation);
      assert.equal(fixture.keychain.events.some(([event]) => event === "delete"), false,
        mutation);
      assert.equal(existsSync(paths(directory).receiptPath), true, mutation);
      assert.equal(existsSync(privateAggregateReceiptPendingPath(
        paths(directory).receiptPath)), true, mutation);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("reset authorization cannot be transplanted under another valid receipt suffix", async () => {
  const directory = workspace();
  try {
    const fixture = await preparedResetFixture(directory);
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset(resetRunArguments(
        directory,
        fixture,
        {
          onTransition(name) {
            if (name === "before_reset_journal:0:planned") {
              throw new Error("stop after authorization");
            }
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const exactPath = join(directory, fixture.preview.reset_receipt_name);
    const substitutedPath = join(
      directory,
      `${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_PREFIX}${HASH("b")}.json`,
    );
    const bytes = readFileSync(exactPath);
    writeFileSync(substitutedPath, bytes, { mode: 0o600 });
    bytes.fill(0);
    rmSync(exactPath);
    const deletesBefore = fixture.keychain.events.filter(([event]) =>
      event === "delete").length;
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset(resetRunArguments(
        directory,
        fixture,
        { resume: true },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID"),
    );
    await assert.rejects(
      Promise.resolve().then(() => verifyDisposableRecoveryFieldKeychainResetJournal({
        binding: fixture.checkedBinding,
        resetReceiptPath: substitutedPath,
        expectedReceiptDirectory: directory,
      })),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID"),
    );
    assert.equal(fixture.keychain.events.filter(([event]) =>
      event === "delete").length, deletesBefore);
    assert.equal(existsSync(paths(directory).receiptPath), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline reset-journal verification enforces exact event and aggregate caps", async () => {
  for (const boundary of ["event_count", "event_bytes", "aggregate_bytes"]) {
    const directory = workspace();
    try {
      const fixture = await preparedResetFixture(directory);
      await runDisposableRecoveryFieldKeychainReset(resetRunArguments(directory, fixture));
      const resetReceiptPath = join(directory, fixture.preview.reset_receipt_name);
      const names = resetJournalNames(directory);
      assert.equal(names.length,
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENTS);
      if (boundary === "event_count") {
        writeFileSync(
          join(
            directory,
            `${DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_PREFIX}` +
              `${fixture.preview.reservation_marker_sha256}-13-planned.json`,
          ),
          "{}\n",
          { mode: 0o600 },
        );
      } else if (boundary === "event_bytes") {
        writeFileSync(
          join(directory, names[0]),
          Buffer.alloc(
            DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES + 1,
            0x20,
          ),
          { mode: 0o600 },
        );
      } else {
        let previous = null;
        for (const name of names) {
          const path = join(directory, name);
          const value = JSON.parse(readFileSync(path, "utf8"));
          value.previous_event_sha256 = previous;
          const raw = Buffer.concat([
            Buffer.alloc(42_000, 0x20),
            Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
          ]);
          assert.equal(raw.length <
            DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_MAX_EVENT_BYTES, true);
          writeFileSync(path, raw, { mode: 0o600 });
          previous = sha256(raw);
          raw.fill(0);
        }
      }
      assert.throws(
        () => verifyDisposableRecoveryFieldKeychainResetJournal({
          binding: fixture.checkedBinding,
          resetReceiptPath,
          expectedReceiptDirectory: directory,
        }),
        prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_JOURNAL_INVALID"),
        boundary,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("reset resume refuses a non-private receipt directory before any deletion", async () => {
  const directory = workspace();
  try {
    const fixture = await preparedResetFixture(directory);
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset(resetRunArguments(
        directory,
        fixture,
        {
          onTransition(name) {
            if (name === "after_reset_journal:1:sent_unconfirmed") {
              throw new Error("simulated death");
            }
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const deletesBefore = fixture.keychain.events.filter(([event]) =>
      event === "delete").length;
    chmodSync(directory, 0o755);
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset(resetRunArguments(
        directory,
        fixture,
        { resume: true },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PATH_INVALID"),
    );
    assert.equal(fixture.keychain.events.filter(([event]) =>
      event === "delete").length, deletesBefore);
    chmodSync(directory, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same-path receipt-directory inode replacement is refused at reset authorization and journal boundaries", async () => {
  for (const boundary of ["authorization", "journal"]) {
    const directory = workspace();
    const originalDirectory = `${directory}-original`;
    try {
      const fixture = await preparedResetFixture(directory);
      let replaced = false;
      const replaceDirectory = () => {
        if (replaced) return;
        renameSync(directory, originalDirectory);
        mkdirSync(directory, { mode: 0o700 });
        for (const name of readdirSync(originalDirectory)) {
          const source = join(originalDirectory, name);
          const destination = join(directory, name);
          copyFileSync(source, destination);
          chmodSync(destination, 0o600);
        }
        replaced = true;
      };
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetRunArguments(
          directory,
          fixture,
          {
            onTransition(name) {
              if (boundary === "authorization" &&
                  name === "reset_authorization_finalized") {
                replaceDirectory();
              }
              if (boundary === "journal" &&
                  name === "after_reset_journal:1:sent_unconfirmed") {
                replaceDirectory();
              }
            },
          },
        )),
      );
      assert.equal(replaced, true, boundary);
      assert.equal(fixture.keychain.events.some(([event]) => event === "delete"), false,
        boundary);
      assert.equal(existsSync(paths(directory).receiptPath), true, boundary);
      assert.equal(existsSync(join(
        originalDirectory,
        DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
      )), true, boundary);
    } finally {
      if (existsSync(directory)) chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
      rmSync(originalDirectory, { recursive: true, force: true });
    }
  }
});

test("K0 exactly cancels pending-only reservation power loss without touching Keychain", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        {
          reserveReceipt(output, marker) {
            return reservePrivateAggregateReceipt(output, marker, {
              onTransition(name) {
                if (name === "pending_marker_durable") {
                  throw new Error("simulated reservation power loss");
                }
              },
            });
          },
        },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RESERVATION_FAILED"),
    );
    assert.equal(existsSync(paths(directory).receiptPath), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), true);
    assert.equal(keychain.events.some(([event]) => event === "write"), false);
    assert.equal(keychain.events.some(([event]) => event === "delete"), false);

    const preview = await previewDisposableRecoveryFieldKeychainReset({
      binding: checkedBinding,
      ...paths(directory),
      keychain: keychain.adapter,
      platform: "darwin",
    });
    assert.equal(preview.campaign_items.every((item) =>
      item.lookup === "item_not_found"), true);
    const reset = await runDisposableRecoveryFieldKeychainReset({
      binding: checkedBinding,
      approvalFingerprint: preview.reset_approval_fingerprint,
      singleOperatorConfirmed: true,
      ...paths(directory),
      keychain: keychain.adapter,
      platform: "darwin",
    });
    assert.equal(reset.status, "reset_complete");
    assert.equal(keychain.events.some(([event]) => event === "delete"), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reset re-hashes the exact locator after approval and immediately before delete", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
        {
          onTransition(name) {
            if (name === `after_write:${PURPOSES[0]}`) throw new Error("simulated death");
          },
        },
      )),
      (error) => error?.code ===
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
    );
    const preview = await previewDisposableRecoveryFieldKeychainReset({
      binding: checkedBinding,
      ...paths(directory),
      keychain: keychain.adapter,
      platform: "darwin",
    });
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        approvalFingerprint: preview.reset_approval_fingerprint,
        singleOperatorConfirmed: true,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
        onTransition(name) {
          if (name === `before_reset_delete:${PURPOSES[0]}`) {
            keychain.state.get(REFERENCES[0]).fill(0);
            keychain.state.set(REFERENCES[0], Buffer.from("f".repeat(48)));
          }
        },
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_VALUE_CHANGED"),
    );
    assert.equal(
      keychain.events.some(([event, item]) => event === "delete" && item === REFERENCES[0]),
      false,
    );
    assert.equal(keychain.state.get(REFERENCES[0]).toString("utf8"), "f".repeat(48));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reset authorization resumes across every reservation and commit boundary", async () => {
  for (const crashAt of [
    "authorization_reserved",
    "before_rename",
    "after_final_sync",
    "authorization_finalized",
  ]) {
    const directory = workspace();
    try {
      const checkedBinding = binding();
      const keychain = fakeKeychain();
      await assert.rejects(
        runDisposableRecoveryFieldKeychainPrep(runArguments(
          directory,
          checkedBinding,
          keychain.adapter,
          deterministicRandom(),
          {
            onTransition(name) {
              if (name === `after_write:${PURPOSES[0]}`) throw new Error("simulated death");
            },
          },
        )),
        (error) => error?.code ===
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH",
      );
      const preview = await previewDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
      });
      const resetArguments = {
        binding: checkedBinding,
        approvalFingerprint: preview.reset_approval_fingerprint,
        singleOperatorConfirmed: true,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
        ...(crashAt === "before_rename" ? {
          finalizeReceipt: (reservation, receipt) =>
            finalizePrivateAggregateReceipt(reservation, receipt, {
              rename: () => { throw new Error("simulated death"); },
            }),
        } : {}),
        ...(crashAt === "after_final_sync" ? {
          finalizeReceipt: (reservation, receipt) =>
            finalizePrivateAggregateReceipt(reservation, receipt, {
              removePending: () => { throw new Error("simulated death"); },
            }),
        } : {}),
        ...(["authorization_reserved", "authorization_finalized"].includes(crashAt) ? {
          onTransition(name) {
            if (name === `reset_${crashAt}`) throw new Error("simulated death");
          },
        } : {}),
      };
      await assert.rejects(
        runDisposableRecoveryFieldKeychainReset(resetArguments),
        (error) => crashAt.startsWith("authorization_")
          ? error?.code === "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_INJECTED_PROCESS_DEATH"
          : /simulated death/u.test(String(error?.message || "")),
        crashAt,
      );
      assert.equal(keychain.events.some(([event]) => event === "delete"), false, crashAt);
      const resumed = await runDisposableRecoveryFieldKeychainReset({
        binding: checkedBinding,
        approvalFingerprint: preview.reset_approval_fingerprint,
        singleOperatorConfirmed: true,
        ...paths(directory),
        keychain: keychain.adapter,
        platform: "darwin",
        resume: true,
      });
      assert.equal(resumed.status, "reset_complete", crashAt);
      assert.deepEqual(
        keychain.events.filter(([event]) => event === "delete").map(([, item]) => item),
        [REFERENCES[0]],
        crashAt,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("pending-only reset authorization is cancelled without deletion and requires a fresh run", async () => {
  const directory = workspace();
  try {
    const fixture = await preparedResetFixture(directory);
    const resetPath = join(directory, fixture.preview.reset_receipt_name);
    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset(resetRunArguments(
        directory,
        fixture,
        {
          reserveReceipt(output, marker) {
            return reservePrivateAggregateReceipt(output, marker, {
              onTransition(name) {
                if (name === "pending_marker_durable") {
                  throw new Error("simulated reset authorization power loss");
                }
              },
            });
          },
        },
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_RECEIPT_INVALID"),
    );
    assert.equal(existsSync(resetPath), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(resetPath)), true);
    assert.equal(
      fixture.keychain.events.some(([event]) => event === "delete"),
      false,
    );

    await assert.rejects(
      runDisposableRecoveryFieldKeychainReset(resetRunArguments(
        directory,
        fixture,
        { resume: true },
      )),
      prepError(
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_RESET_AUTHORIZATION_RESTART_REQUIRED",
      ),
    );
    assert.equal(existsSync(resetPath), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(resetPath)), false);
    assert.equal(
      fixture.keychain.events.some(([event]) => event === "delete"),
      false,
    );

    const freshPreview = await previewDisposableRecoveryFieldKeychainReset({
      binding: fixture.checkedBinding,
      ...paths(directory),
      keychain: fixture.keychain.adapter,
      platform: "darwin",
    });
    const completed = await runDisposableRecoveryFieldKeychainReset({
      ...resetRunArguments(directory, fixture),
      approvalFingerprint: freshPreview.reset_approval_fingerprint,
    });
    assert.equal(completed.status, "reset_complete");
    assert.deepEqual(
      fixture.keychain.events.filter(([event]) => event === "delete")
        .map(([, item]) => item),
      REFERENCES,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("full pre-receipt readback catches earlier-key drift and refuses unsafe rollback", async () => {
  const directory = workspace();
  try {
    const keychain = fakeKeychain({ corruptReadAt: 5 });
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        binding(),
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_ROLLBACK_UNPROVEN"),
    );
    assert.notEqual(keychain.state.get(REFERENCES[0]), null);
    assert.equal(keychain.events.some(([event, item]) =>
      event === "delete" && item === REFERENCES[0]), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("full post-finalization readback catches drift without deleting finalized values", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain({ corruptReadAt: 9 });
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    assert.equal(existsSync(paths(directory).receiptPath), true);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(
      paths(directory).receiptPath)), false);
    assert.equal(keychain.events.some(([event]) => event === "delete"), false);
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    assert.equal(keychain.events.some(([event]) => event === "delete"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed reuse rereads exact hashes, performs no write, and refuses changed binding or value", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    const first = await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      deterministicRandom(),
    ));
    const writesBefore = keychain.events.filter(([event]) => event === "write").length;
    const second = await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      { randomBytesImpl: () => { throw new Error("idempotent reuse must not generate"); } },
    ));
    assert.equal(second.receiptSha256, first.receiptSha256);
    assert.equal(keychain.events.filter(([event]) => event === "write").length, writesBefore);

    const changedBinding = binding({ field_receipt_sha256: HASH("f") });
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        changedBinding,
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID"),
    );

    keychain.state.get(REFERENCES[3]).fill(0);
    keychain.state.set(REFERENCES[3], Buffer.from("v2.invalid"));
    await assert.rejects(
      runDisposableRecoveryFieldKeychainPrep(runArguments(
        directory,
        checkedBinding,
        keychain.adapter,
        deterministicRandom(),
      )),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    assert.equal(keychain.events.filter(([event]) => event === "write").length, writesBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline K0 prepared-receipt capability is fixed-path, hash-only, and unforgeable", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    const completed = await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      deterministicRandom(),
    ));
    const original = readFileSync(paths(directory).receiptPath);
    const keychainEventsBefore = keychain.events.length;
    const capability = readDisposableRecoveryFieldKeychainPreparedReceipt({
      binding: checkedBinding,
      ...paths(directory),
    });
    assert.equal(keychain.events.length, keychainEventsBefore,
      "offline receipt authentication must not inspect or read Keychain");
    assert.equal(capability.receipt_sha256, completed.receiptSha256);
    assert.equal(capability.preparation_fingerprint,
      disposableRecoveryFieldKeychainPreparationFingerprint(checkedBinding));
    assert.equal(
      assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
        capability,
        checkedBinding,
        capability.keychain_binding_sha256,
      ),
      capability,
    );
    assert.equal(await capability.revalidateReceipt(), true);
    assert.equal(keychain.events.length, keychainEventsBefore);
    assert.equal(Object.isFrozen(capability), true);
    assert.equal(Object.isFrozen(capability.campaign_items), true);
    assert.equal("campaign_keychain_status" in capability, false);
    assert.equal("revalidate" in capability, false);
    assert.equal("verifyItem" in capability, false);
    const serialized = JSON.stringify({ ...capability, revalidateReceipt: undefined });
    assert.equal(serialized.includes(ACCOUNT_ID), false);
    for (const locator of REFERENCES) assert.equal(serialized.includes(locator), false);
    for (const { value } of keychain.writes) {
      assert.equal(serialized.includes(value.toString("utf8")), false);
    }

    for (const forged of [
      Object.freeze({ revalidateReceipt: async () => true }),
      Object.freeze({ ...capability }),
    ]) {
      assert.throws(
        () => assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
          forged,
          checkedBinding,
          capability.keychain_binding_sha256,
        ),
        prepError(
          "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREPARED_RECEIPT_CAPABILITY_INVALID",
        ),
      );
    }
    assert.throws(
      () => assertDisposableRecoveryFieldKeychainVerificationCapability(
        capability,
        capability.keychain_binding_sha256,
      ),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_CAPABILITY_INVALID"),
      "offline receipt evidence cannot impersonate live Keychain authority",
    );
    assert.throws(
      () => { capability.campaign_items[0].purpose = "forged"; },
      TypeError,
    );

    const wrongBinding = binding({ account_id: "b".repeat(32) });
    assert.throws(
      () => readDisposableRecoveryFieldKeychainPreparedReceipt({
        binding: wrongBinding,
        ...paths(directory),
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID"),
    );
    assert.throws(
      () => assertDisposableRecoveryFieldKeychainPreparedReceiptCapability(
        capability,
        wrongBinding,
        capability.keychain_binding_sha256,
      ),
      prepError(
        "DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREPARED_RECEIPT_CAPABILITY_INVALID",
      ),
    );

    const wrongPath = join(directory, "copied-k0-receipt.json");
    copyFileSync(paths(directory).receiptPath, wrongPath);
    assert.throws(
      () => readDisposableRecoveryFieldKeychainPreparedReceipt({
        binding: checkedBinding,
        receiptPath: wrongPath,
        expectedReceiptDirectory: directory,
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_PATH_INVALID"),
    );
    rmSync(wrongPath);

    const mutated = JSON.parse(original.toString("utf8"));
    mutated.provider_access = true;
    writeFileSync(
      paths(directory).receiptPath,
      `${JSON.stringify(mutated, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      capability.revalidateReceipt(),
      (error) => error instanceof DisposableRecoveryFieldKeychainPrepError,
      "a mutated prepared receipt invalidates the existing capability",
    );
    assert.throws(
      () => readDisposableRecoveryFieldKeychainPreparedReceipt({
        binding: checkedBinding,
        ...paths(directory),
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID"),
    );

    writeFileSync(paths(directory).receiptPath, original, { mode: 0o600 });
    assert.equal(await capability.revalidateReceipt(), true);
    rmSync(paths(directory).receiptPath);
    await assert.rejects(
      capability.revalidateReceipt(),
      (error) => error instanceof DisposableRecoveryFieldKeychainPrepError,
      "a removed prepared receipt invalidates the existing capability",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed K0 verification returns hash-only evidence and revalidates exact receipt and values", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    const completed = await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      deterministicRandom(),
    ));
    const readOnlyKeychain = {
      inspect: keychain.adapter.inspect,
      read: keychain.adapter.read,
    };
    const proof = await verifyDisposableRecoveryFieldKeychainPrep({
      binding: checkedBinding,
      ...paths(directory),
      keychain: readOnlyKeychain,
      platform: "darwin",
    });
    assert.equal(proof.receipt_sha256, completed.receiptSha256);
    assert.equal(proof.preparation_fingerprint,
      disposableRecoveryFieldKeychainPreparationFingerprint(checkedBinding));
    assert.deepEqual(
      proof.campaign_keychain_locator_sha256,
      completed.receipt.campaign_items.map((item) => item.locator_sha256),
    );
    assert.deepEqual(
      proof.campaign_keychain_value_sha256,
      completed.receipt.campaign_items.map((item) => item.value_sha256),
    );
    assert.deepEqual(
      proof.campaign_keychain_status,
      PURPOSES.map((purpose) => ({ purpose, lookup: "present" })),
    );
    assert.equal(await proof.revalidate(), true);
    assert.equal(await proof.revalidateReceipt(), true);
    assert.equal(
      assertDisposableRecoveryFieldKeychainVerificationCapability(
        proof,
        proof.keychain_binding_sha256,
      ),
      proof,
    );
    const forged = Object.freeze({ ...proof });
    assert.throws(
      () => assertDisposableRecoveryFieldKeychainVerificationCapability(
        forged,
        proof.keychain_binding_sha256,
      ),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_CAPABILITY_INVALID"),
    );
    assert.throws(
      () => assertDisposableRecoveryFieldKeychainVerificationCapability(
        proof,
        HASH("f"),
      ),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_VERIFICATION_CAPABILITY_INVALID"),
    );
    for (const purpose of PURPOSES) assert.equal(await proof.verifyItem(purpose), true);
    const publicText = JSON.stringify({ ...proof, revalidate: undefined });
    assert.equal(publicText.includes(ACCOUNT_ID), false);
    for (const locator of REFERENCES) assert.equal(publicText.includes(locator), false);
    for (const { value } of keychain.writes) {
      assert.equal(publicText.includes(value.toString("utf8")), false);
    }

    keychain.state.get(REFERENCES[0]).fill(0);
    keychain.state.set(REFERENCES[0], Buffer.from("f".repeat(48)));
    assert.equal(await proof.revalidateReceipt(), true);
    await assert.rejects(
      proof.verifyItem(PURPOSES[0]),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    await assert.rejects(
      proof.revalidate(),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    await assert.rejects(
      verifyDisposableRecoveryFieldKeychainPrep({
        binding: binding({ account_id: "b".repeat(32) }),
        ...paths(directory),
        keychain: readOnlyKeychain,
        platform: "darwin",
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_INVALID"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed K0 verification allows exact missing values only for teardown resume", async () => {
  const directory = workspace();
  try {
    const checkedBinding = binding();
    const keychain = fakeKeychain();
    await runDisposableRecoveryFieldKeychainPrep(runArguments(
      directory,
      checkedBinding,
      keychain.adapter,
      deterministicRandom(),
    ));
    const readOnlyKeychain = {
      inspect: keychain.adapter.inspect,
      read: keychain.adapter.read,
    };
    const complete = await verifyDisposableRecoveryFieldKeychainPrep({
      binding: checkedBinding,
      ...paths(directory),
      keychain: readOnlyKeychain,
      platform: "darwin",
    });
    const removed = keychain.state.get(REFERENCES[0]);
    removed.fill(0);
    keychain.state.set(REFERENCES[0], null);

    await assert.rejects(
      verifyDisposableRecoveryFieldKeychainPrep({
        binding: checkedBinding,
        ...paths(directory),
        keychain: readOnlyKeychain,
        platform: "darwin",
      }),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    const resumable = await verifyDisposableRecoveryFieldKeychainPrep({
      binding: checkedBinding,
      ...paths(directory),
      keychain: readOnlyKeychain,
      platform: "darwin",
      allowMissing: true,
    });
    assert.equal(resumable.keychain_binding_sha256, complete.keychain_binding_sha256);
    assert.deepEqual(
      resumable.campaign_keychain_status,
      PURPOSES.map((purpose, index) => ({
        purpose,
        lookup: index === 0 ? "item_not_found" : "present",
      })),
    );
    assert.equal(await resumable.revalidate(), true);
    assert.equal(await resumable.revalidateReceipt(), true);
    await assert.rejects(
      resumable.verifyItem(PURPOSES[0]),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
    assert.equal(await resumable.verifyItem(PURPOSES[1]), true);

    keychain.state.get(REFERENCES[1]).fill(0);
    keychain.state.set(REFERENCES[1], Buffer.from("f".repeat(48)));
    await assert.rejects(
      resumable.revalidate(),
      prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_COMPLETED_STATE_CHANGED"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default Keychain transport keeps values out of argv, env, and child output", async () => {
  const calls = [];
  const stored = new Map();
  const snapshots = [];
  const childBuffers = [];
  const childResult = (status, stdout, stderr) => {
    childBuffers.push(stdout, stderr);
    return { status, stdout, stderr };
  };
  const adapter = createDisposableRecoveryFieldKeychainPrep({
    platform: "darwin",
    environment: {
      PATH: "/untrusted",
      ADMIN_KEY: "ambient-admin-secret",
      CLOUDFLARE_API_TOKEN: "ambient-provider-secret",
    },
    run(command, args, options) {
      const snapshot = {
        command,
        args: [...args],
        env: { ...options.env },
        input: options.input ? Buffer.from(options.input) : null,
      };
      calls.push(snapshot);
      const service = args[args.indexOf("-s") + 1];
      const account = args[args.indexOf("-a") + 1];
      const item = `${service}/${account}`;
      if (command === "/usr/bin/expect") {
        const input = Buffer.from(options.input);
        input.fill(0, input.length - 1);
        stored.set(item, Buffer.from(options.input.subarray(0, options.input.length - 1)));
        snapshots.push(Buffer.from(stored.get(item)));
        return childResult(0, Buffer.alloc(0), Buffer.alloc(0));
      }
      if (args[0] === "find-generic-password" && args.includes("-w")) {
        const value = stored.get(item);
        return value
          ? childResult(0, Buffer.concat([value, Buffer.from("\n")]), Buffer.alloc(0))
          : childResult(44, Buffer.alloc(0), Buffer.from("item not found"));
      }
      if (args[0] === "find-generic-password") {
        return stored.has(item)
          ? childResult(0, Buffer.alloc(0), Buffer.alloc(0))
          : childResult(44, Buffer.alloc(0), Buffer.from("item not found"));
      }
      if (args[0] === "delete-generic-password") {
        stored.delete(item);
        return childResult(0, Buffer.alloc(0), Buffer.alloc(0));
      }
      throw new Error("unexpected child invocation");
    },
  });
  const locator = {
    ...parseAdminKeySecretReference(REFERENCES[0]),
    reference: REFERENCES[0],
  };
  const secret = Buffer.from("1".repeat(48));
  assert.equal(await adapter.inspect(locator), "item_not_found");
  assert.equal(await adapter.write(locator, secret), true);
  const readback = await adapter.read(locator);
  assert.equal(readback.toString("utf8"), "1".repeat(48));
  readback.fill(0);
  assert.equal(await adapter.delete(locator), true);

  const secretText = "1".repeat(48);
  for (const call of calls) {
    assert.equal(call.args.join("\0").includes(secretText), false);
    assert.equal(JSON.stringify(call.env).includes(secretText), false);
    assert.equal(call.env.ADMIN_KEY, undefined);
    assert.equal(call.env.CLOUDFLARE_API_TOKEN, undefined);
  }
  const writeCall = calls.find(({ command }) => command === "/usr/bin/expect");
  assert.ok(writeCall);
  const inspectCall = calls.find(({ command, args }) =>
    command === "/usr/bin/security" && args[0] === "find-generic-password" &&
    !args.includes("-w"));
  assert.ok(inspectCall, "absence inspection must not request a secret value");
  assert.equal(writeCall.args.includes("-U"), false,
    "a collision must fail instead of overwriting a partial item");
  assert.equal(writeCall.input.toString("utf8"), `${secretText}\n`);
  assert.equal(snapshots[0].toString("utf8"), secretText);
  assert.equal(calls.some(({ input }) => input && input.includes("ambient-provider-secret")), false);
  assert.equal(childBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true,
    "captured child stdout and stderr are zeroed after inspection or readback");

  await assert.rejects(
    adapter.inspect({ backend: "keychain", service: "other", account: "owner" }),
    prepError("DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_KEYCHAIN_INVALID"),
  );
  secret.fill(0);
  snapshots.forEach((value) => value.fill(0));
});

}
