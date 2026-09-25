import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DISPOSABLE_TEARDOWN_NAMES,
  executeDisposableTeardownProvider,
} from "../operations/cloudflare-disposable-teardown-provider.mjs";
import {
  inspectDisposableRecoveryDeploymentPreparation,
} from "../operations/cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  disposableRecoveryDeploymentCampaignFingerprint,
  disposableRecoveryTargetA4Fingerprint,
  disposableRecoveryVectorizeMutationQuiescenceClaim,
} from "../operations/disposable-recovery-deployment-receipt.mjs";
import {
  disposableRecoveryProvisionApprovalFingerprint,
  disposableRecoveryProvisionPaths,
  disposableRecoveryProvisioningBinding,
  runDisposableRecoveryProvisionPhase,
  runDisposableRecoveryProvisionPreflight,
} from "../operations/disposable-recovery-field-provision.mjs";
import {
  executeDisposableRecoveryFieldTeardown,
  parseDisposableRecoveryFieldTeardownArguments,
} from "../operations/disposable-recovery-field-teardown-cli.mjs";
import {
  DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  DISPOSABLE_TEARDOWN_TOKEN_SERVICE,
  assertDisposableRecoveryBrainTeardownReceipt,
  assertDisposableRecoveryTeardownA12EvidenceCapability,
  assertDisposableTeardownProviderResult,
  assertDisposableRecoveryTeardownPreview,
  createDisposableTeardownProviderInvoker,
  readDisposableRecoveryTeardownA12Evidence,
  readDisposableRecoveryTeardownProvisionArtifacts,
  readDisposableRecoverySourceTeardownReceipt,
  runDisposableRecoveryTeardownMutation,
  runDisposableRecoveryTeardownPreview,
  validateDisposableTeardownWrapperProgram,
} from "../operations/disposable-recovery-field-teardown.mjs";
import {
  DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  assertDisposableRecoveryManualTeardownClosure,
} from "../operations/disposable-recovery-field-acceptance.mjs";
import {
  assertDisposableRecoveryFieldKeychainVerificationCapability,
  DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME,
} from "../operations/disposable-recovery-field-keychain-prep.mjs";
import {
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptPendingPath,
  readPrivateAggregateReceipt,
} from "../operations/private-aggregate-receipt.mjs";
import {
  VERIFIED_RECOVERY_STAGES,
  bindVerifiedRecoveryFieldProof,
  initializeVerifiedRecovery,
  reviewVerifiedRecoveryVectorizeMutationQuiescence,
  runVerifiedRecovery,
  writeVerifiedRecoveryState,
} from "../operations/verified-recovery.mjs";
import {
  createTestDisposableRecoveryK0Capability,
} from "./helpers/disposable-recovery-k0-capability.mjs";
import {
  createDisposableCampaignAuthorityFixture,
} from "./helpers/disposable-campaign-authority.mjs";

const MACOS_PRIVATE_RECEIPT_SKIP =
  "requires a verifier-minted K0 capability and private receipt ACL proof";
function testWithMacosPrivateReceipt(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  return test(name, {
    ...options,
    skip: process.platform === "win32" ? MACOS_PRIVATE_RECEIPT_SKIP : options.skip,
  }, fn);
}

const ACCOUNT = "a".repeat(32);
const SOURCE_WORKER_ID = "b".repeat(32);
const TARGET_WORKER_ID = "c".repeat(32);
const SOURCE_D1 = "11111111-1111-4111-8111-111111111111";
const TARGET_D1 = "22222222-2222-4222-8222-222222222222";
const SOURCE_VERSION = "33333333-3333-4333-8333-333333333333";
const TARGET_VERSION = "44444444-4444-4444-8444-444444444444";
const VECTOR_CREATED_ON = "2022-11-15T18:25:44.442097Z";
const HASH = (letter) => letter.repeat(64);
const TOKEN = Buffer.from("fixture-cloudflare-token-value");
const MAINTENANCE_WINDOW = Object.freeze({
  single_operator: true,
  other_actors_paused: true,
});
const RETAINED_CAPABILITY_DIRECTORIES = new Set();
process.once("exit", () => {
  for (const directory of RETAINED_CAPABILITY_DIRECTORIES) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* temporary capability evidence only */ }
  }
});
const CORE_TEST_K0 = process.platform === "win32" ? null
  : await createTestDisposableRecoveryK0Capability({
    candidate_sha: "a".repeat(40),
    candidate_tree_sha: "b".repeat(40),
    package_sha256: HASH("a"),
    field_receipt_sha256: HASH("b"),
    account_id: ACCOUNT,
  });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function privateReceiptSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

const WORKER_MISSING_CODE_SHA256 = sha256(JSON.stringify({ codes: [10007] }));

function injectedFinalizationCrash(stage, failure) {
  if (stage === "post_commit_pre_publish") {
    return { publish() { throw failure; } };
  }
  if (stage === "post_final_sync") {
    return { removePending() { throw failure; } };
  }
  if (stage === "post_pending_removal") {
    return { removeCommit() { throw failure; } };
  }
  if (stage === "post_commit_removal") {
    let directorySyncs = 0;
    return {
      syncDirectory() {
        directorySyncs += 1;
        if (directorySyncs === 3) throw failure;
      },
    };
  }
  throw new Error(`unknown fixture crash stage ${stage}`);
}

function jsonResponse(value, status = 200, url = "") {
  const bytes = Buffer.from(JSON.stringify(value));
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.length),
    },
  });
}

function ok(result) {
  return { success: true, errors: [], messages: [], result };
}

function okPaged(result, {
  page = 1,
  perPage = 100,
  totalCount = result.length,
  mode = "valid",
} = {}) {
  const value = ok(result);
  if (mode === "missing") return value;
  value.result_info = {
    count: result.length,
    page,
    per_page: perPage,
    total_count: totalCount,
    total_pages: Math.max(1, Math.ceil(totalCount / perPage)),
  };
  if (mode === "unexpected") value.result_info.cursor = "fixture-cursor";
  return value;
}

function okD1Page(result, {
  page = 1,
  perPage = 100,
  totalCount = result.length,
  mode = "valid",
} = {}) {
  const value = ok(result);
  if (mode === "missing") return value;
  value.result_info = {
    count: result.length,
    page,
    per_page: perPage,
    total_count: totalCount,
  };
  if (mode === "unexpected") value.result_info.cursor = "fixture-cursor";
  return value;
}

function missing(code = 1000) {
  return {
    success: false,
    errors: [{ code, message: "fixture resource not found" }],
    messages: [],
    result: null,
  };
}

function providerTarget(role = "source") {
  const source = role === "source";
  const name = DISPOSABLE_TEARDOWN_NAMES[role];
  return {
    account_id: ACCOUNT,
    worker_id: source ? SOURCE_WORKER_ID : TARGET_WORKER_ID,
    worker_name: name,
    database_id: source ? SOURCE_D1 : TARGET_D1,
    database_name: name,
    vectorize_name: name,
    vectorize_created_on: VECTOR_CREATED_ON,
    other_worker_name: DISPOSABLE_TEARDOWN_NAMES[source ? "target" : "source"],
  };
}

function providerRequest(operation, {
  role = "source",
  kind = null,
  fingerprint = null,
} = {}) {
  return {
    schema_version: 1,
    operation,
    role,
    kind,
    target: providerTarget(role),
    expected_instance_fingerprint: fingerprint,
    maintenance_window: MAINTENANCE_WINDOW,
  };
}

function providerFixture({
  ambiguousKind = null,
  ambiguousDeletes = true,
  malformedWorker404 = false,
  driftSecondCapture = false,
  driftUnrelatedBinding = false,
  workerExactStatus = 404,
  workerIdMissingButNamePresent = false,
  exactWorkerReferenceMode = "valid",
  versionPaginationMode = "valid",
  versionCount = 1,
  d1PaginationMode = "valid",
  d1IdentityMode = "valid",
  domainPaginationMode = "missing",
  domainRows = [],
  workerDeleteMode = "official",
  d1DeleteMode = "official",
  vectorDeleteMode = "official",
  extraVectorRows = 0,
  extraD1Rows = 0,
  exactD1Missing = false,
  exactVectorizeMissing = false,
  vectorInventoryMode = "valid",
  arrayResultObjectMode = null,
  versionBindingMode = "valid",
  scriptIdentityMode = "valid",
  legacyRouteMode = "valid",
  legacyTailMode = "valid",
  scheduleMode = "valid",
  missingDiagnosticMode = "plain",
  vectorCreatedOnDriftAtRead = null,
} = {}) {
  const state = {
    source: {
      worker: true,
      vectorize: true,
      d1: true,
      vectorizeCreatedOn: VECTOR_CREATED_ON,
    },
    target: {
      worker: true,
      vectorize: true,
      d1: true,
      vectorizeCreatedOn: VECTOR_CREATED_ON,
    },
  };
  const calls = [];
  let sourceWorkerReads = 0;
  let inventoryPass = 0;
  let scheduleReads = 0;
  let sourceVectorReads = 0;
  const byRole = (name) => name === DISPOSABLE_TEARDOWN_NAMES.source
    ? "source"
    : name === DISPOSABLE_TEARDOWN_NAMES.target
      ? "target"
      : null;
  const workerId = (role) => role === "source" ? SOURCE_WORKER_ID : TARGET_WORKER_ID;
  const databaseId = (role) => role === "source" ? SOURCE_D1 : TARGET_D1;
  const versionId = (role) => role === "source" ? SOURCE_VERSION : TARGET_VERSION;
  const versionIds = (role) => Array.from({ length: versionCount }, (_, index) =>
    index === 0
      ? versionId(role)
      : `${role === "source" ? "33333333-3333-4333-8333" :
        "44444444-4444-4444-8444"}-${String(index).padStart(12, "0")}`);
  const missingResult = (code = 1000) => {
    const value = missing(code);
    if (missingDiagnosticMode === "valid_optional") {
      value.errors[0].documentation_url =
        "https://developers.cloudflare.com/api/operations/example";
      value.errors[0].source = { pointer: "/resource" };
      value.messages.push({
        code: 1000,
        message: "fixture diagnostic",
        source: {},
      });
    }
    if (missingDiagnosticMode === "invalid_url") {
      value.errors[0].documentation_url = "http://example.invalid/unsafe";
    }
    if (missingDiagnosticMode === "invalid_code") value.errors[0].code = 999;
    if (missingDiagnosticMode === "invalid_parameter") {
      value.errors[0].source = { parameter: "resource" };
    }
    if (missingDiagnosticMode === "invalid_header") {
      value.errors[0].source = { header: "authorization" };
    }
    return value;
  };
  const deleteResponse = (mode, result, { worker = false } = {}) => {
    if (mode === "timeout") {
      throw Object.assign(new Error("fixture timeout"), { name: "AbortError" });
    }
    if (mode === "empty") return new Response(null, { status: 204 });
    if (mode === "malformed_json") {
      return new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (mode === "wrong_content_type") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (mode === "redirect") {
      return new Response("{}", {
        status: 302,
        headers: {
          "content-type": "application/json",
          location: "https://example.invalid",
        },
      });
    }
    if (mode === "oversize") {
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String((1024 * 1024) + 1),
        },
      });
    }
    if (mode === "stream_read_error") {
      let pull = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (pull++ === 0) controller.enqueue(new TextEncoder().encode("{"));
          else controller.error(new Error("fixture stream read failure"));
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (mode === "token_reflection") {
      return jsonResponse(ok({ reflected: TOKEN.toString("utf8") }));
    }
    const statusMatch = /^status_(201|202|206)$/u.exec(mode);
    if (statusMatch) {
      return jsonResponse(
        worker ? { success: true, errors: [], messages: [] } : ok(result),
        Number(statusMatch[1]),
      );
    }
    if (mode === "missing_result") {
      return jsonResponse({ success: true, errors: [], messages: [] });
    }
    if (mode === "result_string") return jsonResponse(ok("deleted"));
    if (worker) return jsonResponse({ success: true, errors: [], messages: [] });
    return jsonResponse(ok(result));
  };

  const fetchImpl = async (urlInput, init) => {
    const url = new URL(urlInput);
    calls.push({ method: init.method, pathname: url.pathname, search: url.search });
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.match(init.headers.Authorization, /^Bearer /);
    const root = `/client/v4/accounts/${ACCOUNT}`;
    assert.ok(url.pathname.startsWith(root));
    const suffix = url.pathname.slice(root.length);

    if (init.method === "GET" && suffix === "/workers/scripts") {
      inventoryPass += 1;
      assert.equal(url.search, "");
      const result = ["source", "target"].filter((role) => state[role].worker).map((role) => ({
        [scriptIdentityMode === "script_name" ? "script_name" : "id"]:
          DISPOSABLE_TEARDOWN_NAMES[role],
        ...(legacyRouteMode === "missing" ? {} : {
          routes: legacyRouteMode === "null" ? null : [],
        }),
        ...(legacyTailMode === "missing" ? {} : {
          tail_consumers: legacyTailMode === "null"
            ? null
            : legacyTailMode === "script_name_alias"
              ? [{ script_name: DISPOSABLE_TEARDOWN_NAMES.source }]
              : legacyTailMode === "bare_string"
                ? [DISPOSABLE_TEARDOWN_NAMES.source]
              : [],
        }),
      }));
      return jsonResponse(ok(arrayResultObjectMode === "scripts"
        ? { items: result }
        : result));
    }
    const schedules = /^\/workers\/scripts\/([^/]+)\/schedules$/u.exec(suffix);
    if (schedules && init.method === "GET") {
      scheduleReads += 1;
      const role = byRole(decodeURIComponent(schedules[1]));
      if (!role || !state[role].worker || scheduleMode === "missing" ||
          scheduleMode === "drift_missing" && scheduleReads > 1) {
        return jsonResponse(missingResult(10007), 404);
      }
      if (scheduleMode === "malformed") return jsonResponse(ok({ schedules: null }));
      return jsonResponse(ok({
        schedules: scheduleMode === "nonempty"
          ? [{ cron: "0 0 * * *" }]
          : [],
      }));
    }
    if (init.method === "GET" && suffix === "/workers/domains") {
      assert.equal(url.searchParams.get("service"), DISPOSABLE_TEARDOWN_NAMES.source);
      assert.deepEqual([...url.searchParams.keys()], ["service"]);
      const rows = domainRows;
      if (arrayResultObjectMode === "domains") {
        return jsonResponse(ok({ items: rows }));
      }
      if (domainPaginationMode === "missing") return jsonResponse(ok(rows));
      const totalCount = domainPaginationMode === "unrelated"
        ? 101
        : domainRows.length;
      const body = okPaged(rows, { page: 1, perPage: 100, totalCount });
      if (domainPaginationMode === "global_zero_pages") {
        body.result_info.total_count = 2;
        body.result_info.total_pages = 0;
      }
      if (domainPaginationMode === "partial") {
        body.result_info = { count: rows.length, page: 1 };
      }
      if (domainPaginationMode === "contradictory") body.result_info.count += 1;
      if (domainPaginationMode === "truncated") body.result_info.total_pages += 1;
      if (domainPaginationMode === "unexpected") {
        body.result_info.cursor = "unexpected";
      }
      return jsonResponse(body);
    }
    const exactWorker = /^\/workers\/workers\/([a-f0-9]{32})$/u.exec(suffix);
    if (exactWorker && init.method === "GET") {
      const role = exactWorker[1] === SOURCE_WORKER_ID ? "source" : "target";
      if (!state[role].worker || workerIdMissingButNamePresent && role === "source") {
        return jsonResponse(
          malformedWorker404 && role === "source"
            ? missingResult(99999)
            : missingResult(10007),
          role === "source" ? workerExactStatus : 404,
        );
      }
      if (role === "source") sourceWorkerReads += 1;
      const references = {
        dispatch_namespace_outbounds: [],
        domains: [],
        durable_objects: [],
        queues: [],
        workers: [],
      };
      if (exactWorkerReferenceMode === "missing") delete references.queues;
      if (exactWorkerReferenceMode === "unknown") references.unknown = [];
      if (exactWorkerReferenceMode === "nonarray") references.domains = {};
      if (exactWorkerReferenceMode === "nonempty") references.workers = ["fixture"];
      return jsonResponse(ok({
        id: workerId(role),
        name: DISPOSABLE_TEARDOWN_NAMES[role],
        references,
        tail_consumers: exactWorkerReferenceMode === "tail_nonempty"
          ? ["fixture"]
          : [],
        subdomain: null,
        deployed_on: driftSecondCapture && role === "source" && sourceWorkerReads > 1
          ? "2026-09-13T00:01:00.000Z"
          : "2026-09-13T00:00:00.000Z",
      }));
    }
    if (exactWorker && init.method === "DELETE") {
      const role = exactWorker[1] === SOURCE_WORKER_ID ? "source" : "target";
      if (ambiguousKind === "worker") {
        if (ambiguousDeletes) state[role].worker = false;
        throw new Error("fixture lost response");
      }
      state[role].worker = false;
      if (workerDeleteMode === "official") return deleteResponse("official", null, {
        worker: true,
      });
      if (workerDeleteMode === "result") return jsonResponse(ok({ deleted: true }));
      if (workerDeleteMode === "extra") {
        return jsonResponse({ success: true, errors: [], messages: [], extra: true });
      }
      if (workerDeleteMode === "malformed") {
        return jsonResponse({ success: true, errors: {}, messages: [] });
      }
      return deleteResponse(workerDeleteMode, null, { worker: true });
    }

    const versions = /^\/workers\/scripts\/([^/]+)\/versions$/u.exec(suffix);
    if (versions && init.method === "GET") {
      const role = byRole(decodeURIComponent(versions[1]));
      const page = Number(url.searchParams.get("page"));
      assert.deepEqual([...url.searchParams], [
        ["page", String(page)], ["per_page", "100"],
      ]);
      const allRows = role && state[role].worker
        ? versionIds(role).map((id) => ({
          [versionPaginationMode === "version_id_alias" ? "version_id" : "id"]: id,
        }))
        : [];
      const start = (page - 1) * 100;
      const rows = versionPaginationMode === "duplicate_page" && page === 2
        ? allRows.slice(0, 100)
        : allRows.slice(start, start + 100);
      const body = ok({ items: rows });
      if (versionPaginationMode === "undocumented_latest") {
        body.result.latest = allRows[0]?.id ?? null;
      }
      if (versionPaginationMode === "unexpected_result_info") {
        body.result_info = { count: rows.length, page, per_page: 100, total_count: rows.length };
      }
      if (versionPaginationMode === "malformed") body.result = rows;
      return jsonResponse(body);
    }
    const version = /^\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/u.exec(suffix);
    if (version && init.method === "GET") {
      const role = byRole(decodeURIComponent(version[1]));
      const bindings = [
        { type: "d1", name: "DB", id: databaseId(role) },
        {
          type: "vectorize",
          name: "VECTORIZE",
          index_name: DISPOSABLE_TEARDOWN_NAMES[role],
        },
      ];
      if (role === "target") {
        if (versionBindingMode === "service_missing") {
          bindings.push({ type: "service", name: "SERVICE" });
        }
        if (versionBindingMode === "service_alias_type") {
          bindings.push({
            type: "service_binding",
            name: "SERVICE",
            service: DISPOSABLE_TEARDOWN_NAMES.source,
          });
        }
        if (versionBindingMode === "service_name_alias") {
          bindings.push({
            type: "service",
            name: "SERVICE",
            service_name: DISPOSABLE_TEARDOWN_NAMES.source,
          });
        }
        if (versionBindingMode === "service_conflict") {
          bindings.push({
            type: "service",
            name: "SERVICE",
            service: DISPOSABLE_TEARDOWN_NAMES.target,
            service_name: DISPOSABLE_TEARDOWN_NAMES.source,
          });
        }
        if (versionBindingMode.startsWith("d1_")) {
          const d1 = bindings[0];
          if (versionBindingMode === "d1_missing") delete d1.id;
          if (versionBindingMode === "d1_alias_type") d1.type = "d1_database";
          if (versionBindingMode === "d1_upper") d1.type = "D1";
          if (versionBindingMode === "d1_database_id") {
            d1.database_id = d1.id;
            delete d1.id;
          }
          if (versionBindingMode === "d1_conflict") {
            d1.database_id = SOURCE_D1;
          }
          if (versionBindingMode === "d1_uuid_conflict") d1.uuid = SOURCE_D1;
        }
        if (versionBindingMode === "vectorize_missing") {
          delete bindings[1].index_name;
        }
        if (versionBindingMode === "vectorize_conflict") {
          bindings[1].index = DISPOSABLE_TEARDOWN_NAMES.source;
        }
      }
      if (driftUnrelatedBinding && role === "target") {
        bindings.push({
          type: "plain_text",
          name: "FIXTURE",
          text: inventoryPass > 1 ? "second" : "first",
        });
      }
      return jsonResponse(ok(versionBindingMode === "top_level_bindings"
        ? { id: decodeURIComponent(version[2]), bindings }
        : {
          id: decodeURIComponent(version[2]),
          resources: { bindings },
        }));
    }

    if (init.method === "GET" && suffix === "/d1/database") {
      const page = Number(url.searchParams.get("page"));
      assert.deepEqual([...url.searchParams], [
        ["page", String(page)], ["per_page", "100"],
      ]);
      const allRows = ["source", "target"].filter((role) => state[role].d1).map((role) => ({
        [d1IdentityMode === "list_id_alias" ? "id" : "uuid"]: databaseId(role),
        name: DISPOSABLE_TEARDOWN_NAMES[role],
      }));
      for (let index = 0; index < extraD1Rows; index += 1) {
        allRows.push({
          uuid: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
          name: `fixture-d1-${index}`,
        });
      }
      let rows = allRows.slice((page - 1) * 100, page * 100);
      if (d1PaginationMode === "duplicate_page" && page === 2) {
        rows = allRows.slice(0, 100);
      }
      if (d1PaginationMode === "incomplete") {
        return jsonResponse(okD1Page(rows, { page, totalCount: allRows.length + 100 }));
      }
      const body = okD1Page(rows, {
        page,
        totalCount: allRows.length,
        mode: ["missing", "duplicate_page"].includes(d1PaginationMode)
          ? "missing"
          : d1PaginationMode,
      });
      if (d1PaginationMode === "partial") {
        body.result_info = { count: rows.length, page };
      }
      if (d1PaginationMode === "null_info") body.result_info = null;
      if (d1PaginationMode === "wrong_page") body.result_info.page = page + 1;
      if (d1PaginationMode === "total_pages") body.result_info.total_pages = 1;
      if (arrayResultObjectMode === "d1") body.result = { items: rows };
      return jsonResponse(body);
    }
    const exactD1 = /^\/d1\/database\/([^/]+)$/u.exec(suffix);
    if (exactD1 && init.method === "GET") {
      const role = exactD1[1] === SOURCE_D1 ? "source" : "target";
      return state[role].d1 && !exactD1Missing
        ? jsonResponse(ok({
          [d1IdentityMode === "exact_id_alias" ? "id" : "uuid"]:
            databaseId(role),
          name: DISPOSABLE_TEARDOWN_NAMES[role],
        }))
        : jsonResponse(missingResult(), 404);
    }
    if (exactD1 && init.method === "DELETE") {
      const role = exactD1[1] === SOURCE_D1 ? "source" : "target";
      if (ambiguousKind === "d1") {
        if (ambiguousDeletes) state[role].d1 = false;
        throw new Error("fixture lost response");
      }
      state[role].d1 = false;
      return deleteResponse(d1DeleteMode, {});
    }

    if (init.method === "GET" && suffix === "/vectorize/v2/indexes") {
      assert.equal(url.search, "");
      const rows = ["source", "target"].filter((role) => state[role].vectorize).map((role) => ({
        name: DISPOSABLE_TEARDOWN_NAMES[role],
      }));
      for (let index = 0; index < extraVectorRows; index += 1) {
        rows.push({ name: `fixture-vector-${index}` });
      }
      if (vectorInventoryMode === "malformed") rows.push({});
      return jsonResponse(ok(arrayResultObjectMode === "vectorize"
        ? { items: rows }
        : rows));
    }
    const exactVector = /^\/vectorize\/v2\/indexes\/([^/]+)$/u.exec(suffix);
    if (exactVector && init.method === "GET") {
      const role = byRole(decodeURIComponent(exactVector[1]));
      if (role === "source") {
        sourceVectorReads += 1;
        if (sourceVectorReads === vectorCreatedOnDriftAtRead) {
          state.source.vectorizeCreatedOn = "2026-09-13T00:00:01.000Z";
        }
      }
      return state[role].vectorize && !exactVectorizeMissing
        ? jsonResponse(ok({
          name: DISPOSABLE_TEARDOWN_NAMES[role],
          created_on: state[role].vectorizeCreatedOn,
          config: { dimensions: 768, metric: "cosine" },
        }))
        : jsonResponse(missingResult(), 404);
    }
    if (exactVector && init.method === "DELETE") {
      const role = byRole(decodeURIComponent(exactVector[1]));
      if (ambiguousKind === "vectorize") {
        if (ambiguousDeletes) state[role].vectorize = false;
        throw new Error("fixture lost response");
      }
      state[role].vectorize = false;
      return deleteResponse(vectorDeleteMode, { deleted: true });
    }
    throw new Error(`unexpected fixture endpoint ${init.method} ${suffix}${url.search}`);
  };
  return { fetchImpl, state, calls };
}

