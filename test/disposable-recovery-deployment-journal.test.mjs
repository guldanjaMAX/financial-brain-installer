import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
  DisposableRecoveryDeploymentJournalError,
  disposableRecoveryDeploymentJournalSha256,
  readDisposableRecoveryDeploymentJournal,
  runJournaledDisposableRecoveryDeploymentMutation,
  summarizeDisposableRecoveryDeploymentJournal,
} from "../operations/disposable-recovery-deployment-journal.mjs";

const journalTest = process.platform === "win32" ? test.skip : test;
const VERSION_ID = "10000000-0000-4000-8000-000000000001";
const DEPLOYMENT_ID = "40000000-0000-4000-8000-000000000004";
const RESPONSE_SHA256 = "c".repeat(64);

function providerMetadata(overrides = {}) {
  return {
    schema_version: 1,
    status: 200,
    content_type: "application/json",
    body_sha256: RESPONSE_SHA256,
    ...overrides,
  };
}

function privateDirectory(prefix = "brain-deployment-journal-") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(directory, 0o700);
  return directory;
}

function fixture(prefix) {
  const directory = privateDirectory(prefix);
  return {
    directory,
    journalPath: join(directory, "deployment-journal.jsonl"),
  };
}

function binding(overrides = {}) {
  return {
    schema_version: 1,
    approval_fingerprint: "a".repeat(64),
    account_id: "must-not-be-persisted-account",
    manifest_path: "/must/not/be/persisted/manifest.json",
    ...overrides,
  };
}

function uploadRequest(overrides = {}) {
  return {
    operation: "upload_version",
    package_sha256: "b".repeat(64),
    body_sha256: "d".repeat(64),
    module_inventory_sha256: "e".repeat(64),
    body_bytes: 42,
    account_id: "must-not-be-persisted-request-account",
    path: "/must/not/be/persisted/source.js",
    ...overrides,
  };
}

function uploadOptions(target, overrides = {}) {
  return {
    journalPath: target.journalPath,
    expectedJournalDirectory: target.directory,
    phase: "source",
    step: "upload_active_version",
    effect: "create_worker_version",
    binding: binding(),
    request: uploadRequest(),
    mutate: async () => ({ provider_response: "unvalidated" }),
    validate: async () => ({
      provider_metadata: providerMetadata(),
      result: { version_id: VERSION_ID },
    }),
    ...overrides,
  };
}

function deploymentOptions(target, overrides = {}) {
  return {
    journalPath: target.journalPath,
    expectedJournalDirectory: target.directory,
    phase: "source",
    step: "deploy_active_version",
    effect: "replace_worker_deployment",
    binding: binding(),
    request: {
      operation: "deploy_version",
      version_id: VERSION_ID,
      percentage: 100,
    },
    mutate: async () => ({ provider_response: "unvalidated" }),
    validate: async () => ({
      provider_metadata: providerMetadata(),
      result: {
        accepted: true,
        deployment_id: DEPLOYMENT_ID,
        version_id: VERSION_ID,
      },
    }),
    ...overrides,
  };
}

