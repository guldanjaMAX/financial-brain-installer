import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdUpdate } from "../brain.mjs";

test("a representative update keeps every owner-home write inside injected fixture roots", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-home-isolation-"));
  const fakeHome = join(sandbox, "fake-real-home");
  const installedState = join(sandbox, "installed-state");
  const skillHome = join(sandbox, "skill-home");
  const manifestPath = join(sandbox, "brain.manifest.json");
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  const productVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  writeFileSync(manifestPath, `${JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Fixture", timezone: "UTC" },
    brain: {
      version: productVersion,
      domain: "fixture.invalid",
      worker_name: "fixture-brain",
    },
    infrastructure: {
      cloudflare: {
        account_id: "a".repeat(32),
        auth_profile: `financial-brain-${"b".repeat(24)}`,
        storage: "d1",
        d1_database_id: "11111111-2222-4333-8444-555555555555",
        vectorize_index: "fixture-brain",
      },
    },
  }, null, 2)}\n`);

  const reached = { lifecycle: 0, verify: 0, upgrade: 0 };
  try {
    await cmdUpdate(manifestPath, {
      withBrainLifecycleLockWait: async (_request, operation) => {
        reached.lifecycle += 1;
        return operation();
      },
      discoverInstalledManifest: () => ({ path: manifestPath, source: "explicit" }),
      installedManifestOptions: { stateDirectory: installedState },
      readUpdateBacklog: async () => ({ pending: 0 }),
      adoptCloudflareAuthProfile: async () => {},
      withCloudflareControl: async (operation) => operation(),
      cmdVerify: async () => { reached.verify += 1; },
      cmdUpgrade: async () => {
        reached.upgrade += 1;
        return { status: "verified" };
      },
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
      claudeSkillOptions: { home: skillHome, agentRoots: [".claude"] },
      reportSkillRefreshOk: () => {},
      reportSkillRefreshWarning: () => {},
      reportUpdateFinish: () => {},
    });

    assert.deepEqual(reached, { lifecycle: 1, verify: 1, upgrade: 1 },
      "the no-write assertion must follow a completed update decision path");
    assert.equal(
      existsSync(join(installedState, "installed-manifest.json")),
      true,
      "the green control must prove the installed-manifest write reached its injected state directory",
    );
    assert.equal(
      existsSync(join(skillHome, ".claude", "skills", "financial-brain-technician", "SKILL.md")),
      true,
      "the green control must prove the skill refresh reached its injected home",
    );
    assert.deepEqual(readdirSync(fakeHome), [],
      "a completed update must not write to the ambient fake real home");
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