test("provider binds immutable Worker ID and produces two stable complete custody captures", async () => {
  const fixture = providerFixture();
  const receipt = await executeDisposableTeardownProvider(
    providerRequest("preview"),
    { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) },
  );
  assert.equal(receipt.states.worker, "present");
  assert.equal(receipt.states.vectorize, "present");
  assert.equal(receipt.states.d1, "present");
  assert.equal(receipt.custody.pagination_complete, true);
  assert.deepEqual(receipt.custody.incoming_references, {
    version_references: 0,
    service_bindings: 0,
    tail_consumers: 0,
  });
  const exactWorkerReads = fixture.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith(`/workers/workers/${SOURCE_WORKER_ID}`));
  assert.equal(exactWorkerReads.length, 2);
  assert.deepEqual(receipt.custody.worker_schedules, {
    count: 0,
    exact_endpoint_status: 200,
    missing_code_sha256: null,
    schedules_sha256: sha256(canonical([])),
  });
  assert.equal(fixture.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith(
      `/workers/scripts/${DISPOSABLE_TEARDOWN_NAMES.source}/schedules`,
    )).length, 2);
  assert.equal(fixture.calls.some((call) =>
    call.pathname.includes(`/workers/scripts/${DISPOSABLE_TEARDOWN_NAMES.source}`) &&
    call.method === "DELETE"), false);
  const serialized = JSON.stringify(receipt);
  for (const privateValue of [
    ACCOUNT,
    SOURCE_WORKER_ID,
    SOURCE_D1,
    DISPOSABLE_TEARDOWN_NAMES.source,
  ]) assert.equal(serialized.includes(privateValue), false);
});

test("Worker delete uses immutable beta ID and exact code-10007 404 reconciliation", async () => {
  const fixture = providerFixture();
  const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: fixture.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  const fingerprint = preview.instance_fingerprints.worker;
  await executeDisposableTeardownProvider(providerRequest("delete", {
    kind: "worker",
    fingerprint,
  }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) });
  const reconciled = await executeDisposableTeardownProvider(providerRequest("reconcile", {
    kind: "worker",
    fingerprint,
  }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) });
  assert.equal(reconciled.absent, true);
  assert.equal(reconciled.exact_endpoint_status, 404);
  assert.equal(reconciled.absence_authority, "exact_id_404_code_10007");
  assert.equal(fixture.calls.some((call) =>
    call.method === "DELETE" &&
    call.pathname.endsWith(`/workers/workers/${SOURCE_WORKER_ID}`)), true);
});

test("Worker Beta DELETE accepts only its documented no-result success envelope", async () => {
  const accepted = providerFixture({ workerDeleteMode: "official" });
  const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: accepted.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  const result = await executeDisposableTeardownProvider(providerRequest("delete", {
    kind: "worker",
    fingerprint: preview.instance_fingerprints.worker,
  }), { fetchImpl: accepted.fetchImpl, token: Buffer.from(TOKEN) });
  assert.equal(result.accepted, true);
  assert.equal(result.response_status, 200);

  for (const mode of ["result", "extra", "malformed", "empty"]) {
    const fixture = providerFixture({ workerDeleteMode: mode });
    const current = await executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: fixture.fetchImpl,
      token: Buffer.from(TOKEN),
    });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("delete", {
        kind: "worker",
        fingerprint: current.instance_fingerprints.worker,
      }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) }),
      (error) => error.code === "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN",
      mode,
    );
  }
});

test("lost Vectorize response reconciles by two exhaustive list captures without a retry", async () => {
  const fixture = providerFixture({ ambiguousKind: "vectorize", ambiguousDeletes: true });
  const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: fixture.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  const fingerprint = preview.instance_fingerprints.vectorize;
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("delete", {
      kind: "vectorize",
      fingerprint,
    }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) }),
    (error) => error.code === "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN",
  );
  const reconciled = await executeDisposableTeardownProvider(providerRequest("reconcile", {
    kind: "vectorize",
    fingerprint,
  }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) });
  assert.equal(reconciled.absent, true);
  assert.equal(reconciled.absence_authority,
    "two_stable_exhaustive_account_inventories");
  assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.ok(fixture.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith("/vectorize/v2/indexes")).length >= 4);
});

test("documented D1 and Vectorize DELETE success envelopes are accepted", async () => {
  for (const [kind, fixture] of [
    ["vectorize", providerFixture()],
    ["vectorize", providerFixture({ vectorDeleteMode: "result_string" })],
    ["d1", providerFixture()],
  ]) {
    const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: fixture.fetchImpl,
      token: Buffer.from(TOKEN),
    });
    const result = await executeDisposableTeardownProvider(providerRequest("delete", {
      kind,
      fingerprint: preview.instance_fingerprints[kind],
    }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) });
    assert.equal(result.accepted, true);
    assert.equal(result.response_status, 200);
    assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1);
  }
});

test("all DELETE endpoints require exact 200 and normalize every post-dispatch failure", async () => {
  for (const kind of ["worker", "d1", "vectorize"]) {
    const modes = [
      "empty",
      "status_201",
      "status_202",
      "status_206",
      "timeout",
      "malformed_json",
      "wrong_content_type",
      "redirect",
      "oversize",
      "stream_read_error",
      "token_reflection",
      ...(kind === "worker" ? [] : ["missing_result"]),
    ];
    for (const mode of modes) {
      const fixture = providerFixture({
        [`${kind === "worker" ? "worker" : kind === "d1" ? "d1" : "vector"}DeleteMode`]:
          mode,
      });
      const preview = await executeDisposableTeardownProvider(
        providerRequest("preview"),
        { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) },
      );
      await assert.rejects(
        executeDisposableTeardownProvider(providerRequest("delete", {
          kind,
          fingerprint: preview.instance_fingerprints[kind],
        }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) }),
        (error) => error.code === "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN" &&
          !JSON.stringify(error).includes(ACCOUNT),
        `${kind}:${mode}`,
      );
      assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1,
        `${kind}:${mode}`);
    }
  }

  const invalidCoreReceipt = {
    schema_version: 1,
    operation: "delete",
    role: "source",
    kind: "d1",
    expected_instance_fingerprint: HASH("1"),
    maintenance_window_sha256: sha256(canonical(MAINTENANCE_WINDOW)),
    accepted: true,
    response_status: 204,
    response_body_sha256: HASH("2"),
  };
  assert.throws(
    () => assertDisposableTeardownProviderResult(invalidCoreReceipt, {
      operation: "delete",
      role: "source",
      kind: "d1",
      expectedInstanceFingerprint: HASH("1"),
      maintenanceWindow: MAINTENANCE_WINDOW,
    }),
    (error) => error.code === "TEARDOWN_PROVIDER_RECEIPT_INVALID",
  );
});

test("committed-lost Worker and D1 deletes reconcile without a second DELETE", async () => {
  for (const kind of ["worker", "d1"]) {
    const fixture = providerFixture({ ambiguousKind: kind, ambiguousDeletes: true });
    const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: fixture.fetchImpl,
      token: Buffer.from(TOKEN),
    });
    const fingerprint = preview.instance_fingerprints[kind];
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("delete", {
        kind,
        fingerprint,
      }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) }),
      (error) => error.code === "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN",
    );
    const reconciled = await executeDisposableTeardownProvider(providerRequest("reconcile", {
      kind,
      fingerprint,
    }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) });
    assert.equal(reconciled.absent, true);
    assert.equal(reconciled.exact_endpoint_status, 404);
    assert.equal(reconciled.absence_authority, kind === "worker"
      ? "exact_id_404_code_10007"
      : "two_stable_exhaustive_account_inventories");
    assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1);
    if (kind === "d1") {
      assert.ok(fixture.calls.filter((call) =>
        call.method === "GET" && call.pathname.endsWith("/d1/database")).length >= 4);
    }
  }
});

test("present after an ambiguous delete remains open and cannot become absence", async () => {
  const fixture = providerFixture({ ambiguousKind: "d1", ambiguousDeletes: false });
  const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: fixture.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  const fingerprint = preview.instance_fingerprints.d1;
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("delete", {
      kind: "d1",
      fingerprint,
    }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) }),
    (error) => error.code === "CF_TEARDOWN_DELETE_OUTCOME_UNKNOWN",
  );
  const reconciled = await executeDisposableTeardownProvider(providerRequest("reconcile", {
    kind: "d1",
    fingerprint,
  }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) });
  assert.equal(reconciled.absent, false);
  assert.equal(reconciled.exact_endpoint_status, 200);
  assert.equal(reconciled.absence_authority, "present");
  assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("malformed Worker 404 and concurrent capture drift fail closed", async () => {
  const malformed = providerFixture({ malformedWorker404: true });
  malformed.state.source.worker = false;
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: malformed.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_MISSING_ENVELOPE_INVALID",
  );

  const drift = providerFixture({ driftSecondCapture: true });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: drift.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_SNAPSHOT_CHANGED",
  );

  const unrelatedBinding = providerFixture({ driftUnrelatedBinding: true });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: unrelatedBinding.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_SNAPSHOT_CHANGED",
  );
});

test("Beta Worker GET requires the documented empty references object and tail consumers", async () => {
  const valid = providerFixture();
  const receipt = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: valid.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  assert.equal(receipt.states.worker, "present");
  for (const mode of [
    "missing", "unknown", "nonarray", "nonempty", "tail_nonempty",
  ]) {
    const fixture = providerFixture({ exactWorkerReferenceMode: mode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_RESOURCE_MISMATCH",
      mode,
    );
  }
});

test("legacy Worker inventory must authoritatively include routes and tail consumers", async () => {
  for (const option of [
    { legacyRouteMode: "missing" },
    { legacyRouteMode: "null" },
    { legacyTailMode: "missing" },
    { legacyTailMode: "null" },
  ]) {
    const fixture = providerFixture(option);
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_CUSTODY_UNPROVEN",
      JSON.stringify(option),
    );
  }

  for (const legacyTailMode of ["script_name_alias", "bare_string"]) {
    const invalidTail = providerFixture({ legacyTailMode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: invalidTail.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_RESPONSE_INVALID",
      legacyTailMode,
    );
  }
});

test("Worker custody rejects undocumented or incomplete binding locators", async () => {
  for (const versionBindingMode of [
    "service_missing", "service_alias_type", "service_name_alias",
    "service_conflict", "d1_missing", "d1_alias_type", "d1_upper",
    "d1_database_id", "d1_conflict", "d1_uuid_conflict",
    "vectorize_missing", "vectorize_conflict", "top_level_bindings",
  ]) {
    const fixture = providerFixture({ versionBindingMode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_RESPONSE_INVALID",
      versionBindingMode,
    );
  }
  for (const fixture of [
    providerFixture({ scriptIdentityMode: "script_name" }),
    providerFixture({ versionPaginationMode: "version_id_alias" }),
    providerFixture({ d1IdentityMode: "list_id_alias" }),
    providerFixture({ d1IdentityMode: "exact_id_alias" }),
  ]) {
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_RESPONSE_INVALID",
    );
  }
});

test("Cron schedules are authoritative, empty, and stable in both captures", async () => {
  for (const scheduleMode of ["missing", "malformed", "nonempty", "drift_missing"]) {
    const fixture = providerFixture({ scheduleMode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => [
        "CF_TEARDOWN_RESOURCE_MISMATCH",
        "CF_TEARDOWN_RESPONSE_INVALID",
        "CF_TEARDOWN_CUSTODY_NOT_EMPTY",
      ].includes(error.code),
      scheduleMode,
    );
  }
});

test("unpaged collections remain single-response complete at exactly 100 rows", async () => {
  const fixture = providerFixture({ extraVectorRows: 98 });
  const receipt = await executeDisposableTeardownProvider(
    providerRequest("preview"),
    { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) },
  );
  assert.equal(receipt.custody.vectorize_entries_inspected, 100);
  const vectorLists = fixture.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith("/vectorize/v2/indexes"));
  assert.equal(vectorLists.length, 2);
  assert.deepEqual(vectorLists.map((call) => call.search), ["", ""]);
  assert.equal(fixture.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith("/workers/scripts")).length, 2);
});

test("endpoint-specific pagination accepts documented omission and rejects invented metadata", async () => {
  for (const d1PaginationMode of ["missing", "partial", "valid"]) {
    const fixture = providerFixture({ d1PaginationMode });
    await assert.doesNotReject(executeDisposableTeardownProvider(
      providerRequest("preview"),
      { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) },
    ), d1PaginationMode);
  }

  for (const d1PaginationMode of [
    "unexpected", "total_pages", "wrong_page", "null_info",
  ]) {
    const fixture = providerFixture({ d1PaginationMode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_PAGINATION_INVALID",
      d1PaginationMode,
    );
  }

  const incomplete = providerFixture({ d1PaginationMode: "incomplete" });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: incomplete.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_PAGINATION_INVALID",
  );

  const duplicateD1 = providerFixture({
    d1PaginationMode: "duplicate_page",
    extraD1Rows: 198,
  });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: duplicateD1.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_PAGINATION_INVALID",
  );

  const boundedVersions = providerFixture({ versionCount: 100 });
  await assert.doesNotReject(executeDisposableTeardownProvider(
    providerRequest("preview"),
    { fetchImpl: boundedVersions.fetchImpl, token: Buffer.from(TOKEN) },
  ));
  assert.equal(boundedVersions.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith("/versions")).length, 8,
  "each full legacy page must terminate only after its bounded empty page");

  for (const fixture of [
    providerFixture({ versionPaginationMode: "unexpected_result_info" }),
    providerFixture({ versionPaginationMode: "undocumented_latest" }),
    providerFixture({ versionPaginationMode: "duplicate_page", versionCount: 200 }),
    providerFixture({ versionCount: 201 }),
  ]) {
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => [
        "CF_TEARDOWN_PROVIDER_REFUSED",
        "CF_TEARDOWN_RESPONSE_INVALID",
        "CF_TEARDOWN_PAGINATION_INVALID",
        "CF_TEARDOWN_INVENTORY_TOO_LARGE",
      ].includes(error.code),
    );
  }
});

test("array-only inventory endpoints reject object-shaped result wrappers", async () => {
  for (const arrayResultObjectMode of ["scripts", "d1", "vectorize", "domains"]) {
    const fixture = providerFixture({ arrayResultObjectMode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_RESPONSE_INVALID",
      arrayResultObjectMode,
    );
  }
});

test("maintenance window and Vectorize creation identity fail closed before DELETE", async () => {
  const invalidWindow = providerRequest("preview");
  invalidWindow.maintenance_window = {
    single_operator: true,
    other_actors_paused: false,
  };
  let providerAccess = 0;
  await assert.rejects(
    executeDisposableTeardownProvider(invalidWindow, {
      fetchImpl: async () => { providerAccess += 1; },
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_MAINTENANCE_WINDOW_REQUIRED",
  );
  assert.equal(providerAccess, 0);

  const fixture = providerFixture();
  const preview = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: fixture.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  fixture.state.source.vectorizeCreatedOn = "2026-09-13T00:00:01.000Z";
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("delete", {
      kind: "vectorize",
      fingerprint: preview.instance_fingerprints.vectorize,
    }), { fetchImpl: fixture.fetchImpl, token: Buffer.from(TOKEN) }),
    (error) => error.code === "CF_TEARDOWN_RESOURCE_MISMATCH",
  );
  assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 0);

  const immediateDrift = providerFixture({ vectorCreatedOnDriftAtRead: 5 });
  const stablePreview = await executeDisposableTeardownProvider(
    providerRequest("preview"),
    { fetchImpl: immediateDrift.fetchImpl, token: Buffer.from(TOKEN) },
  );
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("delete", {
      kind: "vectorize",
      fingerprint: stablePreview.instance_fingerprints.vectorize,
    }), { fetchImpl: immediateDrift.fetchImpl, token: Buffer.from(TOKEN) }),
    (error) => error.code === "CF_TEARDOWN_RESOURCE_MISMATCH",
  );
  assert.equal(immediateDrift.calls.filter((call) =>
    call.method === "GET" && call.pathname.endsWith(
      `/vectorize/v2/indexes/${DISPOSABLE_TEARDOWN_NAMES.source}`,
    )).length, 5);
  assert.equal(immediateDrift.calls.filter((call) =>
    call.method === "DELETE").length, 0);
});

