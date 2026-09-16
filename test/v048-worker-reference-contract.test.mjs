import assert from "node:assert/strict";
import test from "node:test";

import {
  V048_WORKER_REFERENCE_KEYS,
  V048_WORKER_REFERENCE_SNAPSHOT_KIND,
  V048WorkerReferenceContractError,
  fingerprintV048WorkerReferenceSnapshot,
  normalizeV048WorkerReferenceSnapshot,
} from "../operations/v048-worker-reference-contract.mjs";

const WORKER_NAME = "brain-test-v048-field-source-recovery-gate-a48f1101";
const WORKER_ID = "2ea0c355770d462e87c360f096bf5ea2";
const ACCOUNT_SUBDOMAIN = "synthetic-account";
const EXPECTED_DOMAIN = `${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`;

function result(override = {}) {
  return {
    id: WORKER_ID,
    name: WORKER_NAME,
    references: {
      dispatch_namespace_outbounds: [],
      domains: [],
      durable_objects: [],
      queues: [],
      workers: [],
    },
    subdomain: {
      enabled: true,
      preview_url_suffix:
        `-${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      previews_enabled: false,
      url: `https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
    },
    tail_consumers: [],
    ...override,
  };
}

const options = Object.freeze({
  expectedWorkerName: WORKER_NAME,
  expectedWorkerId: WORKER_ID,
  expectedDomain: EXPECTED_DOMAIN,
});

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof V048WorkerReferenceContractError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test("normalizes a zero-reference Worker result without exposing hostnames", () => {
  const proof = normalizeV048WorkerReferenceSnapshot(result(), options);
  assert.deepEqual(proof, {
    schema_version: 1,
    kind: V048_WORKER_REFERENCE_SNAPSHOT_KIND,
    worker_id: WORKER_ID,
    reference_counts: {
      dispatch_namespace_outbounds: 0,
      domains: 0,
      durable_objects: 0,
      queues: 0,
      workers: 0,
    },
    tail_consumers: 0,
    subdomain_enabled: true,
    previews_enabled: false,
    subdomain_metadata_present: true,
    snapshot_sha256: proof.snapshot_sha256,
  });
  assert.match(proof.snapshot_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.isFrozen(proof.reference_counts), true);
  assert.equal(JSON.stringify(proof).includes(ACCOUNT_SUBDOMAIN), false);
  assert.equal(JSON.stringify(proof).includes(WORKER_NAME), false);
  assert.deepEqual(V048_WORKER_REFERENCE_KEYS, [
    "dispatch_namespace_outbounds",
    "domains",
    "durable_objects",
    "queues",
    "workers",
  ]);
});

test("service Worker references are refused", () => {
  const worker = result();
  worker.references.workers.push({ id: "referrer-id", name: "referrer" });
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(worker, options),
    "V048_WORKER_REFERENCE_PRESENT",
  );
});

test("dispatch outbound, queue, Durable Object, and domain references are refused", async (t) => {
  const cases = [
    ["dispatch outbound", "dispatch_namespace_outbounds", {
      namespace_id: "namespace-id",
      namespace_name: "namespace-name",
      worker_id: "worker-id",
      worker_name: "worker-name",
    }],
    ["queue", "queues", {
      queue_consumer_id: "consumer-id",
      queue_id: "queue-id",
      queue_name: "queue-name",
    }],
    ["Durable Object", "durable_objects", {
      namespace_id: "namespace-id",
      namespace_name: "namespace-name",
      worker_id: "worker-id",
      worker_name: "worker-name",
    }],
    ["domain", "domains", {
      id: "domain-id",
      certificate_id: "certificate-id",
      hostname: "private-hostname.example",
      zone_id: "zone-id",
      zone_name: "example",
    }],
  ];
  for (const [label, key, reference] of cases) {
    await t.test(label, () => {
      const worker = result();
      worker.references[key].push(reference);
      expectCode(
        () => normalizeV048WorkerReferenceSnapshot(worker, options),
        "V048_WORKER_REFERENCE_PRESENT",
      );
    });
  }
});

