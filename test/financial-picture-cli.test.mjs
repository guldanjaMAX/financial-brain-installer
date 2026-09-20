import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cmdFinancialPicture,
  runCliCommandWithCredentialBoundary,
  supportSourceForCommand,
} from "../brain.mjs";
import {
  FINANCIAL_PICTURE_SECTIONS,
  financialPictureRequestFromFlags,
  parseFinancialPictureArgv,
  parseFinancialPictureFlags,
  renderFinancialPicture,
  requestFinancialPicture,
} from "../operations/financial-picture.mjs";

const APPLIED_FILTERS = Object.freeze({
  entities: ["entity_slug"],
  periods: ["entity_slug", "tax_year", "period_start", "period_end"],
  accounts: ["entity_slug", "period_start", "period_end"],
  books: ["entity_slug", "tax_year", "period_start", "period_end"],
  payroll: ["entity_slug", "tax_year", "period_start", "period_end"],
  tax_returns: ["entity_slug", "tax_year", "period_start", "period_end"],
  filing_payments: ["entity_slug", "tax_year", "period_start", "period_end"],
  evidence: ["entity_slug", "tax_year", "period_start", "period_end"],
  conflicts: ["entity_slug", "period_start", "period_end"],
});

function unavailableSection(name, filters, baseline, requested) {
  return {
    state: "unavailable",
    unavailable: true,
    unavailable_reason: requested ? "database_read_failed" : "not_requested",
    unavailable_fields: [],
    provenance_state: requested ? "unavailable" : "not_requested",
    provenance_fields: [],
    verification_gap_summary: {
      count_scope: "unavailable",
      bounded_by_page_limit: true,
      covers_all_matching_records: null,
      examined: 0,
      affected: null,
      blocking: null,
      missing_fields: {},
      by_provenance_state: {},
      by_extraction_state: {},
      by_freshness_state: {},
      provenance_debt_since_baseline: {
        state: baseline && requested ? "insufficient_scope" : "not_requested",
        baseline_recorded_at: baseline && requested ? baseline.recorded_at : null,
        count_scope: "unavailable",
        count_unit: "provenance_record_occurrences",
        covers_all_matching_records: null,
        new_records: null,
        new_records_with_provenance_debt: null,
        unclassifiable_recorded_at: null,
        debt_reason_codes: {},
      },
      recovery_mode: "planning_only_no_ocr_reingest_or_write",
    },
    blocks_financial_verification: requested ? true : null,
    total: null,
    returned: 0,
    truncated: null,
    cursor: null,
    next_cursor: null,
    applied_filters: Object.fromEntries(
      APPLIED_FILTERS[name].map((key) => [key, filters[key]]),
    ),
    not_applicable_filters: [],
    real_world_completeness: "not_proven",
  };
}

async function rehashReceipt(receipt) {
  const snapshot = { ...receipt.snapshot };
  delete snapshot.content_sha256;
  const receiptWithoutHash = { ...receipt, snapshot };
  const bytes = new TextEncoder().encode(JSON.stringify(receiptWithoutHash));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    ...receiptWithoutHash,
    snapshot: { ...snapshot, content_sha256: contentSha256 },
  };
}

