import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FIRST_SOURCE_FILE_EFFECT_EXCLUSIONS,
  FIRST_SOURCE_FILE_EXACT_LOCAL_BOUNDARY,
  FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY,
  FIRST_SOURCE_FILE_RESULT_FAMILY_UNRELATED_BACKLOG_CODE,
  FIRST_SOURCE_FILE_RUNTIME_IDENTITY_SCHEME,
  FIRST_SOURCE_FILE_SOURCE_REGISTRATION_POLICY,
  FirstSourceFileError,
  applyFirstSourceFile,
  buildFirstSourceFilePlan,
  canonicalFirstSourceFileLocator,
  firstSourceArchitectureIdentity,
  parseFirstSourceFileArgv,
  previewFirstSourceFile,
  renderFirstSourceFileReceipt,
} from "../operations/first-source-file.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalHash = (value) => sha256(canonical(value));
const digest = (character) => character.repeat(64);
const hashId = (character) => `sha256:${digest(character)}`;

const MANIFEST = "C:\\Users\\Synthetic\\Financial Brain\\brain.manifest.json";
const SOURCE = "pilot_docs";
const FILE = "first-source.txt";
const CONTENT = "Synthetic private first-source content for a deterministic same-item check.";
const QUERY = "Synthetic private first-source deterministic same-item check";
const ADMIN_SECRET = "private-admin-access-never-print";
const EXPECTED_RUNTIME_SHA256 = digest("9");

const ARCHITECTURE = Object.freeze({
  platform: "win32",
  native_windows_architecture: "x64",
  node_process_architecture: "x64",
  native_probe: "RuntimeInformation.OSArchitecture",
  native_probe_fingerprint: digest("1"),
});

const NATIVE_ARCHITECTURE_RESULT = Object.freeze({
  schema_version: 1,
  kind: "windows_native_architecture_gate",
  status: "verified",
  eligible: true,
  intended_architecture: "x64",
  probe_method: "runtime_information_os_architecture",
  native_windows_architecture: "x64",
  node_process_architecture: "x64",
  failure: null,
});

const previewArgv = () => [
  MANIFEST,
  "--source", SOURCE,
  "--file", FILE,
  "--expect-runtime-sha256", EXPECTED_RUNTIME_SHA256,
  "--json",
];

const applyArgv = (approval) => [
  MANIFEST,
  "--source", SOURCE,
  "--file", FILE,
  "--expect-runtime-sha256", EXPECTED_RUNTIME_SHA256,
  "--apply",
  "--approve", approval,
];

function envelope() {
  return {
    source_type: SOURCE,
    source_id: FILE,
    title: "Synthetic first source",
    content: CONTENT,
    text_source: "native",
    text_reliable: true,
    metadata: { category: "synthetic" },
    source_original_receipt: {
      version: 1,
      locator_kind: "source_relative_path",
      original_content_sha256: digest("7"),
      original_byte_count: 4096,
    },
  };
}

function exactContext({
  fileCtime = "1700000000000000000",
  envelopes = null,
  envelopeMutator = null,
} = {}) {
  const prepared = envelope();
  if (typeof envelopeMutator === "function") envelopeMutator(prepared);
  const preparedBytes = Buffer.from(prepared.content, "utf8");
  return {
    manifestIdentity: {
      content_sha256: digest("2"),
      byte_count: 512,
      filesystem_identity_sha256: digest("3"),
    },
    rootIdentity: {
      filesystem_identity_sha256: digest("4"),
      realpath_sha256: digest("5"),
    },
    fileIdentity: {
      filesystem_identity_sha256: digest("6"),
      realpath_sha256: digest("8"),
      byte_count: 4096,
      link_count: 1,
      mtime_ns: "1699999999999999999",
      ctime_ns: fileCtime,
    },
    runtimeIdentity: {
      identity_scheme: FIRST_SOURCE_FILE_RUNTIME_IDENTITY_SCHEME,
      runtime_payload_sha256: EXPECTED_RUNTIME_SHA256,
      expected_runtime_sha256: EXPECTED_RUNTIME_SHA256,
      product_version: "0.4.8",
    },
    originalIdentity: {
      content_sha256: digest("7"),
      byte_count: 4096,
    },
    envelopeIdentity: {
      source_type: SOURCE,
      source_id: FILE,
      doc_uid: `${SOURCE}:${FILE}`,
      envelope_sha256: canonicalHash(prepared),
      content_sha256: sha256(preparedBytes),
      content_byte_count: preparedBytes.length,
    },
    envelopes: envelopes ?? [prepared],
    retrievalQuery: QUERY,
    boundary: { ...FIRST_SOURCE_FILE_EXACT_LOCAL_BOUNDARY },
  };
}

