// Settled D1-D4: add-only retention, mailbox-local time, counted skips, and work accounts only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { providerAccessToken, refreshProviderCredentials, saveProviderCredentials, loadProviderCredentials,
  providerOAuthConfig, authorizeProvider, bindMicrosoftConnection } from "../connectors/provider-oauth.mjs";
globalThis.fetch = async () => { throw new Error("UNSCRIPTED_NETWORK_BLOCKED"); };
const NOW = Date.parse("2026-11-17T12:00:00Z");
function fixture(t, provider = "microsoft", extra = {}, platform = process.platform) {
  const home = mkdtempSync(join(homedir(), "refresh-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const custody = [], plaintexts = new Map();
  const storage = { home, backend: "file", platform, environment: {} };
  if (platform === "win32") Object.assign(storage, {
    username: "fixture-user", environment: { SystemRoot: "C:\\Windows", USERNAME: "fixture-user" },
    // Exercise production DPAPI framing and ACL ordering, replacing only host
    // child processes. NTFS cannot prove the POSIX permission-bit contract.
    runPowerShell: (_command, args, options) => {
      const operation = args[args.indexOf("-Operation") + 1];
      custody.push(operation);
      if (operation === "protect") {
        const ciphertext = Buffer.from(`synthetic-ciphertext-${plaintexts.size}`);
        plaintexts.set(ciphertext.toString("base64"), Buffer.from(options.input));
        return { status: 0, stdout: ciphertext, stderr: Buffer.alloc(0) };
      }
      assert.equal(operation, "unprotect");
      const plaintext = plaintexts.get(Buffer.from(options.input).toString("base64"));
      assert.ok(plaintext, "only this fixture's protected payload may be opened");
      return { status: 0, stdout: Buffer.from(plaintext), stderr: Buffer.alloc(0) };
    },
    runAcl: (_command, args) => {
      custody.push("acl");
      assert.equal(readFileSync(args[0]).length, 0, "the staging file is restricted before any payload is written");
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  const connection = saveProviderCredentials(provider, { access_token: "synthetic-old-access", refresh_token: "synthetic-old-refresh",
    expires_at: NOW - 60_000, client_id: "synthetic-client", scopes: providerOAuthConfig(provider).scopes,
    provider_metadata: { microsoft_account_fingerprint: "a".repeat(64) }, ...extra }, storage);
  return { storage, connection, custody };
}
const renewed = () => Response.json({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", expires_in: 3600 });
test("Windows refresh fixture reaches protected-file custody without host credential helpers", async t => {
  const { storage, custody } = fixture(t, "microsoft", {}, "win32");
  assert.equal(storage.platform, "win32");
  assert.ok(custody.includes("protect") && custody.includes("unprotect") && custody.includes("acl"));
  let sent = 0;
  await providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: async () => { sent++; return renewed(); } });
  assert.equal(sent, 1);
  assert.equal(loadProviderCredentials("microsoft", storage).refresh_token, "synthetic-new-refresh");
  const before = readFileSync(storage.path || join(storage.home, ".brain", "microsoft-tokens.json"));
  storage.runAcl = () => { custody.push("acl-refused"); return { status: 1 }; };
  assert.throws(() => saveProviderCredentials("microsoft", { access_token: "synthetic-rejected" }, storage), /restrict/);
  assert.ok(custody.includes("acl-refused"), "the rejected write reached its ACL decision");
  assert.deepEqual(readFileSync(storage.path || join(storage.home, ".brain", "microsoft-tokens.json")), before);
});
for (const code of ["ENOTFOUND", "ENETUNREACH", "ECONNREFUSED"]) {
  test(`A5: wake-before-send ${code} retries next run without sign-in`, async t => {
    const { storage } = fixture(t); let calls = 0;
    await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: async () => {
      calls++; throw Object.assign(new TypeError("Synthetic transport failure"), { cause: { code } });
    } }), error => error.supportCode === "NETWORK_UNREACHABLE" && !/sign in|reconnect/i.test(error.message));
    assert.equal(calls, 1); assert.equal(loadProviderCredentials("microsoft", storage).oauth_refresh_fence, undefined);
    const result = await providerAccessToken("microsoft", { storage, now: NOW + 3600_000, fetchImpl: async () => { calls++; return renewed(); } });
    assert.equal(calls, 2); assert.equal(result.refreshed, true);
    assert.equal(loadProviderCredentials("microsoft", storage).refresh_token, "synthetic-new-refresh");
  });
}
for (const recover of [true, false]) {
  test(`A6: after-send timeout permits exactly one later guarded recovery (recover=${recover})`, async t => {
    const { storage } = fixture(t); let calls = 0; const used = [];
    const timeout = async (_url, init) => { calls++; used.push(init.body.get("refresh_token")); throw Object.assign(new Error("Synthetic timeout"), { name: "AbortError" }); };
    await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: timeout }));
    assert.equal(calls, 1); assert.equal(loadProviderCredentials("microsoft", storage).oauth_refresh_fence.state, "outcome_unknown");
    if (recover) {
      await providerAccessToken("microsoft", { storage, now: NOW + 3600_000, fetchImpl: async (_url, init) => { calls++; used.push(init.body.get("refresh_token")); return renewed(); } });
      assert.equal(calls, 2); assert.equal(loadProviderCredentials("microsoft", storage).refresh_token, "synthetic-new-refresh");
      await providerAccessToken("microsoft", { storage, now: NOW + 7200_000, fetchImpl: async (_url, init) => { calls++; used.push(init.body.get("refresh_token")); return renewed(); } });
      assert.deepEqual(used, ["synthetic-old-refresh", "synthetic-old-refresh", "synthetic-new-refresh"]);
    } else {
      await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW + 3600_000, fetchImpl: timeout }));
      assert.equal(calls, 2, "the one allowed recovery request was actually sent");
      await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW + 7200_000, fetchImpl: timeout }), { code: "refresh_outcome_unknown" });
      assert.equal(calls, 2, "the exhausted recovery never sends a third request");
    }
  });
}

