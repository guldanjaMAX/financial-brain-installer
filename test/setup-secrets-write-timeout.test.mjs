/**
 * cmdSecrets must not hang forever writing a Worker secret.
 *
 * WHY THIS EXISTS. FINDING-SETUP-HANG-2026-09-23.md: on CLI 0.4.1, `brain
 * setup` printed "ok generated an admin key for this brain" and then sat for
 * over nine minutes at 0% CPU with no further output. The finding guessed
 * network: cmdSecrets' next step writes that key to the Worker over HTTP.
 * Rehearsed again on 2026-09-23, the actual repro was a HARNESS ARTIFACT --
 * the rehearsal ran under a throwaway HOME with no login keychain, and under
 * such a HOME `security add-generic-password` (the macOS Keychain write
 * cmdSecrets' admin-key persistence goes through, right after "generated an
 * admin key") blocks indefinitely at 0% CPU with no output, while
 * `security find-generic-password` (the read) fails instantly. Not a
 * network call at all.
 *
 * That leaves two real improvements, both covered below:
 *  1. Every Cloudflare API write cmdSecrets makes while writing or
 *     reconciling Worker secrets is now bounded (~90s) with a periodic
 *     "still waiting for ..." line and an actionable timeout failure --
 *     good hygiene regardless of which path actually hung historically.
 *  2. Before any macOS Keychain read or write of the admin key, cmdSecrets
 *     now checks for a usable login keychain and fails fast and actionably
 *     if there is none, instead of finding out nine minutes later. When a
 *     keychain DOES exist, cmdSecrets narrates that it is about to touch it
 *     and names the real possibility of a human "Allow?" prompt -- and
 *     deliberately does NOT wrap that read/write in a short timeout, because
 *     only a person can answer that prompt.
 *
 * This file uses a transport stub whose Worker-secret PUT never settles (a
 * bare pending Promise, not a real socket) for (1), and a stubbed Keychain
 * persist function that never settles for (2)'s fast-fail path, with a small
 * injected network timeout so the test proves the real machinery in
 * milliseconds rather than the product's 90s/15s defaults.
 *
 * Every identifier here is a fictional fixture; none names a real client,
 * account or key.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSecrets } from "../brain.mjs";
import { macKeychainUsable } from "../operations/admin-key-persistence.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const FIXTURE_KEY = `fixture-admin-${"a".repeat(40)}`;

function apiResponse(result) {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that answers account and secret-inventory reads normally, but
 * never answers the secret WRITE -- the exact shape of a blocked socket,
 * without opening a real one. The fixture never inspects `options.signal`,
 * so this is inert: it holds no timer or handle, and cannot itself keep the
 * test process alive after the test's own bounded wait gives up on it.
 */
function stalledSecretsWriteFetch(events) {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    if (url.pathname === "/client/v4/accounts" && method === "GET") {
      events.push("accounts");
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      events.push("secrets:list");
      return apiResponse([]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      const name = JSON.parse(String(options.body || "{}")).name;
      events.push(`secrets:put:${name}`);
      return new Promise(() => {}); // never resolves, never rejects
    }
    throw new Error(`offline fixture has no response for ${method} ${url.pathname}`);
  };
}

async function isolatedRuntime({ fetchImpl, env }, operation) {
  const priorFetch = globalThis.fetch;
  const names = ["CLOUDFLARE_API_TOKEN", "ADMIN_KEY"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const output = [];
  const priorLog = console.log;
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...args) => output.push(args.map(String).join(" "));
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(env || {})) process.env[name] = value;
    const value = await operation();
    return { value, error: null, output: output.join("\n") };
  } catch (error) {
    return { value: undefined, error, output: output.join("\n") };
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
}