test("tail consumers are refused", () => {
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(result({
      tail_consumers: [{ name: "tail-consumer" }],
    }), options),
    "V048_WORKER_TAIL_CONSUMER_PRESENT",
  );
});

test("disabled workers.dev and enabled previews are independently refused", () => {
  for (const [field, code] of [
    ["enabled", "V048_WORKER_REFERENCE_SUBDOMAIN_DISABLED"],
    ["previews_enabled", "V048_WORKER_REFERENCE_PREVIEWS_ENABLED"],
  ]) {
    const worker = result();
    worker.subdomain[field] = field === "enabled" ? false : true;
    expectCode(
      () => normalizeV048WorkerReferenceSnapshot(worker, options),
      code,
    );
  }
});

test("all five reference arrays must be present and exactly empty arrays", async (t) => {
  for (const key of V048_WORKER_REFERENCE_KEYS) {
    await t.test(`omitted ${key}`, () => {
      const worker = result();
      delete worker.references[key];
      expectCode(
        () => normalizeV048WorkerReferenceSnapshot(worker, options),
        "V048_WORKER_REFERENCES_INVALID",
      );
    });
    for (const malformed of [null, {}, "", 0]) {
      await t.test(`malformed ${key} as ${typeof malformed}`, () => {
        const worker = result();
        worker.references[key] = malformed;
        expectCode(
          () => normalizeV048WorkerReferenceSnapshot(worker, options),
          "V048_WORKER_REFERENCE_PRESENT",
        );
      });
    }
  }
});

test("name and immutable ID drift fail closed", () => {
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(result({
      name: `${WORKER_NAME}-other`,
    }), options),
    "V048_WORKER_REFERENCE_NAME_MISMATCH",
  );
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(result({
      id: "3ea0c355770d462e87c360f096bf5ea3",
    }), options),
    "V048_WORKER_REFERENCE_ID_MISMATCH",
  );
  for (const id of ["", "with spaces", "a".repeat(129), "bad/id", null]) {
    expectCode(
      () => normalizeV048WorkerReferenceSnapshot(result({ id }), {
        expectedWorkerName: WORKER_NAME,
        expectedDomain: EXPECTED_DOMAIN,
      }),
      "V048_WORKER_REFERENCE_ID_INVALID",
    );
  }
});

test("documented URL and preview suffix metadata are required and canonical", () => {
  const invalid = [
    { url: `https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev/path` },
    { url: `http://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev` },
    { url: `https://${WORKER_NAME}.other-account.workers.dev` },
    { preview_url_suffix: `${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev` },
    { preview_url_suffix: `-${WORKER_NAME}.other-account.workers.dev` },
  ];
  for (const changed of invalid) {
    const worker = result();
    Object.assign(worker.subdomain, changed);
    expectCode(
      () => normalizeV048WorkerReferenceSnapshot(worker, options),
      "V048_WORKER_REFERENCE_SUBDOMAIN_INVALID",
    );
  }

  for (const missingKeys of [
    ["url"],
    ["preview_url_suffix"],
    ["url", "preview_url_suffix"],
  ]) {
    const worker = result();
    for (const key of missingKeys) delete worker.subdomain[key];
    expectCode(
      () => normalizeV048WorkerReferenceSnapshot(worker, options),
      "V048_WORKER_REFERENCE_SUBDOMAIN_INVALID",
    );
  }
});

test("the exact manifest domain is required and bound without being disclosed", () => {
  const otherDomain = `${WORKER_NAME}.other-account.workers.dev`;
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(result(), {
      ...options,
      expectedDomain: otherDomain,
    }),
    "V048_WORKER_REFERENCE_SUBDOMAIN_INVALID",
  );
  for (const expectedDomain of [
    undefined,
    `other-worker.${ACCOUNT_SUBDOMAIN}.workers.dev`,
    `https://${EXPECTED_DOMAIN}`,
    `${EXPECTED_DOMAIN}.`,
  ]) {
    expectCode(
      () => normalizeV048WorkerReferenceSnapshot(result(), {
        expectedWorkerName: WORKER_NAME,
        expectedWorkerId: WORKER_ID,
        expectedDomain,
      }),
      "V048_WORKER_REFERENCE_ARGUMENT_INVALID",
    );
  }
  const proof = normalizeV048WorkerReferenceSnapshot(result(), options);
  assert.equal(JSON.stringify(proof).includes(EXPECTED_DOMAIN), false);
});