test("A6: response-body DNS-shaped error cannot erase an after-send fence", async t => {
  const { storage } = fixture(t); let calls = 0;
  await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: async () => {
    calls++; return { ok: true, status: 200, json: async () => { throw Object.assign(new Error("Synthetic unreadable body"), { code: "ENOTFOUND" }); } };
  } }));
  assert.equal(calls, 1); assert.ok(loadProviderCredentials("microsoft", storage).oauth_refresh_fence);
  await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW + 3600_000, fetchImpl: async () => { calls++; return renewed(); } }), { code: "refresh_outcome_unknown" });
  assert.equal(calls, 1);
});

test("A6: unrelated provider and mismatched refresh fingerprints retain their fence", async t => {
  for (const provider of ["slack", "microsoft"]) {
    const { storage, connection } = fixture(t, provider, { oauth_refresh_fence: {
      state: "outcome_unknown", microsoft_timeout_retry: 1, token_fingerprint: "b".repeat(64) } });
    let calls = 0;
    await assert.rejects(refreshProviderCredentials(provider, connection, { storage, now: NOW,
      fetchImpl: async () => { calls++; return renewed(); } }), { code: "refresh_outcome_unknown" });
    assert.equal(calls, 0); assert.ok(loadProviderCredentials(provider, storage).oauth_refresh_fence);
  }
});

