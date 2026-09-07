/**
 * An agent-driven session must be able to adopt the Cloudflare auth profile.
 *
 * WHY THIS EXISTS. `adoptCloudflareAuthProfile` opened with:
 *
 *     const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
 *     if (options.forceToken === true || !interactive || env.CLOUDFLARE_API_TOKEN) return null;
 *
 * so it returned null before reading the manifest whenever stdin and stdout
 * were not both terminals. A coding agent has neither. Every agent-driven
 * `brain update` on a pre-profile install therefore skipped adoption, fell
 * into the token lane with all three token sources empty, and died
 * AUTH_REQUIRED in well under a second without ever pausing or migrating
 * (field run A: 174 ms).
 *
 * The TTY gate is not the bug. It exists so an unattended job cannot silently
 * start a browser credential ceremony nobody asked for. The repair is an
 * EXPLICIT consent path around it: `--adopt-cloudflare-profile`, or
 * BRAIN_ADOPT_CLOUDFLARE_PROFILE=1. With that consent and no terminal, the
 * ceremony runs and prints the owner an instruction instead of a y/n prompt.
 * Without it, a session with no terminal still refuses exactly as before.
 *
 * Every other escape stays absolute: an explicit token run and an injected
 * CLOUDFLARE_API_TOKEN refuse even when consent is present.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as brain from "../brain.mjs";
import {
  adoptCloudflareAuthProfile,
  cloudflareOAuthInstallIdentity,
  cmdUpdate,
} from "../brain.mjs";
import { cloudflareOAuthProfileName } from "../operations/cloudflare-oauth-session.mjs";

const ACCOUNT_ID = "9f2c1d4b7a6e8035c1d24b9e7f60a381";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

/* ---- the pre-profile manifest shape: an account id, and no auth_profile ---- */
const legacyManifest = () => ({
  client: { slug: "legacy", display_name: "Legacy Install", primary_contact: "", timezone: "UTC" },
  brain: { version: "0.3.5", worker_name: "legacy-brain" },
  infrastructure: {
    cloudflare: { account_id: ACCOUNT_ID, d1_database_name: "legacy-brain", storage: "d1" },
  },
  retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", rerank: false },
});
const legacyBytes = JSON.stringify(legacyManifest(), null, 2) + "\n";

/* A session spy that RECORDS the ceremony and returns an acceptable result, so
 * a leak shows up twice: as a recorded attempt and as a changed manifest. */
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

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-adopt-consent-")));
const priorLog = console.log;
let seq = 0;

/** One adoption run against a fresh copy of the pre-profile manifest. */
async function adopt(options) {
  const target = join(sandbox, `m${seq++}.manifest.json`);
  writeFileSync(target, legacyBytes);
  const spy = recordingSession();
  const lines = [];
  let asked = 0;
  console.log = (line) => lines.push(String(line ?? ""));
  let outcome;
  try {
    outcome = await adoptCloudflareAuthProfile(target, {
      askFn: async () => { asked++; return "y"; },
      write: (line) => lines.push(String(line ?? "")),
      withOAuthSession: spy.withOAuthSession,
      ...options,
    });
  } finally {
    console.log = priorLog;
  }
  const bytes = readFileSync(target, "utf8");
  return {
    target, outcome, asked, lines,
    text: lines.join("\n"),
    attempts: spy.attempts,
    unchanged: bytes === legacyBytes,
    written: JSON.parse(bytes),
    expected: cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(target)),
  };
}

