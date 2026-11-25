import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import {
  assertKnownFlags, confirmWorkersPaidForSetup, parseFlags, renderCliCommands, setupManifestTarget,
  confirmCloudflareWorkersPaidAccount,
  createSetupControlAction,
  setupWorkersPaidOptions,
} from "../brain.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const ACCOUNT = "a".repeat(32);
const BRAIN_ENTRYPOINT = fileURLToPath(new URL("../brain.mjs", import.meta.url));

function isolatedEnvironment(root, extra = {}) {
  const bin = join(root, "bin");
  for (const part of ["bin", "tmp", "config", "cache", "data", "state"]) {
    mkdirSync(join(root, part), { recursive: true });
  }
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const keyFile = join(root, ".brain-admin-key");
  writeFileSync(keyFile, Buffer.alloc(32, 7).toString("hex"), { mode: 0o600 });
  return {
    ...cliTestEnvironment(root, extra),
    HOME: root, USERPROFILE: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    PATH: [bin, dirname(process.execPath)].join(process.platform === "win32" ? ";" : ":"),
    BRAIN_NO_WRANGLER_LOGIN: "1",
  };
}


// These cases run the real setup action, confirmer and production option factory.
// Account ids use the existing trim + lowercase policy on both sides.
async function paidControlCase({
  workersPaidConfirmed,
  suppliedAccountId = ACCOUNT,
  accountId = ACCOUNT,
  environment = {},
  interactive = false,
  answer = "PAID",
} = {}) {
  const account = { id: accountId, name: "Owner account" };
  const counters = { confirmer: 0, runSetup: 0, selectedId: null, prompts: 0, opened: 0 };
  const lines = [];
  let proof;
  const options = setupWorkersPaidOptions({
    workersPaidConfirmed, suppliedAccountId, environment, interactive,
    askFn: async () => { counters.prompts++; return answer; },
  });
  const action = createSetupControlAction({
    readCurrentManifest: () => null,
    resolveSavedAccount: async () => account,
    chooseAccount: async () => account,
    confirmWorkersPaid: async selected => {
      counters.confirmer++;
      proof = await confirmCloudflareWorkersPaidAccount(selected, {
        ...options,
        write: line => lines.push(line),
        openBrowserImpl: () => { counters.opened++; return true; },
      });
    },
    runSetup: async selected => {
      counters.runSetup++;
      counters.selectedId = selected.id;
      return "setup reached";
    },
  });
  let error;
  try { await action({ account }); } catch (caught) { error = caught; }
  return { counters, error, proof, lines };
}

function assertAdvanced(result, selectedId = ACCOUNT) {
  assert.equal(result.counters.confirmer, 1, "the real confirmer was reached once");
  assert.equal(result.counters.runSetup, 1, "the reviewed confirmation must advance setup once");
  assert.ifError(result.error);
  assert.equal(result.counters.selectedId, selectedId);
}

function assertStopped(result) {
  assert.equal(result.counters.confirmer, 1, "a refusal must reach the real confirmer");
  assert.equal(result.counters.runSetup, 0, "unbound confirmation must not advance setup");
  assert.equal(result.counters.selectedId, null);
  assert.match(result.error?.message || "", /missing or different account id is not approval/i);
}

test("R1 reviewed flag advances the live control action for the exact supplied account with empty environment", async () => {
  const result = await paidControlCase({ workersPaidConfirmed: true });
  assertAdvanced(result);
  assert.equal(result.proof.account_id, ACCOUNT);
  assert.equal(result.counters.prompts, 0);
  assert.equal(result.counters.opened, 0);
  assert.doesNotMatch(result.lines.join("\n"), /No Cloudflare resource|Nothing was created|billing (?:status )?(?:was )?verified/i);
});

test("R2 missing, malformed and different supplied ids cannot bind the reviewed flag", async () => {
  for (const suppliedAccountId of [null, "", " ", "not-an-account", "a".repeat(31), "a".repeat(33), "b".repeat(32), `a ${"a".repeat(31)}`]) {
    assertStopped(await paidControlCase({ workersPaidConfirmed: true, suppliedAccountId }));
    assertAdvanced(await paidControlCase({ workersPaidConfirmed: true }));
  }
});

test("R2 account equality applies trim and lowercase to both ids", async () => {
  for (const [accountId, suppliedAccountId] of [
    [ACCOUNT, ` ${ACCOUNT.toUpperCase()} `],
    [` ${ACCOUNT.toUpperCase()} `, ACCOUNT],
    [` ${ACCOUNT.toUpperCase()} `, ` ${ACCOUNT.toUpperCase()} `],
  ]) {
    const result = await paidControlCase({ workersPaidConfirmed: true, accountId, suppliedAccountId });
    assertAdvanced(result, accountId);
    assert.equal(result.proof.account_id, ACCOUNT);
    assertStopped(await paidControlCase({ workersPaidConfirmed: true, accountId, suppliedAccountId: ` ${"b".repeat(32).toUpperCase()} ` }));
  }
});

