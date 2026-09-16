import assert from "node:assert/strict";
import test from "node:test";

import {
  V048_CURRENT_WORKER_BINDING_TYPES,
  V048_EXCLUSIVE_RESOURCE_CUSTODY_KIND,
  V048ExclusiveResourceCustodyContractError,
  assertV048ExclusiveCampaignResourceCustodyAuthority,
  verifyV048ExclusiveCampaignResourceCustody,
  verifyV048ExclusiveCampaignResourceCustodyWithAuthority,
} from "../operations/v048-exclusive-resource-custody-contract.mjs";

const SOURCE_WORKER = "brain-test-v048-field-source-recovery-gate-a48f1101";
const TARGET_WORKER = "brain-test-v048-field-target-recovery-gate-a48f1102";
const OTHER_WORKER = "existing-account-worker";
const IDLE_WORKER = "never-deployed-worker";
const SOURCE_D1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_D1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_D1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOURCE_VERSION = "11111111-1111-4111-8111-111111111111";
const SECOND_VERSION = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPLOYED_ON = "2026-09-12T12:00:00.000Z";

const campaignResources = Object.freeze({
  teardownRole: "source",
  source: Object.freeze({
    workerName: SOURCE_WORKER,
    workerState: "present",
    d1DatabaseId: SOURCE_D1,
    vectorizeIndexName: SOURCE_WORKER,
  }),
  target: Object.freeze({
    workerName: TARGET_WORKER,
    workerState: "present",
    d1DatabaseId: TARGET_D1,
    vectorizeIndexName: TARGET_WORKER,
  }),
});

function initialWorker(id, name, extra = {}) {
  return {
    id,
    name,
    deployed_on: name === IDLE_WORKER ? null : DEPLOYED_ON,
    ...extra,
  };
}

function deployment(versions = [{ percentage: 100, version_id: SOURCE_VERSION }], extra = {}) {
  return {
    created_on: DEPLOYED_ON,
    id: DEPLOYMENT_ID,
    strategy: "percentage",
    versions,
    ...extra,
  };
}

function version(id = SOURCE_VERSION, bindings = [], extra = {}) {
  return {
    id,
    resources: { bindings },
    ...extra,
  };
}

function workerEvidence({
  workerId = "other-worker-id",
  workerName = OTHER_WORKER,
  deployments = [deployment()],
  trafficVersions = [version(SOURCE_VERSION, [
    { type: "d1", name: "OTHER_DB", database_id: OTHER_D1, id: OTHER_D1 },
    { type: "vectorize", name: "OTHER_VECTOR", index_name: "other-vector-index" },
    { type: "kv_namespace", name: "CACHE", namespace_id: "kv-namespace-id" },
  ])],
} = {}) {
  return {
    workerId,
    workerName,
    deploymentList: { deployments },
    trafficVersions,
  };
}

function idleEvidence() {
  return workerEvidence({
    workerId: "idle-worker-id",
    workerName: IDLE_WORKER,
    deployments: [],
    trafficVersions: [],
  });
}