/* --------------------------------------- macKeychainUsable, in isolation --------------------------------------- */
{
  check("a non-macOS platform is never blocked on this check",
    macKeychainUsable({ platform: "linux", exists: () => false, readdir: () => { throw new Error("must not run"); } }) === true);
  check("darwin with no HOME at all is not usable",
    macKeychainUsable({ platform: "darwin", home: "", exists: () => true }) === false);
  check("darwin with a real login.keychain-db is usable",
    macKeychainUsable({
      platform: "darwin", home: "/Users/fixture",
      exists: (p) => p === "/Users/fixture/Library/Keychains/login.keychain-db",
    }) === true);
  check("darwin with some OTHER *.keychain-db (a renamed or non-default keychain) is still usable",
    macKeychainUsable({
      platform: "darwin", home: "/Users/fixture",
      exists: () => false,
      readdir: () => ["not-a-keychain.txt", "custom.keychain-db"],
    }) === true);
  check("darwin with a Keychains directory that cannot be listed is not usable",
    macKeychainUsable({
      platform: "darwin", home: "/Users/fixture",
      exists: () => false,
      readdir: () => { throw new Error("ENOENT: no such directory"); },
    }) === false);
  check("darwin with an empty Keychains directory is not usable",
    macKeychainUsable({
      platform: "darwin", home: "/Users/fixture",
      exists: () => false,
      readdir: () => ["not-a-keychain.txt"],
    }) === false);
}

