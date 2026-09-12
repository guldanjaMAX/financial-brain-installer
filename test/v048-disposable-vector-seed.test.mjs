import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fieldTest = process.platform === "win32" ? test.skip : test;
import {
  V048_CONNECTOR_KEYS,
  V048_SEED_BATCH_COUNT,
  V048_SEED_BATCH_SIZE,
  V048_SEED_CORPUS_SHA256,
  V048_SEED_DOCUMENT_COUNT,
  V048_SEED_MARKER,
  V048_SEED_MARKER_TITLE,
  V048_SEED_SOURCE,
  assertV048AggregateSeedReceipt,
  batchV048SyntheticDocuments,
  buildV048SyntheticDocuments,
  inspectV048SeederLocalBindings,
  main as v048SeederMain,
  parseV048DisposableVectorSeedArgs,
  runV048DisposableVectorSeed,
  v048SeedCorpusSha256,
  validateV048SeedBinding,
  validateV048SyntheticSourceManifest,
} from "./live/v048-disposable-vector-seed.mjs";

const WORKER = "brain-test-v048-field-source-recovery-gate-a48f1101";
const ADMIN_KEY = "a".repeat(48);
const REFUSAL = "The documents do not answer the question.";

function manifestFixture() {
  return {
    manifest_version: 1,
    client: {
      slug: "v048-field-proof",
      display_name: "Synthetic Field Gate v0.4.8",
    },
    brain: {
      version: "0.4.8",
      worker_name: WORKER,
      domain: `${WORKER}.fixture-subdomain.workers.dev`,
    },
    infrastructure: {
      cloudflare: {
        account_id: "b".repeat(32),
        storage: "d1",
        d1_database_name: WORKER,
        d1_database_id: "c".repeat(32),
        vectorize_index: WORKER,
      },
    },
    retrieval: {
      embed_model: "@cf/baai/bge-base-en-v1.5",
      embed_dimensions: 768,
    },
    corpora: Object.fromEntries(V048_CONNECTOR_KEYS.map((key) => [key, { enabled: false }])),
    operations: {
      admin_key_secret: `keychain://${WORKER}/owner`,
    },
  };
}