test("documented optional Cloudflare diagnostics validate without escaping receipts", async () => {
  const valid = providerFixture({ missingDiagnosticMode: "valid_optional" });
  valid.state.source.worker = false;
  const receipt = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: valid.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  assert.equal(receipt.states.worker, "absent");
  assert.equal(JSON.stringify(receipt).includes("developers.cloudflare.com"), false);

  for (const mode of [
    "invalid_url",
    "invalid_code",
    "invalid_parameter",
    "invalid_header",
  ]) {
    const invalid = providerFixture({ missingDiagnosticMode: mode });
    invalid.state.source.worker = false;
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: invalid.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_MISSING_ENVELOPE_INVALID",
      mode,
    );
  }
});

test("storage absence cannot be inferred from an exact 404 without complete inventories", async () => {
  for (const fixture of [
    providerFixture({ exactD1Missing: true }),
    providerFixture({ exactVectorizeMissing: true }),
  ]) {
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_RESOURCE_MISMATCH",
    );
  }

  const malformed = providerFixture({ vectorInventoryMode: "malformed" });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: malformed.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_RESPONSE_INVALID",
  );
});

test("exact-filtered Worker domains accept SinglePage service and global metadata", async () => {
  for (const mode of [
    "valid", "missing", "partial", "unrelated",
  ]) {
    const fixture = providerFixture({ domainPaginationMode: mode });
    const receipt = await executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: fixture.fetchImpl,
      token: Buffer.from(TOKEN),
    });
    assert.equal(receipt.custody.custom_domains, 0);
    const calls = fixture.calls.filter((call) =>
      call.pathname.endsWith("/workers/domains"));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.search), [
      `?service=${DISPOSABLE_TEARDOWN_NAMES.source}`,
      `?service=${DISPOSABLE_TEARDOWN_NAMES.source}`,
    ]);
  }

  const unrelated = providerFixture({ domainPaginationMode: "unrelated" });
  const receipt = await executeDisposableTeardownProvider(providerRequest("preview"), {
    fetchImpl: unrelated.fetchImpl,
    token: Buffer.from(TOKEN),
  });
  assert.equal(receipt.custody.custom_domains, 0);
  const unrelatedCalls = unrelated.calls.filter((call) =>
    call.pathname.endsWith("/workers/domains"));
  assert.equal(unrelatedCalls.length, 2,
    "two stable captures each make one exact-filter request");
  assert.deepEqual(unrelatedCalls.map((call) => call.search), [
    `?service=${DISPOSABLE_TEARDOWN_NAMES.source}`,
    `?service=${DISPOSABLE_TEARDOWN_NAMES.source}`,
  ]);
});

test("Worker domains reject contradictory, extra, or wrong-service results", async () => {
  for (const mode of ["contradictory", "unexpected", "global_zero_pages"]) {
    const fixture = providerFixture({ domainPaginationMode: mode });
    await assert.rejects(
      executeDisposableTeardownProvider(providerRequest("preview"), {
        fetchImpl: fixture.fetchImpl,
        token: Buffer.from(TOKEN),
      }),
      (error) => error.code === "CF_TEARDOWN_PAGINATION_INVALID",
      mode,
    );
  }
  const wrongService = providerFixture({
    domainRows: [{ service: DISPOSABLE_TEARDOWN_NAMES.target }],
  });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: wrongService.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_RESOURCE_MISMATCH",
  );
});

test("source custody must prove the other campaign Worker was inspected", () => {
  const source = semanticSnapshot("source", {
    worker: "present", vectorize: "present", d1: "present",
  }, { otherCampaignWorkerInspected: false });
  assert.throws(
    () => assertDisposableTeardownProviderResult(source, {
      operation: "preview",
      role: "source",
      maintenanceWindow: MAINTENANCE_WINDOW,
    }),
    (error) => error.code === "TEARDOWN_CUSTODY_INVALID",
  );

  const target = semanticSnapshot("target", {
    worker: "present", vectorize: "present", d1: "present",
  }, { otherCampaignWorkerInspected: true });
  assert.throws(
    () => assertDisposableTeardownProviderResult(target, {
      operation: "preview",
      role: "target",
      maintenanceWindow: MAINTENANCE_WINDOW,
    }),
    (error) => error.code === "TEARDOWN_CUSTODY_INVALID",
  );
});

test("provider receipt validator binds two stable exhaustive storage inventory passes", () => {
  const baseline = semanticSnapshot("source", {
    worker: "absent", vectorize: "absent", d1: "absent",
  });
  assert.doesNotThrow(() => assertDisposableTeardownProviderResult(baseline, {
    operation: "preview",
    role: "source",
    maintenanceWindow: MAINTENANCE_WINDOW,
  }));

  for (const mutate of [
    (value) => { delete value.custody.storage_inventory_passes; },
    (value) => {
      value.custody.storage_inventory_passes.d1[1].inventory_sha256 = HASH("e");
    },
    (value) => {
      value.custody.storage_inventory_passes.vectorize[1].pagination_complete = false;
    },
    (value) => {
      value.custody.storage_inventory_passes.d1[0].matching_resources = 1;
      value.custody.storage_inventory_passes.d1[1].matching_resources = 1;
    },
    (value) => {
      [value.custody.storage_inventory_passes.d1,
        value.custody.storage_inventory_passes.vectorize] = [
        value.custody.storage_inventory_passes.vectorize,
        value.custody.storage_inventory_passes.d1,
      ];
    },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    const unsigned = { ...changed };
    delete unsigned.snapshot_sha256;
    changed.snapshot_sha256 = sha256(canonical(unsigned));
    assert.throws(
      () => assertDisposableTeardownProviderResult(changed, {
        operation: "preview",
        role: "source",
        maintenanceWindow: MAINTENANCE_WINDOW,
      }),
      (error) => error.code === "TEARDOWN_CUSTODY_INVALID" ||
        error.code === "TEARDOWN_PROVIDER_RECEIPT_INVALID",
    );
  }
});

test("non-404 Worker reads and same-name replacement races cannot prove absence", async () => {
  const non404 = providerFixture({ workerExactStatus: 403 });
  non404.state.source.worker = false;
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: non404.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_PROVIDER_REFUSED",
  );

  const replaced = providerFixture({ workerIdMissingButNamePresent: true });
  await assert.rejects(
    executeDisposableTeardownProvider(providerRequest("preview"), {
      fetchImpl: replaced.fetchImpl,
      token: Buffer.from(TOKEN),
    }),
    (error) => error.code === "CF_TEARDOWN_RESOURCE_MISMATCH",
  );
});

test("the real child argv path enters the provider child without making a request", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-teardown-child-")));
  const tokenPath = join(directory, "token");
  const requestPath = join(directory, "request");
  let tokenFd;
  let requestFd;
  try {
    chmodSync(directory, 0o700);
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
    writeFileSync(requestPath, "{}", { mode: 0o600 });
    tokenFd = openSync(tokenPath, "r");
    requestFd = openSync(requestPath, "r");
    const child = spawnSync(process.execPath, [
      resolve("operations/cloudflare-disposable-teardown-provider.mjs"),
      "--campaign-teardown-provider-child",
    ], {
      stdio: [tokenFd, "pipe", "pipe", requestFd],
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, "");
    assert.deepEqual(JSON.parse(child.stdout), {
      schema_version: 1,
      ok: false,
      code: "CF_TEARDOWN_REQUEST_INVALID",
    });
  } finally {
    if (tokenFd !== undefined) closeSync(tokenFd);
    if (requestFd !== undefined) closeSync(requestFd);
    rmSync(directory, { recursive: true, force: true });
  }
});

function semanticSnapshot(role, states, {
  otherCampaignWorkerInspected = role === "source",
} = {}) {
  const resources = ["worker", "vectorize", "d1"];
  const d1Entries = states.d1 === "present" ? 2 : 1;
  const vectorizeEntries = states.vectorize === "present" ? 2 : 1;
  const storagePass = (kind, entries) => ({
    resource_kind: kind,
    pagination_complete: true,
    entries_inspected: entries,
    matching_resources: states[kind] === "present" ? 1 : 0,
    inventory_sha256: sha256(`${role}-${kind}-${states[kind]}-inventory`),
  });
  const d1Pass = storagePass("d1", d1Entries);
  const vectorizePass = storagePass("vectorize", vectorizeEntries);
  const base = {
    schema_version: 1,
    operation: "preview",
    role,
    account_fingerprint: sha256(canonical({
      kind: "cloudflare_account",
      account_id: ACCOUNT,
    })),
    target_fingerprint: HASH("2"),
    maintenance_window_sha256: sha256(canonical(MAINTENANCE_WINDOW)),
    states: Object.fromEntries(resources.map((kind) => [kind, states[kind]])),
    instance_fingerprints: Object.fromEntries(resources.map((kind, index) => [
      kind,
      states[kind] === "present" ? HASH(String(index + 3)) : null,
    ])),
    exact_endpoint_statuses: Object.fromEntries(resources.map((kind) => [
      kind,
      states[kind] === "present" ? 200 : 404,
    ])),
    exact_endpoint_missing_code_sha256: Object.fromEntries(resources.map((kind, index) => [
      kind,
      states[kind] === "present"
        ? null
        : kind === "worker"
          ? WORKER_MISSING_CODE_SHA256
          : HASH(String(index + 6)),
    ])),
    absence_authority: Object.fromEntries(resources.map((kind) => [
      kind,
      states[kind] === "present"
        ? "present"
        : kind === "worker"
          ? "exact_id_404_code_10007"
          : "two_stable_exhaustive_account_inventories",
    ])),
    custody: {
      pagination_complete: true,
      workers_inspected: 2,
      versions_inspected: 2,
      bindings_inspected: 4,
      d1_entries_inspected: d1Entries,
      vectorize_entries_inspected: vectorizeEntries,
      other_campaign_worker_inspected: otherCampaignWorkerInspected,
      incoming_references: {
        version_references: 0,
        service_bindings: 0,
        tail_consumers: 0,
      },
      routes: 0,
      custom_domains: 0,
      worker_schedules: {
        count: 0,
        exact_endpoint_status: states.worker === "present" ? 200 : 404,
        missing_code_sha256: states.worker === "present"
          ? null
          : WORKER_MISSING_CODE_SHA256,
        schedules_sha256: sha256(canonical([])),
      },
      storage_inventory_passes: {
        d1: [d1Pass, structuredClone(d1Pass)],
        vectorize: [vectorizePass, structuredClone(vectorizePass)],
      },
      inventory_sha256: HASH("9"),
    },
  };
  return Object.freeze({ ...base, snapshot_sha256: sha256(canonical(base)) });
}

function targetEvalReceipt(teardownBinding, {
  stateSha256 = HASH("1"),
  goldenSha256 = HASH("2"),
  completedAt = "2026-09-13T00:30:00.000Z",
  campaignProtection,
} = {}) {
  const binding = {
    candidate_sha: teardownBinding.candidate_sha,
    candidate_tree_sha: teardownBinding.candidate_tree_sha,
    package_sha256: teardownBinding.package_sha256,
    field_receipt_sha256: teardownBinding.field_receipt_sha256,
    keychain_binding_sha256: teardownBinding.keychain_binding_sha256,
    campaign_fingerprint: teardownBinding.campaign_fingerprint,
    recovery_plan_fingerprint: teardownBinding.plan_fingerprint,
    recovery_state_sha256: stateSha256,
    golden_sha256: goldenSha256,
    source_resource_fingerprint: teardownBinding.source_resource_fingerprint,
    target_resource_fingerprint: teardownBinding.target_resource_fingerprint,
    active_worker_version_id: TARGET_VERSION,
  };
  const value = {
    schema_version: 1,
    kind: "v048_disposable_target_eval",
    status: "passed",
    completed_at: completedAt,
    binding,
    campaign_protection: {
      a4_authority: campaignProtection.a4Authority,
      evaluated_authority: campaignProtection.evaluatedAuthority,
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      worker_version_id: binding.active_worker_version_id,
      mode: "active",
    },
    projection: {
      documents: 6_001,
      d1_chunks: 6_001,
      fts_rows: 6_001,
      vectorize_vectors: 6_001,
      pending_outbox: 0,
      failed_vectors: 0,
    },
    checks: {
      health: {
        status: "pass",
        version: "0.4.8",
        accepting_documents: true,
        before_snapshot_sha256: HASH("3"),
        after_snapshot_sha256: HASH("3"),
        active_version_unchanged: true,
        projection_unchanged: true,
      },
      eval_profile: "release",
      eval_status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
      supported_marker_case: {
        direct_target_check: true,
        cited: true,
        citation_count: 1,
      },
      unsupported_case: { direct_target_check: true, refused: true },
    },
  };
  return {
    value,
    sha256: sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)),
  };
}

function completedSourceTeardownReceipt(preparation, {
  startedAt = "2026-09-13T01:00:00.000Z",
  completedAt = "2026-09-13T01:01:00.000Z",
} = {}) {
  const binding = {
    candidate_sha: preparation.binding.candidate_sha,
    candidate_tree_sha: preparation.binding.candidate_tree_sha,
    package_sha256: preparation.binding.package_sha256,
    field_receipt_sha256: preparation.binding.field_receipt_sha256,
    keychain_binding_sha256: preparation.binding.keychain_binding_sha256,
    campaign_fingerprint: preparation.binding.campaign_fingerprint,
    plan_fingerprint: preparation.binding.plan_fingerprint,
    resource_fingerprint: preparation.binding.source_resource_fingerprint,
    wrangler_wrapper_sha256: preparation.binding.wrangler_wrapper_sha256,
    provision_receipt_sha256:
      preparation.provisionArtifacts.source.receiptSha256,
    provision_manifest_sha256:
      preparation.provisionArtifacts.source.manifestSha256,
    target_eval_receipt_sha256: preparation.targetEvalReceipt.sha256,
  };
  const resources = ["worker", "vectorize", "d1"];
  const value = {
    schema_version: 1,
    kind: "v048_disposable_brain_teardown",
    role: "source",
    status: "passed",
    binding,
    resource_fingerprint: binding.resource_fingerprint,
    started_at: startedAt,
    completed_at: completedAt,
    target_eval_receipt_sha256: preparation.targetEvalReceipt.sha256,
    source_teardown_receipt_sha256: null,
    present_preview_sha256: HASH("1"),
    custody: {
      pagination_complete: true,
      incoming_references: {
        version_references: 0,
        service_bindings: 0,
        tail_consumers: 0,
      },
      routes: 0,
      custom_domains: 0,
      worker_schedule_passes: {
        present: {
          count: 0,
          exact_endpoint_status: 200,
          missing_code_sha256: null,
          schedules_sha256: sha256(canonical([])),
        },
        absent: {
          count: 0,
          exact_endpoint_status: 404,
          missing_code_sha256: WORKER_MISSING_CODE_SHA256,
          schedules_sha256: sha256(canonical([])),
        },
      },
      storage_inventory_passes: {
        d1: [
          {
            resource_kind: "d1",
            pagination_complete: true,
            entries_inspected: 1,
            matching_resources: 0,
            inventory_sha256: HASH("a"),
          },
          {
            resource_kind: "d1",
            pagination_complete: true,
            entries_inspected: 1,
            matching_resources: 0,
            inventory_sha256: HASH("a"),
          },
        ],
        vectorize: [
          {
            resource_kind: "vectorize",
            pagination_complete: true,
            entries_inspected: 1,
            matching_resources: 0,
            inventory_sha256: HASH("b"),
          },
          {
            resource_kind: "vectorize",
            pagination_complete: true,
            entries_inspected: 1,
            matching_resources: 0,
            inventory_sha256: HASH("b"),
          },
        ],
      },
      resources: resources.map((kind, index) => ({
        kind,
        instance_fingerprint: HASH(String(index + 2)),
      })),
    },
    actions: resources.map((kind, index) => ({
      kind,
      instance_fingerprint: HASH(String(index + 2)),
      request_sha256: HASH(String(index + 5)),
      transitions: ["planned", "sent_unconfirmed", "confirmed"],
      exact_endpoint_status: 404,
      missing_code_sha256: kind === "worker"
        ? WORKER_MISSING_CODE_SHA256
        : sha256(`missing-${kind}`),
      absence_authority: kind === "worker"
        ? "exact_id_404_code_10007"
        : "two_stable_exhaustive_account_inventories",
    })),
    absent_preview_sha256: HASH("8"),
    absence: { present: 0, absent: 3 },
  };
  assertDisposableRecoveryBrainTeardownReceipt(value, {
    role: "source",
    expectedBinding: binding,
    expectedSourceTeardownReceiptSha256: null,
  });
  return {
    value,
    sha256: sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)),
  };
}

function mintSourceTeardownReceiptCapability(preparation, overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(
    tmpdir(),
    "brain-v048-source-teardown-capability-",
  )));
  chmodSync(directory, 0o700);
  RETAINED_CAPABILITY_DIRECTORIES.add(directory);
  const receipt = completedSourceTeardownReceipt(preparation, overrides);
  const receiptPath = join(
    directory,
    DISPOSABLE_RECOVERY_SOURCE_TEARDOWN_RECEIPT_NAME,
  );
  writeFileSync(receiptPath, `${JSON.stringify(receipt.value, null, 2)}\n`, {
    mode: 0o600,
  });
  return Object.freeze({
    capability: readDisposableRecoverySourceTeardownReceipt({
      receiptPath,
      expectedReceiptDirectory: directory,
      preparation,
    }),
    directory,
    receiptPath,
    receipt,
  });
}

function fixtureKeychainPreparation(binding) {
  assert.equal(binding.candidate_sha, "a".repeat(40));
  assert.equal(binding.candidate_tree_sha, "b".repeat(40));
  assert.equal(binding.package_sha256, HASH("a"));
  assert.equal(binding.field_receipt_sha256, HASH("b"));
  const proof = CORE_TEST_K0.proof;
  const keychainPreparation = Object.freeze({
    schema_version: proof.schema_version,
    protocol: proof.protocol,
    receipt_sha256: proof.receipt_sha256,
    preparation_fingerprint: proof.preparation_fingerprint,
    account_fingerprint: proof.account_fingerprint,
    campaign_keychain_locator_sha256:
      [...proof.campaign_keychain_locator_sha256],
    campaign_keychain_value_sha256:
      [...proof.campaign_keychain_value_sha256],
    campaign_items: proof.campaign_items.map((item) => ({ ...item })),
    keychain_binding_sha256: proof.keychain_binding_sha256,
  });
  return {
    locatorHashes: [...proof.campaign_keychain_locator_sha256],
    keychainPreparation,
  };
}

function provisioningPreparationBinding() {
  return {
    schema_version: 1,
    candidate_sha: "a".repeat(40),
    candidate_tree_sha: "b".repeat(40),
    field_receipt_run_id: SOURCE_VERSION,
    field_receipt_sha256: HASH("b"),
    package_filename: "brain-installer-0.4.8.tgz",
    package_bytes: 1234,
    package_sha256: HASH("a"),
    package_file_count: 100,
    execution_inventory_sha256: HASH("1"),
    installed_execution_inventory_sha256: HASH("1"),
    wrangler_version: "4.131.1",
    wrangler_wrapper_sha256: HASH("e"),
    wrangler_runtime_inventory_sha256: HASH("4"),
    wrangler_entrypoint_sha256: HASH("5"),
    node_version: "v22.0.0",
    node_executable_sha256: HASH("6"),
  };
}

