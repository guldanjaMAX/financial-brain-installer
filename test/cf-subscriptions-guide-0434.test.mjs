import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cmdDoctor, confirmWorkersPaidForSetup, confirmCloudflareWorkersPaidAccount,
  renderCliCommands, r2BucketRequested,
} from "../brain.mjs";
import { runAll } from "../doctor.mjs";
import { doctorDependencies } from "./fixtures/doctor-cli-dependencies.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const moduleUrl = new URL("../operations/cloudflare-subscriptions.mjs", import.meta.url);
const account = { id: "a".repeat(32), name: "Fixture account" };
const warning = "Choose Workers Paid for setup. Do not add Images or Stream for the Brain; it does not use those services.";
const load = () => import(moduleUrl.href);
const capture = async (fn) => {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try { await fn(); } finally { console.log = original; }
  return lines.join("\n");
};

test("both setup confirmations put the bundle warning after the price", async () => {
  for (const confirm of [confirmWorkersPaidForSetup, confirmCloudflareWorkersPaidAccount]) {
    const lines = [];
    let prompts = 0;
    const result = await confirm(account, {
      interactive: true, write: (line) => lines.push(line),
      openBrowserImpl: () => false,
      askFn: async () => { prompts++; return confirm === confirmWorkersPaidForSetup ? "yes" : "PAID"; },
    });
    assert.equal(prompts, 1, "the real confirmation decision was reached");
    assert.equal(result.account_id, account.id);
    const index = lines.findIndex((line) => line.includes(warning));
    assert.ok(index > 0, "setup needs the exact bundle warning");
    assert.match(lines[index - 1], /\$5|5 USD/);
    assert.match(lines[index - 1], /minimum.*as of 2026-11-24.*usage/i);
  }
});

test("verified media pricing leaves combined bundles and live logging usage uncertain", async () => {
  const { classifySubscriptions, renderSubscriptionSection } = await load();
  const names = ["Images Stream Basic", "Observability", "Workers Logs", "Images", "Stream"];
  const rows = classifySubscriptions(names);
  assert.equal(rows.length, names.length);
  for (const row of rows.slice(0, 3)) {
    assert.equal(row.brain_uses, "unknown");
    assert.match(row.note, /ask your installer before cancelling/i);
  }
  for (const row of rows.slice(3)) assert.equal(row.brain_uses, false);
  assert.match(rows[0].plain_name, /unrecognised/i);
  assert.match(rows[1].plain_name, /logs/i);
  assert.doesNotMatch(renderSubscriptionSection(names).join("\n"), /you may cancel it yourself/);
});

test("Workers Paid is used and unknown subscriptions never suggest cancellation", async () => {
  const { classifySubscriptions, parseSubscriptionNames, renderSubscriptionSection } = await load();
  const names = ["Workers Paid", "Fixture extra", "Workers Paid extra", "R2 extra"];
  const rows = classifySubscriptions(names);
  assert.equal(rows[0].brain_uses, true, "known required plan is the green control");
  for (const row of rows.slice(1)) {
    assert.equal(row.brain_uses, "unknown");
    assert.match(row.note, /not sure; ask your installer/i);
    const text = renderSubscriptionSection([row.name]).join("\n");
    assert.doesNotMatch(text, /the Brain does not use this|you may cancel it yourself/);
  }
  assert.deepEqual(parseSubscriptionNames(" Workers Paid ; ; Fixture extra "), ["Workers Paid", "Fixture extra"]);
  assert.throws(() => parseSubscriptionNames(true), /needs a value/);
  assert.throws(() => parseSubscriptionNames("Workers Paid\nFixture extra"), /plain text/);
  assert.throws(() => classifySubscriptions(["\u001bFixture extra"]), /plain text/);
});

