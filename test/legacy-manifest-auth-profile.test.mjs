/**
 * A Brain installed before `auth_profile` existed must still be updatable.
 *
 * WHY THIS EXISTS. `buildSetupManifest` is the only writer of
 * `infrastructure.cloudflare.auth_profile`, and it runs only for a manifest
 * that does not exist yet. Setup's existing-manifest branch validates the
 * saved profile and never assigns one. So every install created before that
 * field shipped carries an account id and no profile, for ever.
 *
 * `withCloudflareControlCredential` reads "no saved profile" as "no saved
 * custody" and takes the token lane unconditionally:
 *
 *     if (forceToken || (!freshOAuth && !authProfile)) return await runToken();
 *
 * `freshOAuth` is only ever true for a first-time setup, so a resumed install
 * always lands there. On a real client machine all three token sources are
 * then empty: no wrangler `default.toml` (modern wrangler keeps an encrypted
 * `default.enc` that only wrangler can unwrap), no macOS keychain copy (that
 * store is darwin-only), and no hidden prompt (it refuses without real TTYs).
 * The command dies AUTH_REQUIRED. That took a live client's Brain down.
 *
 * The repair is adoption on update: derive the profile name a fresh install
 * would have used, complete and verify the browser sign-in, and only then
 * write the label — before `pinUpdateManifest` fingerprints the file.
 *
 * This test drives the real `cmdUpdate` three times against one legacy
 * manifest, on a faked win32 host with every token source empty:
 *
 *   A. today's behavior, adoption suppressed  -> AUTH_REQUIRED, manifest intact
 *   B. the fix, interactive                   -> OAuth lane, profile recorded
 *   C. the same non-interactive command again -> now succeeds on the saved
 *                                                profile, which is the state
 *                                                every agent session inherits
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptCloudflareAuthProfile,
  cloudflareOAuthInstallIdentity,
  cmdUpdate,
  readHiddenCloudflareToken,
} from "../brain.mjs";
import { cloudflareOAuthProfileName } from "../operations/cloudflare-oauth-session.mjs";
import { findWranglerConfig, readWranglerOAuthToken } from "../operations/wrangler-oauth.mjs";
import { loadStoredCloudflareToken } from "../operations/cloudflare-token-store.mjs";
import { WRANGLER_AUTH_PROFILE_PATTERN, wranglerProfileName } from "../doctor.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCOUNT_ID = "9f2c1d4b7a6e8035c1d24b9e7f60a381";
const OAUTH_TOKEN = "x".repeat(48);

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

/* ---- the 0.3.5 manifest shape: an account id, and no auth_profile ---- */
const legacyManifest = () => ({
  client: { slug: "legacy", display_name: "Legacy Install", primary_contact: "", timezone: "UTC" },
  brain: { version: "0.3.5", worker_name: "legacy-brain" },
  infrastructure: {
    cloudflare: {
      account_id: ACCOUNT_ID,
      d1_database_name: "legacy-brain",
      storage: "d1",
    },
  },
  retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", rerank: false },
});

const schemaAuthProfilePattern = new RegExp(
  JSON.parse(readFileSync(join(ROOT, "manifest.schema.json"), "utf8"))
    .properties.infrastructure.properties.cloudflare.properties.auth_profile.pattern,
);

