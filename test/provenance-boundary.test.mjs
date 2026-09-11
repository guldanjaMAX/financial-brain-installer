import assert from "node:assert/strict";

import worker from "../worker/src/index.js";
import { splitOversized } from "../ingest/envelope-batching.mjs";
import { prepareBankExportImport } from "../worker/src/lib/fin-import.js";
import { handleBankExportImport } from "../worker/src/lib/fin-upload.js";
import { ingestEnvelopeValidationError } from "../worker/src/lib/ingest-envelope.js";
import { publicInstallSmokeEnvelope } from "../worker/src/lib/install-smoke.js";
import {
  normalizeIngestEnvelopeProvenance,
  provenanceReceiptTransitionError,
  provenanceReceiptValidationError,
  storedProvenanceAssessment,
  withFirstPartySourceProvenance,
} from "../worker/src/lib/provenance-receipt.js";
import { providerEnvelope } from "../worker/src/lib/provider-sync.js";
import { normalizeProviderResult } from "../connectors/provider-runtime.mjs";
import { storeFor } from "../worker/src/lib/store.js";
import { buildZoomEnvelope, gatedIngest } from "../worker/src/lib/zoom.js";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const doc = (extra = {}) => ({
  source_type: "drive",
  source_id: "file-1",
  content: "ordinary fixture text",
  ...extra,
});

// Shared ingress remains backward compatible, but omission is represented as
// unavailable instead of being silently promoted to native/reliable.
{
  const normalized = normalizeIngestEnvelopeProvenance(doc());
  assert.equal(normalized.text_source, "unknown");
  assert.equal(normalized.text_reliable, false);
  assert.deepEqual(normalized.metadata.provenance_receipt, {
    version: 1,
    status: "unavailable",
    reason: "provenance_unavailable",
    root_ids: ["drive:file-1"],
  });
  assert.equal(ingestEnvelopeValidationError(normalized), null);

  const malformed = normalizeIngestEnvelopeProvenance(doc({
    metadata: {
      provenance_receipt: {
        version: 1,
        status: "complete",
        reason: "lineage_and_text_recorded",
        root_ids: ["drive:someone-else"],
      },
    },
  }));
  assert.match(provenanceReceiptValidationError(malformed), /recorded document family/);
}

// A direct first-party connector can state only facts it controls and receives
// a complete receipt. This is the shape shared by local, mail and providers.
{
  const known = withFirstPartySourceProvenance(doc(), {
    textSource: "native",
    textReliable: true,
  });
  assert.deepEqual(known.metadata.evidence_lineage, {
    version: 1,
    kind: "source_record",
    root_ids: ["drive:file-1"],
  });
  assert.equal(known.metadata.provenance_receipt.status, "complete");
  assert.equal(ingestEnvelopeValidationError(known), null);

  const partialOcr = withFirstPartySourceProvenance(doc({ source_id: "scan-1" }), {
    textSource: "ocr_partial",
    textReliable: false,
  });
  assert.equal(partialOcr.metadata.provenance_receipt.status, "complete",
    "complete means the lineage and text-origin fields are recorded, not that extraction quality is complete");
  assert.equal(partialOcr.text_reliable, false);

  const provider = providerEnvelope("slack", "message-1", { content: "provider fixture" });
  assert.equal(provider.metadata.provenance_receipt.status, "complete");
  assert.deepEqual(provider.metadata.provenance_receipt.root_ids, ["slack:message-1"]);
  const providerScan = providerEnvelope("dropbox", "scan-1", {
    content: "provider OCR fixture",
    textSource: "ocr_partial",
    textReliable: false,
  });
  assert.equal(providerScan.text_source, "ocr_partial");
  assert.equal(providerScan.text_reliable, false);
  assert.equal(providerScan.metadata.provenance_receipt.status, "complete");

  const omittedProviderAssessment = normalizeProviderResult("fixture-provider", {
    documents: [{
      source_type: "adapter-private-name",
      source_id: "unassessed-1",
      content: "provider fixture with no extraction assessment",
      metadata: {},
    }],
    deletions: [],
    outcome: { kind: "completed" },
  }).documents[0];
  assert.equal(omittedProviderAssessment.text_source, "unknown");
  assert.equal(omittedProviderAssessment.text_reliable, false);
  assert.equal(omittedProviderAssessment.metadata.provenance_receipt.status, "partial");
  assert.equal(omittedProviderAssessment.metadata.provenance_receipt.reason, "text_provenance_unavailable");
}

// Root identity is established before physical part ids are introduced.
{
  const parts = splitOversized(doc({ content: "x".repeat(90) }), 30);
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((part) => part.metadata.provenance_receipt.root_ids),
    [["drive:file-1"], ["drive:file-1"], ["drive:file-1"]],
  );
  assert.ok(parts.every((part) => ingestEnvelopeValidationError(part) === null));
}