test("R2 usage follows the existing bucket-request decision", async () => {
  const { classifySubscriptions, renderSubscriptionSection } = await load();
  for (const [bucket, expected] of [["fixture-bucket", true], ["", false], ["  ", false]]) {
    const options = { r2BucketRequested: Boolean(r2BucketRequested({ r2_bucket: bucket })) };
    assert.equal(classifySubscriptions(["R2"], options)[0].brain_uses, expected);
    assert.match(renderSubscriptionSection(["R2"], options).join("\n"), expected
      ? /the Brain uses this/ : /the Brain does not use this/);
  }
  assert.equal(classifySubscriptions(["R2"], { r2BucketRequested: null })[0].brain_uses, "unknown",
    "a missing manifest is not proof that R2 is unused");
  const root = mkdtempSync(join(process.env.HOME, "subscriptions-r2-"));
  try {
    const path = join(root, "fixture.manifest.json");
    const keyPath = join(root, "fixture-admin-key");
    writeFileSync(keyPath, ["fixture", "admin", "value"].join("-"), { mode: 0o600 });
    for (const [bucket, wording] of [["fixture-bucket", /R2.*the Brain uses this/], ["", /R2.*the Brain does not use this/]]) {
      writeFileSync(path, JSON.stringify({ brain: { admin_key_file: keyPath },
        infrastructure: { cloudflare: { r2_bucket: bucket } } }));
      let reads = 0;
      const deployedCheck = async () => { reads++; return { name: "fixture", status: "ok", detail: "fixture check" }; };
      const output = await capture(() => cmdDoctor(path, {
        subscriptions: "R2", interactive: false,
        withAvailableCloudflareToken: (fn) => fn(), doctorRunAll: async () => [],
        buildUpgradePauseCheck: deployedCheck, buildAnthropicWorkerSecretCheck: deployedCheck,
        buildChecksumDriftCheck: deployedCheck,
        checkBankFeedRedirect: () => ({ name: "fixture", status: "ok", detail: "fixture check" }),
        checkPrioritySlice: () => ({ name: "fixture", status: "ok", detail: "fixture check" }),
      }));
      assert.equal(reads, 3, "real manifest branch reaches every injected deployed check");
      assert.match(output, wording);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("official dated pricing covers required storage, search, AI and optional services", async () => {
  const { classifySubscriptions, WORKERS_PAID_SETUP_NOTICE } = await load();
  const names = ["Workers Paid", "D1", "Vectorize", "Workers AI", "R2", "Images", "Stream", "Workers Logs", "Observability"];
  const rows = classifySubscriptions(names);
  assert.equal(rows.length, 9, "every requested product reaches the guide");
  for (const row of rows) {
    assert.match(row.pricing, /as of 2026-11-24/);
    assert.ok(row.sources.length > 0);
    for (const source of row.sources) {
      assert.equal(new URL(source.url).hostname, "developers.cloudflare.com");
      assert.match(source.page_updated, /^2026-\d{2}-\d{2}$/);
    }
  }
  assert.deepEqual(rows.slice(0, 4).map(row => row.brain_uses), [true, true, true, true]);
  assert.match(WORKERS_PAID_SETUP_NOTICE, /\$5 USD per month minimum.*as of 2026-11-24/);
  assert.match(rows[0].pricing, /\$5 USD per month minimum/);
  assert.match(rows[1].pricing, /25 billion.*50 million.*5 GB/);
  assert.match(rows[2].pricing, /50 million.*10 million/);
  assert.match(rows[3].pricing, /10,000.*per day.*\$0\.011.*1,000/);
  assert.match(rows[4].pricing, /Standard.*10 GB-month.*1 million.*10 million.*Infrequent Access/i);
  assert.match(rows[5].pricing, /5,000.*\$0\.50.*1,000.*\$5.*100,000.*\$1.*100,000/);
  assert.match(rows[6].pricing, /prepaid.*\$5.*1,000.*\$1.*1,000/i);
  assert.match(rows[7].pricing, /20 million.*\$0\.60.*December 1, 2026/);
  assert.match(rows[8].pricing, /December 1, 2026.*50 GB.*10 GB-month.*\$0\.25.*\$0\.10/);
});

test("unused services never establish a zero bill or safe cancellation", async () => {
  const { classifySubscriptions, renderSubscriptionSection } = await load();
  const names = ["Images", "Stream", "R2", "Images extra", "Stream extra", "R2 extra"];
  const rows = classifySubscriptions(names, { r2BucketRequested: false });
  assert.equal(rows[2].brain_uses, false, "unused R2 decision reached");
  assert.equal(classifySubscriptions(["Workers Paid"])[0].brain_uses, true, "required green control");
  const output = renderSubscriptionSection(names, { r2BucketRequested: false }).join("\n");
  assert.doesNotMatch(output, /you may cancel|safe to cancel|nothing to pay|your (?:bill|charge) is (?:zero|\$0)/i);
  assert.deepEqual(rows.slice(0, 3).map(row => row.brain_uses), [false, false, false]);
  assert.ok(rows.slice(3).every(row => row.brain_uses === "unknown"), "unknown suffixes stay unknown");
  assert.match(output, /other projects/i);
  assert.match(output, /before cancelling/i);
});

test("real doctor machine checks reach account reads without billing or mutation", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ path: new URL(url).pathname, method: options.method || "GET" });
    return { ok: true, status: 200, json: async () => ({
      success: true, result: String(url).endsWith("/tokens/verify") ? { status: "active" } : [],
    }) };
  };
  let runs = 0;
  let output;
  try {
    output = await capture(() => cmdDoctor(undefined, {
      subscriptions: "Workers Paid;Images Stream Basic;Observability;R2;Fixture extra",
      interactive: false,
      withAvailableCloudflareToken: (fn) => fn(),
      doctorRunAll: (options) => {
        runs++;
        return runAll({ ...options, ...doctorDependencies(), accountId: account.id,
          cloudflareToken: ["fixture", "token"].join("-"),
          localRun: (command, args) => ({ ok: true, out: command === "npx"
            ? "wrangler 4.131.1" : args.includes("status") ? "signed in" : "2.1.63 (Claude Code)" }),
        });
      },
    }));
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(runs, 1);
  assert.ok(calls.some((call) => call.path.endsWith("/workers/scripts")), "real account probes were reached");
  assert.ok(calls.some((call) => call.path.endsWith("/vectorize/v2/indexes")), "green read control");
  assert.deepEqual(calls.filter((call) => /billing|subscriptions|cancel/i.test(call.path)), []);
  assert.ok(calls.every((call) => call.method === "GET"), "no cancel or modify request");
  assert.match(output, /Cloudflare subscriptions/);
  assert.match(output, /Workers Paid.*the Brain uses this/);
  assert.match(output, /Fixture extra.*not sure; ask your installer/);
  assert.match(output, /R2.*not sure; ask your installer/);
  assert.match(output, /never cancels or changes.*subscription/i);
});

test("doctor prompts only interactively and offers a rendered command when no names are provided", async () => {
  let prompts = 0;
  const options = {
    withAvailableCloudflareToken: (fn) => fn(), doctorRunAll: async () => [],
    askFn: async () => { prompts++; return "Workers Paid;Fixture extra"; },
  };
  const output = await capture(() => cmdDoctor(undefined, { ...options, interactive: true }));
  assert.equal(prompts, 1);
  assert.match(output, /Workers Paid.*the Brain uses this/);
  const unattended = await capture(() => cmdDoctor(undefined, { ...options, interactive: false }));
  assert.equal(prompts, 1, "noninteractive check never waits on a prompt");
  assert.ok(unattended.includes(renderCliCommands('brain doctor --subscriptions "<name>;<name>"')));
  assert.match(unattended, /Manage Account > Billing > Subscriptions/);
  assert.match(unattended, /not.*verified|not.*checked/i);
});

test("the existing owner checklist stays quiet unless subscription help is requested", async () => {
  const root = mkdtempSync(join(process.env.HOME, "subscriptions-checklist-"));
  try {
    const path = join(root, "fixture.manifest.json");
    const keyPath = join(root, "fixture-admin-key");
    writeFileSync(keyPath, ["fixture", "admin", "value"].join("-"), { mode: 0o600 });
    writeFileSync(path, JSON.stringify({ brain: { admin_key_file: keyPath, worker_name: "fixture" },
      infrastructure: { cloudflare: { account_id: account.id,
        d1_database_id: "11111111-2222-4333-8444-555555555555", vectorize_index: "fixture" } } }));
    let prompts = 0, reads = 0;
    const deployedCheck = async () => { reads++; return { name: "fixture", status: "ok", detail: "fixture" }; };
    const options = { interactive: true, askFn: async () => { prompts++; return "Images"; },
      withAvailableCloudflareToken: fn => fn(), doctorRunAll: async () => [],
      buildUpgradePauseCheck: deployedCheck, buildAnthropicWorkerSecretCheck: deployedCheck,
      buildChecksumDriftCheck: deployedCheck, checkBankFeedRedirect: () => null, checkPrioritySlice: () => null,
      reportChecklist: () => {},
    };
    // Deployed checks must return rows, even for optional checks.
    options.checkBankFeedRedirect = options.checkPrioritySlice = () => ({ name: "fixture", status: "ok", detail: "fixture" });
    const output = await capture(() => cmdDoctor(path, options));
    assert.equal(reads, 3, "existing-Brain checklist decision reached");
    assert.equal(prompts, 0);
    assert.doesNotMatch(output, /Cloudflare subscriptions/);
    const explicit = await capture(() => cmdDoctor(path, { ...options, subscriptions: "Images" }));
    assert.equal(reads, 6, "explicit-help green control reaches same checks");
    assert.match(explicit, /Images.*the Brain does not use this/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real CLI accepts subscription names and rejects a bare flag before checks", () => {
  const root = mkdtempSync(join(process.env.HOME, "subscriptions-cli-"));
  try {
    const imports = ["cli-side-effect-tripwire", "isolate-support-root", "support-journal-acl-preload", "doctor-cli-preload"];
    const args = imports.flatMap((name) => ["--import", new URL(`./fixtures/${name}.mjs`, import.meta.url).href]);
    const cli = fileURLToPath(new URL("../brain.mjs", import.meta.url));
    for (const [extra, expected] of [
      [["--subscriptions", "Workers Paid;Fixture extra"], 0],
      [["--diagnostic", "--subscriptions", "Workers Paid;Fixture extra"], 0],
      [["--subscriptions"], 1],
    ]) {
      const result = spawnSync(process.execPath, [...args, cli, "doctor", ...extra], {
        cwd: root, env: cliTestEnvironment(root, { BRAIN_TEST_DOCTOR: "ready" }), encoding: "utf8", timeout: 20_000,
      });
      assert.equal(result.status, expected, result.stderr);
      if (expected === 0) {
        assert.match(result.stdout, /TEST_DOCTOR_STAGE:dispatch/);
        assert.match(result.stdout, /Workers Paid.*the Brain uses this/);
      } else {
        assert.match(result.stdout, /--subscriptions needs a value/);
        assert.doesNotMatch(result.stdout, /TEST_DOCTOR_STAGE:dispatch/);
      }
      assert.doesNotMatch(result.stderr, /TEST_SIDE_EFFECT_BLOCKED/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner and technician guides carry the same one-subscription warning", () => {
  for (const path of ["onboarding/08-provisioning-prerequisites.md", "skills/financial-brain-technician/SKILL.md"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(source.replace(/\s+/g, " ").includes(warning), path);
  }
  const privacy = readFileSync(new URL("./package-privacy.test.mjs", import.meta.url), "utf8");
  assert.ok(privacy.includes('"operations/cloudflare-subscriptions.mjs",'),
    "the reviewed package inventory must include the new imported module");
  const chain = readFileSync(new URL("../scripts/run-test-chain.mjs", import.meta.url), "utf8");
  for (const suffix of ["", "-mutants", "-privacy", "-portability"]) {
    const command = `"node --test test/cf-subscriptions-guide-0434${suffix}.test.mjs",`;
    assert.equal(chain.split(command).length - 1, 2, "each suite is in both chain lists");
  }
});
