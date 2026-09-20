import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION,
  SourceOriginalBindingError,
  createSourceOriginalResultBinding,
  deriveSourceOriginalId,
  hashSourceOriginalResultBinding,
  loadSourceOriginalSigningKey,
  normalizeSourceOriginalLocator,
  normalizeSourceOriginalReceipt,
  normalizeSourceOriginalSource,
} from "../src/lib/source-original-binding.js";

const SOURCE = "localdocs";
const LOCATOR = "statements/fixture-scan.pdf";
const SIGNING_SALT = "a".repeat(64);
const RAW_RECEIPT = Object.freeze({
  version: 1,
  locator_kind: "source_relative_path",
  original_content_sha256: "3".repeat(64),
  original_byte_count: 1234,
});

function keyEnvironment({ row, waitFor = Promise.resolve() }) {
  let reads = 0;
  const DB = {
    prepare(sql) {
      assert.equal(
        sql,
        "SELECT tenant_id, signing_salt FROM source_original_id_key_state WHERE tenant_id=?1",
      );
      return {
        bind(tenantId) {
          assert.equal(tenantId, "primary");
          return {
            async first() {
              reads += 1;
              await waitFor;
              return row;
            },
          };
        },
      };
    },
  };
  return { env: { DB }, reads: () => reads };
}

function bindingReceipt(patch = {}) {
  return {
    contract_version: 1,
    tenant_id: "primary",
    source: SOURCE,
    original_id: `hmac-sha256:${"1".repeat(64)}`,
    locator_kind: "source_relative_path",
    document_revision_id: `rev-v1:${"2".repeat(64)}`,
    original_content_sha256: "3".repeat(64),
    original_byte_count: 1234,
    document_content_hash: "4".repeat(64),
    provenance_receipt_digest: "5".repeat(64),
    ...patch,
  };
}

function bindingError(code) {
  return (error) => error instanceof SourceOriginalBindingError && error.code === code;
}

test("canonical source-original inputs use an exact closed receipt contract", () => {
  assert.equal(SOURCE_ORIGINAL_BINDING_CONTRACT_VERSION, 1);
  assert.equal(normalizeSourceOriginalSource(SOURCE), SOURCE);
  assert.deepEqual(
    normalizeSourceOriginalLocator("source_relative_path", LOCATOR),
    { locator_kind: "source_relative_path", locator: LOCATOR },
  );
  assert.deepEqual(normalizeSourceOriginalReceipt(RAW_RECEIPT), RAW_RECEIPT);

  for (const locator of [
    "/absolute.pdf", "trailing/", "double//slash.pdf", "dot/../escape.pdf",
    "windows\\path.pdf", "decomposed/cafe\u0301.pdf", "control/line\nbreak.pdf",
  ]) {
    assert.throws(
      () => normalizeSourceOriginalLocator("source_relative_path", locator),
      bindingError("source_original_invalid_locator"),
      locator,
    );
  }
  assert.throws(
    () => normalizeSourceOriginalLocator("url", LOCATOR),
    bindingError("source_original_invalid_locator_kind"),
  );
  for (const source of ["", "LocalDocs", "local/docs", "a".repeat(65)]) {
    assert.throws(
      () => normalizeSourceOriginalSource(source),
      bindingError("source_original_invalid_source"),
      source,
    );
  }
  assert.throws(
    () => normalizeSourceOriginalReceipt({ ...RAW_RECEIPT, locator: LOCATOR }),
    bindingError("source_original_invalid_content_receipt"),
  );
  assert.throws(
    () => normalizeSourceOriginalReceipt({ ...RAW_RECEIPT, version: 2 }),
    bindingError("source_original_binding_contract_unsupported"),
  );
  assert.throws(
    () => normalizeSourceOriginalReceipt({ ...RAW_RECEIPT, original_content_sha256: "A".repeat(64) }),
    bindingError("source_original_invalid_content_receipt"),
  );
  assert.throws(
    () => normalizeSourceOriginalReceipt({ ...RAW_RECEIPT, original_byte_count: 1.5 }),
    bindingError("source_original_invalid_content_receipt"),
  );
});