function genuineProvisionProvider(role) {
  const source = role === "source";
  const resourceName = DISPOSABLE_TEARDOWN_NAMES[role];
  const workerId = source ? SOURCE_WORKER_ID : TARGET_WORKER_ID;
  const databaseId = source ? SOURCE_D1 : TARGET_D1;
  const versionId = source ? SOURCE_VERSION : TARGET_VERSION;
  const deploymentId = source
    ? "55555555-5555-4555-8555-555555555555"
    : "66666666-6666-4666-8666-666666666666";
  let d1Created = false;
  let vectorCreated = false;
  let workerCreated = false;
  const providerMetadata = () => ({
    schema_version: 1,
    status: 200,
    content_type: "application/json",
    body_sha256: HASH("7"),
  });
  const providerResult = (result) => ({ provider_metadata: providerMetadata(), result });
  const responseEvidence = () => ({ operation: "fixture", ...providerMetadata() });
  const semantic = () => ({
    account_id: ACCOUNT,
    role,
    resource_name: resourceName,
    worker_id: workerId,
    worker_created_on: VECTOR_CREATED_ON,
    worker_tag_sha256: HASH("8"),
    hostname: `${resourceName}.fixture.workers.dev`,
    database_id: databaseId,
    active_deployment_id: deploymentId,
    active_version_id: versionId,
    active_script_etag: "fixture-etag",
    active_traffic_percent: 100,
    baseline_mode: "maintenance-bootstrap",
    bindings_sha256: HASH("9"),
    resource: {
      custom_domains_count: 0,
      d1_exists: true,
      d1_name_and_id_exact: true,
      previews_enabled: false,
      routes_count: 0,
      schedules_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
      vectorize_exists: true,
      vectorize_name_exact: true,
      worker_exists: true,
      workers_dev_enabled: true,
    },
    bootstrap_tag_sha256: HASH("a"),
    schema_version: source ? 47 : null,
    user_tables: source ? null : 0,
    content_rows: 0,
    vector_count: 0,
    vectorize_created_on: VECTOR_CREATED_ON,
    metadata_indexes_sha256: HASH("b"),
  });
  return {
    role,
    accountId: ACCOUNT,
    resourceName,
    adminKeyLocator: `keychain://${resourceName}/owner`,
    recoveryArtifactKeyLocator: source
      ? null
      : `keychain://${resourceName}/artifact-v1`,
    bankWrappingKeyLocator: source
      ? null
      : `keychain://${resourceName}/bank-wrapping-v2`,
    candidateModuleInventorySha256: HASH("c"),
    migrationInventorySha256: HASH("d"),
    bootstrapModuleInventorySha256: HASH("e"),
    async readCollisions() {
      return {
        schema_version: 1,
        operation: "read_provisioning_collisions",
        account_id: ACCOUNT,
        resource_name: resourceName,
        worker_exists: workerCreated,
        d1_exists: d1Created,
        vectorize_exists: vectorCreated,
        worker_ids: workerCreated ? [workerId] : [],
        d1_ids: d1Created ? [databaseId] : [],
        vectorize_names: vectorCreated ? [resourceName] : [],
        responses: [responseEvidence()],
      };
    },
    async createMutationProvider() {
      return {
        async createD1() {
          d1Created = true;
          return providerResult({ database_id: databaseId });
        },
        async reconcileD1() { return { outcome: "resume_safe" }; },
        async createVectorize() {
          vectorCreated = true;
          return providerResult({ accepted: true, created_on: VECTOR_CREATED_ON });
        },
        async reconcileVectorize() { return { outcome: "resume_safe" }; },
        async createMetadataIndex({ propertyName, indexType }) {
          return providerResult({ property_name: propertyName, index_type: indexType });
        },
        async reconcileMetadataIndex() { return { outcome: "resume_safe" }; },
        async createWorker() {
          workerCreated = true;
          return providerResult({ worker_id: workerId });
        },
        async reconcileWorker() { return { outcome: "resume_safe" }; },
        async initializeSourceSchema() {
          return providerResult({
            migration_inventory_sha256: HASH("d"),
            schema_version: 47,
          });
        },
        async reconcileSourceSchema() { return { outcome: "resume_safe" }; },
        async readFinalIdentity() {
          return { worker_id: workerId, hostname: `${resourceName}.fixture.workers.dev` };
        },
        async createBaseline() { return providerResult({ version_id: versionId }); },
        async reconcileBaseline() { return { outcome: "resume_safe" }; },
        async readFinal() {
          return { semantic: semantic(), evidence: [responseEvidence()] };
        },
        dispose() {},
      };
    },
  };
}

async function genuineProvisionCapabilities() {
  const directory = realpathSync(mkdtempSync(join(
    tmpdir(),
    "brain-v048-teardown-provisions-",
  )));
  chmodSync(directory, 0o700);
  RETAINED_CAPABILITY_DIRECTORIES.add(directory);
  const capabilities = {};
  const artifactPaths = {};
  for (const role of ["source", "target"]) {
      const provider = genuineProvisionProvider(role);
      const binding = disposableRecoveryProvisioningBinding(
        { binding: provisioningPreparationBinding() },
        provider,
        role,
        CORE_TEST_K0.proof,
      );
      const paths = disposableRecoveryProvisionPaths(directory, role);
      artifactPaths[role] = paths;
      const preflight = await runDisposableRecoveryProvisionPreflight({
        binding,
        keychainProof: CORE_TEST_K0.proof,
        provider,
        receiptPath: paths.preflight,
        expectedReceiptDirectory: directory,
        revalidate: () => true,
        now: () => new Date(role === "source"
          ? "2026-09-13T00:05:00.000Z"
          : "2026-09-13T00:15:00.000Z"),
      });
      await runDisposableRecoveryProvisionPhase({
        binding,
        keychainProof: CORE_TEST_K0.proof,
        provider,
        preflightReceiptPath: paths.preflight,
        approvalFingerprint: disposableRecoveryProvisionApprovalFingerprint(
          binding,
          preflight.receiptSha256,
        ),
        journalPath: paths.journal,
        receiptPath: paths.phase,
        manifestPath: paths.manifest,
        expectedReceiptDirectory: directory,
        revalidate: () => true,
        now: () => new Date(role === "source"
          ? "2026-09-13T00:10:00.000Z"
          : "2026-09-13T00:20:00.000Z"),
      });
      capabilities[role] = readDisposableRecoveryTeardownProvisionArtifacts({
        receiptPath: paths.phase,
        manifestPath: paths.manifest,
        expectedReceiptDirectory: directory,
        role,
      });
  }
  return Object.freeze({
    ...capabilities,
    fixture: Object.freeze({ directory, paths: Object.freeze(artifactPaths) }),
  });
}

const GENUINE_PROVISIONS = process.platform === "win32"
  ? null
  : await genuineProvisionCapabilities();

function deploymentSnapshot(label, semantic = null) {
  const semanticSha256 = semantic === null
    ? sha256(`${label}-semantic`)
    : sha256(canonical(semantic));
  return {
    first_raw_evidence_manifest_sha256: sha256(`${label}-raw-1`),
    second_raw_evidence_manifest_sha256: sha256(`${label}-raw-2`),
    first_semantic_sha256: semanticSha256,
    second_semantic_sha256: semanticSha256,
    stable_semantic_sha256: semanticSha256,
  };
}

function deploymentVersion(id, label, moduleHash, withoutModeHash) {
  return {
    version_id: id,
    script_etag: `${label}-etag`,
    upload_request_sha256: sha256(`${label}-request`),
    module_inventory_sha256: moduleHash,
    bindings_sha256: sha256(`${label}-bindings`),
    bindings_without_mode_sha256: withoutModeHash,
    upload_response_evidence_manifest_sha256: sha256(`${label}-response`),
    version_readback_evidence_manifest_sha256: sha256(`${label}-readback`),
  };
}

function deploymentNetworkIsolation(role) {
  return {
    worker_identity_proved: true,
    worker_identity_sha256: sha256(`${role}-worker-identity`),
    workers_dev_identity_proved: true,
    worker_previews_disabled: true,
    worker_cache_enabled: false,
    worker_extra_exports: 0,
    worker_tail_consumers: 0,
    worker_assets: false,
    worker_logpush: false,
    cron_triggers: 0,
    routes: 0,
    custom_domains: 0,
  };
}

function deploymentSemanticVersion(evidence) {
  return {
    bindings_sha256: evidence.bindings_sha256,
    bindings_without_mode_sha256: evidence.bindings_without_mode_sha256,
    handlers: ["fetch", "scheduled"],
    named_handlers_count: 0,
    script_etag: evidence.script_etag,
    version_id: evidence.version_id,
  };
}

function deploymentSemanticResource() {
  return {
    custom_domains_count: 0,
    d1_exists: true,
    d1_name_and_id_exact: true,
    previews_enabled: false,
    routes_count: 0,
    schedules_count: 0,
    vector_count: 0,
    vector_dimensions: 768,
    vector_metric: "cosine",
    vectorize_exists: true,
    vectorize_name_exact: true,
    worker_exists: true,
    workers_dev_enabled: true,
  };
}

function deploymentTargetPhase(binding, quiescenceApproval) {
  const sourcePhaseSha256 = sha256("a12-source-phase");
  const seedReceiptSha256 = sha256("a12-seed");
  const targetPreflightSha256 = sha256("a12-target-preflight");
  const sharedModule = sha256("a12-target-module");
  const sharedWithoutMode = sha256("a12-target-bindings-without-mode");
  const pausedVersion = deploymentVersion(
    "77777777-7777-4777-8777-777777777777",
    "a12-paused",
    sharedModule,
    sharedWithoutMode,
  );
  const activeVersion = deploymentVersion(
    TARGET_VERSION,
    "a12-active",
    sharedModule,
    sharedWithoutMode,
  );
  const value = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    kind: "target_phase",
    status: "passed",
    completed_at: "2026-09-13T00:24:00.000Z",
    binding,
    source_phase_receipt_sha256: sourcePhaseSha256,
    seed_receipt_sha256: seedReceiptSha256,
    target_preflight_receipt_sha256: targetPreflightSha256,
    a4_approval_fingerprint: disposableRecoveryTargetA4Fingerprint(
      binding,
      sourcePhaseSha256,
      seedReceiptSha256,
      targetPreflightSha256,
    ),
    vectorize_mutation_quiescence:
      disposableRecoveryVectorizeMutationQuiescenceClaim(
        binding,
        quiescenceApproval,
      ),
    journal: {
      run_id: binding.run_id,
      through_sequence: 6,
      event_count: 6,
      source_prefix_head_sha256: sha256("a12-source-journal-head"),
      head_sha256: sha256("a12-target-journal-head"),
      event_manifest_sha256: sha256("a12-target-journal-manifest"),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version_id: SOURCE_VERSION,
      active_script_etag: "a12-source-etag",
      active_deployment_id: "88888888-8888-4888-8888-888888888888",
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      paused_version: pausedVersion,
      active_version: activeVersion,
      paused_deployment: {
        deployment_id: "99999999-9999-4999-8999-999999999999",
        version_id: pausedVersion.version_id,
        traffic_percent: 100,
        deployment_request_sha256: sha256("a12-paused-deployment-request"),
        deployment_response_evidence_manifest_sha256:
          sha256("a12-paused-deployment-response"),
        deployment_readback_evidence_manifest_sha256:
          sha256("a12-paused-deployment-readback"),
      },
    },
  };
  const sourceNetworkIsolation = deploymentNetworkIsolation("source");
  const targetNetworkIsolation = deploymentNetworkIsolation("target");
  const campaignInput = {
    source: {
      workerId: SOURCE_WORKER_ID,
      workerName: DISPOSABLE_TEARDOWN_NAMES.source,
      databaseId: SOURCE_D1,
      vectorizeIndexName: DISPOSABLE_TEARDOWN_NAMES.source,
      deploymentId: value.source.active_deployment_id,
      versionId: value.source.active_version_id,
      scriptEtag: value.source.active_script_etag,
      reviewedGenerationSha256: sha256("a12-source-reviewed-generation"),
    },
    target: {
      workerId: TARGET_WORKER_ID,
      workerName: DISPOSABLE_TEARDOWN_NAMES.target,
      databaseId: TARGET_D1,
      vectorizeIndexName: DISPOSABLE_TEARDOWN_NAMES.target,
      paused: {
        deploymentId: value.target.paused_deployment.deployment_id,
        versionId: pausedVersion.version_id,
        scriptEtag: pausedVersion.script_etag,
        reviewedGenerationSha256:
          sha256("a12-target-paused-reviewed-generation"),
      },
      active: {
        deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versionId: activeVersion.version_id,
        scriptEtag: activeVersion.script_etag,
        reviewedGenerationSha256:
          sha256("a12-target-active-reviewed-generation"),
      },
    },
    sourceNetworkIsolation,
    targetNetworkIsolation,
    nonCampaignBindingText: "stable-binding",
    sourceVectorizeCreatedOn: VECTOR_CREATED_ON,
    targetVectorizeCreatedOn: VECTOR_CREATED_ON,
  };
  const a4Campaign = createDisposableCampaignAuthorityFixture(campaignInput);
  const evaluatedCampaign = createDisposableCampaignAuthorityFixture({
    ...campaignInput,
    targetMode: "active",
  });
  value.final_semantic = {
    campaign_authority: a4Campaign.authority,
    campaign_custody: a4Campaign.custody,
    source: {
      active_deployment_id: value.source.active_deployment_id,
      active_script_etag: value.source.active_script_etag,
      active_traffic_percent: 100,
      active_version_id: value.source.active_version_id,
      network_isolation: sourceNetworkIsolation,
      resource: deploymentSemanticResource(),
      resource_fingerprint: binding.source_resource_fingerprint,
      worker_generation: {
        schema_version: 1,
        worker_identity_proved: true,
        worker_generation_proved: true,
        worker_generation_sha256: a4Campaign.custody.roles.source
          .worker_protection.worker_generation_sha256,
      },
    },
    target: {
      active_version: deploymentSemanticVersion(activeVersion),
      network_isolation: targetNetworkIsolation,
      paused_deployment: {
        deployment_id: value.target.paused_deployment.deployment_id,
        traffic_percent: 100,
        version_id: pausedVersion.version_id,
      },
      paused_version: deploymentSemanticVersion(pausedVersion),
      resource: deploymentSemanticResource(),
      resource_fingerprint: binding.target_resource_fingerprint,
      worker_generation: {
        schema_version: 1,
        worker_identity_proved: true,
        worker_generation_proved: true,
        worker_generation_sha256: a4Campaign.custody.roles.target
          .worker_protection.worker_generation_sha256,
      },
    },
    vectorize_mutation_quiescence: value.vectorize_mutation_quiescence,
  };
  value.final_snapshot = deploymentSnapshot(
    "a12-target-final",
    value.final_semantic,
  );
  return Object.freeze({
    receipt: value,
    a4Authority: a4Campaign.authority,
    evaluatedAuthority: evaluatedCampaign.authority,
  });
}

function recoveryClock(start) {
  let value = Date.parse(start);
  return () => {
    const result = new Date(value);
    value += 1000;
    return result;
  };
}

function recoveryEvidence(
  stage,
  context,
  fieldProof = null,
  vectorizeMutationQuiescenceSha256 = null,
) {
  const artifactSha256 = sha256("a12-recovery-artifact");
  const schemaFingerprint = sha256("a12-schema");
  const aggregateFingerprint = sha256("a12-aggregate");
  const contentFingerprint = sha256("a12-content");
  const bankProof = {
    protocol: "bank-security-v1",
    reconciliation_at: "2026-09-13T00:25:00.000Z",
    rows: [],
  };
  const chunks = 6_113;
  const values = {
    export_d1: { artifact_sha256: artifactSha256, artifact_bytes: 4096 },
    verify_export: {
      artifact_sha256: artifactSha256,
      artifact_bytes: 4096,
      integrity: "ok",
      schema_fingerprint: schemaFingerprint,
      aggregate_fingerprint: aggregateFingerprint,
      content_fingerprint: contentFingerprint,
      source_d1_deletion_state_fingerprint: HASH("f"),
      document_count: 6_001,
      chunk_count: chunks,
      fts_count: chunks,
    },
    prove_target_clean: {
      target_resource_fingerprint: context.targetResourceFingerprint,
      user_table_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
    },
    restore_d1: { artifact_sha256: artifactSha256, import_completed: true },
    verify_d1: {
      integrity: "ok",
      schema_fingerprint: schemaFingerprint,
      aggregate_fingerprint: aggregateFingerprint,
      content_fingerprint: contentFingerprint,
      document_count: 6_001,
      chunk_count: chunks,
      fts_count: chunks,
      non_bank_content_fingerprint: contentFingerprint,
      bank_security_fingerprint: sha256(canonical(bankProof)),
      bank_security_proof: bankProof,
    },
    reconcile_security: {
      integrity: "ok",
      schema_fingerprint: schemaFingerprint,
      aggregate_fingerprint: aggregateFingerprint,
      content_fingerprint: contentFingerprint,
      document_count: 6_001,
      chunk_count: chunks,
      fts_count: chunks,
      bank_protected: 0,
      bank_reauthorization_required: 0,
      bank_legacy_rewrap_required: 0,
      bank_unsupported_key_versions: 0,
    },
    rebuild_vectorize: {
      chunk_count: chunks,
      vector_count: chunks,
      pending_outbox: 0,
      failed_vectors: 0,
      ...(vectorizeMutationQuiescenceSha256 ? {
        vectorize_mutation_quiescence_sha256:
          vectorizeMutationQuiescenceSha256,
        vector_id_set_sha256: HASH("1"),
        vector_watermark_sha256: HASH("2"),
        vector_barrier_sha256: HASH("3"),
        promotion_intent_sha256: HASH("4"),
      } : {}),
      ...(fieldProof ? {
        source_phase_receipt_sha256: fieldProof.source_phase_receipt_sha256,
        deployment_receipt_sha256: fieldProof.deployment_receipt_sha256,
        seed_receipt_sha256: fieldProof.seed_receipt_sha256,
        bootstrap_interruption_checkpoint_sha256:
          sha256("a12-bootstrap-interruption"),
        bootstrap_resume_authorization_sha256: sha256("a12-bootstrap-resume"),
        bootstrap_promotion_authorization_sha256:
          sha256("a12-bootstrap-promotion"),
      } : {}),
    },
    verify_health: { status: "pass", failure_count: 0, vector_backlog: 0 },
    verify_eval: {
      profile: "release",
      status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
      final_d1_content_fingerprint: contentFingerprint,
      final_d1_deletion_state_fingerprint: HASH("9"),
      target_eval_llm_append: {
        schema_version: 1,
        kind: "v048_target_eval_llm_append_v1",
        before_rows: 2,
        appended_rows: 2,
        after_rows: 4,
        rag_think_rows: 1,
        rag_evidence_gate_rows: 1,
        transition_sha256: HASH("e"),
      },
      ...(vectorizeMutationQuiescenceSha256 ? {
        vectorize_mutation_quiescence_sha256:
          vectorizeMutationQuiescenceSha256,
      } : {}),
    },
  };
  return values[stage];
}

