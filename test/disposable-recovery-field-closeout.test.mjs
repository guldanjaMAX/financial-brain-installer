import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as closeoutApi from "../operations/disposable-recovery-field-closeout.mjs";
import {
  DisposableRecoveryFieldAcceptanceError,
  DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
  assertDisposableRecoveryFieldAcceptance,
  readDisposableRecoveryFieldDeploymentEvidence,
  readDisposableRecoveryFieldInterruptionEvidence,
  readDisposableRecoveryManualTeardownClosure,
  readDisposableRecoveryTargetEvalReceipt,
} from "../operations/disposable-recovery-field-acceptance.mjs";
import {
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
  DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
  DisposableRecoveryFieldCloseoutError,
  assertDisposableRecoveryFieldCloseoutEvidenceCapability,
  disposableRecoveryFieldCloseoutApprovalFingerprint,
  previewDisposableRecoveryFieldCloseout,
  readDisposableRecoveryFieldCloseoutEvidence,
  runDisposableRecoveryFieldCloseout,
} from "../operations/disposable-recovery-field-closeout.mjs";
import {
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
  privateAggregateReceiptStagedPath,
} from "../operations/private-aggregate-receipt.mjs";
import {
  CLOSEOUT_FIXTURE_REFERENCES,
  cloneDisposableRecoveryCloseoutFixture,
  createDisposableRecoveryCloseoutFixture,
  createInMemoryCloseoutRuntime,
} from "./helpers/disposable-recovery-closeout-fixture.mjs";
import {
  registerNextTestDisposableRecoveryRetainedRecensusTransition,
} from "./helpers/disposable-recovery-acceptance-runtime.mjs";
import {
  registerTestDisposableRecoveryFieldCloseoutRuntime,
} from "./helpers/disposable-recovery-closeout-keychain.mjs";

const BASE = await createDisposableRecoveryCloseoutFixture({
  prefix: "brain-v048-closeout-base-",
});
const CHILD = fileURLToPath(new URL(
  "./helpers/disposable-recovery-closeout-child.mjs",
  import.meta.url,
));
const createdRoots = new Set([BASE.root]);
process.once("exit", () => {
  for (const root of createdRoots) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { /* test-only owner-private fixture */ }
  }
});

function closeoutError(code) {
  return (error) => error instanceof DisposableRecoveryFieldCloseoutError &&
    error.code === code;
}

async function fixture(prefix = "brain-v048-closeout-test-") {
  const value = await cloneDisposableRecoveryCloseoutFixture(BASE, { prefix });
  createdRoots.add(value.root);
  return value;
}

function dispose(value) {
  rmSync(value.root, { recursive: true, force: true });
  createdRoots.delete(value.root);
}

function privateWrite(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function register(fixtureValue, options = {}) {
  const runtime = createInMemoryCloseoutRuntime(fixtureValue, options);
  registerTestDisposableRecoveryFieldCloseoutRuntime(
    fixtureValue.evidenceCapability,
    runtime,
  );
  return runtime;
}

function closureReaderOptions(value) {
  return Object.freeze({
    receiptPath: join(
      value.receiptDirectory,
      DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
    ),
    binding: value.evidenceCapability.binding,
    sourceManifestPath: value.readerOptions.sourceManifestPath,
    targetManifestPath: value.readerOptions.targetManifestPath,
    planPath: value.readerOptions.planPath,
    statePath: value.readerOptions.statePath,
    artifactDirectory: value.readerOptions.artifactDirectory,
    wranglerWrapperPath: value.readerOptions.wranglerWrapperPath,
    goldenPath: value.readerOptions.goldenPath,
    fieldReceiptPath: value.readerOptions.fieldReceiptPath,
    packagePath: value.readerOptions.packagePath,
  });
}

function closeoutChildHarness(value) {
  const descriptorPath = join(value.root, "child-evidence.json");
  const statePath = join(value.root, "child-keychain.json");
  privateWrite(
    descriptorPath,
    `${JSON.stringify(value.readerOptions, null, 2)}\n`,
  );
  const values = CLOSEOUT_FIXTURE_REFERENCES.map((reference) =>
    value.k0.keychain.values.get(reference).toString("base64"));
  privateWrite(statePath, `${JSON.stringify({
    statuses: Array(4).fill("present"),
    values,
    deletes: [],
    killed_stages: [],
    shared_token_checks: 0,
  }, null, 2)}\n`);
  const run = (killStage, resume) => spawnSync(
    process.execPath,
    [CHILD, descriptorPath, statePath, killStage, String(resume)],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: "child-v8" },
      timeout: 120_000,
    },
  );
  return Object.freeze({ descriptorPath, statePath, run });
}