// Exercise the production callback handler without opening a host listener.
function callbackServer(t, { approve = true } = {}) {
  let handler; let server; let closed = 0; let opened = 0;
  return {
    createServerImpl: callback => {
      handler = callback;
      server = { on() {}, close() { closed++; }, listen(_port, _host, ready) { queueMicrotask(ready); } };
      return server;
    },
    openImpl: url => {
      opened++;
      const auth = new URL(url); const callback = new URL(auth.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", auth.searchParams.get("state"));
      callback.searchParams.set(approve ? "code" : "error", approve ? "synthetic-code" : "access_denied");
      queueMicrotask(() => handler({ headers: { host: callback.host }, url: callback.pathname + callback.search }, {
        writeHead(status) { assert.equal(status, approve ? 200 : 400); return this; }, end() {} }));
      return true;
    },
    counts: () => ({ opened, closed }),
  };
}
const fingerprint = id => createHash("sha256").update(`microsoft-account-v1:${id}`).digest("hex");
for (const mode of ["legacy", "same-account", "different-account", "denied", "missing-new-identity", "corrupt-old-binding", "changed-during-sign-in"]) {
  test(`A7: fresh sign-in with ${mode} preserves the account and retention guards`, async t => {
    const sync_states = { microsoft: { cursor: { mail: { inbox: "https://graph.microsoft.com/v1.0/prior-delta" } } } };
    const { storage } = fixture(t, "microsoft", { sync_states, provider_metadata: mode === "same-account" || mode === "different-account"
      ? { microsoft_account_fingerprint: fingerprint("prior-account") }
      : mode === "corrupt-old-binding" ? { microsoft_account_fingerprint: "invalid-binding" } : {},
      oauth_refresh_fence: { state: "outcome_unknown" } });
    const before = loadProviderCredentials("microsoft", storage);
    const callback = callbackServer(t, { approve: mode !== "denied" }); const calls = []; const logs = [];
    const run = () => authorizeProvider("microsoft", { storage, now: NOW, clientId: "synthetic-client", timeoutMs: 250,
      ...callback, log: line => logs.push(line), fetchImpl: async (url, init) => {
        calls.push(String(url));
        if (String(url).includes("/token")) {
          assert.equal(init.body.get("grant_type"), "authorization_code", "never reuse the fenced refresh token");
          if (mode === "changed-during-sign-in") saveProviderCredentials("microsoft", { ...before, connected_at: "2026-11-16T00:00:00Z" }, storage);
          return renewed();
        }
        assert.match(String(url), /graph.microsoft.com/);
        if (init.headers.Authorization === "Bearer synthetic-old-access") return Response.json({}, { status: 401 });
        return Response.json(mode === "missing-new-identity" ? {} : {
          id: mode === "same-account" ? "prior-account" : "new-account", mail: "owner@business.invalid" });
      } });
    if (["different-account", "denied", "missing-new-identity", "corrupt-old-binding", "changed-during-sign-in"].includes(mode)) {
      await assert.rejects(run(), { code: ({ "different-account": "unexpected_account", denied: "access_denied",
        "missing-new-identity": "account_identity_unproven", "corrupt-old-binding": "account_identity_corrupt",
        "changed-during-sign-in": "credential_changed_during_authorization" })[mode] });
      if (mode === "corrupt-old-binding") assert.equal(callback.counts().opened, 0, "invalid stored binding reached its identity guard");
      else assert.equal(callback.counts().opened, 1, "the rejection decision followed the browser ceremony");
      if (mode !== "changed-during-sign-in") assert.deepEqual(loadProviderCredentials("microsoft", storage), before);
      else assert.equal(loadProviderCredentials("microsoft", storage).connected_at, "2026-11-16T00:00:00Z");
      assert.equal(logs.filter(line => /earlier Microsoft connection/.test(line)).length, 0);
      return;
    }
    const saved = await run();
    assert.deepEqual(callback.counts(), { opened: 1, closed: 1 });
    assert.equal(calls.filter(url => url.includes("/token")).length, 1);
    assert.equal(saved.provider_metadata.microsoft_account_fingerprint, fingerprint(mode === "same-account" ? "prior-account" : "new-account"));
    assert.equal(saved.oauth_refresh_fence, undefined);
    if (mode === "same-account") {
      assert.deepEqual(saved.sync_states, sync_states); assert.equal(saved.microsoft_binding, undefined);
      assert.equal(logs.filter(line => /earlier Microsoft connection/.test(line)).length, 0);
    } else {
      assert.equal(calls.filter(url => url.includes("/me")).length, 2, "old and fresh identity checks were both reached");
      assert.deepEqual(saved.sync_states, {}, "unproved cursors never move to the newly signed-in mailbox");
      const binding = saved.microsoft_binding; assert.ok(binding);
      assert.match(binding.active_binding_id, /^[a-f0-9]{32}$/);
      assert.equal(binding.bindings.legacy.state, "replaced");
      assert.equal(binding.bindings.legacy.replaced_by, binding.active_binding_id);
      assert.deepEqual(binding.bindings.legacy.sync_states, sync_states);
      assert.equal(binding.bindings[binding.active_binding_id].account_fingerprint, fingerprint("new-account"));
      assert.equal(JSON.stringify(binding).includes("synthetic-old-"), false, "the retired binding stores no duplicate credentials");
      assert.deepEqual(loadProviderCredentials("microsoft", storage), saved, "replacement reads back exactly");
      const ownerLines = logs.filter(line => /earlier Microsoft connection/.test(line));
      assert.equal(ownerLines.length, 1); assert.match(ownerLines[0], /owner@business.invalid.*now connected/);
      assert.match(ownerLines[0], /stay in the Brain/);
      const { microsoft_binding: _binding, ...freshCandidate } = saved;
      const again = bindMicrosoftConnection({ prior: saved, candidate: { ...freshCandidate, sync_states: {} } });
      assert.deepEqual(again.microsoft_binding, binding, "same-account re-consent keeps the replacement namespace and history");
    }
  });
}

test("A5/A6: a pre-send wake failure cannot consume the later timeout recovery send", async t => {
  const { storage } = fixture(t); let calls = 0;
  await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: async () => {
    calls++; throw Object.assign(new Error("Synthetic sent request timeout"), { name: "AbortError" });
  } }));
  await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW + 3600_000, fetchImpl: async () => {
    calls++; throw Object.assign(new TypeError("Synthetic wake failure"), { cause: { code: "ENETUNREACH" } });
  } }));
  assert.equal(calls, 2); assert.equal(loadProviderCredentials("microsoft", storage).oauth_refresh_fence.microsoft_timeout_retry, 1);
  const recovered = await providerAccessToken("microsoft", { storage, now: NOW + 7200_000, fetchImpl: async () => { calls++; return renewed(); } });
  assert.equal(calls, 3); assert.equal(recovered.refreshed, true);
  assert.equal(loadProviderCredentials("microsoft", storage).refresh_token, "synthetic-new-refresh");
});