async function receiptFor(request = {}, { unavailableRequested = false } = {}) {
  void unavailableRequested;
  const sectionsRequested = request.sections
    ? [...request.sections]
    : [...FINANCIAL_PICTURE_SECTIONS];
  const filters = {
    entity_slug: request.filters?.entity_slug ?? null,
    tax_year: request.filters?.tax_year ?? null,
    period_start: request.filters?.period_start ?? null,
    period_end: request.filters?.period_end ?? null,
  };
  const baseline = request.provenance_baseline ?? null;
  const sections = Object.fromEntries(FINANCIAL_PICTURE_SECTIONS.map((name) => [
    name,
    unavailableSection(name, filters, baseline, sectionsRequested.includes(name)),
  ]));
  const provenanceDebtGate = baseline ? {
    state: "insufficient_scope",
    baseline_recorded_at: baseline.recorded_at,
    comparison: "durable_recorded_at_strictly_after_baseline",
    gate_scope: "requested_sections_with_available_record_registry",
    count_unit: "section_provenance_record_occurrences_may_overlap",
    sections_evaluated: [],
    sections_excluded_as_unavailable: [...sectionsRequested],
    scope_reason_codes: ["requested_sections_unavailable"],
    new_records: 0,
    new_records_with_provenance_debt: 0,
    unclassifiable_recorded_at: 0,
    debt_reason_codes: {},
    covers_all_evaluated_matching_records: false,
    real_world_completeness: "not_proven",
  } : {
    state: "not_requested",
    baseline_recorded_at: null,
    gate_scope: "requested_sections_with_available_record_registry",
    count_unit: "section_provenance_record_occurrences_may_overlap",
    real_world_completeness: "not_proven",
  };
  const envelope = {
    schema_version: 2,
    operation: "financial_picture.inventory",
    read_only: true,
    mutation_count: 0,
    completeness_verdict: "not_computed",
    correctness_verdict: "not_computed",
    tenant_scope: "authenticated_brain",
    filters,
    provenance_baseline: baseline,
    sections_requested: sectionsRequested,
    page_limit: request.limit ?? 100,
    request_cursor: request.cursor ?? null,
    pagination_snapshot_scope: "each response is one snapshot; compare snapshot receipts before combining pages",
    reference_token_contract: {
      scheme: "hmac_sha256_v2",
      key_scope: "per_brain_session_signing_secret",
      stability: "stable_within_one_brain_until_session_signing_key_rotation",
      pagination: "stable_across_page_receipts_from_the_same_brain_key",
      identifier_values_disclosed: false,
    },
    evidence_scope: "exact structured financial ledger and linked corpus custody metadata only",
    extraction_state_contract: {
      stored_states: ["native", "ocr", "ocr_partial", "unreadable"],
      unavailable_states: ["scan_only", "empty"],
      unavailable_reason: "rejected scan-only or empty documents have no durable financial evidence row in the current schema",
    },
    freshness_state_contract: {
      verdict: "not_computed",
      available_evidence: [
        "source_status", "source_last_ingest_at", "corpus_ingested_at_ms",
        "evidence_recorded_at", "expected_cadence", "source_coverage_dimensions",
        "latest_source_run_outcome_counts", "confirmed_and_target_source_ranges",
      ],
      unavailable_fields: ["freshness_applicability", "freshness_evaluation_policy"],
    },
    recovery_mode: "planning_only_no_ocr_reingest_or_write",
    sections,
    unavailable: true,
    sections_unavailable: [...sectionsRequested],
    provenance_debt_gate: provenanceDebtGate,
  };
  const snapshot = {
    captured_at: "2026-09-10T12:00:00.000Z",
    as_of: "2026-09-10T12:00:00.000Z",
    consistency: "single_d1_batch",
    database_version_ref: null,
    database_bookmark_state: "unavailable",
  };
  return rehashReceipt({ ...envelope, snapshot });
}

const RECEIPT = await receiptFor();

test("flags become one exact bounded inventory request", () => {
  const parsed = parseFinancialPictureFlags({
    json: true,
    entity: "orchard-cafe",
    year: "2024",
    "period-start": "2024-01-01",
    "period-end": "2024-12-31",
    sections: "accounts,books,tax_returns",
    limit: "75",
    "provenance-baseline": "2026-09-01T12:30:00Z",
  });
  assert.equal(parsed.json, true);
  assert.deepEqual(financialPictureRequestFromFlags(parsed), {
    sections: ["accounts", "books", "tax_returns"],
    filters: {
      entity_slug: "orchard-cafe",
      tax_year: 2024,
      period_start: "2024-01-01",
      period_end: "2024-12-31",
    },
    limit: 75,
    provenance_baseline: { recorded_at: "2026-09-01T12:30:00.000Z" },
  });
  const page = parseFinancialPictureFlags({ sections: "accounts", cursor: "cursor-fixture" });
  assert.equal(financialPictureRequestFromFlags(page).cursor, "cursor-fixture");
});

