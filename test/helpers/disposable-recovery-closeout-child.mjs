import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

import {
  disposableRecoveryFieldCloseoutApprovalFingerprint,
  readDisposableRecoveryFieldCloseoutEvidence,
  runDisposableRecoveryFieldCloseout,
} from "../../operations/disposable-recovery-field-closeout.mjs";
import {
  registerTestDisposableRecoveryFieldCloseoutRuntime,
} from "./disposable-recovery-closeout-keychain.mjs";
import {
  CLOSEOUT_FIXTURE_ACCOUNT_ID,
  CLOSEOUT_FIXTURE_REFERENCES,
} from "./disposable-recovery-closeout-fixture.mjs";

function persist(path, state) {
  const staged = `${path}.next`;
  writeFileSync(staged, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const descriptor = openSync(staged, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(staged, path);
}

const [descriptorPath, statePath, killStage = "none", resumeValue = "false"] =
  process.argv.slice(2);
if (!descriptorPath || !statePath || !["true", "false"].includes(resumeValue)) {
  process.exitCode = 2;
} else {
  const readerOptions = JSON.parse(readFileSync(descriptorPath, "utf8"));
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const save = () => persist(statePath, state);
  const kill = (stage) => {
    if (killStage !== stage || state.killed_stages.includes(stage)) return;
    state.killed_stages.push(stage);
    save();
    process.kill(process.pid, "SIGKILL");
  };
  const reference = (locator) => locator?.reference;
  const capability = await readDisposableRecoveryFieldCloseoutEvidence(
    readerOptions,
  );
  const runtime = {
    implementation: {
      async inspect(locator) {
        const index = CLOSEOUT_FIXTURE_REFERENCES.indexOf(reference(locator));
        if (index < 0) throw new Error("unexpected fixture locator");
        return state.statuses[index];
      },
      async read(locator) {
        const index = CLOSEOUT_FIXTURE_REFERENCES.indexOf(reference(locator));
        if (index < 0) throw new Error("unexpected fixture locator");
        return state.statuses[index] === "item_not_found"
          ? null
          : Buffer.from(state.values[index], "base64");
      },
      async delete(locator) {
        const index = CLOSEOUT_FIXTURE_REFERENCES.indexOf(reference(locator));
        if (index < 0 || state.statuses[index] !== "present") {
          throw new Error("unexpected fixture delete");
        }
        state.statuses[index] = "item_not_found";
        state.deletes.push(CLOSEOUT_FIXTURE_REFERENCES[index]);
        save();
        kill("deletion:post_delete");
        return true;
      },
      async sharedTokenPresent() {
        state.shared_token_checks += 1;
        save();
        return true;
      },
    },
    now: () => new Date("2026-09-13T13:05:00.000Z"),
    onDeletionTransition: async ({ state: transition, item_index: itemIndex }) => {
      kill(`deletion:${transition}`);
      kill(`deletion:${transition}:${itemIndex}`);
    },
    onAnchorTransition: (transition) => kill(transition),
    onFinalizationTransition: (transition) => kill(transition),
  };
  registerTestDisposableRecoveryFieldCloseoutRuntime(capability, runtime);
  const approvalFingerprint =
    await disposableRecoveryFieldCloseoutApprovalFingerprint(capability);
  const result = await runDisposableRecoveryFieldCloseout({
    evidenceCapability: capability,
    approvalFingerprint,
    resume: resumeValue === "true",
  });
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    status: result.receipt.status,
    receipt_sha256: result.receiptSha256,
    terminal_anchor_sha256: result.terminalAnchorSha256,
    deletes: state.deletes.length,
    account_fingerprint_present: typeof CLOSEOUT_FIXTURE_ACCOUNT_ID === "string",
  })}\n`);
}
