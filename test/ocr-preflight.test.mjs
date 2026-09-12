import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cmdOcrPreflight,
  runCliCommandWithCredentialBoundary,
} from "../brain.mjs";
import { register } from "../ingest/extract.mjs";
import { estimateOcrCost } from "../ingest/ocr.mjs";
import { prepare } from "../ingest/run.mjs";
import { scanPdf, textPdf } from "./fixtures/scan-pdf.mjs";
import {
  assertOcrPreflightReceipt,
  ocrPreflightFailureReceipt,
  ocrPreflightPolicy,
  ocrPreflightReceipt,
  ocrPreflightWalkEvidence,
  parseOcrPreflightArgv,
  renderOcrPreflightReceipt,
} from "../operations/ocr-preflight.mjs";

const PRIVATE = Object.freeze({
  path: "Fixtures/Private/Northwind synthetic tax scan.pdf",
  title: "Northwind synthetic tax scan",
  content: "Private adjusted gross income is 9876543 credits.",
  error: "parser refused /Users/client/private/tax-return.pdf?access_token=never-print",
  hash: "c".repeat(64),
  credential: `sk-private-${"A7".repeat(20)}`,
});
const PLAN_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const CLI = fileURLToPath(new URL("../brain.mjs", import.meta.url));
const ISOLATE_SUPPORT_ROOT = new URL("./fixtures/isolate-support-root.mjs", import.meta.url).href;

const scan = (pages) => ({
  state: "scan_only_ocr_needed",
  format: "pdf",
  reason_code: "scan_only_ocr_needed",
  extraction_complete: false,
  page_count_state: pages === null ? "unavailable" : "authoritative",
  ...(pages === null ? {} : { page_count: pages, page_count_authoritative: true }),
  private_path: PRIVATE.path,
  raw_content: PRIVATE.content,
});

const native = () => ({
  state: "native_readable",
  format: "pdf",
  reason_code: "provenance_unassessed",
  page_count_state: "authoritative",
  page_count: 3,
  page_count_authoritative: true,
  title: PRIVATE.title,
});

const policy = (cap = 10) => ocrPreflightPolicy({
  safety: {
    daily_llm_spend_cap_usd: cap,
    ocr: { enabled: false, max_pages_per_document: 40 },
  },
});

function assertNoPrivateSurface(value) {
  const surface = typeof value === "string" ? value : JSON.stringify(value);
  for (const forbidden of Object.values(PRIVATE)) {
    assert.equal(surface.includes(forbidden), false, `private fixture escaped: ${forbidden}`);
  }
  assert.doesNotMatch(surface, /access_token|tax return|adjusted gross income/i);
}

function fixedEstimate(pages, { low = 1, high = 3 } = {}) {
  return {
    pages,
    usd_low: pages ? low : 0,
    usd_high: pages ? high : 0,
    minutes_low: pages ? 2 : 0,
    minutes_high: pages ? 6 : 0,
  };
}

function treeSnapshot(root) {
  const visit = (dir, prefix = "") => readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return [{ relative, kind: "directory" }, ...visit(full, relative)];
      const bytes = readFileSync(full);
      const mode = statSync(full).mode & 0o777;
      return [{ relative, kind: "file", mode, bytes: bytes.toString("base64") }];
    });
  return visit(root);
}

test("complete OCR preflight preserves authoritative scan pages and reuses the cost range", () => {
  const receipt = ocrPreflightReceipt({
    planFingerprint: PLAN_FINGERPRINT,
    observations: [scan(7), scan(51), native(), {
      state: "empty",
      format: "pdf",
      page_count_state: "unavailable",
      raw_error: PRIVATE.error,
    }],
    walkComplete: true,
    scopeItems: 0,
    policy: policy(2.5),
    estimateCost: estimateOcrCost,
  });

  assert.equal(assertOcrPreflightReceipt(receipt), receipt);
  assert.equal(receipt.status, "complete");
  assert.deepEqual(receipt.coverage, {
    filesystem_scope_complete: true,
    plan_complete: true,
    pdf_documents_observed: 4,
    pdf_documents_inspected: 4,
    pdf_documents_uninspectable: 0,
    scope_items_uninspectable: 0,
  });
  assert.deepEqual(receipt.affected_documents, {
    scan_only: 2,
    with_authoritative_page_count: 2,
    with_unknown_page_count: 0,
  });
  assert.deepEqual(receipt.pages, {
    affected_known: 58,
    cap_eligible_known: 47,
    excluded_by_document_cap_known: 11,
  });
  assert.deepEqual(receipt.estimate, {
    ...estimateOcrCost(47),
    basis: "all_cap_eligible_pages",
    complete: true,
    affordability: "within_cap",
  });
  assert.deepEqual(Object.values(receipt.actions), [false, false, false, false, false, false, false, false]);
  assertNoPrivateSurface(receipt);
  assertNoPrivateSurface(renderOcrPreflightReceipt(receipt));
  assert.throws(
    () => assertOcrPreflightReceipt({ ...receipt, title: PRIVATE.title }),
    /fields outside/,
  );
});

