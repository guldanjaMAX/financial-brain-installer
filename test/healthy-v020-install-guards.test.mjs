/**
 * THE OLDEST HEALTHY INSTALL: the guards a v0.2.0 brain meets.
 *
 * Three things get assumed about the clean case and are proven here instead.
 *
 * A. The auth-profile adoption F14 added is already covered for a hand-written
 *    "0.3.5" manifest with a three-field cloudflare block. A REAL v0.2.0
 *    manifest is not that shape: it carries `_token_scopes`, `_storage_options`,
 *    a `_drain_cron_comment` array, `r2_bucket`, `kv_namespace` and a whole
 *    `infrastructure.supabase` section. The fixture below is the actual
 *    published v0.2.0 template, read from the tag, filled in the way an install
 *    fills it. Adoption has to accept that and change exactly one field.
 *
 * B. `probeExistingWorkerHealth` is the fix for setup pausing a finished brain
 *    merely because its Worker existed. Every existing test STUBS it, so
 *    nothing proves it recognises the health body a v0.2.0 Worker actually
 *    serves. Here the real v0.2.0-shaped body is produced by the real Worker
 *    module and fed to the real probe, and the probe's own output is what
 *    drives cmdSetup.
 *
 * C. The owner is on arm64 macOS. Nothing in the update path may branch on CPU
 *    architecture, because none of it ships a native binary.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptCloudflareAuthProfile,
  cloudflareOAuthInstallIdentity,
  cmdSetup,
  manifestCloudflareControlBinding,
  probeExistingWorkerHealth,
} from "../brain.mjs";
import { cloudflareOAuthProfileName } from "../operations/cloudflare-oauth-session.mjs";
import workerModule from "../worker/src/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ACCOUNT_ID = "3c9a71b0e4d5426f8a1b7c0d9e2f3a4b";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

const priorLog = console.log;
const quiet = async (task) => {
  console.log = () => {};
  try { return await task(); } finally { console.log = priorLog; }
};

/* ---------------------------------------------------------------------------
 * A. adoption over the REAL published v0.2.0 manifest shape
 * ------------------------------------------------------------------------ */