test("A4/A7: renewal preserves the verified Microsoft account binding and source cursors", async t => {
  const sync_states = { microsoft: { cursor: { mail: { inbox: "https://graph.microsoft.com/v1.0/synthetic-prior" } } } };
  const { storage } = fixture(t, "microsoft", { sync_states }); let calls = 0;
  await providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: async () => { calls++; return renewed(); } });
  assert.equal(calls, 1);
  const saved = loadProviderCredentials("microsoft", storage);
  assert.equal(saved.provider_metadata.microsoft_account_fingerprint, "a".repeat(64));
  assert.deepEqual(saved.sync_states, sync_states);
});

test("A6: stale callers cannot receive a fenced credential as a successful renewal", async t => {
  const { storage, connection } = fixture(t); let calls = 0;
  await assert.rejects(providerAccessToken("microsoft", { storage, now: NOW, fetchImpl: async () => {
    calls++; throw Object.assign(new Error("Synthetic timeout"), { name: "AbortError" });
  } }));
  const result = await refreshProviderCredentials("microsoft", { ...connection, access_token: "synthetic-stale-access" },
    { storage, now: NOW + 3600_000, fetchImpl: async () => { calls++; return renewed(); } });
  assert.equal(calls, 2, "the pending timeout permission was recovered under custody");
  assert.equal(result.oauth_refresh_fence, undefined);
  assert.equal(result.refresh_token, "synthetic-new-refresh");
});