function input(override = {}) {
  return {
    campaignResources,
    initialWorkerList: {
      total_count: 4,
      workers: [
        initialWorker("source-worker-id", SOURCE_WORKER),
        initialWorker("target-worker-id", TARGET_WORKER),
        initialWorker("other-worker-id", OTHER_WORKER),
        initialWorker("idle-worker-id", IDLE_WORKER),
      ],
    },
    nonCampaignWorkers: [workerEvidence(), idleEvidence()],
    ...override,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof V048ExclusiveResourceCustodyContractError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test("proves complete account-wide custody with aggregate-only output", () => {
  const receipt = verifyV048ExclusiveCampaignResourceCustody(input());
  assert.deepEqual(receipt, {
    schema_version: 1,
    kind: V048_EXCLUSIVE_RESOURCE_CUSTODY_KIND,
    account_workers: 4,
    campaign_workers_reviewed: 2,
    campaign_workers_present: 2,
    campaign_workers_absent: 0,
    non_campaign_workers: 2,
    deployed_non_campaign_workers: 1,
    traffic_versions_inspected: 1,
    bindings_inspected: 3,
    d1_bindings_inspected: 1,
    vectorize_bindings_inspected: 1,
    campaign_d1_bindings: 0,
    campaign_vectorize_bindings: 0,
    initial_worker_list_sha256: receipt.initial_worker_list_sha256,
    custody_sha256: receipt.custody_sha256,
  });
  assert.match(receipt.initial_worker_list_sha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.custody_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(receipt), true);
  const serialized = JSON.stringify(receipt);
  for (const privateValue of [
    SOURCE_WORKER,
    TARGET_WORKER,
    OTHER_WORKER,
    SOURCE_D1,
    TARGET_D1,
    OTHER_D1,
    SOURCE_VERSION,
    DEPLOYMENT_ID,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("the private authority deterministically recomputes every aggregate hash", () => {
  const proof = verifyV048ExclusiveCampaignResourceCustodyWithAuthority(input());
  const recomputed = assertV048ExclusiveCampaignResourceCustodyAuthority(
    proof.authority,
  );
  assert.deepEqual(recomputed.receipt, proof.receipt);
  assert.deepEqual(recomputed.authority, proof.authority);

  const changedOuterOnly = structuredClone(proof.receipt);
  changedOuterOnly.custody_sha256 = "f".repeat(64);
  assert.notDeepEqual(recomputed.receipt, changedOuterOnly);

  const malformedAuthority = structuredClone(proof.authority);
  malformedAuthority.initial_worker_list.total_count += 1;
  expectCode(
    () => assertV048ExclusiveCampaignResourceCustodyAuthority(malformedAuthority),
    "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID",
  );
});

test("a non-campaign D1 binding to either campaign database is refused", async (t) => {
  for (const databaseId of [SOURCE_D1, TARGET_D1, SOURCE_D1.toUpperCase()]) {
    await t.test(databaseId.slice(0, 8), () => {
      const evidence = workerEvidence({
        trafficVersions: [version(SOURCE_VERSION, [{
          type: "d1",
          name: "SHADOW_DB",
          database_id: databaseId,
          id: databaseId,
        }])],
      });
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: [evidence, idleEvidence()],
        })),
        "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_RESOURCE_BOUND",
      );
    });
  }
});

test("a non-campaign Vectorize binding to either campaign index is refused", async (t) => {
  for (const indexName of [SOURCE_WORKER, TARGET_WORKER]) {
    await t.test(indexName.slice(-8), () => {
      const evidence = workerEvidence({
        trafficVersions: [version(SOURCE_VERSION, [{
          type: "vectorize",
          name: "SHADOW_VECTOR",
          index_name: indexName,
        }])],
      });
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: [evidence, idleEvidence()],
        })),
        "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_RESOURCE_BOUND",
      );
    });
  }
});

test("both traffic-bearing versions in a split deployment are inspected", () => {
  const split = workerEvidence({
    deployments: [deployment([
      { percentage: 37.5, version_id: SOURCE_VERSION },
      { percentage: 62.5, version_id: SECOND_VERSION },
    ])],
    trafficVersions: [
      version(SECOND_VERSION, [{ type: "plain_text", name: "MODE", text: "active" }]),
      version(SOURCE_VERSION, [{
        type: "d1",
        name: "OTHER_DB",
        database_id: OTHER_D1,
      }]),
    ],
  });
  const receipt = verifyV048ExclusiveCampaignResourceCustody(input({
    nonCampaignWorkers: [idleEvidence(), split],
  }));
  assert.equal(receipt.traffic_versions_inspected, 2);
  assert.equal(receipt.bindings_inspected, 2);
  assert.equal(receipt.d1_bindings_inspected, 1);

  split.trafficVersions[0].resources.bindings = [{
    type: "vectorize",
    name: "CAMPAIGN_VECTOR",
    index_name: TARGET_WORKER,
  }];
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      nonCampaignWorkers: [split, idleEvidence()],
    })),
    "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_RESOURCE_BOUND",
  );
});

test("missing, duplicate, or extra non-campaign Worker evidence is refused", async (t) => {
  const cases = [
    ["missing", [workerEvidence()]],
    ["duplicate", [workerEvidence(), workerEvidence()]],
    ["campaign entry", [workerEvidence(), workerEvidence({
      workerId: "source-worker-id",
      workerName: SOURCE_WORKER,
    })]],
    ["unknown entry", [workerEvidence(), workerEvidence({
      workerId: "unknown-id",
      workerName: "unknown-worker",
    })]],
  ];
  for (const [label, evidence] of cases) {
    await t.test(label, () => {
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: evidence,
        })),
        "V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID",
      );
    });
  }
});

