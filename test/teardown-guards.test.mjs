import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TeardownSafetyError,
  executeProviderChild,
  executeTeardown,
  inspectTeardownProviderProgram,
  inspectTeardownWrapper,
  invokeTeardownWrapper,
  looksDisposable,
  parseCoordinatorArguments,
  protectedListMissing,
  safeTeardownChildEnvironment,
  teardownDecision,
  validateProviderReceipt,
  validateTeardownWrapperProgram,
} from "../scripts/teardown-test-brain.mjs";

const NAME = "brain-test-v048-field-source-recovery-gate-a48f1101";
const TARGET_HASH = createHash("sha256").update(NAME).digest("hex");
const NONCE = "ab".repeat(32);
const NONCE_HASH = createHash("sha256").update(NONCE).digest("hex");
const PROVIDER_PATH = fileURLToPath(new URL("../scripts/teardown-test-brain.mjs", import.meta.url));
const PROVIDER_SOURCE = readFileSync(PROVIDER_PATH, "utf8");
const PROVIDER_HASH = createHash("sha256").update(PROVIDER_SOURCE).digest("hex");
const PROVIDER_PROGRAM = Object.freeze({
  path: PROVIDER_PATH,
  sha256: PROVIDER_HASH,
  program: PROVIDER_SOURCE,
});
const WRAPPER =
  "#!/bin/sh\n" +
  "BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA=\"$(printf '%s' \"${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}\" | /usr/bin/shasum -a 256)\" || exit 126\n" +
  `[ "\${BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA%% *}" = '${PROVIDER_HASH}' ] || exit 126\n` +
  "unset BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA\n" +
  "CLOUDFLARE_API_TOKEN=\"$(/usr/bin/security find-generic-password -a 'brain-test' -s 'cf-api-token' -w)\" || exit 125\n" +
  "[ -n \"$CLOUDFLARE_API_TOKEN\" ] || exit 125\n" +
  "export CLOUDFLARE_API_TOKEN\n" +
  "exec \"${BRAIN_TEARDOWN_NODE:?}\" --input-type=module --eval \"${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}\" -- --provider-snapshot-child \"$@\"\n";
const WRAPPER_HASH = createHash("sha256").update(WRAPPER).digest("hex");
const INSTANCE_SHA256 = Object.freeze({
  account: "11".repeat(32),
  worker: "22".repeat(32),
  d1: "33".repeat(32),
  vectorize: "44".repeat(32),
});

function providerReceipt(before = {
  worker: "present",
  d1: "present",
  vectorize: "present",
}, {
  instanceSha256 = INSTANCE_SHA256,
  providerSha256 = PROVIDER_HASH,
} = {}) {
  return {
    contract_version: 2,
    ok: true,
    operation: "preview",
    target_sha256: TARGET_HASH,
    nonce_sha256: NONCE_HASH,
    provider_sha256: providerSha256,
    account_scope_exact: true,
    instance_sha256: instanceSha256,
    before,
    after: before,
    deleted: 0,
    already_absent: 0,
    absence_verified: false,
  };
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof TeardownSafetyError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function privateDirectory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "brain-teardown-test-"));
  chmodSync(root, 0o700);
  return root;
}

