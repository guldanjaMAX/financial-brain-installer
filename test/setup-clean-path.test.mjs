import { setupSettingsProofFixture } from "./helpers/setup-settings-proof-fixture.mjs";
import assert from "node:assert/strict";
import { validateBankProviderManifest } from "../operations/bank-provider-command.mjs";
const manifestSchema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

// Terminal schema facts come from the migrations directory, not a literal,
// so adding migration 00NN never breaks this suite (found at 13 -> 14).
const MIGRATION_FILES = readdirSync(new URL("../migrations/d1/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name));
const LATEST_SCHEMA = Math.max(...MIGRATION_FILES.map((name) => Number(name.slice(0, 4))));
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseSetupAccount,
  cmdMigrate,
  cmdSetup,
  persistWorkersDevDomain,
  workerBindings,
} from "../brain.mjs";
import {
  installedManifestPointerPath,
  readInstalledManifest,
} from "../operations/installed-manifest.mjs";

const oneAccount = { id: "a".repeat(32), name: "Owner account" };

assert.deepEqual(
  await chooseSetupAccount(async () => { throw new Error("one account needs no prompt"); }, {
    listAccounts: async () => [oneAccount],
  }),
  oneAccount,
);

const secondAccount = { id: "b".repeat(32), name: "Second account" };
assert.deepEqual(
  await chooseSetupAccount(async () => secondAccount.id, {
    listAccounts: async () => [oneAccount, secondAccount],
  }),
  secondAccount,
);
await assert.rejects(
  chooseSetupAccount(async () => "not-visible", {
    listAccounts: async () => [oneAccount, secondAccount],
  }),
  /not one this permission pass can see/i,
);

const sandbox = mkdtempSync(join(tmpdir(), "brain-clean-setup-"));
try {
  const domainManifest = join(sandbox, "domain.manifest.json");
  const domainValue = {
    client: { slug: "clean" },
    brain: { worker_name: "clean-brain" },
    infrastructure: { cloudflare: { account_id: oneAccount.id } },
  };
  writeFileSync(domainManifest, JSON.stringify(domainValue));
  const domain = await persistWorkersDevDomain(
    domainManifest,
    domainValue,
    oneAccount,
    "clean-brain",
    {
      readSubdomain: async () => ({ subdomain: "owner-subdomain" }),
      verifyWorkersDevCandidate: async (candidate) => {
        assert.equal(candidate, "clean-brain.owner-subdomain.workers.dev");
        return { ok: true };
      },
    },
  );
  assert.equal(domain, "clean-brain.owner-subdomain.workers.dev");
  assert.equal(JSON.parse(readFileSync(domainManifest, "utf8")).brain.domain, domain);

  const target = join(sandbox, "Financial Brain", "brain.manifest.json");
  const setupDomain = "clean-brain-brain.owner-subdomain.workers.dev";
  const installedManifestOptions = {
    home: sandbox,
    stateDirectory: join(sandbox, "installed-state"),
  };
  const events = [];
  let ocrConsentPrompts = 0;
  const key = `fixture-${"k".repeat(40)}`;
  const prompt = async (question, fallback) => {
    if (/what is this brain for|short name/i.test(question)) {
      throw new Error("the complete Claude setup context must not ask for the Brain identity");
    }
    if (/OCR|scanned PDFs/i.test(question)) {
      ocrConsentPrompts++;
      return "y";
    }
    if (/folder to load/i.test(question)) return "";
    return fallback || "";
  };
  await cmdSetup(target, {
    flags: { name: "Clean Brain", slug: "clean-brain" },
    setupWorkerScriptExists: async () => false,
    ask: prompt,
    doctorRunAll: async (options) => {
      assert.equal(options.requireClaudeCode, true);
      return [];
    },
    listCloudflareAccounts: async () => [oneAccount],
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "generated", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { events.push("verify"); },
    cmdProvision: async (path) => {
      events.push("provision");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.infrastructure.cloudflare.d1_database_id = "11111111-2222-4333-8444-555555555555";
      writeFileSync(path, JSON.stringify(value));
    },
    cmdMigrate: async (_path, options) => {
      assert.notEqual(options?.vectorDrainQuiesced, true);
      events.push("migrate");
    },
    cmdDeploy: async (path) => {
      events.push("deploy");
      const value = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(value.safety.ocr.enabled, true,
        "the one fresh-setup OCR consent must be in the manifest before initial deploy");
      const ocrEnabled = workerBindings(value, value.infrastructure.cloudflare)
        .find((binding) => binding.name === "OCR_ENABLED");
      assert.equal(ocrEnabled?.text, "1",
        "initial deployment must render the enabled setting without a later brain update");
      // Deploy proves the upload; setup owns the separate domain save.
      assert.equal(Object.hasOwn(value.brain, "domain"), false);
    },
    domainSaveOptions: {
      readSubdomain: async () => { events.push("domain-read"); return { subdomain: "owner-subdomain" }; },
      verifyWorkersDevCandidate: async () => { events.push("domain-probe"); return { ok: true }; },
    },
    cmdSecrets: async (_path, options) => {
      assert.equal(JSON.parse(readFileSync(target, "utf8")).brain.domain,
        setupDomain, "setup saves the verified address before keys and smoke");
      events.push("secrets");
      assert.equal(options.explicitAdminKey, key);
    },
    cmdDrain: async (path) => {
      assert.equal(path, target);
      events.push("drain");
    },
    cmdHealth: async (_path, options) => {
      events.push("health");
      assert.equal(options.durableAdminKeyOnly, true);
      assert.equal(options.expectDrainMode, "active");
    },
    wireAgents: async (manifest) => {
      events.push("wire");
      assert.equal(manifest.infrastructure.cloudflare.d1_database_id, "11111111-2222-4333-8444-555555555555");
      assert.equal(manifest.brain.domain, setupDomain);
      return { wired: ["Claude Code"], failures: [], skipped: [] };
    },
    writeClaudeWorkspaceGuide: (path, options) => {
      events.push("claude-guide");
      assert.equal(path, target);
      assert.ok(options.brainCliPath);
      assert.ok(options.nodePath);
      return { path: join(sandbox, "Financial Brain", "CLAUDE.md"), status: "written" };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  assert.deepEqual(events, ["verify", "provision", "migrate", "deploy", "domain-read", "domain-probe", "secrets", "drain", "health", "wire", "claude-guide"]);
  assert.equal(ocrConsentPrompts, 1, "fresh setup asks for OCR consent exactly once");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(Object.hasOwn(saved.client, "primary_contact"), false,
    "fresh setup omits an unknown optional contact");
  assert.equal(saved.infrastructure.cloudflare.account_id, oneAccount.id);
  assert.equal(saved.brain.domain, setupDomain);
  validateBankProviderManifest(saved, manifestSchema);
  assert.equal(readInstalledManifest(installedManifestOptions), realpathSync.native(target));

  const resumedProof = setupSettingsProofFixture(target, { account: oneAccount });
  const resumedEvents = [];
  let resumedPinnedPath = null;
  await cmdSetup(target, {
    ...resumedProof.options,
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async (path) => {
      resumedPinnedPath = path;
      assert.notEqual(path, target);
      return true;
    },
    probeExistingWorkerHealth: async () => null,
    captureSetupD1Bookmark: async (path) => {
      assert.equal(path, resumedPinnedPath);
      resumedEvents.push("bookmark");
      return "setup-bookmark";
    },
    waitForVectorDrainQuiescence: async (milliseconds) => {
      resumedEvents.push(`wait:${milliseconds}`);
    },
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { resumedEvents.push("verify"); },
    cmdProvision: async () => { resumedEvents.push("provision"); },
    cmdMigrate: async (path, options) => {
      assert.equal(path, resumedPinnedPath);
      // A resumed setup waits the fixed grace with no probe, so quiescence is
      // never READ. It must not be claimed either: run A migrated 100
      // accepted-but-unconfirmed batches under a hardcoded `true` here.
      assert.equal(options?.vectorDrainQuiesced, false);
      resumedEvents.push(`migrate:${options?.vectorDrainPauseCompleted === true}`);
    },
    cmdDeploy: async (path, options = {}) => {
      assert.equal(path, resumedPinnedPath);
      assert.equal(options.persistDomain, false);
      resumedEvents.push(`deploy:${options.pauseVectorDrainForUpgrade === true}`);
    },
    cmdSecrets: async (path) => {
      assert.equal(path, target);
      resumedEvents.push("secrets");
    },
    cmdDrain: async (path) => {
      assert.equal(path, target);
      resumedEvents.push("drain");
    },
    cmdHealth: async (path, options) => {
      assert.equal(path, options.reachOnly ? resumedPinnedPath : target);
      resumedEvents.push(options.reachOnly ? `health:${options.expectDrainMode}` : "health:durable");
    },
    wireAgents: async () => {
      resumedEvents.push("wire");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  resumedProof.assertReads();
  assert.deepEqual(resumedEvents, [
    "verify",
    "provision",
    "bookmark",
    "deploy:true",
    "health:paused-for-upgrade",
    "wait:1200000",
    "migrate:true",
    "deploy:false",
    "health:active",
    "secrets",
    "drain",
    "health:durable",
    "wire",
  ]);

  // A finished brain on the lease protocol is not a cutover candidate. Setup
  // used to pause it and walk it back into the cutover purely because the
  // Worker existed, and every error message in that state suggested setup.
  const runningVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const liveProof = setupSettingsProofFixture(target, {
    account: oneAccount, version: runningVersion, writerProtocol: "lease-v1",
  });
  const liveEvents = [];
  await cmdSetup(target, {
    ...liveProof.options,
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async () => true,
    probeExistingWorkerHealth: async () => ({ version: runningVersion, acceptingDocuments: true }),
    captureSetupD1Bookmark: async () => { liveEvents.push("bookmark"); return "never"; },
    waitForVectorDrainQuiescence: async () => { liveEvents.push("wait"); },
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { liveEvents.push("verify"); },
    cmdProvision: async () => { liveEvents.push("provision"); },
    cmdMigrate: async () => { liveEvents.push("migrate"); },
    cmdDeploy: async () => { liveEvents.push("deploy"); },
    cmdSecrets: async () => { liveEvents.push("secrets"); },
    cmdDrain: async () => { liveEvents.push("drain"); },
    cmdHealth: async (_path, options) => { liveEvents.push(options.reachOnly ? `health:${options.expectDrainMode}` : "health:durable"); },
    wireAgents: async () => { liveEvents.push("wire"); return { wired: [], failures: [], skipped: [] }; },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  liveProof.assertReads();
  assert.deepEqual(liveEvents, ["verify", "provision", "secrets", "drain", "health:durable", "wire"],
    "a live brain on this release is neither paused, migrated nor redeployed by setup");

  // On another release, setup names the right tool and touches nothing.
  const otherProof = setupSettingsProofFixture(target, {
    account: oneAccount, version: "0.0.1", writerProtocol: "lease-v1",
  });
  const otherEvents = [];
  await assert.rejects(
    () => cmdSetup(target, {
      ...otherProof.options,
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => true,
      captureSetupD1Bookmark: async () => { otherEvents.push("bookmark"); return "never"; },
      waitForVectorDrainQuiescence: async () => { otherEvents.push("wait"); },
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => { otherEvents.push("verify"); },
      cmdProvision: async () => { otherEvents.push("provision"); },
      cmdMigrate: async () => { otherEvents.push("migrate"); },
      cmdDeploy: async () => { otherEvents.push("deploy"); },
      cmdSecrets: async () => { otherEvents.push("secrets"); },
      cmdDrain: async () => { otherEvents.push("drain"); },
      cmdHealth: async () => { otherEvents.push("health"); },
      wireAgents: async () => { otherEvents.push("wire"); return { wired: [], failures: [], skipped: [] }; },
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    (error) => /already installed and live on version 0\.0\.1/.test(String(error?.message || error)) &&
      /brain update/.test(String(error?.message || error)),
  );
  otherProof.assertReads(0);
  assert.equal(otherProof.reads.liveProbe, 1, "the other-version guard was reached before proof");
  assert.deepEqual(otherEvents, ["verify", "provision"], "nothing after the check runs on a brain from another release");

  // An interrupted projection bootstrap is a durable partial success: setup
  // stops before full health/wiring, and a rerun invokes the same drain again
  // so its D1 cursor can resume before setup is allowed to turn green.
  const convergenceProof = setupSettingsProofFixture(target, { account: oneAccount });
  const convergenceEvents = [];
  const convergenceOptions = {
    ...convergenceProof.options,
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async () => true,
    captureSetupD1Bookmark: async () => "convergence-bookmark",
    waitForVectorDrainQuiescence: async () => {},
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => {},
    cmdProvision: async () => {},
    cmdMigrate: async () => {},
    cmdDeploy: async () => {},
    cmdSecrets: async () => { convergenceEvents.push("secrets"); },
    cmdHealth: async (_path, options) => {
      if (!options.reachOnly) convergenceEvents.push("full-health");
    },
    wireAgents: async () => {
      convergenceEvents.push("wire");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  };
  await assert.rejects(
    cmdSetup(target, {
      ...convergenceOptions,
      cmdDrain: async () => {
        convergenceEvents.push("drain:partial");
        throw new Error("synthetic durable bootstrap timeout; rerun to resume");
      },
    }),
    /durable bootstrap timeout.*resume/i,
  );
  convergenceProof.assertReads();
  assert.deepEqual(convergenceEvents, ["secrets", "drain:partial"]);
  await cmdSetup(target, {
    ...convergenceOptions,
    cmdDrain: async () => { convergenceEvents.push("drain:resumed"); },
  });
  convergenceProof.assertReads(2);
  assert.deepEqual(convergenceEvents, [
    "secrets",
    "drain:partial",
    "secrets",
    "drain:resumed",
    "full-health",
    "wire",
  ]);

  // A mutable user manifest cannot redirect migration after the bookmark or
  // during the old-invocation grace window. The pinned compatibility Worker
  // remains safe and no migration/active deployment runs.
  const stableManifest = readFileSync(target, "utf8");
  const driftProof = setupSettingsProofFixture(target, { account: oneAccount });
  const driftEvents = [];
  await assert.rejects(
    cmdSetup(target, {
      ...driftProof.options,
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => true,
      captureSetupD1Bookmark: async () => "drift-bookmark",
      waitForVectorDrainQuiescence: async () => {
        driftEvents.push("wait");
        const changed = JSON.parse(readFileSync(target, "utf8"));
        changed.infrastructure.cloudflare.d1_database_id = "different-database-after-bookmark";
        changed.brain.worker_name = "different-worker-after-bookmark";
        writeFileSync(target, JSON.stringify(changed));
      },
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => {},
      cmdProvision: async () => {},
      cmdMigrate: async () => { driftEvents.push("MIGRATED"); },
      cmdDeploy: async (_path, options = {}) => {
        driftEvents.push(options.pauseVectorDrainForUpgrade ? "paused" : "ACTIVE");
      },
      cmdHealth: async () => {},
      cmdSecrets: async () => { driftEvents.push("SECRETS"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /manifest changed.*no later stage|verified vector-writer cutover/i,
  );
  driftProof.assertReads();
  assert.deepEqual(driftEvents, ["paused", "wait"]);
  writeFileSync(target, stableManifest);

  const activeHealthProof = setupSettingsProofFixture(target, { account: oneAccount });
  const activeHealthEvents = [];
  await assert.rejects(
    cmdSetup(target, {
      ...activeHealthProof.options,
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => true,
      captureSetupD1Bookmark: async () => "active-health-bookmark",
      waitForVectorDrainQuiescence: async () => { activeHealthEvents.push("wait"); },
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => {},
      cmdProvision: async () => {},
      cmdMigrate: async () => { activeHealthEvents.push("migrate"); },
      cmdDeploy: async (_path, options = {}) => {
        activeHealthEvents.push(options.pauseVectorDrainForUpgrade ? "paused" : "active");
      },
      cmdHealth: async (_path, options) => {
        activeHealthEvents.push(`health:${options.expectDrainMode}`);
        if (options.expectDrainMode === "active") throw new Error("synthetic active mode not live");
      },
      cmdSecrets: async () => { activeHealthEvents.push("SECRETS"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /synthetic active mode not live/,
  );
  activeHealthProof.assertReads();
  assert.deepEqual(activeHealthEvents, [
    "paused", "health:paused-for-upgrade", "wait", "migrate", "active", "health:active",
  ]);

  const renamedWorkerEvents = [];
  await assert.rejects(
    cmdSetup(target, {
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => false,
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => { renamedWorkerEvents.push("verify"); },
      cmdProvision: async () => { renamedWorkerEvents.push("provision"); },
      cmdMigrate: async (_path, options) => {
        renamedWorkerEvents.push("guard");
        assert.notEqual(options?.vectorDrainQuiesced, true);
        throw new Error("synthetic live-install migration guard");
      },
      cmdDeploy: async () => { renamedWorkerEvents.push("DEPLOYED"); },
      cmdHealth: async () => {},
      cmdSecrets: async () => {},
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /synthetic live-install migration guard/,
  );
  assert.deepEqual(renamedWorkerEvents, ["verify", "provision", "guard"]);

  // A first setup can be interrupted after D1 committed migration 0001 but
  // before the runner wrote its receipt or install-state singleton. Absence of
  // the exact manifest Worker is not proof that a renamed legacy Worker is not
  // still writing this D1, so setup must stop without another mutation and
  // point at the verified paused-writer cutover. Once that exact Worker exists
  // (including an update interrupted after its paused deploy), setup can prove
  // quiescence and resume the real migration prefix safely.
  const partialManifest = join(sandbox, "partial-migration.manifest.json");
  writeFileSync(partialManifest, stableManifest);
  const partialDb = new DatabaseSync(":memory:");
  partialDb.exec(readFileSync(
    new URL("../migrations/d1/0001_install_state.sql", import.meta.url),
    "utf8",
  ));
  let partialMutations = 0;
  const partialQuery = async (_account, _database, sql, params = []) => {
    const text = String(sql).trim();
    if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
      return { results: partialDb.prepare(sql).all(...params) };
    }
    let result = null;
    if (params.length) result = partialDb.prepare(sql).run(...params);
    else partialDb.exec(sql);
    partialMutations++;
    return { results: [], meta: { changes: Number(result?.changes || 0) } };
  };
  const runPartialMigration = (path, options = {}) => cmdMigrate(path, {
    ...options,
    silent: true,
    resolveAccount: async () => ({ id: oneAccount.id }),
    d1Query: partialQuery,
  });
  const partialEvents = [];
  await assert.rejects(
    cmdSetup(partialManifest, {
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => false,
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => { partialEvents.push("verify"); },
      cmdProvision: async () => { partialEvents.push("provision"); },
      cmdMigrate: async (path, options) => {
        partialEvents.push("migrate-unquiesced");
        return runPartialMigration(path, options);
      },
      cmdDeploy: async () => { partialEvents.push("DEPLOYED"); },
      cmdHealth: async () => { partialEvents.push("HEALTH"); },
      cmdSecrets: async () => { partialEvents.push("SECRETS"); },
      cmdDrain: async () => { partialEvents.push("DRAIN"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /existing brain needs.*paused-writer cutover.*brain update.*direct migrate was stopped/is,
  );
  assert.deepEqual(partialEvents, ["verify", "provision", "migrate-unquiesced"]);
  assert.equal(partialMutations, 0);
  assert.equal(partialDb.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 0);

  const partialProof = setupSettingsProofFixture(partialManifest, { account: oneAccount });
  partialEvents.length = 0;
  await cmdSetup(partialManifest, {
    ...partialProof.options,
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async () => true,
    captureSetupD1Bookmark: async () => {
      partialEvents.push("bookmark");
      return "partial-setup-bookmark";
    },
    waitForVectorDrainQuiescence: async (milliseconds) => {
      partialEvents.push(`wait:${milliseconds}`);
    },
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { partialEvents.push("verify"); },
    cmdProvision: async () => { partialEvents.push("provision"); },
    cmdMigrate: async (path, options) => {
      // Same contract as the resumed run above: the completed cutover is the
      // authorization, the unread quiescence is never claimed as verified.
      assert.equal(options?.vectorDrainQuiesced, false);
      partialEvents.push(`migrate:${options?.vectorDrainPauseCompleted === true}`);
      return runPartialMigration(path, options);
    },
    cmdDeploy: async (_path, options) => {
      partialEvents.push(options.pauseVectorDrainForUpgrade ? "deploy:paused" : "deploy:active");
    },
    cmdHealth: async (_path, options) => {
      partialEvents.push(options.reachOnly
        ? `health:${options.expectDrainMode}`
        : "health:durable");
    },
    cmdSecrets: async () => { partialEvents.push("secrets"); },
    cmdDrain: async () => { partialEvents.push("drain"); },
    wireAgents: async () => {
      partialEvents.push("wire");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  partialProof.assertReads();
  assert.deepEqual(partialEvents, [
    "verify",
    "provision",
    "bookmark",
    "deploy:paused",
    "health:paused-for-upgrade",
    `wait:${20 * 60 * 1000}`,
    "migrate:true",
    "deploy:active",
    "health:active",
    "secrets",
    "drain",
    "health:durable",
    "wire",
  ]);
  assert.ok(partialMutations > 0);
  const partialState = partialDb.prepare(
    "SELECT schema_version, vector_projection_status FROM install_state WHERE id=1",
  ).get();
  assert.equal(partialState.schema_version, LATEST_SCHEMA);
  assert.equal(partialState.vector_projection_status, "verified");
  assert.equal(partialDb.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, MIGRATION_FILES.length);
  partialDb.close();

  if (process.platform !== "win32") {
    const { mode } = lstatSync(target);
    assert.equal(mode & 0o777, 0o600);
    assert.equal(lstatSync(installedManifestPointerPath(installedManifestOptions)).mode & 0o777, 0o600);
    assert.equal(lstatSync(installedManifestOptions.stateDirectory).mode & 0o777, 0o700);
  }
  // The actual setup orchestration, with external boundaries injected, reaches
  // the domain decision before keys on every arm. A denied read stays optional.
  for (const arm of ["missing", "existing", "custom", "denied"]) {
    const path = join(sandbox, `domain-${arm}.json`);
    const value = structuredClone(saved);
    if (arm === "missing" || arm === "denied") delete value.brain.domain;
    if (arm === "custom") value.brain.domain = "brain.example.invalid";
    const raw = JSON.stringify(value);
    writeFileSync(path, raw);
    const stages = [], lines = [];
    let reads = 0, probes = 0;
    await cmdSetup(path, {
      flags: {}, ask: prompt, doctorRunAll: async () => [],
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      setupWorkerScriptExists: async () => false,
      cmdVerify: async () => {}, cmdProvision: async () => {}, cmdMigrate: async () => {},
      cmdDeploy: async (_target, options) => { assert.equal(options.persistDomain, false); stages.push("deploy"); },
      domainSaveOptions: {
        readSubdomain: async () => {
          reads++; stages.push("address");
          if (arm === "denied") throw new Error("GET failed (403): 10000");
          return { subdomain: "owner-subdomain" };
        },
        verifyWorkersDevCandidate: async () => { probes++; return { ok: true }; },
        report: line => lines.push(line),
      },
      cmdSecrets: async () => {
        stages.push("keys");
        const current = JSON.parse(readFileSync(path, "utf8"));
        if (arm === "missing") assert.equal(current.brain.domain, saved.brain.domain);
      },
      cmdDrain: async () => {}, cmdHealth: async () => { stages.push("health"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }), backlogCount: async () => 0,
      installedManifestOptions,
    });
    assert.equal(stages[0], "deploy");
    assert.equal(stages.at(-1), "health");
    assert.equal(reads, ["missing", "denied"].includes(arm) ? 1 : 0);
    assert.equal(probes, arm === "missing" ? 1 : 0);
    validateBankProviderManifest(JSON.parse(readFileSync(path, "utf8")), manifestSchema);
    if (arm !== "missing") assert.equal(readFileSync(path, "utf8"), raw);
    if (arm === "denied") {
      assert.equal(lines.length, 1); assert.match(lines[0], /BRAIN_DOMAIN_NOT_SAVED/);
      assert.doesNotMatch(lines[0], /token|paste|recovery|sign in/i);
      assert.deepEqual(stages, ["deploy", "address", "keys", "health"]);
    }
  }
  console.log("clean setup path: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------------
 * The success screen is the last thing a client reads, and it rendered the
 * manifest path as `../../../../../../../private/tmp/...` whenever the manifest
 * sat outside the working directory (bench, 2026-08-28). Seven levels of `..`
 * in a command someone is told to retype reads as broken software.
 */
{
  const { displayPathForTesting, shouldSkipSetupConnections } = await import("../brain.mjs");
  const { default: assertStrict } = await import("node:assert/strict");

  const deep = displayPathForTesting("/private/tmp/a/b/c/x.json", "/Users/j/One/Two/Three/Four");
  assertStrict.ok(!deep.includes("../.."),
    `a far-outside manifest must not print a ladder of dot-dots, got: ${deep}`);
  // Compared with separators normalised: Windows returns `sub\\x.json` here and
  // that is correct on Windows, which is the whole point of the check.
  const below = displayPathForTesting("/tmp/work/sub/x.json", "/tmp/work").replace(/\\/g, "/");
  assertStrict.equal(below, "sub/x.json",
    "a manifest below the working directory keeps the short relative form");
  assertStrict.equal(shouldSkipSetupConnections({ "no-connect": true }), true,
    "--no-connect must prevent setup from editing this machine's AI-tool configuration");
  assertStrict.equal(shouldSkipSetupConnections({}, { connectAgents: false }), true,
    "injected setup runs can request the same custody-safe behavior without process arguments");
  assertStrict.equal(shouldSkipSetupConnections({}), false,
    "ordinary owner setup still connects the owner's own AI tools");
  console.log("display path: absolute when far outside, relative when close");
}
