import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  cmdSources,
  collectSourceInventoryPages,
  runCliCommandWithCredentialBoundary,
} from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const RECOVERY_SNAPSHOT = `sha256:${"b".repeat(64)}`;
const AS_OF = "2026-09-10T12:00:00.000Z";
const OWNER_PROOF = "fixture-owner-proof";
const SAFE_GMAIL_FAILURE = Object.freeze({
  version: 1,
  operation_class: "gmail_message_read",
  http_status: 400,
  provider_reason: "failed_precondition",
  checkpoint_readback: "verified",
  checkpoint_done: 55,
  checkpoint_skipped: 3,
  cursor_preservation: "absent_preserved",
});

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const reasonCounts = () => ({
  no_stored_chunks: 0,
  blank_only_chunks: 0,
  ocr_partial_review: 0,
  provenance_receipt_unassessed: 0,
  extraction_method_missing: 0,
  text_reliability_missing: 0,
  source_record_id_missing: 0,
  derivation_lineage_missing: 0,
  lineage_contract_unrecognized: 0,
});

const recoverySummary = (overrides = {}) => ({
  status: "no_candidates",
  read_only: true,
  candidate_documents: 0,
  candidate_source_groups: 0,
  candidate_pages_at_max_size: 0,
  maximum_page_size: 250,
  priority: "none",
  blocking_signals: [],
  reason_counts: reasonCounts(),
  source_groups: [],
  ...overrides,
});

function sourceRow(name, overrides = {}) {
  return {
    source_id: name,
    name,
    kind: "drive",
    registered: true,
    zone: null,
    connector: { kind: "drive", provider: "google", provider_identity_status: "supported" },
    configuration: { status: "partial", missing_subfields: ["scope_receipt"] },
    storage: { physical_documents: 1, logical_documents: 1, chunks: 1, readable_documents: 1, unreadable_documents: 0 },
    readability: { status: "complete" },
    provenance: { status: "complete", missing_subfields: [] },
    recovery_plan: { status: "no_candidates", candidate_documents: 0 },
    receipt: { status: "ready" },
    last_failure: null,
    freshness: { state: "ok" },
    ...overrides,
  };
}

function inventoryPage({ source, cursor = null, truncated = false, row = null, total = 2 }) {
  return {
    contract_version: 2,
    kind: "source_inventory",
    complete: !truncated,
    total,
    returned: 1,
    truncated,
    cursor,
    as_of: AS_OF,
    snapshot: { id: SNAPSHOT, as_of: AS_OF, stable: true, total },
    sources: [row ?? sourceRow(source)],
    recovery_plan_summary: recoverySummary(),
    limitations: { entity_year_coverage: "not_available" },
  };
}

function recoveryPage() {
  const recordId = `hmac-sha256:${"c".repeat(64)}`;
  return {
    contract_version: 2,
    kind: "source_recovery_plan",
    complete: true,
    total: 1,
    returned: 1,
    truncated: false,
    cursor: null,
    as_of: AS_OF,
    snapshot: {
      id: RECOVERY_SNAPSHOT,
      as_of: AS_OF,
      stable: true,
      total: 1,
      basis: "corpus_mutation_receipt",
    },
    source_filter: "drive",
    recovery_plan_summary: recoverySummary({
      status: "review_needed",
      candidate_documents: 1,
      candidate_source_groups: 1,
      candidate_pages_at_max_size: 1,
      candidate_pages_at_requested_size: 1,
      priority: "high",
      blocking_signals: ["records_without_readable_text"],
      page: { limit: 25, returned: 1, truncated: false },
    }),
    candidates: [{
      record_id: recordId,
      locator: { kind: "opaque_document_digest", value: recordId, reversible: false },
      source_id: "drive",
      source_kind: "drive",
      registered: true,
      zone: null,
      ingested_at: AS_OF,
      text: { extraction_method: "native", content_state: "empty" },
      ocr: { likely_candidate: true },
      provenance: { status: "partial", missing_subfields: ["derivation_lineage"] },
      reasons: ["no_stored_chunks", "derivation_lineage_missing"],
      plan: { mode: "preview_only", suggested_next_step: "review_original_for_ocr" },
    }],
    limitations: { read_only: true, repair_performed: false, ocr_performed: false },
  };
}

