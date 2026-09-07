/**
 * The vector-drain cutover must never report success it did not earn.
 *
 * Field run A: the writer-state probe threw UND_ERR_CONNECT_TIMEOUT, the
 * cutover bailed on the FIRST error, printed the ordinary success line, and
 * returned `proven: false` into three call sites that all ignored it. The
 * setup path then told `migrate` the drain was quiesced with a hardcoded
 * literal. One hundred accepted-but-unconfirmed batches were migrated under a
 * claim nothing had checked.
 *
 * These tests pin the three halves of that fix: a bounded retry across the
 * remaining window, an unmistakable "NOT verified" report instead of the
 * success line, and call sites that carry the real proof value forward.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
  cmdSetup,
  waitForVectorDrainCutover,
} from "../brain.mjs";

/**
 * A single blip must not end the check, and the retries have to be bounded.
 * Deliberately a floor rather than the exported constant, so the contract this
 * pins is "retried several times across the window", not one specific number.
 */
const MIN_PROBE_ATTEMPTS = 4;

/** Run `action` with console.log captured, ANSI stripped. */
async function captured(action) {
  const lines = [];
  const priorLog = console.log;
  console.log = (...values) => lines.push(values.map(String).join(" "));
  try {
    const result = await action();
    return { result, rendered: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "") };
  } finally {
    console.log = priorLog;
  }
}

/* ---- a probe that never reads must not print the success line ---- */
{
  let clock = 0;
  let probeCalls = 0;
  const { result, rendered } = await captured(() =>
    waitForVectorDrainCutover(async (ms) => { clock += ms; }, {
      probe: async () => {
        probeCalls += 1;
        throw new Error("fetch failed: UND_ERR_CONNECT_TIMEOUT connecting to the database endpoint");
      },
      now: () => clock,
    }));

  assert.doesNotMatch(
    rendered,
    /safety pause complete/i,
    `the success line was printed after proving nothing:\n${rendered}`,
  );
  assert.match(
    rendered,
    /NOT verified/,
    `the unverified state was not reported:\n${rendered}`,
  );

  // The probe is retried across the window rather than abandoned on the first
  // blip, and the error text survives whole instead of being cut mid-word.
  assert.ok(
    probeCalls >= MIN_PROBE_ATTEMPTS,
    `a single network blip ended the check: ${probeCalls} probe call(s)`,
  );
  assert.match(
    rendered,
    /UND_ERR_CONNECT_TIMEOUT connecting to the database endpoint/,
    `the probe failure was truncated mid-word:\n${rendered}`,
  );

  assert.equal(result.proven, false, JSON.stringify(result));
  assert.equal(result.reason, "probe-unreadable", JSON.stringify(result));
  assert.equal(
    result.waitedMs,
    VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
    `an unreadable probe still serves the full grace: ${JSON.stringify(result)}`,
  );
}

/* ---- a blip that clears still proves quiescence ---- */
{
  let clock = 0;
  const readings = [
    () => { throw new Error("fetch failed"); },
    () => { throw new Error("fetch failed"); },
    () => ({ leaseFree: true, inFlight: 0 }),
    () => ({ leaseFree: true, inFlight: 0 }),
  ];
  const { result, rendered } = await captured(() =>
    waitForVectorDrainCutover(async (ms) => { clock += ms; }, {
      probe: async () => (readings.shift() ?? (() => ({ leaseFree: true, inFlight: 0 })))(),
      now: () => clock,
      pollMs: 15_000,
    }));

  assert.equal(result.proven, true, JSON.stringify(result));
  assert.equal(result.reason, "verified-quiet", JSON.stringify(result));
  assert.ok(
    result.waitedMs < VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
    `two blips must not cost the full grace: ${JSON.stringify(result)}`,
  );
  assert.doesNotMatch(rendered, /NOT verified/, rendered);
}

/* ---- the existing quiet path is untouched ---- */
{
  let clock = 0;
  const { result } = await captured(() =>
    waitForVectorDrainCutover(async (ms) => { clock += ms; }, {
      probe: async () => ({ leaseFree: true, inFlight: 0 }),
      now: () => clock,
      pollMs: 15_000,
    }));
  assert.equal(result.proven, true, JSON.stringify(result));
  assert.equal(result.waitedMs, 15_000, JSON.stringify(result));
}

/* ---- the setup cutover hands migrate the real proof value ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-cutover-setup-"));
  try {
    const account = { id: "c".repeat(32), name: "Owner account" };
    const target = join(sandbox, "Financial Brain", "brain.manifest.json");
    const key = `fixture-${"k".repeat(40)}`;
    const installedManifestOptions = {
      home: sandbox,
      stateDirectory: join(sandbox, "installed-state"),
    };
    const prompt = async (question, fallback) => {
      if (/what is this brain for/i.test(question)) return "Cutover Brain";
      if (/short name/i.test(question)) return "cutover-brain";
      if (/folder to load/i.test(question)) return "";
      return fallback || "";
    };

    const migrateOptions = [];
    await captured(() => cmdSetup(target, {
      ask: prompt,
      doctorRunAll: async () => [],
      listCloudflareAccounts: async () => [account],
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      setupWorkerScriptExists: async () => true,
      probeExistingWorkerHealth: async () => null,
      captureSetupD1Bookmark: async () => "setup-bookmark",
      waitForVectorDrainQuiescence: async () => {},
      cmdVerify: async () => {},
      // Everything the manifest needs is written BEFORE setup pins it. A pinned
      // stage that edits the manifest is a different failure, not this one.
      cmdProvision: async (path) => {
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.infrastructure.cloudflare.d1_database_id = "fixture-d1";
        value.brain.domain = "cutover-brain.owner-subdomain.workers.dev";
        writeFileSync(path, JSON.stringify(value));
      },
      cmdMigrate: async (_path, options = {}) => { migrateOptions.push(options); },
      cmdDeploy: async () => {},
      cmdSecrets: async () => {},
      cmdDrain: async () => {},
      cmdHealth: async () => {},
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }));

    assert.equal(migrateOptions.length, 1, JSON.stringify(migrateOptions));
    assert.equal(
      migrateOptions[0].vectorDrainQuiesced,
      false,
      `setup claimed a quiescence it never verified: ${JSON.stringify(migrateOptions[0])}`,
    );
    assert.notEqual(
      migrateOptions[0].vectorDrainQuiesced,
      true,
      JSON.stringify(migrateOptions[0]),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log("PASS vector-drain cutover reports and carries an unverified quiescence");
