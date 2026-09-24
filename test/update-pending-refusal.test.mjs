import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyCliCredentialBoundary,
  cmdUpdate,
  dispatchUpdateCli,
  readUpdateBacklog,
  updateCommandTarget,
} from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const PENDING_MESSAGE = (pending) => renderCliCommands(
  `This Brain is still processing ${pending} queued search update(s). Updating now would pause it mid-queue. ` +
    "Nothing was changed. Wait until `brain health` says query-ready, then run the update again.",
);

const UNREADABLE_MESSAGE = renderCliCommands(
  "The authenticated documents backlog read failed, so this Brain's queued search updates could not be read. " +
    "Updating now could pause it mid-queue. Nothing was changed. Fix the failed read, wait until `brain health` " +
    "says query-ready, then run the update again.",
);

const FORCE_WARNING = (pending) => renderCliCommands(
  `This Brain is still processing ${pending} queued search update(s). ` +
    "`--force` will update anyway and may pause it mid-queue.",
);

function fixtureManifest() {
  return {
    client: { slug: "fixture" },
    brain: { version: "0.4.7", domain: "brain.example.invalid" },
    infrastructure: {
      cloudflare: {
        account_id: "1".repeat(32),
        auth_profile: `financial-brain-${"2".repeat(24)}`,
        storage: "d1",
        d1_database_id: "11111111-2222-4333-8444-555555555555",
      },
    },
  };
}

function updateHarness(manifestPath, readUpdateBacklog, events) {
  return {
    discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
    readUpdateBacklog: async (...args) => {
      events.push("authenticated documents backlog read");
      return readUpdateBacklog(...args);
    },
    adoptCloudflareAuthProfile: async () => {
      events.push("profile adoption");
    },
    withCloudflareControl: async (action) => {
      events.push("control boundary");
      return action();
    },
    cmdVerify: async () => {
      events.push("verification");
    },
    cmdUpgrade: async () => {
      events.push("paused vector-drain deployment");
      return { updated: true };
    },
    reconcileExistingOwnerAgents: null,
    writeClaudeWorkspaceGuideAfterUpdate: null,
    installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
    reportSkillRefreshOk: () => {},
    reportSkillRefreshWarning: () => {},
  };
}

async function withFixture(run) {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-update-pending-"));
  const manifestPath = join(sandbox, "brain.manifest.json");
  const original = `${JSON.stringify(fixtureManifest(), null, 2)}\n`;
  writeFileSync(manifestPath, original);
  try {
    await run({ manifestPath, original });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("pending vector work refuses before adoption, verification, deployment, or a manifest write", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, updateHarness(
        manifestPath,
        async () => ({ pending: 7 }),
        events,
      ));
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, PENDING_MESSAGE(7));
    assert.deepEqual(events, ["authenticated documents backlog read"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("an unreadable backlog fails closed and names the failed read", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, updateHarness(
        manifestPath,
        async () => {
          throw new Error("private transport detail must not escape");
        },
        events,
      ));
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, UNREADABLE_MESSAGE);
    assert.doesNotMatch(error?.message || "", /private transport detail/);
    assert.deepEqual(events, ["authenticated documents backlog read"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("an empty backlog reaches the paused-deployment stage", async () => {
  await withFixture(async ({ manifestPath }) => {
    const events = [];
    const result = await cmdUpdate(manifestPath, updateHarness(
      manifestPath,
      async () => ({ pending: 0 }),
      events,
    ));

    assert.deepEqual(result, { updated: true });
    assert.deepEqual(events, [
      "authenticated documents backlog read",
      "profile adoption",
      "control boundary",
      "verification",
      "paused vector-drain deployment",
    ]);
  });
});

test("force with pending work proceeds after one risk warning", async () => {
  await withFixture(async ({ manifestPath }) => {
    const events = [];
    const output = [];
    const priorLog = console.log;
    console.log = (...values) => output.push(values.map(String).join(" "));
    let result;
    try {
      result = await dispatchUpdateCli([manifestPath, "--force"], {
        updateOptions: updateHarness(manifestPath, async () => ({ pending: 3 }), events),
      });
    } finally {
      console.log = priorLog;
    }

    assert.deepEqual(result, { updated: true });
    assert.equal(
      output.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
        .filter((line) => line.includes(FORCE_WARNING(3))).length,
      1,
    );
    assert.equal(events.at(-1), "paused vector-drain deployment");
  });
});

test("the production reader uses the authenticated documents aggregate without normalizing pending", async () => {
  await withFixture(async ({ manifestPath }) => {
    const calls = [];
    const receipt = await readUpdateBacklog(manifestPath, {
      resolveAdminKey: (path, options) => {
        calls.push({ stage: "credential", path, options });
        return "unit-test-admin-key";
      },
      http: async (url, init, options) => {
        calls.push({ stage: "request", url, init, options });
        return {
          ok: true,
          json: async () => ({ vector_backlog: { pending: 4 } }),
        };
      },
    });

    assert.deepEqual(receipt, { pending: 4 });
    assert.equal(calls[0].path, manifestPath);
    assert.deepEqual(calls[0].options, { ignoreEnvironment: true });
    assert.equal(calls[1].url, "https://brain.example.invalid/api/admin/brain/documents");
    assert.equal(calls[1].init.headers["X-Admin-Key"], "unit-test-admin-key");
    assert.equal(calls[1].options.what, "the update backlog check");
  });
});

test("the production reader rejects an error receipt instead of guessing zero", async () => {
  await withFixture(async ({ manifestPath }) => {
    await assert.rejects(
      readUpdateBacklog(manifestPath, {
        resolveAdminKey: () => "unit-test-admin-key",
        http: async () => ({
          ok: true,
          json: async () => ({ vector_backlog: { pending: 0, error: "private detail" } }),
        }),
      }),
      (error) => error?.message === "authenticated documents backlog read failed" &&
        !error.message.includes("private detail"),
    );
  });
});

test("the force switch remains on the live update boundary and is documented", () => {
  for (const argv of [
    ["--force"],
    ["brain.manifest.json", "--force"],
    ["--force", "brain.manifest.json"],
    ["brain.manifest.json", "--adopt-cloudflare-profile", "--force"],
  ]) {
    assert.equal(classifyCliCredentialBoundary("update", argv), "update");
  }
  assert.equal(updateCommandTarget("--force", { force: "brain.manifest.json" }), "brain.manifest.json");

  const help = spawnSync(process.execPath, [fileURLToPath(new URL("../brain.mjs", import.meta.url)), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(renderCliCommands("brain update     [manifest] --force")));
  assert.match(help.stdout, /queued search update/);
});