function withManifest(run, domain = "brain.example.invalid") {
  const directory = mkdtempSync(join(tmpdir(), "brain-source-inventory-cli-"));
  const manifest = join(directory, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ brain: { domain } }));
  return Promise.resolve()
    .then(() => run(manifest))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

async function captureLogs(run) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    return { value: await run(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("source inventory CLI uses only the internal durable credential and collects one stable snapshot", async () => {
  await withManifest(async (manifest) => {
    let resolverCalls = 0;
    const bodies = [];
    const fetchImpl = async (url, init) => {
      assert.equal(url, "https://brain.example.invalid/api/admin/brain/sources");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("X-Admin-Key"), OWNER_PROOF);
      const body = JSON.parse(init.body);
      bodies.push(body);
      return new Response(JSON.stringify(body.cursor
        ? inventoryPage({ source: "beta", truncated: false })
        : inventoryPage({ source: "alpha", cursor: "opaque-next-page", truncated: true })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const { value, output } = await captureLogs(() => cmdSources(manifest, {
      flags: { json: true },
      fetchImpl,
      resolveAdminKey(path, options) {
        resolverCalls++;
        assert.equal(path, manifest);
        assert.deepEqual(options, { ignoreEnvironment: true });
        return OWNER_PROOF;
      },
    }));

    assert.equal(resolverCalls, 1);
    assert.deepEqual(bodies, [{ limit: 250 }, { limit: 250, cursor: "opaque-next-page" }]);
    assert.deepEqual(value.sources.map((source) => source.source_id), ["alpha", "beta"]);
    assert.equal(value.complete, true);
    assert.equal(value.returned, 2);
    assert.doesNotMatch(output, new RegExp(OWNER_PROOF));
    assert.equal(JSON.parse(output).snapshot.id, SNAPSHOT);
  });
});

test("source inventory CLI exposes only validated Gmail failure evidence in JSON and concise human output", async () => {
  const gmail = sourceRow("gmail", {
    kind: "gmail",
    connector: { kind: "gmail", provider: "google", provider_identity_status: "supported" },
    receipt: {
      status: "error",
      latest_run: { outcome: "failed", metrics_version: 1, docs_failed: 1 },
    },
    last_failure: SAFE_GMAIL_FAILURE,
    freshness: { state: "broken" },
  });
  const page = inventoryPage({ source: "gmail", row: gmail, truncated: false, total: 1 });

  await withManifest(async (manifest) => {
    const baseOptions = {
      resolveAdminKey() { return OWNER_PROOF; },
      fetchImpl: async () => new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    };
    const { value, output } = await captureLogs(() => cmdSources(manifest, {
      ...baseOptions,
      flags: {},
    }));
    assert.deepEqual(value.sources[0].last_failure, SAFE_GMAIL_FAILURE);
    assert.match(output, /last connector failure/);
    assert.match(output, /Gmail message read; HTTP 400; provider failed_precondition/);
    assert.match(output, /checkpoint 55 processed \/ 3 skipped; cursor absent and preserved/);
    assert.doesNotMatch(output, /provider_message|message-id|cursor-value|secret/i);

    const jsonResult = await captureLogs(() => cmdSources(manifest, {
      ...baseOptions,
      flags: { json: true },
    }));
    assert.deepEqual(JSON.parse(jsonResult.output).sources[0].last_failure, SAFE_GMAIL_FAILURE);
  });

  const privatePage = structuredClone(page);
  privatePage.sources[0].last_failure.provider_message =
    "SYNTHETIC_PRIVATE_PROVIDER_MESSAGE /private/message-id cursor-value secret";
  await assert.rejects(
    collectSourceInventoryPages(async () => new Response(JSON.stringify(privatePage), { status: 200 })),
    /invalid connector failure evidence/,
  );
});

test("source recovery CLI returns one bounded preview page with no control-plane ceremony", async () => {
  await withManifest(async (manifest) => {
    let resolverCalls = 0;
    let requestBody = null;
    const { value, output } = await captureLogs(() => cmdSources(manifest, {
      flags: { json: true, recovery: true, source: "drive", limit: "25" },
      resolveAdminKey(_path, options) {
        resolverCalls++;
        assert.deepEqual(options, { ignoreEnvironment: true });
        return OWNER_PROOF;
      },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        assert.equal(new Headers(init.headers).get("X-Admin-Key"), OWNER_PROOF);
        return new Response(JSON.stringify(recoveryPage()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }));
    assert.equal(resolverCalls, 1);
    assert.deepEqual(requestBody, { mode: "recovery", limit: 25, source: "drive" });
    assert.equal(value.kind, "source_recovery_plan");
    assert.equal(value.candidates[0].plan.mode, "preview_only");
    assert.doesNotMatch(output, new RegExp(OWNER_PROOF));
  });

  let sourceWrapperCalls = 0;
  let sourceRunCalls = 0;
  await runCliCommandWithCredentialBoundary("sources", async () => { sourceRunCalls++; }, {
    withWranglerSession: async () => { sourceWrapperCalls++; },
  });
  assert.equal(sourceRunCalls, 1);
  assert.equal(sourceWrapperCalls, 0, "sources must not touch Wrangler login or keyring state");

  let otherWrapperCalls = 0;
  await runCliCommandWithCredentialBoundary("status", async () => {}, {
    withWranglerSession: async (run) => { otherWrapperCalls++; return run(); },
  });
  assert.equal(otherWrapperCalls, 1, "the bypass must stay narrow to sources");
});

test("source CLI fails closed before network or credential reads and rejects private response fields", async () => {
  await withManifest(async (manifest) => {
    let resolverCalls = 0;
    let fetchCalls = 0;
    await assert.rejects(
      cmdSources(manifest, {
        flags: { json: true, "admin-key": "literal-value" },
        resolveAdminKey() { resolverCalls++; return OWNER_PROOF; },
        fetchImpl: async () => { fetchCalls++; return new Response(); },
      }),
      (error) => {
        const receipt = JSON.parse(error.message);
        return receipt.ok === false && receipt.error.code === "invalid_options";
      },
    );
    assert.equal(resolverCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  await withManifest(async (manifest) => {
    let fetchCalls = 0;
    await assert.rejects(
      cmdSources(manifest, {
        flags: { json: true },
        resolveAdminKey() { return null; },
        fetchImpl: async () => { fetchCalls++; return new Response(); },
      }),
      /owner_credential_missing/,
    );
    assert.equal(fetchCalls, 0);
  });

  await withManifest(async (manifest) => {
    let resolverCalls = 0;
    await assert.rejects(
      cmdSources(manifest, {
        flags: { json: true },
        resolveAdminKey() { resolverCalls++; return OWNER_PROOF; },
      }),
      /brain_domain_invalid/,
    );
    assert.equal(resolverCalls, 0, "unsafe destinations must fail before Keychain access");
  }, "http://brain.example.invalid");

  const privatePage = inventoryPage({ source: "alpha", truncated: false });
  privatePage.total = 1;
  privatePage.snapshot.total = 1;
  privatePage.sources[0].title = "must not cross boundary";
  await assert.rejects(
    collectSourceInventoryPages(async () => new Response(JSON.stringify(privatePage), { status: 200 })),
    /invalid source row|private/i,
  );
});

test("CLI help advertises the read-only inventory and recovery preview without an MCP change", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "brain.mjs"), "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const shownSources = escapeForRegExp(renderCliCommands("brain sources"));
  assert.match(result.stdout, new RegExp(`${shownSources}\\s+<manifest>.*read-only D1 source inventory`));
  assert.match(result.stdout, new RegExp(`${shownSources} <manifest> --json`));
  assert.match(result.stdout, /--json --recovery/);
  assert.match(result.stdout, /without Cloudflare sign-in or a control-plane/);
});