test("schema-42 HMAC identity domain remains byte-for-byte stable", async () => {
  const { env } = keyEnvironment({
    row: { tenant_id: "primary", signing_salt: SIGNING_SALT },
  });
  const signingKey = await loadSourceOriginalSigningKey(env);
  const originalId = await deriveSourceOriginalId(signingKey, {
    source: SOURCE,
    locator_kind: "source_relative_path",
    locator: LOCATOR,
  });
  assert.equal(
    originalId,
    "hmac-sha256:e20bb6e0fc40b6a9c2534fb9edf33d676912bbb3eed4518aa78628004b1b4ed8",
  );
});

test("concurrent key loads share one D1 read and settled loads refresh", async () => {
  let release;
  const waitFor = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = keyEnvironment({
    row: { tenant_id: "primary", signing_salt: SIGNING_SALT },
    waitFor,
  });
  const pending = Array.from({ length: 50 }, () => loadSourceOriginalSigningKey(fixture.env));
  await Promise.resolve();
  assert.equal(fixture.reads(), 1);
  release();
  const keys = await Promise.all(pending);
  assert(keys.every((key) => key instanceof CryptoKey));
  assert.equal(fixture.reads(), 1);

  await loadSourceOriginalSigningKey(fixture.env);
  assert.equal(fixture.reads(), 2);
});

test("an unavailable identity key fails closed and is retried after settlement", async () => {
  const fixture = keyEnvironment({ row: null });
  await assert.rejects(
    Promise.all([
      loadSourceOriginalSigningKey(fixture.env),
      loadSourceOriginalSigningKey(fixture.env),
    ]),
    bindingError("source_original_id_key_unavailable"),
  );
  assert.equal(fixture.reads(), 1);
  await assert.rejects(
    loadSourceOriginalSigningKey(fixture.env),
    bindingError("source_original_id_key_unavailable"),
  );
  assert.equal(fixture.reads(), 2);
});

test("result binding hashes have a fixed canonical vector", async () => {
  assert.equal(
    await hashSourceOriginalResultBinding(bindingReceipt()),
    "sha256:5c90c5682053f5de168b74af4b40a9575b80751cf73e1506ef7a7b68b5d261d5",
  );
  await assert.rejects(
    hashSourceOriginalResultBinding({ ...bindingReceipt(), locator: LOCATOR }),
    bindingError("source_original_invalid_result_binding"),
  );
  await assert.rejects(
    hashSourceOriginalResultBinding(bindingReceipt({ document_revision_id: `rev-v2:${"2".repeat(64)}` })),
    bindingError("source_original_invalid_result_binding"),
  );
});

test("sealed result binding persists identity and digests without a raw locator field", async () => {
  const { env } = keyEnvironment({
    row: { tenant_id: "primary", signing_salt: SIGNING_SALT },
  });
  const result = await createSourceOriginalResultBinding(env, {
    source: SOURCE,
    locator: LOCATOR,
    source_original_receipt: RAW_RECEIPT,
    document_revision_id: `rev-v1:${"2".repeat(64)}`,
    document_content_hash: "4".repeat(64),
    provenance_receipt_digest: "5".repeat(64),
  });
  assert.equal(
    result.receipt.original_id,
    "hmac-sha256:e20bb6e0fc40b6a9c2534fb9edf33d676912bbb3eed4518aa78628004b1b4ed8",
  );
  assert.equal(result.receipt.original_content_sha256, RAW_RECEIPT.original_content_sha256);
  assert.equal(result.receipt.original_byte_count, RAW_RECEIPT.original_byte_count);
  assert.match(result.binding_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.binding_hash, await hashSourceOriginalResultBinding(result.receipt));
  assert.equal(Object.hasOwn(result.receipt, "locator"), false);
  assert.equal(Object.hasOwn(result.receipt, "doc_uid"), false);
  assert.deepEqual(
    Object.keys(result.receipt).filter((key) => key.includes("locator")),
    ["locator_kind"],
  );

  const changedRevision = await createSourceOriginalResultBinding(env, {
    source: SOURCE,
    locator: LOCATOR,
    source_original_receipt: RAW_RECEIPT,
    document_revision_id: `rev-v1:${"6".repeat(64)}`,
    document_content_hash: "4".repeat(64),
    provenance_receipt_digest: "5".repeat(64),
  });
  assert.notEqual(changedRevision.binding_hash, result.binding_hash);
});