test("non-campaign Worker immutable ID and name must match the initial list", () => {
  for (const changed of [
    workerEvidence({ workerId: "replacement-worker-id" }),
    workerEvidence({ workerName: "renamed-worker" }),
  ]) {
    expectCode(
      () => verifyV048ExclusiveCampaignResourceCustody(input({
        nonCampaignWorkers: [changed, idleEvidence()],
      })),
      "V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID",
    );
  }
});

test("every and only traffic-bearing version must have a full detail", async (t) => {
  const splitDeployments = [deployment([
    { percentage: 50, version_id: SOURCE_VERSION },
    { percentage: 50, version_id: SECOND_VERSION },
  ])];
  const cases = [
    ["missing detail", [version(SOURCE_VERSION)]],
    ["duplicate detail", [version(SOURCE_VERSION), version(SOURCE_VERSION)]],
    ["extra detail", [version(SOURCE_VERSION), version(SECOND_VERSION), version(
      "33333333-3333-4333-8333-333333333333",
    )]],
    ["wrong detail", [version(SOURCE_VERSION), version(
      "33333333-3333-4333-8333-333333333333",
    )]],
  ];
  for (const [label, trafficVersions] of cases) {
    await t.test(label, () => {
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: [workerEvidence({
            deployments: splitDeployments,
            trafficVersions,
          }), idleEvidence()],
        })),
        "V048_EXCLUSIVE_CUSTODY_TRAFFIC_VERSION_COVERAGE_INVALID",
      );
    });
  }
});

test("missing or malformed full version bindings are refused", async (t) => {
  const cases = [
    ["missing resources", { id: SOURCE_VERSION }],
    ["missing bindings", { id: SOURCE_VERSION, resources: {} }],
    ["object bindings", { id: SOURCE_VERSION, resources: { bindings: {} } }],
    ["sparse bindings", (() => {
      const bindings = new Array(1);
      return version(SOURCE_VERSION, bindings);
    })()],
  ];
  for (const [label, detail] of cases) {
    await t.test(label, () => {
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: [workerEvidence({ trafficVersions: [detail] }), idleEvidence()],
        })),
        label === "missing resources"
          ? "V048_EXCLUSIVE_CUSTODY_VERSION_INVALID"
          : "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID",
      );
    });
  }
});

test("invalid traffic allocations and deployment shapes are refused", async (t) => {
  const cases = [
    ["zero", [{ percentage: 0, version_id: SOURCE_VERSION }]],
    ["over 100", [{ percentage: 101, version_id: SOURCE_VERSION }]],
    ["under total", [
      { percentage: 40, version_id: SOURCE_VERSION },
      { percentage: 40, version_id: SECOND_VERSION },
    ]],
    ["duplicate", [
      { percentage: 50, version_id: SOURCE_VERSION },
      { percentage: 50, version_id: SOURCE_VERSION },
    ]],
    ["three versions", [
      { percentage: 34, version_id: SOURCE_VERSION },
      { percentage: 33, version_id: SECOND_VERSION },
      { percentage: 33, version_id: "33333333-3333-4333-8333-333333333333" },
    ]],
  ];
  for (const [label, versions] of cases) {
    await t.test(label, () => {
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: [workerEvidence({
            deployments: [deployment(versions)],
            trafficVersions: versions.map((entry) => version(entry.version_id)),
          }), idleEvidence()],
        })),
        "V048_EXCLUSIVE_CUSTODY_DEPLOYMENT_INVALID",
      );
    });
  }
  const wrongStrategy = workerEvidence({
    deployments: [deployment(undefined, { strategy: "gradual" })],
  });
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      nonCampaignWorkers: [wrongStrategy, idleEvidence()],
    })),
    "V048_EXCLUSIVE_CUSTODY_DEPLOYMENT_INVALID",
  );
});

