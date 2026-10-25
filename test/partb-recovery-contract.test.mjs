import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  buildConfiguredDailyPlan,
  cmdConnect,
  persistWorkersDevDomain,
} from "../brain.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { installDailyRefreshSchedule } from "../operations/daily-refresh-scheduler.mjs";
import {
  ANTHROPIC_SECRET_NAME,
  BUILT_IN_ANSWER_MODEL,
  RECOMMENDED_ANSWER_SETUP,
  answerSetupHasSchema2RecoveryJournal,
  answerSetupJournal,
  answerSetupJournalPath,
  answerSetupNeedsRecovery,
  answerSetupOf,
} from "../operations/answer-setup.mjs";
import { HALF_RUN } from "../operations/answer-setup-copy.mjs";

const WINDOWS_PUBLICATION_ATTEMPTS = 10;
const FIXED_NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ANSWER_SETUP_MODULE_URL = new URL("../operations/answer-setup.mjs", import.meta.url).href;
const INTERRUPTED_CARD = Object.freeze([
  "Answer setup was interrupted.",
  "Nothing more will run automatically.",
  "Your Brain keeps working as before.",
  "Contact your Financial Brain partner.",
]);
const KEY_REPLACEMENT_UNSUPPORTED =
  "This Brain already uses your Claude key. Replacing the key is not supported in this version. Nothing was changed. Contact your partner.";

export const NAMED_RECOVERY_CONTRACT_GAPS = Object.freeze([]);

const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

function scratchRoot(label) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `partb-${label}-`)));
}

function fixtureManifest(root, { domain = true } = {}) {
  const adminKeyPath = join(root, "fixture-admin-key");
  const sentinel = Buffer.from([0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]);
  writeFileSync(adminKeyPath, sentinel, { mode: 0o600 });
  return {
    client: { slug: "contract-fixture", display_name: "Owner", timezone: "UTC" },
    brain: {
      worker_name: "contract-fixture-worker",
      ...(domain ? { domain: "contract-fixture.invalid" } : {}),
    },
    infrastructure: {
      cloudflare: { storage: "d1", d1_database_id: "fixture-database" },
    },
    retrieval: {
      answer_model: BUILT_IN_ANSWER_MODEL,
      gate_model: BUILT_IN_ANSWER_MODEL,
    },
    safety: { daily_llm_spend_cap_usd: 10 },
    admin_key_file: adminKeyPath,
    unrelated: {
      exact_value: "retain  two  spaces\nand this line",
      nested: { enabled: true, count: 7 },
    },
  };
}

function workerCheck(manifestPath, status) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return {
    answer: { model: manifest.retrieval?.answer_model ?? BUILT_IN_ANSWER_MODEL, status },
    check: { model: manifest.retrieval?.gate_model ?? BUILT_IN_ANSWER_MODEL, status },
  };
}

function mutationCounters() {
  return {
    manifestControls: 0,
    journalInspections: 0,
    manifestPublications: 0,
    manifestReadbacks: 0,
    versionChecks: 0,
    dailyPrepares: 0,
    dailyReconciles: 0,
    dailyRollbacks: 0,
    secretInventories: 0,
    secretMutations: 0,
    secretDeleteCalls: 0,
    deployProofs: 0,
    deployMutations: 0,
    workerReadbacks: 0,
    guideMutations: 0,
    guideReadbacks: 0,
    stagedCleanups: 0,
    journalCleanups: 0,
  };
}

function anthropicBoundaryOptions(manifestPath, counters, overrides = {}) {
  return {
    platform: "win32",
    stdinIsTTY: false,
    loadManifest: (path) => ({ m: JSON.parse(readFileSync(path, "utf8")) }),
    acquireLock: async (_input, action) => action(),
    verifyVersion: async () => { counters.versionChecks += 1; },
    prepareDaily: async () => { counters.dailyPrepares += 1; },
    reconcileDaily: async (_path, options = {}) => {
      if (options.rollback) counters.dailyRollbacks += 1;
      else counters.dailyReconciles += 1;
    },
    listSecretNames: async () => {
      counters.secretInventories += 1;
      return [ANTHROPIC_SECRET_NAME];
    },
    putSecret: async () => { counters.secretMutations += 1; },
    deleteSecret: async () => { counters.secretMutations += 1; },
    verifyDeploy: async () => { counters.deployProofs += 1; },
    deploy: async () => { counters.deployMutations += 1; },
    refreshGuide: async () => { counters.guideMutations += 1; },
    checkWorker: async () => {
      counters.workerReadbacks += 1;
      return workerCheck(manifestPath, "ok");
    },
    now: () => new Date(FIXED_NOW),
    sleep: async () => {},
    ...overrides,
  };
}

async function invokeConnect(manifestPath, flags, counters, overrides = {}) {
  return cmdConnect("anthropic", {
    argv: [process.execPath, "brain.mjs", "connect", "anthropic", manifestPath, ...flags],
    answerSetupNeedsRecovery: (path) => {
      counters.journalInspections += 1;
      return answerSetupNeedsRecovery(path);
    },
    withManifestControl: async (_path, action) => {
      counters.manifestControls += 1;
      return action();
    },
    anthropicOptions: anthropicBoundaryOptions(manifestPath, counters, overrides),
  });
}

async function captureOutcome(action) {
  return action().then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
}

function treeSnapshot(root) {
  const snapshot = {};
  const walk = (folder, prefix = "") => {
    const entries = fs.readdirSync(folder, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const path = join(root, relativePath);
      const stat = lstatSync(path);
      const common = {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        snapshot[relativePath] = { type: "directory", ...common };
        walk(path, relativePath);
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = { type: "symlink", ...common, target: fs.readlinkSync(path) };
      } else {
        snapshot[relativePath] = {
          type: "file",
          ...common,
          bytes: readFileSync(path).toString("base64"),
        };
      }
    }
  };
  walk(root);
  return snapshot;
}

function recoveryArtifactSnapshot(fixture) {
  const ignored = new Set([
    fixture.manifestPath.slice(fixture.root.length + 1),
    "fixture-admin-key",
  ]);
  return Object.fromEntries(
    Object.entries(treeSnapshot(fixture.root)).filter(([path]) => !ignored.has(path)),
  );
}

function mutationView(counters) {
  return {
    manifestPublications: counters.manifestPublications,
    dailyPrepares: counters.dailyPrepares,
    dailyReconciles: counters.dailyReconciles,
    dailyRollbacks: counters.dailyRollbacks,
    secretMutations: counters.secretMutations,
    deployMutations: counters.deployMutations,
    guideMutations: counters.guideMutations,
    stagedCleanups: counters.stagedCleanups,
    journalCleanups: counters.journalCleanups,
  };
}

function recoveryErrorCode(error) {
  return error?.supportCode || error?.code || error?.cause?.supportCode || error?.cause?.code || null;
}

function memoryDailyScheduler(counters) {
  let state = Object.freeze({ exists: false, owned: false, enabled: false });
  return {
    read(identity) {
      counters.scheduleReads += 1;
      if (state.exists) {
        assert.equal(identity.id, state.definition.identity.id,
          "the scheduler boundary read the installed Brain identity");
      }
      return state;
    },
    install(definition, options = {}) {
      counters.scheduleInstalls += 1;
      if (state.exists) {
        assert.equal(options.replaceOwned, true,
          "a schedule replacement declared existing owned custody");
        assert.equal(options.expected?.definition?.definition_hash, state.definition.definition_hash,
          "a schedule replacement carried the exact observed predecessor");
      }
      state = Object.freeze({
        exists: true,
        owned: true,
        enabled: true,
        loaded: true,
        loaded_definition_matches: true,
        definition,
      });
    },
    setEnabled(identity, enabled) {
      counters.scheduleEnableWrites += 1;
      assert.equal(identity.id, state.definition.identity.id,
        "the scheduler boundary changed only the installed Brain identity");
      state = Object.freeze({ ...state, enabled });
    },
    remove(identity) {
      counters.scheduleRemovals += 1;
      assert.equal(identity.id, state.definition.identity.id,
        "the scheduler boundary removed only the installed Brain identity");
      state = Object.freeze({ exists: false, owned: false, enabled: false });
    },
    current() { return state; },
  };
}

async function withPatchedBuiltins(overrides, action) {
  const originalRename = fs.renameSync;
  const originalLstat = fs.lstatSync;
  const originalDateNow = Date.now;
  if (overrides.renameSync) {
    fs.renameSync = (...args) => overrides.renameSync(originalRename, ...args);
  }
  if (overrides.lstatSync) {
    fs.lstatSync = (...args) => overrides.lstatSync(originalLstat, ...args);
  }
  if (overrides.dateNow) Date.now = overrides.dateNow;
  syncBuiltinESMExports();
  try {
    return await action({ originalRename, originalLstat });
  } finally {
    fs.renameSync = originalRename;
    fs.lstatSync = originalLstat;
    Date.now = originalDateNow;
    syncBuiltinESMExports();
  }
}