test("R3 absent or non-boolean flag cannot invent consent, including generic yes and foreign environment ids", async () => {
  for (const workersPaidConfirmed of [undefined, false, "true"]) {
    for (const environment of [
      {},
      { BRAIN_WORKERS_PAID_CONFIRMED: "1" },
      { BRAIN_WORKERS_PAID_ACCOUNT_ID: "b".repeat(32) },
    ]) {
      assertStopped(await paidControlCase({ workersPaidConfirmed, environment }));
      assertAdvanced(await paidControlCase({
        workersPaidConfirmed: false,
        environment: { BRAIN_WORKERS_PAID_ACCOUNT_ID: ` ${ACCOUNT.toUpperCase()} ` },
      }));
    }
  }
});

test("R3 existing exact-account environment and interactive PAID controls remain live", async () => {
  const environment = await paidControlCase({ environment: { BRAIN_WORKERS_PAID_ACCOUNT_ID: ACCOUNT } });
  assertAdvanced(environment);
  assert.equal(environment.proof.confirmation, "account_bound_automation");
  const interactive = await paidControlCase({ interactive: true });
  assertAdvanced(interactive);
  assert.equal(interactive.counters.prompts, 1);
  assert.equal(interactive.counters.opened, 1);
  assert.equal(interactive.proof.confirmation, "owner_dashboard");
  for (const answer of ["", "yes"]) {
    const stopped = await paidControlCase({ interactive: true, answer });
    assert.equal(stopped.counters.confirmer, 1);
    assert.equal(stopped.counters.prompts, 1);
    assert.equal(stopped.counters.runSetup, 0);
    assert.match(stopped.error?.message || "", /billing approval belongs to the owner/i);
  }
});