/* ---- the two profile-name schemes are not interchangeable ---- */
{
  const sixteen = wranglerProfileName(ACCOUNT_ID);
  check(
    "doctor's legacy 16-hex account profile is refused by the saved-profile pattern",
    /^financial-brain-[a-f0-9]{16}$/.test(sixteen) && !WRANGLER_AUTH_PROFILE_PATTERN.test(sixteen),
    sixteen,
  );
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-legacy-auth-profile-")));
const priorToken = process.env.CLOUDFLARE_API_TOKEN;
const priorStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const priorLog = console.log;

try {
  delete process.env.CLOUDFLARE_API_TOKEN;
  // The hidden prompt refuses unless stdin AND stderr are real terminals. Fake
  // the agent-driven session so the refusal is the real one, not a stub, and
  // so this test cannot hang when a developer runs it from a terminal.
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

  /* ---- source 1: wrangler keeps an encrypted default.enc, not default.toml ---- */
  const winHome = join(sandbox, "win-home");
  mkdirSync(join(winHome, ".wrangler", "config"), { recursive: true });
  writeFileSync(join(winHome, ".wrangler", "config", "default.enc"), "encrypted-by-wrangler");
  const winEnv = {
    USERPROFILE: winHome,
    APPDATA: join(winHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(winHome, "AppData", "Local"),
  };
  check(
    "an encrypted default.enc leaves findWranglerConfig with nothing to read",
    findWranglerConfig({ env: winEnv, platform: "win32" }) === null,
  );
  check(
    "so the wrangler-session token source is empty",
    readWranglerOAuthToken({ env: winEnv, platform: "win32" }) === null,
  );
  /* ---- source 2: the per-account keychain copy is darwin-only ---- */
  check(
    "the remembered-token store is empty on Windows by construction",
    loadStoredCloudflareToken(ACCOUNT_ID, { platform: "win32" }) === null,
  );
  /* ---- source 3: the hidden prompt refuses without real terminals ---- */
  let promptRefusal = null;
  try {
    await readHiddenCloudflareToken();
  } catch (error) { promptRefusal = error; }
  check(
    "and the hidden token prompt refuses in an agent-driven session",
    /cannot prompt securely/.test(promptRefusal?.message || ""),
    promptRefusal?.message,
  );

  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(legacyManifest(), null, 2) + "\n");
  const legacyBytes = readFileSync(manifestPath, "utf8");
  const installedManifestOptions = { home: sandbox, stateDirectory: join(sandbox, "installed-state") };

  const expectedProfile = cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(manifestPath));
  check(
    "the adopted profile uses the 24-hex install-identity scheme, not the 16-hex account one",
    WRANGLER_AUTH_PROFILE_PATTERN.test(expectedProfile) &&
      expectedProfile !== wranglerProfileName(ACCOUNT_ID),
    expectedProfile,
  );

  /* ---- stubs: wrangler's child process and Cloudflare's read-only API ---- */
  const wranglerCalls = [];
  const manifestProfileNow = () => {
    try { return JSON.parse(readFileSync(manifestPath, "utf8")).infrastructure?.cloudflare?.auth_profile ?? null; }
    catch { return null; }
  };
  const processRunner = (command, argv) => {
    const args = argv.map((value) => String(value).replaceAll('"', ""));
    const stage = args.includes("keyring") ? "keyring"
      : args.includes("create") ? "create"
      : args.includes("token") ? "token"
      : "unknown";
    // `auth keyring enable` names no profile; `auth create` and `auth token` do.
    const profile = stage === "token" ? args[args.indexOf("--profile") + 1]
      : stage === "create" ? args[args.indexOf("create") + 1]
      : null;
    wranglerCalls.push({ command, stage, profile, manifestProfileAtCall: manifestProfileNow() });
    const stdout = stage === "token"
      ? Buffer.from(JSON.stringify({ type: "oauth", token: OAUTH_TOKEN }), "ascii")
      : Buffer.alloc(0);
    return { status: 0, error: null, signal: null, stdout, stderr: Buffer.alloc(0) };
  };

  const authorizations = [];
  const jsonResponse = (body) => {
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(bytes.length) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const account = { id: ACCOUNT_ID, name: "Legacy Client" };
  const fetchImpl = async (url, init) => {
    authorizations.push(String(init?.headers?.Authorization || ""));
    const target = `${url.pathname}${url.search}`;
    if (target === "/client/v4/accounts?page=1&per_page=50") {
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [account],
        result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 },
      });
    }
    if (target === `/client/v4/accounts/${ACCOUNT_ID}`) {
      return jsonResponse({ success: true, errors: [], messages: [], result: account });
    }
    if (target.startsWith(`/client/v4/accounts/${ACCOUNT_ID}/`)) {
      return jsonResponse({ success: true, errors: [], messages: [], result: [] });
    }
    throw new Error(`unexpected Cloudflare request: ${target}`);
  };

  let tokenPromptCalls = 0;
  const readCloudflareToken = (...args) => {
    tokenPromptCalls++;
    return readHiddenCloudflareToken(...args);
  };
  const baseOptions = () => ({
    installedManifestOptions,
    loadStoredCloudflareToken: () => null,
    readCloudflareToken,
    oauthOptions: { processRunner, fetchImpl, platformName: "win32" },
    installTechnicianSkills: () => [],
    reportSkillRefreshOk: () => {},
    reportSkillRefreshWarning: () => {},
    askFn: async () => "y",
  });

  /* ---- A. today's path: no adoption, no credential, AUTH_REQUIRED ---- */
  const eventsA = [];
  let failure = null;
  console.log = () => {};
  try {
    await cmdUpdate(manifestPath, {
      ...baseOptions(),
      interactive: false,
      // Exactly the product before this fix: nothing ever adds auth_profile.
      adoptCloudflareAuthProfile: async () => null,
      cmdVerify: async () => { eventsA.push("verify"); },
      cmdUpgrade: async () => { eventsA.push("upgrade"); },
    });
  } catch (error) { failure = error; }
  console.log = priorLog;
  check(
    "without an adopted profile the legacy manifest still dies AUTH_REQUIRED",
    failure?.code === "AUTH_REQUIRED" && eventsA.length === 0 && tokenPromptCalls === 1,
    JSON.stringify({ code: failure?.code, message: failure?.message, eventsA, tokenPromptCalls }),
  );
  check(
    "and the failed run changed nothing on disk",
    readFileSync(manifestPath, "utf8") === legacyBytes && wranglerCalls.length === 0,
  );

  /* ---- B. the fix: an interactive update adopts the profile ---- */
  const promptCountBeforeB = tokenPromptCalls;
  const eventsB = [];
  const sentinel = { updated: "legacy" };
  console.log = () => {};
  const resultB = await cmdUpdate(manifestPath, {
    ...baseOptions(),
    interactive: true,
    cmdVerify: async (path) => {
      eventsB.push({ stage: "verify", path, profile: manifestProfileNow() });
    },
    cmdUpgrade: async (path) => {
      eventsB.push({ stage: "upgrade", path, profile: manifestProfileNow() });
      return sentinel;
    },
  });
  console.log = priorLog;

  const written = JSON.parse(readFileSync(manifestPath, "utf8"));
  const savedProfile = written.infrastructure?.cloudflare?.auth_profile;
  check(
    "1/3 the manifest on disk now carries a 24-hex auth_profile its own schema accepts",
    savedProfile === expectedProfile &&
      WRANGLER_AUTH_PROFILE_PATTERN.test(savedProfile) &&
      schemaAuthProfilePattern.test(savedProfile),
    JSON.stringify({ savedProfile, expectedProfile }),
  );
  check(
    "adoption changes only that one field",
    JSON.stringify({ ...written, infrastructure: undefined }) ===
      JSON.stringify({ ...JSON.parse(legacyBytes), infrastructure: undefined }) &&
      written.infrastructure.cloudflare.account_id === ACCOUNT_ID &&
      written.infrastructure.cloudflare.d1_database_name === "legacy-brain",
    readFileSync(manifestPath, "utf8"),
  );

  const stages = wranglerCalls.map((call) => call.stage).join(",");
  check(
    "2/3 the credential wrapper took the OAuth lane, never the token lane",
    tokenPromptCalls === promptCountBeforeB &&
      stages === "keyring,create,token,keyring,token" &&
      wranglerCalls.filter((call) => call.stage !== "keyring")
        .every((call) => call.profile === expectedProfile) &&
      wranglerCalls.filter((call) => call.stage === "keyring").every((call) => call.profile === null) &&
      authorizations.length > 0 &&
      authorizations.every((value) => value === `Bearer ${OAUTH_TOKEN}`),
    JSON.stringify({ tokenPromptCalls, promptCountBeforeB, stages, calls: wranglerCalls.map((c) => c.profile) }),
  );
  check(
    "the update itself ran and returned its own result",
    resultB === sentinel &&
      eventsB.map((event) => event.stage).join(",") === "verify,upgrade" &&
      eventsB.every((event) => event.path === manifestPath),
    JSON.stringify(eventsB),
  );

  const proofCall = wranglerCalls[2];
  const controlCall = wranglerCalls[4];
  check(
    "the label is written only after the sign-in proves itself, never before",
    proofCall.stage === "token" && proofCall.manifestProfileAtCall === null,
    JSON.stringify(proofCall),
  );
  check(
    "3/3 the write lands before the update pin, so no stage revalidation trips",
    controlCall.stage === "token" && controlCall.manifestProfileAtCall === expectedProfile &&
      eventsB.every((event) => event.profile === expectedProfile) &&
      !/changed during/.test(String(resultB?.message || "")),
    JSON.stringify({ controlCall, eventsB }),
  );

  /* ---- C. the same non-interactive command the agent session runs ---- */
  const promptCountBeforeC = tokenPromptCalls;
  const callsBeforeC = wranglerCalls.length;
  const eventsC = [];
  console.log = () => {};
  const resultC = await cmdUpdate(manifestPath, {
    ...baseOptions(),
    interactive: false,
    cmdVerify: async () => { eventsC.push("verify"); },
    cmdUpgrade: async () => { eventsC.push("upgrade"); return sentinel; },
  });
  console.log = priorLog;
  check(
    "the once-broken non-interactive update now runs on the saved profile",
    resultC === sentinel && eventsC.join(",") === "verify,upgrade" &&
      tokenPromptCalls === promptCountBeforeC &&
      wranglerCalls.slice(callsBeforeC).map((call) => call.stage).join(",") === "keyring,token",
    JSON.stringify({ eventsC, tokenPromptCalls, added: wranglerCalls.slice(callsBeforeC) }),
  );

  /* ---- the escapes the fix must never take away ----
   *
   * A stub that THROWS cannot prove a refusal. The helper catches every
   * sign-in failure and returns null, so a throwing stub reports the same
   * outcome whether the guard refused up front or a ceremony was started and
   * then swallowed. Deleting all three guards passed a throwing-stub version
   * of this block 22/22. The spy therefore RECORDS the attempt and returns a
   * session that would be accepted, so a leaked ceremony shows up twice: as a
   * recorded attempt, and as a manifest that changed.
   *
   * The headless case is the one that matters in the field: a real leak would
   * spawn `wrangler auth create`, open a browser and block on its callback in
   * a session with nobody at the keyboard.
   */
  const recordingSession = () => {
    const attempts = [];
    return {
      attempts,
      withOAuthSession: async (request) => {
        attempts.push(request);
        return {
          profile: request?.profile,
          account: { id: String(request?.expectedAccountId || ACCOUNT_ID), name: "Legacy Client" },
        };
      },
    };
  };
  const untouched = join(sandbox, "untouched.manifest.json");
  const refuse = async (label, options) => {
    writeFileSync(untouched, legacyBytes);
    const spy = recordingSession();
    console.log = () => {};
    const outcome = await adoptCloudflareAuthProfile(untouched, {
      askFn: async () => "y",
      withOAuthSession: spy.withOAuthSession,
      ...options,
    });
    console.log = priorLog;
    check(
      label,
      outcome === null && spy.attempts.length === 0 && readFileSync(untouched, "utf8") === legacyBytes,
      JSON.stringify({ outcome, attempts: spy.attempts.length }),
    );
  };
  await refuse("an explicit --cloudflare-token run starts no sign-in", { interactive: true, forceToken: true, env: {} });
  await refuse("a headless run starts no sign-in", { interactive: false, env: {} });
  await refuse("an injected CLOUDFLARE_API_TOKEN starts no sign-in", { interactive: true, env: { CLOUDFLARE_API_TOKEN: "t".repeat(40) } });
  await refuse("declining the browser sign-in starts no sign-in", {
    interactive: true, env: {}, askFn: async () => "n",
  });

  const alreadyBound = join(sandbox, "bound.manifest.json");
  const bound = legacyManifest();
  bound.infrastructure.cloudflare.auth_profile = `financial-brain-${createHash("sha256").update("bound").digest("hex").slice(0, 24)}`;
  const boundBytes = JSON.stringify(bound, null, 2) + "\n";
  writeFileSync(alreadyBound, boundBytes);
  const boundSpy = recordingSession();
  console.log = () => {};
  const boundOutcome = await adoptCloudflareAuthProfile(alreadyBound, {
    interactive: true,
    env: {},
    askFn: async () => "y",
    withOAuthSession: boundSpy.withOAuthSession,
  });
  console.log = priorLog;
  check(
    "an install that already has a profile is never re-bound, and never signs in again",
    boundOutcome === null && boundSpy.attempts.length === 0 &&
      readFileSync(alreadyBound, "utf8") === boundBytes,
    JSON.stringify({ boundOutcome, attempts: boundSpy.attempts.length }),
  );

  const noAccount = join(sandbox, "no-account.manifest.json");
  const partial = legacyManifest();
  partial.infrastructure.cloudflare.account_id = "REQUIRED_client_account_id";
  const partialBytes = JSON.stringify(partial, null, 2) + "\n";
  writeFileSync(noAccount, partialBytes);
  const partialSpy = recordingSession();
  console.log = () => {};
  const partialOutcome = await adoptCloudflareAuthProfile(noAccount, {
    interactive: true,
    env: {},
    askFn: async () => "y",
    withOAuthSession: partialSpy.withOAuthSession,
  });
  console.log = priorLog;
  check(
    "a manifest with no real account id neither signs in nor gets a profile it could not honour",
    partialOutcome === null && partialSpy.attempts.length === 0 &&
      readFileSync(noAccount, "utf8") === partialBytes,
    JSON.stringify({ partialOutcome, attempts: partialSpy.attempts.length }),
  );

  /* ---- a browser ceremony takes real time; the file can move under it ---- */
  const raced = join(sandbox, "raced.manifest.json");
  writeFileSync(raced, legacyBytes);
  const racedSpy = recordingSession();
  console.log = () => {};
  const racedOutcome = await adoptCloudflareAuthProfile(raced, {
    interactive: true,
    env: {},
    // The prompt runs after the first read and before the sign-in, which is
    // exactly the window a second session writes in.
    askFn: async () => {
      const concurrent = JSON.parse(readFileSync(raced, "utf8"));
      concurrent.brain.worker_name = "renamed-by-another-session";
      writeFileSync(raced, JSON.stringify(concurrent, null, 2) + "\n");
      return "y";
    },
    withOAuthSession: racedSpy.withOAuthSession,
  });
  console.log = priorLog;
  const racedWritten = JSON.parse(readFileSync(raced, "utf8"));
  check(
    "a manifest changed during the ceremony keeps that change and still gets the profile",
    racedOutcome === cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(raced)) &&
      racedWritten.brain.worker_name === "renamed-by-another-session" &&
      racedWritten.infrastructure.cloudflare.auth_profile === racedOutcome,
    JSON.stringify(racedWritten.brain),
  );

  /* ---- a sign-in that fails must not leave a label pointing at nothing ---- */
  const failing = join(sandbox, "failing.manifest.json");
  writeFileSync(failing, legacyBytes);
  let ceremonies = 0;
  console.log = () => {};
  const failedOutcome = await adoptCloudflareAuthProfile(failing, {
    interactive: true,
    env: {},
    askFn: async () => "y",
    withOAuthSession: async () => {
      ceremonies++;
      throw new Error("browser authorization did not complete");
    },
  });
  const mismatchOutcome = await adoptCloudflareAuthProfile(failing, {
    interactive: true,
    env: {},
    askFn: async () => "y",
    withOAuthSession: async () => {
      ceremonies++;
      return {
        profile: cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(failing)),
        account: { id: "0".repeat(32), name: "Someone Else" },
      };
    },
  });
  console.log = priorLog;
  check(
    "a failed or wrong-account sign-in records nothing, so doctor never sees a phantom profile",
    failedOutcome === null && mismatchOutcome === null && ceremonies === 2 &&
      readFileSync(failing, "utf8") === legacyBytes,
    JSON.stringify({ failedOutcome, mismatchOutcome, ceremonies }),
  );
} finally {
  console.log = priorLog;
  if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  if (priorStdinTty) Object.defineProperty(process.stdin, "isTTY", priorStdinTty);
  else delete process.stdin.isTTY;
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nlegacy manifest auth profile: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
