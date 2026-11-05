import "./update-faults-boundaries.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptCloudflareAuthProfile, cloudflareApiRequest, cloudflareOAuthInstallIdentity,
  cmdUpdate, cmdUpdatePreview, withCloudflareControlCredential, withUpdateKeyPreviewCloudflare,
} from "../brain.mjs";
import { captureCloudflareOAuthToken, cloudflareOAuthProfileName, CloudflareOAuthSessionError } from "../operations/cloudflare-oauth-session.mjs";
import { modelSwitchFixture, PAIR, previewOptions, SHA } from "./fixtures/legacy-model-switch.mjs";

const ACCOUNT = "1".repeat(32), TOKEN = ["synthetic", "oauth", "access", "fixture"].join("-");
const PROFILE = `financial-brain-${"2".repeat(24)}`;

// An unavailable durable profile cannot be read without potentially refreshing
// it in pinned Wrangler. An already acquired snapshot is the success control.
for (const state of ["expired", "revoked", "unexpired"]) {
  test(`preview never runs the credential process for a ${state} durable profile`, async () => {
    const decisions = [], effects = [], manifest = { infrastructure: { cloudflare: { account_id: ACCOUNT, auth_profile: PROFILE } } };
    const options = {
      manifestPath: join(tmpdir(), "synthetic.manifest.json"), manifest,
      captureToken: request => captureCloudflareOAuthToken({
        ...request, environment: {}, platformName: "darwin",
        processRunner: () => {
          effects.push("process", ...(state === "expired" ? ["refresh", "write"] : []));
          return { status: 0, stdout: Buffer.from(JSON.stringify({ type: "oauth", token: TOKEN })), stderr: Buffer.alloc(0) };
        },
      }),
      withAvailableToken: () => { effects.push("fallback"); throw new Error("forbidden fallback"); },
    };
    let error;
    try { await withUpdateKeyPreviewCloudflare(() => { decisions.push("inventory"); }, options); }
    catch (caught) { error = caught; }
    assert.equal(error?.code, "UPDATE_PREVIEW_CLOUDFLARE_ACCESS_UNAVAILABLE", "the unavailable-snapshot decision was reached");
    assert.deepEqual(effects, [], "no process, refresh, credential write or fallback");
    assert.deepEqual(decisions, []);
    const bytes = Buffer.from(TOKEN);
    await withCloudflareControlCredential(() => withUpdateKeyPreviewCloudflare(() => {
      decisions.push("inventory"); return "present";
    }, options), {
      accountId: ACCOUNT, authProfile: PROFILE, interactive: false,
      withOAuthSession: async request => request.action({ profile: PROFILE, account: { id: ACCOUNT }, token: bytes }),
    });
    assert.deepEqual(decisions, ["inventory"], "unexpired in-memory profile control reaches the same inventory decision");
    assert.deepEqual(effects, []);
    assert.ok(bytes.every(byte => byte === 0));
  });
}

test("preview isolates an approved snapshot from the parent session renewal callback", async () => {
  for (const status of [401, 200]) {
    const calls = [], bytes = Buffer.from(TOKEN), priorFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls.push("GET");
      return status === 200 ? Response.json({ success: true, result: [] })
        : Response.json({ success: false, errors: [{ code: 9109 }] }, { status });
    };
    try {
      await withCloudflareControlCredential(async () => {
        const read = withUpdateKeyPreviewCloudflare(() => cloudflareApiRequest("/fixture"), {
          manifestPath: join(tmpdir(), "synthetic.manifest.json"),
          manifest: { infrastructure: { cloudflare: { account_id: ACCOUNT, auth_profile: PROFILE } } },
        });
        if (status === 401) await assert.rejects(read);
        else assert.deepEqual(await read, []);
        assert.equal(bytes.toString(), TOKEN, "preview wipes its own copy, preserving the parent snapshot");
      }, {
        accountId: ACCOUNT, authProfile: PROFILE, interactive: false,
        oauthOptions: { processRunner: () => { calls.push("renew"); throw new Error("forbidden renewal"); } },
        withOAuthSession: async request => request.action({ profile: PROFILE, account: { id: ACCOUNT }, token: bytes }),
      });
    } finally { globalThis.fetch = priorFetch; }
    assert.deepEqual(calls, ["GET"], "each request decision was reached once, without renewal");
    assert.ok(bytes.every(byte => byte === 0));
  }
});

for (const field of ["account", "profile"]) {
  test(`preview refuses a mismatched ${field} snapshot and accepts its exact binding`, async () => {
    for (const matches of [false, true]) {
      const events = [], expected = { account_id: ACCOUNT, auth_profile: PROFILE };
      const accountId = !matches && field === "account" ? "3".repeat(32) : ACCOUNT;
      const profile = !matches && field === "profile" ? `financial-brain-${"4".repeat(24)}` : PROFILE;
      let error;
      await withCloudflareControlCredential(async () => {
        try {
          await withUpdateKeyPreviewCloudflare(() => { events.push("inventory"); }, {
            manifest: { infrastructure: { cloudflare: expected } },
          });
        } catch (caught) { error = caught; }
      }, {
        accountId, authProfile: profile, interactive: false,
        withOAuthSession: async request => request.action({ profile, account: { id: accountId }, token: Buffer.from(TOKEN) }),
      });
      assert.deepEqual(events, matches ? ["inventory"] : []);
      if (!matches) assert.equal(error?.code, "UPDATE_PREVIEW_CLOUDFLARE_ACCESS_UNAVAILABLE", "exact-binding decision reached");
      else assert.equal(error, undefined);
    }
  });
}

