import "../update-faults-boundaries.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFaultFixture } from "../update-faults-fixture.mjs";
import { createUpgradeBookmarkWriter } from "./upgrade-bookmark-writer.mjs";

export const SWITCH_LINE = "Your Brain uses an older Claude model name (claude-sonnet-5). This update switches it to the current pair: Opus answers, Sonnet checks. Same key, same data.";
export const REFUSAL = "This model name isn't supported for updates yet. Nothing was changed. Contact your partner.";
export const PAIR = Object.freeze({ answer_model: "claude-opus-5-5", gate_model: "claude-sonnet-5-5" });
export const SHA = "a".repeat(64);

export function modelSwitchFixture(root) {
  const f = createFaultFixture(root);
  const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  manifest.brain.version = "0.4.17";
  manifest.infrastructure.cloudflare.vectorize_index = "fixture-index";
  manifest.retrieval = { answer_model: "claude-sonnet-5", chunk_size: 900, rerank: false };
  manifest.safety = { daily_llm_spend_cap_usd: 7 };
  manifest.testing = { probe_questions: ["What is recorded?"] };
  writeFileSync(f.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(root, ".brain-admin-key"), ["fixture", "local", "admin", "value", "only"].join("-"), { mode: 0o600 });
  const db = new DatabaseSync(f.databasePath);
  db.exec("UPDATE install_state SET product_version = '0.4.17'");
  return { ...f, manifest, db };
}

export function readyInventory(version) {
  return {
    version, backend: "d1", vector_drain_mode: "active",
    rows: [{ source_type: "curated", total: 1, embedded: 1 }],
    vector_backlog: { pending: 0, pending_is_capped: false, pending_display: "0", upserts: 0, deletes: 0, submitted: 0, component_counts_exact: true, oldest_queued_at: null },
    vector_readiness: { ready: true, reason: null, expected_vectors: 1, actual_vectors: 1, pending: 0, pending_is_capped: false, submitted: 0, submitted_counts_exact: true, oldest_queued_at: null },
  };
}

export function previewOptions(f, write) {
  return {
    runtimeRoot: f.root, runtimeAllowlist: ["brain.mjs"],
    verifyRuntime: () => ({ schema_version: 1, identity_scheme: "brain.runtime-payload.sha256.v1", runtime_payload_sha256: SHA, file_count: 1, total_bytes: 1, expected_runtime_sha256: SHA, verified_passes: 2 }),
    pinRuntimePackage: () => ({ manifest: { name: "brain-installer", version: f.targetVersion } }),
    discoverInstalledManifest: () => ({ path: f.manifestPath, source: "explicit" }),
    validateManifest: () => ({ recordedVersion: "0.4.17", credential_reference: "adjacent_protected_file" }),
    revalidateRuntimePackage: () => {},
    resolveAdminKey: () => ["fixture", "admin"].join("-"),
    withKeyPreflightCloudflare: async action => action(),
    answerKeyOptions: { cf: async () => [{ name: "ANTHROPIC_API_KEY", type: "secret_text" }] },
    request: async () => Response.json(readyInventory("0.4.17")),
    write,
  };
}

export function updateAdapters(f, { interrupt = false } = {}) {
  const calls = [], uploads = [], secretWrites = [], lines = [];
  const bookmark = createUpgradeBookmarkWriter();
  const originalBytes = readFileSync(f.manifestPath);
  const query = async (_account, _database, sql, params = []) => ({ results: f.db.prepare(sql).all(...params) });
  const response = (result) => Response.json({ success: true, result });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method || "GET";
    calls.push(`${method} ${path}`);
    if (new URL(url).hostname === "api.cloudflare.com") {
      if (path.endsWith("/secrets") && method !== "GET") {
        secretWrites.push(method);
        throw new Error("fixture refuses every secret write");
      }
      if (path === "/client/v4/accounts") return response([{ id: "fixture-account", name: "Fixture" }]);
      if (path.endsWith("/workers/scripts/fixture-brain") && method === "PUT") {
        const metadata = JSON.parse(await init.body.get("metadata").text());
        uploads.push(metadata);
        assert.deepEqual(readFileSync(f.manifestPath), originalBytes, "deploy must not persist the model switch");
        return response({});
      }
      if (path.endsWith("/secrets")) return response([{ name: "ANTHROPIC_API_KEY", type: "secret_text" }]);
      if (path.endsWith("/schedules")) return response([{ cron: "* * * * *" }]);
      if (path.endsWith("/subdomain")) return response({ enabled: true });
      if (path.endsWith("/query")) {
        const body = JSON.parse(init.body);
        return response([await query(null, null, body.sql, body.params)]);
      }
      throw new Error("unexpected fake control-plane request");
    }
    assert.equal(new URL(url).hostname, "brain.example.invalid");
    if (path === "/health") return Response.json({ ok: true, version: f.targetVersion });
    const authorized = new Headers(init.headers).get("X-Admin-Key") === readFileSync(join(f.root, ".brain-admin-key"), "utf8");
    if (!authorized) return Response.json({}, { status: 401 });
    if (path.endsWith("/documents")) return Response.json(readyInventory(f.targetVersion));
    if (path.endsWith("/freshness")) return Response.json({ backend: "d1", sources: [] });
    if (path.endsWith("/ingest")) return Response.json({ error: "refused: content carries live credential(s)", labels: ["cloudflare_token_new"], detail: "Rotate them, strip them from the source, then re-ingest. Nothing was written." }, { status: 422 });
    const candidate = { title: "Synthetic record", source: "fixture", chunk_uid: "fixture:record#0" };
    if (path === "/api/rag/unified") return Response.json({ results: [candidate] });
    if (path === "/api/rag/think") {
      if (interrupt) throw new Error("fixture interruption after deploy");
      const model = uploads.at(-1).bindings.find((binding) => binding.name === "ANSWER_MODEL").text;
      return Response.json({ mode: "think", model, answer: "Synthetic record [1].", citations: [{ n: 1, title: candidate.title, source: candidate.source }], results: [candidate], gaps: [], evidence_gate: { supported: true, complete: true, evidence: [1] } });
    }
    throw new Error("unexpected fake Worker request");
  };
  return {
    calls, uploads, secretWrites, lines, fetchImpl, originalBytes,
    options: {
      lifecycleLockHeld: true,
      discoverInstalledManifest: () => { calls.push("discover"); return { path: f.manifestPath }; },
      answerSetupNeedsRecovery: () => false,
      adoptCloudflareAuthProfile: async () => { calls.push("adopt"); },
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => { calls.push("verify"); },
      dailyRefreshOptions: { platform: "linux" },
      upgradeOptions: {
        resolveAccount: async () => ({ id: "fixture-account" }), d1Query: query,
        cf: async () => ({ bookmark: "fixture-before-update" }),
        saveUpgradeBookmark: bookmark.saveUpgradeBookmark,
        readUpdateBacklog: async () => ({ pending: 0 }),
        waitForVectorDrainQuiescence: async () => {},
        cmdMigrate: async () => { calls.push("migrate"); },
        cmdBootstrap: async () => ({ epoch: 1, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true }),
        cmdHealth: async () => { calls.push("health"); }, cmdDrain: async () => { calls.push("drain"); },
      },
    },
  };
}