function acceptanceError(code) {
  return (error) => error instanceof DisposableRecoveryFieldAcceptanceError &&
    error.code === code;
}

test("A17 public contracts accept only current physical evidence capabilities", async () => {
  const current = await fixture();
  try {
    const runtime = register(current);
    const preview = await previewDisposableRecoveryFieldCloseout({
      evidenceCapability: current.evidenceCapability,
    });
    assert.equal(preview.action, "A17");
    assert.equal(preview.keychain_mutation, false);
    assert.equal(preview.provider_mutation, false);
    assert.equal(preview.campaign_items.length, 4);
    assert.equal(runtime.events.some(([event]) => event === "delete"), false);
    assert.match(
      await disposableRecoveryFieldCloseoutApprovalFingerprint(
        current.evidenceCapability,
      ),
      /^[a-f0-9]{64}$/u,
    );

    const copied = structuredClone(current.evidenceCapability);
    await assert.rejects(
      () => assertDisposableRecoveryFieldCloseoutEvidenceCapability(copied),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID"),
    );
    await assert.rejects(
      () => previewDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        input: copied,
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_INVALID"),
    );
    await assert.rejects(
      () => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: "0".repeat(64),
        retainedEvidence: copied.retainedEvidence,
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_ARGUMENTS_INVALID"),
    );
  } finally {
    dispose(current);
  }
});

test("no destructive low-level API is exported and only the approved runner deletes", async () => {
  const current = await fixture();
  try {
    assert.equal(
      Object.hasOwn(
        closeoutApi,
        "createDisposableRecoveryFieldKeychainCloseout",
      ),
      false,
    );
    assert.equal(
      Object.values(closeoutApi).some((value) => value &&
        typeof value === "object" &&
        (typeof value.delete === "function" ||
         typeof value.authorizeDelete === "function")),
      false,
    );
    const runtime = register(current);
    await assert.rejects(
      () => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: "0".repeat(64),
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_APPROVAL_INVALID"),
    );
    await assert.rejects(
      () => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: "0".repeat(64),
        keychain: {},
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_ARGUMENTS_INVALID"),
    );
    assert.equal(runtime.events.some(([event]) => event === "delete"), false);
    assert.equal(
      existsSync(join(
        current.receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME,
      )),
      false,
    );
    assert.equal(
      existsSync(join(
        current.receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
      )),
      false,
    );
  } finally {
    dispose(current);
  }
});

