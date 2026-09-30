import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  confirmCloudflareWorkersPaidAccount,
  createSetupControlAction,
  prepareCloudflareAccountCeremony,
  setupLocalPreflightChecks,
} from "../brain.mjs";

import {
  chooseCloudflareAccountPath,
  cloudflareAccountPlan,
  cloudflareWorkersPlanUrl,
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
    assert.equal(plan.boundaries.exact_account_selection, "api_verified_then_owner_plan_confirmed");
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

test("the account preparation step does not claim billing proof before OAuth verifies the account", async () => {
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
      return "";
    },
    write: line => lines.push(line),
  });
  assert.equal(plan.path, "existing");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /after the Cloudflare account is ready/i);
  assert.match(lines.join("\n"), /verifies the exact account first/i);
  assert.doesNotMatch(lines.join("\n"), /Paid confirmed/i);
});

test("Workers Paid confirmation is bound to the exact verified account before provisioning", async () => {
  const accountId = "a".repeat(32);
  const account = { id: accountId, name: "Fixture Owner" };
  const lines = [];
  const prompts = [];
  let opened = null;
  const proof = await confirmCloudflareWorkersPaidAccount(account, {
    interactive: true,
    openBrowserImpl: url => { opened = url; return true; },
    askFn: async question => { prompts.push(question); return "paid"; },
    write: line => lines.push(line),
  });
  assert.equal(opened, cloudflareWorkersPlanUrl(accountId));
  assert.match(opened, new RegExp(accountId));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Fixture Owner/);
  assert.match(prompts[0], new RegExp(accountId));
  assert.match(prompts[0], /Workers & Pages > Plans > Paid/i);
  assert.deepEqual(proof, { account_id: accountId, confirmation: "owner_dashboard" });
  assert.match(lines.join("\n"), /exact verified account.*No Cloudflare resource has been created yet/i);

  await assert.rejects(
    confirmCloudflareWorkersPaidAccount(account, {
      interactive: true,
      openBrowserImpl: () => true,
      askFn: async () => "",
      write: () => {},
    }),
    /stopped before creating any Cloudflare resource.*exact account.*billing approval belongs to the owner/i,
  );
});

test("unattended setup requires an account-bound Workers Paid confirmation", async () => {
  const accountId = "b".repeat(32);
  const account = { id: accountId, name: "Fixture Automation" };
  let opened = false;
  const proof = await confirmCloudflareWorkersPaidAccount(account, {
    interactive: false,
    environment: { BRAIN_WORKERS_PAID_ACCOUNT_ID: accountId.toUpperCase() },
    openBrowserImpl: () => { opened = true; return true; },
    write: () => {},
  });
  assert.equal(opened, false, "unattended setup must not launch a browser");
  assert.deepEqual(proof, { account_id: accountId, confirmation: "account_bound_automation" });

  await assert.rejects(
    confirmCloudflareWorkersPaidAccount(account, {
      interactive: false,
      environment: { BRAIN_WORKERS_PAID_ACCOUNT_ID: "c".repeat(32) },
      openBrowserImpl: () => { throw new Error("must not open"); },
      write: () => {},
    }),
    /unattended setup stopped before creating any Cloudflare resource.*missing or different account id is not approval/i,
  );
});

test("every public setup lane confirms the verified account before setup can write", () => {
  const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
  const helper = source.indexOf("export function createSetupControlAction");
  const wrapper = source.indexOf("async function cmdSetupInteractive");
  const selected = source.indexOf("const selectedAccount = session?.account", helper);
  const paid = source.indexOf("await confirmWorkersPaid(selectedAccount", selected);
  const setup = source.indexOf("return runSetup(selectedAccount", paid);
  const wrapperUsesHelper = source.indexOf("const setupAction = createSetupControlAction", wrapper);
  assert.ok(helper > 0 && selected > helper && paid > selected && setup > paid && wrapperUsesHelper > wrapper);
  assert.match(source.slice(selected, paid), /currentManifest[\s\S]*resolveSavedAccount[\s\S]*chooseAccount/);
  const wrapperWiring = source.slice(wrapperUsesHelper, source.indexOf("return withCloudflareControlCredential", wrapperUsesHelper));
  assert.match(
    wrapperWiring,
    /readCurrentManifest:\s*\(\)\s*=>\s*existsSync\(target\)\s*\?\s*loadManifest\(target\)\.m\s*:\s*null/,
    "the real setup wrapper must reread the manifest written by the first recovery attempt",
  );
  assert.doesNotMatch(
    wrapperWiring,
    /readCurrentManifest:\s*\(\)\s*=>\s*manifest\b/,
    "the setup wrapper must not close over its stale pre-recovery manifest",
  );
});

test("fresh setup recovery rereads its saved account and does not repeat account or Workers Paid questions", async () => {
  const account = { id: "d".repeat(32), name: "Fixture Account" };
  let manifest = null;
  let accountChoices = 0;
  let paidChecks = 0;
  let setupRuns = 0;
  const action = createSetupControlAction({
    initialManifest: null,
    readCurrentManifest: () => manifest,
    resolveSavedAccount: async current => {
      assert.equal(current, manifest);
      return account;
    },
    chooseAccount: async () => { accountChoices += 1; return account; },
    confirmWorkersPaid: async selected => {
      paidChecks += 1;
      assert.equal(selected, account);
    },
    runSetup: async selected => {
      setupRuns += 1;
      assert.equal(selected, account);
      if (setupRuns === 1) {
        manifest = { infrastructure: { cloudflare: { account_id: account.id } } };
        throw new Error("fixture recoverable setup refusal");
      }
      return "resumed";
    },
  });

  await assert.rejects(
    action({ account }),
    /fixture recoverable setup refusal/,
  );
  assert.equal(await action({ account: null }), "resumed");
  assert.equal(setupRuns, 2, "both the original action and recovery rerun must reach setup");
  assert.equal(accountChoices, 0, "the recovery rerun must use the account saved by setup");
  assert.equal(paidChecks, 1, "the same-process recovery rerun must not reopen or reconfirm Workers Paid");
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
