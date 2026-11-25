import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workerBindings } from "../../brain.mjs";

// Read after provision: setup pins those saved bindings, including a newly
// recorded database or address. Never use a stale pre-provision template.
export function setupSettingsProofFixture(manifestPath, {
  account,
  version = "0.1.14",
  writerProtocol = "legacy",
}) {
  const reads = { account: 0, settings: 0, health: 0, liveProbe: 0 };
  const savedManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
  const options = {
    resolveExistingWorkerProbeDomain: async () => {
      const domain = savedManifest().brain.domain;
      assert.ok(domain, "the fixture must save an address before probing");
      return domain;
    },
    probeExistingWorkerHealth: async () => {
      reads.liveProbe++;
      return writerProtocol === "lease-v1" ? { version, acceptingDocuments: true } : null;
    },
    probeExistingWorkerDrainMode: async () => "active",
    setupSettingsProofOptions: {
      resolveAccount: async (manifest) => {
        reads.account++;
        assert.deepEqual(manifest, savedManifest(), "proof uses the exact saved manifest");
        assert.equal(manifest.infrastructure.cloudflare.account_id, account.id);
        return account;
      },
      cf: async (route) => {
        reads.settings++;
        const manifest = savedManifest();
        assert.equal(route, `/accounts/${account.id}/workers/scripts/${manifest.brain.worker_name}/settings`);
        const bindings = workerBindings(manifest, manifest.infrastructure.cloudflare)
          .map((binding) => ({ ...binding }));
        bindings.find((binding) => binding.name === "BRAIN_VERSION").text = version;
        // Settings expose secret names and types only, never values.
        bindings.push({ name: "ADMIN_KEY", type: "secret_text" },
          { name: "ANTHROPIC_API_KEY", type: "secret_text" });
        return { bindings };
      },
      http: async (url) => {
        reads.health++;
        const manifest = savedManifest();
        assert.equal(url, `https://${manifest.brain.domain}/health`);
        return { ok: true, text: async () => JSON.stringify({
          ok: true, brain: manifest.client.slug, version,
          accepting_documents: true, vector_writer_protocol: writerProtocol,
          vector_drain_mode: "active", rollback_write_fence: false,
        }) };
      },
    },
  };
  return {
    options,
    reads,
    assertReads(expected = 1) {
      assert.equal(reads.account, expected, "metadata proof resolves only the synthetic account");
      assert.equal(reads.settings, expected, "metadata proof must reach the exact settings read");
      assert.equal(reads.health, expected, "metadata proof must reach the matching health read");
    },
  };
}