test("a genuine A17 run deletes four items and requires stable F+A+J thereafter", async () => {
  const current = await fixture();
  const substituted = await fixture("brain-v048-closeout-substituted-");
  try {
    const runtime = register(current);
    const approval = await disposableRecoveryFieldCloseoutApprovalFingerprint(
      current.evidenceCapability,
    );
    const completed = await runDisposableRecoveryFieldCloseout({
      evidenceCapability: current.evidenceCapability,
      approvalFingerprint: approval,
    });
    assert.equal(completed.receipt.status, "closed");
    assert.match(completed.receiptSha256, /^[a-f0-9]{64}$/u);
    assert.match(completed.terminalAnchorSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      runtime.events.filter(([event]) => event === "delete")
        .map(([, reference]) => reference),
      CLOSEOUT_FIXTURE_REFERENCES,
    );
    const finalPath = join(
      current.receiptDirectory,
      DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
    );
    const accepted = readDisposableRecoveryManualTeardownClosure(
      closureReaderOptions(current),
    );
    assert.equal(accepted.sha256, completed.receiptSha256);
    assert.equal(accepted.terminalAnchor.sha256, completed.terminalAnchorSha256);
    const targetEval = readDisposableRecoveryTargetEvalReceipt(
      join(current.receiptDirectory,
        "v048-disposable-target-eval-receipt.json"),
      current.evidenceCapability.binding,
    );
    const deploymentEvidence = readDisposableRecoveryFieldDeploymentEvidence(
      current.receiptDirectory,
    );
    const interruptionEvidence =
      readDisposableRecoveryFieldInterruptionEvidence({
        deploymentEvidence,
        teardownClosure: accepted,
      });
    const acceptanceInput = {
      deploymentEvidence,
      interruptionEvidence,
      binding: current.evidenceCapability.binding,
      targetEvalReceipt: targetEval,
      teardownClosure: accepted,
    };
    const finalAcceptance = assertDisposableRecoveryFieldAcceptance(
      acceptanceInput,
    );
    assert.equal(finalAcceptance.status, "accepted");
    assert.equal(finalAcceptance.actual_chunks_admitted_to_epoch, 6_113);
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance({
        ...acceptanceInput,
        teardownClosure: structuredClone(accepted),
      }),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID"),
    );
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance({
        ...acceptanceInput,
        deploymentEvidence: structuredClone(deploymentEvidence),
      }),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID"),
    );
    const substitutedDeployment =
      readDisposableRecoveryFieldDeploymentEvidence(
        substituted.receiptDirectory,
      );
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance({
        ...acceptanceInput,
        deploymentEvidence: substitutedDeployment,
      }),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID"),
    );
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance({
        ...acceptanceInput,
        interruptionEvidence: structuredClone(interruptionEvidence),
      }),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID"),
    );
    const nonIntegerInterruption = structuredClone(interruptionEvidence);
    nonIntegerInterruption.interruptionProof.actual_chunks_admitted_to_epoch =
      "6113";
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance({
        ...acceptanceInput,
        interruptionEvidence: nonIntegerInterruption,
      }),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID"),
    );
    for (const injected of [
      { deploymentChain: deploymentEvidence.chain },
      { seedReceipt: deploymentEvidence.seedReceipt },
      { interruptionProof: interruptionEvidence.interruptionProof },
    ]) {
      assert.throws(
        () => assertDisposableRecoveryFieldAcceptance({
          ...acceptanceInput,
          ...injected,
        }),
        acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID"),
      );
    }
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance({
        ...acceptanceInput,
        targetEvalReceipt: structuredClone(targetEval),
      }),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID"),
    );
    assert.throws(
      () => assertDisposableRecoveryFieldAcceptance(acceptanceInput, {}),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID"),
    );
    assert.throws(
      () => readDisposableRecoveryManualTeardownClosure(
        closureReaderOptions(current),
        {},
      ),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID"),
    );
    assert.throws(
      () => readDisposableRecoveryFieldInterruptionEvidence({
        deploymentEvidence,
        teardownClosure: accepted,
      }, {}),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID"),
    );
    assert.throws(
      () => readDisposableRecoveryTargetEvalReceipt(
        join(current.receiptDirectory,
          "v048-disposable-target-eval-receipt.json"),
        current.evidenceCapability.binding,
        {},
      ),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_ARGUMENTS_INVALID"),
    );
    assert.equal(existsSync(privateAggregateReceiptPendingPath(finalPath)), false);
    assert.equal(existsSync(privateAggregateReceiptStagedPath(finalPath)), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(finalPath)), false);

    const idempotentRuntime = register(current, {
      states: Array(4).fill("item_not_found"),
    });
    const repeated = await runDisposableRecoveryFieldCloseout({
      evidenceCapability: current.evidenceCapability,
      approvalFingerprint: approval,
    });
    assert.equal(repeated.receiptSha256, completed.receiptSha256);
    assert.equal(repeated.terminalAnchorSha256, completed.terminalAnchorSha256);
    assert.equal(
      idempotentRuntime.events.some(([event]) => event === "delete"),
      false,
    );
  } finally {
    dispose(current);
    dispose(substituted);
  }
});

