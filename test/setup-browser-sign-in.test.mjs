import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  confirmCloudflareWorkersPaidAccount,
  createSetupControlAction,
  setupWorkersPaidOptions,
} from "../brain.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const ACCOUNT = "a".repeat(32);
const BRAIN_ENTRYPOINT = fileURLToPath(new URL("../brain.mjs", import.meta.url));

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
      env: cliTestEnvironment(sandbox),
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
      env: cliTestEnvironment(sandbox, {
        CLOUDFLARE_API_TOKEN: ["fixture", "automation", "token"].join("-"),
      }),
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
      env: cliTestEnvironment(sandbox),
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /--slug must be 2 to 41 lowercase/i);
    assert.equal(existsSync(manifest), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
