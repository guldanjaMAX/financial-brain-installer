import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  V048_DISPOSABLE_CAMPAIGN,
  V048_DISPOSABLE_CAMPAIGN_ARTIFACT_KEY_LOCATOR,
  V048_DISPOSABLE_CAMPAIGN_CORPORA,
  V048_DISPOSABLE_CAMPAIGN_SOURCE_ADMIN_KEY_LOCATOR,
  V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME,
  V048_DISPOSABLE_CAMPAIGN_TARGET_ADMIN_KEY_LOCATOR,
  V048_DISPOSABLE_CAMPAIGN_TARGET_NAME,
  assertV048DisposableCampaignManifestPair,
  validateV048DisposableCampaignManifest,
} from "../operations/v048-disposable-campaign-contract.mjs";

const ACCOUNT_ID = "a".repeat(32);
const SOURCE_D1_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_D1_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function campaignManifest(role) {
  const source = role === "source";
  const name = source
    ? V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME
    : V048_DISPOSABLE_CAMPAIGN_TARGET_NAME;
  return {
    manifest_version: 1,
    client: {
      slug: V048_DISPOSABLE_CAMPAIGN.clientSlug,
      display_name: V048_DISPOSABLE_CAMPAIGN.displayName,
    },
    brain: {
      version: V048_DISPOSABLE_CAMPAIGN.version,
      worker_name: name,
      domain: `${name}.fixture-account.workers.dev`,
    },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        storage: "d1",
        d1_database_name: name,
        d1_database_id: source ? SOURCE_D1_ID : TARGET_D1_ID,
        vectorize_index: name,
      },
    },
    retrieval: {
      embed_model: V048_DISPOSABLE_CAMPAIGN.retrieval.embedModel,
      embed_dimensions: V048_DISPOSABLE_CAMPAIGN.retrieval.embedDimensions,
    },
    corpora: Object.fromEntries(V048_DISPOSABLE_CAMPAIGN_CORPORA.map((key) => [key, { enabled: false }])),
    operations: source ? {
      admin_key_secret: V048_DISPOSABLE_CAMPAIGN_SOURCE_ADMIN_KEY_LOCATOR,
    } : {
      admin_key_secret: V048_DISPOSABLE_CAMPAIGN_TARGET_ADMIN_KEY_LOCATOR,
      recovery_artifact_key_secret: V048_DISPOSABLE_CAMPAIGN_ARTIFACT_KEY_LOCATOR,
      recovery_field_gate: {
        paused_worker_version_id: "fixture-paused-version-id",
        active_worker_version_id: "fixture-active-version-id",
        worker_script_etag: "d".repeat(64),
        routes: [],
        custom_domains: [],
        reviewed_at: "2026-09-12T12:00:00.000Z",
      },
    },
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => error?.code === code);
}