test("the final retained recensus rehashes K0 reset receipts and journal events", async () => {
  const current = await createDisposableRecoveryCloseoutFixture({
    prefix: "brain-v048-closeout-final-recensus-",
    includeK0ResetHistory: true,
  });
  createdRoots.add(current.root);
  try {
    register(current);
    const approval = await disposableRecoveryFieldCloseoutApprovalFingerprint(
      current.evidenceCapability,
    );
    await runDisposableRecoveryFieldCloseout({
      evidenceCapability: current.evidenceCapability,
      approvalFingerprint: approval,
    });
    const names = [
      current.k0ResetHistory.resetReceiptName,
      current.k0ResetHistory.journalNames[0],
    ];
    for (const name of names) {
      const path = join(current.receiptDirectory, name);
      const original = readFileSync(path);
      registerNextTestDisposableRecoveryRetainedRecensusTransition(
        ({ stage }) => {
          assert.equal(stage, "before_final_retained_evidence_recensus");
          privateWrite(path, Buffer.concat([
            original,
            Buffer.from("changed-during-final-recensus"),
          ]));
        },
      );
      assert.throws(
        () => readDisposableRecoveryManualTeardownClosure(
          closureReaderOptions(current),
        ),
        acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED"),
      );
      privateWrite(path, original);
    }
    assert.match(
      readDisposableRecoveryManualTeardownClosure(
        closureReaderOptions(current),
      ).sha256,
      /^[a-f0-9]{64}$/u,
    );
  } finally {
    dispose(current);
  }
});

