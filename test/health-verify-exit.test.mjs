/**
 * Zero-network CLI exit tests for the two commands that establish whether the
 * required infrastructure is actually usable. This file doubles as its own
 * `--import` fixture so no second helper or real credential is needed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const SCENARIO = String(process.env.BRAIN_HEALTH_VERIFY_SCENARIO || "");
const FIXTURE_ADMIN = "fixture-admin-label";
const FIXTURE_TOKEN = "fixture-cloudflare-label";

function json(body, status = 200) {
  if (body && typeof body === "object" && body.backend &&
      SCENARIO !== "health-documents-version-missing" &&
      !Object.prototype.hasOwnProperty.call(body, "version")) {
    body = { ...body, version: "0.1.9" };
  }
  if (body && typeof body === "object" && body.backend &&
      SCENARIO !== "health-documents-mode-missing" &&
      !Object.prototype.hasOwnProperty.call(body, "vector_drain_mode")) {
    body = {
      ...body,
      vector_drain_mode: [
        "health-paused-ready",
        "health-paused-vector-count-mismatch",
        "health-mixed-generation-vector-count-mismatch",
      ].includes(SCENARIO) ? "paused-for-upgrade" : "active",
    };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

if (SCENARIO) {
  const userRoot = String(process.env.BRAIN_HEALTH_VERIFY_USER_ROOT || "");
  if (!userRoot) throw new Error("BRAIN_HEALTH_VERIFY_USER_ROOT is required");
  os.homedir = () => userRoot;
  syncBuiltinESMExports();
  let documentRequests = 0;

  globalThis.fetch = async (input, options = {}) => {
    const url = requestUrl(input);

    if (url.hostname === "fixture.invalid" && url.pathname === "/health") {
      if (["health-paused-ready", "health-paused-vector-count-mismatch"].includes(SCENARIO)) {
        return json({
          ok: false,
          status: "paused-for-upgrade",
          accepting_documents: false,
          version: "0.1.9",
          vector_writer_protocol: "lease-v1",
          vector_drain_mode: "paused-for-upgrade",
        });
      }
      if (SCENARIO === "health-public-incomplete") {
        return json({ ok: true, version: "0.1.9" });
      }
      return json({
        ok: true,
        status: "ok",
        accepting_documents: true,
        version: "0.1.9",
        vector_writer_protocol: "lease-v1",
        vector_drain_mode: "active",
      });
    }
    if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
      if (new Headers(options.headers).get("X-Admin-Key") !== FIXTURE_ADMIN) {
        return json({ error: "fixture unauthorized" }, 401);
      }
      documentRequests++;
      if ((SCENARIO === "health-documents-timeout-once" && documentRequests === 1) ||
          (SCENARIO === "health-documents-timeout-twice" && documentRequests <= 2)) {
        // A translated timeout must never echo even the inert credential used
        // by this isolated fixture.
        const error = new Error(`fixture timeout while using ${new Headers(options.headers).get("X-Admin-Key")}`);
        error.name = "TimeoutError";
        throw error;
      }
      if (SCENARIO === "health-documents-nonretryable-then-healthy" && documentRequests === 1) {
        throw new Error("fixture permanent transport refusal");
      }
      if (SCENARIO === "health-documents-http-then-healthy" && documentRequests === 1) {
        return json({ error: "fixture temporary-looking HTTP response" }, 503);
      }
      if (SCENARIO === "health-documents-unreachable") {
        return json({ error: "fixture documents unavailable" }, 503);
      }
      if (SCENARIO === "health-documents-invalid") {
        return new Response("<html>fixture gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (SCENARIO === "health-backlog-error") {
        return json({ backend: "d1", rows: [], vector_backlog: { error: "fixture D1 failure" } });
      }
      if (SCENARIO === "health-backlog-missing") {
        return json({ backend: "d1", rows: [] });
      }
      if (SCENARIO === "health-backlog-malformed") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: "0", upserts: 0, deletes: 0 },
        });
      }
      if (SCENARIO === "health-backlog-oldest-missing") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: 1, upserts: 1, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: false, reason: "vector_work_queued",
            expected_vectors: 1, actual_vectors: 0, pending: 1, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-backlog-old") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: {
            pending: 10_240,
            upserts: 10_240,
            deletes: 0,
            submitted: 0,
            oldest_queued_at: Date.now() - 181 * 60 * 1000,
          },
          vector_readiness: {
            ready: false, reason: "vector_work_queued",
            expected_vectors: 10_240, actual_vectors: 0, pending: 10_240, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-vector-processing") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: {
            pending: 1,
            upserts: 1,
            deletes: 0,
            submitted: 1,
            oldest_queued_at: Date.now() - 1_000,
          },
          vector_readiness: {
            ready: false, reason: "accepted_mutation_processing",
            expected_vectors: 1, actual_vectors: 0, pending: 1, submitted: 1,
          },
        });
      }
      if ([
        "health-vector-count-mismatch",
        "health-paused-vector-count-mismatch",
        "health-mixed-generation-vector-count-mismatch",
        "health-documents-mode-missing",
      ].includes(SCENARIO)) {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: false, reason: "vector_count_mismatch",
            expected_vectors: 10, actual_vectors: 0, pending: 0, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-vector-count-excess") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: false, reason: "vector_count_mismatch",
            expected_vectors: 10, actual_vectors: 13, pending: 0, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-mixed-generation-ready") {
        return json({
          backend: "d1",
          version: "0.1.8",
          vector_drain_mode: "active",
          rows: [],
          vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: true, reason: null,
            expected_vectors: 0, actual_vectors: 0, pending: 0, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-backend-mismatch") {
        return json({ backend: "supabase", rows: [] });
      }
      if (SCENARIO === "health-backend-case-bypass") {
        return json({ backend: "D1", rows: [] });
      }
      if (SCENARIO === "health-backend-unknown") {
        return json({ backend: "fixture-store", rows: [] });
      }
      if (SCENARIO === "health-default-backend-mismatch") {
        return json({ backend: "supabase", rows: [] });
      }
      return json({
        backend: "d1",
        rows: [],
        vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
        vector_readiness: {
          ready: true, reason: null,
          expected_vectors: 0, actual_vectors: 0, pending: 0, submitted: 0,
        },
      });
    }

    if (url.hostname === "api.cloudflare.com" && url.pathname === "/client/v4/accounts") {
      return json({ success: true, result: [{ id: "fixture-account", name: "Fixture account" }] });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/r2/buckets")) {
      // A manifest with no bucket must never reach this endpoint. Throwing here
      // names a reintroduced probe instead of letting it pass as one more warning.
      if (SCENARIO === "verify-no-r2") {
        throw new Error("verify probed R2 for a manifest that asks for no bucket");
      }
      if (SCENARIO === "verify-optional-warnings") {
        return json({ success: false, errors: [{ code: 9109, message: "fixture R2 unavailable" }] }, 403);
      }
      return json({ success: true, result: { buckets: [] } });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/d1/database")) {
      if (SCENARIO === "verify-d1-unreachable") {
        return json({ success: false, errors: [{ code: 9109, message: "fixture D1 unavailable" }] }, 403);
      }
      return json({ success: true, result: [] });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/workers/scripts")) {
      return json({ success: true, result: [] });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/vectorize/v2/indexes")) {
      if (SCENARIO === "verify-optional-warnings") {
        return json({ success: false, errors: [{ code: 9109, message: "fixture Vectorize unavailable" }] }, 403);
      }
      return json({ success: true, result: [] });
    }

    throw new Error(`unexpected fixture request: ${url.origin}${url.pathname}`);
  };
} else {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CLI = join(HERE, "..", "brain.mjs");
  const THIS_FILE = import.meta.url;
  let fail = 0;
  let ran = 0;
  const check = (name, condition, detail = "") => {
    ran++;
    console.log((condition ? "PASS  " : "FAIL  ") + name +
      (condition ? "" : "  " + String(detail).slice(0, 300)));
    if (!condition) fail++;
  };
  const strip = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

  function safeChildEnvironment() {
    const environment = {};
    for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

  function runScenario(scenario, command, { adminKey = false, cloudflareToken = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "brain-health-verify-exit-"));
    const userRoot = join(directory, "isolated-user-root");
    const manifestPath = join(directory, "fixture.manifest.json");
    mkdirSync(userRoot, { recursive: true });
    const cloudflare = { account_id: "fixture-account" };
    if (scenario !== "health-default-backend-mismatch") cloudflare.storage = "d1";
    // Verify only probes R2 for a manifest that asks for a bucket (F-09). The
    // optional-warnings scenario is about an install that WANTS R2 and cannot
    // reach it, so it has to name one; verify-no-r2 deliberately names none.
    if (scenario === "verify-optional-warnings") cloudflare.r2_bucket = "fixture-assets";
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture-brain" },
      brain: { domain: "fixture.invalid", worker_name: "fixture-brain" },
      infrastructure: { cloudflare },
    }));

    const environment = {
      ...safeChildEnvironment(),
      BRAIN_HEALTH_VERIFY_SCENARIO: scenario,
      BRAIN_HEALTH_VERIFY_USER_ROOT: userRoot,
    };
    if (adminKey) environment.ADMIN_KEY = FIXTURE_ADMIN;
    if (cloudflareToken) environment.CLOUDFLARE_API_TOKEN = FIXTURE_TOKEN;

    const result = spawnSync(process.execPath, ["--import", THIS_FILE, CLI, command, manifestPath], {
      encoding: "utf-8",
      env: environment,
      timeout: 30_000,
    });
    const output = strip(`${result.stdout || ""}${result.stderr || ""}`);
    rmSync(directory, { recursive: true, force: true });
    return { code: result.status, output, error: result.error };
  }

  const missingKey = runScenario("health-ok", "health");
  check("health exits nonzero when no admin key is available",
    missingKey.code === 1 && /no admin key.*authenticated documents endpoint/is.test(missingKey.output),
    missingKey.output);
  check("missing-key health never claims the documents endpoint passed",
    !/ok\s+documents endpoint/i.test(missingKey.output), missingKey.output);

  const documentsDown = runScenario("health-documents-unreachable", "health", { adminKey: true });
  check("health exits nonzero when authenticated documents cannot be reached",
    documentsDown.code === 1 && /documents endpoint 503.*authenticated access was not proven/is.test(documentsDown.output),
    documentsDown.output);
  check("an unavailable documents endpoint never prints green",
    !/ok\s+documents endpoint/i.test(documentsDown.output), documentsDown.output);

  const invalidDocuments = runScenario("health-documents-invalid", "health", { adminKey: true });
  check("health rejects a 200 that is not a real documents inventory",
    invalidDocuments.code === 1 && /did not return JSON.*authenticated access was not proven/is.test(invalidDocuments.output),
    invalidDocuments.output);

  const healthy = runScenario("health-ok", "health", { adminKey: true });
  check("health still succeeds after authenticated documents are proven",
    healthy.code === 0 && /documents endpoint 200/.test(healthy.output) &&
      /vector index is query-ready/.test(healthy.output), healthy.output);

  const timeoutThenHealthy = runScenario("health-documents-timeout-once", "health", { adminKey: true });
  check("health retries one retryable documents transport timeout and then verifies normally",
    timeoutThenHealthy.code === 0 && /still checking once more/i.test(timeoutThenHealthy.output) &&
      /documents endpoint 200/.test(timeoutThenHealthy.output) &&
      /vector index is query-ready/.test(timeoutThenHealthy.output),
    timeoutThenHealthy.output);

  const twoTimeouts = runScenario("health-documents-timeout-twice", "health", { adminKey: true });
  check("health stops after one documents transport retry",
    twoTimeouts.code === 1 && /still checking once more/i.test(twoTimeouts.output) &&
      /private readiness check timed out after 60s/i.test(twoTimeouts.output) &&
      !/documents endpoint 200|vector index is query-ready/i.test(twoTimeouts.output),
    twoTimeouts.output);

  const nonretryable = runScenario("health-documents-nonretryable-then-healthy", "health", { adminKey: true });
  check("health does not retry a nonretryable documents transport failure",
    nonretryable.code === 1 && /fixture permanent transport refusal/i.test(nonretryable.output) &&
      !/still checking once more|documents endpoint 200|vector index is query-ready/i.test(nonretryable.output),
    nonretryable.output);

  const httpFailure = runScenario("health-documents-http-then-healthy", "health", { adminKey: true });
  check("health does not retry an HTTP documents failure",
    httpFailure.code === 1 && /documents endpoint 503/i.test(httpFailure.output) &&
      !/still checking once more|documents endpoint 200|vector index is query-ready/i.test(httpFailure.output),
    httpFailure.output);

  const incompletePublic = runScenario("health-public-incomplete", "health", { adminKey: true });
  check("health rejects a 200 public response that cannot prove an exact Worker state",
    incompletePublic.code === 1 && /did not return one exact Worker version and writer state/i.test(incompletePublic.output) &&
      !/documents endpoint 200/.test(incompletePublic.output), incompletePublic.output);

  const versionlessDocuments = runScenario("health-documents-version-missing", "health", { adminKey: true });
  check("health rejects authenticated readiness that carries no Worker version",
    versionlessDocuments.code === 1 && /could not prove its Worker version/i.test(versionlessDocuments.output) &&
      !/vector index is query-ready/.test(versionlessDocuments.output),
    versionlessDocuments.output);

  for (const scenario of ["health-backlog-error", "health-backlog-missing", "health-backlog-malformed"]) {
    const invalidBacklog = runScenario(scenario, "health", { adminKey: true });
    check(`${scenario} exits nonzero instead of claiming semantic indexing is healthy`,
      invalidBacklog.code === 1 && /could not prove a valid D1 vector backlog/is.test(invalidBacklog.output) &&
        !/vector index is query-ready/.test(invalidBacklog.output), invalidBacklog.output);
  }

  const missingOldest = runScenario("health-backlog-oldest-missing", "health", { adminKey: true });
  check("health rejects queued work whose age cannot be proven",
    missingOldest.code === 1 && /without a valid oldest timestamp/is.test(missingOldest.output),
    missingOldest.output);

  const oldQueue = runScenario("health-backlog-old", "health", { adminKey: true });
  check("an old active queue stays non-green without being called stalled from one snapshot",
    oldQueue.code === 1 && /10240 vector operation\(s\) are still processing.*oldest queued/is.test(oldQueue.output) &&
      /Age alone does not prove a stall.*one snapshot cannot tell/is.test(oldQueue.output) &&
      !/vector operation\(s\) are stalled/i.test(oldQueue.output) &&
      !/vector index is caught up/.test(oldQueue.output), oldQueue.output);
  check("a falling pending count is explicitly working, not a reason to start an update",
    /pending count is falling between checks, indexing is.*working/is.test(oldQueue.output) &&
      oldQueue.output.includes(renderCliCommands(
        "Do not start `brain update` merely to accelerate a healthy active-mode queue;"
      )),
    oldQueue.output);

  const processing = runScenario("health-vector-processing", "health", { adminKey: true });
  check("health cannot green an accepted mutation before query visibility",
    processing.code === 1 && /not query-visible yet.*accepted by Vectorize/is.test(processing.output) &&
      !/vector index is query-ready/.test(processing.output),
    processing.output);

  // A manual drain takes the same lease the scheduled drain holds, so the two
  // exclude each other rather than adding up, and the manual runner is slower.
  // Health used to hand an old-queue operator that exact command. Assert it never
  // INSTRUCTS one again, and that the snapshot says what it cannot prove, rather than merely
  // never naming the command.
  // The warning names a command, and on Windows the CLI renders that command as a
  // runnable invocation rather than the bare word. Build the expectation through
  // the product's own renderer, or this assertion passes on macOS and fails on the
  // one platform the warning exists for.
  check("health never instructs a manual drain, and warns against it for an old queue",
    !/(Clear it now with|Finish and confirm visibility with|Re-run `brain drain)/i
        .test(oldQueue.output + processing.output) &&
      oldQueue.output.includes(renderCliCommands("Do NOT run `brain drain`")),
    oldQueue.output + processing.output);

  const countMismatch = runScenario("health-vector-count-mismatch", "health", { adminKey: true });
  check("health rejects an empty queue when Vectorize is still missing vectors",
    countMismatch.code === 1 && /Vectorize holds 0 vector\(s\), but D1 requires 10/is.test(countMismatch.output) &&
      countMismatch.output.includes(renderCliCommands("brain diagnose <manifest>")) &&
      countMismatch.output.includes(renderCliCommands("brain reindex <manifest> --yes")),
    countMismatch.output);

  const pausedCountMismatch = runScenario("health-paused-vector-count-mismatch", "health", { adminKey: true });
  check("ordinary health cannot pass a same-generation paused brain",
    pausedCountMismatch.code === 1 &&
      /paused for an update.*ordinary health cannot pass/is.test(pausedCountMismatch.output) &&
      pausedCountMismatch.output.includes(renderCliCommands("brain update <manifest>")) &&
      !pausedCountMismatch.output.includes(renderCliCommands("brain reindex <manifest> --yes")),
    pausedCountMismatch.output);

  const pausedReady = runScenario("health-paused-ready", "health", { adminKey: true });
  check("a query-ready receipt cannot turn a paused brain green",
    pausedReady.code === 1 && /paused for an update.*ordinary health cannot pass/is.test(pausedReady.output) &&
      !/vector index is query-ready/.test(pausedReady.output), pausedReady.output);

  const mixedGeneration = runScenario("health-mixed-generation-vector-count-mismatch", "health", { adminKey: true });
  check("health refuses to splice an active public receipt with paused authenticated readiness",
    mixedGeneration.code === 1 &&
      /did not match the public Worker's version and writer mode/is.test(mixedGeneration.output) &&
      !mixedGeneration.output.includes(renderCliCommands("brain reindex <manifest> --yes")) &&
      !mixedGeneration.output.includes(renderCliCommands("brain drain <manifest>")),
    mixedGeneration.output);

  const mixedReady = runScenario("health-mixed-generation-ready", "health", { adminKey: true });
  check("two individually healthy generations cannot produce a false-green readiness result",
    mixedReady.code === 1 && /did not match the public Worker's version and writer mode/is.test(mixedReady.output) &&
      !/vector index is query-ready/.test(mixedReady.output), mixedReady.output);

  const unboundMode = runScenario("health-documents-mode-missing", "health", { adminKey: true });
  check("health refuses recovery commands when readiness carries no same-generation writer mode",
    unboundMode.code === 1 && /could not prove its vector writer mode/i.test(unboundMode.output) &&
      !unboundMode.output.includes(renderCliCommands("brain reindex <manifest> --yes")) &&
      !unboundMode.output.includes(renderCliCommands("brain drain <manifest>")),
    unboundMode.output);

  const countExcess = runScenario("health-vector-count-excess", "health", { adminKey: true });
  check("health does not claim reindex alone can remove provider-only excess vectors",
    countExcess.code === 1 && /Vectorize holds 13 vector\(s\), but D1 requires 10/is.test(countExcess.output) &&
      /provider-only excess vectors.*reindex cannot enumerate or remove/is.test(countExcess.output) &&
      /supervised recovery.*recreate\/rebind a clean/is.test(countExcess.output),
    countExcess.output);

  const mismatch = runScenario("health-backend-mismatch", "health", { adminKey: true });
  check("health rejects a valid endpoint serving a backend different from the manifest",
    mismatch.code === 1 && /different storage backend than this manifest/is.test(mismatch.output),
    mismatch.output);

  const caseBypass = runScenario("health-backend-case-bypass", "health", { adminKey: true });
  check("backend normalization cannot bypass the required D1 backlog proof",
    caseBypass.code === 1 && /could not prove a valid D1 vector backlog/is.test(caseBypass.output),
    caseBypass.output);

  const unknownBackend = runScenario("health-backend-unknown", "health", { adminKey: true });
  check("health rejects an unsupported backend instead of treating authentication as readiness",
    unknownBackend.code === 1 && /unsupported storage backend/is.test(unknownBackend.output),
    unknownBackend.output);

  const defaultMismatch = runScenario("health-default-backend-mismatch", "health", { adminKey: true });
  check("an omitted manifest storage field still expects the standard D1 backend",
    defaultMismatch.code === 1 && /different storage backend than this manifest/is.test(defaultMismatch.output),
    defaultMismatch.output);

  const d1Down = runScenario("verify-d1-unreachable", "verify", { cloudflareToken: true });
  check("verify exits nonzero when required D1 is unreachable",
    d1Down.code === 1 && /D1 is not reachable.*required database cannot be verified/is.test(d1Down.output),
    d1Down.output);
  check("unreachable D1 is never downgraded to a warning",
    !/warn\s+D1 not reachable/i.test(d1Down.output), d1Down.output);

  const noR2 = runScenario("verify-no-r2", "verify", { cloudflareToken: true });
  check("verify does not probe R2 for a manifest that has no bucket",
    noR2.code === 0 && !/R2 is not ready/.test(noR2.output) &&
      /does not use R2 file storage/.test(noR2.output),
    noR2.output);

  const optionalWarnings = runScenario("verify-optional-warnings", "verify", { cloudflareToken: true });
  check("optional R2 and Vectorize access remain warnings with the ordinary owner path",
    optionalWarnings.code === 0 && /R2 is not ready/.test(optionalWarnings.output) &&
      /Provision can use browser sign-in as a temporary fallback/.test(optionalWarnings.output) &&
      /D1 is reachable/.test(optionalWarnings.output) && /Workers is reachable/.test(optionalWarnings.output),
    optionalWarnings.output);

  const outputs = [
    missingKey, documentsDown, invalidDocuments, healthy,
    timeoutThenHealthy, twoTimeouts, nonretryable, httpFailure,
    d1Down, optionalWarnings,
  ]
    .map((result) => result.output).join("\n");
  check("fixtures never expose even their inert credential labels",
    !outputs.includes(FIXTURE_ADMIN) && !outputs.includes(FIXTURE_TOKEN), outputs);

  console.log(fail ? `\n${fail} FAILURES` : `\nhealth/verify exits: all ${ran} tests passed`);
  if (fail) process.exit(1);
}