test("unknown pages and uninspectable documents stay typed and make a known estimate only a lower bound", () => {
  const receipt = ocrPreflightReceipt({
    planFingerprint: PLAN_FINGERPRINT,
    observations: [
      scan(8),
      scan(null),
      { state: "password_protected", format: "pdf", raw_error: PRIVATE.error },
      { state: "extraction_failed", format: "pdf", raw_error: PRIVATE.content },
      { state: "unavailable", format: "pdf", path: PRIVATE.path },
      { state: "unsupported", format: "pdf", title: PRIVATE.title },
      { state: "native_readable", format: "not-pdf", hash: PRIVATE.hash },
    ],
    walkComplete: false,
    scopeItems: 2,
    policy: policy(100),
    estimateCost: estimateOcrCost,
  });

  assert.equal(receipt.status, "incomplete");
  assert.equal(receipt.coverage.filesystem_scope_complete, false);
  assert.equal(receipt.coverage.pdf_documents_observed, 7);
  assert.equal(receipt.coverage.pdf_documents_inspected, 2);
  assert.equal(receipt.coverage.pdf_documents_uninspectable, 5);
  assert.deepEqual(receipt.unknown_or_uninspectable, {
    scan_only_page_count_unknown: 1,
    password_protected_documents: 1,
    unsupported_documents: 1,
    extraction_failed_documents: 1,
    unavailable_documents: 1,
    invalid_observation_documents: 1,
    scope_items: 2,
  });
  assert.equal(receipt.pages.cap_eligible_known, 8);
  assert.equal(receipt.estimate.basis, "known_cap_eligible_pages_lower_bound");
  assert.equal(receipt.estimate.pages, 8);
  assert.equal(receipt.estimate.complete, false);
  assert.equal(receipt.estimate.affordability, "unknown");
  assertNoPrivateSurface(receipt);
});

test("a complete zero is numeric while truncated zero remains unavailable", () => {
  const complete = ocrPreflightReceipt({
    planFingerprint: PLAN_FINGERPRINT,
    observations: [native()],
    walkComplete: true,
    scopeItems: 0,
    policy: policy(0),
    estimateCost: estimateOcrCost,
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.estimate.basis, "all_cap_eligible_pages");
  assert.equal(complete.estimate.pages, 0);
  assert.equal(complete.estimate.usd_high, 0);
  assert.equal(complete.estimate.affordability, "within_cap");

  const incomplete = ocrPreflightReceipt({
    planFingerprint: PLAN_FINGERPRINT,
    observations: [],
    walkComplete: false,
    scopeItems: 1,
    policy: policy(10),
    estimateCost: estimateOcrCost,
  });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.pages.cap_eligible_known, 0);
  assert.equal(incomplete.estimate.basis, "unavailable");
  assert.equal(incomplete.estimate.pages, null);
  assert.equal(incomplete.estimate.affordability, "unknown");
});

test("affordability is closed over the high estimate and never overclaims incomplete coverage", () => {
  const build = ({ cap, observations = [scan(1)], walkComplete = true, scopeItems = 0, range }) =>
    ocrPreflightReceipt({
      planFingerprint: PLAN_FINGERPRINT,
      observations,
      walkComplete,
      scopeItems,
      policy: policy(cap),
      estimateCost: (pages) => fixedEstimate(pages, range),
    });

  assert.equal(build({ cap: 0 }).estimate.affordability, "may_exceed_cap");
  assert.equal(build({ cap: 2 }).estimate.affordability, "may_exceed_cap",
    "a cap between the low and high estimate is not promised sufficient");
  assert.equal(build({ cap: 3 }).estimate.affordability, "within_cap");
  assert.equal(build({ cap: 100, observations: [scan(1), scan(null)] }).estimate.affordability, "unknown");
});