test("copied, stale, wrong-account, and changed K0 evidence are refused", async () => {
  const stale = await fixture();
  const wrongAccount = await fixture();
  const changedK0 = await fixture();
  try {
    privateWrite(stale.explicit.package, "changed package\n");
    await assert.rejects(
      () => assertDisposableRecoveryFieldCloseoutEvidenceCapability(
        stale.evidenceCapability,
      ),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID"),
    );
    await assert.rejects(
      () => readDisposableRecoveryFieldCloseoutEvidence({
        ...wrongAccount.readerOptions,
        accountId: "b".repeat(32),
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_EVIDENCE_CAPABILITY_INVALID"),
    );
    const k0Path = join(
      changedK0.receiptDirectory,
      "v048-disposable-field-keychain-prep.json",
    );
    const receipt = JSON.parse(readFileSync(k0Path, "utf8"));
    receipt.completed_at = "2026-09-13T12:00:01.000Z";
    privateWrite(k0Path, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(
      () => readDisposableRecoveryFieldCloseoutEvidence(changedK0.readerOptions),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_K0_INVALID"),
    );
  } finally {
    dispose(stale);
    dispose(wrongAccount);
    dispose(changedK0);
  }
});

test("every recovery residue form is rejected before Keychain construction", async () => {
  const cases = [
    (current) => {
      privateWrite(join(current.receiptDirectory,
        ".brain-recovery-export.sql.tmp-data"), "residue\n");
      return current.readerOptions;
    },
    (current) => {
      privateWrite(join(current.artifactDirectory,
        ".brain-recovery-export.sql.tmp-combined"), "residue\n");
      return current.readerOptions;
    },
    (current) => {
      const nested = join(current.artifactDirectory, "nested");
      mkdirSync(nested, { mode: 0o700 });
      privateWrite(join(nested, ".brain-recovery-plaintext.tmp-tail"), "residue\n");
      return current.readerOptions;
    },
    (current) => {
      const tail = join(current.explicitDirectory,
        ".brain-recovery-encrypted.tmp-tail");
      copyFileSync(current.explicit.package, tail);
      if (process.platform !== "win32") chmodSync(tail, 0o600);
      return { ...current.readerOptions, packagePath: tail };
    },
    (current) => {
      const ancestor = join(current.root, ".brain-recovery-runtime-parent");
      mkdirSync(ancestor, { mode: 0o700 });
      const moved = join(ancestor, "artifacts");
      renameSync(current.artifactDirectory, moved);
      return { ...current.readerOptions, artifactDirectory: moved };
    },
  ];
  for (const mutate of cases) {
    const current = await fixture("brain-v048-closeout-residue-");
    try {
      await assert.rejects(
        () => readDisposableRecoveryFieldCloseoutEvidence(mutate(current)),
        closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_RETAINED_EVIDENCE_INVALID"),
      );
    } finally {
      dispose(current);
    }
  }
});

test("mutations across awaited K0, transition, and delete boundaries fail closed", async () => {
  const duringK0 = await fixture();
  const afterJournal = await fixture();
  const afterDelete = await fixture();
  try {
    let changed = false;
    const k0Runtime = register(duringK0, {
      onRead: async () => {
        if (changed) return;
        changed = true;
        privateWrite(duringK0.explicit.package, "mutated during K0 read\n");
      },
    });
    await assert.rejects(
      () => previewDisposableRecoveryFieldCloseout({
        evidenceCapability: duringK0.evidenceCapability,
      }),
    );
    assert.equal(k0Runtime.events.some(([event]) => event === "delete"), false);

    let journalChanged = false;
    const journalRuntime = register(afterJournal, {
      onDeletionTransition: async ({ state }) => {
        if (state === "planned" && !journalChanged) {
          journalChanged = true;
          privateWrite(afterJournal.explicit.package, "mutated after journal await\n");
        }
      },
    });
    const journalApproval = await disposableRecoveryFieldCloseoutApprovalFingerprint(
      afterJournal.evidenceCapability,
    );
    await assert.rejects(() => runDisposableRecoveryFieldCloseout({
      evidenceCapability: afterJournal.evidenceCapability,
      approvalFingerprint: journalApproval,
    }));
    assert.equal(journalRuntime.events.some(([event]) => event === "delete"), false);

    let deleteChanged = false;
    const deleteRuntime = register(afterDelete, {
      onDelete: async () => {
        if (deleteChanged) return;
        deleteChanged = true;
        privateWrite(afterDelete.explicit.package, "mutated during delete await\n");
      },
    });
    const deleteApproval = await disposableRecoveryFieldCloseoutApprovalFingerprint(
      afterDelete.evidenceCapability,
    );
    await assert.rejects(() => runDisposableRecoveryFieldCloseout({
      evidenceCapability: afterDelete.evidenceCapability,
      approvalFingerprint: deleteApproval,
    }));
    assert.equal(
      deleteRuntime.events.filter(([event]) => event === "delete").length,
      1,
    );
  } finally {
    dispose(duringK0);
    dispose(afterJournal);
    dispose(afterDelete);
  }
});

test("final, anchor, and journal tamper plus final-only or anchor-only states refuse", async () => {
  const current = await fixture();
  try {
    const runtime = register(current);
    const approval = await disposableRecoveryFieldCloseoutApprovalFingerprint(
      current.evidenceCapability,
    );
    await runDisposableRecoveryFieldCloseout({
      evidenceCapability: current.evidenceCapability,
      approvalFingerprint: approval,
    });
    assert.equal(runtime.events.filter(([event]) => event === "delete").length, 4);
    const paths = {
      final: join(current.receiptDirectory,
        DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME),
      anchor: join(current.receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME),
      journal: join(current.receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME),
    };
    const original = Object.fromEntries(Object.entries(paths).map(([key, path]) => [
      key,
      readFileSync(path),
    ]));
    for (const key of ["final", "anchor", "journal"]) {
      privateWrite(paths[key], Buffer.concat([original[key], Buffer.from("x")]));
      const absentRuntime = register(current, {
        states: Array(4).fill("item_not_found"),
      });
      await assert.rejects(() => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: approval,
      }));
      assert.equal(absentRuntime.events.some(([event]) => event === "delete"), false);
      privateWrite(paths[key], original[key]);
    }

    for (const key of ["final", "anchor", "journal"]) {
      let changed = false;
      const absentRuntime = register(current, {
        states: Array(4).fill("item_not_found"),
        onSharedToken: async () => {
          if (changed) return;
          changed = true;
          privateWrite(
            paths[key],
            Buffer.concat([original[key], Buffer.from("awaited-change")]),
          );
        },
      });
      await assert.rejects(() => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: approval,
      }));
      assert.equal(changed, true);
      assert.equal(absentRuntime.events.some(([event]) => event === "delete"), false);
      privateWrite(paths[key], original[key]);
    }

    const closureCapability = readDisposableRecoveryManualTeardownClosure(
      closureReaderOptions(current),
    );
    const targetEvalCapability = readDisposableRecoveryTargetEvalReceipt(
      join(current.receiptDirectory,
        "v048-disposable-target-eval-receipt.json"),
      current.evidenceCapability.binding,
    );
    const deploymentCapability = readDisposableRecoveryFieldDeploymentEvidence(
      current.receiptDirectory,
    );
    const interruptionCapability =
      readDisposableRecoveryFieldInterruptionEvidence({
        deploymentEvidence: deploymentCapability,
        teardownClosure: closureCapability,
      });
    const acceptanceProbe = {
      deploymentEvidence: deploymentCapability,
      interruptionEvidence: interruptionCapability,
      binding: current.evidenceCapability.binding,
      targetEvalReceipt: targetEvalCapability,
      teardownClosure: closureCapability,
    };
    const physicalCases = [
      {
        path: join(current.receiptDirectory,
          "v048-disposable-field-keychain-prep.json"),
        mutate(path) { unlinkSync(path); },
      },
      {
        path: current.explicit.package,
        mutate(path, bytes) {
          privateWrite(path, Buffer.concat([bytes, Buffer.from("explicit-change")]));
        },
      },
      {
        path: current.explicit.fieldReceipt,
        mutate(path, bytes) {
          privateWrite(path, Buffer.concat([bytes, Buffer.from("field-change")]));
        },
      },
      {
        path: join(current.receiptDirectory,
          "v048-disposable-seed-receipt.json"),
        mutate(path, bytes) {
          privateWrite(path, Buffer.concat([bytes, Buffer.from("seed-change")]));
        },
      },
      {
        path: join(current.artifactDirectory,
          ".brain-recovery-export.sql.fbrenc"),
        mutate(path, bytes) {
          privateWrite(path, Buffer.concat([bytes, Buffer.from("artifact-change")]));
        },
      },
    ];
    for (const physical of physicalCases) {
      const bytes = readFileSync(physical.path);
      physical.mutate(physical.path, bytes);
      assert.throws(
        () => readDisposableRecoveryManualTeardownClosure(
          closureReaderOptions(current),
        ),
        acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED"),
      );
      if ([
        current.explicit.package,
        current.explicit.fieldReceipt,
      ].includes(physical.path) ||
          physical.path.endsWith("v048-disposable-seed-receipt.json")) {
        const acceptanceCode = physical.path.endsWith(
          "v048-disposable-seed-receipt.json",
        )
          ? "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED"
          : "DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_CAPABILITY_INVALID";
        assert.throws(
          () => assertDisposableRecoveryFieldAcceptance(acceptanceProbe),
          acceptanceError(acceptanceCode),
        );
      }
      privateWrite(physical.path, bytes);
    }
    const residuePath = join(
      current.artifactDirectory,
      ".brain-recovery-runtime-acceptance-residue",
    );
    privateWrite(residuePath, "residue\n");
    assert.throws(
      () => readDisposableRecoveryManualTeardownClosure(
        closureReaderOptions(current),
      ),
      acceptanceError("DISPOSABLE_RECOVERY_FIELD_ACCEPTANCE_READ_REFUSED"),
    );
    unlinkSync(residuePath);

    unlinkSync(paths.anchor);
    register(current, { states: Array(4).fill("item_not_found") });
    await assert.rejects(
      () => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: approval,
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID"),
    );
    privateWrite(paths.anchor, original.anchor);
    unlinkSync(paths.final);
    register(current, { states: Array(4).fill("item_not_found") });
    await assert.rejects(
      () => runDisposableRecoveryFieldCloseout({
        evidenceCapability: current.evidenceCapability,
        approvalFingerprint: approval,
        resume: true,
      }),
      closeoutError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID"),
    );
  } finally {
    dispose(current);
  }
});