// A derived summary keeps its recorded roots, and an accepted reingest cannot
// drift to another family or weaken an already stronger assessment.
{
  const summary = normalizeIngestEnvelopeProvenance({
    source_type: "owner-notes",
    source_id: "summary-1",
    content: "derived fixture",
    metadata: {
      evidence_lineage: { version: 1, kind: "derived_record", root_ids: ["drive:file-1"] },
    },
  });
  assert.equal(summary.metadata.provenance_receipt.status, "partial");
  assert.deepEqual(summary.metadata.provenance_receipt.root_ids, ["drive:file-1"]);
  const summaryParts = splitOversized({ ...summary, content: "s".repeat(90) }, 30);
  assert.deepEqual(
    summaryParts.map((part) => part.metadata.provenance_receipt.root_ids),
    [["drive:file-1"], ["drive:file-1"], ["drive:file-1"]],
  );
  assert.ok(summaryParts.every((part) => ingestEnvelopeValidationError(part) === null));

  const complete = withFirstPartySourceProvenance(doc(), {
    textSource: "native", textReliable: true,
  }).metadata;
  const unavailable = normalizeIngestEnvelopeProvenance(doc()).metadata;
  assert.match(provenanceReceiptTransitionError(complete, unavailable, {
    priorProvenanceAssessed: true,
  }), /downgrade/);
  const weakerSameText = withFirstPartySourceProvenance(doc(), {
    textSource: "ocr_partial", textReliable: false,
  });
  assert.match(provenanceReceiptTransitionError(complete, weakerSameText.metadata, {
    priorTextSource: "native",
    priorTextReliable: true,
    incomingTextSource: weakerSameText.text_source,
    incomingTextReliable: weakerSameText.text_reliable,
    sameContent: true,
    priorProvenanceAssessed: true,
  }), /text-source fidelity/);
  assert.match(provenanceReceiptTransitionError(complete, weakerSameText.metadata, {
    priorTextSource: "native",
    priorTextReliable: true,
    incomingTextSource: weakerSameText.text_source,
    incomingTextReliable: weakerSameText.text_reliable,
    sameContent: false,
    priorProvenanceAssessed: true,
  }), /text-source fidelity/, "chunk-geometry or content changes cannot bypass extraction no-downgrade");
  const moved = structuredClone(complete);
  moved.provenance_receipt.root_ids = ["drive:file-2"];
  assert.match(provenanceReceiptTransitionError(complete, moved, {
    priorProvenanceAssessed: true,
  }), /change.*family/);

  const migrationDefault = { provenance_receipt: {
    version: 1,
    status: "complete",
    reason: "lineage_and_text_recorded",
    root_ids: ["drive:file-1"],
  } };
  assert.equal(provenanceReceiptTransitionError(migrationDefault, unavailable, {
    priorTextSource: "native",
    priorTextReliable: true,
    incomingTextSource: "unknown",
    incomingTextReliable: false,
    priorProvenanceAssessed: false,
  }), null, "a caller must validate the prior persisted row before transition protection applies");
}

// Migration 0020's native/1 defaults are not extraction proof. A receipt must
// validate against the same stored row before any read or transition trusts it.
{
  const legacy = storedProvenanceAssessment({
    source: "drive",
    source_id: "legacy-1",
    doc_uid: "drive:legacy-1",
    text_source: "native",
    text_reliable: 1,
    authority_meta: "{}",
  });
  assert.equal(legacy.provenance_assessed, false);
  assert.equal(legacy.text_source, "unknown");
  assert.equal(legacy.text_reliable, false);
  assert.equal(legacy.provenance_reason, "provenance_receipt_missing_or_invalid");
}

// Zoom's former direct-store door now creates and validates the same receipt,
// and refuses invalid provenance before touching a D1 binding.
{
  const zoom = buildZoomEnvelope({ uuid: "meeting-1", transcript: "Speaker: fixture" });
  assert.equal(zoom.metadata.provenance_receipt.status, "complete");
  assert.deepEqual(zoom.metadata.provenance_receipt.root_ids, ["zoom:meeting-1"]);

  let touched = false;
  const refused = await gatedIngest({
    STORAGE: "d1",
    DB: { prepare() { touched = true; throw new Error("store reached"); } },
  }, { ...zoom, text_source: "fabricated" });
  assert.equal(refused.refused, true);
  assert.deepEqual(refused.labels, ["invalid_ingest_provenance"]);
  assert.equal(touched, false);
}