test("Claude-guided fresh browser sign-in refuses incomplete owner context before preflight", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-browser-consent-")));
  try {
    const brain = BRAIN_ENTRYPOINT;
    const result = spawnSync(process.execPath, [
      "--import", new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href,
      brain,
      "setup",
      join(sandbox, "brain.manifest.json"),
      "--browser-sign-in",
    ], {
      cwd: sandbox,
      encoding: "utf8",
      env: isolatedEnvironment(sandbox),
      timeout: 15000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /needs the owner's reviewed non-secret choices/i);
    assert.match(output, /--name/);
    assert.match(output, /--slug/);
    assert.match(output, /--cloudflare-account-id/);
    assert.match(output, /--workers-paid-confirmed/);
    assert.match(output, /Nothing was changed/i);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("explicit browser sign-in cannot silently fall back to an inherited automation token", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-browser-token-conflict-")));
  try {
    const brain = BRAIN_ENTRYPOINT;
    const manifest = join(sandbox, "brain.manifest.json");
    const result = spawnSync(process.execPath, [
      "--import", new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href,
      brain,
      "setup",
      manifest,
      "--browser-sign-in",
      "--name",
      "Owner Brain",
      "--slug",
      "owner-brain",
      "--cloudflare-account",
      "existing",
      "--cloudflare-account-id",
      ACCOUNT,
      "--workers-paid-confirmed",
    ], {
      cwd: sandbox,
      encoding: "utf8",
      env: isolatedEnvironment(sandbox, {
        CLOUDFLARE_API_TOKEN: ["fixture", "automation", "token"].join("-"),
      }),
      timeout: 15000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /browser sign-in was requested/i);
    assert.match(output, /also supplied recovery-token access/i);
    assert.match(output, /confirmations cannot be bypassed/i);
    assert.match(output, /Nothing was changed/i);
    assert.equal(existsSync(manifest), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Claude-guided setup rejects an unsafe slug before browser sign-in", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-browser-name-")));
  try {
    const brain = BRAIN_ENTRYPOINT;
    const manifest = join(sandbox, "brain.manifest.json");
    const result = spawnSync(process.execPath, [
      "--import", new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href,
      brain,
      "setup",
      manifest,
      "--browser-sign-in",
      "--name",
      "Owner Brain",
      "--slug",
      "Owner Brain",
      "--cloudflare-account",
      "existing",
      "--cloudflare-account-id",
      ACCOUNT,
      "--workers-paid-confirmed",
    ], {
      cwd: sandbox,
      encoding: "utf8",
      env: isolatedEnvironment(sandbox),
      timeout: 15000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /--slug must be 2 to 41 lowercase/i);
    assert.equal(existsSync(manifest), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Workers Paid confirmation is bound to the exact verified account", async () => {
  const lines = [];
  const receipt = await confirmWorkersPaidForSetup(
    { id: ACCOUNT, name: "Owner account" },
    { confirmed: true, interactive: false, write: (line) => lines.push(line) },
  );
  assert.deepEqual(receipt, {
    account_id: ACCOUNT,
    confirmed: true,
    source: "owner_flag",
  });
  assert.match(lines.join("\n"), /Owner account/);
  assert.match(lines.join("\n"), /No billing setting was changed/i);
});

test("an agent shell cannot infer or silently supply billing confirmation", async () => {
  await assert.rejects(
    confirmWorkersPaidForSetup(
      { id: ACCOUNT, name: "Owner account" },
      { interactive: false, write: () => undefined },
    ),
    (error) => error?.code === "WORKERS_PAID_CONFIRMATION_REQUIRED" &&
      /No Brain or Cloudflare resources were created/i.test(error.message) &&
      /local browser sign-in may remain saved for retry/i.test(error.message),
  );
});

test("an owner-controlled terminal can confirm after exact account selection", async () => {
  let prompts = 0;
  const receipt = await confirmWorkersPaidForSetup(
    { id: ACCOUNT, name: "Owner account" },
    {
      interactive: true,
      askFn: async () => { prompts += 1; return "yes"; },
      write: () => undefined,
    },
  );
  assert.equal(prompts, 1);
  assert.equal(receipt.source, "owner_prompt");
});


const PROFILE = "owner-brain-profile";
const OTHER_ACCOUNT = "b".repeat(32);
const guidedFlags = (accountId = ACCOUNT) => [
  "--browser-sign-in", "--name", "Owner Brain", "--slug", "owner-brain",
  "--cloudflare-account", "existing", "--cloudflare-account-id", accountId,
  "--workers-paid-confirmed",
];
const savedManifest = (accountId = ACCOUNT, profile = PROFILE) => ({
  client: { name: "Owner Brain", slug: "owner-brain" },
  infrastructure: { cloudflare: { account_id: accountId, auth_profile: profile } },
});

// Exercise the exact dispatcher function, with the real flag parser, control
// action and billing guards. Only effectful boundaries are injected, so this
// cannot sign in, open a browser, run a host tool, or contact an endpoint.
// Source extraction avoids adding a production-only test API to this large CLI.
async function guidedSetupWitness({ manifest, flags = guidedFlags(), selectedId = ACCOUNT, environment = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-guided-witness-")));
  const target = join(root, "brain.manifest.json");
  const events = [];
  const confirmations = [];
  const output = [];
  let controlOptions;
  let setupOptions;
  let failure;
  try {
    const env = isolatedEnvironment(root, environment);
    if (manifest) writeFileSync(target, JSON.stringify(manifest));
    const source = readFileSync(process.env.BRAIN_SETUP_TEST_SOURCE || BRAIN_ENTRYPOINT, "utf8");
    const start = source.indexOf("async function cmdSetupInteractive(");
    const end = source.indexOf("\nexport async function cmdUpgradeInteractive(", start);
    assert.ok(start >= 0 && end > start, "the real setup dispatcher must be present");
    const write = line => output.push(line);
    const context = {
      process: { argv: [process.execPath, BRAIN_ENTRYPOINT, "setup", target, ...flags],
        env, stdin: { isTTY: false }, stdout: { isTTY: false } },
      parseFlags, assertKnownFlags, setupManifestTarget,
      existsSync: path => { events.push("manifest-check"); return existsSync(path); },
      loadManifest: path => { events.push("manifest-read"); return { m: JSON.parse(readFileSync(path, "utf8")) }; },
      die: message => { events.push("refusal"); throw new Error(message); },
      adoptCloudflareAuthProfile: async () => { events.push("adopt"); throw new Error("unexpected profile adoption"); },
      cloudflareAdoptionConsent: () => false,
      setupLocalPreflightChecks: async () => { events.push("preflight"); return []; },
      shouldSkipSetupConnections: flags => flags["no-connect"] === true,
      D_FAIL: "FAIL", D_OK: "OK", D_WARN: "WARN",
      createSetupControlAction, setupWorkersPaidOptions,
      confirmWorkersPaidForSetup: (account, options) => {
        confirmations.push({ path: "flag", account: account.id });
        return confirmWorkersPaidForSetup(account, { ...options, write });
      },
      confirmCloudflareWorkersPaidAccount: async (account, options) => {
        const reached = { path: "environment", account: account.id };
        confirmations.push(reached);
        const receipt = await confirmCloudflareWorkersPaidAccount(account, {
          ...options, write,
          openBrowserImpl: () => { throw new Error("browser attempted"); },
        });
        // Observe the real centralized guard's receipt, not a duplicated flag decision.
        if (receipt.confirmation === "owner_flag") reached.path = "flag";
        return receipt;
      },
      ask: async () => { throw new Error("unexpected prompt"); },
      resolveAccount: async () => { events.push("resolve-account"); return { id: selectedId, name: "Owner account" }; },
      chooseSetupAccount: async () => { events.push("choose-account"); throw new Error("OAuth account missing"); },
      reserveWorkersDevAddress: async () => { events.push("subdomain"); return "owner-workspace"; },
      cf: () => { throw new Error("endpoint attempted"); },
      activeCloudflareToken: () => null,
      cmdSetup: async (path, options) => {
        events.push("setup");
        assert.equal(path, target);
        setupOptions = options;
      },
      commandPath: path => JSON.stringify(path), displayPath: path => path,
      console: { log: write },
      withCloudflareControlCredential: async (action, options) => {
        events.push("credential-boundary");
        controlOptions = options;
        return action({ method: "wrangler_oauth", profile: manifest ? null : PROFILE,
          account: { id: selectedId, name: "Owner account" },
          preflight: { workersSubdomain: "owner-workspace" } });
      },
    };
    const run = new Script(`(${source.slice(start, end).trim()})`, { filename: "setup-dispatcher-witness.mjs" })
      .runInNewContext(context);
    await run(target);
  } catch (error) {
    failure = error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { events, confirmations, output: output.join("\n"), failure, controlOptions, setupOptions };
}

test("P7 paid flag: reviewed non-TTY OAuth choices pass Workers Paid without an environment receipt", async () => {
  const result = await guidedSetupWitness();
  assert.equal(result.events.includes("credential-boundary"), true, "the OAuth decision must be reached");
  assert.ifError(result.failure);
  assert.deepEqual(result.confirmations, [{ path: "flag", account: ACCOUNT }]);
  assert.equal(result.events.filter(event => event === "setup").length, 1);
  assert.equal(result.controlOptions.freshOAuth, true);
  assert.equal(result.controlOptions.accountId, ACCOUNT);
  assert.match(result.output, /confirmation matches the exact verified account\. Billing status was not read/);
});

test("P7 resume: the same reviewed command reuses the saved profile and account", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest() });
  assert.ok(result.events.includes("manifest-read"), "resume must read the saved binding");
  assert.ifError(result.failure);
  assert.deepEqual(result.confirmations, [{ path: "flag", account: ACCOUNT }]);
  assert.equal(result.events.filter(event => event === "setup").length, 1);
  assert.equal(result.events.includes("adopt"), false);
  assert.equal(result.controlOptions.freshOAuth, false);
  assert.equal(result.controlOptions.reauthorizeOAuth, false);
  assert.equal(result.controlOptions.authProfile, PROFILE);
  assert.equal(result.controlOptions.accountId, ACCOUNT);
  assert.equal(result.setupOptions.cloudflareAuthProfile, PROFILE);
});

test("P7 M1: a different OAuth account cannot use the reviewed paid flag", async () => {
  const result = await guidedSetupWitness({ selectedId: OTHER_ACCOUNT });
  assert.ok(result.events.includes("credential-boundary"), "the verified-account confirmation decision must be reached");
  assert.deepEqual(result.confirmations, [{ path: "environment", account: OTHER_ACCOUNT }]);
  assert.match(result.failure?.message || "", /missing or different account id is not approval/);
  assert.equal(result.events.includes("setup"), false);
  assert.equal(result.events.includes("subdomain"), false);
});

test("P7 M2: a saved manifest without a profile refuses before adoption or credential work", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest(ACCOUNT, null) });
  assert.ok(result.events.includes("manifest-read"), "the resume binding decision must be reached");
  assert.equal(result.events.includes("adopt"), false, "a missing saved profile must not trigger adoption");
  assert.match(result.failure?.message || "", /saved browser sign-in profile/);
  assert.doesNotMatch(result.failure.message, /older/i);
  assert.equal(result.events.includes("credential-boundary"), false);
  assert.equal(result.events.includes("setup"), false);
});

test("P7 resume: a different saved account refuses before preflight", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest(OTHER_ACCOUNT) });
  assert.ok(result.events.includes("manifest-read"), "the saved-account comparison must be reached");
  assert.match(result.failure?.message || "", /does not match the account already bound/);
  assert.doesNotMatch(result.failure.message, /older/i);
  assert.equal(result.events.includes("preflight"), false);
  assert.equal(result.events.includes("credential-boundary"), false);
  assert.equal(result.events.includes("setup"), false);
});