async function genuineA12Capability() {
  const directory = realpathSync(mkdtempSync(join(
    tmpdir(),
    "brain-v048-teardown-a12-",
  )));
  chmodSync(directory, 0o700);
  RETAINED_CAPABILITY_DIRECTORIES.add(directory);
  const sourceManifestPath = disposableRecoveryProvisionPaths(
    directory,
    "source",
  ).manifest;
  const targetManifestPath = disposableRecoveryProvisionPaths(
    directory,
    "target",
  ).manifest;
  for (const [path, value] of [
    [sourceManifestPath, GENUINE_PROVISIONS.source.manifest],
    [targetManifestPath, GENUINE_PROVISIONS.target.manifest],
  ]) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  }
  const planPath = join(directory, "verified-recovery-plan.json");
  const statePath = join(directory, "verified-recovery-state.json");
  const quiescence = reviewVerifiedRecoveryVectorizeMutationQuiescence(
    sourceManifestPath,
    targetManifestPath,
  );
  const initialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    planPath,
    statePath,
    {
      now: new Date("2026-09-13T00:21:00.000Z"),
      approveVectorizeMutationQuiescence:
        quiescence.vectorize_mutation_quiescence_sha256,
    },
  );
  const bindingBase = {
    ...provisioningPreparationBinding(),
    schema_version: 2,
    run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    plan_fingerprint: initialized.plan.plan_fingerprint,
    keychain_binding_sha256: CORE_TEST_K0.proof.keychain_binding_sha256,
    source_manifest_fingerprint: initialized.plan.source_manifest_fingerprint,
    source_resource_fingerprint: initialized.plan.source_resource_fingerprint,
    target_manifest_fingerprint: initialized.plan.target_manifest_fingerprint,
    target_resource_fingerprint: initialized.plan.target_resource_fingerprint,
    runtime_contract_fingerprint: initialized.plan.runtime_contract_fingerprint,
  };
  const binding = Object.freeze({
    ...bindingBase,
    campaign_fingerprint:
      disposableRecoveryDeploymentCampaignFingerprint(bindingBase),
  });
  const deploymentCampaign = deploymentTargetPhase(
    binding,
    quiescence.vectorize_mutation_quiescence_sha256,
  );
  const deployment = deploymentCampaign.receipt;
  const deploymentPath = join(
    directory,
    DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  );
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(deploymentPath, 0o600);
  const deploymentSha256 = privateReceiptSha256(deployment);
  const adapters = Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [
    id,
    async (context) => recoveryEvidence(
      id,
      context,
      null,
      quiescence.vectorize_mutation_quiescence_sha256,
    ),
  ]));
  let checkpointState = initialized.state;
  try {
    await runVerifiedRecovery(initialized.plan, initialized.state, adapters, {
      clock: recoveryClock("2026-09-13T00:25:00.000Z"),
      revalidateManifests: async () => true,
      approveVectorizeMutationQuiescence:
        quiescence.vectorize_mutation_quiescence_sha256,
      persistState: async (state) => { checkpointState = state; },
      afterStageCheckpoint: async (stage) => {
        if (stage === "reconcile_security") throw new Error("a12-field-checkpoint");
      },
    });
  } catch (error) {
    assert.equal(error.message, "a12-field-checkpoint");
  }
  const fieldProof = {
    schema_version: 1,
    kind: "v048_disposable_recovery_seed_bridge",
    candidate_sha: binding.candidate_sha,
    package_sha256: binding.package_sha256,
    field_receipt_sha256: binding.field_receipt_sha256,
    source_phase_receipt_sha256: deployment.source_phase_receipt_sha256,
    deployment_receipt_sha256: deploymentSha256,
    seed_receipt_sha256: deployment.seed_receipt_sha256,
    fixture_sha256:
      "7e8325d3014102e3509fd2f5dcc7ac78aded99dffac18c899e1dd2611cfba6c8",
    seed_d1_content_fingerprint: sha256("a12-content"),
    expected_documents: 6_001,
    expected_chunks: 6_113,
    expected_fts: 6_113,
    seed_replay_unchanged_documents: 6_001,
    paired_stop_stage: "rebuild_vectorize",
  };
  const boundState = bindVerifiedRecoveryFieldProof(
    checkpointState,
    initialized.plan,
    fieldProof,
    { now: new Date("2026-09-13T00:38:00.000Z") },
  );
  const completingAdapters = Object.fromEntries(
    VERIFIED_RECOVERY_STAGES.map(({ id }) => [
      id,
      async (context) => recoveryEvidence(
        id,
        context,
        fieldProof,
        quiescence.vectorize_mutation_quiescence_sha256,
      ),
    ]),
  );
  const completed = await runVerifiedRecovery(
    initialized.plan,
    boundState,
    completingAdapters,
    {
      clock: recoveryClock("2026-09-13T00:39:00.000Z"),
      revalidateManifests: async () => true,
      approveVectorizeMutationQuiescence:
        quiescence.vectorize_mutation_quiescence_sha256,
    },
  );
  assert.equal(completed.ok, true);
  writeVerifiedRecoveryState(statePath, completed.state, initialized.plan);
  const goldenPath = join(directory, "verified-recovery-golden.json");
  writeFileSync(goldenPath, "{}\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(goldenPath, 0o600);
  const stateSha256 = sha256(readFileSync(statePath));
  const goldenSha256 = sha256(readFileSync(goldenPath));
  const targetEval = targetEvalReceipt(binding, {
    stateSha256,
    goldenSha256,
    completedAt: "2026-09-13T01:00:00.000Z",
    campaignProtection: deploymentCampaign,
  });
  const targetEvalPath = join(
    directory,
    DISPOSABLE_RECOVERY_TARGET_EVAL_RECEIPT_NAME,
  );
  writeFileSync(
    targetEvalPath,
    `${JSON.stringify(targetEval.value, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(targetEvalPath, 0o600);
  const capability = readDisposableRecoveryTeardownA12Evidence({
    targetEvalReceiptPath: targetEvalPath,
    statePath,
    goldenPath,
    deploymentReceiptPath: deploymentPath,
    expectedReceiptDirectory: directory,
    plan: initialized.plan,
  });
  assert.equal(
    assertDisposableRecoveryTeardownA12EvidenceCapability(capability),
    capability,
  );
  return Object.freeze({
    directory,
    plan: initialized.plan,
    binding,
    capability,
    paths: Object.freeze({
      sourceManifestPath,
      targetManifestPath,
      statePath,
      goldenPath,
      deploymentPath,
      targetEvalPath,
    }),
  });
}

const GENUINE_A12 = process.platform === "win32"
  ? null
  : await genuineA12Capability();

function rereadGenuineProvisionCapabilities(completedAt) {
  const directory = realpathSync(mkdtempSync(join(
    tmpdir(),
    "brain-v048-teardown-provision-time-",
  )));
  chmodSync(directory, 0o700);
  RETAINED_CAPABILITY_DIRECTORIES.add(directory);
  const capabilities = {};
  for (const role of ["source", "target"]) {
      const paths = disposableRecoveryProvisionPaths(directory, role);
      const receipt = structuredClone(GENUINE_PROVISIONS[role].receipt);
      receipt.completed_at = completedAt[role];
      writeFileSync(paths.phase, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      writeFileSync(
        paths.manifest,
        `${JSON.stringify(GENUINE_PROVISIONS[role].manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(paths.phase, 0o600);
      chmodSync(paths.manifest, 0o600);
      capabilities[role] = readDisposableRecoveryTeardownProvisionArtifacts({
        receiptPath: paths.phase,
        manifestPath: paths.manifest,
        expectedReceiptDirectory: directory,
        role,
      });
  }
  return Object.freeze(capabilities);
}

const REVERSED_PROVISIONS = process.platform === "win32" ? null
  : rereadGenuineProvisionCapabilities({
    source: "2026-09-13T00:21:00.000Z",
    target: "2026-09-13T00:20:00.000Z",
  });
const TARGET_AFTER_DEPLOYMENT_PROVISIONS = process.platform === "win32" ? null
  : rereadGenuineProvisionCapabilities({
    source: "2026-09-13T00:10:00.000Z",
    target: "2026-09-13T00:25:00.000Z",
  });

function fakeProvisionManifest(role) {
  const name = DISPOSABLE_TEARDOWN_NAMES[role];
  return {
    brain: { worker_name: name },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT,
        worker_id: role === "source" ? SOURCE_WORKER_ID : TARGET_WORKER_ID,
        d1_database_id: role === "source" ? SOURCE_D1 : TARGET_D1,
        d1_database_name: name,
        vectorize_index: name,
      },
    },
  };
}

function fakeProvisionBinding(preparationBinding, role, keychainProof) {
  const provisioningBinding = Object.fromEntries([
    "candidate_sha", "candidate_tree_sha", "field_receipt_run_id",
    "field_receipt_sha256", "package_filename", "package_bytes",
    "package_sha256", "package_file_count", "execution_inventory_sha256",
    "installed_execution_inventory_sha256", "wrangler_version",
    "wrangler_wrapper_sha256", "wrangler_runtime_inventory_sha256",
    "wrangler_entrypoint_sha256", "node_version", "node_executable_sha256",
  ].map((field) => [field, preparationBinding[field]]));
  const name = DISPOSABLE_TEARDOWN_NAMES[role];
  const provider = {
    role,
    accountId: ACCOUNT,
    resourceName: name,
    adminKeyLocator: `keychain://${name}/owner`,
    recoveryArtifactKeyLocator: role === "source"
      ? null
      : `keychain://${name}/artifact-v1`,
    bankWrappingKeyLocator: role === "source"
      ? null
      : `keychain://${name}/bank-wrapping-v2`,
    candidateModuleInventorySha256: HASH("1"),
    migrationInventorySha256: HASH("2"),
    bootstrapModuleInventorySha256: HASH("3"),
  };
  return disposableRecoveryProvisioningBinding(
    { binding: { schema_version: 1, ...provisioningBinding } },
    provider,
    role,
    keychainProof,
  );
}

function fakePreparation(provider, keychainProof = CORE_TEST_K0.proof) {
  const sourceName = DISPOSABLE_TEARDOWN_NAMES.source;
  const targetName = DISPOSABLE_TEARDOWN_NAMES.target;
  const info = provider.info;
  const preparationBinding = GENUINE_A12.binding;
  return {
    binding: preparationBinding,
    targetEvalReceipt: GENUINE_A12.capability.target_eval_receipt,
    a12Evidence: GENUINE_A12.capability,
    manifestBindings: {
      planFingerprint: preparationBinding.plan_fingerprint,
      sourceManifestFingerprint: preparationBinding.source_manifest_fingerprint,
      targetManifestFingerprint: preparationBinding.target_manifest_fingerprint,
      source: {
        accountId: ACCOUNT,
        workerId: SOURCE_WORKER_ID,
        workerName: sourceName,
        databaseId: SOURCE_D1,
        vectorizeCreatedOn: VECTOR_CREATED_ON,
        databaseName: sourceName,
        vectorizeIndex: sourceName,
      },
      target: {
        accountId: ACCOUNT,
        workerId: TARGET_WORKER_ID,
        workerName: targetName,
        databaseId: TARGET_D1,
        vectorizeCreatedOn: VECTOR_CREATED_ON,
        databaseName: targetName,
        vectorizeIndex: targetName,
      },
    },
    provisionArtifacts: {
      source: GENUINE_PROVISIONS.source,
      target: GENUINE_PROVISIONS.target,
    },
    executionPins: [{
      relative: "operations/cloudflare-disposable-teardown-provider.mjs",
      path: provider.path,
      hash: provider.sha256,
      info,
    }],
    keychainProof,
    revalidate: () => true,
    revalidateKeychain: async () => true,
  };
}

function fakePins() {
  const provider = {
    path: "/fixture/provider.mjs",
    program: "fixture provider",
    sha256: sha256("fixture provider"),
    info: { dev: 1, ino: 2, nlink: 1, size: 16, mtimeMs: 1, ctimeMs: 1 },
  };
  const wrapper = {
    path: "/fixture/wrapper",
    program: "fixture wrapper",
    sha256: sha256("fixture wrapper"),
    providerSha256: provider.sha256,
    tokenLocator: teardownTokenLocator(),
  };
  return { provider, wrapper };
}

function teardownTokenLocator(
  accountId = ACCOUNT,
  service = DISPOSABLE_TEARDOWN_TOKEN_SERVICE,
) {
  const accountFingerprint = sha256(canonical({
    kind: "cloudflare_account",
    account_id: accountId,
  }));
  const serviceSha256 = sha256(service);
  return {
    account_fingerprint: accountFingerprint,
    service_sha256: serviceSha256,
    locator_sha256: sha256(canonical({
      backend: "macos_keychain",
      account_fingerprint: accountFingerprint,
      service_sha256: serviceSha256,
    })),
  };
}

function manualTeardownClosureFixture(preparation) {
  const sourceReceipt = completedSourceTeardownReceipt(preparation).value;
  const project = (receipt) => ({
    resource_fingerprint: receipt.resource_fingerprint,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    present_preview_sha256: receipt.present_preview_sha256,
    custody: structuredClone(receipt.custody),
    actions: structuredClone(receipt.actions),
    absent_preview_sha256: receipt.absent_preview_sha256,
    absence: structuredClone(receipt.absence),
  });
  const source = project(sourceReceipt);
  const target = structuredClone(source);
  target.resource_fingerprint = preparation.binding.target_resource_fingerprint;
  target.started_at = "2026-09-13T01:02:00.000Z";
  target.completed_at = "2026-09-13T01:03:00.000Z";
  target.custody.resources = target.custody.resources.map((resource) => ({
    ...resource,
    instance_fingerprint: sha256(`target-${resource.kind}`),
  }));
  target.actions = target.actions.map((action) => ({
    ...action,
    instance_fingerprint: sha256(`target-${action.kind}`),
    request_sha256: sha256(`target-request-${action.kind}`),
  }));
  const closureBinding = preparation.targetEvalReceipt.value.binding;
  const {
    locatorHashes,
    keychainPreparation,
  } = fixtureKeychainPreparation(closureBinding);
  const targetEvalReceiptSha256 = preparation.targetEvalReceipt.sha256;
  const sourceTeardownReceiptSha256 = HASH("c");
  const targetTeardownReceiptSha256 = HASH("d");
  const retainedNames = [
    "v048-disposable-field-keychain-prep.json",
    "v048-disposable-source-provision-preflight.json",
    "v048-disposable-source-provision.json",
    "v048-disposable-source.manifest.json",
    "v048-disposable-source-provision-journal.jsonl",
    "v048-disposable-target-provision-preflight.json",
    "v048-disposable-target-provision.json",
    "v048-disposable-target.manifest.json",
    "v048-disposable-target-provision-journal.jsonl",
    "v048-disposable-source-preflight-receipt.json",
    "v048-disposable-source-deployment-receipt.json",
    "v048-disposable-source-deployment-journal.jsonl",
    "v048-disposable-target-preflight-receipt.json",
    "v048-disposable-deployment-receipt.json",
    "v048-disposable-target-deployment-journal.jsonl",
    "v048-disposable-seed-receipt.json",
    "v048-disposable-target-eval-receipt.json",
    "v048-disposable-source-teardown-preview.json",
    "v048-disposable-source-teardown.json",
    "v048-disposable-source-teardown-absent-preview.json",
    "v048-disposable-target-teardown-preview.json",
    "v048-disposable-target-teardown.json",
    "v048-disposable-target-teardown-absent-preview.json",
  ];
  const retainedHashes = new Map([
    [retainedNames[0], keychainPreparation.receipt_sha256],
    [retainedNames[16], targetEvalReceiptSha256],
    [retainedNames[18], sourceTeardownReceiptSha256],
    [retainedNames[21], targetTeardownReceiptSha256],
  ]);
  const explicitRoles = [
    "source_manifest", "target_manifest", "plan", "state",
    "wrangler_wrapper", "golden", "field_receipt", "package",
  ];
  const retainedInventory = {
    schema_version: 1,
    kind: "v048_disposable_retained_evidence_inventory",
    receipt_directory: {
      path_sha256: HASH("7"),
      items: retainedNames.map((name, index) => ({
        name,
        bytes: 100 + index,
        sha256: retainedHashes.get(name) ??
          (index % 10).toString(16).repeat(64),
      })),
      k0_reset_receipts: [],
      k0_reset_journals: [],
    },
    explicit_files: explicitRoles.map((role, index) => ({
      role,
      name: `${role}.fixture`,
      path_sha256: (index + 1).toString(16).repeat(64),
      bytes: 200 + index,
      sha256: role === "source_manifest" ? HASH("3")
        : role === "target_manifest" ? HASH("7")
          : role === "state" ? closureBinding.recovery_state_sha256
        : role === "golden" ? closureBinding.golden_sha256
          : role === "field_receipt" ? closureBinding.field_receipt_sha256
            : role === "package" ? closureBinding.package_sha256
              : (index + 8).toString(16).slice(-1).repeat(64),
    })),
    artifact_directory: {
      path_sha256: HASH("8"),
      items: [{
        relative_name: ".brain-recovery-export.sql.fbrenc",
        bytes: 512,
        sha256: HASH("9"),
      }],
      encrypted_provenance_artifact_present: true,
    },
  };
  const retainedEvidence = {
    inventory: retainedInventory,
    inventory_sha256: sha256(canonical(retainedInventory)),
  };
  const a17ApprovalFingerprint = sha256(canonical({
    schema_version: 1,
    protocol: "v048-disposable-recovery-field-closeout-v1",
    action: "A17",
    binding: closureBinding,
    target_eval_receipt_sha256: targetEvalReceiptSha256,
    source_teardown_receipt_sha256: sourceTeardownReceiptSha256,
    target_teardown_receipt_sha256: targetTeardownReceiptSha256,
    keychain_preparation: keychainPreparation,
    retained_evidence: retainedEvidence,
    campaign_keychain_locator_sha256: locatorHashes,
  }));
  return {
    schema_version: 1,
    kind: "v048_disposable_manual_teardown_closure",
    status: "closed",
    completed_at: "2026-09-13T01:04:00.000Z",
    binding: closureBinding,
    evidence: {
      target_eval_receipt_sha256: targetEvalReceiptSha256,
      source_teardown_receipt_sha256: sourceTeardownReceiptSha256,
      target_teardown_receipt_sha256: targetTeardownReceiptSha256,
      keychain_preparation: keychainPreparation,
      retained_evidence: retainedEvidence,
      a17_approval_fingerprint: a17ApprovalFingerprint,
    },
    maintenance_window: MAINTENANCE_WINDOW,
    ceremony_order: ["source", "target"],
    source,
    target,
    ambiguity: { unresolved_outcomes: 0 },
    keychain: {
      campaign_items: locatorHashes.map((locator_sha256) => ({
        locator_sha256,
        lookup: "item_not_found",
      })),
      shared_test_token_lookup: { lookup: "succeeded", value_printed: false },
      deletion_journal: {
        schema_version: 1,
        protocol:
          "v048-disposable-recovery-field-closeout-deletion-journal-v1",
        path_sha256: HASH("a"),
        event_count: 12,
        head_sha256: HASH("b"),
        journal_sha256: HASH("c"),
        terminal_state: "all_campaign_items_confirmed_absent",
      },
    },
  };
}