function familyReceipt(operation, overrides = {}) {
  return {
    contract_version: 1,
    mode: "result_family",
    operation,
    source: SOURCE,
    original_id: `hmac-sha256:${digest("a")}`,
    family_receipt_hash: hashId("b"),
    verification_hash: hashId("c"),
    document_count: 1,
    chunk_count: 1,
    vector_readiness_hash: hashId("d"),
    retrieval_probe_id: `probe-v1:${digest("e")}`,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    recorded: operation === "record",
    replayed: operation === "verify",
    accepted_outcome_authorized: false,
    ...overrides,
  };
}

function ingestReceipt(overrides = {}) {
  return {
    created: 1,
    updated: 0,
    unchanged: 0,
    refused: 0,
    failed: 0,
    results: [{
      source_type: SOURCE,
      source_id: FILE,
      doc_uid: `${SOURCE}:${FILE}`,
      status: "created",
    }],
    ...overrides,
  };
}

function codedError(code) {
  const error = new Error(`synthetic ${code}`);
  error.code = code;
  return error;
}

function sourceInventory(overrides = {}) {
  const sources = overrides.sources ?? [{
    source_id: SOURCE,
    name: SOURCE,
    kind: "upload",
    registered: true,
  }];
  return {
    contract_version: 3,
    kind: "source_inventory",
    complete: true,
    truncated: false,
    cursor: null,
    returned: sources.length,
    total: sources.length,
    snapshot: { stable: true, id: hashId("f") },
    sources,
    ...overrides,
  };
}

function dependencies({
  context = exactContext(),
  architecture = ARCHITECTURE,
  registration = sourceInventory(),
  ingest = ingestReceipt(),
  record = familyReceipt("record"),
  verify = familyReceipt("verify"),
  readMonotonicTime = null,
  passiveReadinessWait = null,
} = {}) {
  const calls = [];
  const forbidden = {
    registerSource: 0,
    wholeSourceWalk: 0,
    inferRemovals: 0,
    reconcileFamily: 0,
    drainVectorOutbox: 0,
    loadResumeState: 0,
    saveResumeState: 0,
    schedule: 0,
  };
  const never = (name) => async () => {
    forbidden[name] += 1;
    throw new Error(`forbidden callback ${name}`);
  };
  return {
    calls,
    forbidden,
    api: {
      inspectArchitecture: async () => {
        calls.push("architecture");
        return architecture;
      },
      openReadOnlySnapshot: async ({ manifest, source, file, expectedRuntimeSha256 }) => {
        calls.push("snapshot.open");
        assert.deepEqual(
          { manifest, source, file, expectedRuntimeSha256 },
          {
            manifest: MANIFEST,
            source: SOURCE,
            file: FILE,
            expectedRuntimeSha256: EXPECTED_RUNTIME_SHA256,
          },
        );
        return {
          read_only: true,
          fingerprint: digest("f"),
          assertCurrent: async () => { calls.push("snapshot.assert"); },
          close: async () => { calls.push("snapshot.close"); },
        };
      },
      acquireSourceLease: async ({ manifest, source, file, expectedRuntimeSha256 }) => {
        calls.push("lease.acquire");
        assert.deepEqual(
          { manifest, source, file, expectedRuntimeSha256 },
          {
            manifest: MANIFEST,
            source: SOURCE,
            file: FILE,
            expectedRuntimeSha256: EXPECTED_RUNTIME_SHA256,
          },
        );
        return {
          fingerprint: digest("0"),
          assertOwned: async () => { calls.push("lease.assert"); },
          release: async () => { calls.push("lease.release"); },
        };
      },
      loadExactContext: async ({
        manifest,
        source,
        file,
        expectedRuntimeSha256,
        assertOwned,
      }) => {
        calls.push("context");
        assert.deepEqual(
          { manifest, source, file, expectedRuntimeSha256 },
          {
            manifest: MANIFEST,
            source: SOURCE,
            file: FILE,
            expectedRuntimeSha256: EXPECTED_RUNTIME_SHA256,
          },
        );
        await assertOwned();
        return typeof context === "function" ? context() : context;
      },
      resolveAdminAccess: async () => {
        calls.push("credential");
        return { token: ADMIN_SECRET };
      },
      verifySourceRegistration: async ({ source, policy }) => {
        calls.push("registration.verify");
        assert.equal(source, SOURCE);
        assert.deepEqual(policy, FIRST_SOURCE_FILE_SOURCE_REGISTRATION_POLICY);
        return typeof registration === "function" ? registration() : registration;
      },
      ingestExact: async ({ envelope: submitted }) => {
        calls.push("ingest");
        assert.equal(submitted.source_id, FILE);
        return ingest;
      },
      recordResultFamily: async ({ request, readinessPolicy, attemptContext }) => {
        calls.push("family.record");
        assert.deepEqual(request, {
          contract_version: 1,
          mode: "result_family",
          operation: "record",
          source: SOURCE,
          locator_kind: "source_relative_path",
          locator: FILE,
          original_content_sha256: digest("7"),
          original_byte_count: 4096,
          retrieval_query: QUERY,
        });
        assert.deepEqual(readinessPolicy, FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY);
        assert.ok(Number.isSafeInteger(attemptContext.attempt));
        assert.equal(attemptContext.max_attempts, readinessPolicy.max_attempts);
        assert.ok(attemptContext.request_timeout_ms > 0);
        assert.ok(attemptContext.request_timeout_ms <= readinessPolicy.attempt_timeout_ms);
        assert.ok(attemptContext.remaining_timeout_ms > 0);
        return typeof record === "function" ? record({ request, readinessPolicy, attemptContext }) : record;
      },
      verifyResultFamily: async ({ request }) => {
        calls.push("family.verify");
        assert.equal(request.operation, "verify");
        assert.equal(request.locator, FILE);
        assert.equal(request.retrieval_query, QUERY);
        return verify;
      },
      wholeSourceWalk: never("wholeSourceWalk"),
      registerSource: never("registerSource"),
      inferRemovals: never("inferRemovals"),
      reconcileFamily: never("reconcileFamily"),
      drainVectorOutbox: never("drainVectorOutbox"),
      loadResumeState: never("loadResumeState"),
      saveResumeState: never("saveResumeState"),
      schedule: never("schedule"),
      ...(readMonotonicTime ? { readMonotonicTime } : {}),
      passiveReadinessWait: passiveReadinessWait ?? (async ({
        waitMs,
        completedAttempts,
        retryableErrorCode,
      }) => {
        calls.push("readiness.wait");
        assert.equal(waitMs, FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.wait_interval_ms);
        assert.ok(completedAttempts > 0);
        assert.equal(
          retryableErrorCode,
          FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code,
        );
      }),
    },
  };
}