test("credential-shaped and unknown command arguments are refused", () => {
  assert.throws(() => parseFinancialPictureFlags({ "admin-key": "forbidden" }), /unknown option --admin-key/i);
  assert.throws(() => parseFinancialPictureFlags({ token: "forbidden" }), /unknown option --token/i);
  assert.throws(() => parseFinancialPictureFlags({ limit: "501" }), /between 1 and 500/i);
  assert.throws(() => parseFinancialPictureFlags({ json: "yes" }), /--json.*switch/i);
  assert.throws(() => parseFinancialPictureFlags({ sections: "accounts,unknown" }), /unknown section/i);
  assert.throws(() => parseFinancialPictureFlags({ "provenance-baseline": "yesterday" }), /snapshot\.as_of/i);

  const literal = "literal-admin-secret-must-not-be-echoed";
  assert.throws(() => parseFinancialPictureArgv([literal]), (error) => {
    assert.match(error.message, /never accepts a credential argument/i);
    assert.equal(error.message.includes(literal), false);
    return true;
  });
  assert.throws(() => parseFinancialPictureArgv([`--admin-key=${literal}`]), (error) => {
    assert.match(error.message, /--admin-key/i);
    assert.equal(error.message.includes(literal), false);
    return true;
  });
  assert.deepEqual(parseFinancialPictureArgv([
    "--json", "--entity", "orchard-cafe", "--sections", "accounts", "--limit", "25",
  ]), parseFinancialPictureFlags({
    json: true, entity: "orchard-cafe", sections: "accounts", limit: "25",
  }));
});

test("HTTPS is validated before durable credential resolution and the secret never enters URL or body", async () => {
  let credentialsRead = 0;
  let calls = 0;
  await assert.rejects(requestFinancialPicture({
    baseUrl: "http://brain.example.test",
    request: {},
    credential: () => { credentialsRead += 1; return "credential-fixture"; },
    fetchImpl: async () => { calls += 1; },
  }), /HTTPS.*loopback/i);
  assert.equal(credentialsRead, 0);
  assert.equal(calls, 0);

  let observed;
  const request = { sections: ["entities"], limit: 10 };
  const expectedReceipt = await receiptFor(request);
  const body = await requestFinancialPicture({
    baseUrl: "https://brain.example.test/",
    request,
    credential: () => { credentialsRead += 1; return "credential-fixture"; },
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify(expectedReceipt), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(body, expectedReceipt);
  assert.equal(observed.url, "https://brain.example.test/api/fin/financial-picture");
  assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.redirect, "error");
  assert.equal(new Headers(observed.init.headers).get("X-Admin-Key"), "credential-fixture");
  assert.equal(observed.url.includes("credential-fixture"), false);
  assert.equal(String(observed.init.body).includes("credential-fixture"), false);
});

test("the CLI refuses redirects, malformed success, and unsafe server detail", async () => {
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: {},
    credential: () => "credential-fixture",
    fetchImpl: async () => ({
      ok: true, status: 200, redirected: true,
      url: "https://brain.example.test/final",
      text: async () => JSON.stringify(RECEIPT),
    }),
  }), /redirected/i);

  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: {},
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response("private database exception", { status: 503 }),
  }), (error) => {
    assert.match(error.message, /HTTP 503/);
    assert.equal(error.message.includes("private database exception"), false);
    return true;
  });

  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: {},
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  }), /did not return a valid inventory receipt/i);

  const rawNestedField = structuredClone(await receiptFor());
  rawNestedField.sections.entities.verification_gap_summary.source_doc_uid =
    "gmail:provider-private-id";
  const rehashedRawNestedField = await rehashReceipt(rawNestedField);
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: {},
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(rehashedRawNestedField), { status: 200 }),
  }), /did not return a valid inventory receipt/i);

  const requested = { sections: ["entities"], limit: 10 };
  const wrongEcho = await receiptFor({ sections: ["accounts"], limit: 10 });
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: requested,
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(wrongEcho), { status: 200 }),
  }), /not request-bound/i);

  const tampered = await receiptFor(requested);
  tampered.page_limit = 11;
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: requested,
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(tampered), { status: 200 }),
  }), /not request-bound/i);

  const movedAsOf = await receiptFor(requested);
  movedAsOf.snapshot.captured_at = "2026-09-11T12:00:00.000Z";
  movedAsOf.snapshot.as_of = "2026-09-11T12:00:00.000Z";
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: requested,
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(movedAsOf), { status: 200 }),
  }), /not request-bound/i);

  const changedDatabaseVersion = await receiptFor(requested);
  changedDatabaseVersion.snapshot.database_bookmark_state = "available";
  changedDatabaseVersion.snapshot.database_version_ref = `database_snapshot_v2_${"b".repeat(64)}`;
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: requested,
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(changedDatabaseVersion), { status: 200 }),
  }), /not request-bound/i);

  const replayedLaterPage = await receiptFor({ ...requested, cursor: "later-page-cursor" });
  await assert.rejects(requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: requested,
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(replayedLaterPage), { status: 200 }),
  }), /not request-bound/i);

  const unavailablePageRequest = {
    sections: ["entities"], limit: 10, cursor: "requested-page-cursor",
  };
  const unavailablePage = await receiptFor(
    unavailablePageRequest,
    { unavailableRequested: true },
  );
  assert.deepEqual(await requestFinancialPicture({
    baseUrl: "https://brain.example.test",
    request: unavailablePageRequest,
    credential: () => "credential-fixture",
    fetchImpl: async () => new Response(JSON.stringify(unavailablePage), { status: 200 }),
  }), unavailablePage);
});