testWithMacosPrivateReceipt("final acceptance cannot pass on storage 404s without bound inventory proof", () => {
  const { provider } = fakePins();
  const preparation = fakePreparation(provider);
  const baseline = manualTeardownClosureFixture(preparation);
  assert.doesNotThrow(() => assertDisposableRecoveryManualTeardownClosure(
    baseline,
    preparation.targetEvalReceipt.value.binding,
  ));

  for (const mutate of [
    (value) => { delete value.source.custody.storage_inventory_passes; },
    (value) => {
      value.source.custody.storage_inventory_passes.d1[1].inventory_sha256 =
        HASH("f");
    },
    (value) => {
      value.target.custody.storage_inventory_passes.vectorize[1]
        .pagination_complete = false;
    },
    (value) => {
      value.source.actions[1].absence_authority =
        "exact_id_404_code_10007";
    },
    (value) => { value.target.actions[0].missing_code_sha256 = HASH("f"); },
    (value) => {
      [value.target.custody.storage_inventory_passes.d1,
        value.target.custody.storage_inventory_passes.vectorize] = [
        value.target.custody.storage_inventory_passes.vectorize,
        value.target.custody.storage_inventory_passes.d1,
      ];
    },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(
      () => assertDisposableRecoveryManualTeardownClosure(
        changed,
        preparation.targetEvalReceipt.value.binding,
      ),
      (error) => error.code ===
        "DISPOSABLE_RECOVERY_TEARDOWN_CLOSURE_INVALID",
    );
  }
});

testWithMacosPrivateReceipt("actual A1/A3 producer bindings preserve microsecond identity through teardown", async () => {
  const directory = realpathSync(mkdtempSync(join(
    tmpdir(),
    "brain-v048-vector-created-on-",
  )));
  chmodSync(directory, 0o700);
  try {
    const fixture = providerFixture();
    const { provider, wrapper } = fakePins();
    const preparation = fakePreparation(provider);
    for (const role of ["source", "target"]) {
      const produced = preparation.provisionArtifacts[role].binding;
      const campaignBase = { ...produced };
      delete campaignBase.campaign_fingerprint;
      assert.equal(
        produced.campaign_fingerprint,
        sha256(canonical(campaignBase)),
      );
      assert.equal(Object.hasOwn(produced, "plan_fingerprint"), false);
    }
    let observedPreviewRequest;
    const previewPath = join(directory, "source-preview.json");
    const previewRun = await runDisposableRecoveryTeardownPreview({
      preparation,
      role: "source",
      receiptPath: previewPath,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => ({
        invoke: async (request) => {
          observedPreviewRequest = request;
          return executeDisposableTeardownProvider(request, {
            fetchImpl: fixture.fetchImpl,
            token: Buffer.from(TOKEN),
          });
        },
      }),
      now: () => new Date("2026-09-13T01:00:00.000Z"),
    });
    assert.equal(
      observedPreviewRequest.target.vectorize_created_on,
      "2022-11-15T18:25:44.442097Z",
    );
    const deleted = await executeDisposableTeardownProvider({
      ...observedPreviewRequest,
      operation: "delete",
      kind: "vectorize",
      expected_instance_fingerprint:
        previewRun.receipt.instance_fingerprints.vectorize,
    }, {
      fetchImpl: fixture.fetchImpl,
      token: Buffer.from(TOKEN),
    });
    assert.equal(deleted.accepted, true);
    assert.equal(deleted.response_status, 200);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("both A1 and A3 receipts stay fully bound before any teardown provider access", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const variants = [];
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.target.binding.package_filename = "replacement.tgz";
    artifacts.target.receipt.binding.package_filename = "replacement.tgz";
    const base = { ...artifacts.target.binding };
    delete base.campaign_fingerprint;
    artifacts.target.binding.campaign_fingerprint = sha256(canonical(base));
    artifacts.target.receipt.binding.campaign_fingerprint =
      artifacts.target.binding.campaign_fingerprint;
    artifacts.target.receiptSha256 = privateReceiptSha256(artifacts.target.receipt);
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.source.binding.keychain_prep_receipt_sha256 = HASH("f");
    artifacts.source.receipt.binding.keychain_prep_receipt_sha256 = HASH("f");
    const base = { ...artifacts.source.binding };
    delete base.campaign_fingerprint;
    artifacts.source.binding.campaign_fingerprint = sha256(canonical(base));
    artifacts.source.receipt.binding.campaign_fingerprint =
      artifacts.source.binding.campaign_fingerprint;
    artifacts.source.receiptSha256 = privateReceiptSha256(artifacts.source.receipt);
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.target.receiptSha256 = HASH("f");
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.source.manifest.unsealed_field = true;
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.target.receipt.binding = {
      ...artifacts.target.receipt.binding,
      node_version: "v99.0.0",
    };
    const base = { ...artifacts.target.receipt.binding };
    delete base.campaign_fingerprint;
    artifacts.target.receipt.binding.campaign_fingerprint = sha256(canonical(base));
    artifacts.target.receiptSha256 = privateReceiptSha256(artifacts.target.receipt);
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.source.receipt.final_state.vectorize_created_on =
      "2026-09-13T00:00:00.000Z";
    artifacts.source.receiptSha256 = privateReceiptSha256(artifacts.source.receipt);
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.target.completedAt = "2026-09-13T00:31:00.000Z";
    artifacts.target.receipt.completed_at = artifacts.target.completedAt;
    artifacts.target.receiptSha256 = privateReceiptSha256(artifacts.target.receipt);
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  {
    const artifacts = structuredClone(preparation.provisionArtifacts);
    artifacts.source.completedAt = "2026-09-13T00:31:00.000Z";
    artifacts.source.receipt.completed_at = artifacts.source.completedAt;
    artifacts.source.receiptSha256 = privateReceiptSha256(artifacts.source.receipt);
    variants.push({ ...preparation, provisionArtifacts: artifacts });
  }
  variants.push({
    ...preparation,
    provisionArtifacts: REVERSED_PROVISIONS,
  });
  variants.push({
    ...preparation,
    provisionArtifacts: TARGET_AFTER_DEPLOYMENT_PROVISIONS,
  });
  for (const invalid of variants) {
    let providerAccess = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation: invalid,
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        now: () => new Date("2026-09-13T01:00:00.000Z"),
        inspectWrapper: () => { providerAccess += 1; return wrapper; },
        inspectProvider: () => { providerAccess += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerAccess += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_PROVISION_IDENTITY_MISMATCH",
    );
    assert.equal(providerAccess, 0);
  }
});

testWithMacosPrivateReceipt("a minimal self-consistent provision forgery has no reader capability", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const original = preparation.provisionArtifacts.source;
  const manifest = {
    brain: { worker_name: original.resourceName },
    infrastructure: { cloudflare: {
      account_id: original.accountId,
      worker_id: original.workerId,
      d1_database_id: original.databaseId,
      d1_database_name: original.resourceName,
      vectorize_index: original.resourceName,
    } },
  };
  const manifestSha256 = privateReceiptSha256(manifest);
  const receipt = {
    binding: original.binding,
    completed_at: original.completedAt,
    manifest_sha256: manifestSha256,
    final_state: {
      account_id: original.accountId,
      resource_name: original.resourceName,
      worker_id: original.workerId,
      database_id: original.databaseId,
      vectorize_created_on: original.vectorizeCreatedOn,
    },
  };
  const forgery = {
    role: "source",
    accountId: original.accountId,
    resourceName: original.resourceName,
    workerId: original.workerId,
    databaseId: original.databaseId,
    vectorizeCreatedOn: original.vectorizeCreatedOn,
    completedAt: original.completedAt,
    receiptSha256: privateReceiptSha256(receipt),
    manifestSha256,
    receipt,
    binding: receipt.binding,
    manifest,
  };
  let providerAccess = 0;
  await assert.rejects(
    runDisposableRecoveryTeardownPreview({
      preparation: {
        ...preparation,
        provisionArtifacts: {
          ...preparation.provisionArtifacts,
          source: forgery,
        },
      },
      role: "source",
      receiptPath: "/never/reached.json",
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => { providerAccess += 1; return wrapper; },
      inspectProvider: () => { providerAccess += 1; return provider; },
      createInvoker: () => ({
        invoke: async () => { providerAccess += 1; return {}; },
      }),
    }),
    (error) => error.code === "TEARDOWN_PROVISION_IDENTITY_MISMATCH",
  );
  assert.equal(providerAccess, 0);
});

testWithMacosPrivateReceipt("reader-owned A1, A3, and A12 evidence is revalidated from disk", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const cases = [
    {
      label: "mutated A1 phase receipt",
      path: GENUINE_PROVISIONS.fixture.paths.source.phase,
      mutate(path) { writeFileSync(path, "{}\n"); },
    },
    {
      label: "removed A3 manifest",
      path: GENUINE_PROVISIONS.fixture.paths.target.manifest,
      mutate(path) { rmSync(path); },
    },
    {
      label: "mutated A12 recovery state",
      path: GENUINE_A12.paths.statePath,
      mutate(path) { writeFileSync(path, "{}\n"); },
    },
    {
      label: "removed A12 deployment receipt",
      path: GENUINE_A12.paths.deploymentPath,
      mutate(path) { rmSync(path); },
    },
  ];
  for (const fixture of cases) {
    const original = readFileSync(fixture.path);
    try {
      fixture.mutate(fixture.path);
      let providerAccess = 0;
      await assert.rejects(
        runDisposableRecoveryTeardownPreview({
          preparation,
          role: "source",
          receiptPath: "/never/reached.json",
          teardownWrapperPath: wrapper.path,
          maintenanceWindow: MAINTENANCE_WINDOW,
          now: () => new Date("2026-09-13T01:30:00.000Z"),
          inspectWrapper: () => { providerAccess += 1; return wrapper; },
          inspectProvider: () => { providerAccess += 1; return provider; },
          createInvoker: () => ({
            invoke: async () => { providerAccess += 1; return {}; },
          }),
        }),
        (error) => error.code === "TEARDOWN_PREPARATION_CHANGED",
        fixture.label,
      );
      assert.equal(providerAccess, 0, fixture.label);
    } finally {
      writeFileSync(fixture.path, original, { mode: 0o600 });
      chmodSync(fixture.path, 0o600);
    }
  }
});

testWithMacosPrivateReceipt("A14 capability is uncopyable and revalidates its fixed receipt", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const fixture = mintSourceTeardownReceiptCapability(preparation);
  const expectTargetRefusal = async (sourceTeardownReceipt, expectedCode, label) => {
    let providerAccess = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation,
        role: "target",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        sourceTeardownReceipt,
        maintenanceWindow: MAINTENANCE_WINDOW,
        now: () => new Date("2026-09-13T02:00:00.000Z"),
        inspectWrapper: () => { providerAccess += 1; return wrapper; },
        inspectProvider: () => { providerAccess += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerAccess += 1; return {}; },
        }),
      }),
      (error) => error.code === expectedCode,
      label,
    );
    assert.equal(providerAccess, 0, label);
  };

  await expectTargetRefusal(
    { ...fixture.capability },
    "TEARDOWN_SOURCE_RECEIPT_INVALID",
    "copied capability",
  );
  await expectTargetRefusal(
    Object.freeze({}),
    "TEARDOWN_SOURCE_RECEIPT_INVALID",
    "forged capability",
  );

  const original = readFileSync(fixture.receiptPath);
  for (const [label, mutate] of [
    ["mutated receipt", (path) => writeFileSync(path, "{}\n")],
    ["removed receipt", (path) => rmSync(path)],
  ]) {
    try {
      mutate(fixture.receiptPath);
      await expectTargetRefusal(
        fixture.capability,
        "TEARDOWN_PREPARATION_CHANGED",
        label,
      );
    } finally {
      writeFileSync(fixture.receiptPath, original, { mode: 0o600 });
      chmodSync(fixture.receiptPath, 0o600);
    }
  }
});