test("unknown and inherited binding types fail closed", () => {
  for (const [type, code] of [
    ["future_database", "V048_EXCLUSIVE_CUSTODY_BINDING_TYPE_UNKNOWN"],
    ["inherit", "V048_EXCLUSIVE_CUSTODY_BINDING_INHERIT_UNRESOLVED"],
  ]) {
    const evidence = workerEvidence({
      trafficVersions: [version(SOURCE_VERSION, [{ type, name: "OPAQUE" }])],
    });
    expectCode(
      () => verifyV048ExclusiveCampaignResourceCustody(input({
        nonCampaignWorkers: [evidence, idleEvidence()],
      })),
      code,
    );
  }
  assert.equal(V048_CURRENT_WORKER_BINDING_TYPES.includes("d1"), true);
  assert.equal(V048_CURRENT_WORKER_BINDING_TYPES.includes("vectorize"), true);
  assert.equal(V048_CURRENT_WORKER_BINDING_TYPES.includes("inherit"), true);
  assert.equal(Object.isFrozen(V048_CURRENT_WORKER_BINDING_TYPES), true);
});

test("D1 and Vectorize binding identities must be unambiguous", async (t) => {
  const cases = [
    ["D1 missing database_id", { type: "d1", name: "DB" },
      "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID"],
    ["D1 mismatched deprecated id", {
      type: "d1",
      name: "DB",
      database_id: OTHER_D1,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }, "V048_EXCLUSIVE_CUSTODY_BINDING_ID_AMBIGUOUS"],
    ["D1 extra alias", {
      type: "d1",
      name: "DB",
      database_id: OTHER_D1,
      database_name: "other",
    }, "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID"],
    ["Vectorize missing index", { type: "vectorize", name: "VECTOR" },
      "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID"],
    ["Vectorize extra alias", {
      type: "vectorize",
      name: "VECTOR",
      index_name: "other-vector-index",
      index_id: "opaque",
    }, "V048_EXCLUSIVE_CUSTODY_BINDINGS_INVALID"],
    ["wrong type with database identity", {
      type: "plain_text",
      name: "VALUE",
      text: "safe",
      database_id: OTHER_D1,
    }, "V048_EXCLUSIVE_CUSTODY_BINDING_ID_AMBIGUOUS"],
  ];
  for (const [label, binding, code] of cases) {
    await t.test(label, () => {
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({
          nonCampaignWorkers: [workerEvidence({
            trafficVersions: [version(SOURCE_VERSION, [binding])],
          }), idleEvidence()],
        })),
        code,
      );
    });
  }
});

test("the exact initial Worker list and provider total are required", async (t) => {
  const baseline = input().initialWorkerList;
  const cases = [
    ["count mismatch", { ...baseline, total_count: 5 }],
    ["missing source", {
      total_count: 3,
      workers: baseline.workers.filter((worker) => worker.name !== SOURCE_WORKER),
    }],
    ["duplicate name", {
      ...baseline,
      workers: baseline.workers.map((worker, index) => index === 3
        ? { ...worker, name: OTHER_WORKER }
        : worker),
    }],
    ["duplicate ID", {
      ...baseline,
      workers: baseline.workers.map((worker, index) => index === 3
        ? { ...worker, id: "other-worker-id" }
        : worker),
    }],
    ["unknown Worker key", {
      ...baseline,
      workers: baseline.workers.map((worker, index) => index === 0
        ? { ...worker, script_name: worker.name }
        : worker),
    }],
    ["missing deployed_on", {
      ...baseline,
      workers: baseline.workers.map((worker, index) => {
        if (index !== 0) return worker;
        const { deployed_on: _deployedOn, ...withoutDeployment } = worker;
        return withoutDeployment;
      }),
    }],
    ["malformed deployed_on", {
      ...baseline,
      workers: baseline.workers.map((worker, index) => index === 0
        ? { ...worker, deployed_on: "2026-09-12" }
        : worker),
    }],
  ];
  for (const [label, initialWorkerList] of cases) {
    await t.test(label, () => {
      expectCode(
        () => verifyV048ExclusiveCampaignResourceCustody(input({ initialWorkerList })),
        "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID",
      );
    });
  }
});

