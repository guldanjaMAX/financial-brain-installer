import assert from "node:assert/strict";
import test from "node:test";

import { prepareCloudflareAccountCeremony, setupLocalPreflightChecks } from "../brain.mjs";

import {
  chooseCloudflareAccountPath,
  cloudflareAccountPlan,
  normalizeCloudflareAccountPath,
} from "../operations/cloudflare-account-bootstrap.mjs";

test("the first-account and existing-account paths converge without claiming an account action", () => {
  const created = cloudflareAccountPlan("create");
  const existing = cloudflareAccountPlan("existing");
  assert.match(created.start_url, /cloudflare\.com\/sign-up/);
  assert.match(existing.start_url, /cloudflare\.com\/login/);
  assert.equal(created.convergence, existing.convergence);
  assert.match(created.multi_brain, /many separate Brains/i);
  assert.match(existing.multi_brain, /own Worker, D1 database, Vectorize index/i);
  for (const plan of [created, existing]) {
    assert.equal(plan.boundaries.provisioning, "not_started_by_this_plan");
    assert.equal(plan.boundaries.credential_storage, "wrangler_os_keyring");
    assert.equal(plan.boundaries.workers_paid_confirmation, "owner_confirmed_before_provisioning");
    assert.equal(plan.boundaries.plan_visibility, "owner_dashboard_only_not_narrow_session");
    assert.match(plan.human_steps.join(" "), /Workers & Pages > Plans.*say Paid.*before setup creates anything/i);
    assert.doesNotMatch(JSON.stringify(plan), /api[_-]?token|client_secret|CLOUDFLARE_API_TOKEN|email@/i);
  }
});

test("the account path is explicit, friendly to uppercase input, and validated before use", async () => {
  assert.equal(normalizeCloudflareAccountPath(" Existing "), "existing");
  assert.equal(normalizeCloudflareAccountPath(""), null);
  assert.throws(() => normalizeCloudflareAccountPath("somewhere-else", { required: true }), /create or existing/);
  assert.equal(await chooseCloudflareAccountPath(async () => "CREATE"), "create");
  let prompted = false;
  assert.equal(await chooseCloudflareAccountPath(async () => { prompted = true; }, "existing"), "existing");
  assert.equal(prompted, false);
});

test("setup requires an explicit Workers Paid dashboard confirmation before provisioning", async () => {
  const lines = [];
  const prompts = [];
  const plan = await prepareCloudflareAccountCeremony({
    accountPath: "existing",
    openBrowserImpl: url => {
      assert.match(url, /cloudflare\.com\/login/);
      return true;
    },
    askFn: async question => {
      prompts.push(question);
      return "PAID";
    },
    write: line => lines.push(line),
  });
  assert.equal(plan.path, "existing");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /before setup creates anything.*Workers & Pages > Plans > Paid/i);
  assert.match(lines.join("\n"), /narrow sign-in cannot read billing status/i);
  assert.match(lines.join("\n"), /No Cloudflare resource has been created yet/i);

  await assert.rejects(
    prepareCloudflareAccountCeremony({
      accountPath: "create",
      openBrowserImpl: () => true,
      askFn: async () => "",
      write: () => {},
    }),
    /stopped before creating any Cloudflare resource.*billing approval belongs to the owner/i,
  );
});

test("the automation and recovery token lane cannot bypass machine prerequisites", async () => {
  const calls = [];
  const checks = await setupLocalPreflightChecks({
    tokenPath: true,
    platformName: "win32",
    environment: { LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local" },
    cliPath: "C:\\Fixture\\brain.mjs",
    doctor: async () => { throw new Error("the token lane must not run provider preflight"); },
    nodeCheck: () => { calls.push("node"); return { name: "Node", status: "ok" }; },
    driveCheck: options => {
      calls.push("drive");
      assert.equal(options.platformName, "win32");
      assert.equal(options.environment.LOCALAPPDATA, "C:\\Users\\Fixture\\AppData\\Local");
      return { name: "Install drive", status: "fail" };
    },
    privilegeCheck: options => {
      calls.push("privilege");
      assert.equal(options.platformName, "win32");
      return { name: "Install session", status: "ok" };
    },
  });
  assert.deepEqual(calls, ["node", "drive", "privilege"]);
  assert.deepEqual(checks.map(check => check.status), ["ok", "fail", "ok"]);

  let normalOptions = null;
  await setupLocalPreflightChecks({
    tokenPath: false,
    skipConnections: true,
    doctor: async options => { normalOptions = options; return []; },
  });
  assert.equal(normalOptions.skipCloudflare, true);
  assert.equal(normalOptions.requireClaudeCode, false);
});