testWithMacosPrivateReceipt("A13 and A14 require the exact completed A12 receipt before any provider call", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const changedValue = structuredClone(preparation.targetEvalReceipt.value);
  changedValue.binding.candidate_sha = "d".repeat(40);
  const pendingValue = structuredClone(preparation.targetEvalReceipt.value);
  pendingValue.status = "pending";
  const invalidPreparations = [
    { ...preparation, targetEvalReceipt: null },
    { ...preparation, a12Evidence: Object.freeze({}) },
    { ...preparation, a12Evidence: { ...preparation.a12Evidence } },
    {
      ...preparation,
      targetEvalReceipt: { ...preparation.targetEvalReceipt, sha256: HASH("f") },
    },
    {
      ...preparation,
      targetEvalReceipt: {
        value: changedValue,
        sha256: sha256(Buffer.from(`${JSON.stringify(changedValue, null, 2)}\n`)),
      },
    },
    {
      ...preparation,
      targetEvalReceipt: {
        value: pendingValue,
        sha256: sha256(Buffer.from(`${JSON.stringify(pendingValue, null, 2)}\n`)),
      },
    },
  ];
  for (const invalid of invalidPreparations) {
    let providerCalls = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation: invalid,
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        inspectWrapper: () => { providerCalls += 1; return wrapper; },
        inspectProvider: () => { providerCalls += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerCalls += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_TARGET_EVAL_RECEIPT_INVALID",
    );
    assert.equal(providerCalls, 0);
  }

  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-a12-order-")));
  chmodSync(directory, 0o700);
  try {
    let providerCalls = 0;
    const snapshot = semanticSnapshot("source", {
      worker: "present", vectorize: "present", d1: "present",
    });
    const previewPath = join(directory, "source-preview.json");
    const previewRun = await runDisposableRecoveryTeardownPreview({
      preparation,
      role: "source",
      receiptPath: previewPath,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => ({ invoke: async () => snapshot }),
    });
    const previewFile = readPrivateAggregateReceipt(previewPath);
    const changed = {
      ...preparation,
      targetEvalReceipt: { ...preparation.targetEvalReceipt, sha256: HASH("f") },
    };
    await assert.rejects(
      runDisposableRecoveryTeardownMutation({
        preparation: changed,
        role: "source",
        preview: previewRun.receipt,
        previewSha256: previewFile.sha256,
        approvalFingerprint: previewRun.approvalFingerprint,
        teardownWrapperPath: wrapper.path,
        receiptDirectory: directory,
        receiptPath: join(directory, "source-teardown.json"),
        absentPreviewPath: join(directory, "source-absent.json"),
        maintenanceWindow: MAINTENANCE_WINDOW,
        inspectWrapper: () => { providerCalls += 1; return wrapper; },
        inspectProvider: () => { providerCalls += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerCalls += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_TARGET_EVAL_RECEIPT_INVALID",
    );
    assert.equal(providerCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("teardown core requires a genuine K0 capability before provider access", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  for (const keychainProof of [
    Object.freeze({}),
    Object.freeze({ ...preparation.keychainProof }),
  ]) {
    let providerAccess = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation: { ...preparation, keychainProof },
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        inspectWrapper: () => { providerAccess += 1; return wrapper; },
        inspectProvider: () => { providerAccess += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerAccess += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_PREPARATION_INVALID",
    );
    assert.equal(providerAccess, 0);
  }
});

testWithMacosPrivateReceipt("teardown core refuses unrelated genuine K0 capabilities before provider access", async () => {
  const { provider, wrapper } = fakePins();
  for (const binding of [
    {
      candidate_sha: "c".repeat(40),
      candidate_tree_sha: "b".repeat(40),
      package_sha256: HASH("a"),
      field_receipt_sha256: HASH("b"),
      account_id: ACCOUNT,
    },
    {
      candidate_sha: "a".repeat(40),
      candidate_tree_sha: "b".repeat(40),
      package_sha256: HASH("a"),
      field_receipt_sha256: HASH("b"),
      account_id: "d".repeat(32),
    },
  ]) {
    const unrelated = await createTestDisposableRecoveryK0Capability(binding);
    const preparation = {
      ...fakePreparation(provider),
      keychainProof: unrelated.proof,
    };
    let providerAccess = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation,
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        now: () => new Date("2026-09-13T01:00:00.000Z"),
        inspectWrapper: () => { providerAccess += 1; return wrapper; },
        inspectProvider: () => { providerAccess += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerAccess += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_PREPARATION_INVALID",
    );
    assert.equal(providerAccess, 0);
  }
});

testWithMacosPrivateReceipt("async preparation and K0 revalidation failures stop before provider access", async () => {
  const { provider, wrapper } = fakePins();
  const valid = fakePreparation(provider);
  for (const [label, changes] of [
    ["preparation false", { revalidate: async () => false }],
    ["preparation reject", {
      revalidate: async () => { throw new Error("fixture local drift"); },
    }],
    ["K0 projection false", { revalidateKeychain: async () => false }],
    ["K0 projection reject", {
      revalidateKeychain: async () => { throw new Error("fixture K0 drift"); },
    }],
  ]) {
    let providerAccess = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation: { ...valid, ...changes },
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        now: () => new Date("2026-09-13T01:00:00.000Z"),
        inspectWrapper: () => { providerAccess += 1; return wrapper; },
        inspectProvider: () => { providerAccess += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerAccess += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_PREPARATION_CHANGED",
      label,
    );
    assert.equal(providerAccess, 0, label);
  }
});

testWithMacosPrivateReceipt("committed recovery awaits full async revalidation before recovery mutation", async () => {
  const directory = realpathSync(mkdtempSync(join(
    tmpdir(),
    "brain-v048-async-recovery-",
  )));
  chmodSync(directory, 0o700);
  try {
    const { provider, wrapper } = fakePins();
    const preparation = fakePreparation(provider);
    const receiptPath = join(directory, "source-preview.json");
    const input = {
      preparation,
      role: "source",
      receiptPath,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => ({
        invoke: async () => semanticSnapshot("source", {
          worker: "present", vectorize: "present", d1: "present",
        }),
      }),
      now: () => new Date("2026-09-13T01:30:00.000Z"),
    };
    const failure = new Error("fixture committed preview crash");
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        ...input,
        finalize: (reservation, receipt) => finalizePrivateAggregateReceipt(
          reservation,
          receipt,
          injectedFinalizationCrash("post_commit_pre_publish", failure),
        ),
      }),
      (error) => error === failure,
    );
    let preparationChecks = 0;
    let recoveryMutations = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        ...input,
        preparation: {
          ...preparation,
          revalidate: async () => {
            preparationChecks += 1;
            return preparationChecks < 5;
          },
        },
        resume: true,
        recover: async () => {
          recoveryMutations += 1;
          throw new Error("recovery must not run");
        },
      }),
      (error) => error.code === "TEARDOWN_PREPARATION_CHANGED",
    );
    assert.equal(preparationChecks, 5);
    assert.equal(recoveryMutations, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("a future-dated A12 is rejected before wrapper or provider access", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const futureValue = structuredClone(preparation.targetEvalReceipt.value);
  futureValue.completed_at = "2026-09-13T02:00:00.000Z";
  const futurePreparation = {
    ...preparation,
    targetEvalReceipt: {
      value: futureValue,
      sha256: sha256(Buffer.from(`${JSON.stringify(futureValue, null, 2)}\n`)),
    },
  };
  let providerAccess = 0;
  await assert.rejects(
    runDisposableRecoveryTeardownPreview({
      preparation: futurePreparation,
      role: "source",
      receiptPath: "/never/reached.json",
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      now: () => new Date("2026-09-13T01:00:00.000Z"),
      inspectWrapper: () => { providerAccess += 1; return wrapper; },
      inspectProvider: () => { providerAccess += 1; return provider; },
      createInvoker: () => ({
        invoke: async () => { providerAccess += 1; return {}; },
      }),
    }),
    (error) => error.code === "TEARDOWN_TARGET_EVAL_RECEIPT_INVALID",
  );
  assert.equal(providerAccess, 0);
});

testWithMacosPrivateReceipt("core rejects A12 state, deployment, active-version, and chronology drift", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const mutations = [
    (value) => { value.state_sha256 = HASH("f"); },
    (value) => { value.golden_sha256 = HASH("f"); },
    (value) => { value.active_worker_version_id = SOURCE_VERSION; },
    (value) => { value.state_deployment_receipt_sha256 = HASH("f"); },
    (value) => {
      value.deployment_completed_at = "2026-09-13T00:26:00.000Z";
    },
    (value) => { value.state_updated_at = "2026-09-13T00:31:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const a12Evidence = structuredClone(preparation.a12Evidence);
    mutate(a12Evidence);
    let providerAccess = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation: { ...preparation, a12Evidence },
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        now: () => new Date("2026-09-13T01:00:00.000Z"),
        inspectWrapper: () => { providerAccess += 1; return wrapper; },
        inspectProvider: () => { providerAccess += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerAccess += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_TARGET_EVAL_RECEIPT_INVALID",
    );
    assert.equal(providerAccess, 0);
  }
});

testWithMacosPrivateReceipt("target teardown requires the exact completed source receipt before provider access", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  let providerCalls = 0;
  await assert.rejects(
    runDisposableRecoveryTeardownPreview({
      preparation,
      role: "target",
      receiptPath: "/never/reached.json",
      teardownWrapperPath: wrapper.path,
      sourceTeardownReceipt: null,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => { providerCalls += 1; return wrapper; },
      inspectProvider: () => { providerCalls += 1; return provider; },
      createInvoker: () => ({
        invoke: async () => { providerCalls += 1; return {}; },
      }),
    }),
    (error) => error.code === "TEARDOWN_SOURCE_RECEIPT_INVALID",
  );
  assert.equal(providerCalls, 0);
});

testWithMacosPrivateReceipt("preview finalization recovers every commit boundary with exact validation", async () => {
  for (const stage of [
    "post_commit_pre_publish",
    "post_final_sync",
    "post_pending_removal",
    "post_commit_removal",
  ]) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `brain-v048-preview-${stage}-`)));
    chmodSync(directory, 0o700);
    try {
      const { provider, wrapper } = fakePins();
      const preparation = fakePreparation(provider);
      const receiptPath = join(directory, "source-preview.json");
      let providerCalls = 0;
      const input = {
        preparation,
        role: "source",
        receiptPath,
        teardownWrapperPath: wrapper.path,
        maintenanceWindow: MAINTENANCE_WINDOW,
        inspectWrapper: () => wrapper,
        inspectProvider: () => provider,
        createInvoker: () => ({
          invoke: async () => {
            providerCalls += 1;
            return semanticSnapshot("source", {
              worker: "present", vectorize: "present", d1: "present",
            });
          },
        }),
        now: () => new Date("2026-09-13T01:30:00.000Z"),
      };
      const failure = new Error(`synthetic_${stage}`);
      await assert.rejects(
        runDisposableRecoveryTeardownPreview({
          ...input,
          finalize: (reservation, receipt) => finalizePrivateAggregateReceipt(
            reservation,
            receipt,
            injectedFinalizationCrash(stage, failure),
          ),
        }),
        (error) => error === failure,
      );
      const automaticallyRecovered = await runDisposableRecoveryTeardownPreview(input);
      assert.equal(automaticallyRecovered.receipt.status,
        "ready_for_separate_approval");
      assert.equal(automaticallyRecovered.alreadyComplete, true,
        "a durable finalization commitment is safe to recover without another provider read");
      const completed = await runDisposableRecoveryTeardownPreview({
        ...input,
        resume: true,
      });
      assert.equal(completed.receipt.status, "ready_for_separate_approval");
      assert.equal(completed.approvalFingerprint,
        completed.receipt.approval_fingerprint);
      assert.equal(providerCalls, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

testWithMacosPrivateReceipt("target teardown persists exact source receipt binding and rejects substitution or chronology", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-target-order-")));
  chmodSync(directory, 0o700);
  try {
    const { provider, wrapper } = fakePins();
    const preparation = fakePreparation(provider);
    const sourceReceiptFixture = mintSourceTeardownReceiptCapability(preparation);
    const sourceReceipt = sourceReceiptFixture.capability;
    const states = { worker: "present", vectorize: "present", d1: "present" };
    let providerCalls = 0;
    const invoker = {
      invoke: async (request) => {
        providerCalls += 1;
        if (request.operation === "preview") {
          return semanticSnapshot("target", states);
        }
        if (request.operation === "delete") {
          states[request.kind] = "absent";
          return {
            schema_version: 1,
            operation: "delete",
            role: "target",
            kind: request.kind,
            expected_instance_fingerprint: request.expected_instance_fingerprint,
            accepted: true,
            response_status: 200,
            response_body_sha256: HASH("9"),
          };
        }
        return {
          schema_version: 1,
          operation: "reconcile",
          role: "target",
          kind: request.kind,
          expected_instance_fingerprint: request.expected_instance_fingerprint,
          exact_endpoint_status: 404,
          missing_code_sha256: request.kind === "worker"
            ? WORKER_MISSING_CODE_SHA256
            : HASH("8"),
          absence_authority: request.kind === "worker"
            ? "exact_id_404_code_10007"
            : "two_stable_exhaustive_account_inventories",
          absent: true,
          current_instance_fingerprint: null,
        };
      },
    };
    const previewPath = join(directory, "target-preview.json");
    const receiptPath = join(directory, "target-teardown.json");
    const absentPreviewPath = join(directory, "target-absent.json");
    const previewRun = await runDisposableRecoveryTeardownPreview({
      preparation,
      role: "target",
      receiptPath: previewPath,
      teardownWrapperPath: wrapper.path,
      sourceTeardownReceipt: sourceReceipt,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
      now: () => new Date("2026-09-13T02:00:00.000Z"),
    });
    assert.equal(previewRun.receipt.source_teardown_receipt_sha256,
      sourceReceipt.sha256);
    const previewFile = readPrivateAggregateReceipt(previewPath);
    const result = await runDisposableRecoveryTeardownMutation({
      preparation,
      role: "target",
      preview: previewRun.receipt,
      previewSha256: previewFile.sha256,
      approvalFingerprint: previewRun.approvalFingerprint,
      teardownWrapperPath: wrapper.path,
      receiptDirectory: directory,
      receiptPath,
      absentPreviewPath,
      sourceTeardownReceipt: sourceReceipt,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
      now: (() => {
        let second = 0;
        return () => new Date(`2026-09-13T02:01:${String(second++).padStart(2, "0")}.000Z`);
      })(),
    });
    assert.equal(result.receipt.source_teardown_receipt_sha256,
      sourceReceipt.sha256);
    assert.equal(result.receipt.target_eval_receipt_sha256,
      preparation.targetEvalReceipt.sha256);
    assertDisposableRecoveryBrainTeardownReceipt(result.receipt, {
      role: "target",
      expectedSourceTeardownReceiptSha256: sourceReceipt.sha256,
    });

    let rollbackProviderCalls = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownMutation({
        preparation,
        role: "target",
        preview: previewRun.receipt,
        previewSha256: previewFile.sha256,
        approvalFingerprint: previewRun.approvalFingerprint,
        teardownWrapperPath: wrapper.path,
        receiptDirectory: directory,
        receiptPath,
        absentPreviewPath,
        sourceTeardownReceipt: sourceReceipt,
        maintenanceWindow: MAINTENANCE_WINDOW,
        resume: true,
        now: () => new Date("2026-09-13T01:59:59.000Z"),
        inspectWrapper: () => { rollbackProviderCalls += 1; return wrapper; },
        inspectProvider: () => { rollbackProviderCalls += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { rollbackProviderCalls += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_CLOCK_INVALID",
    );
    assert.equal(rollbackProviderCalls, 0);

    const substituted = completedSourceTeardownReceipt(preparation, {
      startedAt: "2026-09-13T01:02:00.000Z",
      completedAt: "2026-09-13T01:03:00.000Z",
    });
    const callsBeforeSubstitution = providerCalls;
    await assert.rejects(
      runDisposableRecoveryTeardownMutation({
        preparation,
        role: "target",
        preview: previewRun.receipt,
        previewSha256: previewFile.sha256,
        approvalFingerprint: previewRun.approvalFingerprint,
        teardownWrapperPath: wrapper.path,
        receiptDirectory: directory,
        receiptPath,
        absentPreviewPath,
        sourceTeardownReceipt: substituted,
        maintenanceWindow: MAINTENANCE_WINDOW,
        resume: true,
        inspectWrapper: () => wrapper,
        inspectProvider: () => provider,
        createInvoker: () => invoker,
      }),
      (error) => error.code === "TEARDOWN_SOURCE_RECEIPT_INVALID",
    );
    assert.equal(providerCalls, callsBeforeSubstitution);

    const future = mintSourceTeardownReceiptCapability(preparation, {
      startedAt: "2026-09-13T03:00:00.000Z",
      completedAt: "2026-09-13T03:01:00.000Z",
    }).capability;
    let futureProviderCalls = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation,
        role: "target",
        receiptPath: join(directory, "future-target-preview.json"),
        teardownWrapperPath: wrapper.path,
        sourceTeardownReceipt: future,
        maintenanceWindow: MAINTENANCE_WINDOW,
        inspectWrapper: () => { futureProviderCalls += 1; return wrapper; },
        inspectProvider: () => { futureProviderCalls += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { futureProviderCalls += 1; return {}; },
        }),
        now: () => new Date("2026-09-13T02:00:00.000Z"),
      }),
      (error) => error.code === "TEARDOWN_SOURCE_RECEIPT_INVALID",
    );
    assert.equal(futureProviderCalls, 0);

    let beforeA12ProviderCalls = 0;
    assert.throws(
      () => mintSourceTeardownReceiptCapability(preparation, {
        startedAt: "2026-09-13T00:20:00.000Z",
        completedAt: "2026-09-13T00:25:00.000Z",
      }),
      (error) => error.code === "TEARDOWN_SOURCE_RECEIPT_INVALID",
    );
    assert.equal(beforeA12ProviderCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("broker persists planned and sent_unconfirmed before every ordered delete", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-teardown-core-")));
  chmodSync(directory, 0o700);
  try {
    const { provider, wrapper } = fakePins();
    const preparation = fakePreparation(provider);
    const states = { worker: "present", vectorize: "present", d1: "present" };
    const calls = [];
    const invoker = {
      invoke: async (request) => {
        calls.push(`${request.operation}:${request.kind ?? "all"}`);
        if (request.operation === "preview") return semanticSnapshot("source", states);
        if (request.operation === "delete") {
          states[request.kind] = "absent";
          return {
            schema_version: 1,
            operation: "delete",
            role: "source",
            kind: request.kind,
            expected_instance_fingerprint: request.expected_instance_fingerprint,
            accepted: true,
            response_status: 200,
            response_body_sha256: HASH("9"),
          };
        }
        return {
          schema_version: 1,
          operation: "reconcile",
          role: "source",
          kind: request.kind,
          expected_instance_fingerprint: request.expected_instance_fingerprint,
          exact_endpoint_status: 404,
          missing_code_sha256: request.kind === "worker"
            ? WORKER_MISSING_CODE_SHA256
            : HASH("8"),
          absence_authority: request.kind === "worker"
            ? "exact_id_404_code_10007"
            : "two_stable_exhaustive_account_inventories",
          absent: true,
          current_instance_fingerprint: null,
        };
      },
    };
    const previewPath = join(directory, "source-preview.json");
    const previewRun = await runDisposableRecoveryTeardownPreview({
      preparation,
      role: "source",
      receiptPath: previewPath,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
      now: () => new Date("2026-09-13T01:00:00.000Z"),
    });
    const previewFile = readPrivateAggregateReceipt(previewPath);
    assert.equal(previewFile.sha256,
      sha256(Buffer.from(`${JSON.stringify(previewRun.receipt, null, 2)}\n`)));

    const result = await runDisposableRecoveryTeardownMutation({
      preparation,
      role: "source",
      preview: previewRun.receipt,
      previewSha256: previewFile.sha256,
      approvalFingerprint: previewRun.approvalFingerprint,
      teardownWrapperPath: wrapper.path,
      receiptDirectory: directory,
      receiptPath: join(directory, "source-teardown.json"),
      absentPreviewPath: join(directory, "source-absent.json"),
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
      now: (() => {
        let second = 0;
        return () => new Date(`2026-09-13T01:00:${String(second++).padStart(2, "0")}.000Z`);
      })(),
    });
    assertDisposableRecoveryBrainTeardownReceipt(result.receipt, {
      role: "source",
    });
    assert.equal(result.receipt.target_eval_receipt_sha256,
      preparation.targetEvalReceipt.sha256);
    assert.equal(result.receipt.binding.target_eval_receipt_sha256,
      preparation.targetEvalReceipt.sha256);
    assert.deepEqual(result.receipt.actions.map((action) => action.kind),
      ["worker", "vectorize", "d1"]);
    assert.deepEqual(result.receipt.actions.map((action) => action.transitions), [
      ["planned", "sent_unconfirmed", "confirmed"],
      ["planned", "sent_unconfirmed", "confirmed"],
      ["planned", "sent_unconfirmed", "confirmed"],
    ]);
    assert.deepEqual(calls, [
      "preview:all",
      "preview:all",
      "delete:worker", "reconcile:worker",
      "delete:vectorize", "reconcile:vectorize",
      "delete:d1", "reconcile:d1",
      "preview:all",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("journal records recover every commit boundary without a second DELETE", async () => {
  for (const journalState of ["planned", "sent_unconfirmed", "confirmed"]) {
    for (const stage of [
      "post_commit_pre_publish",
      "post_final_sync",
      "post_pending_removal",
      "post_commit_removal",
    ]) {
      const directory = realpathSync(mkdtempSync(join(
        tmpdir(),
        `brain-v048-journal-${journalState}-${stage}-`,
      )));
      chmodSync(directory, 0o700);
      try {
        const { provider, wrapper } = fakePins();
        const preparation = fakePreparation(provider);
        const states = { worker: "present", vectorize: "present", d1: "present" };
        const deletes = { worker: 0, vectorize: 0, d1: 0 };
        const invoker = {
          invoke: async (request) => {
            if (request.operation === "preview") {
              return semanticSnapshot("source", states);
            }
            if (request.operation === "delete") {
              deletes[request.kind] += 1;
              states[request.kind] = "absent";
              return {
                schema_version: 1,
                operation: "delete",
                role: "source",
                kind: request.kind,
                expected_instance_fingerprint: request.expected_instance_fingerprint,
                accepted: true,
                response_status: 200,
                response_body_sha256: HASH("9"),
              };
            }
            const absent = states[request.kind] === "absent";
            return {
              schema_version: 1,
              operation: "reconcile",
              role: "source",
              kind: request.kind,
              expected_instance_fingerprint: request.expected_instance_fingerprint,
              exact_endpoint_status: absent ? 404 : 200,
              missing_code_sha256: absent
                ? request.kind === "worker"
                  ? WORKER_MISSING_CODE_SHA256
                  : HASH("8")
                : null,
              absence_authority: absent
                ? request.kind === "worker"
                  ? "exact_id_404_code_10007"
                  : "two_stable_exhaustive_account_inventories"
                : "present",
              absent,
              current_instance_fingerprint: absent
                ? null
                : previewRun.receipt.instance_fingerprints[request.kind],
            };
          },
        };
        const previewPath = join(directory, "source-preview.json");
        const previewRun = await runDisposableRecoveryTeardownPreview({
          preparation,
          role: "source",
          receiptPath: previewPath,
          teardownWrapperPath: wrapper.path,
          maintenanceWindow: MAINTENANCE_WINDOW,
          inspectWrapper: () => wrapper,
          inspectProvider: () => provider,
          createInvoker: () => invoker,
          now: () => new Date("2026-09-13T01:40:00.000Z"),
        });
        const previewFile = readPrivateAggregateReceipt(previewPath);
        const input = {
          preparation,
          role: "source",
          preview: previewRun.receipt,
          previewSha256: previewFile.sha256,
          approvalFingerprint: previewRun.approvalFingerprint,
          teardownWrapperPath: wrapper.path,
          receiptDirectory: directory,
          receiptPath: join(directory, "source-teardown.json"),
          absentPreviewPath: join(directory, "source-absent.json"),
          maintenanceWindow: MAINTENANCE_WINDOW,
          inspectWrapper: () => wrapper,
          inspectProvider: () => provider,
          createInvoker: () => invoker,
          now: (() => {
            let second = 0;
            return () => new Date(`2026-09-13T01:41:${String(second++).padStart(2, "0")}.000Z`);
          })(),
        };
        const failure = new Error(`synthetic_${journalState}_${stage}`);
        let injected = false;
        await assert.rejects(
          runDisposableRecoveryTeardownMutation({
            ...input,
            journalFinalizeOptions: ({ kind, state }) => {
              if (!injected && kind === "worker" && state === journalState) {
                injected = true;
                return injectedFinalizationCrash(stage, failure);
              }
              return undefined;
            },
          }),
          (error) => error === failure,
          `${journalState}:${stage}`,
        );
        assert.equal(injected, true);
        if (journalState === "sent_unconfirmed") {
          await assert.rejects(
            runDisposableRecoveryTeardownMutation({ ...input, resume: true }),
            (error) => error.code === "TEARDOWN_SENT_UNCONFIRMED_REMAINS_OPEN",
            `${journalState}:${stage}`,
          );
          assert.deepEqual(deletes, { worker: 0, vectorize: 0, d1: 0 },
            `${journalState}:${stage}`);
        } else {
          let completed;
          try {
            completed = await runDisposableRecoveryTeardownMutation({
              ...input,
              resume: true,
            });
          } catch (error) {
            error.message = `${error.message}:${journalState}:${stage}`;
            throw error;
          }
          assert.equal(completed.receipt.status, "passed");
          assert.deepEqual(deletes, { worker: 1, vectorize: 1, d1: 1 },
            `${journalState}:${stage}`);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

testWithMacosPrivateReceipt("broker never retries a sent-unconfirmed delete and can reconcile it on resume", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-teardown-resume-")));
  chmodSync(directory, 0o700);
  try {
    const { provider, wrapper } = fakePins();
    const preparation = fakePreparation(provider);
    const states = { worker: "present", vectorize: "present", d1: "present" };
    const deleteCounts = { worker: 0, vectorize: 0, d1: 0 };
    let keepWorkerPresent = true;
    const invoker = {
      invoke: async (request) => {
        if (request.operation === "preview") return semanticSnapshot("source", states);
        if (request.operation === "delete") {
          deleteCounts[request.kind] += 1;
          if (request.kind === "worker" && keepWorkerPresent) {
            throw new Error("lost response while still present");
          }
          states[request.kind] = "absent";
          return {};
        }
        const absent = states[request.kind] === "absent";
        return {
          schema_version: 1,
          operation: "reconcile",
          role: "source",
          kind: request.kind,
          expected_instance_fingerprint: request.expected_instance_fingerprint,
          exact_endpoint_status: absent ? 404 : 200,
          missing_code_sha256: absent
            ? request.kind === "worker"
              ? WORKER_MISSING_CODE_SHA256
              : HASH("8")
            : null,
          absence_authority: absent
            ? request.kind === "worker"
              ? "exact_id_404_code_10007"
              : "two_stable_exhaustive_account_inventories"
            : "present",
          absent,
          current_instance_fingerprint: absent
            ? null
            : request.expected_instance_fingerprint,
        };
      },
    };
    const previewPath = join(directory, "source-preview.json");
    const previewRun = await runDisposableRecoveryTeardownPreview({
      preparation,
      role: "source",
      receiptPath: previewPath,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
    });
    const previewFile = readPrivateAggregateReceipt(previewPath);
    const input = {
      preparation,
      role: "source",
      preview: previewRun.receipt,
      previewSha256: previewFile.sha256,
      approvalFingerprint: previewRun.approvalFingerprint,
      teardownWrapperPath: wrapper.path,
      receiptDirectory: directory,
      receiptPath: join(directory, "source-teardown.json"),
      absentPreviewPath: join(directory, "source-absent.json"),
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
    };
    await assert.rejects(
      runDisposableRecoveryTeardownMutation(input),
      (error) => error.code === "TEARDOWN_SENT_UNCONFIRMED_REMAINS_OPEN",
    );
    assert.equal(deleteCounts.worker, 1);
    keepWorkerPresent = false;
    states.worker = "absent";
    const resumed = await runDisposableRecoveryTeardownMutation({ ...input, resume: true });
    assert.equal(deleteCounts.worker, 1);
    assert.deepEqual(resumed.receipt.actions[0].transitions,
      ["planned", "sent_unconfirmed", "reconciled"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("resume closes the final receipt after a crash following durable absent preview", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-v048-teardown-absent-resume-")));
  chmodSync(directory, 0o700);
  try {
    const { provider, wrapper } = fakePins();
    const preparation = fakePreparation(provider);
    const states = { worker: "present", vectorize: "present", d1: "present" };
    const deletes = { worker: 0, vectorize: 0, d1: 0 };
    const invoker = {
      invoke: async (request) => {
        if (request.operation === "preview") return semanticSnapshot("source", states);
        if (request.operation === "delete") {
          deletes[request.kind] += 1;
          states[request.kind] = "absent";
          return {};
        }
        return {
          schema_version: 1,
          operation: "reconcile",
          role: "source",
          kind: request.kind,
          expected_instance_fingerprint: request.expected_instance_fingerprint,
          exact_endpoint_status: 404,
          missing_code_sha256: request.kind === "worker"
            ? WORKER_MISSING_CODE_SHA256
            : HASH("8"),
          absence_authority: request.kind === "worker"
            ? "exact_id_404_code_10007"
            : "two_stable_exhaustive_account_inventories",
          absent: true,
          current_instance_fingerprint: null,
        };
      },
    };
    const previewPath = join(directory, "source-preview.json");
    const previewRun = await runDisposableRecoveryTeardownPreview({
      preparation,
      role: "source",
      receiptPath: previewPath,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
    });
    const previewFile = readPrivateAggregateReceipt(previewPath);
    const receiptPath = join(directory, "source-teardown.json");
    const absentPreviewPath = join(directory, "source-absent.json");
    const input = {
      preparation,
      role: "source",
      preview: previewRun.receipt,
      previewSha256: previewFile.sha256,
      approvalFingerprint: previewRun.approvalFingerprint,
      teardownWrapperPath: wrapper.path,
      receiptDirectory: directory,
      receiptPath,
      absentPreviewPath,
      maintenanceWindow: MAINTENANCE_WINDOW,
      inspectWrapper: () => wrapper,
      inspectProvider: () => provider,
      createInvoker: () => invoker,
    };
    await assert.rejects(
      runDisposableRecoveryTeardownMutation({
        ...input,
        afterAbsentFinalized: () => { throw new Error("simulated crash"); },
      }),
      /simulated crash/u,
    );
    assert.equal(existsSync(absentPreviewPath), true);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(absentPreviewPath)), false);
    assert.equal(existsSync(privateAggregateReceiptPendingPath(receiptPath)), true);
    const completed = await runDisposableRecoveryTeardownMutation({
      ...input,
      resume: true,
    });
    assert.equal(completed.receipt.status, "passed");
    assert.deepEqual(deletes, { worker: 1, vectorize: 1, d1: 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testWithMacosPrivateReceipt("absent and final receipts recover every commit boundary without another DELETE", async () => {
  for (const artifact of ["absent", "final"]) {
    for (const stage of [
      "post_commit_pre_publish",
      "post_final_sync",
      "post_pending_removal",
      "post_commit_removal",
    ]) {
      const directory = realpathSync(mkdtempSync(join(
        tmpdir(),
        `brain-v048-${artifact}-${stage}-`,
      )));
      chmodSync(directory, 0o700);
      try {
        const { provider, wrapper } = fakePins();
        const preparation = fakePreparation(provider);
        const states = { worker: "present", vectorize: "present", d1: "present" };
        const deletes = { worker: 0, vectorize: 0, d1: 0 };
        const invoker = {
          invoke: async (request) => {
            if (request.operation === "preview") {
              return semanticSnapshot("source", states);
            }
            if (request.operation === "delete") {
              deletes[request.kind] += 1;
              states[request.kind] = "absent";
              return {
                schema_version: 1,
                operation: "delete",
                role: "source",
                kind: request.kind,
                expected_instance_fingerprint: request.expected_instance_fingerprint,
                accepted: true,
                response_status: 200,
                response_body_sha256: HASH("9"),
              };
            }
            return {
              schema_version: 1,
              operation: "reconcile",
              role: "source",
              kind: request.kind,
              expected_instance_fingerprint: request.expected_instance_fingerprint,
              exact_endpoint_status: 404,
              missing_code_sha256: request.kind === "worker"
                ? WORKER_MISSING_CODE_SHA256
                : HASH("8"),
              absence_authority: request.kind === "worker"
                ? "exact_id_404_code_10007"
                : "two_stable_exhaustive_account_inventories",
              absent: true,
              current_instance_fingerprint: null,
            };
          },
        };
        const previewPath = join(directory, "source-preview.json");
        const previewRun = await runDisposableRecoveryTeardownPreview({
          preparation,
          role: "source",
          receiptPath: previewPath,
          teardownWrapperPath: wrapper.path,
          maintenanceWindow: MAINTENANCE_WINDOW,
          inspectWrapper: () => wrapper,
          inspectProvider: () => provider,
          createInvoker: () => invoker,
          now: () => new Date("2026-09-13T04:00:00.000Z"),
        });
        const previewFile = readPrivateAggregateReceipt(previewPath);
        const input = {
          preparation,
          role: "source",
          preview: previewRun.receipt,
          previewSha256: previewFile.sha256,
          approvalFingerprint: previewRun.approvalFingerprint,
          teardownWrapperPath: wrapper.path,
          receiptDirectory: directory,
          receiptPath: join(directory, "source-teardown.json"),
          absentPreviewPath: join(directory, "source-absent.json"),
          maintenanceWindow: MAINTENANCE_WINDOW,
          inspectWrapper: () => wrapper,
          inspectProvider: () => provider,
          createInvoker: () => invoker,
          now: (() => {
            let second = 0;
            return () => new Date(`2026-09-13T04:01:${String(second++).padStart(2, "0")}.000Z`);
          })(),
        };
        const failure = new Error(`synthetic_${artifact}_${stage}`);
        await assert.rejects(
          runDisposableRecoveryTeardownMutation({
            ...input,
            ...(artifact === "absent"
              ? { absentFinalizeOptions: injectedFinalizationCrash(stage, failure) }
              : { finalFinalizeOptions: injectedFinalizationCrash(stage, failure) }),
          }),
          (error) => error === failure,
          `${artifact}:${stage}`,
        );
        const completed = await runDisposableRecoveryTeardownMutation({
          ...input,
          resume: true,
        });
        assert.equal(completed.receipt.status, "passed");
        assert.deepEqual(deletes, { worker: 1, vectorize: 1, d1: 1 },
          `${artifact}:${stage}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

testWithMacosPrivateReceipt("preview-file hash and plan fingerprint drift are rejected before mutation", async () => {
  const { provider, wrapper } = fakePins();
  const preparation = fakePreparation(provider);
  const snapshot = semanticSnapshot("source", {
    worker: "present",
    vectorize: "present",
    d1: "present",
  });
  const base = {
    schema_version: 1,
    kind: "v048_disposable_teardown_preview",
    role: "source",
    status: "ready_for_separate_approval",
    created_at: "2026-09-13T01:00:00.000Z",
    binding: {
      candidate_sha: preparation.binding.candidate_sha,
      candidate_tree_sha: preparation.binding.candidate_tree_sha,
      package_sha256: preparation.binding.package_sha256,
      field_receipt_sha256: preparation.binding.field_receipt_sha256,
      keychain_binding_sha256: preparation.binding.keychain_binding_sha256,
      campaign_fingerprint: preparation.binding.campaign_fingerprint,
      plan_fingerprint: preparation.binding.plan_fingerprint,
      resource_fingerprint: preparation.binding.source_resource_fingerprint,
      wrangler_wrapper_sha256: preparation.binding.wrangler_wrapper_sha256,
      provision_receipt_sha256:
        preparation.provisionArtifacts.source.receiptSha256,
      provision_manifest_sha256:
        preparation.provisionArtifacts.source.manifestSha256,
      target_eval_receipt_sha256: preparation.targetEvalReceipt.sha256,
    },
    teardown_wrapper_sha256: wrapper.sha256,
    teardown_provider_sha256: provider.sha256,
    teardown_token_locator: wrapper.tokenLocator,
    account_fingerprint: snapshot.account_fingerprint,
    target_fingerprint: snapshot.target_fingerprint,
    provider_snapshot_sha256: snapshot.snapshot_sha256,
    target_eval_receipt_sha256: preparation.targetEvalReceipt.sha256,
    source_teardown_receipt_sha256: null,
    maintenance_window: MAINTENANCE_WINDOW,
    maintenance_window_sha256: sha256(canonical(MAINTENANCE_WINDOW)),
    resources: snapshot.states,
    instance_fingerprints: snapshot.instance_fingerprints,
    custody: snapshot.custody,
  };
  const preview = { ...base, approval_fingerprint: sha256(canonical(base)) };
  assertDisposableRecoveryTeardownPreview(preview, { role: "source", preparation });
  await assert.rejects(
    runDisposableRecoveryTeardownMutation({
      preparation,
      role: "source",
      preview,
      previewSha256: HASH("9"),
      approvalFingerprint: preview.approval_fingerprint,
      teardownWrapperPath: wrapper.path,
      maintenanceWindow: MAINTENANCE_WINDOW,
    }),
    (error) => error.code === "TEARDOWN_APPROVAL_INVALID",
  );
  const changed = structuredClone(preview);
  changed.binding.plan_fingerprint = HASH("7");
  assert.throws(
    () => assertDisposableRecoveryTeardownPreview(changed, {
      role: "source",
      preparation,
    }),
    (error) => error.code === "TEARDOWN_PREVIEW_INVALID",
  );
});

test("wrapper contract carries the credential only over stdin and pins provider bytes", () => {
  const providerHash = HASH("a");
  const wrapper = [
    "#!/bin/sh",
    "set -eu",
    "exec 3<&0",
    'BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA="$(printf \'%s\' "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" | /usr/bin/shasum -a 256)" || exit 126',
    `[ "\${BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA%% *}" = '${providerHash}' ] || exit 126`,
    "unset BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA",
    '[ -n "${BRAIN_TEARDOWN_NODE:?}" ]',
    '[ -n "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" ]',
    `/usr/bin/security find-generic-password -a '${ACCOUNT}' -s '${DISPOSABLE_TEARDOWN_TOKEN_SERVICE}' -w | exec "\${BRAIN_TEARDOWN_NODE:?}" --input-type=module --eval "\${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" -- --campaign-teardown-provider-child 3<&3`,
    "",
  ].join("\n");
  const contract = validateDisposableTeardownWrapperProgram(wrapper, {
    accountId: ACCOUNT,
  });
  assert.equal(contract.providerSha256, providerHash);
  assert.deepEqual(contract.tokenLocator, teardownTokenLocator());
  assert.doesNotMatch(wrapper, /export CLOUDFLARE|API_TOKEN|Bearer/u);
});

test("wrapper validation refuses the wrong Keychain account or service", () => {
  const providerHash = HASH("a");
  const wrapperProgram = (accountId, service) => [
    "#!/bin/sh",
    "set -eu",
    "exec 3<&0",
    'BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA="$(printf \'%s\' "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" | /usr/bin/shasum -a 256)" || exit 126',
    `[ "\${BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA%% *}" = '${providerHash}' ] || exit 126`,
    "unset BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA",
    '[ -n "${BRAIN_TEARDOWN_NODE:?}" ]',
    '[ -n "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" ]',
    `/usr/bin/security find-generic-password -a '${accountId}' -s '${service}' -w | exec "\${BRAIN_TEARDOWN_NODE:?}" --input-type=module --eval "\${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" -- --campaign-teardown-provider-child 3<&3`,
    "",
  ].join("\n");
  assert.throws(
    () => validateDisposableTeardownWrapperProgram(
      wrapperProgram("f".repeat(32), DISPOSABLE_TEARDOWN_TOKEN_SERVICE),
      { accountId: ACCOUNT },
    ),
    (error) => error.code === "TEARDOWN_WRAPPER_UNSAFE",
  );
  assert.throws(
    () => validateDisposableTeardownWrapperProgram(
      wrapperProgram(ACCOUNT, "wrong-service"),
      { accountId: ACCOUNT },
    ),
    (error) => error.code === "TEARDOWN_WRAPPER_UNSAFE",
  );
});

testWithMacosPrivateReceipt("wrong wrapper locator refuses before provider access", async () => {
  const providerHash = HASH("a");
  const wrapperProgram = (accountId, service) => [
    "#!/bin/sh",
    "set -eu",
    "exec 3<&0",
    'BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA="$(printf \'%s\' "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" | /usr/bin/shasum -a 256)" || exit 126',
    `[ "\${BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA%% *}" = '${providerHash}' ] || exit 126`,
    "unset BRAIN_TEARDOWN_PROVIDER_ACTUAL_SHA",
    '[ -n "${BRAIN_TEARDOWN_NODE:?}" ]',
    '[ -n "${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" ]',
    `/usr/bin/security find-generic-password -a '${accountId}' -s '${service}' -w | exec "\${BRAIN_TEARDOWN_NODE:?}" --input-type=module --eval "\${BRAIN_TEARDOWN_PROVIDER_SOURCE:?}" -- --campaign-teardown-provider-child 3<&3`,
    "",
  ].join("\n");
  const provider = fakePins().provider;
  const preparation = fakePreparation(provider);
  for (const [accountId, service] of [
    ["f".repeat(32), DISPOSABLE_TEARDOWN_TOKEN_SERVICE],
    [ACCOUNT, "wrong-service"],
  ]) {
    let providerCalls = 0;
    await assert.rejects(
      runDisposableRecoveryTeardownPreview({
        preparation,
        role: "source",
        receiptPath: "/never/reached.json",
        teardownWrapperPath: "/fixture/wrong-wrapper",
        maintenanceWindow: MAINTENANCE_WINDOW,
        inspectWrapper: () => validateDisposableTeardownWrapperProgram(
          wrapperProgram(accountId, service),
          { accountId: ACCOUNT },
        ),
        inspectProvider: () => { providerCalls += 1; return provider; },
        createInvoker: () => ({
          invoke: async () => { providerCalls += 1; return {}; },
        }),
      }),
      (error) => error.code === "TEARDOWN_WRAPPER_UNSAFE",
    );
    assert.equal(providerCalls, 0);
  }
});

test("wrapper invocation has no credential, account selector, HOME, or arguments", async () => {
  const { provider, wrapper } = fakePins();
  let observed;
  const preview = semanticSnapshot("source", {
    worker: "present",
    vectorize: "present",
    d1: "present",
  });
  const invoker = createDisposableTeardownProviderInvoker({
    provider,
    wrapper,
    run: (call) => {
      observed = call;
      return {
        status: 0,
        signal: null,
        error: null,
        stdout: Buffer.from(JSON.stringify({
          schema_version: 1,
          ok: true,
          result: preview,
        })),
        stderr: Buffer.alloc(0),
      };
    },
  });
  await invoker.invoke(providerRequest("preview"));
  assert.deepEqual(Object.keys(observed.env).sort(), [
    "BRAIN_TEARDOWN_NODE",
    "BRAIN_TEARDOWN_PROVIDER_SOURCE",
    "LANG",
    "LC_ALL",
    "PATH",
  ]);
  assert.equal(Object.keys(observed).includes("args"), false);
  assert.equal(Object.values(observed.env).some((value) =>
    String(value).includes(TOKEN.toString("utf8"))), false);
});

function teardownCliArguments(command, extra = []) {
  return [
    command,
    "--candidate-sha", "a".repeat(40),
    "--field-receipt", "/private/field.json",
    "--package", "/private/brain-installer-0.4.8.tgz",
    "--plan", "/private/plan.json",
    "--state", "/private/state.json",
    "--golden", "/private/golden.json",
    "--receipt-directory", "/private/receipts",
    "--source-manifest", "/private/receipts/v048-disposable-source.manifest.json",
    "--target-manifest", "/private/receipts/v048-disposable-target.manifest.json",
    "--wrangler-wrapper", "/private/wrangler-wrapper",
    "--teardown-wrapper", "/private/teardown-wrapper",
    "--maintenance-window-confirmed",
    ...extra,
  ];
}

test("teardown CLI keeps approvals separate and has no credential option", () => {
  const source = parseDisposableRecoveryFieldTeardownArguments(
    teardownCliArguments("source-mutate", ["--approve-a14", HASH("a")]),
  );
  assert.equal(source.role, "source");
  assert.equal(source.approvalFingerprint, HASH("a"));
  assert.equal(source.resume, false);
  const previewResume = parseDisposableRecoveryFieldTeardownArguments(
    teardownCliArguments("source-preview", ["--resume"]),
  );
  assert.equal(previewResume.resume, true);
  assert.throws(
    () => parseDisposableRecoveryFieldTeardownArguments(
      teardownCliArguments("source-mutate", ["--approve-a16", HASH("a")]),
    ),
    (error) => error.code === "DISPOSABLE_TEARDOWN_CLI_OPTION_INVALID",
  );
  assert.throws(
    () => parseDisposableRecoveryFieldTeardownArguments([
      ...teardownCliArguments("source-preview"),
      "--api-token", "fixture-secret",
    ]),
    (error) => error.code === "DISPOSABLE_TEARDOWN_CLI_OPTION_INVALID",
  );
  assert.throws(
    () => parseDisposableRecoveryFieldTeardownArguments(
      teardownCliArguments("target-preview").filter((token) =>
        token !== "--maintenance-window-confirmed"),
    ),
    (error) => error.code === "DISPOSABLE_TEARDOWN_CLI_ARGUMENTS_INVALID",
  );
});

testWithMacosPrivateReceipt("teardown CLI cross-binds both provisioning receipts and returns aggregates only", async () => {
  const { provider } = fakePins();
  const k0 = CORE_TEST_K0;
  const fullPreparation = fakePreparation(provider, k0.proof);
  const {
    provisionArtifacts: expectedArtifacts,
    targetEvalReceipt: expectedTargetEval,
    ...basePreparation
  } = fullPreparation;
  const readCliReceipt = (path) => {
    if (basename(path) === DISPOSABLE_RECOVERY_FIELD_KEYCHAIN_PREP_RECEIPT_NAME) {
      return readPrivateAggregateReceipt(path);
    }
    return { value: {}, sha256: HASH("4") };
  };
  let runInput;
  let injectedVerifierCalls = 0;
  const parsed = parseDisposableRecoveryFieldTeardownArguments(
    teardownCliArguments("source-preview"),
  );
  assert.equal(parsed.statePath, "/private/state.json");
  assert.equal(parsed.goldenPath, "/private/golden.json");
  const result = await executeDisposableRecoveryFieldTeardown(parsed, {
    platform: "darwin",
    assertReceiptDirectory: () => ({ path: k0.directory }),
    loadPlan: () => GENUINE_A12.plan,
    inspectPreparation: ({ keychainProof }) => {
      assert.equal(
        assertDisposableRecoveryFieldKeychainVerificationCapability(
          keychainProof,
          k0.proof.keychain_binding_sha256,
        ).keychain_binding_sha256,
        k0.proof.keychain_binding_sha256,
      );
      return {
        ...basePreparation,
        binding: {
          ...basePreparation.binding,
          keychain_binding_sha256: k0.proof.keychain_binding_sha256,
        },
      };
    },
    readProvisionArtifacts: ({ role, receiptPath, manifestPath }) => {
      assert.equal(basename(receiptPath), `v048-disposable-${role}-provision.json`);
      assert.equal(basename(manifestPath), `v048-disposable-${role}.manifest.json`);
      return expectedArtifacts[role];
    },
    readA12Capability: () => GENUINE_A12.capability,
    createKeychain: () => ({
      inspect: k0.keychain.adapter.inspect,
      read: k0.keychain.adapter.read,
    }),
    verifyKeychainPrep: () => {
      injectedVerifierCalls += 1;
      return { ...k0.proof };
    },
    runPreview: async (input) => {
      runInput = input;
      return { approvalFingerprint: HASH("5") };
    },
    readReceipt: readCliReceipt,
  });
  assert.equal(injectedVerifierCalls, 0,
    "the production verifier is not replaceable through dependency injection");
  assert.equal(runInput.role, "source");
  assert.deepEqual(runInput.maintenanceWindow, MAINTENANCE_WINDOW);
  assert.equal(runInput.preparation.provisionArtifacts.source.workerId, SOURCE_WORKER_ID);
  assert.equal(runInput.preparation.provisionArtifacts.target.workerId, TARGET_WORKER_ID);
  assert.equal(runInput.preparation.provisionArtifacts.source.vectorizeCreatedOn,
    "2022-11-15T18:25:44.442097Z");
  assert.equal(runInput.preparation.targetEvalReceipt.sha256,
    expectedTargetEval.sha256);
  assert.deepEqual(result, {
    schema_version: 1,
    kind: "source-preview",
    action: "A13",
    status: "ready_for_separate_approval",
    cloudflare_access: "read_only",
    cloudflare_mutation: false,
    local_receipt_written: true,
    receipt_sha256: HASH("4"),
    a14_approval_fingerprint: HASH("5"),
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ACCOUNT), false);
  assert.equal(serialized.includes(SOURCE_WORKER_ID), false);
  assert.equal(serialized.includes(DISPOSABLE_TEARDOWN_NAMES.source), false);

  for (const [label, a12Capability] of [
    ["copied", { ...GENUINE_A12.capability }],
    ["forged", {
      ...GENUINE_A12.capability,
      state_sha256: HASH("f"),
    }],
  ]) {
    let a12RunCalls = 0;
    await assert.rejects(
      executeDisposableRecoveryFieldTeardown(parsed, {
        platform: "darwin",
        assertReceiptDirectory: () => ({ path: k0.directory }),
        loadPlan: () => GENUINE_A12.plan,
        inspectPreparation: ({ keychainProof }) => ({
          ...basePreparation,
          binding: {
            ...basePreparation.binding,
            keychain_binding_sha256: keychainProof.keychain_binding_sha256,
          },
        }),
        readProvisionArtifacts: ({ role }) => expectedArtifacts[role],
        readA12Capability: () => a12Capability,
        createKeychain: () => ({
          inspect: k0.keychain.adapter.inspect,
          read: k0.keychain.adapter.read,
        }),
        readReceipt: readCliReceipt,
        runPreview: async () => { a12RunCalls += 1; },
      }),
      (error) => error.code ===
        "DISPOSABLE_TEARDOWN_CLI_TARGET_EVAL_RECEIPT_INVALID",
      label,
    );
    assert.equal(a12RunCalls, 0, label);
  }
});

testWithMacosPrivateReceipt("production adapter rejects a copied K0 proof before other preparation", async () => {
  const k0 = await createTestDisposableRecoveryK0Capability({
    candidate_sha: "a".repeat(40),
    candidate_tree_sha: "b".repeat(40),
    package_sha256: HASH("a"),
    field_receipt_sha256: HASH("b"),
    account_id: ACCOUNT,
  });
  assert.throws(
    () => inspectDisposableRecoveryDeploymentPreparation({
      candidateSha: "a".repeat(40),
      fieldReceiptPath: "/does/not/exist",
      packagePath: "/does/not/exist",
      wranglerWrapperPath: "/does/not/exist",
      sourceManifestPath: "/does/not/exist",
      targetManifestPath: "/does/not/exist",
      keychainProof: { ...k0.proof },
      plan: {},
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_KEYCHAIN_BINDING_INVALID",
  );

  assert.throws(
    () => inspectDisposableRecoveryDeploymentPreparation({
      candidateSha: "a".repeat(40),
      fieldReceiptPath: "/does/not/exist",
      packagePath: "/does/not/exist",
      wranglerWrapperPath: "/does/not/exist",
      sourceManifestPath: "/does/not/exist",
      targetManifestPath: "/does/not/exist",
      keychainProof: k0.proof,
      plan: {},
    }),
    (error) => error.code !== "RECOVERY_FIELD_GATE_KEYCHAIN_BINDING_INVALID",
    "a genuine verifier-minted capability must reach the next production check",
  );
});