// Real D1 regression: receipt-era rows cannot be weakened, malformed claims
// never write, and an unproven 0020 legacy default can normalize honestly.
{
  const fixture = await createProductFixture();
  try {
    const headers = { "X-Admin-Key": fixture.env.ADMIN_KEY };
    const strong = withFirstPartySourceProvenance(doc({ source_id: "transition-strong" }), {
      textSource: "native", textReliable: true,
    });
    let response = await fixture.post("/api/admin/brain/ingest", strong, headers);
    assert.equal(response.status, 200, await response.text());

    const weaker = withFirstPartySourceProvenance({ ...strong, metadata: {} }, {
      textSource: "ocr_partial", textReliable: false,
    });
    response = await fixture.post("/api/admin/brain/ingest", weaker, headers);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /reingest.*text-source fidelity/);
    const stillStrong = fixture.first(
      "SELECT text_source,text_reliable,meta FROM documents WHERE doc_uid='drive:transition-strong'",
    );
    assert.equal(stillStrong.text_source, "native");
    assert.equal(stillStrong.text_reliable, 1);
    assert.equal(JSON.parse(stillStrong.meta).provenance_receipt.status, "complete");

    const malformed = doc({
      source_id: "malformed-new",
      metadata: {
        provenance_receipt: {
          version: 1,
          status: "complete",
          reason: "lineage_and_text_recorded",
          root_ids: ["drive:not-this-document"],
        },
      },
    });
    await assert.rejects(
      storeFor(fixture.env).ingest(fixture.env, malformed),
      /recorded document family/,
      "the storage boundary must fail closed even when a first-party caller bypasses HTTP",
    );
    response = await fixture.post("/api/admin/brain/ingest", malformed, headers);
    assert.equal(response.status, 400);
    assert.equal(fixture.first(
      "SELECT count(*) n FROM documents WHERE doc_uid='drive:malformed-new'",
    ).n, 0);

    const legacyInput = doc({ source_id: "legacy-default" });
    response = await fixture.post("/api/admin/brain/ingest", legacyInput, headers);
    assert.equal(response.status, 200, await response.text());
    fixture.raw(
      "UPDATE documents SET text_source='native',text_reliable=1,meta='{}' WHERE doc_uid='drive:legacy-default'",
    );
    response = await fixture.post("/api/admin/brain/ingest", legacyInput, headers);
    assert.equal(response.status, 200, await response.text());
    const normalizedLegacy = fixture.first(
      "SELECT source,source_id,doc_uid,text_source,text_reliable,meta AS authority_meta FROM documents WHERE doc_uid='drive:legacy-default'",
    );
    assert.equal(normalizedLegacy.text_source, "unknown");
    assert.equal(normalizedLegacy.text_reliable, 0);
    assert.equal(storedProvenanceAssessment(normalizedLegacy).provenance_assessed, true);
    assert.equal(JSON.parse(normalizedLegacy.authority_meta).provenance_receipt.status, "unavailable");

    fixture.raw(
      `UPDATE documents
          SET text_source='native', text_reliable=1,
              meta='{"provenance_receipt":{"version":1,"status":"complete","reason":"lineage_and_text_recorded","root_ids":["drive:legacy-default"],"invented":true}}'
        WHERE doc_uid='drive:legacy-default'`,
    );
    response = await fixture.post("/api/admin/brain/ingest", legacyInput, headers);
    assert.equal(response.status, 200, await response.text());
    const repairedReceipt = JSON.parse(fixture.first(
      "SELECT meta FROM documents WHERE doc_uid='drive:legacy-default'",
    ).meta).provenance_receipt;
    assert.deepEqual(Object.keys(repairedReceipt).sort(), ["reason", "root_ids", "status", "version"]);
    assert.equal(repairedReceipt.status, "unavailable");
  } finally {
    fixture.close();
  }
}

// Alternate storage cannot round-trip the receipt, so both the store adapter
// and authenticated HTTP route refuse without calling its RPC.
{
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async () => {
    rpcCalls++;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(
      storeFor({ STORAGE: "supabase" }).ingest({ STORAGE: "supabase" }, doc()),
      /cannot prove normalized provenance parity/,
    );
    const response = await worker.fetch(new Request("https://brain.invalid/api/admin/brain/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": "fixture-admin" },
      body: JSON.stringify(doc()),
    }), {
      STORAGE: "supabase",
      ADMIN_KEY: "fixture-admin",
      SUPABASE_URL: "https://supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-role",
    }, {});
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "provenance_storage_unsupported");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The fixed public install document is itself covered by the contract.
{
  const smoke = publicInstallSmokeEnvelope();
  assert.equal(smoke.text_source, "native");
  assert.equal(smoke.text_reliable, true);
  assert.equal(smoke.metadata.provenance_receipt.status, "complete");
  assert.equal(ingestEnvelopeValidationError(smoke), null);
}

// Financial scope is owner input. Neither the reusable writer nor the HTTP
// route may select the primary entity when that input is absent.
{
  const plan = prepareBankExportImport({ ok: true, accounts: [] });
  assert.equal(plan.receipt.imported, false);
  assert.equal(plan.statements.length, 0);
  assert.match(plan.receipt.reason, /no primary entity was assumed/);

  const response = await handleBankExportImport({}, new Request("https://brain.invalid/api/admin/fin/import-bank-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: { ok: true } }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).reason, /entity_slug is required/);
}

console.log("provenance boundary: route, connector, storage, split and financial regressions passed");