const sandbox = mkdtempSync(join(tmpdir(), "brain-secrets-write-timeout-"));
try {
  const manifestDir = join(sandbox, "client");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
  }, null, 2));

  const events = [];
  const started = Date.now();
  const { error, output } = await isolatedRuntime({
    fetchImpl: stalledSecretsWriteFetch(events),
    env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-token" },
  }, () => cmdSecrets(manifestPath, {
    explicitAdminKey: FIXTURE_KEY,
    // Keychain, not file: skips the adjacent-.gitignore and key-directory
    // dance entirely, which is a different concern from this test's.
    adminKeyPersistencePlan: () => Object.freeze({
      backend: "keychain", service: "fixture-brain-admin", account: "owner",
    }),
    // Hermetic: says the keychain is usable without reading whatever HOME
    // this test happens to run under, so the test's outcome cannot depend on
    // the real test machine's login keychain state one way or the other.
    macKeychainUsable: () => true,
    persistAdminKeyDurably: async (plan) => Object.freeze({ ...plan, verified: true }),
    // The small injected timeout: proves the real bounded-wait machinery
    // (periodic narration, then an actionable failure) without the test
    // waiting on the 90s/15s product defaults.
    secretsWriteTimeoutMs: 1000,
    secretsWriteWaitIntervalMs: 250,
  }));
  const elapsedMs = Date.now() - started;

  check("cmdSecrets reached the account and secret-inventory reads before the stalled write",
    events.includes("accounts") && events.includes("secrets:list"), JSON.stringify(events));
  check("cmdSecrets attempted exactly one write of the stalled secret, never a busy retry loop",
    events.filter((e) => e === "secrets:put:ADMIN_KEY").length === 1, JSON.stringify(events));

  check("cmdSecrets gives up instead of hanging forever", error !== null, "expected cmdSecrets to reject");
  check("it gives up close to the injected timeout, not the 90s/60s product default",
    elapsedMs < 5_000, `${elapsedMs}ms`);

  check("while waiting, it prints the same-toned waiting line this CLI uses elsewhere",
    /still waiting for the ADMIN_KEY secret write \(\d+s\)\. This is normal\./.test(output), output);
  check("it also narrates the keychain step it is about to take, since a human may need to click Allow",
    /reading and writing this Brain's admin key through the macOS Keychain/.test(output) &&
      /click Allow/.test(output),
    output);

  const message = String(error?.message || "");
  check("on timeout it names what it was doing and for how long",
    /^the ADMIN_KEY secret write did not respond within 1s\./.test(message), message);
  check("the failure is actionable: nothing was half-written",
    /Nothing was half-written/i.test(message), message);
  check("the failure says re-running `brain setup` resumes safely",
    /brain setup <manifest>.*resumes safely/is.test(message) || /resumes safely.*brain setup/is.test(message),
    message);
  check("the failure also names `brain secrets` as the direct retry path",
    /brain secrets <manifest>/.test(message), message);

  /* --------------- no usable keychain: fail fast, never call the writer --------------- */
  // The coordinator's ask: a stubbed keychain writer that never returns must
  // hit the fast-fail path, not hang. A `setTimeout` safety net means a
  // regression here fails this one check within ~2s instead of hanging the
  // whole suite.
  {
    let persistCalls = 0;
    let guardTimer;
    const guard = new Promise((resolve) => {
      guardTimer = setTimeout(() => resolve({ timedOut: true }), 2_000);
    });
    const attempt = isolatedRuntime({
      // No call should ever reach the network: the fast-fail check runs
      // before account resolution, let alone a secret write.
      fetchImpl: async (input) => { throw new Error(`unexpected network call: ${input}`); },
      env: {},
    }, () => cmdSecrets(manifestPath, {
      explicitAdminKey: FIXTURE_KEY,
      adminKeyPersistencePlan: () => Object.freeze({
        backend: "keychain", service: "fixture-brain-admin", account: "owner",
      }),
      macKeychainUsable: () => false,
      persistAdminKeyDurably: () => { persistCalls++; return new Promise(() => {}); },
    })).then((result) => ({ timedOut: false, ...result }));
    const outcome = await Promise.race([attempt, guard]);
    clearTimeout(guardTimer);

    check("with no usable keychain, cmdSecrets fails fast rather than hanging",
      outcome.timedOut !== true, "cmdSecrets did not settle within the test's 2s safety net");
    check("it never calls the keychain persist function at all",
      persistCalls === 0, `called ${persistCalls} time(s)`);
    const noKeychainMessage = String(outcome.error?.message || "");
    check("the failure names the real cause: no usable macOS Keychain",
      /no usable macOS Keychain was found/i.test(noKeychainMessage), noKeychainMessage);
    check("the failure points at both real remedies: a real session, or the file backend",
      /login keychain under/i.test(noKeychainMessage) &&
        /operations\.admin_key_secret/i.test(noKeychainMessage) &&
        /file-backed default/i.test(noKeychainMessage),
      noKeychainMessage);
    check("nothing about this failure misattributes it to a network problem",
      !/network|socket|fetch/i.test(noKeychainMessage), noKeychainMessage);
  }

  /* ---------- the same fast-fail also guards the READ path, not just the write ---------- */
  {
    let readCalls = 0;
    let guardTimer;
    const guard = new Promise((resolve) => {
      guardTimer = setTimeout(() => resolve({ timedOut: true }), 2_000);
    });
    const attempt = isolatedRuntime({
      fetchImpl: async (input) => { throw new Error(`unexpected network call: ${input}`); },
      env: {},
    }, () => cmdSecrets(manifestPath, {
      // No explicitAdminKey this time: a standalone `brain secrets` rotation
      // reads the durable key rather than being handed one by `brain setup`.
      adminKeyPersistencePlan: () => Object.freeze({
        backend: "keychain", service: "fixture-brain-admin", account: "owner",
      }),
      macKeychainUsable: () => false,
      readAdminKeyDurably: () => { readCalls++; return new Promise(() => {}); },
    })).then((result) => ({ timedOut: false, ...result }));
    const outcome = await Promise.race([attempt, guard]);
    clearTimeout(guardTimer);

    check("the fast-fail check also guards standalone key rotation's read of the keychain",
      outcome.timedOut !== true, "cmdSecrets did not settle within the test's 2s safety net");
    check("it never calls the keychain read function at all",
      readCalls === 0, `called ${readCalls} time(s)`);
    check("the read-path failure is the same actionable no-keychain message",
      /no usable macOS Keychain was found/i.test(String(outcome.error?.message || "")),
      String(outcome.error?.message || ""));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