function planInput(context = exactContext(), architectureIdentity = ARCHITECTURE) {
  return {
    invocation: {
      manifest: MANIFEST,
      source: SOURCE,
      file: FILE,
      expectedRuntimeSha256: EXPECTED_RUNTIME_SHA256,
    },
    architectureIdentity,
    manifestIdentity: context.manifestIdentity,
    rootIdentity: context.rootIdentity,
    fileIdentity: context.fileIdentity,
    runtimeIdentity: context.runtimeIdentity,
    originalIdentity: context.originalIdentity,
    envelopeIdentity: context.envelopeIdentity,
    envelope: context.envelopes[0],
    retrievalQuery: context.retrievalQuery,
    boundary: context.boundary,
  };
}

function assertNoForbiddenCalls(fixture) {
  assert.deepEqual(fixture.forbidden, {
    registerSource: 0,
    wholeSourceWalk: 0,
    inferRemovals: 0,
    reconcileFamily: 0,
    drainVectorOutbox: 0,
    loadResumeState: 0,
    saveResumeState: 0,
    schedule: 0,
  });
}

function assertPrivateValuesAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const privateValue of [MANIFEST, SOURCE, FILE, CONTENT, QUERY, ADMIN_SECRET]) {
    assert.equal(serialized.includes(privateValue), false, `receipt leaked ${privateValue}`);
  }
}

test("strict parser accepts only the dedicated JSON preview and approved apply modes", () => {
  assert.deepEqual(parseFirstSourceFileArgv(previewArgv()), {
    manifest: MANIFEST,
    source: SOURCE,
    file: FILE,
    expectedRuntimeSha256: EXPECTED_RUNTIME_SHA256,
    apply: false,
    approve: null,
    json: true,
    mode: "preview",
  });
  assert.deepEqual(parseFirstSourceFileArgv(applyArgv(digest("a"))), {
    manifest: MANIFEST,
    source: SOURCE,
    file: FILE,
    expectedRuntimeSha256: EXPECTED_RUNTIME_SHA256,
    apply: true,
    approve: digest("a"),
    json: false,
    mode: "apply",
  });
  assert.equal(canonicalFirstSourceFileLocator(FILE), FILE);
});