test("Beta deployed_on and the latest deployment are exact counterparts", () => {
  const baseline = input().initialWorkerList;
  const withOtherDeployment = (deployedOn, evidence) => verifyV048ExclusiveCampaignResourceCustody(
    input({
      initialWorkerList: {
        ...baseline,
        workers: baseline.workers.map((worker) => worker.name === OTHER_WORKER
          ? { ...worker, deployed_on: deployedOn }
          : worker),
      },
      nonCampaignWorkers: [evidence, idleEvidence()],
    }),
  );

  expectCode(
    () => withOtherDeployment(DEPLOYED_ON, workerEvidence({
      deployments: [],
      trafficVersions: [],
    })),
    "V048_EXCLUSIVE_CUSTODY_DEPLOYED_STATE_INVALID",
  );
  expectCode(
    () => withOtherDeployment(null, workerEvidence()),
    "V048_EXCLUSIVE_CUSTODY_DEPLOYED_STATE_INVALID",
  );
  expectCode(
    () => withOtherDeployment("2026-09-12T12:00:01.000Z", workerEvidence()),
    "V048_EXCLUSIVE_CUSTODY_DEPLOYED_STATE_INVALID",
  );
});

test("campaign identity requires exact distinct source and target resource pairs", () => {
  for (const changed of [
    { ...campaignResources, teardownRole: "other" },
    { ...campaignResources, source: { ...campaignResources.source, workerName: TARGET_WORKER } },
    { ...campaignResources, source: { ...campaignResources.source, d1DatabaseId: "not-a-uuid" } },
    { ...campaignResources, source: { ...campaignResources.source, workerState: "unknown" } },
    { ...campaignResources, source: {
      ...campaignResources.source,
      vectorizeIndexName: TARGET_WORKER,
    } },
    { ...campaignResources, extra: true },
  ]) {
    expectCode(
      () => verifyV048ExclusiveCampaignResourceCustody(input({
        campaignResources: changed,
      })),
      "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_INVALID",
    );
  }
});

test("target teardown proves source absence while retaining the target", () => {
  const targetCampaign = {
    ...campaignResources,
    teardownRole: "target",
    source: { ...campaignResources.source, workerState: "absent" },
  };
  const targetInput = input({
    campaignResources: targetCampaign,
    initialWorkerList: {
      total_count: 3,
      workers: input().initialWorkerList.workers.filter(
        (worker) => worker.name !== SOURCE_WORKER,
      ),
    },
  });
  const receipt = verifyV048ExclusiveCampaignResourceCustody(targetInput);
  assert.equal(receipt.account_workers, 3);
  assert.equal(receipt.campaign_workers_reviewed, 2);
  assert.equal(receipt.campaign_workers_present, 1);
  assert.equal(receipt.campaign_workers_absent, 1);

  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      campaignResources: targetCampaign,
    })),
    "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID",
  );
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      campaignResources: targetCampaign,
      initialWorkerList: {
        total_count: 2,
        workers: input().initialWorkerList.workers.filter(
          (worker) => worker.name !== SOURCE_WORKER && worker.name !== TARGET_WORKER,
        ),
      },
    })),
    "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID",
  );
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      campaignResources: {
        ...targetCampaign,
        source: { ...targetCampaign.source, workerState: "present" },
      },
    })),
    "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_INVALID",
  );
});

test("source teardown resumes after its Worker is already absent", () => {
  const resumedCampaign = {
    ...campaignResources,
    source: { ...campaignResources.source, workerState: "absent" },
  };
  const receipt = verifyV048ExclusiveCampaignResourceCustody(input({
    campaignResources: resumedCampaign,
    initialWorkerList: {
      total_count: 3,
      workers: input().initialWorkerList.workers.filter(
        (worker) => worker.name !== SOURCE_WORKER,
      ),
    },
  }));
  assert.equal(receipt.account_workers, 3);
  assert.equal(receipt.campaign_workers_present, 1);
  assert.equal(receipt.campaign_workers_absent, 1);
  assert.notEqual(
    receipt.custody_sha256,
    verifyV048ExclusiveCampaignResourceCustody(input()).custody_sha256,
  );

  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      campaignResources: resumedCampaign,
    })),
    "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID",
  );
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      campaignResources: {
        ...campaignResources,
        target: { ...campaignResources.target, workerState: "absent" },
      },
    })),
    "V048_EXCLUSIVE_CUSTODY_CAMPAIGN_INVALID",
  );
});