/** The published v0.2.0 template, filled in the way a completed install fills it. */
function v020InstalledManifest() {
  // The published v0.2.0 template, kept as a fixture rather than read from the
  // tag: CI checkouts are shallow and the CI-only repository carries no tags at
  // all. The working tree cannot stand in for it, because today's template has
  // the auth_profile field this test exists to prove was absent. The digest is
  // the tag's own bytes, so an edited fixture fails here.
  // Normalised before hashing: .gitattributes pins this to LF, but a checkout
  // that ignored that must not be able to report the published bytes as wrong.
  const fixture = Buffer.from(
    readFileSync(new URL("./fixtures/v0.2.0-brain.manifest.json", import.meta.url), "utf8").replace(/\r\n/g, "\n"),
    "utf8");
  const digest = createHash("sha256").update(fixture).digest("hex");
  if (digest !== "78f6244d7bb0307898d4b5c43a8f97c6eaddba11297abf60cbf40bcd4dcb3ea4") {
    throw new Error(`the v0.2.0 manifest fixture is not the published bytes (${digest})`);
  }
  const template = JSON.parse(fixture.toString("utf8"));
  template.client = { slug: "riverbend", display_name: "Riverbend Studio, Inc", primary_contact: "", timezone: "America/Chicago" };
  template.brain = { version: "0.2.0", domain: "riverbend-brain.owner-subdomain.workers.dev", worker_name: "riverbend-brain" };
  const cf = template.infrastructure.cloudflare;
  cf.account_id = ACCOUNT_ID;
  cf.d1_database_name = "riverbend-brain";
  cf.d1_database_id = "8f2b1c4d-5e6a-4b7c-9d0e-1f2a3b4c5d6e";
  cf.vectorize_index = "riverbend-brain";
  cf.kv_namespace_id = "0123456789abcdef0123456789abcdef";
  template.operations.admin_key_secret = "keychain://financial-brain-fixture/admin-key";
  return template;
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "v020-guards-")));
try {
  const v020 = v020InstalledManifest();
  check("the v0.2.0 fixture really is the pre-auth_profile shape, comments and supabase block and all",
    v020.infrastructure.cloudflare.auth_profile === undefined &&
    Array.isArray(v020.infrastructure.cloudflare._token_scopes) &&
    Array.isArray(v020.infrastructure.cloudflare._drain_cron_comment) &&
    v020.infrastructure.supabase !== undefined &&
    v020.infrastructure.cloudflare.r2_bucket === "brain-assets",
    JSON.stringify(Object.keys(v020.infrastructure.cloudflare)));

  const manifestPath = join(sandbox, "brain.manifest.json");
  const beforeBytes = JSON.stringify(v020, null, 2) + "\n";
  writeFileSync(manifestPath, beforeBytes);

  const expectedProfile = cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(manifestPath));
  const attempts = [];
  const adopted = await quiet(() => adoptCloudflareAuthProfile(manifestPath, {
    interactive: true,
    env: {},
    askFn: async () => "y",
    withOAuthSession: async (request) => {
      attempts.push(request);
      return { profile: request?.profile, account: { id: String(request?.expectedAccountId), name: "Riverbend Studio" } };
    },
  }));
  check("a real v0.2.0 manifest is ADOPTED, not rejected, onto the OAuth profile lane",
    adopted === expectedProfile && attempts.length === 1 &&
    attempts[0].expectedAccountId === ACCOUNT_ID.toLowerCase(),
    JSON.stringify({ adopted, expectedProfile, attempts: attempts.length }));

  const after = JSON.parse(readFileSync(manifestPath, "utf8"));
  check("adoption changed exactly one field and preserved every v0.2.0 comment block",
    after.infrastructure.cloudflare.auth_profile === expectedProfile &&
    JSON.stringify({ ...after.infrastructure.cloudflare, auth_profile: undefined }) ===
      JSON.stringify({ ...v020.infrastructure.cloudflare, auth_profile: undefined }) &&
    JSON.stringify(after.infrastructure.supabase) === JSON.stringify(v020.infrastructure.supabase) &&
    JSON.stringify(after.corpora) === JSON.stringify(v020.corpora) &&
    JSON.stringify(after.brain) === JSON.stringify(v020.brain),
    readFileSync(manifestPath, "utf8").slice(0, 300));

  const schemaPattern = new RegExp(
    JSON.parse(readFileSync(join(ROOT, "manifest.schema.json"), "utf8"))
      .properties.infrastructure.properties.cloudflare.properties.auth_profile.pattern
  );
  check("the adopted profile satisfies this release's own manifest schema",
    schemaPattern.test(after.infrastructure.cloudflare.auth_profile),
    after.infrastructure.cloudflare.auth_profile);

  const binding = manifestCloudflareControlBinding(manifestPath);
  check("and the credential wrapper now reads a bound account plus a saved profile",
    binding.accountId === ACCOUNT_ID && binding.authProfile === expectedProfile,
    JSON.stringify(binding));

  /* ---------------------------------------------------------------------------
   * B. the real Worker's health body, through the real setup guard
   * ------------------------------------------------------------------------ */

  /** The exact /health body a live Worker serves, from the Worker module itself. */
  const workerHealth = async (env) => {
    const response = await workerModule.fetch(new Request("https://riverbend-brain.example/health"), env, {});
    return { status: response.status, body: await response.text() };
  };
  const asProbeResponse = ({ status, body }) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

  // The SHAPE still comes from the real Worker module, which is the point of
  // this section. The version cannot: since 0.4.4 the Worker reports the version
  // compiled into its own source rather than a deploy-time variable, precisely
  // so a variable cannot outlive the code it described. That makes the version
  // uninjectable here, so it is restated to what a real v0.2.0 Worker serves,
  // which is its own BRAIN_VERSION. Everything the probe and the setup guard
  // actually read is still the live body.
  const served = await workerHealth({ BRAIN_NAME: "riverbend", BRAIN_VERSION: "0.2.0" });
  const asOldWorker = JSON.parse(served.body);
  delete asOldWorker.configured_version;
  delete asOldWorker.version_mismatch;
  asOldWorker.version = "0.2.0";
  const liveBody = { status: served.status, body: JSON.stringify(asOldWorker) };
  const parsed = asOldWorker;
  check("a v0.2.0 Worker really does advertise the lease protocol and an active drain",
    parsed.vector_writer_protocol === "lease-v1" && parsed.vector_drain_mode === "active" &&
    parsed.accepting_documents === true && parsed.version === "0.2.0",
    liveBody.body);

  const liveManifest = join(sandbox, "live.manifest.json");
  writeFileSync(liveManifest, JSON.stringify(v020InstalledManifest(), null, 2) + "\n");
  let probedUrl = null;
  const liveVerdict = await probeExistingWorkerHealth(liveManifest, {
    http: async (url) => { probedUrl = url; return asProbeResponse(liveBody); },
  });
  check("the real setup guard reads that body as a FINISHED brain, not a cutover candidate",
    liveVerdict !== null && liveVerdict.version === "0.2.0" && liveVerdict.acceptingDocuments === true &&
    probedUrl === "https://riverbend-brain.owner-subdomain.workers.dev/health",
    JSON.stringify({ liveVerdict, probedUrl }));

  /* the verdict the real probe just produced is what drives setup */
  const touched = [];
  let refusal = null;
  try {
    await quiet(() => cmdSetup(liveManifest, {
      flags: {},
      ask: async (_question, fallback) => fallback || "",
      doctorRunAll: async () => [],
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: "k".repeat(48), plan: { backend: "file" } }),
      setupWorkerScriptExists: async () => true,
      probeExistingWorkerHealth: async () => liveVerdict,
      captureSetupD1Bookmark: async () => { touched.push("bookmark"); return "never"; },
      waitForVectorDrainQuiescence: async () => { touched.push("wait"); },
      cmdVerify: async () => { touched.push("verify"); },
      cmdProvision: async () => { touched.push("provision"); },
      cmdMigrate: async () => { touched.push("migrate"); },
      cmdDeploy: async () => { touched.push("deploy"); },
      cmdSecrets: async () => { touched.push("secrets"); },
      cmdDrain: async () => { touched.push("drain"); },
      cmdHealth: async () => { touched.push("health"); },
      wireAgents: async () => { touched.push("wire"); return { wired: [], failures: [], skipped: [] }; },
      backlogCount: async () => 0,
      installedManifestOptions: { home: sandbox, stateDirectory: join(sandbox, "installed-state") },
    }));
  } catch (error) { refusal = error; }
  check("so rerunning setup on its healthy brain REFUSES and names brain update instead",
    /already installed and live on version 0\.2\.0/.test(String(refusal?.message || "")) &&
    /brain update/.test(String(refusal?.message || "")),
    String(refusal?.message || "no refusal"));
  check("and nothing after the check ran, so a working brain is never paused by that rerun",
    !touched.includes("deploy") && !touched.includes("migrate") &&
    !touched.includes("bookmark") && !touched.includes("wait"),
    JSON.stringify(touched));

  /* a brain already paused by a half-finished update is NOT read as finished */
  const pausedBody = await workerHealth({
    BRAIN_NAME: "riverbend", BRAIN_VERSION: "0.2.0", VECTOR_DRAIN_MODE: "paused-for-upgrade",
  });
  const pausedVerdict = await probeExistingWorkerHealth(liveManifest, {
    http: async () => asProbeResponse(pausedBody),
  });
  check("a paused brain is not mistaken for a finished one, so the cutover recovery still runs",
    pausedVerdict === null, JSON.stringify(pausedVerdict));

  /* the residual hole: no saved domain means the probe never even asks */
  const noDomain = join(sandbox, "no-domain.manifest.json");
  const withoutDomain = v020InstalledManifest();
  delete withoutDomain.brain.domain;
  writeFileSync(noDomain, JSON.stringify(withoutDomain, null, 2) + "\n");
  let asked = false;
  const noDomainVerdict = await probeExistingWorkerHealth(noDomain, {
    http: async () => { asked = true; return asProbeResponse(liveBody); },
  });
  check("a manifest with no saved domain yields no verdict at all, and asks nothing",
    noDomainVerdict === null && asked === false,
    JSON.stringify({ noDomainVerdict, asked }));

  /* ---------------------------------------------------------------------------
   * C. arm64: nothing in the update path may branch on CPU architecture
   * ------------------------------------------------------------------------ */
  const archPattern = /process\.arch|\bx86_64\b|["'`]x64["'`]|["'`]ia32["'`]/;
  const inDirectory = (relative, extension) => readdirSync(join(ROOT, relative))
    .filter((name) => name.endsWith(extension)).map((name) => join(relative, name));
  // brain.mjs's static import closure, by directory. connectors/ is reached
  // only through dynamic import from a named provider command, never from
  // update; google-auth is the one connector brain.mjs loads at module level.
  const updatePathFiles = [
    "brain.mjs", "doctor.mjs", "support-journal.mjs", "support-recovery.mjs",
    "acceptance.mjs", "report.mjs", join("connectors", "google-auth.mjs"),
    ...inDirectory("operations", ".mjs"),
    ...inDirectory("components", ".mjs"),
    ...inDirectory("ingest", ".mjs"),
    ...inDirectory(join("worker", "src", "lib"), ".js"),
  ];
  // support-journal.mjs is the single allowed reader: it RECORDS the value in a
  // support event and never decides anything on it. That is asserted below by
  // calling it, not by trusting the exemption.
  const archRecordingOnly = new Set(["support-journal.mjs"]);
  const archBranches = updatePathFiles.filter((relativePath) =>
    !archRecordingOnly.has(relativePath) &&
    archPattern.test(readFileSync(join(ROOT, relativePath), "utf8")));
  check(`no file the update path loads branches on CPU architecture (${updatePathFiles.length} scanned)`,
    archBranches.length === 0, JSON.stringify(archBranches));

  const { previewSupportEvent } = await import("../support-journal.mjs");
  const armEvent = previewSupportEvent(
    { command: "update", source: "installer", errorCode: "AUTH_REQUIRED" },
    { platform: "darwin", arch: "arm64", nodeVersion: "v22.0.0" },
  );
  const intelEvent = previewSupportEvent(
    { command: "update", source: "installer", errorCode: "AUTH_REQUIRED" },
    { platform: "darwin", arch: "x64", nodeVersion: "v22.0.0" },
  );
  check("an Apple Silicon run is recorded as arm64, not folded into x64",
    armEvent.arch === "arm64" && intelEvent.arch === "x64" &&
    armEvent.platform === "darwin",
    JSON.stringify({ arm: armEvent.arch, intel: intelEvent.arch }));

  // The one module that does read process.arch ships a native daemon and is
  // not on this path. Prove both halves: brain.mjs never imports it, and its
  // own mapping does not treat arm64 as an x64 alias.
  const brainSource = readFileSync(join(ROOT, "brain.mjs"), "utf8");
  check("the one arch-aware module, the WhatsApp daemon resolver, is never statically imported here",
    !/^import[^;]*connectors\/whatsapp\.mjs/m.test(brainSource),
    "brain.mjs imports connectors/whatsapp.mjs");
  const { daemonBinaryName } = await import("../connectors/whatsapp.mjs");
  check("and even there arm64 maps to an arm64 binary, never to an amd64 one",
    daemonBinaryName("darwin", "arm64") === "wa-daemon-darwin-arm64" &&
    daemonBinaryName("darwin", "x64") === "wa-daemon-darwin-amd64",
    daemonBinaryName("darwin", "arm64"));

  const journal = readFileSync(join(ROOT, "support-journal.mjs"), "utf8");
  check("the one place that records an architecture accepts arm64 rather than normalising it away",
    /["']arm64["']/.test(journal) && /process\.arch/.test(journal),
    "support-journal.mjs");
} finally {
  console.log = priorLog;
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nhealthy v0.2.0 install guards: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