test("fresh-process SIGKILL resumes every recoverable stage and preserves the zero-byte refusal", {
  timeout: 15 * 60 * 1000,
}, async () => {
  const stages = [
    "terminal_anchor_durable",
    "staged_receipt_created",
    "staged_receipt_written",
    "staged_receipt_file_fsynced",
    "staged_receipt_durable",
    "finalization_commit_durable",
    "final_receipt_durable",
    "pending_marker_removal_durable",
    "finalization_commit_removal_durable",
  ];
  for (const stage of stages) {
    const current = await fixture("brain-v048-closeout-sigkill-");
    try {
      const { statePath, run } = closeoutChildHarness(current);
      const killed = run(stage, false);
      assert.equal(killed.signal, "SIGKILL", `${stage} must hard-kill`);
      if (stage === "staged_receipt_created") {
        const guardedPaths = [
          join(current.receiptDirectory,
            DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME),
          join(current.receiptDirectory,
            DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME),
          privateAggregateReceiptPendingPath(join(
            current.receiptDirectory,
            DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
          )),
          privateAggregateReceiptStagedPath(join(
            current.receiptDirectory,
            DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
          )),
        ];
        const before = guardedPaths.map((path) => ({
          path,
          bytes: readFileSync(path),
          info: lstatSync(path),
        }));
        assert.equal(before.at(-1).info.size, 0);
        const stateBefore = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(stateBefore.statuses,
          Array(4).fill("item_not_found"));
        assert.equal(stateBefore.deletes.length, 4);
        assert.equal(new Set(stateBefore.deletes).size, 4);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const refused = run("none", true);
          assert.equal(refused.status, 1);
          assert.match(
            refused.stderr,
            /DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_FINALIZATION_RECOVERY_FAILED/u,
          );
        }
        for (const prior of before) {
          const currentInfo = lstatSync(prior.path);
          assert.equal(currentInfo.dev, prior.info.dev);
          assert.equal(currentInfo.ino, prior.info.ino);
          assert.deepEqual(readFileSync(prior.path), prior.bytes);
        }
        const stateAfter = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(stateAfter.deletes, stateBefore.deletes);
        continue;
      }
      const recovered = run("none", true);
      assert.equal(recovered.status, 0, `${stage}: ${recovered.stderr}`);
      const first = JSON.parse(recovered.stdout);
      const stateAfterRecovery = JSON.parse(readFileSync(statePath, "utf8"));
      assert.deepEqual(stateAfterRecovery.statuses,
        Array(4).fill("item_not_found"));
      assert.equal(stateAfterRecovery.deletes.length, 4);
      assert.equal(new Set(stateAfterRecovery.deletes).size, 4);
      const repeated = run("none", false);
      assert.equal(repeated.status, 0, `${stage}: ${repeated.stderr}`);
      const second = JSON.parse(repeated.stdout);
      assert.equal(second.receipt_sha256, first.receipt_sha256);
      assert.equal(second.terminal_anchor_sha256, first.terminal_anchor_sha256);
      const finalState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.deepEqual(finalState.deletes, stateAfterRecovery.deletes);
    } finally {
      dispose(current);
    }
  }

  const deletionStages = [
    { stage: "deletion:planned", recoverable: true },
    { stage: "deletion:sent_unconfirmed", recoverable: false },
    { stage: "deletion:post_delete", recoverable: true },
    { stage: "deletion:confirmed_absent", recoverable: true },
  ];
  for (const { stage, recoverable } of deletionStages) {
    const current = await fixture("brain-v048-closeout-delete-sigkill-");
    try {
      const { statePath, run } = closeoutChildHarness(current);
      const killed = run(stage, false);
      assert.equal(killed.signal, "SIGKILL", `${stage} must hard-kill`);
      if (!recoverable) {
        const guardPaths = [
          join(current.receiptDirectory,
            DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_DELETION_JOURNAL_NAME),
          privateAggregateReceiptPendingPath(join(
            current.receiptDirectory,
            DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_NAME,
          )),
        ];
        const before = guardPaths.map((path) => ({
          path,
          bytes: readFileSync(path),
          info: lstatSync(path),
        }));
        const stateBefore = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(stateBefore.statuses, Array(4).fill("present"));
        assert.deepEqual(stateBefore.deletes, []);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const refused = run("none", true);
          assert.equal(refused.status, 1);
          assert.match(
            refused.stderr,
            /DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_KEYCHAIN_AMBIGUOUS/u,
          );
        }
        for (const prior of before) {
          const after = lstatSync(prior.path);
          assert.equal(after.dev, prior.info.dev);
          assert.equal(after.ino, prior.info.ino);
          assert.deepEqual(readFileSync(prior.path), prior.bytes);
        }
        assert.deepEqual(
          JSON.parse(readFileSync(statePath, "utf8")).deletes,
          [],
        );
        continue;
      }
      const recovered = run("none", true);
      assert.equal(recovered.status, 0, `${stage}: ${recovered.stderr}`);
      const first = JSON.parse(recovered.stdout);
      const stateAfterRecovery = JSON.parse(readFileSync(statePath, "utf8"));
      assert.deepEqual(
        stateAfterRecovery.statuses,
        Array(4).fill("item_not_found"),
      );
      assert.equal(stateAfterRecovery.deletes.length, 4);
      assert.equal(new Set(stateAfterRecovery.deletes).size, 4);
      const repeated = run("none", false);
      assert.equal(repeated.status, 0, `${stage}: ${repeated.stderr}`);
      const second = JSON.parse(repeated.stdout);
      assert.equal(second.receipt_sha256, first.receipt_sha256);
      assert.equal(
        second.terminal_anchor_sha256,
        first.terminal_anchor_sha256,
      );
      assert.deepEqual(
        JSON.parse(readFileSync(statePath, "utf8")).deletes,
        stateAfterRecovery.deletes,
      );
    } finally {
      dispose(current);
    }
  }

  for (const anchorBytes of [Buffer.alloc(0), Buffer.from("{", "utf8")]) {
    const current = await fixture("brain-v048-closeout-anchor-prefix-");
    try {
      const { statePath, run } = closeoutChildHarness(current);
      const killed = run("deletion:confirmed_absent:3", false);
      assert.equal(killed.signal, "SIGKILL");
      const stateBefore = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(stateBefore.deletes.length, 4);
      assert.equal(new Set(stateBefore.deletes).size, 4);
      const anchorPath = join(
        current.receiptDirectory,
        DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_NAME,
      );
      privateWrite(anchorPath, anchorBytes);
      const info = lstatSync(anchorPath);
      const refused = run("none", true);
      assert.equal(refused.status, 1);
      assert.match(
        refused.stderr,
        /DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_TERMINAL_ANCHOR_INVALID/u,
      );
      const after = lstatSync(anchorPath);
      assert.equal(after.dev, info.dev);
      assert.equal(after.ino, info.ino);
      assert.deepEqual(readFileSync(anchorPath), anchorBytes);
      assert.deepEqual(
        JSON.parse(readFileSync(statePath, "utf8")).deletes,
        stateBefore.deletes,
      );
    } finally {
      dispose(current);
    }
  }
});