test("strict parser refuses ambiguous modes, ignored syntax, and noncanonical locators", () => {
  const rejected = [
    [MANIFEST, "--source", SOURCE, "--file", FILE],
    [MANIFEST, "--source", SOURCE, "--file", FILE, "--expect-runtime-sha256", "A".repeat(64), "--json"],
    [MANIFEST, "--source", SOURCE, "--file", FILE, "--expect-runtime-sha256", "short", "--json"],
    [MANIFEST, "--source", SOURCE, "--file", FILE, "--expect-runtime-sha256"],
    [...previewArgv(), "--expect-runtime-sha256", EXPECTED_RUNTIME_SHA256],
    [MANIFEST, "--source", SOURCE, "--file", FILE,
      `--expect-runtime-sha256=${EXPECTED_RUNTIME_SHA256}`, "--json"],
    [MANIFEST, "--source", SOURCE, "--file", FILE, "--approve", digest("a"), "--json"],
    [MANIFEST, "--source", SOURCE, "--file", FILE, "--apply"],
    [...applyArgv(digest("a")), "--json"],
    [...previewArgv(), "--path", "folder"],
    [MANIFEST, "--source", SOURCE, `--file=${FILE}`, "--json"],
    [...previewArgv(), "--source", SOURCE],
    [...previewArgv(), "ignored"],
  ];
  for (const argv of rejected) assert.throws(() => parseFirstSourceFileArgv(argv));

  for (const locator of [
    "../secret.txt",
    "/absolute.txt",
    "folder\\file.txt",
    "folder//file.txt",
    "folder/file.txt",
    "folder/./file.txt",
    "folder/../file.txt",
    "NUL.txt",
    "folder/trailing. ",
    `decomposed-e\u0301.txt`,
  ]) {
    assert.throws(
      () => parseFirstSourceFileArgv([
        MANIFEST,
        "--source", SOURCE,
        "--file", locator,
        "--expect-runtime-sha256", EXPECTED_RUNTIME_SHA256,
        "--json",
      ]),
      /canonical source-relative/u,
    );
  }
});

test("runtime identity must exactly match the independently supplied expectation", () => {
  const baseline = planInput();
  assert.throws(
    () => buildFirstSourceFilePlan({
      ...baseline,
      runtimeIdentity: {
        ...baseline.runtimeIdentity,
        runtime_payload_sha256: digest("a"),
      },
    }),
    /independently expected payload/u,
  );
  assert.throws(
    () => buildFirstSourceFilePlan({
      ...baseline,
      runtimeIdentity: {
        ...baseline.runtimeIdentity,
        identity_scheme: "legacy.package.fingerprint.v0",
      },
    }),
    /unsupported scheme/u,
  );
});

test("file identity refuses every link count except one", () => {
  const baseline = planInput();
  for (const linkCount of [0, 2, "1", null]) {
    assert.throws(
      () => buildFirstSourceFilePlan({
        ...baseline,
        fileIdentity: { ...baseline.fileIdentity, link_count: linkCount },
      }),
      /one filesystem link/u,
    );
  }
});