test("target teardown resumes after both campaign Workers are absent", () => {
  const resumedCampaign = {
    ...campaignResources,
    teardownRole: "target",
    source: { ...campaignResources.source, workerState: "absent" },
    target: { ...campaignResources.target, workerState: "absent" },
  };
  const receipt = verifyV048ExclusiveCampaignResourceCustody(input({
    campaignResources: resumedCampaign,
    initialWorkerList: {
      total_count: 2,
      workers: input().initialWorkerList.workers.filter(
        (worker) => worker.name !== SOURCE_WORKER && worker.name !== TARGET_WORKER,
      ),
    },
  }));
  assert.equal(receipt.account_workers, 2);
  assert.equal(receipt.campaign_workers_present, 0);
  assert.equal(receipt.campaign_workers_absent, 2);
  assert.notEqual(
    receipt.custody_sha256,
    verifyV048ExclusiveCampaignResourceCustody(input()).custody_sha256,
  );

  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      campaignResources: resumedCampaign,
      initialWorkerList: {
        total_count: 3,
        workers: input().initialWorkerList.workers.filter(
          (worker) => worker.name !== SOURCE_WORKER,
        ),
      },
    })),
    "V048_EXCLUSIVE_CUSTODY_WORKER_LIST_INVALID",
  );
});

test("hashes are stable across set ordering and bind every full binding field", () => {
  const baseline = verifyV048ExclusiveCampaignResourceCustody(input());
  const reorderedEvidence = workerEvidence({
    trafficVersions: [version(SOURCE_VERSION, [
      { type: "kv_namespace", name: "CACHE", namespace_id: "kv-namespace-id" },
      { type: "vectorize", name: "OTHER_VECTOR", index_name: "other-vector-index" },
      { type: "d1", name: "OTHER_DB", database_id: OTHER_D1, id: OTHER_D1 },
    ], { number: 42, metadata: { author_id: "ignored-version-metadata" } })],
    deployments: [deployment(undefined, {
      source: "api",
    })],
  });
  const reorderedList = [...input().initialWorkerList.workers].reverse().map((worker) => ({
    ...worker,
    created_on: "2026-09-12T00:00:00.000Z",
  }));
  const repeated = verifyV048ExclusiveCampaignResourceCustody(input({
    initialWorkerList: { total_count: 4, workers: reorderedList },
    nonCampaignWorkers: [idleEvidence(), reorderedEvidence],
  }));
  assert.equal(repeated.initial_worker_list_sha256, baseline.initial_worker_list_sha256);
  assert.equal(repeated.custody_sha256, baseline.custody_sha256);

  const changed = workerEvidence({
    trafficVersions: [version(SOURCE_VERSION, [
      { type: "d1", name: "OTHER_DB", database_id: OTHER_D1, id: OTHER_D1 },
      { type: "vectorize", name: "OTHER_VECTOR", index_name: "other-vector-index" },
      { type: "kv_namespace", name: "CACHE", namespace_id: "changed-kv-id" },
    ])],
  });
  const changedReceipt = verifyV048ExclusiveCampaignResourceCustody(input({
    nonCampaignWorkers: [changed, idleEvidence()],
  }));
  assert.notEqual(changedReceipt.custody_sha256, baseline.custody_sha256);
});

test("only the latest deployment is traffic-bearing", () => {
  const historical = deployment([
    { percentage: 100, version_id: SECOND_VERSION },
  ], { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  const evidence = workerEvidence({
    deployments: [deployment(), historical],
    trafficVersions: [version(SOURCE_VERSION)],
  });
  const receipt = verifyV048ExclusiveCampaignResourceCustody(input({
    nonCampaignWorkers: [evidence, idleEvidence()],
  }));
  assert.equal(receipt.traffic_versions_inspected, 1);
});

test("extra or malformed custody evidence shapes are refused", () => {
  const extraEvidence = workerEvidence();
  extraEvidence.latestDeployment = deployment();
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      nonCampaignWorkers: [extraEvidence, idleEvidence()],
    })),
    "V048_EXCLUSIVE_CUSTODY_WORKER_COVERAGE_INVALID",
  );

  const extraDeploymentResult = workerEvidence();
  extraDeploymentResult.deploymentList.cursor = "opaque";
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      nonCampaignWorkers: [extraDeploymentResult, idleEvidence()],
    })),
    "V048_EXCLUSIVE_CUSTODY_DEPLOYMENT_INVALID",
  );

  const extraVersionResult = workerEvidence();
  extraVersionResult.trafficVersions[0].bindings = [];
  expectCode(
    () => verifyV048ExclusiveCampaignResourceCustody(input({
      nonCampaignWorkers: [extraVersionResult, idleEvidence()],
    })),
    "V048_EXCLUSIVE_CUSTODY_VERSION_INVALID",
  );
});