test("an absent daily cap stays explicitly unconfigured rather than receiving an invented value", () => {
  const noCapPolicy = ocrPreflightPolicy({ safety: { ocr: { enabled: false } } });
  assert.deepEqual(noCapPolicy, {
    ocr_enabled: false,
    max_pages_per_document: 40,
    daily_spend_cap_usd: null,
    daily_spend_cap_configured: false,
    daily_spend_cap_source: "not_configured",
  });
  const receipt = ocrPreflightReceipt({
    planFingerprint: PLAN_FINGERPRINT,
    observations: [scan(4)],
    walkComplete: true,
    scopeItems: 0,
    policy: noCapPolicy,
    estimateCost: estimateOcrCost,
  });
  assert.equal(receipt.coverage.filesystem_scope_complete, true);
  assert.equal(receipt.estimate.complete, true);
  assert.equal(receipt.coverage.plan_complete, false);
  assert.equal(receipt.status, "incomplete");
  assert.equal(receipt.estimate.affordability, "unknown");
});

test("walk evidence ignores adjudicated external junctions and strips private paths and errors", () => {
  const evidence = ocrPreflightWalkEvidence([
    {
      path: "node_modules",
      scope: "subtree",
      coverage_gap: false,
      adjudication: "preserve_external_subtree",
      reason: PRIVATE.error,
    },
    {
      path: "Clients/Private",
      scope: "subtree",
      coverage_gap: false,
      adjudication: "source_policy",
      reason: PRIVATE.content,
    },
    { path: PRIVATE.path, scope: "file", original_state: "unavailable", reason: PRIVATE.error },
    { path: "blank.pdf", scope: "file", original_state: "empty" },
    { path: "Unreadable folder", scope: "directory", reason: PRIVATE.error },
  ]);
  assert.equal(evidence.root_unavailable, false);
  assert.equal(evidence.scope_items, 1);
  assert.deepEqual(evidence.observations.map((item) => item.state), ["unavailable", "empty"]);
  assertNoPrivateSurface(evidence);

  const junctionOnly = ocrPreflightWalkEvidence([{
    path: "node_modules",
    scope: "subtree",
    coverage_gap: false,
    adjudication: "preserve_external_subtree",
  }]);
  const receipt = ocrPreflightReceipt({
    planFingerprint: PLAN_FINGERPRINT,
    observations: junctionOnly.observations,
    walkComplete: true,
    scopeItems: junctionOnly.scope_items,
    policy: policy(10),
    estimateCost: estimateOcrCost,
  });
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.estimate.pages, 0);
});

test("request, policy, and failure contracts fail closed without echoing input", () => {
  assert.deepEqual(parseOcrPreflightArgv(["--path", "/safe/folder", "--json"]), {
    path: "/safe/folder",
    json: true,
  });
  for (const args of [
    [],
    ["--json"],
    ["--path", "/safe/folder"],
    ["--path", "/safe/folder", "--json", "extra"],
    ["--path", PRIVATE.path, "--json", "--unknown"],
  ]) {
    assert.throws(() => parseOcrPreflightArgv(args), TypeError);
  }
  assert.throws(
    () => ocrPreflightPolicy({ safety: { daily_llm_spend_cap_usd: -1 } }),
    /finite non-negative/,
  );
  const failed = ocrPreflightFailureReceipt("SOURCE_UNAVAILABLE");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.code, "SOURCE_UNAVAILABLE");
  assert.equal(failed.coverage.pdf_documents_observed, null);
  assertNoPrivateSurface(failed);
  assert.throws(
    () => assertOcrPreflightReceipt({
      ...failed,
      failure: { code: "SOURCE_UNAVAILABLE", message: PRIVATE.error },
    }),
    /fields outside/,
  );
});