test("real preview reports unavailable durable access truthfully and keeps its acquired-access control held", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "key-preview-auth-"))), f = modelSwitchFixture(root);
  t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  f.manifest.infrastructure.cloudflare.account_id = ACCOUNT;
  f.manifest.infrastructure.cloudflare.auth_profile = PROFILE;
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  for (const available of [false, true]) {
    const events = [], options = previewOptions(f, () => {});
    delete options.withKeyPreflightCloudflare;
    options.answerKeyOptions = { cf: async () => { events.push("inventory"); return [{ name: "ANTHROPIC_API_KEY" }]; } };
    const request = options.request;
    options.request = async () => { events.push("documents"); return request(); };
    let receipt;
    const run = async () => {
      try { receipt = await cmdUpdatePreview([f.manifestPath, "--preview", "--json", "--expect-runtime-sha256", SHA], options); }
      catch (error) { receipt = error.payload; }
    };
    if (available) await withCloudflareControlCredential(run, {
      accountId: ACCOUNT, authProfile: PROFILE, interactive: false,
      withOAuthSession: async request => request.action({ profile: PROFILE, account: { id: ACCOUNT }, token: Buffer.from(TOKEN) }),
    });
    else await run();
    assert.deepEqual(events, available ? ["documents", "inventory"] : ["documents"]);
    assert.equal(receipt.authorizes_update, false);
    assert.equal(receipt.read_only, true);
    assert.equal(receipt.effects.network_requests, available ? 2 : 1);
    assert.equal(receipt.effects.credential_reads, available ? 2 : 1);
    for (const effect of ["manifest_writes", "brain_writes", "deployments", "browser_launches", "package_installs"]) assert.equal(receipt.effects[effect], 0);
    assert.equal(receipt.status, available ? "pre_update_check_complete" : "failed");
    if (!available) {
      assert.equal(receipt.error_code, "UPDATE_PREVIEW_ANTHROPIC_KEY_UNVERIFIED");
      assert.doesNotMatch(JSON.stringify(receipt), /Same key, same data/);
      assert.ok(receipt.next_step.includes("verify"));
    }
  }
});

async function authUpdate(t, { named = false, consent = true, interactive = false, answer = "y", state = "fresh", key = true, available = false, change } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "key-auth-repair-"))), f = modelSwitchFixture(root);
  t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  f.manifest.infrastructure.cloudflare.account_id = ACCOUNT;
  f.manifest.retrieval = PAIR;
  if (named) f.manifest.infrastructure.cloudflare.auth_profile = PROFILE;
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const before = readFileSync(f.manifestPath), calls = [], snapshots = [];
  let error;
  const priorLog = console.log, priorToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  console.log = () => {};
  const session = async request => {
    calls.push(request.reauthorize ? "authorize" : "capture");
    if (named && state !== "fresh" && !request.reauthorize) {
      throw new CloudflareOAuthSessionError("CLOUDFLARE_OAUTH_REAUTH_REQUIRED", "token", "synthetic sign-in expired");
    }
    const value = { profile: request.profile, account: { id: ACCOUNT }, token: Buffer.from(TOKEN) };
    snapshots.push(value.token);
    try { return request.action ? await request.action(value) : { profile: value.profile, account: value.account }; }
    finally { value.token.fill(0); }
  };
  try {
    await cmdUpdate(f.manifestPath, {
      lifecycleLockHeld: true, interactive, adoptConsent: consent,
      discoverInstalledManifest: () => ({ path: f.manifestPath }), answerSetupNeedsRecovery: () => false,
      readUpdateBacklog: async () => { calls.push("backlog"); return { pending: 0 }; },
      adoptCloudflareAuthProfile: async (path, options) => {
        calls.push("adoption");
        const result = await adoptCloudflareAuthProfile(path, { ...options, env: {}, write: () => {}, withOAuthSession: session });
        if (change && result) {
          const current = JSON.parse(readFileSync(path)); change(current);
          writeFileSync(path, JSON.stringify(current));
        }
        return result;
      },
      withCloudflareControl: withCloudflareControlCredential, withOAuthSession: session,
      ...(available ? { withKeyPreflightCloudflare: async action => { calls.push("available-token"); return action(); } } : {}),
      withToken: async action => { if (available) { calls.push("available-token"); return action(); } calls.push("no-token"); throw new Error("no injected token available"); },
      askFn: async () => { calls.push("consent"); return answer; },
      answerKeyOptions: { cf: async () => {
        calls.push("inventory");
        assert.deepEqual(readFileSync(f.manifestPath), before, "profile persistence must wait for the key result");
        return key ? [{ name: "ANTHROPIC_API_KEY" }] : [];
      } },
      cmdVerify: async () => { calls.push("verify"); throw new Error("verified-stage-reached"); },
      cmdUpgrade: async () => { calls.push("upgrade"); throw new Error("unexpected upgrade"); },
      dailyRefreshOptions: { platform: "darwin", schedulerOptions: { launchctl: () => { calls.push("launchctl"); throw new Error("forbidden launchctl"); } } },
    });
  } catch (caught) { error = caught; }
  finally {
    console.log = priorLog;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
  assert.ok(calls.includes("backlog"), "the installed update decision was reached");
  assert.equal(calls.includes("upgrade"), false);
  assert.equal(calls.includes("launchctl"), false);
  assert.ok(snapshots.every(bytes => bytes.every(byte => byte === 0)));
  return { calls, error, before, after: readFileSync(f.manifestPath), manifest: JSON.parse(readFileSync(f.manifestPath)), f };
}

