import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUpgradeBookmarkWriter } from "./upgrade-bookmark-writer.mjs";
import { validateBankProviderManifest } from "../../operations/bank-provider-command.mjs";

// Used by the full lifecycle suite and a light offline lane test. All provider,
// scheduler and credential boundaries are injected; the upgrade itself is real.
export async function verifyDomainUpgradeCases(cmdUpgrade) {
  const dir = mkdtempSync(join(tmpdir(), "domain-upgrade-"));
  const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  const schema = JSON.parse(readFileSync(new URL("../../manifest.schema.json", import.meta.url), "utf8"));
  try {
    for (const arm of ["missing", "existing", "custom", "denied"]) {
      const path = join(dir, `${arm}.json`);
      const manifest = { manifest_version: 1, client: { slug: "fixture", display_name: "Owner" },
        brain: { version: "0.1.9", worker_name: "fixture-brain" },
        infrastructure: { cloudflare: { account_id: "a".repeat(32),
          d1_database_id: "11111111-2222-4333-8444-555555555555", storage: "d1" } } };
      if (arm === "existing") manifest.brain.domain = "saved.owner-subdomain.workers.dev";
      if (arm === "custom") manifest.brain.domain = "brain.example.invalid";
      writeFileSync(path, JSON.stringify(manifest));
      const bookmark = createUpgradeBookmarkWriter();
      const lines = []; let reads = 0, probes = 0, deploys = 0, health = 0, committedVersion;
      await cmdUpgrade(path, {
        resolveAccount: async () => ({ id: manifest.infrastructure.cloudflare.account_id }),
        d1Query: async (_account, _db, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [] };
          if (/UPDATE install_state/i.test(sql)) committedVersion = version;
          if (/SELECT product_version/i.test(sql)) return { results: [{ product_version: committedVersion }] };
          return { results: [] };
        },
        cf: async request => { assert.match(request, /time_travel\/bookmark$/); return { bookmark: "fixture-bookmark" }; },
        saveUpgradeBookmark: bookmark.saveUpgradeBookmark,
        waitForVectorDrainQuiescence: async () => {},
        readUpdateBacklog: async () => ({ pending: 0 }),
        cmdMigrate: async () => {},
        cmdDeploy: async (_path, options) => { deploys++; assert.equal(options.persistDomain, false); },
        cmdBootstrap: async () => ({ epoch: 1, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true }),
        cmdDrain: async () => {}, reconcileWorkerProviderSecrets: async () => {},
        cmdHealth: async () => { health++; }, cmdTest: async () => {},
        domainSaveOptions: {
          readSubdomain: async () => {
            reads++; assert.ok(deploys > 0); assert.ok(health > 0);
            if (arm === "denied") throw new Error("GET failed (403): 10000");
            return { subdomain: "owner-subdomain" };
          },
          verifyWorkersDevCandidate: async () => { probes++; return { ok: true }; },
          report: line => lines.push(line),
        },
      });
      bookmark.assertCalled();
      assert.equal(deploys, 2); assert.ok(health >= 2);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(saved.brain.version, version);
      if (arm === "missing") {
        assert.equal(saved.brain.domain, "fixture-brain.owner-subdomain.workers.dev");
        assert.equal(reads, 1); assert.equal(probes, 1);
      } else if (arm === "denied") {
        assert.equal(Object.hasOwn(saved.brain, "domain"), false);
        assert.equal(reads, 1); assert.equal(probes, 0);
        assert.equal(lines.length, 1); assert.match(lines[0], /BRAIN_DOMAIN_NOT_SAVED/);
        assert.doesNotMatch(lines[0], /paste|token|recovery|sign in/i);
      } else {
        assert.equal(saved.brain.domain, manifest.brain.domain); assert.equal(reads, 0); assert.equal(probes, 0);
      }
      validateBankProviderManifest(saved, schema);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