async function persistentReplacementArm(errorCode) {
  const root = scratchRoot(errorCode.toLowerCase());
  const manifestPath = join(root, "brain.manifest.json");
  const journalPath = answerSetupJournalPath(manifestPath);
  writeFileSync(manifestPath, jsonBytes(fixtureManifest(root)), { mode: 0o600 });

  const counters = mutationCounters();
  const attempts = { primary: [], rollback: [] };
  let journalCommits = 0;
  let tick = FIXED_NOW;
  const nativeRename = fs.renameSync;

  const renameBoundary = (renameImpl, stagedPath, targetPath) => {
    if (targetPath === journalPath) {
      journalCommits += 1;
      return renameImpl(stagedPath, targetPath);
    }
    if (targetPath !== manifestPath) return renameImpl(stagedPath, targetPath);

    const staged = JSON.parse(readFileSync(stagedPath, "utf8"));
    const phase = answerSetupOf(staged) === "opus-sonnet" ? "primary" : "rollback";
    const identity = lstatSync(stagedPath);
    attempts[phase].push({
      path: stagedPath,
      identity: `${identity.dev}:${identity.ino}`,
    });
    const failure = new Error("synthetic Windows replacement refusal");
    failure.code = errorCode;
    throw failure;
  };

  try {
    const outcome = await withPatchedBuiltins({
      dateNow: () => tick++,
      renameSync: renameBoundary,
    }, () => captureOutcome(() => invokeConnect(
      manifestPath,
      ["--key-set-in-dashboard"],
      counters,
      {
        publicationOptions: {
          platform: "win32",
          rename: (from, to) => renameBoundary(nativeRename, from, to),
          sleep: () => {},
        },
      },
    )));

    const stagedPaths = [...attempts.primary, ...attempts.rollback].map((entry) => entry.path);
    return {
      errorCode,
      outcome,
      counters,
      attempts,
      journalCommits,
      journalRetained: existsSync(journalPath),
      stagedRetained: stagedPaths.length > 0 && stagedPaths.every((path) => existsSync(path)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("persistent Windows replacement retries the real primary and rollback writers", async () => {
  const arms = [];
  for (const errorCode of ["EPERM", "EBUSY"]) {
    arms.push(await persistentReplacementArm(errorCode));
  }

  for (const arm of arms) {
    assert.ok(arm.outcome.error, `${arm.errorCode}: no false success`);
    assert.equal(arm.outcome.result, null, `${arm.errorCode}: success was not reported`);
    assert.equal(arm.counters.manifestControls, 1,
      `${arm.errorCode}: the real connect credential boundary was reached`);
    assert.equal(arm.journalCommits, 1, `${arm.errorCode}: the real journal commit was reached`);
    assert.equal(arm.journalRetained, true, `${arm.errorCode}: the journal was retained`);
    assert.equal(arm.stagedRetained, true, `${arm.errorCode}: the real staged files were retained`);
    assert.ok(arm.attempts.primary.length > 0,
      `${arm.errorCode}: the real primary rename decision was reached`);
    assert.ok(arm.attempts.rollback.length > 0,
      `${arm.errorCode}: the real rollback rename decision was reached`);
    assert.ok(arm.attempts.primary.length <= WINDOWS_PUBLICATION_ATTEMPTS,
      `${arm.errorCode}: primary attempts stayed bounded`);
    assert.ok(arm.attempts.rollback.length <= WINDOWS_PUBLICATION_ATTEMPTS,
      `${arm.errorCode}: rollback attempts stayed bounded`);
    assert.equal(new Set(arm.attempts.primary.map((entry) => entry.identity)).size, 1,
      `${arm.errorCode}: primary attempts used one staged inode`);
    assert.equal(new Set(arm.attempts.rollback.map((entry) => entry.identity)).size, 1,
      `${arm.errorCode}: rollback attempts used one staged inode`);
    assert.deepEqual({
      secret: arm.counters.secretMutations,
      guide: arm.counters.guideMutations,
      deploy: arm.counters.deployMutations,
    }, { secret: 0, guide: 0, deploy: 0 },
    `${arm.errorCode}: no unproved later mutation was reached`);
  }

  assert.deepEqual(
    arms.map((arm) => [arm.attempts.primary.length, arm.attempts.rollback.length]),
    [[WINDOWS_PUBLICATION_ATTEMPTS, WINDOWS_PUBLICATION_ATTEMPTS],
      [WINDOWS_PUBLICATION_ATTEMPTS, WINDOWS_PUBLICATION_ATTEMPTS]],
    "the proof-aware writer must make the fixed Windows attempts for both publications",
  );
});

const INTERRUPT_CHILD = String.raw`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";

const manifestPath = process.env.FIXTURE_MANIFEST_PATH;
const journalPath = join(dirname(manifestPath), ".answer-setup-journal.json");
const stopAfter = process.env.FIXTURE_STOP_AFTER;
const originalRename = fs.renameSync;
const interruptRename = (from, to) => {
  originalRename(from, to);
  if (stopAfter === "journal" && to === journalPath) process.exit(71);
  if (stopAfter === "manifest" && to === manifestPath) process.exit(72);
  if (stopAfter === "secret-receipt" && basename(to).endsWith("-secret-receipt")) process.exit(72);
};
fs.renameSync = interruptRename;
syncBuiltinESMExports();

const setup = await import(process.env.FIXTURE_ANSWER_SETUP_MODULE);
const fixtureKey = ["sk", "ant", "fixture", "runtime", "sentinel"].join("-");
let secretPresent = process.env.FIXTURE_SECRET_EXISTED === "1";
await setup.runAnthropicAnswerSetup({
  manifestPath,
  flags: { "from-clipboard": true },
}, {
  platform: "win32",
  stdinIsTTY: false,
  acquireLock: async (_input, action) => action(),
  journalExists: () => false,
  loadManifest: (path) => JSON.parse(fs.readFileSync(path, "utf8")),
  verifyVersion: async () => {},
  prepareDaily: async () => {},
  readClipboard: async () => fixtureKey,
  clearClipboard: async () => {},
  preflight: async () => ({ status: "ok" }),
  listSecretNames: async () => secretPresent ? [setup.ANTHROPIC_SECRET_NAME] : [],
  putSecret: async () => { secretPresent = true; },
  deleteSecret: async () => { secretPresent = false; },
  reconcileDaily: async () => {},
  deploy: async () => {},
  checkWorker: async () => ({
    answer: { model: setup.RECOMMENDED_ANSWER_SETUP.answer_model, status: "ok" },
    check: { model: setup.RECOMMENDED_ANSWER_SETUP.gate_model, status: "ok" },
  }),
  now: () => new Date("2026-10-24T12:00:00.000Z"),
  sleep: async () => {},
  log: () => {},
  publicationOptions: {
    platform: "win32",
    rename: (from, to) => interruptRename(from, to),
    sleep: () => {},
  },
});
process.exit(90);
`;

function interruptedFixture(state, secretExisted, {
  stopAfterSecretReceipt = false,
  withGuide = false,
} = {}) {
  const root = scratchRoot(`${secretExisted ? "prior" : "fresh"}-${state}`);
  const manifestPath = join(root, "brain.manifest.json");
  const journalPath = answerSetupJournalPath(manifestPath);
  writeFileSync(manifestPath, jsonBytes(fixtureManifest(root)), { mode: 0o600 });
  if (withGuide) writeFileSync(join(root, "CLAUDE.md"), "fixture guide\n", { mode: 0o600 });

  const stopAfter = stopAfterSecretReceipt ? "secret-receipt"
    : state === "changed" ? "manifest" : "journal";
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", INTERRUPT_CHILD], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME || root,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_LAUNCHCTL: process.env.BRAIN_TEST_LAUNCHCTL || join(root, "launchctl-unavailable"),
      FIXTURE_ANSWER_SETUP_MODULE: ANSWER_SETUP_MODULE_URL,
      FIXTURE_MANIFEST_PATH: manifestPath,
      FIXTURE_SECRET_EXISTED: secretExisted ? "1" : "0",
      FIXTURE_STOP_AFTER: stopAfter,
    },
  });
  assert.equal(child.status, stopAfter === "journal" ? 71 : 72,
    "the child stopped at the selected real publication boundary");
  if (stopAfter === "secret-receipt") {
    assert.equal(child.status, 72,
      "the child stopped after the real secret receipt publication");
  }
  assert.equal(existsSync(journalPath), true, "the real transaction committed its journal");

  if (state === "ambiguous") {
    const concurrent = JSON.parse(readFileSync(manifestPath, "utf8"));
    concurrent.unrelated.concurrent_marker = true;
    writeFileSync(manifestPath, jsonBytes(concurrent), { mode: 0o600 });
  }

  const observedSetup = answerSetupOf(JSON.parse(readFileSync(manifestPath, "utf8")));
  assert.equal(observedSetup, state === "changed" ? "opus-sonnet" : "built-in",
    "the selected process stop produced the expected real manifest phase");

  return {
    root,
    manifestPath,
    journalPath,
    state,
    secretExisted,
    secretPresent: stopAfterSecretReceipt ? true : secretExisted,
  };
}

function recoveryBoundaryOptions(fixture, counters, trace, {
  throwSecretInventory = null,
  stageFile = undefined,
} = {}) {
  return {
    listSecretNames: async () => {
      counters.secretInventories += 1;
      trace.events.push("secret_inventory");
      if (throwSecretInventory) throw new Error(throwSecretInventory);
      return fixture.secretPresent ? [ANTHROPIC_SECRET_NAME] : [];
    },
    deleteSecret: async () => {
      counters.secretDeleteCalls += 1;
      counters.secretMutations += 1;
    },
    readRecoveryManifest: async () => {
      counters.manifestReadbacks += 1;
    },
    reconcileDaily: async (_path, options = {}) => {
      if (options.rollback) counters.dailyRollbacks += 1;
      else counters.dailyReconciles += 1;
    },
    deploy: async () => {
      counters.deployMutations += 1;
    },
    verifyDeploy: async () => {
      counters.deployProofs += 1;
    },
    checkWorker: async () => {
      counters.workerReadbacks += 1;
      return workerCheck(fixture.manifestPath, "ok");
    },
    readRecoveryGuides: async () => {
      counters.guideReadbacks += 1;
    },
    removeRecoveryStagedFile: async () => {
      counters.stagedCleanups += 1;
    },
    removeJournal: async () => {
      counters.journalCleanups += 1;
    },
    publicationOptions: {
      platform: "win32",
      rename: () => {
        counters.manifestPublications += 1;
        throw new Error("recovery publication must remain unreachable");
      },
      sleep: () => {},
    },
    ...(stageFile ? { stageFile } : {}),
  };
}

async function recoveryPreview(fixture, boundaryOptions = {}) {
  const counters = mutationCounters();
  const trace = { events: [] };
  const before = treeSnapshot(fixture.root);
  const outcome = await captureOutcome(() => invokeConnect(
    fixture.manifestPath,
    ["--recover", "rollback"],
    counters,
    recoveryBoundaryOptions(fixture, counters, trace, boundaryOptions),
  ));
  return {
    outcome,
    state: outcome.result?.recovery_state ?? outcome.error?.recoveryState ?? null,
    before,
    after: treeSnapshot(fixture.root),
    counters,
    trace,
  };
}

async function recoveryExecution(fixture, flags = ["--recover", "rollback", "--confirm-recovery", "unused"]) {
  const counters = mutationCounters();
  const trace = { events: [] };
  const before = treeSnapshot(fixture.root);
  const outcome = await captureOutcome(() => invokeConnect(
    fixture.manifestPath,
    flags,
    counters,
    recoveryBoundaryOptions(fixture, counters, trace),
  ));
  return { outcome, counters, trace, before, after: treeSnapshot(fixture.root) };
}

function assertInterruptedCard(outcome, expectedState, label = "interrupted setup") {
  assert.ok(outcome.error, `${label}: the command exited nonzero`);
  assert.deepEqual(String(outcome.error.message).split("\n"), [
    `Recovery state: ${expectedState}`,
    ...INTERRUPTED_CARD,
  ], `${label}: the fixed content-free preview and card were returned`);
  assert.equal(recoveryErrorCode(outcome.error), "ANTHROPIC_ROLLBACK_INCOMPLETE",
    `${label}: the existing conservative support category was retained`);
  assert.equal(outcome.error.recoveryState, expectedState,
    `${label}: the classified preview state remained machine-readable`);
}

function assertNoRecoveryMutation(counters, label) {
  assert.deepEqual(mutationView(counters), {
    manifestPublications: 0,
    dailyPrepares: 0,
    dailyReconciles: 0,
    dailyRollbacks: 0,
    secretMutations: 0,
    deployMutations: 0,
    guideMutations: 0,
    stagedCleanups: 0,
    journalCleanups: 0,
  }, `${label}: no local, scheduler, secret, deploy, guide, or cleanup mutation ran`);
}

function assertMutationFreePreview(preview, expectedState) {
  assert.ok(preview.counters.journalInspections > 0,
    "preview reached the real connect journal fence");
  assert.equal(preview.counters.manifestControls, 0,
    "preview classified before manifest credential control");
  assert.deepEqual(preview.after, preview.before,
    "preview preserved every manifest, journal, stage, and fixture byte and identity");
  assertNoRecoveryMutation(preview.counters, "preview");
  assert.equal(preview.state, expectedState, "preview returned the exact classified state");
  assertInterruptedCard(preview.outcome, expectedState, "preview");
}

function rewriteJournal(fixture, mutate) {
  const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
  mutate(journal);
  writeFileSync(fixture.journalPath, jsonBytes(journal), { mode: 0o600 });
}

test("schema-2 recovery requires every closed journal field and guide record", async (t) => {
  const requiredTopLevel = [
    "schema_version",
    "operation",
    "operation_id",
    "target",
    "original",
    "intended",
    "previous",
    "secret_name_existed",
    "secret_phases",
    "allowed_forward_additions",
    "forward_policy",
    "guides",
    "publication_bounds",
    "mode",
  ];
  const cases = [
    ...requiredTopLevel.map((field) => [
      `top-level ${field}`,
      (journal) => { delete journal[field]; },
    ]),
    ["prior answer-model receipt", (journal) => { delete journal.previous.answer_model; }],
    ["prior gate-model receipt", (journal) => { delete journal.previous.gate_model; }],
    ["prior daily-cap receipt", (journal) => { delete journal.previous.daily_llm_spend_cap_usd; }],
    ["Claude guide record", (journal) => { delete journal.guides.claude; }],
    ["Codex guide record", (journal) => { delete journal.guides.codex; }],
    ["secret write intent", (journal) => { delete journal.secret_phases.write_intended; }],
    ["mode-to-secret intent relationship", (journal) => {
      journal.secret_phases.write_intended = !journal.secret_phases.write_intended;
    }],
    ["forward policy path", (journal) => { delete journal.forward_policy.paths; }],
    ["forward additions initial relationship", (journal) => {
      journal.allowed_forward_additions.push("brain.domain");
    }],
    ["original staged-byte relationship", (journal) => {
      journal.original.stage.sha256 = "0".repeat(64);
    }],
    ["intended staged-byte relationship", (journal) => {
      journal.intended.stage.byte_length += 1;
    }],
    ["unknown nested member", (journal) => { journal.previous.unreviewed_extension = true; }],
    ["unknown top-level member", (journal) => { journal.unreviewed_extension = true; }],
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const fixture = interruptedFixture("original", true);
      try {
        rewriteJournal(fixture, mutate);
        const preview = await recoveryPreview(fixture);
        assertMutationFreePreview(preview, "ambiguous");
        assert.equal(recoveryErrorCode(preview.outcome.error), "ANTHROPIC_ROLLBACK_INCOMPLETE",
          `${label}: malformed schema returned the fixed interrupted-setup code`);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  await t.test("complete journal control", async () => {
    const fixture = interruptedFixture("original", true);
    try {
      const preview = await recoveryPreview(fixture);
      assertMutationFreePreview(preview, "original");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("a real post-secret-receipt interruption preserves every secret and recovery artifact", async () => {
  const fixtures = [];
  try {
    const fresh = interruptedFixture("changed", false, { stopAfterSecretReceipt: true });
    fixtures.push(fresh);
    const freshPreview = await recoveryPreview(fresh);
    assertMutationFreePreview(freshPreview, "changed");
    assert.equal(freshPreview.outcome.error?.recoveryReceipt?.secret_state, "changed",
      "the fresh interruption proved its completed write and inventory receipt");
    const freshExecution = await recoveryExecution(fresh);
    assertInterruptedCard(freshExecution.outcome, "changed", "fresh-secret execution request");
    assertNoRecoveryMutation(freshExecution.counters, "fresh-secret execution request");
    assert.deepEqual(freshExecution.after, freshExecution.before,
      "fresh-secret execution request retained every local byte and identity");
    assert.equal(freshExecution.counters.secretDeleteCalls, 0,
      "the proved fresh secret was not deleted");
    assert.equal(fresh.secretPresent, true, "the live fresh secret remained present");

    const prior = interruptedFixture("changed", true, { stopAfterSecretReceipt: true });
    fixtures.push(prior);
    const priorPreview = await recoveryPreview(prior);
    assertMutationFreePreview(priorPreview, "changed");
    const priorExecution = await recoveryExecution(prior);
    assertInterruptedCard(priorExecution.outcome, "changed", "prior-secret execution request");
    assertNoRecoveryMutation(priorExecution.counters, "prior-secret execution request");
    assert.deepEqual(priorExecution.after, priorExecution.before,
      "prior-secret execution request retained every local byte and identity");
    assert.equal(priorExecution.counters.secretDeleteCalls, 0,
      "the prior-secret control made no deletion call");
    assert.equal(priorExecution.counters.secretMutations, 0,
      "the prior-secret control crossed no secret mutation boundary");
    assert.equal(prior.secretPresent, true, "the prior secret remained present");

    for (const receiptState of ["missing", "altered"]) {
      const malformed = interruptedFixture("changed", false, { stopAfterSecretReceipt: true });
      fixtures.push(malformed);
      const receiptName = fs.readdirSync(malformed.root)
        .find((name) => name.endsWith("-secret-receipt"));
      assert.ok(receiptName, `${receiptState}: the real secret receipt exists`);
      const receiptPath = join(malformed.root, receiptName);
      if (receiptState === "missing") fs.unlinkSync(receiptPath);
      else {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        receipt.phase = "unproved";
        writeFileSync(receiptPath, jsonBytes(receipt), { mode: 0o600 });
      }
      const preview = await recoveryPreview(malformed);
      assertMutationFreePreview(preview, "ambiguous");
      assert.equal(preview.counters.secretDeleteCalls, 0,
        `${receiptState}: invalid receipt made no deletion decision`);
      assert.equal(malformed.secretPresent, true,
        `${receiptState}: invalid receipt preserved the live secret`);
    }
  } finally {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("non-JSON recovery preview renders the fixed content-free card", async () => {
  const fixture = interruptedFixture("changed", true);
  try {
    for (const [label, flags] of [
      ["explicit non-JSON preview", ["--recover", "rollback"]],
      ["ordinary interrupted connect", ["--key-set-in-dashboard"]],
    ]) {
      const counters = mutationCounters();
      const trace = { events: [] };
      const outcome = await captureOutcome(() => invokeConnect(
        fixture.manifestPath,
        flags,
        counters,
        recoveryBoundaryOptions(fixture, counters, trace),
      ));
      assertInterruptedCard(outcome, "changed", label);
      assert.equal(counters.manifestControls, 0,
        `${label}: classification stayed outside manifest credential control`);
      assertNoRecoveryMutation(counters, label);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ordinary recovery detection exceptions map to the closed ambiguous card", async (t) => {
  const fixture = interruptedFixture("changed", true);
  const boundaryDetail = "sensitive boundary detail at /private/contract-fixture";
  try {
    for (const arm of [
      { label: "journal presence throws", throwAt: "presence", expectedRecognitionCalls: 0 },
      { label: "schema recognition throws", throwAt: "recognition", expectedRecognitionCalls: 1 },
    ]) {
      await t.test(arm.label, async () => {
        const counters = mutationCounters();
        const trace = { events: [] };
        const calls = { presence: 0, recognition: 0 };
        const before = treeSnapshot(fixture.root);
        const outcome = await captureOutcome(() => cmdConnect("anthropic", {
          argv: [
            process.execPath,
            "brain.mjs",
            "connect",
            "anthropic",
            fixture.manifestPath,
            "--key-set-in-dashboard",
          ],
          answerSetupNeedsRecovery: () => {
            counters.journalInspections += 1;
            calls.presence += 1;
            if (arm.throwAt === "presence") throw new Error(boundaryDetail);
            return true;
          },
          answerSetupHasSchema2RecoveryJournal: () => {
            calls.recognition += 1;
            if (arm.throwAt === "recognition") throw new Error(boundaryDetail);
            return true;
          },
          withManifestControl: async (_path, action) => {
            counters.manifestControls += 1;
            return action();
          },
          anthropicOptions: recoveryBoundaryOptions(fixture, counters, trace),
        }));

        assert.equal(calls.presence, 1, `${arm.label}: the presence decision was reached once`);
        assert.equal(calls.recognition, arm.expectedRecognitionCalls,
          `${arm.label}: schema recognition followed only a positive presence result`);
        assertInterruptedCard(outcome, "ambiguous", arm.label);
        assert.equal(outcome.error.message.includes(boundaryDetail), false,
          `${arm.label}: the thrown boundary detail did not enter public output`);
        assert.equal(outcome.error.message.includes("contract-fixture"), false,
          `${arm.label}: the path fragment did not enter public output`);
        assert.equal(counters.manifestControls, 0,
          `${arm.label}: recovery detection stopped before manifest credential control`);
        assert.equal(counters.secretInventories, 0,
          `${arm.label}: the failed outer boundary did not claim classifier progress`);
        assertNoRecoveryMutation(counters, arm.label);
        assert.deepEqual(treeSnapshot(fixture.root), before,
          `${arm.label}: every retained recovery byte and identity stayed exact`);
      });
    }

    await t.test("valid journal control reaches the classifier", async () => {
      const counters = mutationCounters();
      const trace = { events: [] };
      const calls = { presence: 0, recognition: 0 };
      const before = treeSnapshot(fixture.root);
      const outcome = await captureOutcome(() => cmdConnect("anthropic", {
        argv: [
          process.execPath,
          "brain.mjs",
          "connect",
          "anthropic",
          fixture.manifestPath,
          "--key-set-in-dashboard",
        ],
        answerSetupNeedsRecovery: () => {
          counters.journalInspections += 1;
          calls.presence += 1;
          return true;
        },
        answerSetupHasSchema2RecoveryJournal: () => {
          calls.recognition += 1;
          return true;
        },
        withManifestControl: async (_path, action) => {
          counters.manifestControls += 1;
          return action();
        },
        anthropicOptions: recoveryBoundaryOptions(fixture, counters, trace),
      }));

      assert.equal(calls.presence, 1, "control reached journal presence once");
      assert.equal(calls.recognition, 1, "control reached schema recognition once");
      assert.equal(counters.secretInventories, 1,
        "control reached the interrupted recovery classifier once");
      assertInterruptedCard(outcome, "changed", "valid-journal control");
      assert.equal(counters.manifestControls, 0,
        "control classified before manifest credential control");
      assertNoRecoveryMutation(counters, "valid-journal control");
      assert.deepEqual(treeSnapshot(fixture.root), before,
        "control preserved every retained recovery byte and identity");
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the real journal recognizer maps every unproved format boundary closed", async (t) => {
  const boundaryDetail = "sensitive recognizer detail at /private/contract-fixture";
  const cases = [
    {
      id: "truncated-current",
      create(path) { writeFileSync(path, '{"schema_version":2,', { mode: 0o600 }); },
    },
    {
      id: "empty-current",
      create(path) { writeFileSync(path, "", { mode: 0o600 }); },
    },
    {
      id: "unrecognized-json",
      create(path) { writeFileSync(path, "{}\n", { mode: 0o600 }); },
    },
    {
      id: "non-file-current",
      create(path) { fs.mkdirSync(path, { mode: 0o700 }); },
    },
    {
      id: "current-read-failure",
      create(path) {
        writeFileSync(path, '{"schema_version":2,"operation":"answer-setup"}\n', { mode: 0o600 });
      },
      refuseRead: true,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.id, async () => {
      for (const control of [true, false]) {
        const root = scratchRoot(`recognizer-${entry.id}-${control ? "control" : "negative"}`);
        const manifestPath = join(root, "brain.manifest.json");
        const journalPath = answerSetupJournalPath(manifestPath);
        const counters = mutationCounters();
        const decisions = { presence: 0, recognition: 0, inspections: 0, reads: 0 };
        writeFileSync(manifestPath, jsonBytes(fixtureManifest(root)), { mode: 0o600 });
        if (control) {
          writeFileSync(journalPath, jsonBytes(answerSetupJournal(
            fixtureManifest(root),
            { mode: "keep", secretExisted: true },
          )), { mode: 0o600 });
        } else {
          entry.create(journalPath);
        }
        const before = treeSnapshot(root);
        try {
          const outcome = await captureOutcome(() => cmdConnect("anthropic", {
            argv: [
              process.execPath,
              "brain.mjs",
              "connect",
              "anthropic",
              manifestPath,
              "--key-set-in-dashboard",
            ],
            answerSetupNeedsRecovery: (path) => {
              counters.journalInspections += 1;
              decisions.presence += 1;
              return answerSetupNeedsRecovery(path);
            },
            answerSetupHasSchema2RecoveryJournal: (path) => {
              decisions.recognition += 1;
              return answerSetupHasSchema2RecoveryJournal(path, {
                inspect(target) {
                  decisions.inspections += 1;
                  return lstatSync(target);
                },
                read(target) {
                  decisions.reads += 1;
                  if (!control && entry.refuseRead) throw new Error(boundaryDetail);
                  return readFileSync(target);
                },
              });
            },
            withManifestControl: async (_path, action) => {
              counters.manifestControls += 1;
              return action();
            },
          }));

          assert.equal(decisions.presence, 1,
            `${entry.id}/${control ? "control" : "negative"}: presence decision was reached`);
          assert.equal(decisions.recognition, 1,
            `${entry.id}/${control ? "control" : "negative"}: real recognition decision was reached`);
          assert.ok(decisions.inspections > 0,
            `${entry.id}/${control ? "control" : "negative"}: stable identity inspection was reached`);
          if (control) {
            assert.equal(outcome.error?.message, HALF_RUN(manifestPath),
              `${entry.id}: the valid legacy control retained the legacy refusal`);
            assert.ok(decisions.reads > 0, `${entry.id}: the legacy control completed a stable read`);
          } else {
            assertInterruptedCard(outcome, "ambiguous", entry.id);
            assert.equal(String(outcome.error?.message).includes(boundaryDetail), false,
              `${entry.id}: private boundary detail stayed out of output`);
          }
          assert.equal(counters.manifestControls, 0,
            `${entry.id}/${control ? "control" : "negative"}: no manifest control`);
          assertNoRecoveryMutation(counters, `${entry.id}/${control ? "control" : "negative"}`);
          assert.deepEqual(treeSnapshot(root), before,
            `${entry.id}/${control ? "control" : "negative"}: all evidence stayed exact`);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  }
});

test("real abrupt-stop recovery classifies every arm and refuses every execution request", async () => {
  const fixtures = [];
  try {
    const matrix = [];
    for (const secretExisted of [false, true]) {
      for (const state of ["original", "changed", "ambiguous"]) {
        const fixture = interruptedFixture(state, secretExisted);
        fixtures.push(fixture);
        const preview = await recoveryPreview(fixture);
        assertMutationFreePreview(preview, state);
        matrix.push({ fixture, preview });
      }
    }
    assert.equal(matrix.length, 6, "both key histories reached all three state arms");

    for (const { fixture, preview } of matrix) {
      const artifactsBeforeExecution = treeSnapshot(fixture.root);
      const execution = await recoveryExecution(fixture);
      assertInterruptedCard(execution.outcome, fixture.state,
        `${fixture.state} execution request`);
      assert.ok(execution.counters.journalInspections > 0,
        "execution request reached the real connect journal fence");
      assert.equal(execution.counters.manifestControls, 0,
        "execution request classified before manifest credential control");
      assertNoRecoveryMutation(execution.counters, `${fixture.state} execution request`);
      assert.deepEqual(treeSnapshot(fixture.root), artifactsBeforeExecution,
        "execution request kept the journal, stages, manifest, and fixture bytes exact");
      assert.equal(existsSync(fixture.journalPath), true,
        "execution request retained the real journal");
    }
  } finally {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("recovery classification proves intended-stage evidence for every manifest phase", async (t) => {
  const cases = [
    {
      label: "altered bytes while the manifest is original",
      state: "original",
      mutate({ intendedPath }) {
        writeFileSync(intendedPath, "{\"altered\":true}\n", { mode: 0o600 });
      },
    },
    {
      label: "replacement identity with exact bytes while the manifest is original",
      state: "original",
      mutate({ intendedPath }) {
        const exact = readFileSync(intendedPath);
        fs.unlinkSync(intendedPath);
        writeFileSync(intendedPath, exact, { mode: 0o600, flag: "wx" });
      },
    },
    {
      label: "missing intended stage while the manifest is original",
      state: "original",
      mutate({ intendedPath }) {
        fs.unlinkSync(intendedPath);
      },
    },
    {
      label: "symlinked intended stage while the manifest is original",
      state: "original",
      mutate({ fixture, intendedPath }) {
        const target = join(fixture.root, "unowned-intended-evidence");
        writeFileSync(target, readFileSync(intendedPath), { mode: 0o600, flag: "wx" });
        fs.unlinkSync(intendedPath);
        fs.symlinkSync(target, intendedPath);
      },
    },
    {
      label: "unreadable intended stage while the manifest is original",
      state: "original",
      unreadable: true,
      mutate() {},
    },
    {
      label: "present intended stage after publication consumed it",
      state: "changed",
      mutate({ fixture, intendedPath }) {
        assert.equal(existsSync(intendedPath), false,
          "the changed-phase negative began after intended-stage consumption");
        writeFileSync(intendedPath, readFileSync(fixture.manifestPath), {
          mode: 0o600,
          flag: "wx",
        });
      },
    },
  ];

  const run = async (entry, alterEvidence) => {
    const fixture = interruptedFixture(entry.state, true);
    const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
    const intendedPath = join(fixture.root, journal.intended.stage.name);
    const decisions = { intendedInspections: 0, intendedReads: 0 };
    try {
      if (alterEvidence) entry.mutate({ fixture, journal, intendedPath });
      const stageFile = {
        inspect(path) {
          if (path === intendedPath) decisions.intendedInspections += 1;
          return lstatSync(path);
        },
        read(path) {
          if (path === intendedPath) {
            decisions.intendedReads += 1;
            if (alterEvidence && entry.unreadable) {
              const error = new Error("synthetic unreadable intended evidence");
              error.code = "EACCES";
              throw error;
            }
          }
          return readFileSync(path);
        },
      };
      const preview = await recoveryPreview(fixture, { stageFile });
      return { fixture, preview, decisions };
    } catch (error) {
      rmSync(fixture.root, { recursive: true, force: true });
      throw error;
    }
  };

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const negative = await run(entry, true);
      const control = await run(entry, false);
      try {
        assert.ok(negative.decisions.intendedInspections > 0,
          `${entry.label}: the classifier reached the journal-recorded intended-stage decision`);
        assertMutationFreePreview(negative.preview, "ambiguous");
        assert.ok(control.decisions.intendedInspections > 0,
          `${entry.label}: the intact control reached the same intended-stage decision`);
        assertMutationFreePreview(control.preview, entry.state);
      } finally {
        rmSync(negative.fixture.root, { recursive: true, force: true });
        rmSync(control.fixture.root, { recursive: true, force: true });
      }
    });
  }
});

async function cleanupArtifactArm(entry, { replace }) {
  const root = scratchRoot(`cleanup-${entry.id}-${replace ? "negative" : "control"}`);
  const manifestPath = join(root, "brain.manifest.json");
  const journalPath = answerSetupJournalPath(manifestPath);
  writeFileSync(manifestPath, jsonBytes(fixtureManifest(root, { domain: !entry.forward })), {
    mode: 0o600,
  });
  const counters = mutationCounters();
  const replacementBytes = Buffer.from("unowned replacement evidence\n", "utf8");
  const publishedStages = { secret: null, forward: null, rollback: null };
  const nativeRename = fs.renameSync;
  let secretPresent = entry.secret === true ? false : true;
  let verifyCalls = 0;
  let deployCalls = 0;
  let replacementDecisions = 0;
  let replacementPath = null;
  let preCleanupSnapshot = null;

  const journalValue = () => JSON.parse(readFileSync(journalPath, "utf8"));
  const selectArtifact = () => {
    const journal = journalValue();
    if (entry.id === "original") return join(root, journal.original.stage.name);
    if (entry.id === "intended") return join(root, journal.intended.stage.name);
    if (entry.id === "secret-final") return join(root, journal.secret_phases.receipt_name);
    if (entry.id === "secret-staging") return publishedStages.secret;
    if (entry.id === "forward-final") return join(root, journal.forward_policy.receipt_name);
    if (entry.id === "forward-staging") return publishedStages.forward;
    if (entry.id === "composite") {
      const name = fs.readdirSync(root).find((candidate) => candidate.endsWith("-original-forward"));
      return name ? join(root, name) : null;
    }
    if (entry.id === "rollback") return publishedStages.rollback;
    throw new Error(`unknown cleanup artifact ${entry.id}`);
  };
  const replaceArtifact = () => {
    if (!replace || replacementDecisions > 0) return;
    replacementPath = selectArtifact();
    assert.ok(replacementPath, `${entry.id}: the operation created the selected artifact path`);
    if (existsSync(replacementPath)) fs.unlinkSync(replacementPath);
    writeFileSync(replacementPath, replacementBytes, { mode: 0o600, flag: "wx" });
    replacementDecisions += 1;
    preCleanupSnapshot = recoveryArtifactSnapshot({ root, manifestPath });
  };
  const publicationBoundary = (from, to) => {
    if (basename(to).endsWith("-secret-receipt")) publishedStages.secret = from;
    if (basename(to).endsWith("-forward-receipt")) publishedStages.forward = from;
    if (to === manifestPath && basename(from).includes("-rollback-")) {
      publishedStages.rollback = from;
    }
    return nativeRename(from, to);
  };

  try {
    const outcome = await captureOutcome(() => invokeConnect(
      manifestPath,
      entry.secret ? ["--from-clipboard"] : ["--key-set-in-dashboard"],
      counters,
      {
        readClipboard: async () => ["sk", "ant", "fixture", "runtime", "sentinel"].join("-"),
        clearClipboard: async () => {},
        preflight: async () => ({ status: "ok" }),
        listSecretNames: async () => secretPresent ? [ANTHROPIC_SECRET_NAME] : [],
        putSecret: async () => {
          secretPresent = true;
          counters.secretMutations += 1;
        },
        verifyDeploy: async () => {
          counters.deployProofs += 1;
          verifyCalls += 1;
          if (entry.seam === "verify-primary" && verifyCalls === 1) replaceArtifact();
          if (entry.seam === "verify-rollback" && verifyCalls === 2) replaceArtifact();
        },
        deploy: async (path) => {
          counters.deployMutations += 1;
          deployCalls += 1;
          if (entry.forward && deployCalls === 1) {
            const deployed = JSON.parse(readFileSync(path, "utf8"));
            await persistWorkersDevDomain(
              path,
              deployed,
              { id: "fixture-account" },
              deployed.brain.worker_name,
              {
                workersDevSubdomain: "contract-cleanup-fixture",
                verifyWorkersDevCandidate: async () => ({ ok: true }),
              },
            );
          }
        },
        checkWorker: async () => {
          counters.workerReadbacks += 1;
          if (entry.seam === "worker") replaceArtifact();
          return workerCheck(manifestPath, entry.rollback ? "key_rejected" : "ok");
        },
        publicationOptions: {
          platform: "win32",
          rename: publicationBoundary,
          sleep: () => {},
        },
      },
    ));
    return {
      root,
      manifestPath,
      journalPath,
      counters,
      outcome,
      replacementBytes,
      replacementDecisions,
      replacementPath,
      preCleanupSnapshot,
      operationArtifacts: fs.readdirSync(root)
        .filter((name) => name.startsWith(".answer-setup-stage-")),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("ordinary cleanup proves every operation artifact before deleting any evidence", async (t) => {
  const cases = [
    { id: "original", label: "original stage", seam: "verify-primary" },
    { id: "intended", label: "consumed intended stage path", seam: "verify-primary" },
    { id: "secret-final", label: "published secret receipt", seam: "verify-primary", secret: true },
    { id: "secret-staging", label: "consumed secret receipt stage path", seam: "verify-primary", secret: true },
    { id: "forward-final", label: "published forward receipt", seam: "worker", forward: true },
    { id: "forward-staging", label: "consumed forward receipt stage path", seam: "worker", forward: true },
    { id: "composite", label: "forward original composite stage", seam: "worker", forward: true },
    { id: "rollback", label: "consumed rollback stage path", seam: "verify-rollback", rollback: true },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const negative = await cleanupArtifactArm(entry, { replace: true });
      const control = await cleanupArtifactArm(entry, { replace: false });
      try {
        assert.equal(negative.replacementDecisions, 1,
          `${entry.label}: the replacement decision was reached after owned publication`);
        assert.ok(negative.counters.deployProofs > 0,
          `${entry.label}: the real deployment proof boundary was reached`);
        assert.ok(negative.outcome.error, `${entry.label}: cleanup refused the replacement`);
        if (entry.rollback) {
          assert.equal(recoveryErrorCode(negative.outcome.error), "ANTHROPIC_ROLLBACK_INCOMPLETE",
            `${entry.label}: rollback reported the fixed incomplete result`);
        } else {
          assert.equal(recoveryErrorCode(negative.outcome.error), "RECOVERY_CLEANUP_FAILED",
            `${entry.label}: ordinary success reported cleanup proof failure`);
        }
        assert.equal(existsSync(negative.replacementPath), true,
          `${entry.label}: the unproved replacement was retained`);
        assert.equal(readFileSync(negative.replacementPath).equals(negative.replacementBytes), true,
          `${entry.label}: the exact replacement bytes were retained`);
        assert.equal(existsSync(negative.journalPath), true,
          `${entry.label}: the journal remained available for review`);
        assert.deepEqual(
          recoveryArtifactSnapshot(negative),
          negative.preCleanupSnapshot,
          `${entry.label}: preflight failure retained every operation artifact before deletion`,
        );

        if (entry.rollback) {
          assert.ok(control.outcome.error, `${entry.label}: the green control reached its answer failure`);
          assert.equal(recoveryErrorCode(control.outcome.error), "ANTHROPIC_KEY_NOT_ACCEPTED",
            `${entry.label}: the intact artifact set returned the original answer failure`);
          assert.equal(control.counters.deployMutations, 2,
            `${entry.label}: the control completed forward and rollback deployment`);
        } else {
          assert.equal(control.outcome.error, null,
            `${entry.label}: the intact artifact set completed successfully`);
          assert.equal(control.outcome.result?.rolled_back, false,
            `${entry.label}: the green control stayed on the forward path`);
        }
        assert.equal(existsSync(control.journalPath), false,
          `${entry.label}: the green control removed its proved journal last`);
        assert.deepEqual(control.operationArtifacts, [],
          `${entry.label}: the green control removed every proved operation artifact`);
      } finally {
        rmSync(negative.root, { recursive: true, force: true });
        rmSync(control.root, { recursive: true, force: true });
      }
    });
  }
});

test("throwing preview boundaries map private text to the closed card", async () => {
  const fixture = interruptedFixture("changed", true);
  const privateText = "private provider detail at /private/fixture-owner-path";
  try {
    const preview = await recoveryPreview(fixture, { throwSecretInventory: privateText });
    assertMutationFreePreview(preview, "ambiguous");
    assert.equal(preview.counters.secretInventories, 1,
      "the throwing inventory boundary was reached once");
    assert.equal(preview.outcome.error.message.includes(privateText), false,
      "the boundary detail did not enter public output");
    assert.equal(preview.outcome.error.message.includes("fixture-owner-path"), false,
      "the private path fragment did not enter public output");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("malformed manifests and bad arguments stop before manifest control", async () => {
  const malformed = interruptedFixture("changed", true);
  try {
    writeFileSync(malformed.manifestPath, "{", { mode: 0o600 });
    const preview = await recoveryPreview(malformed);
    assertMutationFreePreview(preview, "ambiguous");
    assert.equal(preview.counters.manifestControls, 0,
      "malformed manifest classification did not enter manifest control");

    const counters = mutationCounters();
    const before = treeSnapshot(malformed.root);
    for (const [label, flags] of [
      ["bad recovery action", ["--recover", "not-an-action"]],
      ["confirmation without action", ["--confirm-recovery", "unused"]],
    ]) {
      const badArguments = await captureOutcome(() => invokeConnect(
        malformed.manifestPath,
        flags,
        counters,
        recoveryBoundaryOptions(malformed, counters, { events: [] }),
      ));
      assertInterruptedCard(badArguments, "ambiguous", label);
      assert.equal(counters.manifestControls, 0,
        `${label}: argument validation did not enter manifest control`);
      assertNoRecoveryMutation(counters, label);
      assert.deepEqual(treeSnapshot(malformed.root), before,
        `${label}: every local byte and identity remained exact`);
    }
  } finally {
    rmSync(malformed.root, { recursive: true, force: true });
  }
});

test("an existing Claude answer setup refuses every new-key mode before mutation", async (t) => {
  const cases = [
    {
      label: "RBPRM-R4-001 clipboard replacement at cap 5",
      cap: 5,
      flags: ["--from-clipboard"],
      platform: "win32",
      stdinIsTTY: false,
      clipboard: true,
    },
    {
      label: "RBPRM-R4-002 clipboard replacement at cap 10 in JSON mode",
      cap: 10,
      flags: ["--from-clipboard", "--json"],
      platform: "win32",
      stdinIsTTY: false,
      clipboard: true,
      json: true,
    },
    {
      label: "dashboard replacement",
      cap: 5,
      flags: ["--key-set-in-dashboard"],
      platform: "win32",
      stdinIsTTY: false,
      clipboard: false,
    },
    {
      label: "prompt replacement",
      cap: 5,
      flags: [],
      platform: "darwin",
      stdinIsTTY: true,
      clipboard: false,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const root = scratchRoot(`replacement-${entry.cap}`);
      const manifestPath = join(root, "brain.manifest.json");
      const current = fixtureManifest(root);
      current.retrieval = { ...RECOMMENDED_ANSWER_SETUP };
      current.safety.daily_llm_spend_cap_usd = entry.cap;
      writeFileSync(manifestPath, jsonBytes(current), { mode: 0o600 });

      const counters = mutationCounters();
      const before = treeSnapshot(root);
      let lockEntries = 0;
      let insideLock = false;
      let manifestReads = 0;
      let lockedManifestReads = 0;
      let clipboardReads = 0;
      let clipboardClears = 0;
      let clipboardPresent = entry.clipboard;
      let promptReads = 0;
      let preflights = 0;
      let secretPresent = true;
      const replacementKey = ["sk", "ant", "api03", "fixture-replacement"].join("-");

      try {
        const outcome = await captureOutcome(() => invokeConnect(
          manifestPath,
          entry.flags,
          counters,
          {
            platform: entry.platform,
            stdinIsTTY: entry.stdinIsTTY,
            loadManifest: (path) => {
              manifestReads += 1;
              if (insideLock) lockedManifestReads += 1;
              return { m: JSON.parse(readFileSync(path, "utf8")) };
            },
            acquireLock: async (_input, action) => {
              lockEntries += 1;
              insideLock = true;
              try { return await action(); }
              finally { insideLock = false; }
            },
            readClipboard: async () => {
              clipboardReads += 1;
              return replacementKey;
            },
            clearClipboard: async () => {
              clipboardClears += 1;
              clipboardPresent = false;
            },
            readSecret: async () => {
              promptReads += 1;
              return replacementKey;
            },
            preflight: async () => {
              preflights += 1;
              return { status: "ok" };
            },
            listSecretNames: async () => {
              counters.secretInventories += 1;
              return secretPresent ? [ANTHROPIC_SECRET_NAME] : [];
            },
            putSecret: async () => {
              counters.secretMutations += 1;
              secretPresent = true;
            },
            deleteSecret: async () => {
              counters.secretMutations += 1;
              counters.secretDeleteCalls += 1;
              secretPresent = false;
            },
            publicationOptions: {
              platform: "win32",
              rename: (from, to) => {
                if (to === manifestPath) counters.manifestPublications += 1;
                return fs.renameSync(from, to);
              },
              sleep: () => {},
            },
          },
        ));

        assert.equal(outcome.result, null, `${entry.label}: replacement exited nonzero`);
        if (entry.json) {
          assert.equal(outcome.error?.constructor?.name, "JsonFatal");
          assert.deepEqual(outcome.error?.payload, {
            schema_version: 1,
            operation: "answer_setup.connect",
            status: "error",
            error_code: "anthropic_key_replacement_unsupported",
            automatic_action: "none",
          });
        } else {
          assert.equal(outcome.error?.message, KEY_REPLACEMENT_UNSUPPORTED);
          assert.equal(outcome.error?.supportCode, "ANTHROPIC_KEY_REPLACEMENT_UNSUPPORTED");
        }
        assert.equal(counters.journalInspections, 1,
          `${entry.label}: the absent-journal decision was reached`);
        assert.equal(counters.manifestControls, 1,
          `${entry.label}: the ordinary connect control was reached`);
        assert.equal(lockEntries, 1, `${entry.label}: the lifecycle lock was acquired`);
        assert.equal(manifestReads, 2, `${entry.label}: outer and locked manifest reads both ran`);
        assert.equal(lockedManifestReads, 1,
          `${entry.label}: replacement was decided from the current manifest under lock`);
        assert.deepEqual({
          manifestPublications: counters.manifestPublications,
          versionChecks: counters.versionChecks,
          dailyPrepares: counters.dailyPrepares,
          dailyReconciles: counters.dailyReconciles,
          dailyRollbacks: counters.dailyRollbacks,
          secretInventories: counters.secretInventories,
          secretMutations: counters.secretMutations,
          secretDeleteCalls: counters.secretDeleteCalls,
          deployProofs: counters.deployProofs,
          deployMutations: counters.deployMutations,
          workerReadbacks: counters.workerReadbacks,
          guideMutations: counters.guideMutations,
          guideReadbacks: counters.guideReadbacks,
          stagedCleanups: counters.stagedCleanups,
          journalCleanups: counters.journalCleanups,
          clipboardReads,
          promptReads,
          preflights,
        }, {
          manifestPublications: 0,
          versionChecks: 0,
          dailyPrepares: 0,
          dailyReconciles: 0,
          dailyRollbacks: 0,
          secretInventories: 0,
          secretMutations: 0,
          secretDeleteCalls: 0,
          deployProofs: 0,
          deployMutations: 0,
          workerReadbacks: 0,
          guideMutations: 0,
          guideReadbacks: 0,
          stagedCleanups: 0,
          journalCleanups: 0,
          clipboardReads: 0,
          promptReads: 0,
          preflights: 0,
        }, `${entry.label}: refusal stopped before every setup boundary`);
        assert.equal(secretPresent, true, `${entry.label}: the old secret remained untouched`);
        assert.equal(clipboardClears, entry.clipboard ? 1 : 0,
          `${entry.label}: clipboard handling matched the selected mode`);
        assert.equal(clipboardPresent, false,
          `${entry.label}: a clipboard replacement did not remain available`);
        assert.deepEqual(treeSnapshot(root), before,
          `${entry.label}: manifest and every possible recovery artifact stayed byte-identical`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("keep-key remains allowed for an existing Claude answer setup", async () => {
  const root = scratchRoot("replacement-keep-control");
  const manifestPath = join(root, "brain.manifest.json");
  const current = fixtureManifest(root);
  current.retrieval = { ...RECOMMENDED_ANSWER_SETUP };
  current.safety.daily_llm_spend_cap_usd = 5;
  writeFileSync(manifestPath, jsonBytes(current), { mode: 0o600 });
  const before = treeSnapshot(root);
  const counters = mutationCounters();

  try {
    const result = await invokeConnect(manifestPath, ["--keep-key"], counters);
    assert.equal(result.preset, "opus-sonnet");
    assert.equal(result.key_written, false);
    assert.equal(counters.journalInspections, 1, "the keep control reached journal absence");
    assert.equal(counters.manifestControls, 1, "the keep control reached ordinary manifest control");
    assert.equal(counters.versionChecks, 1, "the keep control reached version proof");
    assert.equal(counters.secretInventories, 1, "the keep control proved the existing key name");
    assert.equal(counters.workerReadbacks, 1, "the keep control reached the Worker check");
    assert.deepEqual(mutationView(counters), {
      manifestPublications: 0,
      dailyPrepares: 0,
      dailyReconciles: 0,
      dailyRollbacks: 0,
      secretMutations: 0,
      deployMutations: 0,
      guideMutations: 0,
      stagedCleanups: 0,
      journalCleanups: 0,
    });
    assert.deepEqual(treeSnapshot(root), before,
      "keep-key left the manifest and recovery-artifact set unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected first clipboard connect rolls back to the exact built-in original", async () => {
  const root = scratchRoot("first-connect-rejected");
  const manifestPath = join(root, "brain.manifest.json");
  const original = fixtureManifest(root);
  const originalBytes = jsonBytes(original);
  writeFileSync(manifestPath, originalBytes, { mode: 0o600 });
  const counters = mutationCounters();
  let secretPresent = false;
  let putCalls = 0;
  let deleteCalls = 0;
  let clipboardClears = 0;
  let journalCommits = 0;

  try {
    const outcome = await captureOutcome(() => invokeConnect(
      manifestPath,
      ["--from-clipboard"],
      counters,
      {
        readClipboard: async () => ["sk", "ant", "api03", "fixture-first-connect"].join("-"),
        clearClipboard: async () => { clipboardClears += 1; },
        preflight: async () => ({ status: "ok" }),
        listSecretNames: async () => {
          counters.secretInventories += 1;
          return secretPresent ? [ANTHROPIC_SECRET_NAME] : [];
        },
        putSecret: async () => {
          counters.secretMutations += 1;
          putCalls += 1;
          secretPresent = true;
        },
        deleteSecret: async () => {
          counters.secretMutations += 1;
          counters.secretDeleteCalls += 1;
          deleteCalls += 1;
          secretPresent = false;
        },
        checkWorker: async () => {
          counters.workerReadbacks += 1;
          return workerCheck(manifestPath, "key_rejected");
        },
        publicationOptions: {
          platform: "win32",
          rename: (from, to) => {
            if (to === manifestPath) counters.manifestPublications += 1;
            if (to === answerSetupJournalPath(manifestPath)) journalCommits += 1;
            return fs.renameSync(from, to);
          },
          sleep: () => {},
        },
      },
    ));

    assert.equal(outcome.result, null, "the rejected key did not report success");
    assert.match(outcome.error?.message || "", /did not accept this key/iu);
    assert.equal(counters.manifestControls, 1, "the first-connect control reached manifest custody");
    assert.equal(journalCommits, 1, "the first connect committed one recovery journal");
    assert.equal(counters.manifestPublications, 2,
      "the first connect published forward bytes and then the exact rollback bytes");
    assert.equal(counters.workerReadbacks, 1, "the rejected-key decision was reached");
    assert.equal(putCalls, 1, "the first connect wrote one new secret");
    assert.equal(deleteCalls, 1, "rollback deleted only the secret this run wrote");
    assert.equal(counters.secretDeleteCalls, 1, "the delete decision ran exactly once");
    assert.equal(secretPresent, false, "no secret remained after the rejected first connect");
    assert.equal(clipboardClears, 1, "the rejected first-connect clipboard was cleared once");
    assert.equal(readFileSync(manifestPath, "utf8"), originalBytes,
      "rollback restored the true built-in original bytes");
    assert.equal(answerSetupOf(JSON.parse(readFileSync(manifestPath, "utf8"))), "built-in");
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith(".answer-setup")),
      [],
      "completed rollback left no journal, stage, or phase receipt",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real rollback publisher preserves its proved forward domain addition", async () => {
  const root = scratchRoot("forward-domain");
  const manifestPath = join(root, "brain.manifest.json");
  const journalPath = answerSetupJournalPath(manifestPath);
  writeFileSync(manifestPath, jsonBytes(fixtureManifest(root, { domain: false })), { mode: 0o600 });

  const counters = mutationCounters();
  const publications = [];
  let journalCommits = 0;
  let forwardDeploys = 0;
  let rollbackDeploys = 0;
  let domainWrites = 0;
  let provedDomain = null;
  let tick = FIXED_NOW;
  const nativeRename = fs.renameSync;

  const publicationBoundary = (rename, stagedPath, targetPath) => {
    if (targetPath === journalPath) {
      journalCommits += 1;
      return rename(stagedPath, targetPath);
    }
    if (targetPath === manifestPath) {
      const staged = JSON.parse(readFileSync(stagedPath, "utf8"));
      publications.push({
        preset: answerSetupOf(staged),
        domain: staged.brain?.domain ?? null,
        afterForwardDomain: provedDomain !== null,
      });
    }
    return rename(stagedPath, targetPath);
  };

  try {
    const outcome = await withPatchedBuiltins({
      dateNow: () => tick++,
      renameSync: publicationBoundary,
    }, () => captureOutcome(() => invokeConnect(
      manifestPath,
      ["--key-set-in-dashboard"],
      counters,
      {
        deploy: async () => {
          const isForward = forwardDeploys === 0;
          if (isForward) forwardDeploys += 1;
          else rollbackDeploys += 1;
          const deployed = JSON.parse(readFileSync(manifestPath, "utf8"));
          const hadDomain = Boolean(deployed.brain?.domain);
          const domain = await persistWorkersDevDomain(
            manifestPath,
            deployed,
            { id: "fixture-account" },
            deployed.brain.worker_name,
            {
              workersDevSubdomain: "contract-fixture-subdomain",
              verifyWorkersDevCandidate: async () => ({ ok: true }),
            },
          );
          if (!hadDomain) domainWrites += 1;
          provedDomain ??= domain;
        },
        checkWorker: async () => workerCheck(manifestPath, "key_rejected"),
        publicationOptions: {
          platform: "win32",
          rename: (from, to) => publicationBoundary(nativeRename, from, to),
          sleep: () => {},
        },
      },
    )));

    const rollbackPublication = publications.find((entry) =>
      entry.afterForwardDomain && entry.preset === "built-in");
    assert.ok(outcome.error, "the later answer failure was observed");
    assert.equal(journalCommits, 1, "the real journal commit was reached");
    assert.equal(forwardDeploys, 1, "the real forward deployment decision was reached");
    assert.equal(rollbackDeploys, 1, "the real rollback deployment decision was reached");
    assert.ok(domainWrites > 0, "the forward deploy wrote the verified domain");
    assert.ok(rollbackPublication, "the real rollback publication was observed");
    assert.equal(existsSync(journalPath), false,
      "the sealed writer completed its rollback and cleanup path");

    assert.deepEqual({
      rollback_domain: rollbackPublication.domain,
      domain_writes: domainWrites,
    }, {
      rollback_domain: provedDomain,
      domain_writes: 1,
    }, "rollback must preserve the proved domain instead of removing and recreating it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function rollbackSideEffectView(counters) {
  return {
    dailyReconciles: counters.dailyReconciles,
    dailyRollbacks: counters.dailyRollbacks,
    secretMutations: counters.secretMutations,
    secretDeleteCalls: counters.secretDeleteCalls,
    deployProofs: counters.deployProofs,
    deployMutations: counters.deployMutations,
    stagedCleanups: counters.stagedCleanups,
    journalCleanups: counters.journalCleanups,
  };
}

async function rollbackTargetCustodyArm(entry, { allowedDomain }) {
  const root = scratchRoot(`rollback-target-${entry.id}-${allowedDomain ? "control" : "negative"}`);
  const manifestPath = join(root, "brain.manifest.json");
  const journalPath = answerSetupJournalPath(manifestPath);
  const manifest = fixtureManifest(root, { domain: false });
  writeFileSync(manifestPath, jsonBytes(manifest), { mode: 0o600 });

  const counters = mutationCounters();
  const nativeRename = fs.renameSync;
  let targetObservationOpen = false;
  let targetObservations = 0;
  let deployCalls = 0;
  let rollbackPublications = 0;
  let postDeployTree = null;
  let postDeployEffects = null;
  let replacementBytes = null;

  const publicationBoundary = (rename, stagedPath, targetPath) => {
    if (targetPath === manifestPath && targetObservationOpen) rollbackPublications += 1;
    return rename(stagedPath, targetPath);
  };

  try {
    const outcome = await withPatchedBuiltins({
      lstatSync: (inspect, path, ...args) => {
        if (targetObservationOpen && path === manifestPath) targetObservations += 1;
        return inspect(path, ...args);
      },
      renameSync: publicationBoundary,
    }, () => captureOutcome(() => invokeConnect(
      manifestPath,
      ["--key-set-in-dashboard"],
      counters,
      {
        deploy: async (path) => {
          counters.deployMutations += 1;
          deployCalls += 1;
          if (deployCalls !== 1) return;
          if (allowedDomain) {
            const deployed = JSON.parse(readFileSync(path, "utf8"));
            await persistWorkersDevDomain(
              path,
              deployed,
              { id: "fixture-account" },
              deployed.brain.worker_name,
              {
                workersDevSubdomain: `allowed-${entry.id}`,
                verifyWorkersDevCandidate: async () => ({ ok: true }),
              },
            );
          } else {
            replacementBytes = entry.replacement(readFileSync(path));
            const replacementPath = join(root, `replacement-${entry.id}`);
            writeFileSync(replacementPath, replacementBytes, { mode: 0o600, flag: "wx" });
            nativeRename(replacementPath, path);
          }
          postDeployTree = treeSnapshot(root);
          postDeployEffects = rollbackSideEffectView(counters);
          targetObservationOpen = true;
        },
        checkWorker: async () => {
          counters.workerReadbacks += 1;
          return workerCheck(manifestPath, "key_rejected");
        },
        removeRecoveryStagedFile: async (path) => {
          counters.stagedCleanups += 1;
          fs.unlinkSync(path);
        },
        removeJournal: async (path) => {
          counters.journalCleanups += 1;
          fs.unlinkSync(path);
        },
        publicationOptions: {
          platform: "win32",
          rename: (from, to) => publicationBoundary(nativeRename, from, to),
          sleep: () => {},
        },
      },
    )));
    const observationsAtOutcome = targetObservations;
    const finalTree = treeSnapshot(root);

    return {
      outcome,
      counters,
      deployCalls,
      rollbackPublications,
      postDeployTree,
      postDeployEffects,
      finalTree,
      observationsAtOutcome,
      replacementBytes,
      finalManifestBytes: readFileSync(manifestPath),
      journalRetained: existsSync(journalPath),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("same-process rollback requires the last exact target proof before any recovery mutation", async (t) => {
  const cases = [
    {
      id: "unrelated-valid-json",
      replacement(bytes) {
        const value = JSON.parse(bytes.toString("utf8"));
        value.unrelated.concurrent_marker = "replacement";
        return Buffer.from(jsonBytes(value), "utf8");
      },
    },
    {
      id: "malformed-json",
      replacement() { return Buffer.from('{"brain":', "utf8"); },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.id, async () => {
      const negative = await rollbackTargetCustodyArm(entry, { allowedDomain: false });
      const control = await rollbackTargetCustodyArm(entry, { allowedDomain: true });
      assert.ok(negative.outcome.error, `${entry.id}: the contradictory target stopped the command`);
      assert.equal(recoveryErrorCode(negative.outcome.error), "ANTHROPIC_ROLLBACK_INCOMPLETE",
        `${entry.id}: the existing incomplete recovery result was retained`);
      assert.ok(negative.observationsAtOutcome > 0,
        `${entry.id}: the real post-deploy target observation was reached`);
      assert.equal(negative.deployCalls, 1,
        `${entry.id}: no rollback deployment followed the contradictory target`);
      assert.equal(negative.rollbackPublications, 0,
        `${entry.id}: no rollback manifest publication was attempted`);
      assert.deepEqual(rollbackSideEffectView(negative.counters), negative.postDeployEffects,
        `${entry.id}: secret, schedule, deploy, and cleanup effects stopped at observation`);
      assert.deepEqual(negative.finalTree, negative.postDeployTree,
        `${entry.id}: the replacement, journal, and stages stayed byte-and-identity exact`);
      assert.deepEqual(negative.finalManifestBytes, negative.replacementBytes,
        `${entry.id}: the unrelated replacement was not overwritten`);
      assert.equal(negative.journalRetained, true, `${entry.id}: recovery evidence was retained`);

      assert.ok(control.outcome.error, `${entry.id}: the allowed-domain control reached the later answer failure`);
      assert.ok(control.observationsAtOutcome > 0,
        `${entry.id}: the control reached the same target-observation boundary`);
      assert.equal(control.deployCalls, 2,
        `${entry.id}: the control completed forward and rollback deployment`);
      assert.equal(control.rollbackPublications, 1,
        `${entry.id}: the control published exactly one proved rollback`);
      assert.equal(control.journalRetained, false,
        `${entry.id}: the proved control completed evidence cleanup`);
      const controlManifest = JSON.parse(control.finalManifestBytes.toString("utf8"));
      assert.equal(answerSetupOf(controlManifest), "built-in",
        `${entry.id}: the control restored the built-in answer setup`);
      assert.equal(controlManifest.brain.domain,
        `${controlManifest.brain.worker_name}.allowed-${entry.id}.workers.dev`,
        `${entry.id}: the control preserved only the verified forward domain`);
    });
  }
});

async function successfulConnectScheduleArm({ savedDomain }) {
  const root = scratchRoot(savedDomain ? "schedule-control" : "schedule-domain-red");
  const manifestPath = join(root, "brain.manifest.json");
  const manifest = fixtureManifest(root, { domain: savedDomain });
  manifest.infrastructure.cloudflare.account_id = "fixture-account";
  manifest.infrastructure.cloudflare.vectorize_index = "contract-fixture-index";
  manifest.operations = {
    daily_refresh: {
      enabled: true,
      cron: "0 9 * * *",
      timezone: "UTC",
      max_runtime_minutes: 45,
    },
  };
  manifest.corpora = { fixture_source: { enabled: true } };
  writeFileSync(manifestPath, jsonBytes(manifest), { mode: 0o600 });

  const schedulerCounters = {
    scheduleReads: 0,
    scheduleInstalls: 0,
    scheduleEnableWrites: 0,
    scheduleRemovals: 0,
  };
  const scheduler = memoryDailyScheduler(schedulerCounters);
  const dailyOptions = {
    platform: "darwin",
    principal: "uid:501",
    localTimezone: "UTC",
    planLoad: async () => [{
      key: "fixture_source",
      status: "ready",
      daily_class: "machine-pull",
      daily_owner: "daily-task",
      legs: [{ source: "fixture-source" }],
    }],
    existingSchedulerOwners: [],
    schedulerAdapter: scheduler,
    schedulerOptions: {
      home: root,
      nodePath: process.execPath,
    },
  };
  const initialPlan = await buildConfiguredDailyPlan(manifest, manifestPath, dailyOptions);
  const initialRegistration = installDailyRefreshSchedule(initialPlan, {
    platform: "darwin",
    adapter: scheduler,
    home: root,
    nodePath: process.execPath,
  });
  assert.equal(initialRegistration.verified, true,
    "the fixture began with an exact registered daily definition");

  const counters = mutationCounters();
  let domainPersistCalls = 0;
  let domainWrites = 0;
  let scheduledPlanBuilds = 0;
  let lockAssertions = 0;
  let lockReleases = 0;
  let observations = 0;
  let receipts = 0;
  let sourceRuns = 0;
  let freshnessReads = 0;
  try {
    const connect = await captureOutcome(() => invokeConnect(
      manifestPath,
      ["--key-set-in-dashboard"],
      counters,
      {
        prepareDaily: undefined,
        reconcileDaily: undefined,
        dailyRefreshOptions: dailyOptions,
        deploy: async (path) => {
          counters.deployMutations += 1;
          domainPersistCalls += 1;
          const deployed = JSON.parse(readFileSync(path, "utf8"));
          const hadDomain = Boolean(deployed.brain?.domain);
          await persistWorkersDevDomain(
            path,
            deployed,
            { id: "fixture-account" },
            deployed.brain.worker_name,
            {
              workersDevSubdomain: "contract-schedule-fixture",
              verifyWorkersDevCandidate: async () => ({ ok: true }),
            },
          );
          if (!hadDomain) domainWrites += 1;
        },
      },
    ));
    const registeredDefinition = scheduler.current().definition;
    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const finalPlan = await buildConfiguredDailyPlan(finalManifest, manifestPath, dailyOptions);
    const scheduled = await captureOutcome(() => runDailyRefreshCli(manifestPath, {
      platform: "darwin",
      principal: dailyOptions.principal,
      localTimezone: dailyOptions.localTimezone,
      planLoad: dailyOptions.planLoad,
      existingSchedulerOwners: dailyOptions.existingSchedulerOwners,
      expectedDefinitionHash: registeredDefinition.definition_hash,
      schedulerAdapter: scheduler,
      definitionOptions: {
        home: root,
        nodePath: process.execPath,
      },
      brainModule: {
        buildConfiguredDailyPlan: async (...args) => {
          scheduledPlanBuilds += 1;
          return buildConfiguredDailyPlan(...args);
        },
      },
      acquireLock: () => ({
        assertOwned() { lockAssertions += 1; },
        release() { lockReleases += 1; },
      }),
      runSource: async () => {
        sourceRuns += 1;
        return {
          status: "complete",
          loaded: 1,
          entries: [{ key: "fixture_source", status: "loaded" }],
        };
      },
      readFreshness: async () => {
        freshnessReads += 1;
        const after = freshnessReads > 1;
        return {
          "fixture-source": {
            kind: "fixture",
            last_successful_run_at: after
              ? "2026-10-24T12:00:00.000Z"
              : "2026-10-23T12:00:00.000Z",
            latest_run: {
              outcome: "complete",
              docs_added: after ? 1 : 0,
              docs_updated: 0,
              docs_unchanged: 0,
              docs_refused: 0,
              docs_failed: 0,
            },
          },
        };
      },
      writeReceipt: async () => { receipts += 1; },
      readUpdateTransaction: () => null,
      appendObservation: () => { observations += 1; },
      now: () => new Date(FIXED_NOW),
      home: root,
      silent: true,
    }));

    return {
      connect,
      scheduled,
      counters,
      schedulerCounters,
      domainPersistCalls,
      domainWrites,
      scheduledPlanBuilds,
      lockAssertions,
      lockReleases,
      observations,
      receipts,
      sourceRuns,
      freshnessReads,
      registeredManifestHash: registeredDefinition.manifest_content_hash,
      finalManifestHash: finalPlan.manifest_content_hash,
      finalDomain: finalManifest.brain?.domain ?? null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSuccessfulScheduleDecisionPoints(arm, label) {
  assert.equal(arm.connect.error, null, `${label}: connect completed successfully`);
  assert.equal(arm.connect.result?.rolled_back, false, `${label}: connect did not enter rollback`);
  assert.equal(arm.counters.manifestControls, 1,
    `${label}: the real connect manifest control was reached`);
  assert.equal(arm.counters.deployMutations, 1,
    `${label}: the answer setup deploy boundary was reached`);
  assert.equal(arm.domainPersistCalls, 1,
    `${label}: the real domain persistence decision was reached`);
  assert.equal(arm.schedulerCounters.scheduleInstalls, 2,
    `${label}: initial registration and the real answer-edit replacement both installed`);
  assert.ok(arm.schedulerCounters.scheduleReads >= 4,
    `${label}: registration, replacement, and scheduled authorization read back state`);
  assert.equal(arm.scheduledPlanBuilds, 1,
    `${label}: the later run built its plan through the real product planner`);
  assert.equal(arm.observations, 2,
    `${label}: the later real runner recorded start and terminal outcome`);
}

test("a successful no-domain connect leaves the real daily definition bound to the final manifest", async () => {
  const arm = await successfulConnectScheduleArm({ savedDomain: false });
  assertSuccessfulScheduleDecisionPoints(arm, "no-domain red");
  assert.equal(arm.domainWrites, 1, "the successful deploy added the verified domain once");
  assert.ok(arm.finalDomain?.endsWith(".workers.dev"),
    "the real domain writer saved the verified workers.dev hostname");
  assert.equal(arm.registeredManifestHash, arm.finalManifestHash,
    "the registered definition binds the final manifest after the verified domain save");
  assert.equal(arm.scheduled.result?.status, "complete",
    "the real daily source completed after authorization");
  assert.equal(arm.sourceRuns, 1, "the later run reached the scheduled source decision once");
  assert.equal(arm.freshnessReads, 2,
    "the later run read source freshness before and after the scheduled source");
  assert.equal(arm.lockAssertions, 3, "the later run retained the daily lifecycle lock throughout");
  assert.equal(arm.lockReleases, 1, "the later run released the daily lifecycle lock");
  assert.equal(arm.receipts, 2,
    "the later run wrote one source receipt and one terminal daily receipt");

  assert.equal(arm.scheduled.error, null,
    "successful connect must leave daily registration consistent with the final manifest");
});

test("a saved-domain connect control leaves the real daily definition runnable", async () => {
  const arm = await successfulConnectScheduleArm({ savedDomain: true });
  assertSuccessfulScheduleDecisionPoints(arm, "saved-domain control");
  assert.equal(arm.domainWrites, 0, "the control reached domain persistence without another write");
  assert.equal(arm.registeredManifestHash, arm.finalManifestHash,
    "the registered definition binds the final saved-domain manifest");
  assert.equal(arm.scheduled.error, null, "the real scheduled authorization accepted the control");
  assert.equal(arm.scheduled.result?.status, "complete",
    "the real daily source completed after authorization");
  assert.equal(arm.sourceRuns, 1, "the control reached the scheduled source decision once");
  assert.equal(arm.freshnessReads, 2,
    "the control read source freshness before and after the scheduled source");
  assert.equal(arm.lockAssertions, 3, "the control retained the daily lifecycle lock throughout");
  assert.equal(arm.lockReleases, 1, "the control released the daily lifecycle lock");
  assert.equal(arm.receipts, 2,
    "the control wrote one source receipt and one terminal daily receipt");
});

test("an unlocked connect control reaches the same real writer and completes", async () => {
  const root = scratchRoot("unlocked");
  const rollbackRoot = scratchRoot("rollback-control");
  const manifestPath = join(root, "brain.manifest.json");
  const journalPath = answerSetupJournalPath(manifestPath);
  const original = fixtureManifest(root);
  const unrelatedBytes = Buffer.from(JSON.stringify(original.unrelated), "utf8");
  writeFileSync(manifestPath, jsonBytes(original), { mode: 0o600 });

  const counters = mutationCounters();
  let journalInspections = 0;
  let journalCommits = 0;
  let manifestPublications = 0;
  const nativeRename = fs.renameSync;

  const publicationBoundary = (rename, stagedPath, targetPath) => {
    if (targetPath === journalPath) journalCommits += 1;
    if (targetPath === manifestPath) manifestPublications += 1;
    return rename(stagedPath, targetPath);
  };

  try {
    const result = await withPatchedBuiltins({
      lstatSync: (inspect, path, ...args) => {
        if (path === journalPath) journalInspections += 1;
        return inspect(path, ...args);
      },
      renameSync: publicationBoundary,
    }, () => invokeConnect(
      manifestPath,
      ["--key-set-in-dashboard"],
      counters,
      {
        publicationOptions: {
          platform: "win32",
          rename: (from, to) => publicationBoundary(nativeRename, from, to),
          sleep: () => {},
        },
      },
    ));
    const saved = JSON.parse(readFileSync(manifestPath, "utf8"));

    assert.ok(journalInspections > 0, "the absent-journal control reached the connect gate");
    assert.equal(counters.manifestControls, 1, "the control reached manifest credential control");
    assert.equal(journalCommits, 1, "the control committed the real journal once");
    assert.equal(manifestPublications, 1, "the control reached the real manifest rename once");
    assert.equal(counters.deployMutations, 1, "the control reached deploy");
    assert.equal(existsSync(journalPath), false, "the completed journal was removed");
    assert.equal(result.rolled_back, false);
    assert.equal(answerSetupOf(saved), "opus-sonnet");
    assert.deepEqual(Buffer.from(JSON.stringify(saved.unrelated), "utf8"), unrelatedBytes,
      "unrelated manifest values stayed exact");

    const rollbackManifestPath = join(rollbackRoot, "brain.manifest.json");
    const rollbackJournalPath = answerSetupJournalPath(rollbackManifestPath);
    const rollbackDomain = "rollback-control.invalid";
    const rollbackOriginal = fixtureManifest(rollbackRoot);
    rollbackOriginal.brain.domain = rollbackDomain;
    writeFileSync(rollbackManifestPath, jsonBytes(rollbackOriginal), { mode: 0o600 });
    const rollbackCounters = mutationCounters();
    let rollbackPublications = 0;
    let rollbackJournalCommits = 0;
    const rollbackNativeRename = fs.renameSync;
    const rollbackBoundary = (rename, stagedPath, targetPath) => {
      if (targetPath === rollbackJournalPath) rollbackJournalCommits += 1;
      if (targetPath === rollbackManifestPath) {
        const staged = JSON.parse(readFileSync(stagedPath, "utf8"));
        if (answerSetupOf(staged) === "built-in") {
          rollbackPublications += 1;
          assert.equal(staged.brain.domain, rollbackDomain,
            "the domain-present rollback control preserves its domain");
        }
      }
      return rename(stagedPath, targetPath);
    };
    const rollbackOutcome = await withPatchedBuiltins({
      renameSync: rollbackBoundary,
    }, () => captureOutcome(() => invokeConnect(
      rollbackManifestPath,
      ["--key-set-in-dashboard"],
      rollbackCounters,
      {
        checkWorker: async () => workerCheck(rollbackManifestPath, "key_rejected"),
        publicationOptions: {
          platform: "win32",
          rename: (from, to) => rollbackBoundary(rollbackNativeRename, from, to),
          sleep: () => {},
        },
      },
    )));
    assert.ok(rollbackOutcome.error, "the control reached its later answer failure");
    assert.equal(rollbackJournalCommits, 1, "the rollback control committed the real journal");
    assert.equal(rollbackPublications, 1, "the rollback control reached real rollback publication");
    assert.equal(rollbackCounters.deployMutations, 2,
      "the rollback control reached forward and rollback deployment");
    assert.equal(existsSync(rollbackJournalPath), false,
      "the verified rollback control removed its journal");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(rollbackRoot, { recursive: true, force: true });
  }
});
