/**
 * Regression coverage for the macOS Keychain usability probe inside
 * cmdSecrets (brain.mjs, the `adminKeyPlan.backend === "keychain"` guard;
 * the probe itself is macKeychainUsable in operations/admin-key-persistence.mjs).
 *
 * WHY THIS EXISTS. The guard exists to fail fast under a throwaway HOME with
 * no login keychain, instead of hanging on a real `security
 * add-generic-password` call that has nothing to write to (see
 * setup-secrets-write-timeout.test.mjs for the incident that motivated it).
 * Its first shipped version probed the real filesystem (process.env.HOME and
 * a real ~/Library/Keychains) unconditionally -- even when a caller had
 * already substituted its own keychain child-process runner through
 * persistenceOptions.runChild, which is exactly what
 * test/admin-key-rotation.test.mjs's "cmdSecrets Keychain success without
 * adjacent duplicate" case does. On any machine without a real login
 * keychain -- every Linux CI runner, since ~/Library/Keychains is a macOS
 * path -- the probe died before the injected runner was ever reached,
 * breaking that test on ubuntu-latest / node 22 while it happened to pass on
 * macOS runners that have a real one. Reported from CI as:
 *   Fatal [Error]: no usable macOS Keychain was found for this account ...
 *     at die (brain.mjs:408:9)
 *     at cmdSecrets (brain.mjs:2697:7)
 *     at test/admin-key-rotation.test.mjs:853:12
 *
 * This file drives cmdSecrets itself end to end (not macKeychainUsable in
 * isolation -- that stays covered directly in
 * setup-secrets-write-timeout.test.mjs) to prove both halves of the fix:
 *
 *  (a) a caller that injects its own keychain runner is never blocked by the
 *      real-filesystem probe, even on a machine with no ~/Library/Keychains
 *      at all -- proven host-independently by pointing HOME at a freshly
 *      created, empty temporary directory rather than relying on whatever
 *      the machine running this test happens to have.
 *  (b) a caller that injects nothing still gets the guard's fast, actionable
 *      failure when HOME has an empty Keychains directory, so the
 *      throwaway-HOME case the guard exists for is not weakened by (a).
 *
 * Every identifier here is a fictional fixture; none names a real client,
 * account or key.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSecrets } from "../brain.mjs";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-keychain-probe-")));
const replacementKey = `replacement-${"b".repeat(40)}`;
const priorKey = `prior-${"c".repeat(42)}`;

function manifest(operations = undefined) {
  return {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    ...(operations === undefined ? {} : { operations }),
  };
}

function writeManifest(directory, value) {
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function apiResponse(result) {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Same fixture shape as admin-key-rotation.test.mjs's cloudflareHarness. */
function cloudflareHarness(events) {
  const secrets = new Set();
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    if (url.pathname === "/client/v4/accounts" && method === "GET") {
      events.push("account");
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      return apiResponse([...secrets].map((name) => ({ name, type: "secret_text" })));
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      const name = JSON.parse(String(options.body || "{}")).name;
      events.push(`remote:${name}`);
      secrets.add(name);
      return apiResponse({});
    }
    throw new Error(`offline fixture has no response for ${method} ${url.pathname}`);
  };
}

/** Same isolation shape as admin-key-rotation.test.mjs's isolatedRuntime. */
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
    return { value, output: output.join("\n") };
  } catch (error) {
    error.capturedOutput = output.join("\n");
    throw error;
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
}

/** A total stand-in for the real `security`/expect children: no filesystem, no HOME. */
function fakeKeychain({ initial = null } = {}) {
  let stored = initial;
  return {
    get stored() { return stored; },
    runChild(command, args, options = {}) {
      const input = options.input === undefined ? null : Buffer.from(options.input);
      const securityAction = command.endsWith("/expect") ? args[2] : args[0];
      if (securityAction === "find-generic-password") {
        if (stored === null) {
          return { status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from("item not found") };
        }
        return { status: 0, stdout: Buffer.from(`${stored}\n`), stderr: Buffer.alloc(0) };
      }
      if (securityAction === "add-generic-password") {
        stored = input.subarray(0, input.length - 1).toString("utf8");
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (securityAction === "delete-generic-password") {
        stored = null;
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("unexpected child") };
    },
  };
}

/** Run `body` with process.env.HOME pointed at `home`, restoring it after. */
async function withHome(home, body) {
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await body();
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  }
}

try {
  /* ---------------- (a) an injected keychain runner is never blocked by the real-filesystem probe ---------------- */
  const injectedDir = join(sandbox, "injected-runner");
  mkdirSync(injectedDir, { mode: 0o700 });
  const injectedManifest = writeManifest(
    injectedDir,
    manifest({ admin_key_secret: "keychain://fixture-brain-admin/owner" }),
  );
  // A machine with no ~/Library/Keychains at all under it -- the exact shape
  // of a Linux CI runner's HOME, reproduced host-independently instead of
  // depending on whatever HOME this test happens to actually run under.
  const noKeychainsHome = mkdtempSync(join(sandbox, "no-keychains-home-"));
  const injectedKeychain = fakeKeychain({ initial: priorKey });
  const injectedEvents = [];
  await withHome(noKeychainsHome, () => isolatedRuntime({
    fetchImpl: cloudflareHarness(injectedEvents),
    env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
  }, () => cmdSecrets(injectedManifest, {
    platform: "darwin",
    // Deliberately the same shape as admin-key-rotation.test.mjs:855 -- a
    // runChild is injected but the environment carries no HOME override, so
    // the only way this can pass on a machine without ~/Library/Keychains is
    // for the guard to skip its real-filesystem probe because the read and
    // write below never touch the real filesystem either.
    persistenceOptions: { runChild: injectedKeychain.runChild, environment: { ADMIN_KEY: replacementKey } },
  })));
  assert.deepEqual(
    injectedEvents,
    ["account", "remote:ADMIN_KEY", "remote:RAG_PROXY_KEY", "remote:SESSION_SIGNING_KEY"],
    "an injected keychain runner must reach and complete the full rotation, not die in the usability probe",
  );
  assert.equal(injectedKeychain.stored, replacementKey, "the injected keychain runner received the rotated key");

  /* ---------------- (b) no injected runner + an empty Keychains directory still fails fast ---------------- */
  const realShapeDir = join(sandbox, "real-shape");
  mkdirSync(realShapeDir, { mode: 0o700 });
  const realShapeManifest = writeManifest(
    realShapeDir,
    manifest({ admin_key_secret: "keychain://fixture-brain-admin/owner" }),
  );
  const emptyKeychainsHome = mkdtempSync(join(sandbox, "empty-keychains-home-"));
  mkdirSync(join(emptyKeychainsHome, "Library", "Keychains"), { recursive: true });
  const realShapeEvents = [];
  await withHome(emptyKeychainsHome, () => assert.rejects(
    isolatedRuntime({
      fetchImpl: async (input) => {
        realShapeEvents.push("fetch");
        throw new Error(`unexpected network call: ${input}`);
      },
      env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
    }, () => cmdSecrets(realShapeManifest, {
      platform: "darwin",
      // No persistenceOptions at all: this is the real, unmodified default
      // path the guard exists to protect, so it must still consult the real
      // filesystem and die before any child process or network call.
    })),
    /no usable macOS Keychain was found for this account.*~\/Library\/Keychains/is,
  ));
  assert.deepEqual(realShapeEvents, [], "the guard must die before any network call, exactly as before this fix");

  console.log("admin key keychain usability probe: all focused offline tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