test("P7 resume: a profile without a saved account is not a bound retry", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest(null) });
  assert.ok(result.events.includes("manifest-read"), "the saved-account decision must be reached");
  assert.match(result.failure?.message || "", /saved browser sign-in profile/);
  assert.equal(result.events.includes("credential-boundary"), false);
  assert.equal(result.events.includes("setup"), false);
});

test("P7 resume: a retry must supply the exact reviewed account again", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest(), flags: ["--browser-sign-in"] });
  assert.ok(result.events.includes("manifest-read"), "the supplied-account decision must be reached");
  assert.match(result.failure?.message || "", /saved browser sign-in profile/);
  assert.equal(result.events.includes("credential-boundary"), false);
  assert.equal(result.events.includes("setup"), false);
});

test("P7 fallback control: ordinary resumed setup keeps account-bound environment confirmation", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest(), flags: [],
    environment: { BRAIN_WORKERS_PAID_ACCOUNT_ID: ACCOUNT } });
  assert.ok(result.events.includes("credential-boundary"), "the environment confirmation decision must be reached");
  assert.ifError(result.failure);
  assert.deepEqual(result.confirmations, [{ path: "environment", account: ACCOUNT }]);
  assert.equal(result.events.filter(event => event === "setup").length, 1);
});

test("P7 fallback: an environment confirmation for another account still refuses", async () => {
  const result = await guidedSetupWitness({ manifest: savedManifest(), flags: [],
    environment: { BRAIN_WORKERS_PAID_ACCOUNT_ID: OTHER_ACCOUNT } });
  assert.ok(result.events.includes("credential-boundary"), "the environment binding decision must be reached");
  assert.deepEqual(result.confirmations, [{ path: "environment", account: ACCOUNT }]);
  assert.match(result.failure?.message || "", /missing or different account id is not approval/);
  assert.equal(result.events.includes("setup"), false);
});