test("pure plan binds every identity and exact effect exclusion without exposing private values", () => {
  const baselineContext = exactContext();
  const baseline = buildFirstSourceFilePlan(planInput(baselineContext));
  assert.match(baseline.approval_fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(baseline.run_id, /^fsf_[a-f0-9]{48}$/u);
  assert.deepEqual(baseline.effects, FIRST_SOURCE_FILE_EFFECT_EXCLUSIONS);
  assertPrivateValuesAbsent(baseline);

  const variants = [
    {
      ...planInput(baselineContext),
      invocation: {
        ...planInput(baselineContext).invocation,
        manifest: `${MANIFEST}.new`,
      },
    },
    { ...planInput(baselineContext), manifestIdentity: { ...baselineContext.manifestIdentity, content_sha256: digest("a") } },
    { ...planInput(baselineContext), rootIdentity: { ...baselineContext.rootIdentity, realpath_sha256: digest("a") } },
    planInput(exactContext({ fileCtime: "1700000000000000001" })),
    {
      ...planInput(baselineContext),
      invocation: {
        ...planInput(baselineContext).invocation,
        expectedRuntimeSha256: digest("a"),
      },
      runtimeIdentity: {
        ...baselineContext.runtimeIdentity,
        runtime_payload_sha256: digest("a"),
        expected_runtime_sha256: digest("a"),
      },
    },
    { ...planInput(baselineContext), architectureIdentity: { ...ARCHITECTURE, native_probe_fingerprint: digest("a") } },
    { ...planInput(baselineContext), originalIdentity: { content_sha256: digest("a"), byte_count: 4096 } },
    { ...planInput(baselineContext), retrievalQuery: `${QUERY} changed` },
  ];
  for (const variant of variants) {
    if (variant.originalIdentity?.content_sha256 === digest("a")) {
      variant.envelope = {
        ...variant.envelope,
        source_original_receipt: {
          ...variant.envelope.source_original_receipt,
          original_content_sha256: digest("a"),
        },
      };
      variant.envelopeIdentity = {
        ...variant.envelopeIdentity,
        envelope_sha256: canonicalHash(variant.envelope),
      };
    }
    const changed = buildFirstSourceFilePlan(variant);
    assert.notEqual(changed.approval_fingerprint, baseline.approval_fingerprint);
  }

  const changedEnvelope = envelope();
  changedEnvelope.title = "Changed private title";
  const bytes = Buffer.from(changedEnvelope.content);
  const envelopeVariant = {
    ...planInput(baselineContext),
    envelope: changedEnvelope,
    envelopeIdentity: {
      source_type: SOURCE,
      source_id: FILE,
      doc_uid: `${SOURCE}:${FILE}`,
      envelope_sha256: canonicalHash(changedEnvelope),
      content_sha256: sha256(bytes),
      content_byte_count: bytes.length,
    },
  };
  assert.notEqual(
    buildFirstSourceFilePlan(envelopeVariant).approval_fingerprint,
    baseline.approval_fingerprint,
  );
});

test("native architecture receipt conversion stays inside the lazy first-source module", () => {
  let validated = 0;
  const identity = firstSourceArchitectureIdentity(NATIVE_ARCHITECTURE_RESULT, (result) => {
    validated += 1;
    assert.equal(result, NATIVE_ARCHITECTURE_RESULT);
  });
  assert.equal(validated, 1);
  assert.deepEqual(identity, {
    platform: "win32",
    native_windows_architecture: "x64",
    node_process_architecture: "x64",
    native_probe: "RuntimeInformation.OSArchitecture",
    native_probe_fingerprint: canonicalHash(NATIVE_ARCHITECTURE_RESULT),
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.throws(
    () => firstSourceArchitectureIdentity(
      { ...NATIVE_ARCHITECTURE_RESULT, status: "blocked", eligible: false },
      () => {},
    ),
    /requires native Windows x64/u,
  );
  assert.throws(
    () => firstSourceArchitectureIdentity(NATIVE_ARCHITECTURE_RESULT, null),
    /validator is unavailable/u,
  );
});

test("preview gates architecture first and uses only a no-write snapshot plus exact local reads", async () => {
  const fixture = dependencies();
  const receipt = await previewFirstSourceFile(parseFirstSourceFileArgv(previewArgv()), fixture.api);
  assert.equal(receipt.status, "ready_for_approval");
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.proof, {
    received: false,
    saved: false,
    search_ready: false,
    answer_checked: false,
  });
  assert.equal(fixture.calls[0], "architecture");
  assert.ok(fixture.calls.indexOf("snapshot.open") > fixture.calls.indexOf("architecture"));
  assert.ok(fixture.calls.indexOf("context") > fixture.calls.indexOf("snapshot.open"));
  assert.equal(fixture.calls.includes("lease.acquire"), false);
  assert.equal(fixture.calls.includes("credential"), false);
  assert.equal(fixture.calls.includes("registration.verify"), false);
  assert.equal(fixture.calls.includes("ingest"), false);
  assert.equal(fixture.calls.includes("family.record"), false);
  assert.equal(fixture.calls.includes("family.verify"), false);
  assert.equal(fixture.calls.at(-1), "snapshot.close");
  assertNoForbiddenCalls(fixture);
  assertPrivateValuesAbsent(receipt);
  assertPrivateValuesAbsent(renderFirstSourceFileReceipt(receipt));
});

test("native ARM64 and Node architecture mismatches stop before every local or external gate", async () => {
  for (const architecture of [
    { ...ARCHITECTURE, native_windows_architecture: "arm64" },
    { ...ARCHITECTURE, node_process_architecture: "arm64" },
    { ...ARCHITECTURE, platform: "darwin" },
  ]) {
    const fixture = dependencies({ architecture });
    await assert.rejects(
      previewFirstSourceFile(parseFirstSourceFileArgv(previewArgv()), fixture.api),
      (error) => error instanceof FirstSourceFileError && error.stage === "windows_x64_gate",
    );
    assert.deepEqual(fixture.calls, ["architecture"]);
    assertNoForbiddenCalls(fixture);
  }
});

test("apply recomputes under the real source lease before credential and network callbacks", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  const fixture = dependencies();
  const receipt = await applyFirstSourceFile(
    parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
    fixture.api,
  );
  assert.equal(receipt.status, "same_item_proved");
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.ingest, { outcome: "created", exact_result_count: 1 });
  assert.deepEqual(receipt.proof, {
    received: true,
    saved: true,
    search_ready: true,
    answer_checked: true,
    result_family_recorded: true,
    result_family_verified: true,
  });
  for (const earlier of ["architecture", "lease.acquire", "context"]) {
    assert.ok(fixture.calls.indexOf(earlier) < fixture.calls.indexOf("credential"));
  }
  assert.ok(fixture.calls.indexOf("credential") < fixture.calls.indexOf("ingest"));
  assert.ok(fixture.calls.indexOf("credential") < fixture.calls.indexOf("registration.verify"));
  assert.ok(fixture.calls.indexOf("registration.verify") < fixture.calls.indexOf("ingest"));
  assert.ok(fixture.calls.indexOf("ingest") < fixture.calls.indexOf("family.record"));
  assert.ok(fixture.calls.indexOf("family.record") < fixture.calls.indexOf("family.verify"));
  assert.equal(fixture.calls.includes("snapshot.open"), false);
  assert.equal(fixture.calls.at(-1), "lease.release");
  assertNoForbiddenCalls(fixture);
  assertPrivateValuesAbsent(receipt);
  assertPrivateValuesAbsent(renderFirstSourceFileReceipt(receipt));
});