try {
  /* ---- the consent switch itself ---- */
  const consentOf = brain.cloudflareAdoptionConsent;
  check(
    "brain.mjs exports a consent reader for the adoption switch",
    typeof consentOf === "function",
    typeof consentOf,
  );
  if (typeof consentOf === "function") {
    check(
      "--adopt-cloudflare-profile is consent",
      consentOf({ "adopt-cloudflare-profile": true }, {}) === true,
      String(consentOf({ "adopt-cloudflare-profile": true }, {})),
    );
    check(
      "BRAIN_ADOPT_CLOUDFLARE_PROFILE=1 is the same consent",
      consentOf({}, { BRAIN_ADOPT_CLOUDFLARE_PROFILE: "1" }) === true,
      String(consentOf({}, { BRAIN_ADOPT_CLOUDFLARE_PROFILE: "1" })),
    );
    check(
      "no flag and no variable is not consent",
      consentOf({}, {}) === false && consentOf({ manifest: "x" }, { BRAIN_ADOPT_CLOUDFLARE_PROFILE: "" }) === false,
      JSON.stringify([consentOf({}, {}), consentOf({ manifest: "x" }, { BRAIN_ADOPT_CLOUDFLARE_PROFILE: "" })]),
    );
  }

  /* ---- the gate that shipped: no terminal, no consent, no ceremony ---- */
  const silent = await adopt({ interactive: false, env: {} });
  check(
    "a session with no terminal and no consent still starts no sign-in",
    silent.outcome === null && silent.attempts.length === 0 && silent.unchanged && silent.asked === 0,
    JSON.stringify({ outcome: silent.outcome, attempts: silent.attempts.length, unchanged: silent.unchanged }),
  );

  /* ---- the defect: consent + no terminal must REACH the ceremony ---- */
  const agent = await adopt({ interactive: false, adoptConsent: true, env: {} });
  check(
    "with consent, a session with no terminal reaches the browser sign-in",
    agent.outcome === agent.expected && agent.attempts.length === 1,
    JSON.stringify({ outcome: agent.outcome, expected: agent.expected, attempts: agent.attempts.length }),
  );
  check(
    "that sign-in is bound to this install's exact profile and account",
    agent.attempts[0]?.profile === agent.expected &&
      agent.attempts[0]?.expectedAccountId === ACCOUNT_ID.toLowerCase() &&
      agent.attempts[0]?.reauthorize === true,
    JSON.stringify(agent.attempts[0] ?? null),
  );
  check(
    "no y/n prompt is asked in a session that has nobody at a keyboard",
    agent.asked === 0,
    String(agent.asked),
  );
  check(
    "the owner is told, by name, which switch approved this and where to sign in",
    agent.text.includes("--adopt-cloudflare-profile") && agent.text.includes("sign-in URL"),
    agent.text,
  );
  check(
    "the adopted profile is recorded, and the receipt says the consent was not interactive",
    agent.written.infrastructure.cloudflare.auth_profile === agent.expected &&
      agent.written.infrastructure.cloudflare.auth_profile_consent === "non-interactive",
    JSON.stringify(agent.written.infrastructure.cloudflare),
  );

  /* ---- the environment variable is the same consent ---- */
  const viaEnv = await adopt({ interactive: false, env: { BRAIN_ADOPT_CLOUDFLARE_PROFILE: "1" } });
  check(
    "BRAIN_ADOPT_CLOUDFLARE_PROFILE=1 reaches the same ceremony with no flag",
    viaEnv.outcome === viaEnv.expected && viaEnv.attempts.length === 1 && viaEnv.asked === 0,
    JSON.stringify({ outcome: viaEnv.outcome, attempts: viaEnv.attempts.length }),
  );

  /* ---- consent never overrides the automation escapes ---- */
  const forced = await adopt({ interactive: false, adoptConsent: true, forceToken: true, env: {} });
  check(
    "consent does not override an explicit --cloudflare-token run",
    forced.outcome === null && forced.attempts.length === 0 && forced.unchanged,
    JSON.stringify({ outcome: forced.outcome, attempts: forced.attempts.length }),
  );
  const injected = await adopt({
    interactive: false, adoptConsent: true, env: { CLOUDFLARE_API_TOKEN: "t".repeat(40) },
  });
  check(
    "consent does not override an injected CLOUDFLARE_API_TOKEN",
    injected.outcome === null && injected.attempts.length === 0 && injected.unchanged,
    JSON.stringify({ outcome: injected.outcome, attempts: injected.attempts.length }),
  );

  /* ---- the terminal path is untouched ---- */
  const terminal = await adopt({ interactive: true, env: {} });
  check(
    "a real terminal still asks y/n and adopts on yes, with no non-interactive receipt",
    terminal.outcome === terminal.expected && terminal.asked === 1 &&
      terminal.attempts.length === 1 &&
      terminal.written.infrastructure.cloudflare.auth_profile_consent === undefined,
    JSON.stringify({ outcome: terminal.outcome, asked: terminal.asked, cf: terminal.written.infrastructure.cloudflare }),
  );
  const declined = await adopt({ interactive: true, env: {}, askFn: async () => "n" });
  check(
    "a real terminal that declines still starts no sign-in",
    declined.outcome === null && declined.attempts.length === 0 && declined.unchanged,
    JSON.stringify({ outcome: declined.outcome, attempts: declined.attempts.length }),
  );

  /* ---- the switch must not eat the manifest path it was typed before ---- */
  {
    const targetOf = brain.updateCommandTarget;
    check(
      "brain.mjs exports the update target resolver",
      typeof targetOf === "function",
      typeof targetOf,
    );
    if (typeof targetOf === "function") {
      check(
        "a path typed after the switch is recovered, not silently dropped for discovery",
        targetOf("--adopt-cloudflare-profile", { "adopt-cloudflare-profile": "./brain.manifest.json" }) ===
          "./brain.manifest.json",
        String(targetOf("--adopt-cloudflare-profile", { "adopt-cloudflare-profile": "./brain.manifest.json" })),
      );
      check(
        "a positional path always wins, and a bare switch still means discovery",
        targetOf("./a.json", { "adopt-cloudflare-profile": true }) === "./a.json" &&
          targetOf("--adopt-cloudflare-profile", { "adopt-cloudflare-profile": true }) === undefined &&
          targetOf(undefined, {}) === undefined,
        JSON.stringify([
          targetOf("./a.json", { "adopt-cloudflare-profile": true }),
          targetOf("--adopt-cloudflare-profile", { "adopt-cloudflare-profile": true }),
          targetOf(undefined, {}),
        ]),
      );
    }
  }

  /* ---- cmdUpdate hands the consent down; without it nothing changes ---- */
  const threaded = join(sandbox, "threaded.manifest.json");
  writeFileSync(threaded, legacyBytes);
  const seen = [];
  const stopAfterAdoption = async (_path, opts) => {
    seen.push(opts);
    throw new Error("stop-after-adoption");
  };
  for (const consent of [true, false]) {
    console.log = () => {};
    try {
      await cmdUpdate(threaded, {
        interactive: false,
        adoptConsent: consent,
        discoverInstalledManifest: () => ({ path: threaded, source: "explicit" }),
        adoptCloudflareAuthProfile: stopAfterAdoption,
      });
    } catch (error) {
      if (String(error?.message) !== "stop-after-adoption") throw error;
    } finally {
      console.log = priorLog;
    }
  }
  check(
    "cmdUpdate passes the owner's consent straight through to adoption",
    seen.length === 2 && seen[0]?.adoptConsent === true && seen[1]?.adoptConsent === false,
    JSON.stringify(seen.map((o) => o?.adoptConsent)),
  );
} finally {
  console.log = priorLog;
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nadopt cloudflare profile consent: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