test("P7 help: guided retry requires the saved browser profile and matching account", async () => {
  const source = readFileSync(process.env.BRAIN_SETUP_TEST_SOURCE || BRAIN_ENTRYPOINT, "utf8");
  // Execute the real help emission with its real command renderer. Isolating
  // this expression keeps help mutants off the credential and process paths.
  const start = source.indexOf('  console.log(renderCliCommands(`${c.bold("brain")}: provision');
  const end = source.indexOf('\n  process.exit(cmd && !helpRequested ? 1 : 0);', start);
  assert.ok(start >= 0 && end > start, "the real help emission must be present");
  const lines = [];
  new Script(source.slice(start, end), { filename: "setup-help-witness.mjs" }).runInNewContext({
    c: { bold: text => text }, renderCliCommands,
    console: { log: line => lines.push(line) },
  });
  assert.equal(lines.length, 1, "the real help renderer must emit its help text");
  const help = lines[0];
  const guidedCommand = renderCliCommands("brain setup      [manifest] --browser-sign-in --cloudflare-account existing");
  const recoveryCommand = renderCliCommands("brain setup      [manifest] --cloudflare-token");
  const guidedStart = help.indexOf(guidedCommand);
  const guidedEnd = help.indexOf(recoveryCommand, guidedStart);
  assert.ok(guidedStart >= 0 && guidedEnd > guidedStart, "the guided help section must be reached");
  const guidedHelp = help.slice(guidedStart, guidedEnd).replace(/\s+/g, " ");
  assert.match(guidedHelp, /rerun the same reviewed flags to resume only when the saved browser sign-in profile and account id match/,
    "guided help must explain the saved-profile and matching-account retry guard");
  assert.doesNotMatch(guidedHelp, /fresh setup only|older manifest/i);

  const allowed = await guidedSetupWitness({ manifest: savedManifest() });
  assert.ok(allowed.events.includes("manifest-read"), "the documented retry must read its saved binding");
  assert.ifError(allowed.failure);
  assert.equal(allowed.events.filter(event => event === "setup").length, 1);
  for (const manifest of [savedManifest(ACCOUNT, null), savedManifest(OTHER_ACCOUNT)]) {
    const stopped = await guidedSetupWitness({ manifest });
    assert.ok(stopped.events.includes("manifest-read"), "the documented retry guard must be reached");
    assert.ok(stopped.failure, "a retry outside the documented binding must stop");
    assert.equal(stopped.events.includes("setup"), false);
    assert.equal(stopped.events.includes("credential-boundary"), false);
  }
});