test("prepare retains the structured scan observation while its private skip stays separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-ocr-observation-"));
  const name = "private-record.ocrplanfixture";
  const full = join(root, name);
  try {
    writeFileSync(full, "synthetic local fixture");
    register(".ocrplanfixture", async () => ({
      text: null,
      error: PRIVATE.error,
      observation: {
        state: "scan_only_ocr_needed",
        format: "pdf",
        reason_code: "scan_only_ocr_needed",
        extraction_complete: false,
        page_count: 7,
        page_count_authoritative: true,
      },
    }), "synthetic scan observation");
    const result = await prepare({
      full,
      rel: name,
      name,
      size: statSync(full).size,
      sizeLimit: 1024,
    }, { sourceName: "ocr-preflight", ocr: null });
    assert.equal(result.skip.reason, PRIVATE.error);
    assert.deepEqual(result.observation, {
      state: "scan_only_ocr_needed",
      format: "pdf",
      reason_code: "scan_only_ocr_needed",
      extraction_complete: false,
      page_count_state: "authoritative",
      page_count: 7,
      page_count_authoritative: true,
    });
    assertNoPrivateSurface(result.observation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI path performs no OCR, credential, network, Brain, checkpoint, cursor, state, or filesystem write", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "brain-ocr-preflight-cli-"));
  const sourceRoot = join(fixture, "source");
  const manifestPath = join(fixture, "brain.manifest.json");
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, "private-scan.pdf"), PRIVATE.content);
  writeFileSync(join(sourceRoot, "notes.txt"), "ordinary non-PDF fixture");
  writeFileSync(manifestPath, JSON.stringify({
    client: { display_name: PRIVATE.title },
    safety: {
      private_path_prefixes: ["Never Read"],
      daily_llm_spend_cap_usd: 0.01,
      ocr: { enabled: true, max_pages_per_document: 12 },
    },
  }) + "\n", { mode: 0o600 });
  const before = treeSnapshot(fixture);
  let output = "";
  let prepareCalls = 0;
  let forbiddenBoundaryCalls = 0;
  try {
    const receipt = await cmdOcrPreflight(manifestPath, {
      flags: { path: sourceRoot, json: true },
      write: (value) => { output += value; },
      resolveAdminKey: () => { forbiddenBoundaryCalls++; throw new Error(PRIVATE.credential); },
      fetchImpl: async () => { forbiddenBoundaryCalls++; throw new Error(PRIVATE.error); },
      saveState: () => { forbiddenBoundaryCalls++; throw new Error(PRIVATE.path); },
      ingestLib: async () => ({
        walk(root, { privatePrefixes }) {
          assert.equal(root, sourceRoot);
          assert.deepEqual(privatePrefixes, ["Never Read"]);
          return {
            complete: true,
            files: [
              { name: "private-scan.pdf", full: join(sourceRoot, "private-scan.pdf") },
              { name: "notes.txt", full: join(sourceRoot, "notes.txt") },
            ],
            skipped: [],
          };
        },
        async prepare(file, options) {
          prepareCalls++;
          assert.equal(file.name, "private-scan.pdf");
          assert.equal(options.ocr, null);
          assert.equal(options.sourceName, "ocr-preflight");
          return { observation: scan(20), skip: { path: PRIVATE.path, reason: PRIVATE.error } };
        },
      }),
      ocrLib: async () => ({ estimateOcrCost }),
    });
    assert.equal(prepareCalls, 1);
    assert.equal(forbiddenBoundaryCalls, 0);
    assert.equal(receipt.actions.ocr_performed, false);
    assert.equal(receipt.actions.checkpoint_write_performed, false);
    assert.equal(receipt.actions.cursor_write_performed, false);
    assert.equal(receipt.actions.ingest_state_write_performed, false);
    assert.equal(receipt.pages.affected_known, 20);
    assert.equal(receipt.pages.cap_eligible_known, 12);
    assert.deepEqual(JSON.parse(output), receipt);
    assert.equal(output.endsWith("\n"), true);
    assertNoPrivateSurface(output);
    assert.deepEqual(treeSnapshot(fixture), before, "read-only CLI left every fixture byte and mode unchanged");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("real synthetic scanned PDFs produce authoritative pages without OCR or filesystem mutation", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "brain-ocr-preflight-real-"));
  const sourceRoot = join(fixture, "source");
  const manifestPath = join(fixture, "brain.manifest.json");
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, "synthetic-scan.pdf"), scanPdf({ pages: 3 }));
  writeFileSync(join(sourceRoot, "synthetic-text.pdf"), textPdf(
    "This synthetic PDF has a real text layer and never needs OCR for extraction.",
  ));
  writeFileSync(manifestPath, JSON.stringify({
    safety: {
      daily_llm_spend_cap_usd: 10,
      ocr: { enabled: true, max_pages_per_document: 2 },
    },
  }) + "\n", { mode: 0o600 });
  const before = treeSnapshot(fixture);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let output = "";
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("OCR preflight attempted network access");
  };
  try {
    const receipt = await cmdOcrPreflight(manifestPath, {
      flags: { path: sourceRoot, json: true },
      write: (value) => { output += value; },
    });
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.coverage.pdf_documents_observed, 2);
    assert.equal(receipt.affected_documents.scan_only, 1);
    assert.equal(receipt.affected_documents.with_authoritative_page_count, 1);
    assert.deepEqual(receipt.pages, {
      affected_known: 3,
      cap_eligible_known: 2,
      excluded_by_document_cap_known: 1,
    });
    assert.equal(receipt.actions.ocr_performed, false);
    assert.equal(networkCalls, 0);
    assert.deepEqual(JSON.parse(output), receipt);
    assert.deepEqual(treeSnapshot(fixture), before);
    assert.equal(readdirSync(sourceRoot).some((name) => name.startsWith(".brain-ingest-")), false);

    const firstFingerprint = receipt.plan_fingerprint;
    assert.match(firstFingerprint, /^sha256:[a-f0-9]{64}$/);
    writeFileSync(join(sourceRoot, "synthetic-scan.pdf"), scanPdf({ pages: 4 }));
    const beforeChangedPlan = treeSnapshot(fixture);
    output = "";
    const changed = await cmdOcrPreflight(manifestPath, {
      flags: { path: sourceRoot, json: true },
      write: (value) => { output += value; },
    });
    assert.notEqual(changed.plan_fingerprint, firstFingerprint,
      "changing the private source bytes invalidates the prior plan fingerprint");
    assert.equal(changed.pages.affected_known, 4);
    assert.deepEqual(treeSnapshot(fixture), beforeChangedPlan);
    assertNoPrivateSurface(output);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installed CLI emits only JSON and its failure path creates no support journal", () => {
  const fixture = mkdtempSync(join(tmpdir(), "brain-ocr-preflight-installed-"));
  const sourceRoot = join(fixture, "source-private-fixture");
  const manifestPath = join(fixture, "brain.manifest.json");
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, "Northwind private synthetic scan.pdf"), scanPdf({ pages: 2 }));
  writeFileSync(manifestPath, JSON.stringify({
    safety: {
      daily_llm_spend_cap_usd: 10,
      ocr: { enabled: false, max_pages_per_document: 40 },
    },
  }) + "\n", { mode: 0o600 });
  const env = {
    PATH: process.env.PATH || "",
    BRAIN_TEST_USER_ROOT: fixture,
    NODE_NO_WARNINGS: "1",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
  };
  const run = (...extra) => spawnSync(process.execPath, [
    "--import",
    ISOLATE_SUPPORT_ROOT,
    CLI,
    "ocr-preflight",
    manifestPath,
    "--path",
    sourceRoot,
    "--json",
    ...extra,
  ], {
    cwd: fixture,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  try {
    const before = treeSnapshot(fixture);
    const result = run();
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.affected_documents.scan_only, 1);
    assert.equal(receipt.pages.affected_known, 2);
    assertNoPrivateSurface(result.stdout);
    assert.deepEqual(treeSnapshot(fixture), before);

    const failed = run("--unexpected-private-flag");
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr, "");
    const failureReceipt = JSON.parse(failed.stdout);
    assert.equal(failureReceipt.status, "failed");
    assert.equal(failureReceipt.failure.code, "INVALID_REQUEST");
    assertNoPrivateSurface(failed.stdout);
    assert.deepEqual(treeSnapshot(fixture), before,
      "JsonFatal failure bypassed the local support journal and every other write");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("OCR preflight is exempt from the process-wide Wrangler credential session", async () => {
  let wrapperCalls = 0;
  const value = await runCliCommandWithCredentialBoundary("ocr-preflight", async () => "safe", {
    withWranglerSession: async () => {
      wrapperCalls++;
      throw new Error("must not inspect a Wrangler credential");
    },
  });
  assert.equal(value, "safe");
  assert.equal(wrapperCalls, 0);
});