test("approval drift under the apply lease refuses before credentials or network", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  const fixture = dependencies({ context: exactContext({ fileCtime: "1700000000000000001" }) });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      fixture.api,
    ),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "approval_recheck");
      assert.equal(error.receipt.complete, false);
      assertPrivateValuesAbsent(error);
      return true;
    },
  );
  assert.equal(fixture.calls[0], "architecture");
  assert.equal(fixture.calls.includes("lease.acquire"), true);
  assert.equal(fixture.calls.includes("context"), true);
  assert.equal(fixture.calls.includes("credential"), false);
  assert.equal(fixture.calls.includes("registration.verify"), false);
  assert.equal(fixture.calls.includes("ingest"), false);
  assert.equal(fixture.calls.includes("family.record"), false);
  assertNoForbiddenCalls(fixture);
});

test("local context refuses multiple or non-native envelopes before approval or external access", async () => {
  const two = exactContext();
  two.envelopes = [two.envelopes[0], two.envelopes[0]];
  const unreliable = exactContext({
    envelopeMutator: (value) => { value.text_reliable = false; },
  });
  for (const context of [two, unreliable]) {
    const fixture = dependencies({ context });
    await assert.rejects(
      previewFirstSourceFile(parseFirstSourceFileArgv(previewArgv()), fixture.api),
      (error) => error instanceof FirstSourceFileError && error.stage === "exact_file_context",
    );
    assert.equal(fixture.calls.includes("lease.acquire"), false);
    assert.equal(fixture.calls.includes("credential"), false);
    assert.equal(fixture.calls.includes("registration.verify"), false);
    assert.equal(fixture.calls.includes("ingest"), false);
    assertNoForbiddenCalls(fixture);
  }
});

test("apply requires one pre-existing registered upload source before ingest", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  const wrongSource = {
    source_id: "other_source",
    name: "other_source",
    kind: "upload",
    registered: true,
  };
  const invalidInventories = [
    sourceInventory({ sources: [wrongSource] }),
    sourceInventory({ sources: [{
      source_id: SOURCE,
      name: SOURCE,
      kind: "folder",
      registered: true,
    }] }),
    sourceInventory({ sources: [{
      source_id: SOURCE,
      name: SOURCE,
      kind: "upload",
      registered: false,
    }] }),
    sourceInventory({ sources: [
      { source_id: SOURCE, name: SOURCE, kind: "upload", registered: true },
      { source_id: SOURCE, name: SOURCE, kind: "upload", registered: true },
    ] }),
    sourceInventory({ complete: false }),
  ];

  for (const registration of invalidInventories) {
    const fixture = dependencies({ registration });
    await assert.rejects(
      applyFirstSourceFile(
        parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
        fixture.api,
      ),
      (error) => {
        assert.ok(error instanceof FirstSourceFileError);
        assert.equal(error.stage, "source_registration_verify");
        assert.equal(error.receipt.complete, false);
        assert.deepEqual(error.receipt.completed_stages, []);
        assertPrivateValuesAbsent(error);
        return true;
      },
    );
    assert.ok(fixture.calls.indexOf("registration.verify") > fixture.calls.indexOf("credential"));
    assert.equal(fixture.calls.includes("ingest"), false);
    assert.equal(fixture.calls.includes("family.record"), false);
    assert.equal(fixture.calls.includes("family.verify"), false);
    assert.equal(fixture.calls.at(-1), "lease.release");
    assertNoForbiddenCalls(fixture);
  }

  const missing = dependencies();
  delete missing.api.verifySourceRegistration;
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      missing.api,
    ),
    (error) => error instanceof FirstSourceFileError &&
      error.stage === "source_registration_verify",
  );
  assert.equal(missing.calls.includes("ingest"), false);
  assertNoForbiddenCalls(missing);
});