function bindingFixture(overrides = {}) {
  return {
    schema_version: 1,
    candidate_commit: "d".repeat(40),
    runner_sha256: "e".repeat(64),
    package_sha256: "f".repeat(64),
    package_bytes: 12_345,
    package_content_fingerprint: "1".repeat(64),
    manifest_sha256: "2".repeat(64),
    corpus_sha256: V048_SEED_CORPUS_SHA256,
    ...overrides,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceIdentityFixture(commit, overrides = {}) {
  return {
    head_sha: commit,
    package_version: "0.4.8",
    working_tree_clean: true,
    shallow_repository: false,
    diff_check_clean: true,
    identity_stable_during_check: true,
    package_alignment: { aligned: true },
    ...overrides,
  };
}

function createLocalBindingFixture({
  bindingOverrides = {},
  readIdentity,
  fingerprintRuntimePackage,
} = {}) {
  const created = mkdtempSync(join(tmpdir(), "v048-local-binding-"));
  chmodSync(created, 0o700);
  const temporary = realpathSync(created);
  const sourceRoot = join(temporary, "source");
  const installerRoot = join(temporary, "installed");
  const privateRoot = join(temporary, "private");
  const outputRoot = join(temporary, "output");
  for (const directory of [sourceRoot, installerRoot, privateRoot, outputRoot]) {
    mkdirSync(directory, { mode: 0o700 });
  }

  const runnerPath = join(sourceRoot, "v048-disposable-vector-seed.mjs");
  const runnerBytes = Buffer.from("export const reviewedRunner = true;\n", "utf8");
  writeFileSync(runnerPath, runnerBytes);
  writeFileSync(join(installerRoot, "brain.mjs"), "export const installed = true;\n");
  writeFileSync(join(installerRoot, "package.json"), JSON.stringify({ version: "0.4.8" }));

  const manifestPath = join(privateRoot, "source.manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifestFixture()), "utf8");
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);

  const packageArchivePath = join(privateRoot, "financial-brain-0.4.8.tgz");
  const packageBytes = Buffer.from("reviewed package archive bytes\n", "utf8");
  writeFileSync(packageArchivePath, packageBytes);

  const contentFingerprint = "3".repeat(64);
  const binding = bindingFixture({
    runner_sha256: sha256(runnerBytes),
    package_sha256: sha256(packageBytes),
    package_bytes: packageBytes.length,
    package_content_fingerprint: contentFingerprint,
    manifest_sha256: sha256(manifestBytes),
    ...bindingOverrides,
  });
  const bindingPath = join(privateRoot, "seed.binding.json");
  writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  chmodSync(bindingPath, 0o600);

  return {
    temporary,
    options: {
      bindingPath,
      manifestPath,
      packageArchivePath,
      installerRoot: realpathSync(installerRoot),
      sourceRoot: realpathSync(sourceRoot),
      runnerPath: realpathSync(runnerPath),
      receiptPath: join(realpathSync(outputRoot), "seed-receipt.json"),
    },
    binding,
    dependencies: {
      environmentFactory: () => ({}),
      readIdentity: readIdentity || ((expected) => sourceIdentityFixture(expected)),
      fingerprintRuntimePackage: fingerprintRuntimePackage || (() => contentFingerprint),
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function activeHealth(overrides = {}) {
  return {
    ok: true,
    status: "ok",
    accepting_documents: true,
    version: "0.4.8",
    brain: "v048-field-proof",
    schema_version: 46,
    vector_writer_protocol: "lease-v1",
    vector_drain_mode: "active",
    ...overrides,
  };
}

function createFetchFixture({
  invalidChunkReceipt = false,
  health = activeHealth(),
  finalInventoryRow = {},
} = {}) {
  const state = {
    documents: 0,
    pending: 0,
    vectors: 0,
    drainCalls: 0,
    calls: [],
    batches: [],
    sentDocuments: [],
  };

  const inventory = () => ({
    version: "0.4.8",
    backend: "d1",
    vector_drain_mode: "active",
    rows: state.documents === 0 ? [] : [{
      source_type: V048_SEED_SOURCE,
      documents: state.documents,
      stored_documents: state.documents,
      logical_documents: state.documents,
      document_counts_exact: true,
      chunks: state.documents,
      chunk_counts_exact: true,
      total: state.documents,
      embedded: state.documents - state.pending,
      last_ingested: "2026-09-12T12:00:00.000Z",
      ...finalInventoryRow,
    }],
    vector_backlog: {
      pending: state.pending,
      upserts: state.pending,
      deletes: 0,
      submitted: 0,
      oldest_queued_at: state.pending ? 1 : null,
    },
    vector_readiness: {
      ready: state.pending === 0 && state.vectors === state.documents,
      reason: state.pending === 0 ? null : "vector_work_queued",
      expected_vectors: state.documents,
      actual_vectors: state.vectors,
      pending: state.pending,
      submitted: 0,
      projection_status: "verified",
    },
  });

  const fetchImpl = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    const headers = new Headers(init.headers || {});
    const payload = init.body === undefined ? null : JSON.parse(String(init.body));
    state.calls.push({ path, method: init.method || "GET", authenticated: headers.has("x-admin-key") });
    assert.equal(init.redirect, "error");
    if (path === "/health") {
      assert.equal(headers.has("x-admin-key"), false, "public health must not receive the admin key");
      return jsonResponse(health);
    }
    assert.equal(headers.get("x-admin-key"), ADMIN_KEY, `${path} did not use the injected admin key`);

    if (path === "/api/admin/brain/documents") return jsonResponse(inventory());
    if (path === "/api/admin/brain/ingest/batch") {
      assert.equal(init.method, "POST");
      assert.deepEqual(Object.keys(payload), ["docs"]);
      assert.ok(Array.isArray(payload.docs));
      state.batches.push(payload.docs.length);
      state.sentDocuments.push(...payload.docs);
      state.documents += payload.docs.length;
      state.pending += payload.docs.length;
      return jsonResponse({
        created: payload.docs.length,
        updated: 0,
        unchanged: 0,
        refused: 0,
        failed: 0,
        total: payload.docs.length,
        results: payload.docs.map((document, index) => ({
          source_type: document.source_type,
          source_id: document.source_id,
          status: "created",
          chunks: invalidChunkReceipt && state.batches.length === 1 && index === 0 ? 2 : 1,
          doc_uid: `PRIVATE_DOC_UID_${state.batches.length}_${index}`,
        })),
      });
    }
    if (path === "/api/admin/brain/drain") {
      assert.deepEqual(payload, {});
      state.drainCalls += 1;
      if (state.drainCalls === 1) {
        state.pending = 1_201;
        state.vectors = 2_000;
        return jsonResponse({
          drained: 2_000,
          submitted: 2_000,
          waiting: 0,
          remaining: state.pending,
          vector_ready: false,
          readiness_reason: "vector_work_queued",
          expected_vectors: V048_SEED_DOCUMENT_COUNT,
          actual_vectors: state.vectors,
        });
      }
      state.pending = 0;
      state.vectors = V048_SEED_DOCUMENT_COUNT;
      return jsonResponse({
        drained: 1_201,
        submitted: 1_201,
        waiting: 0,
        remaining: 0,
        vector_ready: true,
        readiness_reason: null,
        expected_vectors: V048_SEED_DOCUMENT_COUNT,
        actual_vectors: V048_SEED_DOCUMENT_COUNT,
      });
    }
    if (path === "/api/admin/brain/vector-retry") {
      assert.deepEqual(payload, { confirm: false });
      return jsonResponse({ quarantined: 0, selected: 0, retried: 0, dry_run: true });
    }
    if (path === "/api/rag/think") {
      assert.equal(payload.source, V048_SEED_SOURCE);
      if (payload.q.includes("orchid ledger")) {
        return jsonResponse({
          mode: "think",
          answer: "The stable marker is recorded in the fictional field fixture. [1]",
          answer_error: null,
          evidence_gate: { supported: true, complete: true },
          citations: [{
            source: V048_SEED_SOURCE,
            title: V048_SEED_MARKER_TITLE,
            private_locator: "PRIVATE_CITATION_LOCATOR",
          }],
        });
      }
      return jsonResponse({
        mode: "think",
        answer: REFUSAL,
        answer_error: null,
        citations: [],
        results: [{ private_result: "PRIVATE_UNSUPPORTED_RESULT" }],
      });
    }
    assert.fail(`unexpected offline fixture path ${path}`);
  };

  return { fetchImpl, state };
}

test("native Windows execution refuses before credentials or provider access", {
  skip: process.platform !== "win32",
}, async () => {
  let credentialReads = 0;
  let providerCalls = 0;
  await assert.rejects(
    () => runV048DisposableVectorSeed({
      manifest: manifestFixture(),
      manifestPath: "C:\\private\\source.manifest.json",
      receiptPath: "C:\\private\\seed-receipt.json",
      installerRoot: "C:\\private\\installed",
      sourceRoot: "C:\\private\\source",
      binding: bindingFixture(),
    }, {
      fetchImpl: async () => { providerCalls += 1; },
      resolveAdminKey: async () => { credentialReads += 1; return ADMIN_KEY; },
      revalidateLocalBindings: async () => true,
    }),
    /V048_SEED_REQUIRES_POSIX_PRIVATE_RECEIPTS/,
  );
  assert.equal(credentialReads, 0);
  assert.equal(providerCalls, 0);
});

fieldTest("the fixture is exactly 3,201 deterministic fictional one-chunk documents", () => {
  const first = buildV048SyntheticDocuments();
  const second = buildV048SyntheticDocuments();
  assert.equal(first.length, V048_SEED_DOCUMENT_COUNT);
  assert.equal(new Set(first.map((document) => document.source_id)).size, V048_SEED_DOCUMENT_COUNT);
  assert.equal(first.filter((document) => document.content.includes(V048_SEED_MARKER)).length, 1);
  assert.equal(first[0].title, V048_SEED_MARKER_TITLE);
  assert.equal(first.every((document) =>
    document.source_type === V048_SEED_SOURCE &&
    document.content.length > 0 && document.content.length < 256 &&
    !/@|https?:|\/Users\/|\\Users\\|password|secret|credential/i.test(document.content)
  ), true);
  assert.equal(v048SeedCorpusSha256(first), V048_SEED_CORPUS_SHA256);
  assert.equal(v048SeedCorpusSha256(second), V048_SEED_CORPUS_SHA256);
  const changed = structuredClone(first);
  changed[1].content += " changed";
  assert.notEqual(v048SeedCorpusSha256(changed), V048_SEED_CORPUS_SHA256);

  const batches = batchV048SyntheticDocuments(first);
  assert.equal(batches.length, V048_SEED_BATCH_COUNT);
  assert.deepEqual(batches.map((batch) => batch.length), [
    ...Array.from({ length: 64 }, () => V048_SEED_BATCH_SIZE),
    1,
  ]);
  assert.equal(batches.flat().length, V048_SEED_DOCUMENT_COUNT);
});

fieldTest("the parser has one explicit live mode and accepts no source or content input", () => {
  assert.deepEqual(parseV048DisposableVectorSeedArgs(["--plan"]), { mode: "plan" });
  assert.deepEqual(parseV048DisposableVectorSeedArgs(["--help"]), { mode: "help" });
  assert.deepEqual(parseV048DisposableVectorSeedArgs([
    "--execute",
    "--confirm", "seed-v048-disposable-vector-source",
    "--manifest", "/private/source.json",
    "--installer-root", "/reviewed/package",
    "--package-archive", "/private/reviewed.tgz",
    "--binding", "/private/binding.json",
    "--receipt", "/private/receipt.json",
  ]), {
    mode: "execute",
    manifestPath: "/private/source.json",
    installerRoot: "/reviewed/package",
    packageArchivePath: "/private/reviewed.tgz",
    bindingPath: "/private/binding.json",
    receiptPath: "/private/receipt.json",
  });
  assert.throws(() => parseV048DisposableVectorSeedArgs([]), /V048_SEED_ARGUMENT_INVALID/);
  assert.throws(() => parseV048DisposableVectorSeedArgs([
    "--execute", "--confirm", "seed-v048-disposable-vector-source",
    "--manifest", "/private/source.json", "--installer-root", "/reviewed/package",
    "--package-archive", "/private/reviewed.tgz", "--binding", "/private/binding.json",
    "--receipt", "/private/receipt.json", "--source", "anything",
  ]), /V048_SEED_ARGUMENT_INVALID/);
  assert.throws(() => parseV048DisposableVectorSeedArgs([
    "--execute", "--confirm", "seed-v048-disposable-vector-source",
    "--manifest", "/private/source.json", "--installer-root", "/reviewed/package",
    "--package-archive", "/private/reviewed.tgz", "--binding", "/private/binding.json",
    "--receipt", "/private/receipt.json", "--content", "anything",
  ]), /V048_SEED_ARGUMENT_INVALID/);
  for (const omitted of ["--binding", "--package-archive"]) {
    const complete = [
      "--execute", "--confirm", "seed-v048-disposable-vector-source",
      "--manifest", "/private/source.json", "--installer-root", "/reviewed/package",
      "--package-archive", "/private/reviewed.tgz", "--binding", "/private/binding.json",
      "--receipt", "/private/receipt.json",
    ];
    const index = complete.indexOf(omitted);
    complete.splice(index, 2);
    assert.throws(() => parseV048DisposableVectorSeedArgs(complete), /V048_SEED_ARGUMENT_INVALID/);
  }
});

fieldTest("plan mode states that it performs no live action", async () => {
  let output = "";
  assert.equal(await v048SeederMain(["--plan"], {
    stdout: (value) => { output += value; },
    stderr: () => assert.fail("plan mode must not write an error"),
  }), 0);
  const plan = JSON.parse(output);
  assert.equal(plan.plan_mode_live_actions, false);
  assert.equal(plan.execution_mutates_live_resources, true);
  assert.equal(Object.hasOwn(plan, "mutates_live_resources"), false);
});

fieldTest("only the exact active-source manifest with every connector off is accepted", () => {
  assert.equal(validateV048SyntheticSourceManifest(manifestFixture()).connectorsDeclared, 16);

  const wrongVersion = structuredClone(manifestFixture());
  wrongVersion.brain.version = "0.4.7";
  assert.throws(() => validateV048SyntheticSourceManifest(wrongVersion), /MANIFEST_CONTRACT_MISMATCH/);

  const target = structuredClone(manifestFixture());
  target.brain.worker_name = "brain-test-v048-field-target-recovery-gate-a48f1102";
  assert.throws(() => validateV048SyntheticSourceManifest(target), /MANIFEST_CONTRACT_MISMATCH/);

  const connectorOn = structuredClone(manifestFixture());
  connectorOn.corpora.gmail.enabled = true;
  assert.throws(() => validateV048SyntheticSourceManifest(connectorOn), /CONNECTORS_MUST_BE_DISABLED/);

  const missingConnector = structuredClone(manifestFixture());
  delete missingConnector.corpora.whatsapp;
  assert.throws(() => validateV048SyntheticSourceManifest(missingConnector), /CONNECTOR_CONTRACT_INVALID/);

  const mismatchedIndex = structuredClone(manifestFixture());
  mismatchedIndex.infrastructure.cloudflare.vectorize_index = `${WORKER}-other`;
  assert.throws(() => validateV048SyntheticSourceManifest(mismatchedIndex), /MANIFEST_CONTRACT_MISMATCH/);
});

fieldTest("the private binding is exact, hash-only, and pins the canonical corpus", () => {
  const binding = bindingFixture();
  assert.deepEqual(validateV048SeedBinding(binding), binding);
  assert.deepEqual(Object.keys(binding).sort(), [
    "candidate_commit", "corpus_sha256", "manifest_sha256", "package_bytes",
    "package_content_fingerprint", "package_sha256", "runner_sha256", "schema_version",
  ]);
  assert.equal(JSON.stringify(binding).includes("/"), false);
  assert.throws(() => validateV048SeedBinding({ ...binding, path: "/private/package" }),
    /V048_SEED_BINDING_INVALID/);
  assert.throws(() => validateV048SeedBinding({ ...binding, corpus_sha256: "0".repeat(64) }),
    /V048_SEED_CORPUS_BINDING_MISMATCH/);
});

fieldTest("every local source, runner, archive, package, manifest, and corpus mismatch refuses before provider access", async (t) => {
  const cases = [
    {
      name: "source checkout commit",
      setup: () => createLocalBindingFixture({
        readIdentity: (expected) => sourceIdentityFixture("0".repeat(40)),
      }),
      error: /V048_SEED_SOURCE_IDENTITY_MISMATCH/,
    },
    {
      name: "dirty source checkout",
      setup: () => createLocalBindingFixture({
        readIdentity: (expected) => sourceIdentityFixture(expected, { working_tree_clean: false }),
      }),
      error: /V048_SEED_SOURCE_IDENTITY_MISMATCH/,
    },
    {
      name: "runner bytes",
      setup: () => createLocalBindingFixture({ bindingOverrides: { runner_sha256: "0".repeat(64) } }),
      error: /V048_SEED_RUNNER_BINDING_MISMATCH/,
    },
    {
      name: "archive sha",
      setup: () => createLocalBindingFixture({ bindingOverrides: { package_sha256: "0".repeat(64) } }),
      error: /V048_SEED_PACKAGE_ARCHIVE_MISMATCH/,
    },
    {
      name: "archive byte count",
      setup: () => createLocalBindingFixture({ bindingOverrides: { package_bytes: 1 } }),
      error: /V048_SEED_PACKAGE_ARCHIVE_MISMATCH/,
    },
    {
      name: "trusted source package content",
      setup: () => {
        let source;
        const fixture = createLocalBindingFixture({
          fingerprintRuntimePackage: ({ root }) => root === source ? "0".repeat(64) : "3".repeat(64),
        });
        source = fixture.options.sourceRoot;
        return fixture;
      },
      error: /V048_SEED_PACKAGE_CONTENT_MISMATCH/,
    },
    {
      name: "installed package content",
      setup: () => {
        let installed;
        const fixture = createLocalBindingFixture({
          fingerprintRuntimePackage: ({ root }) => root === installed ? "0".repeat(64) : "3".repeat(64),
        });
        installed = fixture.options.installerRoot;
        return fixture;
      },
      error: /V048_SEED_PACKAGE_CONTENT_MISMATCH/,
    },
    {
      name: "manifest bytes",
      setup: () => createLocalBindingFixture({ bindingOverrides: { manifest_sha256: "0".repeat(64) } }),
      error: /V048_SEED_MANIFEST_BINDING_MISMATCH/,
    },
    {
      name: "corpus digest",
      setup: () => createLocalBindingFixture({ bindingOverrides: { corpus_sha256: "0".repeat(64) } }),
      error: /V048_SEED_CORPUS_BINDING_MISMATCH/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = entry.setup();
      let providerCalls = 0;
      try {
        await assert.rejects(async () => {
          const local = inspectV048SeederLocalBindings(fixture.options, fixture.dependencies);
          await runV048DisposableVectorSeed({
            ...local,
            receiptPath: fixture.options.receiptPath,
          }, {
            fetchImpl: async () => {
              providerCalls += 1;
              return jsonResponse(activeHealth());
            },
            resolveAdminKey: async () => ADMIN_KEY,
            revalidateLocalBindings: local.revalidate,
          });
        }, entry.error);
        assert.equal(providerCalls, 0);
      } finally {
        rmSync(fixture.temporary, { recursive: true, force: true });
      }
    });
  }
});

fieldTest("a complete private binding can be fully revalidated without exposing its paths", () => {
  const fixture = createLocalBindingFixture();
  try {
    const local = inspectV048SeederLocalBindings(fixture.options, fixture.dependencies);
    assert.equal(local.revalidate({ full: true }), true);
    assert.deepEqual(local.binding, fixture.binding);
    assert.equal(JSON.stringify(local.binding).includes(fixture.temporary), false);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

fieldTest("the offline live simulation seeds, drains, evaluates, and durably writes only aggregates", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "v048-vector-seed-test-"));
  chmodSync(temporary, 0o700);
  try {
    const privateDirectory = realpathSync(temporary);
    const receiptPath = join(privateDirectory, "seed-receipt.json");
    const fixture = createFetchFixture();
    const progress = [];
    let credentialReads = 0;
    const receipt = await runV048DisposableVectorSeed({
      manifest: manifestFixture(),
      manifestPath: "/private/source.manifest.json",
      installerRoot: "/reviewed/package",
      binding: bindingFixture(),
      receiptPath,
    }, {
      fetchImpl: fixture.fetchImpl,
      resolveAdminKey: async () => {
        credentialReads += 1;
        return ADMIN_KEY;
      },
      makeSignal: () => undefined,
      sleep: async () => {},
      now: () => new Date("2026-09-12T12:34:56.000Z"),
      onProgress: (entry) => progress.push(entry),
      revalidateLocalBindings: async () => true,
    });

    assert.equal(assertV048AggregateSeedReceipt(receipt), true);
    assert.equal(credentialReads, 1);
    assert.equal(fixture.state.batches.length, V048_SEED_BATCH_COUNT);
    assert.deepEqual(fixture.state.batches, [
      ...Array.from({ length: 64 }, () => 50),
      1,
    ]);
    assert.deepEqual(fixture.state.sentDocuments, buildV048SyntheticDocuments());
    assert.equal(fixture.state.documents, V048_SEED_DOCUMENT_COUNT);
    assert.equal(fixture.state.vectors, V048_SEED_DOCUMENT_COUNT);
    assert.equal(fixture.state.pending, 0);
    assert.equal(fixture.state.drainCalls, 2);

    const allowedPaths = new Set([
      "/health",
      "/api/admin/brain/documents",
      "/api/admin/brain/ingest/batch",
      "/api/admin/brain/drain",
      "/api/admin/brain/vector-retry",
      "/api/rag/think",
    ]);
    assert.equal(fixture.state.calls.every((call) => allowedPaths.has(call.path)), true);
    assert.equal(fixture.state.calls.some((call) =>
      /forget|reindex|bootstrap|provision|deploy|delete/i.test(call.path)
    ), false);

    const info = lstatSync(receiptPath);
    assert.equal(info.isFile(), true);
    assert.equal(info.nlink, 1);
    if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0);
    const persisted = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.deepEqual(persisted, receipt);
    assert.deepEqual(Object.keys(persisted.binding).sort(), [
      "candidate_commit", "corpus_sha256", "manifest_sha256", "package_bytes",
      "package_content_fingerprint", "package_sha256", "runner_sha256", "schema_version",
    ]);
    assert.equal(JSON.stringify(persisted.binding).includes("/"), false);
    assert.equal(persisted.contract.health_brain_identity_proved, true);
    assert.equal(persisted.contract.schema_version, 46);
    assert.equal(persisted.contract.document_counts_exact, true);
    assert.equal(persisted.contract.chunk_counts_exact, true);

    const visible = JSON.stringify({ receipt: persisted, progress });
    for (const forbidden of [
      ADMIN_KEY,
      WORKER,
      manifestFixture().brain.domain,
      V048_SEED_SOURCE,
      V048_SEED_MARKER,
      "PRIVATE_DOC_UID",
      "PRIVATE_CITATION_LOCATOR",
      "PRIVATE_UNSUPPORTED_RESULT",
      privateDirectory,
      "/private/source.manifest.json",
      "/reviewed/package",
      "cobalt glacier",
      "orchid ledger",
    ]) {
      assert.equal(visible.includes(forbidden), false, `aggregate output leaked ${forbidden}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

fieldTest("a malformed per-document receipt leaves the reserved in-progress marker and stops", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "v048-vector-seed-failure-"));
  chmodSync(temporary, 0o700);
  try {
    const receiptPath = join(realpathSync(temporary), "seed-receipt.json");
    const fixture = createFetchFixture({ invalidChunkReceipt: true });
    await assert.rejects(() => runV048DisposableVectorSeed({
      manifest: manifestFixture(),
      manifestPath: "/private/source.manifest.json",
      installerRoot: "/reviewed/package",
      binding: bindingFixture(),
      receiptPath,
    }, {
      fetchImpl: fixture.fetchImpl,
      resolveAdminKey: async () => ADMIN_KEY,
      makeSignal: () => undefined,
      sleep: async () => {},
      revalidateLocalBindings: async () => true,
    }), /V048_SEED_INGEST_RECEIPT_INVALID/);

    assert.equal(fixture.state.batches.length, 1);
    assert.equal(fixture.state.calls.some((call) => call.path === "/api/admin/brain/drain"), false);
    const marker = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.deepEqual(marker, {
      schema_version: 2,
      gate: "v048_disposable_vector_seed",
      release: "0.4.8",
      status: "execution_in_progress",
      data_class: "deterministic_fictional_synthetic_only",
      expected_documents: V048_SEED_DOCUMENT_COUNT,
      binding: bindingFixture(),
    });
    if (process.platform !== "win32") assert.equal(lstatSync(receiptPath).mode & 0o077, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

fieldTest("a paused source is refused after receipt reservation but before credential read or ingest", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "v048-vector-seed-paused-"));
  chmodSync(temporary, 0o700);
  try {
    const receiptPath = join(realpathSync(temporary), "seed-receipt.json");
    const fixture = createFetchFixture({
      health: activeHealth({
        ok: false,
        status: "paused-for-upgrade",
        accepting_documents: false,
        vector_drain_mode: "paused-for-upgrade",
      }),
    });
    let credentialReads = 0;
    await assert.rejects(() => runV048DisposableVectorSeed({
      manifest: manifestFixture(),
      manifestPath: "/private/source.manifest.json",
      installerRoot: "/reviewed/package",
      binding: bindingFixture(),
      receiptPath,
    }, {
      fetchImpl: fixture.fetchImpl,
      resolveAdminKey: async () => {
        credentialReads += 1;
        return ADMIN_KEY;
      },
      makeSignal: () => undefined,
      sleep: async () => {},
      revalidateLocalBindings: async () => true,
    }), /V048_SEED_SOURCE_NOT_ACTIVE/);
    assert.equal(credentialReads, 0);
    assert.equal(fixture.state.calls.length, 1);
    assert.equal(fixture.state.calls[0].path, "/health");
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).status, "execution_in_progress");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

fieldTest("receipt marker tampering during opening health blocks credential and authenticated access", async (t) => {
  for (const marker of ["final", "pending"]) {
    await t.test(marker, async () => {
      const temporary = mkdtempSync(join(tmpdir(), `v048-receipt-${marker}-tamper-`));
      chmodSync(temporary, 0o700);
      try {
        const receiptPath = join(realpathSync(temporary), "seed-receipt.json");
        const pendingPath = receiptPath.replace(/\.json$/u, ".pending.json");
        const fixture = createFetchFixture();
        let credentialReads = 0;
        let tampered = false;
        const fetchImpl = async (...args) => {
          const response = await fixture.fetchImpl(...args);
          if (!tampered && new URL(args[0]).pathname === "/health") {
            unlinkSync(marker === "final" ? receiptPath : pendingPath);
            tampered = true;
          }
          return response;
        };
        await assert.rejects(() => runV048DisposableVectorSeed({
          manifest: manifestFixture(),
          manifestPath: "/private/source.manifest.json",
          installerRoot: "/reviewed/package",
          binding: bindingFixture(),
          receiptPath,
        }, {
          fetchImpl,
          resolveAdminKey: async () => {
            credentialReads += 1;
            return ADMIN_KEY;
          },
          makeSignal: () => undefined,
          sleep: async () => {},
          revalidateLocalBindings: async () => true,
        }), /V048_SEED_RECEIPT_RESERVATION_CHANGED/);
        assert.equal(credentialReads, 0);
        assert.deepEqual(
          fixture.state.calls.map(({ path, authenticated }) => ({ path, authenticated })),
          [{ path: "/health", authenticated: false }],
        );
        assert.equal(fixture.state.documents, 0);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
});

fieldTest("health must identify the exact disposable Brain and exact schema 46 before credential use", async (t) => {
  const cases = [
    ["wrong Brain", { brain: "another-brain" }],
    ["missing Brain", { brain: undefined }],
    ["older schema", { schema_version: 45 }],
    ["newer schema", { schema_version: 47 }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const temporary = mkdtempSync(join(tmpdir(), "v048-health-identity-"));
      chmodSync(temporary, 0o700);
      try {
        const fixture = createFetchFixture({ health: activeHealth(overrides) });
        let credentialReads = 0;
        await assert.rejects(() => runV048DisposableVectorSeed({
          manifest: manifestFixture(),
          manifestPath: "/private/source.manifest.json",
          installerRoot: "/reviewed/package",
          binding: bindingFixture(),
          receiptPath: join(realpathSync(temporary), "seed-receipt.json"),
        }, {
          fetchImpl: fixture.fetchImpl,
          resolveAdminKey: async () => {
            credentialReads += 1;
            return ADMIN_KEY;
          },
          makeSignal: () => undefined,
          sleep: async () => {},
          revalidateLocalBindings: async () => true,
        }), /V048_SEED_HEALTH_IDENTITY_MISMATCH/);
        assert.equal(credentialReads, 0);
        assert.deepEqual(fixture.state.calls.map(({ path }) => path), ["/health"]);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
});

fieldTest("final inventory requires exact document and chunk flags and uses observed chunk counts", async (t) => {
  const cases = [
    ["document flag", { document_counts_exact: false }],
    ["chunk flag", { chunk_counts_exact: false }],
    ["observed documents", { documents: V048_SEED_DOCUMENT_COUNT - 1 }],
    ["observed chunks", { chunks: V048_SEED_DOCUMENT_COUNT - 1 }],
  ];
  for (const [name, finalInventoryRow] of cases) {
    await t.test(name, async () => {
      const temporary = mkdtempSync(join(tmpdir(), "v048-exact-inventory-"));
      chmodSync(temporary, 0o700);
      try {
        const fixture = createFetchFixture({ finalInventoryRow });
        await assert.rejects(() => runV048DisposableVectorSeed({
          manifest: manifestFixture(),
          manifestPath: "/private/source.manifest.json",
          installerRoot: "/reviewed/package",
          binding: bindingFixture(),
          receiptPath: join(realpathSync(temporary), "seed-receipt.json"),
        }, {
          fetchImpl: fixture.fetchImpl,
          resolveAdminKey: async () => ADMIN_KEY,
          makeSignal: () => undefined,
          sleep: async () => {},
          revalidateLocalBindings: async () => true,
        }), /V048_SEED_FINAL_CORPUS_INVALID/);
        assert.equal(fixture.state.calls.some(({ path }) => path === "/api/rag/think"), false);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
});

fieldTest("manifest mutation during credential resolution is caught before authenticated provider access", async () => {
  const fixture = createLocalBindingFixture();
  try {
    const local = inspectV048SeederLocalBindings(fixture.options, fixture.dependencies);
    const provider = createFetchFixture();
    let credentialReads = 0;
    await assert.rejects(() => runV048DisposableVectorSeed({
      manifest: local.manifest,
      manifestPath: local.manifestPath,
      installerRoot: local.installerRoot,
      sourceRoot: local.sourceRoot,
      binding: local.binding,
      receiptPath: fixture.options.receiptPath,
    }, {
      fetchImpl: provider.fetchImpl,
      resolveAdminKey: async () => {
        credentialReads += 1;
        writeFileSync(local.manifestPath, `${JSON.stringify(manifestFixture())}\n`);
        return ADMIN_KEY;
      },
      makeSignal: () => undefined,
      sleep: async () => {},
      revalidateLocalBindings: local.revalidate,
    }), /V048_SEED_MANIFEST_BINDING_MISMATCH/);
    assert.equal(credentialReads, 1);
    assert.deepEqual(provider.state.calls.map(({ path, authenticated }) => ({ path, authenticated })), [
      { path: "/health", authenticated: false },
    ]);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

fieldTest("private binding mutation after inspection refuses before provider access", async () => {
  const fixture = createLocalBindingFixture();
  try {
    const local = inspectV048SeederLocalBindings(fixture.options, fixture.dependencies);
    writeFileSync(local.bindingPath, `${JSON.stringify(fixture.binding)}\n`);
    let providerCalls = 0;
    await assert.rejects(() => runV048DisposableVectorSeed({
      manifest: local.manifest,
      manifestPath: local.manifestPath,
      installerRoot: local.installerRoot,
      sourceRoot: local.sourceRoot,
      binding: local.binding,
      receiptPath: fixture.options.receiptPath,
    }, {
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse(activeHealth());
      },
      resolveAdminKey: async () => ADMIN_KEY,
      revalidateLocalBindings: local.revalidate,
    }), /V048_SEED_BINDING_CHANGED/);
    assert.equal(providerCalls, 0);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

fieldTest("receipt output inside either execution tree refuses before provider or credential access", async (t) => {
  for (const selected of ["source", "installed"]) {
    await t.test(selected, async () => {
      const created = mkdtempSync(join(tmpdir(), "v048-receipt-containment-"));
      chmodSync(created, 0o700);
      const temporary = realpathSync(created);
      const sourceRoot = join(temporary, "source");
      const installerRoot = join(temporary, "installed");
      mkdirSync(sourceRoot, { mode: 0o700 });
      mkdirSync(installerRoot, { mode: 0o700 });
      let providerCalls = 0;
      let credentialReads = 0;
      try {
        await assert.rejects(() => runV048DisposableVectorSeed({
          manifest: manifestFixture(),
          manifestPath: "/private/source.manifest.json",
          installerRoot,
          sourceRoot,
          binding: bindingFixture(),
          receiptPath: join(selected === "source" ? sourceRoot : installerRoot, "receipt.json"),
        }, {
          fetchImpl: async () => {
            providerCalls += 1;
            return jsonResponse(activeHealth());
          },
          resolveAdminKey: async () => {
            credentialReads += 1;
            return ADMIN_KEY;
          },
          revalidateLocalBindings: async () => true,
        }), /V048_SEED_RECEIPT_INSIDE_EXECUTION_TREE/);
        assert.equal(providerCalls, 0);
        assert.equal(credentialReads, 0);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
});
