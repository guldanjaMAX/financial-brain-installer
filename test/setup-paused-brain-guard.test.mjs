/**
 * A BRAIN PAUSED MID-UPGRADE MUST NOT BE HANDED TO `brain setup`.
 *
 * `probeExistingWorkerHealth` answers one question: is this a FINISHED brain on
 * the current writer protocol? It returns null for anything else, and a brain
 * whose vector drain is `paused-for-upgrade` is "anything else". Setup read
 * that null as "an older Worker that needs the compatibility cutover" and ran
 * the cutover again: pause, migrate, redeploy. On a brain that was already
 * paused because an earlier update stopped half way, that is the same wrong
 * move that took a working install off documents once already.
 *
 * So setup has to read the live drain mode for itself, and refuse. The refusal
 * names `brain update`, and it must not send anyone back to setup or to drain,
 * because neither can finish an upgrade and both make the pause worse.
 *
 * EVERY HEALTH BODY HERE COMES FROM THE REAL WORKER. The first attempt at this
 * guard passed thirteen checks and never fired in the field, because its
 * fixture hand-wrote `ok: true` into a paused body. The Worker sets `ok:
 * !paused` (worker/src/index.js), so a genuinely paused brain answers 200 with
 * `ok: false`, the shared body reader rejected it as unreadable, and the drain
 * probe saw null. A fixture that a human types can disagree with the product;
 * one the product serves cannot. cmdSetup is driven below through the REAL
 * probes with only the socket replaced.
 *
 * The last section is the message an operator meets FIRST in that state. When
 * Cloudflare access cannot be established, the AUTH_REQUIRED failure must name
 * `brain update` and the explicit non-interactive consent flag, never setup or
 * a persistent customer environment-variable workaround.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as brain from "../brain.mjs";
import worker from "../worker/src/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ACCOUNT_ID = "3c9a71b0e4d5426f8a1b7c0d9e2f3a4b";
const DOMAIN = "riverbend-brain.owner-subdomain.workers.dev";

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

/** A finished install's manifest: this release's template with the live ids filled in. */
function installedManifest() {
  const m = brain.buildSetupManifest({
    display: "Riverbend Studio",
    slug: "riverbend",
    accountId: ACCOUNT_ID,
  });
  m.brain.domain = DOMAIN;
  m.infrastructure.cloudflare.d1_database_id = "8f2b1c4d-5e6a-4b7c-9d0e-1f2a3b4c5d6e";
  m.infrastructure.cloudflare.vectorize_index = "riverbend-brain";
  m.infrastructure.cloudflare.kv_namespace_id = "0123456789abcdef0123456789abcdef";
  return m;
}

/** The Worker's own env for each drain mode. Nothing here is written by hand. */
const workerEnv = (drainMode) => ({
  BRAIN_NAME: "riverbend",
  BRAIN_VERSION: PRODUCT_VERSION,
  ...(drainMode === "paused-for-upgrade" ? { VECTOR_DRAIN_MODE: "paused-for-upgrade" } : {}),
});