test("human rendering leads with read-only scope and never turns inventory into a verdict", () => {
  const rendered = renderFinancialPicture(RECEIPT);
  assert.match(rendered, /read-only/i);
  assert.match(rendered, /not a completeness or correctness verdict/i);
  assert.match(rendered, /entities.*Unavailable/i);
  assert.match(rendered, /payroll.*Unavailable/i);
  assert.equal(rendered.includes("credential-fixture"), false);
});

test("the public CLI command uses the manifest domain and protected resolver only", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-financial-picture-"));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "brain.example.test", worker_name: "fixture-brain" },
    }));
    let accountLookups = 0;
    let credentialReads = 0;
    let credentialOptions = null;
    let observed;
    const output = [];
    const expectedReceipt = await receiptFor({
      sections: ["entities"],
      filters: { entity_slug: null, tax_year: null, period_start: null, period_end: null },
      limit: 10,
    });
    const receipt = await cmdFinancialPicture(manifestPath, {
      flags: { json: true, sections: "entities", limit: "10" },
      resolveAccount: async () => { accountLookups += 1; throw new Error("must not run"); },
      resolveAdminKey: (path, keyOptions) => {
        assert.equal(path, manifestPath);
        credentialReads += 1;
        credentialOptions = keyOptions;
        return "credential-fixture";
      },
      fetchImpl: async (url, init) => {
        observed = { url, init };
        return new Response(JSON.stringify(expectedReceipt), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      write: (line) => output.push(line),
    });

    assert.deepEqual(receipt, expectedReceipt);
    assert.equal(accountLookups, 0);
    assert.equal(credentialReads, 1);
    assert.deepEqual(credentialOptions, { ignoreEnvironment: true });
    assert.equal(observed.url, "https://brain.example.test/api/fin/financial-picture");
    assert.equal(JSON.parse(observed.init.body).sections[0], "entities");
    assert.equal(String(observed.init.body).includes("credential-fixture"), false);
    assert.equal(output.length, 1);
    assert.equal(output[0].includes("credential-fixture"), false);
    assert.equal(JSON.parse(output[0]).mutation_count, 0);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("missing or invalid saved domains fail before every control-plane and credential path", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-financial-picture-domain-boundary-"));
  try {
    const cases = [
      { label: "missing", brain: { worker_name: "fixture-brain" }, code: "brain_domain_required" },
      { label: "HTTP", brain: { domain: "http://brain.example.test" }, code: "invalid_brain_address" },
      { label: "path", brain: { domain: "https://brain.example.test/private" }, code: "invalid_brain_address" },
      { label: "port", brain: { domain: "brain.example.test:443" }, code: "invalid_brain_address" },
      { label: "loopback", brain: { domain: "https://127.0.0.1" }, code: "invalid_brain_address" },
    ];
    for (const item of cases) {
      const manifestPath = join(sandbox, `${item.label}.manifest.json`);
      writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" }, brain: item.brain }));
      let accountLookups = 0;
      let baseLookups = 0;
      let credentialReads = 0;
      let fetches = 0;
      await assert.rejects(cmdFinancialPicture(manifestPath, {
        flags: { json: true },
        resolveAccount: async () => { accountLookups += 1; throw new Error("must not run"); },
        resolveBaseUrl: async () => { baseLookups += 1; throw new Error("must not run"); },
        resolveAdminKey: () => { credentialReads += 1; throw new Error("must not run"); },
        fetchImpl: async () => { fetches += 1; throw new Error("must not run"); },
      }), (error) => {
        assert.equal(error.payload?.error_code, item.code, item.label);
        assert.equal(error.payload?.read_only, true, item.label);
        assert.equal(error.payload?.mutation_count, 0, item.label);
        return true;
      });
      assert.deepEqual(
        { accountLookups, baseLookups, credentialReads, fetches },
        { accountLookups: 0, baseLookups: 0, credentialReads: 0, fetches: 0 },
        `${item.label} must stop before account, base, credential, or network access`,
      );
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the actual CLI dispatcher boundary keeps data-plane and local-only commands out of Wrangler", async () => {
  let wranglerSessionCalls = 0;
  let commandCalls = 0;
  const options = {
    withWranglerSession: async (run) => {
      wranglerSessionCalls += 1;
      return run();
    },
  };
  for (const command of [
    "sources",
    "financial-picture",
    "machine-continuity",
    "provenance-repair",
    "assistant-repair",
  ]) {
    assert.equal(await runCliCommandWithCredentialBoundary(command, () => {
      commandCalls += 1;
      return command;
    }, options), command);
  }
  assert.equal(wranglerSessionCalls, 0);
  assert.equal(commandCalls, 5);
  assert.equal(supportSourceForCommand("financial-picture"), "brain-data-plane");
  assert.notEqual(supportSourceForCommand("financial-picture"), "cloudflare");

  await runCliCommandWithCredentialBoundary("deploy", () => "control-plane", options);
  assert.equal(wranglerSessionCalls, 1, "control-plane commands retain the session wrapper");
});

test("--json failures are one sanitized machine-readable receipt", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-financial-picture-json-error-"));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "brain.example.test", worker_name: "fixture-brain" },
    }));
    await assert.rejects(cmdFinancialPicture(manifestPath, {
      flags: { json: true },
      resolveAdminKey: () => "credential-fixture",
      fetchImpl: async () => new Response("private database failure", { status: 503 }),
      write: () => assert.fail("a failed JSON command must not write a success receipt"),
    }), (error) => {
      assert.deepEqual(error.payload, {
        schema_version: 1,
        operation: "financial_picture.inventory",
        status: "error",
        error_code: "financial_picture_unavailable",
        read_only: true,
        mutation_count: 0,
        retry_safe: true,
      });
      assert.equal(error.message.includes("private database failure"), false);
      assert.equal(/\x1b\[/.test(error.message), false);
      return true;
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