test("only exact lower-case brain-test resource names are disposable", () => {
  for (const name of [
    "brain-test",
    "brain-test-run-1",
    "brain-test-v048-field-target-recovery-gate-a48f1102",
  ]) {
    assert.equal(looksDisposable(name), true, name);
  }
  for (const name of [
    "test-scratch",
    "TEST-UPPER",
    "Brain-test-run-1",
    "brain-test-",
    "brain-test--run",
    "brain-test_run",
    "my-production-testbed",
    "latest-greatest",
    "owner-latest-backup",
    "protest-archive",
    "financial-brain-partner-preview-brain",
    "owner-brain-shadow",
    "client-brain",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(looksDisposable(name), false, String(name));
  }
});

test("the protected lock is mandatory and decisions never echo private prefixes", () => {
  assert.equal(protectedListMissing(""), true);
  assert.equal(protectedListMissing(undefined), true);
  assert.equal(protectedListMissing("  , ,, "), true);
  assert.equal(protectedListMissing("owner-brain"), false);
  assert.equal(protectedListMissing("bad prefix with spaces"), true);

  const allowed = teardownDecision(NAME, { protectedPrefixes: ["owner-brain"] });
  assert.deepEqual(allowed, { allowed: true, reason: "allowed" });
  const refused = teardownDecision(NAME, { protectedPrefixes: ["brain-test-v048"] });
  assert.deepEqual(refused, { allowed: false, reason: "protected_match" });
  assert.doesNotMatch(JSON.stringify(refused), /brain-test-v048/);
  assert.deepEqual(teardownDecision(NAME, { protectedPrefixes: [] }), {
    allowed: false,
    reason: "protected_lock_missing",
  });
});

test("the wrapper grammar is exactly Keychain lookup, check, export, and child exec", () => {
  assert.equal(validateTeardownWrapperProgram(WRAPPER), true);
  for (const unsafe of [
    WRAPPER + "echo extra\n",
    WRAPPER.replace("/usr/bin/security", "security"),
    WRAPPER.replace("/usr/bin/shasum", "shasum"),
    WRAPPER.replace("-a 'brain-test'", "-a \"$ACCOUNT\""),
    WRAPPER.replace("exec \"${BRAIN_TEARDOWN_NODE:?}\"", "curl https://example.invalid && exec \"${BRAIN_TEARDOWN_NODE:?}\""),
    WRAPPER.replace("$(/usr/bin/security find-generic-password -a 'brain-test' -s 'cf-api-token' -w)", "plaintext-token"),
  ]) {
    assertCode(() => validateTeardownWrapperProgram(unsafe), "TEARDOWN_WRAPPER_UNSAFE");
  }
});

test("wrapper inspection requires a stable owner-only executable outside the checkout", {
  skip: process.platform === "win32",
}, () => {
  const root = privateDirectory();
  try {
    const wrapperPath = join(root, "teardown-wrapper");
    writeFileSync(wrapperPath, WRAPPER, { mode: 0o700 });
    chmodSync(wrapperPath, 0o700);
    const inspected = inspectTeardownWrapper(wrapperPath);
    assert.equal(inspected.path, wrapperPath);
    assert.match(inspected.sha256, /^[a-f0-9]{64}$/);
    assert.equal(inspected.providerSha256, PROVIDER_HASH);
    assert.equal(inspected.program, WRAPPER);

    chmodSync(wrapperPath, 0o755);
    assertCode(() => inspectTeardownWrapper(wrapperPath), "TEARDOWN_WRAPPER_UNSAFE");
    chmodSync(wrapperPath, 0o700);
    const link = join(root, "wrapper-link");
    symlinkSync(wrapperPath, link);
    assertCode(() => inspectTeardownWrapper(link), "TEARDOWN_WRAPPER_UNSAFE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider inspection captures stable owner-only executable bytes", {
  skip: process.platform === "win32",
}, () => {
  const inspected = inspectTeardownProviderProgram(PROVIDER_PATH);
  assert.equal(inspected.path, PROVIDER_PATH);
  assert.equal(inspected.sha256, PROVIDER_HASH);
  assert.equal(inspected.program, PROVIDER_SOURCE);
});

test("the child environment is an allowlist with exact provider bytes and no path or credential", () => {
  const environment = safeTeardownChildEnvironment({
    nonce: NONCE,
    providerProgram: PROVIDER_PROGRAM,
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    "BRAIN_TEARDOWN_NODE",
    "BRAIN_TEARDOWN_PROVIDER_SOURCE",
    "BRAIN_TEARDOWN_WRAPPED_NONCE",
    "LANG",
    "LC_ALL",
    "PATH",
  ]);
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(environment.BRAIN_TEARDOWN_PROVIDER, undefined);
  assert.equal(environment.BRAIN_TEARDOWN_PROVIDER_SOURCE, PROVIDER_SOURCE);
  assert.equal(environment.HOME, undefined);
});

test("wrapper invocation binds name and nonce and discards raw child failures", () => {
  const wrapper = {
    path: "/private/wrapper",
    sha256: WRAPPER_HASH,
    providerSha256: PROVIDER_HASH,
    program: WRAPPER,
  };
  let rawStdout;
  let rawStderr;
  assertCode(() => invokeTeardownWrapper({
    wrapper,
    operation: "preview",
    name: NAME,
    providerProgram: PROVIDER_PROGRAM,
    random: () => Buffer.from(NONCE, "hex"),
    run: ({ wrapperProgram, args, env }) => {
      assert.equal(wrapperProgram, WRAPPER);
      assert.deepEqual(args, ["--operation", "preview", "--name", NAME]);
      assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(env.BRAIN_TEARDOWN_PROVIDER_SOURCE, PROVIDER_SOURCE);
      rawStdout = Buffer.from("account-id resource-id https://api.cloudflare.com");
      rawStderr = Buffer.from("raw provider error secret-token");
      return { status: 1, signal: null, stdout: rawStdout, stderr: rawStderr };
    },
  }), "TEARDOWN_PROVIDER_UNCONFIRMED");
  assert.equal(rawStdout.every((byte) => byte === 0), true);
  assert.equal(rawStderr.every((byte) => byte === 0), true);

  const receipt = invokeTeardownWrapper({
    wrapper,
    operation: "preview",
    name: NAME,
    providerProgram: PROVIDER_PROGRAM,
    random: () => Buffer.from(NONCE, "hex"),
    run: ({ env }) => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(JSON.stringify({
        ...providerReceipt(),
        nonce_sha256: createHash("sha256").update(env.BRAIN_TEARDOWN_WRAPPED_NONCE).digest("hex"),
        provider_sha256: createHash("sha256").update(env.BRAIN_TEARDOWN_PROVIDER_SOURCE).digest("hex"),
      })),
      stderr: Buffer.alloc(0),
    }),
  });
  assert.equal(receipt.before.worker, "present");
});

test("wrapper and provider path swaps cannot replace captured execution bytes", {
  skip: process.platform === "win32",
}, () => {
  const root = privateDirectory();
  try {
    const wrapperPath = join(root, "wrapper");
    const providerPath = join(root, "provider.mjs");
    const providerSource = PROVIDER_SOURCE;
    writeFileSync(wrapperPath, WRAPPER, { mode: 0o700 });
    writeFileSync(providerPath, providerSource, { mode: 0o700 });
    chmodSync(wrapperPath, 0o700);
    chmodSync(providerPath, 0o700);
    const wrapper = inspectTeardownWrapper(wrapperPath);
    const providerProgram = inspectTeardownProviderProgram(providerPath);

    writeFileSync(wrapperPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    writeFileSync(providerPath, "throw new Error('replacement');\n", { mode: 0o700 });

    const receipt = invokeTeardownWrapper({
      wrapper,
      operation: "preview",
      name: NAME,
      providerProgram,
      random: () => Buffer.from(NONCE, "hex"),
      run: ({ wrapperProgram, env }) => {
        assert.equal(wrapperProgram, WRAPPER);
        assert.equal(env.BRAIN_TEARDOWN_PROVIDER_SOURCE, providerSource);
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from(JSON.stringify(providerReceipt(undefined, {
            providerSha256: providerProgram.sha256,
          }))),
          stderr: Buffer.alloc(0),
        };
      },
    });
    assert.equal(receipt.provider_sha256, providerProgram.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the child contract binds provider and exact opaque instance hashes", () => {
  assert.equal(validateProviderReceipt(providerReceipt(), {
    operation: "preview",
    targetSha256: TARGET_HASH,
    nonceSha256: NONCE_HASH,
    providerSha256: PROVIDER_HASH,
  }).ok, true);
  assertCode(() => validateProviderReceipt({
    ...providerReceipt(),
    account_id: "a".repeat(32),
  }, {
    operation: "preview",
    targetSha256: TARGET_HASH,
    nonceSha256: NONCE_HASH,
    providerSha256: PROVIDER_HASH,
  }), "TEARDOWN_PROVIDER_RECEIPT_INVALID");
  assertCode(() => validateProviderReceipt({
    ...providerReceipt(),
    instance_sha256: { ...INSTANCE_SHA256, d1: null },
  }, {
    operation: "preview",
    targetSha256: TARGET_HASH,
    nonceSha256: NONCE_HASH,
    providerSha256: PROVIDER_HASH,
  }), "TEARDOWN_PROVIDER_RECEIPT_INVALID");
  assertCode(() => validateProviderReceipt(providerReceipt(), {
    operation: "preview",
    targetSha256: TARGET_HASH,
    nonceSha256: NONCE_HASH,
    providerSha256: "55".repeat(32),
  }), "TEARDOWN_PROVIDER_RECEIPT_INVALID");
  assertCode(() => validateProviderReceipt({
    ...providerReceipt(),
    operation: "delete",
  }, {
    operation: "delete",
    targetSha256: TARGET_HASH,
    nonceSha256: NONCE_HASH,
    providerSha256: PROVIDER_HASH,
  }), "TEARDOWN_PROVIDER_RECEIPT_INVALID");
});

test("coordinator arguments require preview first and a separate commit receipt", () => {
  assert.deepEqual(parseCoordinatorArguments([
    "--name", NAME,
    "--wrapper", "/private/wrapper",
    "--record", "/private/preview.json",
  ]), {
    commit: false,
    name: NAME,
    wrapperPath: "/private/wrapper",
    recordPath: "/private/preview.json",
    approval: null,
    resultRecordPath: null,
  });
  for (const args of [
    ["--name", NAME, "--commit"],
    ["--name", NAME, "--wrapper", "/w", "--record", "/r", "--commit"],
    ["--name", NAME, "--wrapper", "/w", "--record", "/r", "--approve", "a".repeat(64)],
    ["--name", NAME, "--wrapper", "/w", "--record", "/r", "--commit", "--approve", "a".repeat(64), "--result-record", "/r"],
    ["--name", "test-scratch", "--wrapper", "/w", "--record", "/r"],
  ]) {
    assertCode(() => parseCoordinatorArguments(args), "TEARDOWN_ARGUMENTS_INVALID");
  }
});

test("ambient Cloudflare credentials stop before wrapper, records, or provider access", () => {
  let touched = false;
  assertCode(() => executeTeardown({
    commit: false,
    name: NAME,
    wrapperPath: "/private/wrapper",
    recordPath: "/private/preview.json",
  }, {
    env: {
      BRAIN_TEARDOWN_PROTECTED: "owner-brain",
      CLOUDFLARE_API_TOKEN: "ambient-secret-that-must-not-win",
    },
    inspectWrapper: () => { touched = true; },
    assertOutput: () => { touched = true; },
    invokeWrapper: () => { touched = true; },
  }), "TEARDOWN_AMBIENT_CREDENTIAL_REFUSED");
  assert.equal(touched, false);
});

test("preview approval binds exact opaque instances and commit is disabled before every boundary", {
  skip: process.platform === "win32",
}, () => {
  const root = privateDirectory();
  try {
    const previewPath = join(root, "preview-a.json");
    const changedPreviewPath = join(root, "preview-b.json");
    const resultPath = join(root, "result.json");
    const wrapper = {
      path: "/private/wrapper",
      sha256: WRAPPER_HASH,
      providerSha256: PROVIDER_HASH,
      program: WRAPPER,
    };
    const common = {
      env: { BRAIN_TEARDOWN_PROTECTED: "owner-brain" },
      inspectWrapper: () => wrapper,
      invokeWrapper: () => providerReceipt(),
    };
    const preview = executeTeardown({
      commit: false,
      name: NAME,
      wrapperPath: wrapper.path,
      recordPath: previewPath,
    }, common);
    assert.deepEqual(preview.resources, { present: 3, absent: 0 });
    assert.equal(preview.preview_instances_bound, true);
    assert.equal(preview.next, "commit_disabled_pending_conditional_provider_fence");
    assert.equal(existsSync(previewPath), true);
    const privatePreview = readFileSync(previewPath, "utf8");
    const savedPreview = JSON.parse(privatePreview);
    assert.equal(savedPreview.provider_sha256, PROVIDER_HASH);
    assert.deepEqual(savedPreview.instance_sha256, INSTANCE_SHA256);
    assert.doesNotMatch(privatePreview, new RegExp(NAME));
    assert.doesNotMatch(privatePreview, /owner-brain|https?:|account[_-]?id|resource[_-]?id/i);

    const changed = executeTeardown({
      commit: false,
      name: NAME,
      wrapperPath: wrapper.path,
      recordPath: changedPreviewPath,
    }, {
      ...common,
      invokeWrapper: () => providerReceipt(undefined, {
        instanceSha256: { ...INSTANCE_SHA256, worker: "55".repeat(32) },
      }),
    });
    assert.notEqual(changed.approval_fingerprint, preview.approval_fingerprint);

    let touched = false;
    assertCode(() => executeTeardown({
      commit: true,
      name: NAME,
      wrapperPath: wrapper.path,
      recordPath: previewPath,
      approval: preview.approval_fingerprint,
      resultRecordPath: resultPath,
    }, {
      env: { BRAIN_TEARDOWN_PROTECTED: "owner-brain" },
      inspectWrapper: () => { touched = true; },
      assertOutput: () => { touched = true; },
      invokeWrapper: () => { touched = true; },
    }), "TEARDOWN_COMMIT_DISABLED");
    assert.equal(touched, false);
    assert.equal(existsSync(resultPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe private destinations fail before provider access", {
  skip: process.platform === "win32",
}, () => {
  const root = privateDirectory();
  try {
    const unsafe = join(root, "shared");
    mkdirSync(unsafe, { mode: 0o755 });
    chmodSync(unsafe, 0o755);
    let providerCalls = 0;
    assert.throws(() => executeTeardown({
      commit: false,
      name: NAME,
      wrapperPath: "/private/wrapper",
      recordPath: join(unsafe, "preview.json"),
    }, {
      env: { BRAIN_TEARDOWN_PROTECTED: "owner-brain" },
      inspectWrapper: () => ({
        path: "/private/wrapper",
        sha256: WRAPPER_HASH,
        providerSha256: PROVIDER_HASH,
        program: WRAPPER,
      }),
      invokeWrapper: () => { providerCalls += 1; },
    }));
    assert.equal(providerCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper invocation refuses delete before spawning a child", () => {
  let ran = false;
  assertCode(() => invokeTeardownWrapper({
    wrapper: {
      path: "/private/wrapper",
      sha256: WRAPPER_HASH,
      providerSha256: PROVIDER_HASH,
      program: WRAPPER,
    },
    operation: "delete",
    name: NAME,
    providerProgram: PROVIDER_PROGRAM,
    run: () => { ran = true; },
  }), "TEARDOWN_COMMIT_DISABLED");
  assert.equal(ran, false);
});

test("wrapper provider pin mismatch refuses before spawning or Keychain access", () => {
  const otherProviderHash = "66".repeat(32);
  const otherWrapper = WRAPPER.replace(PROVIDER_HASH, otherProviderHash);
  let ran = false;
  assertCode(() => invokeTeardownWrapper({
    wrapper: {
      path: "/private/wrapper",
      sha256: createHash("sha256").update(otherWrapper).digest("hex"),
      providerSha256: otherProviderHash,
      program: otherWrapper,
    },
    operation: "preview",
    name: NAME,
    providerProgram: PROVIDER_PROGRAM,
    run: () => { ran = true; },
  }), "TEARDOWN_PROVIDER_PROGRAM_CHANGED");
  assert.equal(ran, false);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function providerFixture({
  accountId = "a".repeat(32),
  workerId = "b".repeat(32),
  d1Id = "12345678-1234-4123-8123-123456789abc",
  vectorCreatedOn = "2026-09-12T12:00:00.000Z",
} = {}) {
  const calls = [];
  const fetchImpl = async (urlInput, options = {}) => {
    const url = new URL(urlInput);
    const method = options.method || "GET";
    calls.push({
      pathname: url.pathname,
      search: url.search,
      method,
      redirect: options.redirect,
    });
    assert.equal(options.redirect, "manual");
    assert.match(options.headers.authorization, /^Bearer /);
    if (url.pathname.endsWith("/user/tokens/verify")) {
      return jsonResponse(200, { success: true, result: { status: "active" } });
    }
    if (url.pathname.endsWith("/accounts")) {
      return jsonResponse(200, { success: true, result: [{ id: accountId, name: "private account" }] });
    }
    if (url.pathname.endsWith("/workers/scripts-search") && method === "GET") {
      return jsonResponse(200, {
        success: true,
        result: [{
          id: workerId,
          script_name: NAME,
          created_on: "2026-09-12T12:00:00.000Z",
          modified_on: "2026-09-12T12:00:00.000Z",
        }],
      });
    }
    if (url.pathname.endsWith("/d1/database") && method === "GET") {
      return jsonResponse(200, {
        success: true,
        result: [{ name: NAME, uuid: d1Id, created_at: "2026-09-12T12:00:00.000Z" }],
      });
    }
    if (url.pathname.endsWith(`/vectorize/v2/indexes/${NAME}`) && method === "GET") {
      return jsonResponse(200, {
        success: true,
        result: {
          name: NAME,
          created_on: vectorCreatedOn,
          modified_on: vectorCreatedOn,
          config: { dimensions: 768, metric: "cosine" },
        },
      });
    }
    throw new Error(`unexpected fixture request ${method}`);
  };
  return { accountId, workerId, d1Id, vectorCreatedOn, calls, fetchImpl };
}

test("provider child needs the wrapper nonce even when an ambient token exists", async () => {
  let calls = 0;
  await assert.rejects(() => executeProviderChild({
    operation: "preview",
    name: NAME,
  }, {
    env: { CLOUDFLARE_API_TOKEN: "fixture-token-long-enough" },
    fetchImpl: async () => { calls += 1; },
  }), (error) => error.code === "TEARDOWN_CHILD_BOUNDARY_INVALID");
  assert.equal(calls, 0);
});

test("provider child returns aggregate-only exact-instance preview", async () => {
  const fixture = providerFixture();
  const env = {
    BRAIN_TEARDOWN_WRAPPED_NONCE: NONCE,
    BRAIN_TEARDOWN_PROVIDER_SOURCE: PROVIDER_SOURCE,
    CLOUDFLARE_API_TOKEN: "fixture-token-that-never-leaves-child",
  };
  const preview = await executeProviderChild({
    operation: "preview",
    name: NAME,
  }, { env, fetchImpl: fixture.fetchImpl });
  assert.deepEqual(preview.before, {
    worker: "present",
    d1: "present",
    vectorize: "present",
  });
  assert.match(preview.instance_sha256.account, /^[a-f0-9]{64}$/);
  assert.match(preview.instance_sha256.worker, /^[a-f0-9]{64}$/);
  assert.match(preview.instance_sha256.d1, /^[a-f0-9]{64}$/);
  assert.match(preview.instance_sha256.vectorize, /^[a-f0-9]{64}$/);
  assert.equal(preview.provider_sha256, PROVIDER_HASH);
  const publicPreview = JSON.stringify(preview);
  assert.doesNotMatch(publicPreview, new RegExp(NAME));
  assert.doesNotMatch(publicPreview, new RegExp(fixture.accountId));
  assert.doesNotMatch(publicPreview, new RegExp(fixture.workerId));
  assert.doesNotMatch(publicPreview, new RegExp(fixture.d1Id));
  assert.doesNotMatch(publicPreview, /private account|https?:|fixture-token|errors|message/i);
  assert.equal(fixture.calls.some((call) => call.method !== "GET"), false);
});

test("account and same-name resource replacements produce different bound hashes", async () => {
  const env = {
    BRAIN_TEARDOWN_WRAPPED_NONCE: NONCE,
    BRAIN_TEARDOWN_PROVIDER_SOURCE: PROVIDER_SOURCE,
    CLOUDFLARE_API_TOKEN: "fixture-token-that-never-leaves-child",
  };
  const preview = async (fixture) => executeProviderChild({
    operation: "preview",
    name: NAME,
  }, { env, fetchImpl: fixture.fetchImpl });
  const baseline = await preview(providerFixture());
  const accountReplacement = await preview(providerFixture({ accountId: "c".repeat(32) }));
  const workerReplacement = await preview(providerFixture({ workerId: "d".repeat(32) }));
  const d1Replacement = await preview(providerFixture({
    d1Id: "22345678-1234-4123-8123-123456789abc",
  }));
  const vectorReplacement = await preview(providerFixture({
    vectorCreatedOn: "2026-09-12T12:00:01.000Z",
  }));
  assert.notEqual(accountReplacement.instance_sha256.account, baseline.instance_sha256.account);
  assert.notEqual(workerReplacement.instance_sha256.worker, baseline.instance_sha256.worker);
  assert.notEqual(d1Replacement.instance_sha256.d1, baseline.instance_sha256.d1);
  assert.notEqual(vectorReplacement.instance_sha256.vectorize, baseline.instance_sha256.vectorize);
});

test("caller-supplied nonce and token cannot reach provider mutation", async () => {
  let calls = 0;
  await assert.rejects(() => executeProviderChild({
    operation: "delete",
    name: NAME,
    expectedStates: { worker: "present", d1: "present", vectorize: "present" },
    expectedInstanceSha256: INSTANCE_SHA256,
  }, {
    env: {
      BRAIN_TEARDOWN_WRAPPED_NONCE: NONCE,
      BRAIN_TEARDOWN_PROVIDER_SOURCE: PROVIDER_SOURCE,
      CLOUDFLARE_API_TOKEN: "fixture-token-that-never-leaves-child",
    },
    fetchImpl: async () => { calls += 1; },
  }), (error) => error.code === "TEARDOWN_COMMIT_DISABLED");
  assert.equal(calls, 0);
});

test("CLI failures are one sanitized JSON code", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/teardown-test-brain.mjs", import.meta.url));
  const privateNeedle = "private-account-id-and-https://example.invalid";
  const child = spawnSync(process.execPath, [
    scriptPath,
    "--name", privateNeedle,
  ], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "ambient-secret" },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  const output = JSON.parse(child.stdout);
  assert.deepEqual(output, { ok: false, code: "TEARDOWN_ARGUMENTS_INVALID" });
  assert.doesNotMatch(child.stdout, /private-account|example\.invalid|ambient-secret|https?:/i);

  const ambient = spawnSync(process.execPath, [
    scriptPath,
    "--name", NAME,
    "--wrapper", "/private/secret-wrapper",
    "--record", "/private/secret-preview.json",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      BRAIN_TEARDOWN_PROTECTED: "owner-private-resource",
      CLOUDFLARE_API_TOKEN: "ambient-secret-that-must-be-refused",
    },
  });
  assert.equal(ambient.status, 1);
  assert.equal(ambient.stderr, "");
  assert.deepEqual(JSON.parse(ambient.stdout), {
    ok: false,
    code: "TEARDOWN_AMBIENT_CREDENTIAL_REFUSED",
  });
  assert.doesNotMatch(ambient.stdout, /secret-wrapper|secret-preview|owner-private|ambient-secret|brain-test-v048/i);

  for (const childFlag of ["--provider-child", "--provider-snapshot-child"]) {
    const bypass = spawnSync(process.execPath, [
      scriptPath,
      childFlag,
      "--operation", "delete",
      "--name", NAME,
    ], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        BRAIN_TEARDOWN_WRAPPED_NONCE: NONCE,
        BRAIN_TEARDOWN_PROVIDER_SOURCE: PROVIDER_SOURCE,
        CLOUDFLARE_API_TOKEN: "caller-supplied-token-that-must-not-run",
      },
    });
    assert.equal(bypass.status, 1);
    assert.equal(bypass.stderr, "");
    assert.deepEqual(JSON.parse(bypass.stdout), {
      ok: false,
      code: "TEARDOWN_ARGUMENTS_INVALID",
    });
    assert.doesNotMatch(bypass.stdout, /caller-supplied|brain-test-v048|provider-source/i);
  }

  const commit = spawnSync(process.execPath, [
    scriptPath,
    "--name", NAME,
    "--wrapper", "/private/wrapper",
    "--record", "/private/preview.json",
    "--commit",
    "--approve", "aa".repeat(32),
    "--result-record", "/private/result.json",
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      BRAIN_TEARDOWN_PROTECTED: "owner-private-resource",
    },
  });
  assert.equal(commit.status, 1);
  assert.equal(commit.stderr, "");
  assert.deepEqual(JSON.parse(commit.stdout), {
    ok: false,
    code: "TEARDOWN_COMMIT_DISABLED",
  });
  assert.doesNotMatch(commit.stdout, /private|owner|brain-test-v048/i);
});