test("one mismatched ingest result stops Received before result-family calls", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  const fixture = dependencies({
    ingest: ingestReceipt({
      results: [{
        source_type: SOURCE,
        source_id: "other.txt",
        doc_uid: `${SOURCE}:other.txt`,
        status: "created",
      }],
    }),
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      fixture.api,
    ),
    (error) => error instanceof FirstSourceFileError &&
      error.stage === "exact_item_received" && error.receipt.proof.received === false,
  );
  assert.equal(fixture.calls.includes("ingest"), true);
  assert.equal(fixture.calls.includes("family.record"), false);
  assert.equal(fixture.calls.includes("family.verify"), false);
  assertNoForbiddenCalls(fixture);
});

test("only exact vector-unready is passively retried under the held source lease", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  let now = 1_000_000;
  let attempts = 0;
  const waits = [];
  const fixture = dependencies({
    readMonotonicTime: () => now,
    record: ({ attemptContext }) => {
      attempts += 1;
      assert.equal(attemptContext.attempt, attempts);
      if (attempts < 3) {
        throw codedError(FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code);
      }
      return familyReceipt("record");
    },
    passiveReadinessWait: async (payload) => {
      waits.push({ ...payload, assertOwned: undefined });
      assert.equal(typeof payload.assertOwned, "function");
      await payload.assertOwned();
      now += payload.waitMs;
    },
  });
  const receipt = await applyFirstSourceFile(
    parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
    fixture.api,
  );
  assert.equal(receipt.complete, true);
  assert.equal(attempts, 3);
  assert.equal(fixture.calls.filter((call) => call === "ingest").length, 1);
  assert.equal(fixture.calls.filter((call) => call === "family.record").length, 3);
  assert.equal(fixture.calls.filter((call) => call === "family.verify").length, 1);
  assert.deepEqual(waits, [
    {
      waitMs: FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.wait_interval_ms,
      completedAttempts: 1,
      retryableErrorCode: FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code,
      assertOwned: undefined,
    },
    {
      waitMs: FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.wait_interval_ms,
      completedAttempts: 2,
      retryableErrorCode: FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code,
      assertOwned: undefined,
    },
  ]);
  assertNoForbiddenCalls(fixture);
});

test("passive readiness spans two one-minute projection ticks without drain or reingest", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  const startedAt = 1_500_000;
  const requiredProjectionDelayMs = 130_000;
  let now = startedAt;
  let attempts = 0;
  let waits = 0;
  const fixture = dependencies({
    readMonotonicTime: () => now,
    record: () => {
      attempts += 1;
      if (now - startedAt < requiredProjectionDelayMs) {
        throw codedError(FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code);
      }
      return familyReceipt("record");
    },
    passiveReadinessWait: async ({ waitMs, assertOwned }) => {
      waits += 1;
      await assertOwned();
      now += waitMs;
    },
  });
  const receipt = await applyFirstSourceFile(
    parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
    fixture.api,
  );
  assert.equal(receipt.complete, true);
  assert.equal(now - startedAt, requiredProjectionDelayMs);
  assert.equal(attempts, 14);
  assert.equal(waits, 13);
  assert.ok(FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.wall_clock_timeout_ms >
    requiredProjectionDelayMs);
  assert.equal(fixture.calls.filter((call) => call === "ingest").length, 1);
  assert.equal(fixture.calls.includes("family.verify"), true);
  assertNoForbiddenCalls(fixture);
});

test("persistent vector-unready reaches the bounded passive timeout without reingest or drain", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  let now = 2_000_000;
  let waits = 0;
  const fixture = dependencies({
    readMonotonicTime: () => now,
    record: () => {
      throw codedError(FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code);
    },
    passiveReadinessWait: async ({ waitMs, assertOwned }) => {
      waits += 1;
      await assertOwned();
      now += waitMs;
    },
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      fixture.api,
    ),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "result_family_readiness_timeout");
      assert.deepEqual(error.receipt.completed_stages, [
        "source_registration_verified",
        "exact_item_received",
      ]);
      assert.equal(error.receipt.proof.received, true);
      assert.equal(error.receipt.proof.saved, false);
      assertPrivateValuesAbsent(error);
      return true;
    },
  );
  assert.equal(
    fixture.calls.filter((call) => call === "family.record").length,
    FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.max_attempts,
  );
  assert.equal(waits, FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.max_attempts - 1);
  assert.equal(fixture.calls.filter((call) => call === "ingest").length, 1);
  assert.equal(fixture.calls.includes("family.verify"), false);
  assert.equal(fixture.calls.at(-1), "lease.release");
  assertNoForbiddenCalls(fixture);
});