test("extra top-level, references, and subdomain keys are refused", () => {
  const topLevel = result({ service_bindings: [] });
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(topLevel, options),
    "V048_WORKER_REFERENCE_RESULT_INVALID",
  );

  const references = result();
  references.references.service_bindings = [];
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(references, options),
    "V048_WORKER_REFERENCES_INVALID",
  );

  const subdomain = result();
  subdomain.subdomain.hostname = "hidden.example";
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(subdomain, options),
    "V048_WORKER_REFERENCE_SUBDOMAIN_INVALID",
  );

  const hidden = result();
  Object.defineProperty(hidden.references, "service_bindings", {
    enumerable: false,
    value: [],
  });
  expectCode(
    () => normalizeV048WorkerReferenceSnapshot(hidden, options),
    "V048_WORKER_REFERENCES_INVALID",
  );
});

test("fingerprints are stable across key order and irrelevant documented metadata", () => {
  const baseline = normalizeV048WorkerReferenceSnapshot(result(), options);
  const reordered = result({
    created_on: "2026-09-12T00:00:00.000Z",
    deployed_on: null,
    logpush: false,
    observability: {},
    tags: ["ignored-by-reference-proof"],
    updated_on: "2026-09-12T00:00:01.000Z",
    references: {
      workers: [],
      queues: [],
      durable_objects: [],
      domains: [],
      dispatch_namespace_outbounds: [],
    },
  });
  const repeated = normalizeV048WorkerReferenceSnapshot(reordered, options);
  assert.equal(repeated.snapshot_sha256, baseline.snapshot_sha256);
  assert.equal(
    fingerprintV048WorkerReferenceSnapshot(reordered, options),
    baseline.snapshot_sha256,
  );

  const changedId = normalizeV048WorkerReferenceSnapshot(result({
    id: "3ea0c355770d462e87c360f096bf5ea3",
  }), {
    expectedWorkerName: WORKER_NAME,
    expectedDomain: EXPECTED_DOMAIN,
  });
  assert.notEqual(changedId.snapshot_sha256, baseline.snapshot_sha256);
  const otherName = "brain-test-v048-field-target-recovery-gate-a48f1102";
  const changedName = normalizeV048WorkerReferenceSnapshot(result({
    name: otherName,
    subdomain: {
      enabled: true,
      preview_url_suffix: `-${otherName}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      previews_enabled: false,
      url: `https://${otherName}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
    },
  }), {
    expectedWorkerName: otherName,
    expectedWorkerId: WORKER_ID,
    expectedDomain: `${otherName}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
  });
  assert.notEqual(changedName.snapshot_sha256, baseline.snapshot_sha256);
});

test("missing and malformed relevant result shapes are refused", () => {
  for (const worker of [
    null,
    [],
    result({ references: null }),
    result({ subdomain: [] }),
    result({ tail_consumers: {} }),
  ]) {
    expectCode(
      () => normalizeV048WorkerReferenceSnapshot(worker, options),
      worker?.references === null
        ? "V048_WORKER_REFERENCES_INVALID"
        : worker?.subdomain && Array.isArray(worker.subdomain)
          ? "V048_WORKER_REFERENCE_SUBDOMAIN_INVALID"
          : worker?.tail_consumers && !Array.isArray(worker.tail_consumers)
            ? "V048_WORKER_TAIL_CONSUMER_PRESENT"
            : "V048_WORKER_REFERENCE_RESULT_INVALID",
    );
  }
});