test("A7 CLI: fresh mailbox connection, first ingest, renewal and resumed ingest retain earlier history", async t => {
  const { cmdConnectProvider, cmdIngestProvider } = await import("../brain.mjs");
  const oauth = await import("../connectors/provider-oauth.mjs");
  const { syncMicrosoftGraph } = await import("../connectors/microsoft-graph.mjs");
  const oldStates = { microsoft: { cursor: { mail: { inbox: "https://graph.microsoft.com/v1.0/old-delta" } } } };
  const { storage } = fixture(t, "microsoft", { provider_metadata: {}, sync_states: oldStates,
    oauth_refresh_fence: { state: "outcome_unknown" } });
  const keyPath = join(storage.home, "fixture-admin-key");
  writeFileSync(keyPath, ["synthetic", "admin", "proof"].join("-"), { mode: 0o600 });
  const path = join(storage.home, "brain.manifest.json");
  const manifest = { client: { timezone: "America/Phoenix" }, brain: { domain: "brain.invalid" },
    operations: { admin_key_secret: keyPath }, corpora: { microsoft: { enabled: true, mail_folder_ids: ["inbox"], include_personal_drive: false } } };
  writeFileSync(path, JSON.stringify(manifest));
  const callback = callbackServer(t); const logs = []; let exchanges = 0; let profiles = 0;
  t.mock.method(console, "log", line => logs.push(String(line))); t.mock.method(console, "warn", line => logs.push(String(line)));
  const lease = async (_options, run) => run({ assertOwned() {} });
  const result = await cmdConnectProvider("microsoft", path, {}, { storage, environment: {}, withSourceIngestLock: lease,
    log: line => logs.push(line), oauth: { ...oauth, authorizeProvider: (provider, options) => oauth.authorizeProvider(provider,
      { ...options, ...callback, now: NOW }) }, fetchImpl: async (url, init) => {
      if (String(url).includes("/token")) { exchanges++; return renewed(); }
      profiles++;
      return init.headers.Authorization === "Bearer synthetic-old-access" ? Response.json({}, { status: 401 })
        : Response.json({ id: "new-account", mail: "owner@business.invalid" });
    } });
  assert.equal(result.connected, true); assert.deepEqual(callback.counts(), { opened: 1, closed: 1 });
  assert.equal(exchanges, 1); assert.equal(profiles, 2);
  assert.equal(logs.filter(line => /earlier Microsoft connection.*stay in the Brain/.test(line)).length, 1);
  const binding = loadProviderCredentials("microsoft", storage).microsoft_binding;
  const oldUid = "microsoft:outlook:message:collision";
  const documents = new Map([[oldUid, "Synthetic earlier retained evidence."]]); const urls = [];
  const ingest = async () => cmdIngestProvider(manifest, path, { from: "microsoft" }, {
    storage, withSourceIngestLock: lease, resolveAdminKey: () => readFileSync(keyPath, "utf8"),
    resolveBaseUrl: async () => "https://brain.invalid",
    oauth: { ...oauth, providerAccessToken: (provider, options) => oauth.providerAccessToken(provider, { ...options, now: NOW }) },
    sync: options => syncMicrosoftGraph({ ...options, now: () => NOW }),
    fetchImpl: async url => { urls.push(String(url)); return Response.json({ value: String(url).includes("calendar") ? [] : [{
      id: "collision", subject: "Synthetic current mail", bodyPreview: "Synthetic newly signed-in mailbox evidence.",
      receivedDateTime: "2026-11-17T12:00:00Z" }], "@odata.deltaLink": String(url).includes("calendar")
        ? "https://graph.microsoft.com/v1.0/new-calendar-delta" : "https://graph.microsoft.com/v1.0/new-mail-delta" }); },
    requestIngestBatch: async ({ docs }) => { for (const doc of docs) documents.set(`microsoft:${doc.source_id}`, doc.content);
      return { results: docs.map(doc => ({ source_id: doc.source_id, status: "created" })) }; },
    listStoredSourceFamilies: async () => new Set(documents.keys()), postSourceReceipt() {},
    applyDriveRemovals: () => assert.fail("A7 cannot remove earlier history"),
  });
  assert.equal((await ingest()).cursor_advanced, true);
  assert.equal(urls.length, 2); assert.ok(urls.every(url => !url.includes("old-delta")), "old cursors never reach Graph");
  assert.equal(documents.get(oldUid), "Synthetic earlier retained evidence.");
  assert.ok(documents.has(`microsoft:outlook:message:binding:${binding.active_binding_id}:collision`));
  const saved = loadProviderCredentials("microsoft", storage);
  assert.deepEqual(saved.microsoft_binding, binding); assert.deepEqual(binding.bindings.legacy.sync_states, oldStates);
  await providerAccessToken("microsoft", { storage, now: NOW + 7200_000, fetchImpl: async () => { exchanges++; return renewed(); } });
  assert.equal(exchanges, 2); assert.deepEqual(loadProviderCredentials("microsoft", storage).microsoft_binding, binding);
  assert.equal((await ingest()).cursor_advanced, true);
  assert.deepEqual(urls.slice(2), ["https://graph.microsoft.com/v1.0/new-calendar-delta", "https://graph.microsoft.com/v1.0/new-mail-delta"]);
  assert.equal(documents.get(oldUid), "Synthetic earlier retained evidence.");
});