test("wall-clock expiry and unrelated backlog both fail incomplete without broad work", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );

  let now = 3_000_000;
  let wallWaits = 0;
  const wallClock = dependencies({
    readMonotonicTime: () => now,
    record: () => {
      throw codedError(FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.retryable_error_code);
    },
    passiveReadinessWait: async ({ assertOwned }) => {
      wallWaits += 1;
      await assertOwned();
      now += FIRST_SOURCE_FILE_PASSIVE_READINESS_POLICY.wall_clock_timeout_ms;
    },
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      wallClock.api,
    ),
    (error) => error instanceof FirstSourceFileError &&
      error.stage === "result_family_readiness_timeout",
  );
  assert.equal(wallWaits, 1);
  assert.equal(wallClock.calls.filter((call) => call === "family.record").length, 1);
  assert.equal(wallClock.calls.filter((call) => call === "ingest").length, 1);
  assert.equal(wallClock.calls.includes("family.verify"), false);
  assertNoForbiddenCalls(wallClock);

  let unrelatedWaits = 0;
  const unrelated = dependencies({
    record: () => {
      throw codedError(FIRST_SOURCE_FILE_RESULT_FAMILY_UNRELATED_BACKLOG_CODE);
    },
    passiveReadinessWait: async () => { unrelatedWaits += 1; },
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      unrelated.api,
    ),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "result_family_unrelated_backlog");
      assert.equal(error.receipt.proof.received, true);
      assert.equal(error.receipt.proof.search_ready, false);
      return true;
    },
  );
  assert.equal(unrelatedWaits, 0);
  assert.equal(unrelated.calls.filter((call) => call === "family.record").length, 1);
  assert.equal(unrelated.calls.filter((call) => call === "ingest").length, 1);
  assert.equal(unrelated.calls.includes("family.verify"), false);
  assertNoForbiddenCalls(unrelated);
});

test("non-readiness result-family errors are never retried", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );
  let waits = 0;
  const fixture = dependencies({
    record: () => { throw codedError("source_original_result_family_binding_mismatch"); },
    passiveReadinessWait: async () => { waits += 1; },
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      fixture.api,
    ),
    (error) => error instanceof FirstSourceFileError &&
      error.stage === "result_family_record",
  );
  assert.equal(waits, 0);
  assert.equal(fixture.calls.filter((call) => call === "family.record").length, 1);
  assert.equal(fixture.calls.filter((call) => call === "ingest").length, 1);
  assert.equal(fixture.calls.includes("family.verify"), false);
  assertNoForbiddenCalls(fixture);
});

test("result-family record and verify are separate fail-closed proof stages", async () => {
  const previewFixture = dependencies();
  const preview = await previewFirstSourceFile(
    parseFirstSourceFileArgv(previewArgv()),
    previewFixture.api,
  );

  const badRecordFixture = dependencies({
    record: familyReceipt("record", { vector_readiness_hash: null }),
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      badRecordFixture.api,
    ),
    (error) => error instanceof FirstSourceFileError &&
      error.stage === "result_family_record" &&
      error.receipt.proof.received === true &&
      error.receipt.proof.saved === false,
  );
  assert.equal(badRecordFixture.calls.includes("family.verify"), false);

  const badVerifyFixture = dependencies({
    verify: familyReceipt("verify", { family_receipt_hash: hashId("f") }),
  });
  await assert.rejects(
    applyFirstSourceFile(
      parseFirstSourceFileArgv(applyArgv(preview.approval_fingerprint)),
      badVerifyFixture.api,
    ),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "result_family_verify");
      assert.deepEqual(error.receipt.completed_stages, [
        "source_registration_verified",
        "exact_item_received",
        "result_family_recorded",
      ]);
      assert.deepEqual(error.receipt.proof, {
        received: true,
        saved: false,
        search_ready: false,
        answer_checked: false,
      });
      assertPrivateValuesAbsent(error);
      return true;
    },
  );
  assertNoForbiddenCalls(badRecordFixture);
  assertNoForbiddenCalls(badVerifyFixture);
});
