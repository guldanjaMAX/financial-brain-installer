import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmdDeploy,
  cmdUpdate,
  openPromptsForTesting,
  promptsOpenForTesting,
} from "../../brain.mjs";

const mode = process.argv[2];
const root = process.env.HOME;
if (!root) throw new Error("the fixture requires an isolated HOME");
mkdirSync(root, { recursive: true });

const manifestPath = join(root, "brain.manifest.json");
const adminKeyPath = join(root, ".brain-admin-key");
const manifest = {
  client: { slug: "fixture", display_name: "Fixture" },
  brain: {
    version: "0.4.9",
    worker_name: "fixture-brain",
    domain: "fixture.invalid",
  },
  infrastructure: {
    cloudflare: {
      account_id: "00000000000000000000000000000000",
      d1_database_id: "fixture-database",
      storage: "supabase",
    },
  },
  retrieval: { chunk_size: 1500, chunk_overlap: 300 },
  safety: { daily_llm_spend_cap_usd: 1 },
  operations: { admin_key_secret: adminKeyPath },
};
writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
writeFileSync(adminKeyPath, "fixture-admin-key\n", { mode: 0o600 });

// A slow start is not the hang under test; the slow green control uses this.
const startDelayMs = Number(process.env.CLI_EXIT_FIXTURE_DELAY_MS || 0);
if (startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, startDelayMs));

if (mode === "control") {
  console.log("DECISION control completed opened=false prompt_open=false");
} else {
  openPromptsForTesting();
  if (!promptsOpenForTesting()) throw new Error("the readline decision point was not reached");

  if (mode === "update" || mode === "update-warning") {
    await cmdUpdate(manifestPath, {
      discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
      adoptCloudflareAuthProfile: async () => {},
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => {},
      cmdUpgrade: async () => ({ status: "verified" }),
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
      installTechnicianSkills: () => {
        if (mode === "update-warning") throw new Error("fixture local refresh warning");
        return [{ root: ".codex", status: "verified" }];
      },
      reportSkillRefreshOk: () => {},
      reportSkillRefreshWarning: () => {},
    });
  } else if (mode === "deploy" || mode === "deploy-warning") {
    process.env.CLOUDFLARE_API_TOKEN = "fixture-control-token";
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      const method = options.method || "GET";
      let result;
      if (path === "/client/v4/accounts" && method === "GET") {
        result = [{ id: manifest.infrastructure.cloudflare.account_id, name: "Fixture" }];
      } else if (path.endsWith("/workers/scripts/fixture-brain") && method === "PUT") {
        result = {};
      } else if (path.endsWith("/workers/scripts/fixture-brain/subdomain") && method === "POST") {
        if (mode === "deploy-warning") {
          return new Response(JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 1000, message: "fixture route refusal" }],
          }), { status: 403, headers: { "content-type": "application/json" } });
        }
        result = { enabled: true };
      } else if (path.endsWith("/workers/scripts/fixture-brain/subdomain") && method === "GET") {
        result = { enabled: false };
      } else {
        throw new Error(`offline fixture has no response for ${method} ${path}`);
      }
      return new Response(JSON.stringify({ success: true, result, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await cmdDeploy(manifestPath);
  } else {
    throw new Error(`unknown fixture mode: ${mode}`);
  }

  console.log(
    `DECISION ${mode} completed opened=true prompt_open=${promptsOpenForTesting()}`,
  );
}