test("the dependency-free module exposes and validates the one exact campaign", () => {
  const modulePath = fileURLToPath(new URL(
    "../operations/v048-disposable-campaign-contract.mjs",
    import.meta.url,
  ));
  assert.doesNotMatch(readFileSync(modulePath, "utf8"), /^import\s/m);
  assert.equal(Object.isFrozen(V048_DISPOSABLE_CAMPAIGN), true);
  assert.equal(Object.isFrozen(V048_DISPOSABLE_CAMPAIGN.source), true);
  assert.equal(Object.isFrozen(V048_DISPOSABLE_CAMPAIGN.target), true);

  const pair = assertV048DisposableCampaignManifestPair(
    campaignManifest("source"),
    campaignManifest("target"),
  );
  assert.equal(pair.source.accountId, ACCOUNT_ID);
  assert.equal(pair.target.accountId, ACCOUNT_ID);
  assert.equal(pair.source.displayName, V048_DISPOSABLE_CAMPAIGN.displayName);
  assert.equal(pair.target.displayName, V048_DISPOSABLE_CAMPAIGN.displayName);
  assert.deepEqual(
    [pair.source.workerName, pair.source.databaseName, pair.source.vectorizeIndex],
    Array(3).fill(V048_DISPOSABLE_CAMPAIGN_SOURCE_NAME),
  );
  assert.deepEqual(
    [pair.target.workerName, pair.target.databaseName, pair.target.vectorizeIndex],
    Array(3).fill(V048_DISPOSABLE_CAMPAIGN_TARGET_NAME),
  );
});
test("wrong role, resource name, account, locator, version, and slug are refused", () => {
  expectCode(
    () => validateV048DisposableCampaignManifest(campaignManifest("target"), "source"),
    "V048_CAMPAIGN_ROLE_RESOURCE_MISMATCH",
  );

  for (const field of ["worker_name", "d1_database_name", "vectorize_index"]) {
    const manifest = campaignManifest("source");
    if (field === "worker_name") manifest.brain[field] = `${manifest.brain[field]}-wrong`;
    else manifest.infrastructure.cloudflare[field] = `${manifest.infrastructure.cloudflare[field]}-wrong`;
    expectCode(
      () => validateV048DisposableCampaignManifest(manifest, "source"),
      "V048_CAMPAIGN_RESOURCE_NAME_MISMATCH",
    );
  }

  const otherAccount = campaignManifest("target");
  otherAccount.infrastructure.cloudflare.account_id = "e".repeat(32);
  expectCode(
    () => assertV048DisposableCampaignManifestPair(campaignManifest("source"), otherAccount),
    "V048_CAMPAIGN_ACCOUNT_MISMATCH",
  );

  const nonUuidD1 = campaignManifest("source");
  nonUuidD1.infrastructure.cloudflare.d1_database_id = "b".repeat(32);
  expectCode(
    () => validateV048DisposableCampaignManifest(nonUuidD1, "source"),
    "V048_CAMPAIGN_RESOURCE_ID_INVALID",
  );

  const sourceLocator = campaignManifest("source");
  sourceLocator.operations.admin_key_secret = "keychain://wrong/owner";
  expectCode(
    () => validateV048DisposableCampaignManifest(sourceLocator, "source"),
    "V048_CAMPAIGN_ADMIN_KEY_LOCATOR_MISMATCH",
  );
  const targetLocator = campaignManifest("target");
  targetLocator.operations.recovery_artifact_key_secret = "keychain://wrong/artifact-v1";
  expectCode(
    () => validateV048DisposableCampaignManifest(targetLocator, "target"),
    "V048_CAMPAIGN_ARTIFACT_KEY_LOCATOR_MISMATCH",
  );

  const wrongVersion = campaignManifest("source");
  wrongVersion.brain.version = "0.4.7";
  expectCode(
    () => validateV048DisposableCampaignManifest(wrongVersion, "source"),
    "V048_CAMPAIGN_PRODUCT_VERSION_MISMATCH",
  );
  const wrongSlug = campaignManifest("source");
  wrongSlug.client.slug = "another-campaign";
  expectCode(
    () => validateV048DisposableCampaignManifest(wrongSlug, "source"),
    "V048_CAMPAIGN_CLIENT_SLUG_MISMATCH",
  );
});

test("R2, KV, route, custom-domain, and generic binding fields are refused", async (t) => {
  const cases = [
    ["R2", (manifest) => { manifest.infrastructure.cloudflare.r2_bucket = null; }],
    ["KV", (manifest) => { manifest.infrastructure.cloudflare.kv_namespace = "unused"; }],
    ["route", (manifest) => { manifest.infrastructure.cloudflare.routes = []; }],
    ["custom domain", (manifest) => { manifest.brain.custom_domain = null; }],
    ["generic bindings", (manifest) => { manifest.bindings = []; }],
    ["nonempty target route attestation", (manifest) => {
      manifest.operations.recovery_field_gate.routes = ["example.invalid/*"];
    }],
    ["nonempty target custom-domain attestation", (manifest) => {
      manifest.operations.recovery_field_gate.custom_domains = ["example.invalid"];
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const role = name.startsWith("nonempty") ? "target" : "source";
      const manifest = campaignManifest(role);
      mutate(manifest);
      expectCode(
        () => validateV048DisposableCampaignManifest(manifest, role),
        "V048_CAMPAIGN_EXTRA_PROVIDER_BINDING_REFUSED",
      );
    });
  }
});
