import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmdDeploy,
  cmdUpdate,
  dispatchUpdateCli,
  openPromptsForTesting,
  promptsOpenForTesting,
} from "../../brain.mjs";
import {
  buildDailyRefreshDefinition,
  readDailyRefreshUpdateTransaction,
} from "../../operations/daily-refresh-scheduler.mjs";

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
if (mode === "update-daily-attention") {
  manifest.client.timezone = "UTC";
  manifest.corpora = { google_drive: { enabled: true } };
  manifest.operations.daily_refresh = { enabled: true, timezone: "UTC" };
}
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

  if (mode === "update" || mode === "update-warning" || mode === "update-daily-attention") {
    const updateOptions = {
      discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
      adoptCloudflareAuthProfile: async () => {},
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => {},
      cmdUpgrade: async () => ({
        status: "verified",
        daily_final_state: { active: true, query_ready: true, pending: 0 },
      }),
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
      installTechnicianSkills: () => {
        if (mode === "update-warning") throw new Error("fixture local refresh warning");
        return [{ root: ".codex", status: "verified" }];
      },
      reportSkillRefreshOk: () => {},
      reportSkillRefreshWarning: () => {},
    };
    let dailyState = null;
    let dailyPlan = null;
    let dailyHome = null;
    let machineLockRoot = null;
    if (mode === "update-daily-attention") {
      dailyHome = join(root, "daily-home");
      machineLockRoot = join(root, "daily-machine-locks");
      dailyPlan = {
        schema_version: 1,
        identity: { id: "v1-0123456789abcdef", principal: "sid:S-1-5-21-fixture" },
        manifest_path: manifestPath,
        manifest_path_hash: "sha256:path",
        manifest_content_hash: "sha256:content",
        source_plan_hash: "sha256:sources",
        platform: "win32",
        enabled: true,
        ready: true,
        timezone_matches_machine: true,
        unsupported_sources: 0,
        cron: "0 9 * * *",
        timezone: "UTC",
        max_runtime_minutes: 45,
        sources: [{
          key: "google_drive", class: "machine-pull", owner: "daily-task", status: "ready",
          run_key: "google_drive", source_names: ["drive"],
        }],
      };
      const nativeOptions = {
        platform: "win32",
        nodePath: String.raw`C:\Runtime\node.exe`,
        brainPath: String.raw`C:\Runtime\brain.mjs`,
        runnerPath: String.raw`C:\Runtime\daily-refresh-run.mjs`,
      };
      dailyState = {
        exists: true,
        owned: true,
        enabled: true,
        definition: buildDailyRefreshDefinition(dailyPlan, nativeOptions),
      };
      updateOptions.dailyRefreshOptions = {
        platform: "win32",
        existingSchedulerOwners: [],
        planDailyRefresh: async () => dailyPlan,
        schedulerAdapter: {
          read: () => dailyState,
          setEnabled: (_identity, enabled) => {
            if (enabled) throw new Error("fixture daily restore failed");
            dailyState = { ...dailyState, enabled };
          },
          install: (definition) => {
            dailyState = { exists: true, owned: true, enabled: true, definition };
          },
        },
        schedulerOptions: { ...nativeOptions, home: dailyHome, machineLockRoot },
        syncSourceExpectations: false,
      };
    }
    if (mode === "update-daily-attention") {
      await dispatchUpdateCli([manifestPath], { updateOptions });
      const recovery = readDailyRefreshUpdateTransaction(dailyPlan.identity, {
        home: dailyHome,
        manifestPath,
        machineLockRoot,
      });
      console.log(`DECISION daily-attention recovery=${Boolean(recovery)} enabled=${dailyState.enabled}`);
    } else {
      await cmdUpdate(manifestPath, updateOptions);
    }
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