function journalError(code) {
  return (error) => {
    assert.equal(error instanceof DisposableRecoveryDeploymentJournalError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function readJournal(target) {
  return readDisposableRecoveryDeploymentJournal(target.journalPath, {
    expectedJournalDirectory: target.directory,
  });
}

journalTest("a durable sent-unconfirmed record precedes mutation and confirmed replay is local", async () => {
  const target = fixture("brain-deployment-journal-success-");
  const events = [];
  let mutationCalls = 0;
  let validationCalls = 0;
  const options = uploadOptions(target, {
    mutate: async (request) => {
      mutationCalls += 1;
      events.push("mutate");
      assert.equal(Object.isFrozen(request), true);
      const leaseInfo = lstatSync(`${target.journalPath}.lease`);
      assert.equal(leaseInfo.nlink, 1);
      assert.equal(leaseInfo.mode & 0o777, 0o600);
      const beforeMutation = readJournal(target);
      assert.equal(beforeMutation.length, 1);
      assert.equal(beforeMutation[0].record_type, "prepared");
      assert.equal(beforeMutation[0].effect_state, "sent_unconfirmed");
      return {
        token: "raw-provider-token-must-not-persist",
        raw_body: "raw-provider-body-must-not-persist",
        account_id: "raw-provider-account-must-not-persist",
        version: VERSION_ID,
      };
    },
    validate: async (raw) => {
      validationCalls += 1;
      events.push("validate");
      assert.equal(raw.version, VERSION_ID);
      assert.equal(readJournal(target).length, 1,
        "confirmation must follow successful validation");
      return {
        provider_metadata: providerMetadata(),
        result: { version_id: raw.version },
      };
    },
  });
  try {
    const result = await runJournaledDisposableRecoveryDeploymentMutation(options);
    assert.deepEqual(result, { version_id: VERSION_ID });
    assert.deepEqual(events, ["mutate", "validate"]);
    assert.equal(mutationCalls, 1);
    assert.equal(validationCalls, 1);
    assert.equal(existsSync(`${target.journalPath}.lease`), false);

    const records = readJournal(target);
    assert.equal(records.length, 2);
    assert.equal(records[0].record_type, "prepared");
    assert.equal(records[1].record_type, "confirmed");
    assert.equal(records[1].effect_state, "confirmed");
    assert.deepEqual(records[1].provider_metadata, providerMetadata());
    assert.deepEqual(records[1].result, { version_id: VERSION_ID });
    assert.match(records[0].binding_sha256, /^[a-f0-9]{64}$/u);
    assert.match(records[0].request_sha256, /^[a-f0-9]{64}$/u);
    assert.match(records[1].result_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(records), true);

    const bytes = readFileSync(target.journalPath, "utf8");
    assert.equal(bytes.endsWith("\n"), true);
    for (const forbidden of [
      "must-not-be-persisted",
      "raw-provider-token",
      "raw-provider-body",
      "raw-provider-account",
      "manifest.json",
      "source.js",
    ]) {
      assert.equal(bytes.includes(forbidden), false);
    }
    const info = lstatSync(target.journalPath);
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(lstatSync(target.directory).mode & 0o077, 0);
    if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid());

    const replay = await runJournaledDisposableRecoveryDeploymentMutation({
      ...options,
      mutate: async () => {
        mutationCalls += 1;
        throw new Error("must-not-run");
      },
      validate: async () => {
        validationCalls += 1;
        throw new Error("must-not-run");
      },
    });
    assert.deepEqual(replay, { version_id: VERSION_ID });
    assert.equal(mutationCalls, 1);
    assert.equal(validationCalls, 1);
    assert.equal(readJournal(target).length, 2);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("one immutable canonical snapshot survives post-validation input mutation", async () => {
  const target = fixture("brain-deployment-journal-snapshot-");
  const originalBinding = binding();
  const originalRequest = uploadRequest({ labels: ["active", "semantic"] });
  const mutableBinding = structuredClone(originalBinding);
  const mutableRequest = structuredClone(originalRequest);
  let providerRequest;
  try {
    const result = await runJournaledDisposableRecoveryDeploymentMutation(
      uploadOptions(target, {
        binding: mutableBinding,
        request: mutableRequest,
        mutate: async (request) => {
          providerRequest = request;
          assert.equal(Object.isFrozen(request), true);
          assert.equal(Object.isFrozen(request.labels), true);
          return { version: VERSION_ID };
        },
        validate: async (raw) => {
          mutableBinding.approval_fingerprint = "f".repeat(64);
          mutableRequest.package_sha256 = "f".repeat(64);
          mutableRequest.labels[0] = "changed-after-provider";
          return {
            provider_metadata: providerMetadata(),
            result: { version_id: raw.version },
          };
        },
      }),
    );
    assert.deepEqual(result, { version_id: VERSION_ID });
    assert.deepEqual(providerRequest, originalRequest);
    const records = readJournal(target);
    assert.equal(
      records[0].binding_sha256,
      disposableRecoveryDeploymentJournalSha256(originalBinding),
    );
    assert.equal(
      records[0].request_sha256,
      disposableRecoveryDeploymentJournalSha256(originalRequest),
    );

    const replay = await runJournaledDisposableRecoveryDeploymentMutation(
      uploadOptions(target, {
        binding: originalBinding,
        request: originalRequest,
        mutate: async () => { throw new Error("must-not-run"); },
      }),
    );
    assert.deepEqual(replay, { version_id: VERSION_ID });
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("accessors, proxies, and raw or secret-bearing semantic fields are refused", async () => {
  const target = fixture("brain-deployment-journal-input-boundary-");
  let mutationCalls = 0;
  try {
    let getterCalls = 0;
    const accessorArray = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "must-not-be-read";
      },
    });
    accessorArray.length = 1;
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
        request: uploadRequest({ labels: accessorArray }),
        mutate: async () => { mutationCalls += 1; },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID"),
    );
    assert.equal(getterCalls, 0);

    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
        request: new Proxy(uploadRequest(), {}),
        mutate: async () => { mutationCalls += 1; },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CANONICAL_INVALID"),
    );

    for (const field of [
      "token",
      "apiToken",
      "authorization",
      "cookie",
      "passkey",
      "passKey",
      "body",
      "raw_body",
      "request_body",
      "content",
      "module_content",
      "bytes",
      "buffer",
      "raw",
      "modules",
      "headers",
      "environment",
      "argv",
    ]) {
      await assert.rejects(
        runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
          request: uploadRequest({ nested: { [field]: "synthetic-refused-value" } }),
          mutate: async () => { mutationCalls += 1; },
        })),
        journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SENSITIVE_INPUT_REFUSED"),
        field,
      );
    }
    for (const request of [
      uploadRequest({ body_sha256: "not-a-sha256" }),
      uploadRequest({ body_bytes: -1 }),
    ]) {
      await assert.rejects(
        runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
          request,
          mutate: async () => { mutationCalls += 1; },
        })),
        journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SENSITIVE_INPUT_REFUSED"),
      );
    }
    assert.equal(mutationCalls, 0);
    assert.equal(existsSync(target.journalPath), false);
    assert.equal(existsSync(`${target.journalPath}.lease`), false);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("an exclusive private lease serializes mutations and is removed after confirmation", async () => {
  const target = fixture("brain-deployment-journal-lease-");
  let enterMutation;
  let finishMutation;
  const entered = new Promise((resolve) => { enterMutation = resolve; });
  const finish = new Promise((resolve) => { finishMutation = resolve; });
  let secondMutationCalls = 0;
  const first = runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
    mutate: async () => {
      enterMutation();
      await finish;
      return { version: VERSION_ID };
    },
    validate: async (raw) => ({
      provider_metadata: providerMetadata(),
      result: { version_id: raw.version },
    }),
  }));
  try {
    await entered;
    const leasePath = `${target.journalPath}.lease`;
    const leaseInfo = lstatSync(leasePath);
    assert.equal(leaseInfo.mode & 0o777, 0o600);
    assert.equal(leaseInfo.nlink, 1);
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
        mutate: async () => {
          secondMutationCalls += 1;
          return {};
        },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_LEASE_HELD"),
    );
    assert.equal(secondMutationCalls, 0);
    finishMutation();
    assert.deepEqual(await first, { version_id: VERSION_ID });
    assert.equal(existsSync(leasePath), false);
  } finally {
    finishMutation?.();
    await first.catch(() => {});
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("an inode-replaced lease is not unlinked and leaves the effect ambiguous", async () => {
  const target = fixture("brain-deployment-journal-lease-replaced-");
  const leasePath = `${target.journalPath}.lease`;
  try {
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
        mutate: async () => {
          rmSync(leasePath);
          writeFileSync(leasePath, "replacement-owner-file\n", { mode: 0o600 });
          chmodSync(leasePath, 0o600);
          return { version: VERSION_ID };
        },
        validate: async (raw) => ({
          provider_metadata: providerMetadata(),
          result: { version_id: raw.version },
        }),
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS"),
    );
    assert.equal(readFileSync(leasePath, "utf8"), "replacement-owner-file\n");
    const records = readJournal(target);
    assert.equal(records.length, 1);
    assert.equal(records[0].record_type, "prepared");
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("a prepared mutation remains ambiguous and is never called again", async () => {
  const target = fixture("brain-deployment-journal-ambiguous-");
  let mutationCalls = 0;
  let validationCalls = 0;
  const options = uploadOptions(target, {
    mutate: async () => {
      mutationCalls += 1;
      throw new Error("lost-response-with-possibly-committed-effect");
    },
    validate: async () => {
      validationCalls += 1;
      return {
        provider_metadata: providerMetadata(),
        result: { version_id: VERSION_ID },
      };
    },
  });
  try {
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(options),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS"),
    );
    assert.equal(mutationCalls, 1);
    assert.equal(validationCalls, 0);
    assert.equal(readJournal(target).length, 1);
    assert.throws(
      () => summarizeDisposableRecoveryDeploymentJournal(target.journalPath, {
        expectedJournalDirectory: target.directory,
        expectedPhase: "source",
        expectedBinding: binding(),
      }),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_INCOMPLETE"),
    );

    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation({
        ...options,
        mutate: async () => {
          mutationCalls += 1;
          return {};
        },
      }),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS"),
    );
    assert.equal(mutationCalls, 1);

    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation({
        ...options,
        request: uploadRequest({ package_sha256: "c".repeat(64) }),
      }),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT"),
    );
    assert.equal(mutationCalls, 1);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("phase, binding, request, effect, and step order conflicts call no provider", async () => {
  const target = fixture("brain-deployment-journal-conflict-");
  let mutationCalls = 0;
  const initial = uploadOptions(target, {
    mutate: async () => {
      mutationCalls += 1;
      return { version: VERSION_ID };
    },
    validate: async (raw) => ({
      provider_metadata: providerMetadata(),
      result: { version_id: raw.version },
    }),
  });
  try {
    await runJournaledDisposableRecoveryDeploymentMutation(initial);
    assert.equal(mutationCalls, 1);

    const conflicts = [
      { request: uploadRequest({ package_sha256: "c".repeat(64) }) },
      { binding: binding({ approval_fingerprint: "d".repeat(64) }) },
      {
        phase: "target",
        step: "upload_paused_version",
        effect: "create_worker_version",
      },
    ];
    for (const conflict of conflicts) {
      await assert.rejects(
        runJournaledDisposableRecoveryDeploymentMutation({
          ...initial,
          ...conflict,
          mutate: async () => {
            mutationCalls += 1;
            return {};
          },
        }),
        journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT"),
      );
    }
    assert.equal(mutationCalls, 1);

    const outOfOrder = fixture("brain-deployment-journal-order-");
    try {
      await assert.rejects(
        runJournaledDisposableRecoveryDeploymentMutation(deploymentOptions(outOfOrder, {
          mutate: async () => {
            mutationCalls += 1;
            return {};
          },
        })),
        journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT"),
      );
      assert.equal(mutationCalls, 1);
    } finally {
      rmSync(outOfOrder.directory, { recursive: true, force: true });
    }

    const deployment = await runJournaledDisposableRecoveryDeploymentMutation(
      deploymentOptions(target, {
        mutate: async () => {
          mutationCalls += 1;
          return { accepted: "raw" };
        },
      }),
    );
    assert.deepEqual(deployment, {
      accepted: true,
      deployment_id: DEPLOYMENT_ID,
      version_id: VERSION_ID,
    });
    assert.equal(mutationCalls, 2);
    assert.deepEqual(readJournal(target).map((record) => record.sequence), [1, 2, 3, 4]);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("a complete phase exposes domain-separated full-prefix and event-manifest digests", async () => {
  const target = fixture("brain-deployment-journal-summary-");
  const bindingValue = binding();
  try {
    await runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
      binding: bindingValue,
    }));
    await runJournaledDisposableRecoveryDeploymentMutation(deploymentOptions(target, {
      binding: bindingValue,
    }));
    const records = readJournal(target);
    const summary = summarizeDisposableRecoveryDeploymentJournal(target.journalPath, {
      expectedJournalDirectory: target.directory,
      expectedPhase: "source",
      expectedBinding: bindingValue,
    });
    assert.equal(Object.isFrozen(summary), true);
    assert.deepEqual({
      schema_version: summary.schema_version,
      protocol: summary.protocol,
      journal_protocol: summary.journal_protocol,
      phase: summary.phase,
      through_sequence: summary.through_sequence,
      event_count: summary.event_count,
    }, {
      schema_version: 1,
      protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
      journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
      phase: "source",
      through_sequence: 4,
      event_count: 4,
    });
    const expectedEvents = [
      {
        sequence: 1,
        record_type: "prepared",
        effect_state: "sent_unconfirmed",
        step: "upload_active_version",
        effect: "create_worker_version",
      },
      {
        sequence: 2,
        record_type: "confirmed",
        effect_state: "confirmed",
        step: "upload_active_version",
        effect: "create_worker_version",
      },
      {
        sequence: 3,
        record_type: "prepared",
        effect_state: "sent_unconfirmed",
        step: "deploy_active_version",
        effect: "replace_worker_deployment",
      },
      {
        sequence: 4,
        record_type: "confirmed",
        effect_state: "confirmed",
        step: "deploy_active_version",
        effect: "replace_worker_deployment",
      },
    ];
    const expectedManifestSha256 = disposableRecoveryDeploymentJournalSha256({
      schema_version: 1,
      digest_type: "event_manifest",
      summary_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
      journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
      phase: "source",
      event_count: 4,
      events: expectedEvents,
    });
    const expectedHeadSha256 = disposableRecoveryDeploymentJournalSha256({
      schema_version: 1,
      digest_type: "ordered_record_prefix",
      summary_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
      journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
      phase: "source",
      binding_sha256: summary.binding_sha256,
      through_sequence: 4,
      event_count: 4,
      records,
    });
    assert.equal(summary.event_manifest_sha256, expectedManifestSha256);
    assert.equal(summary.head_sha256, expectedHeadSha256);
    assert.notEqual(
      summary.head_sha256,
      disposableRecoveryDeploymentJournalSha256(records.at(-1)),
    );
    const alteredPrefix = structuredClone(records);
    alteredPrefix[0].request_sha256 = "f".repeat(64);
    assert.notEqual(
      summary.head_sha256,
      disposableRecoveryDeploymentJournalSha256({
        schema_version: 1,
        digest_type: "ordered_record_prefix",
        summary_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_SUMMARY_PROTOCOL,
        journal_protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_PROTOCOL,
        phase: "source",
        binding_sha256: summary.binding_sha256,
        through_sequence: 4,
        event_count: 4,
        records: alteredPrefix,
      }),
    );
    assert.equal(existsSync(`${target.journalPath}.lease`), false);

    assert.throws(
      () => summarizeDisposableRecoveryDeploymentJournal(target.journalPath, {
        expectedJournalDirectory: target.directory,
        expectedPhase: "source",
        expectedBinding: binding({ approval_fingerprint: "f".repeat(64) }),
      }),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_CONFLICT"),
    );
    assert.equal(existsSync(`${target.journalPath}.lease`), false);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("invalid sanitized output leaves only the ambiguous prepared record", async () => {
  const target = fixture("brain-deployment-journal-invalid-result-");
  let mutationCalls = 0;
  try {
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
        mutate: async () => {
          mutationCalls += 1;
          return {
            version: VERSION_ID,
            token: "raw-token-that-must-not-persist",
          };
        },
        validate: async (raw) => ({
          provider_metadata: providerMetadata({
            raw_body: "forbidden-extra-provider-field",
          }),
          result: {
            version_id: raw.version,
            account_id: "forbidden-extra-result-field",
          },
        }),
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_AMBIGUOUS"),
    );
    assert.equal(mutationCalls, 1);
    const records = readJournal(target);
    assert.equal(records.length, 1);
    assert.equal(records[0].effect_state, "sent_unconfirmed");
    const bytes = readFileSync(target.journalPath, "utf8");
    assert.equal(bytes.includes("raw-token-that-must-not-persist"), false);
    assert.equal(bytes.includes("forbidden-extra"), false);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("malformed, truncated, extra, and tampered records refuse before mutation", async () => {
  const variants = [
    {
      name: "truncated",
      change(bytes) { return bytes.slice(0, -1); },
    },
    {
      name: "extra-field",
      change(bytes) {
        const lines = bytes.trimEnd().split("\n");
        lines[0] = lines[0].replace("{", "{\"account_id\":\"forbidden\",");
        return `${lines.join("\n")}\n`;
      },
    },
    {
      name: "extra-record",
      change(bytes) {
        const lines = bytes.trimEnd().split("\n");
        return `${lines.join("\n")}\n${lines[0]}\n`;
      },
    },
    {
      name: "result-hash",
      change(bytes) {
        const lines = bytes.trimEnd().split("\n");
        const confirmed = JSON.parse(lines[1]);
        const prior = confirmed.result_sha256;
        const changed = `${prior[0] === "0" ? "1" : "0"}${prior.slice(1)}`;
        lines[1] = lines[1].replace(
          `\"result_sha256\":\"${prior}\"`,
          `\"result_sha256\":\"${changed}\"`,
        );
        return `${lines.join("\n")}\n`;
      },
    },
  ];

  for (const variant of variants) {
    const target = fixture(`brain-deployment-journal-${variant.name}-`);
    let mutationCalls = 0;
    const options = uploadOptions(target, {
      mutate: async () => {
        mutationCalls += 1;
        return { version: VERSION_ID };
      },
      validate: async (raw) => ({
        provider_metadata: providerMetadata(),
        result: { version_id: raw.version },
      }),
    });
    try {
      await runJournaledDisposableRecoveryDeploymentMutation(options);
      assert.equal(mutationCalls, 1);
      const changed = variant.change(readFileSync(target.journalPath, "utf8"));
      writeFileSync(target.journalPath, changed, { mode: 0o600 });
      chmodSync(target.journalPath, 0o600);
      assert.throws(
        () => readJournal(target),
        journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED"),
        variant.name,
      );
      await assert.rejects(
        runJournaledDisposableRecoveryDeploymentMutation(options),
        journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_MALFORMED"),
        variant.name,
      );
      assert.equal(mutationCalls, 1);
    } finally {
      rmSync(target.directory, { recursive: true, force: true });
    }
  }
});

journalTest("unsafe directory, file mode, symlink, and hard link refuse before mutation", async () => {
  let mutationCalls = 0;
  const unsafeDirectory = fixture("brain-deployment-journal-open-dir-");
  try {
    chmodSync(unsafeDirectory.directory, 0o755);
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(unsafeDirectory, {
        mutate: async () => { mutationCalls += 1; },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DIRECTORY_REFUSED"),
    );
    assert.equal(mutationCalls, 0);
  } finally {
    chmodSync(unsafeDirectory.directory, 0o700);
    rmSync(unsafeDirectory.directory, { recursive: true, force: true });
  }

  const unsafeFile = fixture("brain-deployment-journal-open-file-");
  try {
    writeFileSync(unsafeFile.journalPath, "{}\n", { mode: 0o640 });
    chmodSync(unsafeFile.journalPath, 0o640);
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(unsafeFile, {
        mutate: async () => { mutationCalls += 1; },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED"),
    );
    assert.equal(mutationCalls, 0);
  } finally {
    rmSync(unsafeFile.directory, { recursive: true, force: true });
  }

  const symlinkFile = fixture("brain-deployment-journal-symlink-");
  try {
    const target = join(symlinkFile.directory, "target.jsonl");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    chmodSync(target, 0o600);
    symlinkSync(target, symlinkFile.journalPath);
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(symlinkFile, {
        mutate: async () => { mutationCalls += 1; },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED"),
    );
    assert.equal(mutationCalls, 0);
  } finally {
    rmSync(symlinkFile.directory, { recursive: true, force: true });
  }

  const hardLinkFile = fixture("brain-deployment-journal-hardlink-");
  try {
    await runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(hardLinkFile));
    linkSync(hardLinkFile.journalPath, join(hardLinkFile.directory, "alias.jsonl"));
    assert.equal(lstatSync(hardLinkFile.journalPath).nlink, 2);
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(hardLinkFile, {
        mutate: async () => { mutationCalls += 1; },
      })),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_FILE_REFUSED"),
    );
    assert.equal(mutationCalls, 0);
  } finally {
    rmSync(hardLinkFile.directory, { recursive: true, force: true });
  }
});

journalTest("public durability dependency overrides are refused before any write", async () => {
  const target = fixture("brain-deployment-journal-dependency-refused-");
  let mutationCalls = 0;
  try {
    await assert.rejects(
      runJournaledDisposableRecoveryDeploymentMutation(uploadOptions(target, {
        mutate: async () => {
          mutationCalls += 1;
          return {};
        },
      }), {
        syncFile() {},
        syncDirectory() { return true; },
      }),
      journalError("DISPOSABLE_RECOVERY_DEPLOYMENT_JOURNAL_DEPENDENCY_INVALID"),
    );
    assert.equal(mutationCalls, 0);
    assert.equal(existsSync(target.journalPath), false);
    assert.equal(existsSync(`${target.journalPath}.lease`), false);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

journalTest("a target journal accepts only its fixed three-step prefix", async () => {
  const target = fixture("brain-deployment-journal-target-");
  const calls = [];
  const common = {
    journalPath: target.journalPath,
    expectedJournalDirectory: target.directory,
    phase: "target",
    binding: binding(),
  };
  const upload = (step, versionId) => ({
    ...common,
    step,
    effect: "create_worker_version",
    request: { operation: "upload_version", mode: step },
    mutate: async () => {
      calls.push(step);
      return { versionId };
    },
    validate: async (raw) => ({
      provider_metadata: providerMetadata(),
      result: { version_id: raw.versionId },
    }),
  });
  const pausedVersion = "20000000-0000-4000-8000-000000000002";
  const activeVersion = "30000000-0000-4000-8000-000000000003";
  try {
    await runJournaledDisposableRecoveryDeploymentMutation(
      upload("upload_paused_version", pausedVersion),
    );
    await runJournaledDisposableRecoveryDeploymentMutation(
      upload("upload_active_version", activeVersion),
    );
    await runJournaledDisposableRecoveryDeploymentMutation({
      ...common,
      step: "deploy_paused_version",
      effect: "replace_worker_deployment",
      request: {
        operation: "deploy_version",
        version_id: pausedVersion,
        percentage: 100,
      },
      mutate: async () => {
        calls.push("deploy_paused_version");
        return { accepted: "raw" };
      },
      validate: async () => ({
        provider_metadata: providerMetadata(),
        result: {
          accepted: true,
          deployment_id: DEPLOYMENT_ID,
          version_id: pausedVersion,
        },
      }),
    });
    assert.deepEqual(calls, [
      "upload_paused_version",
      "upload_active_version",
      "deploy_paused_version",
    ]);
    assert.equal(readJournal(target).length, 6);
    const summary = summarizeDisposableRecoveryDeploymentJournal(target.journalPath, {
      expectedJournalDirectory: target.directory,
      expectedPhase: "target",
      expectedBinding: common.binding,
    });
    assert.equal(summary.through_sequence, 6);
    assert.equal(summary.event_count, 6);
    assert.match(summary.head_sha256, /^[a-f0-9]{64}$/u);
    assert.match(summary.event_manifest_sha256, /^[a-f0-9]{64}$/u);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});
