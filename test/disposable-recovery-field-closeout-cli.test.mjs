import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DisposableRecoveryFieldCloseoutCliError,
  disposableRecoveryFieldCloseoutHelp,
  executeDisposableRecoveryFieldCloseout,
  main,
  parseDisposableRecoveryFieldCloseoutArguments,
} from "../operations/disposable-recovery-field-closeout-cli.mjs";
import {
  disposableRecoveryFieldCloseoutApprovalFingerprint,
} from "../operations/disposable-recovery-field-closeout.mjs";
import {
  CLOSEOUT_FIXTURE_REFERENCES,
  cloneDisposableRecoveryCloseoutFixture,
  createDisposableRecoveryCloseoutFixture,
  createInMemoryCloseoutRuntime,
} from "./helpers/disposable-recovery-closeout-fixture.mjs";
import {
  registerNextTestDisposableRecoveryFieldCloseoutRuntime,
} from "./helpers/disposable-recovery-closeout-keychain.mjs";

if (process.platform === "win32") {
  test("macOS-only disposable recovery field closeout CLI suite", {
    skip: "private aggregate receipt DACL proof is intentionally unavailable on Windows",
  }, () => {});
} else {

const CLI = fileURLToPath(new URL(
  "../operations/disposable-recovery-field-closeout-cli.mjs",
  import.meta.url,
));
const BASE = await createDisposableRecoveryCloseoutFixture({
  prefix: "brain-v048-closeout-cli-base-",
});
const createdRoots = new Set([BASE.root]);
process.once("exit", () => {
  for (const root of createdRoots) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { /* owner-private test fixture */ }
  }
});

function cliError(code) {
  return (error) => error instanceof DisposableRecoveryFieldCloseoutCliError &&
    error.code === code;
}

async function fixture(prefix = "brain-v048-closeout-cli-") {
  const value = await cloneDisposableRecoveryCloseoutFixture(BASE, { prefix });
  createdRoots.add(value.root);
  return value;
}

function dispose(value) {
  rmSync(value.root, { recursive: true, force: true });
  createdRoots.delete(value.root);
}

function argumentsFor(value, command, {
  approvalFingerprint = null,
  resume = false,
} = {}) {
  const options = value.readerOptions;
  const argv = [
    command,
    "--account-id", options.accountId,
    "--receipt-directory", options.expectedReceiptDirectory,
    "--source-manifest", options.sourceManifestPath,
    "--target-manifest", options.targetManifestPath,
    "--plan", options.planPath,
    "--state", options.statePath,
    "--artifact-directory", options.artifactDirectory,
    "--wrangler-wrapper", options.wranglerWrapperPath,
    "--golden", options.goldenPath,
    "--field-receipt", options.fieldReceiptPath,
    "--package", options.packagePath,
  ];
  if (command === "execute") {
    argv.push(
      "--approve-a17",
      approvalFingerprint,
      "--maintenance-window-confirmed",
    );
    if (resume) argv.push("--resume");
  }
  return argv;
}