/** The transport the probes get: the REAL Worker answering /health, unedited. */
const liveHealth = (drainMode) => async () =>
  worker.fetch(new Request(`https://${DOMAIN}/health`), workerEnv(drainMode), { waitUntil() {} });

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "setup-paused-guard-")));
try {
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(installedManifest(), null, 2) + "\n");
  const installedManifestOptions = { home: sandbox, stateDirectory: join(sandbox, "installed-state") };

  /* ------------------------------------------------------------------------
   * 0. what a paused brain ACTUALLY serves
   *
   * Pinned first, because the previous fix was built on a body the product
   * never produces. If this section ever fails, every probe below is testing
   * fiction.
   * --------------------------------------------------------------------- */

  const pausedResponse = await liveHealth("paused-for-upgrade")();
  const pausedBody = JSON.parse(await pausedResponse.text());
  check("a paused brain answers /health with HTTP 200 so probes can still reach it",
    pausedResponse.status === 200, String(pausedResponse.status));
  check("and reports ok:false, because it cannot do its job while paused",
    pausedBody.ok === false, JSON.stringify(pausedBody));
  check("and names the pause in vector_drain_mode, with documents refused",
    pausedBody.status === "paused-for-upgrade" &&
      pausedBody.vector_drain_mode === "paused-for-upgrade" &&
      pausedBody.accepting_documents === false,
    JSON.stringify(pausedBody));

  const activeBody = JSON.parse(await (await liveHealth("active")()).text());
  check("a live brain reports ok:true and an active drain",
    activeBody.ok === true && activeBody.vector_drain_mode === "active",
    JSON.stringify(activeBody));

  /* ------------------------------------------------------------------------
   * 1. setup can SEE a pause at all
   * --------------------------------------------------------------------- */

  check("the installer exports a probe for the live vector drain mode",
    typeof brain.probeExistingWorkerDrainMode === "function",
    typeof brain.probeExistingWorkerDrainMode);

  const readDrainMode = async (drainMode) =>
    typeof brain.probeExistingWorkerDrainMode === "function"
      ? brain.probeExistingWorkerDrainMode(manifestPath, { http: liveHealth(drainMode) })
      : "<no probe>";

  const pausedMode = await readDrainMode("paused-for-upgrade");
  check("it reads paused-for-upgrade off a paused brain's own /health body",
    pausedMode === "paused-for-upgrade", JSON.stringify(pausedMode));

  const activeMode = await readDrainMode("active");
  check("and reads active off a live one", activeMode === "active", JSON.stringify(activeMode));

  // Why a second probe exists at all: the finished-brain probe cannot answer
  // this, by design, and that blindness is what let the guard never fire.
  const pausedAsFinished = await brain.probeExistingWorkerHealth(manifestPath, {
    http: liveHealth("paused-for-upgrade"),
  });
  check("the finished-brain probe still declines to call a paused brain finished",
    pausedAsFinished === null, JSON.stringify(pausedAsFinished));

  const activeAsFinished = await brain.probeExistingWorkerHealth(manifestPath, {
    http: liveHealth("active"),
  });
  check("and it still recognises a live brain as finished, off the same real body",
    activeAsFinished !== null && activeAsFinished.version === PRODUCT_VERSION &&
      activeAsFinished.acceptingDocuments === true,
    JSON.stringify(activeAsFinished));

  // A body that is unreadable for any OTHER reason is still no verdict: the
  // ok gate moved into the finished-brain probe, it did not disappear.
  const notOkActive = await brain.probeExistingWorkerHealth(manifestPath, {
    http: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: false, version: PRODUCT_VERSION,
        vector_writer_protocol: "lease-v1", vector_drain_mode: "active", accepting_documents: true,
      }),
    }),
  });
  check("a brain that reports itself not ok is never called finished, whatever its drain says",
    notOkActive === null, JSON.stringify(notOkActive));

  /* ------------------------------------------------------------------------
   * 2. setup REFUSES a paused brain, driven through the REAL probes
   * --------------------------------------------------------------------- */

  const setupOptions = (overrides, touched) => ({
    flags: {},
    ask: async (_question, fallback) => fallback || "",
    doctorRunAll: async () => [],
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: "k".repeat(48), plan: { backend: "file" } }),
    setupWorkerScriptExists: async () => true,
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
    installedManifestOptions,
    ...overrides,
  });

  /** Setup's own probes, unmodified, with only the network replaced. */
  const realProbes = (drainMode) => ({
    probeExistingWorkerHealth: (pinned) =>
      brain.probeExistingWorkerHealth(pinned, { http: liveHealth(drainMode) }),
    probeExistingWorkerDrainMode: (pinned) =>
      brain.probeExistingWorkerDrainMode(pinned, { http: liveHealth(drainMode) }),
  });

  const pausedTouched = [];
  let refusal = null;
  try {
    await quiet(() => brain.cmdSetup(manifestPath,
      setupOptions(realProbes("paused-for-upgrade"), pausedTouched)));
  } catch (error) { refusal = error; }
  const refusalMessage = String(refusal?.message || "");

  check("setup REFUSES a brain that is paused for an upgrade, and exits nonzero",
    refusal !== null && refusal.constructor?.name === "Fatal" && /paused/i.test(refusalMessage),
    refusalMessage || "no refusal");
  check("the refusal names `brain update` as the command that finishes the upgrade",
    /brain update/.test(refusalMessage), refusalMessage);
  check("the refusal never sends the operator back to setup or drain",
    !/(?:^|\s)(?:re-?run|run|try|use)\s+`?brain\s+(?:setup|drain)/i.test(refusalMessage) &&
      /do not run/i.test(refusalMessage),
    refusalMessage);
  check("setup stops at the check: only the read-only stages ran, nothing destructive",
    JSON.stringify(pausedTouched) === JSON.stringify(["verify", "provision"]),
    JSON.stringify(pausedTouched));

  /* ------------------------------------------------------------------------
   * 3. an ACTIVE brain takes the unchanged path
   * --------------------------------------------------------------------- */

  const activeTouched = [];
  let drainModeConsulted = false;
  let activeError = null;
  try {
    await quiet(() => brain.cmdSetup(manifestPath, setupOptions({
      ...realProbes("active"),
      probeExistingWorkerDrainMode: (pinned) => {
        drainModeConsulted = true;
        return brain.probeExistingWorkerDrainMode(pinned, { http: liveHealth("active") });
      },
    }, activeTouched)));
  } catch (error) { activeError = error; }
  check("a live brain on this release still finishes setup, unchanged",
    activeError === null &&
      JSON.stringify(activeTouched) === JSON.stringify(["verify", "provision", "secrets", "drain", "health", "wire"]),
    String(activeError?.message || JSON.stringify(activeTouched)));
  check("and the pause probe is not even asked once the brain answers as finished",
    drainModeConsulted === false, String(drainModeConsulted));

  /* ------------------------------------------------------------------------
   * 4. the AUTH_REQUIRED copy points at update, and at explicit consent
   * --------------------------------------------------------------------- */

  let authFailure = null;
  try {
    await brain.withCloudflareControlCredential(async () => "never reached", {
      withToken: async () => { throw new Error("fixture: no Cloudflare credential in this shell"); },
    });
  } catch (error) { authFailure = error; }
  const authMessage = String(authFailure?.message || "");

  check("the no-credential failure is still classified AUTH_REQUIRED",
    authFailure?.code === "AUTH_REQUIRED", JSON.stringify({ code: authFailure?.code }));
  check("AUTH_REQUIRED never offers `brain setup` as the way out",
    !/brain setup/.test(authMessage), authMessage);
  check("AUTH_REQUIRED names `brain update <manifest>` from an interactive terminal",
    /brain update <manifest>/.test(authMessage) && /interactive terminal/i.test(authMessage),
    authMessage);
  check("and it names only the explicit consent flag a non-interactive session needs",
    /--adopt-cloudflare-profile/.test(authMessage) &&
      !/BRAIN_ADOPT_CLOUDFLARE_PROFILE=1/.test(authMessage),
    authMessage);
  check("and that consent is described as the owner's, not something to assume",
    /approv/i.test(authMessage), authMessage);

  /* ------------------------------------------------------------------------
   * 5. doctor never sends a stuck brain to setup either
   * --------------------------------------------------------------------- */

  // Doctor is what an operator runs against a brain that is already stuck, and
  // it cannot tell a paused install from a fresh one. Its ordinary owner advice
  // must use browser sign-in and must never be the command that pauses it again.
  const doctorAdvice = readFileSync(join(ROOT, "doctor.mjs"), "utf8").split("\n")
    .filter((line) => /browser sign-in|supported Brain command in an interactive terminal/.test(line));
  check("doctor carries the ordinary owner browser-sign-in advice where an operator meets it",
    doctorAdvice.length >= 4, String(doctorAdvice.length));
  check("and not one line of it sends a stuck brain to `brain setup`",
    !doctorAdvice.some((line) => /brain setup/.test(line)),
    doctorAdvice.filter((line) => /brain setup/.test(line)).join("\n"));
  check("the owner advice uses an interactive terminal and does not assign token creation",
    doctorAdvice.some((line) => /interactive terminal/.test(line)) &&
      !doctorAdvice.some((line) => /create.*token|API Tokens/.test(line)),
    doctorAdvice.join("\n"));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