for (const mode of ["adoption", "expired", "revoked"]) {
  test(`approved ${mode} authenticates before the key gate, and missing keys still refuse`, async t => {
    for (const key of [false, true]) {
      const run = await authUpdate(t, { named: mode !== "adoption", state: mode, interactive: mode !== "adoption", key });
      assert.ok(run.calls.includes("authorize"), "the approved authorization was reached");
      assert.ok(run.calls.includes("inventory"), "the key decision was reached after authentication");
      assert.equal(run.calls.includes("verify"), key);
      if (key) {
        assert.match(run.error?.message ?? "", /verified-stage-reached/);
        if (mode === "adoption") {
          assert.equal(run.manifest.infrastructure.cloudflare.auth_profile, cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(run.f.manifestPath)));
          assert.equal(run.manifest.infrastructure.cloudflare.auth_profile_consent, "non-interactive");
        }
      } else {
        assert.match(run.error?.message ?? "", /Anthropic key.*missing/);
        assert.deepEqual(run.after, run.before);
      }
    }
  });
}

for (const mode of ["adoption", "expired", "revoked"]) {
  test(`denied ${mode} preserves the typed remedy and has an approved control`, async t => {
    const options = { named: mode !== "adoption", state: mode, interactive: mode !== "adoption" };
    const denied = await authUpdate(t, { ...options, consent: false, answer: "n" });
    assert.ok(denied.calls.includes(mode === "adoption" ? "no-token" : "consent"), "the refusal decision was reached");
    assert.equal(denied.calls.includes("inventory"), false);
    assert.deepEqual(denied.after, denied.before);
    assert.ok(["AUTH_REQUIRED", "AUTH_EXPIRED"].includes(denied.error?.code));
    const approved = await authUpdate(t, options);
    assert.ok(approved.calls.includes("inventory") && approved.calls.includes("verify"));
  });
}

for (const [field, change] of [
  ["account", m => { m.infrastructure.cloudflare.account_id = "3".repeat(32); }],
  ["Worker", m => { m.brain.worker_name = "other-worker"; }],
  ["model", m => { m.retrieval.answer_model = "@cf/fixture"; }],
  ...[
    ["absent", undefined], ["null", null], ["empty", ""], ["wrong value", "invented"],
    ["wrong case", "NON-INTERACTIVE"], ["whitespace", "non-interactive "], ["wrong type", true],
  ].map(([label, value]) => [`consent ${label}`, m => {
    if (value === undefined) delete m.infrastructure.cloudflare.auth_profile_consent;
    else m.infrastructure.cloudflare.auth_profile_consent = value;
  }]),
  ["profile", m => { m.infrastructure.cloudflare.auth_profile = PROFILE; }],
  ["unrelated", m => { m.testing = { invented: true }; }],
]) {
  test(`adoption delta rejects changed ${field} and accepts the real consent receipt`, async t => {
    const bad = await authUpdate(t, { change, available: true });
    assert.ok(bad.calls.includes("inventory") && bad.calls.includes("authorize"));
    assert.equal(bad.calls.includes("verify"), false);
    assert.match(bad.error?.message ?? "", /settings changed after the Anthropic key check/);
    const good = await authUpdate(t, { available: true });
    assert.ok(good.calls.includes("inventory") && good.calls.includes("verify"));
    assert.equal(good.error?.message, "verified-stage-reached");
    assert.equal(good.manifest.infrastructure.cloudflare.auth_profile_consent, "non-interactive");
  });
}

for (const interactive of [false, true]) {
  test(`real adoption accepts exactly its ${interactive ? "interactive" : "non-interactive"} metadata`, async t => {
    const run = await authUpdate(t, { interactive, available: true });
    assert.ok(run.calls.includes("authorize") && run.calls.includes("inventory"));
    assert.equal(run.error?.message, "verified-stage-reached");
    assert.equal(run.manifest.infrastructure.cloudflare.auth_profile_consent, interactive ? undefined : "non-interactive");
  });
}