test("parser, help, and direct entry point expose no operational injection", async () => {
  const help = disposableRecoveryFieldCloseoutHelp().join("\n");
  assert.match(help, /encrypted provenance artifact/u);
  assert.match(help, /permanent terminal anchor/u);
  assert.match(help, /held and uncertified/u);
  assert.match(help, /no field or live proof/u);
  assert.doesNotMatch(help, /\bcrypto\b/iu);
  assert.doesNotMatch(help, /--(?:token|admin-key|artifact-key|bank-key)\b/iu);
  assert.deepEqual(
    parseDisposableRecoveryFieldCloseoutArguments(["--help"]),
    { command: "help" },
  );
  assert.throws(
    () => parseDisposableRecoveryFieldCloseoutArguments(["preview"]),
    cliError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID"),
  );
  assert.throws(
    () => parseDisposableRecoveryFieldCloseoutArguments([
      "preview", "--token", "fixture-secret",
    ]),
    cliError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_OPTION_INVALID"),
  );
  await assert.rejects(
    () => executeDisposableRecoveryFieldCloseout({ command: "help" }, {}),
    cliError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID"),
  );
  await assert.rejects(
    () => main(["--help"], { keychain: {} }),
    cliError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_ARGUMENTS_INVALID"),
  );

  let stdout = "";
  const result = await main(["--help"], {
    stdout: (value) => { stdout += value; },
    stderr: () => assert.fail("help must not emit stderr"),
  });
  assert.deepEqual(result, { help: true });
  assert.equal(stdout, `${help}\n`);

  const direct = spawnSync(process.execPath, [CLI, "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, `${help}\n`);
  assert.equal(direct.stderr, "");
});

test("CLI preview mints genuine evidence and returns only sanitized A17 authority", async () => {
  const current = await fixture();
  try {
    const explicitSentinel = "private-client-explicit-sentinel.tgz";
    const artifactSentinel = "private-client-artifact-sentinel.bin";
    const movedPackage = join(current.explicitDirectory, explicitSentinel);
    renameSync(current.explicit.package, movedPackage);
    writeFileSync(
      join(current.artifactDirectory, artifactSentinel),
      "private artifact sentinel\n",
      { mode: 0o600 },
    );
    const withSentinels = Object.freeze({
      ...current,
      readerOptions: Object.freeze({
        ...current.readerOptions,
        packagePath: movedPackage,
      }),
    });
    const runtime = createInMemoryCloseoutRuntime(current);
    registerNextTestDisposableRecoveryFieldCloseoutRuntime(runtime);
    const result = await executeDisposableRecoveryFieldCloseout(
      argumentsFor(withSentinels, "preview"),
    );
    assert.equal(result.action, "A17");
    assert.equal(result.status, "ready_for_separate_approval");
    assert.equal(result.keychain_mutation, false);
    assert.equal(result.provider_mutation, false);
    assert.equal(result.retained_evidence_deleted, false);
    assert.equal(result.campaign_items_present, 4);
    assert.match(result.a17_approval_fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(runtime.events.some(([event]) => event === "delete"), false);
    const serialized = JSON.stringify(result);
    for (const value of runtime.values.values()) {
      assert.equal(serialized.includes(value.toString("base64")), false);
      assert.equal(serialized.includes(value.toString("utf8")), false);
    }
    for (const reference of CLOSEOUT_FIXTURE_REFERENCES) {
      assert.equal(serialized.includes(reference), false);
    }
    assert.equal(serialized.includes(explicitSentinel), false);
    assert.equal(serialized.includes(artifactSentinel), false);
  } finally {
    dispose(current);
  }
});

test("CLI execute returns the anchor hash and the third run performs zero mutations", async () => {
  const current = await fixture();
  try {
    const approval = await disposableRecoveryFieldCloseoutApprovalFingerprint(
      current.evidenceCapability,
    );
    const firstRuntime = createInMemoryCloseoutRuntime(current);
    registerNextTestDisposableRecoveryFieldCloseoutRuntime(firstRuntime);
    let stdout = "";
    let stderr = "";
    const completed = await main(argumentsFor(current, "execute", {
      approvalFingerprint: approval,
    }), {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), completed);
    assert.equal(completed.status, "closed");
    assert.match(completed.receipt_sha256, /^[a-f0-9]{64}$/u);
    assert.match(completed.terminal_anchor_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(firstRuntime.events.filter(([event]) => event === "delete").length, 4);

    const thirdRuntime = createInMemoryCloseoutRuntime(current, {
      states: Array(4).fill("item_not_found"),
    });
    registerNextTestDisposableRecoveryFieldCloseoutRuntime(thirdRuntime);
    const repeated = await executeDisposableRecoveryFieldCloseout(
      argumentsFor(current, "execute", { approvalFingerprint: approval }),
    );
    assert.equal(repeated.receipt_sha256, completed.receipt_sha256);
    assert.equal(
      repeated.terminal_anchor_sha256,
      completed.terminal_anchor_sha256,
    );
    assert.equal(thirdRuntime.events.some(([event]) => event === "delete"), false);
  } finally {
    dispose(current);
  }
});

test("CLI refuses wrong approval and nested residue before constructing Keychain", async () => {
  const wrongApproval = await fixture();
  const residue = await fixture();
  try {
    await assert.rejects(
      () => executeDisposableRecoveryFieldCloseout(
        argumentsFor(wrongApproval, "execute", {
          approvalFingerprint: "0".repeat(64),
        }),
      ),
      cliError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_APPROVAL_INVALID"),
    );

    const residueDirectory = join(
      residue.artifactDirectory,
      "retained",
      ".brain-recovery-runtime-fixture",
      "tail",
    );
    mkdirSync(residueDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(residueDirectory, "bytes"), "fixture\n", { mode: 0o600 });
    await assert.rejects(
      () => executeDisposableRecoveryFieldCloseout(
        argumentsFor(residue, "preview"),
      ),
      cliError("DISPOSABLE_RECOVERY_FIELD_CLOSEOUT_CLI_EVIDENCE_INVALID"),
    );
    assert.equal(
      readFileSync(join(residueDirectory, "bytes"), "utf8"),
      "fixture\n",
    );
  } finally {
    dispose(wrongApproval);
    dispose(residue);
  }
});

}
