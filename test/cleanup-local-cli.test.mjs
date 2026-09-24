import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdCleanupLocal, runAutomaticLocalRetentionCleanup } from "../brain.mjs";
import { missingOngoingKeys } from "../operations/local-staging-cleanup.mjs";

test("cleanup-local previews, requires its exact fingerprint, records consumed state, and uses Trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-cli-"));
  const folder = join(root, "stage");
  const file = join(folder, "fixture.txt");
  const trashDestination = join(root, "fixture.trashed.txt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  writeFileSync(file, "synthetic fixture");
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "staging" },
    ] } },
  }));
  const state = { version: 1, done: { "fixture.txt": "a".repeat(64) }, skipped: {} };
  let proofCalls = 0;
  const requestProof = async (_base, _key, body) => {
    proofCalls++;
    assert.equal(body.source, "drop");
    return {
      confirmations: body.candidates.map((candidate) => ({
        source_id: candidate.source_id,
        accepted_resolution_current: true,
        proof: "p".repeat(64),
      })),
    };
  };
  const ingest = await import("../ingest/run.mjs");
  const ingestLib = async () => ({
    ...ingest,
    loadState: () => state,
    saveState: (_path, value) => Object.assign(state, value),
  });
  const common = {
    ingestLib,
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-key",
    requestProof,
  };
  const preview = await cmdCleanupLocal(manifest, { ...common, flags: { json: true } });
  assert.equal(preview.only_copies, 1);
  assert.equal(proofCalls, 1, "the authoritative proof decision point was reached");

  let trashCalls = 0;
  await assert.rejects(() => cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: "0".repeat(64), "only-copy": "remove" },
    trash: async (path) => { trashCalls++; renameSync(path, trashDestination); },
  }), /exact preview fingerprint/);
  assert.equal(proofCalls, 2, "the refused invocation reached its own authoritative proof decision");
  assert.equal(trashCalls, 0);
  assert.equal(state.consumed, undefined, "a refused approval cannot mark anything consumed");

  const receipt = await cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: preview.plan_id, "only-copy": "remove" },
    trash: async (path) => { trashCalls++; renameSync(path, trashDestination); },
  });
  assert.equal(receipt.moved_to_trash, 1);
  assert.equal(trashCalls, 1);
  assert.equal(state.consumed["fixture.txt"].proof, "p".repeat(64));
});

async function previewWithRoots({ ongoing, staging }) {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-roots-"));
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: ongoing, source: "library", role: "ongoing" },
      { path: staging, source: "drop", role: "staging" },
    ] } },
  }));
  const proofSources = [];
  const result = await cmdCleanupLocal(manifest, {
    flags: { json: true },
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-key",
    requestProof: async (_base, _key, body) => {
      proofSources.push(body.source);
      return { confirmations: body.candidates.map((candidate) => ({
        source_id: candidate.source_id,
        accepted_resolution_current: true,
        proof: "p".repeat(64),
      })) };
    },
  });
  return { result, proofSources };
}

test("a nested ongoing root cannot prove that a staging file has another copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-nested-"));
  const staging = join(root, "stage");
  mkdirSync(staging);
  writeFileSync(join(staging, "only.txt"), "one physical file");
  const { result, proofSources } = await previewWithRoots({ ongoing: root, staging });
  assert.equal(result.copies, 0);
  assert.equal(result.only_copies, 1);
  assert.deepEqual(proofSources, ["drop"], "the CLI requested Brain proof only for the staging declaration");
});

test("the same declared root cannot prove that a staging file is its own copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-same-root-"));
  writeFileSync(join(root, "only.txt"), "one physical file");
  const { result, proofSources } = await previewWithRoots({ ongoing: root, staging: root });
  assert.equal(result.copies, 0);
  assert.equal(result.only_copies, 1);
  assert.deepEqual(proofSources, ["drop"], "the ongoing declaration never enters the proof request");
});

test("a distinct external copy that disappears during apply prevents any Trash call", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-external-"));
  const ongoing = join(root, "library");
  const staging = join(root, "stage");
  mkdirSync(ongoing);
  mkdirSync(staging);
  const external = join(ongoing, "original.txt");
  writeFileSync(external, "matching bytes");
  writeFileSync(join(staging, "copy.txt"), "matching bytes");
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: ongoing, source: "library", role: "ongoing" },
      { path: staging, source: "drop", role: "staging" },
    ] } },
  }));
  let removeDuringProof = false;
  const common = {
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-key",
    sourceIngestLockOptions: { home: root },
    requestProof: async (_base, _key, body) => {
      if (removeDuringProof) rmSync(external);
      return { confirmations: body.candidates.map((candidate) => ({
        source_id: candidate.source_id,
        accepted_resolution_current: true,
        proof: "p".repeat(64),
      })) };
    },
  };
  const preview = await cmdCleanupLocal(manifest, { ...common, flags: { json: true } });
  assert.equal(preview.copies, 1, "the preview first proves one distinct external file");
  removeDuringProof = true;
  let trashCalls = 0;
  await assert.rejects(() => cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: preview.plan_id },
    trash: async () => { trashCalls++; },
  }), /external copy.*no longer|only copy|outside-copy custody/i);
  assert.equal(trashCalls, 0);
});

test("cleanup preview counts inspected files that lack current proof and limits its safety claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-unconfirmed-"));
  const folder = join(root, "stage");
  mkdirSync(folder);
  writeFileSync(join(folder, "unconfirmed.txt"), "not confirmed");
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "staging" },
    ] } },
  }));
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  let summary;
  let proofCalls = 0;
  try {
    summary = await cmdCleanupLocal(manifest, {
      flags: {},
      resolveBaseUrl: async () => "https://brain.example.invalid",
      resolveAdminKey: () => "fixture-key",
      requestProof: async (_base, _key, body) => {
        proofCalls++;
        return { confirmations: body.candidates.map((candidate) => ({
          source_id: candidate.source_id,
          accepted_resolution_current: false,
          proof: null,
        })) };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(proofCalls, 1, "the authoritative refusal decision was reached");
  assert.deepEqual({
    inspected: summary.inspected_files,
    eligible: summary.eligible_files,
    ineligible: summary.ineligible_files,
  }, { inspected: 1, eligible: 0, ineligible: 1 });
  const text = lines.join("\n");
  assert.match(text, /1 inspected file\(s\).*lack current proof|1 file\(s\).*not currently proved/i);
  assert.doesNotMatch(text, /^Your files are safely in your Brain/m);
});

async function cleanupFailureFixture({ failAt }) {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-state-"));
  const folder = join(root, "stage");
  mkdirSync(folder);
  for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(folder, name), name);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "staging" },
    ] } },
  }));
  const state = { version: 1, done: { "a.txt": "a", "b.txt": "b", "c.txt": "c" }, skipped: {} };
  const ingest = await import("../ingest/run.mjs");
  const common = {
    ingestLib: async () => ({
      ...ingest,
      loadState: () => state,
      saveState: (_path, value) => Object.assign(state, value),
    }),
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-key",
    sourceIngestLockOptions: { home: root },
    requestProof: async (_base, _key, body) => ({ confirmations: body.candidates.map((candidate) => ({
      source_id: candidate.source_id,
      accepted_resolution_current: true,
      proof: "p".repeat(64),
    })) }),
  };
  const preview = await cmdCleanupLocal(manifest, { ...common, flags: { json: true } });
  const trashRoot = join(root, "trash");
  mkdirSync(trashRoot);
  let trashCalls = 0;
  await assert.rejects(() => cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: preview.plan_id, "only-copy": "remove" },
    trash: async (path) => {
      trashCalls++;
      if (trashCalls === failAt) throw new Error("fixture Trash unavailable");
      renameSync(path, join(trashRoot, `${trashCalls}-${path.split("/").at(-1)}`));
    },
  }), /fixture Trash unavailable/);
  return { folder, state, trashCalls, trashRoot };
}

test("a first-file Trash failure leaves every untouched key visible to missing-file decisions", async () => {
  const { folder, state, trashCalls, trashRoot } = await cleanupFailureFixture({ failAt: 1 });
  assert.equal(trashCalls, 1, "the Trash decision point was reached");
  assert.deepEqual(Object.keys(state.consumed || {}), []);
  const presentKeys = new Set(readdirSync(folder));
  assert.deepEqual(missingOngoingKeys({
    knownKeys: Object.keys(state.done), presentKeys, role: "staging", consumed: state.consumed,
  }), []);
  assert.deepEqual(readdirSync(trashRoot), []);
});

test("a mid-plan Trash failure consumes only the file already moved", async () => {
  const { folder, state, trashCalls, trashRoot } = await cleanupFailureFixture({ failAt: 2 });
  assert.equal(trashCalls, 2, "execution reached the second Trash decision point");
  assert.deepEqual(Object.keys(state.consumed || {}), ["a.txt"]);
  assert.equal(existsSync(join(folder, "a.txt")), false);
  assert.deepEqual(readdirSync(trashRoot), ["1-a.txt"]);
  const presentKeys = new Set(readdirSync(folder));
  assert.deepEqual(missingOngoingKeys({
    knownKeys: Object.keys(state.done), presentKeys, role: "staging", consumed: state.consumed,
  }), []);
});

test("cleanup reuses only the exact source lease already held by ingest", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-held-lease-"));
  const folder = join(root, "stage");
  const trashRoot = join(root, "trash");
  mkdirSync(folder);
  mkdirSync(trashRoot);
  const agedPath = join(folder, "aged.txt");
  writeFileSync(agedPath, "aged fixture");
  const agedSeconds = (Date.now() - 2 * 86_400_000) / 1000;
  utimesSync(agedPath, agedSeconds, agedSeconds);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "staging", retention_days: 1 },
    ] } },
  }));
  const state = { version: 1, done: { "aged.txt": "a" }, skipped: {} };
  const ingest = await import("../ingest/run.mjs");
  let innerLeaseCalls = 0;
  let ownedChecks = 0;
  let proofCalls = 0;
  let trashCalls = 0;
  const receipt = await runAutomaticLocalRetentionCleanup({
    manifestPath: manifest,
    sourceName: "drop",
    sourceDeclaration: { role: "staging", retention_days: 1, only_copy_action: "remove" },
    assertLockOwned: () => { ownedChecks++; return true; },
    options: {
      withSourceIngestLock: async () => {
        innerLeaseCalls++;
        throw new Error("non-reentrant lease was reacquired");
      },
      ingestLib: async () => ({
        ...ingest,
        loadState: () => state,
        saveState: (_path, value) => Object.assign(state, value),
      }),
      resolveBaseUrl: async () => "https://brain.example.invalid",
      resolveAdminKey: () => "fixture-key",
      requestProof: async (_base, _key, body) => {
        proofCalls++;
        return { confirmations: body.candidates.map((candidate) => ({
          source_id: candidate.source_id,
          accepted_resolution_current: true,
          proof: "p".repeat(64),
        })) };
      },
      trash: async (path) => {
        trashCalls++;
        renameSync(path, join(trashRoot, "aged.txt"));
      },
      now: () => "2026-09-24T12:00:00.000Z",
    },
  });
  assert.equal(innerLeaseCalls, 0, "the non-reentrant source lease was not reacquired");
  assert.ok(ownedChecks >= 2, "the reused lease guarded state writes");
  assert.equal(proofCalls, 1, "automatic retention reached current Brain proof");
  assert.equal(trashCalls, 1, "automatic retention reached the Trash decision");
  assert.equal(receipt.moved_to_trash, 1);
  assert.equal(state.consumed["aged.txt"].proof, "p".repeat(64));
  assert.equal(existsSync(join(root, ".brain-cleanup-receipts.jsonl")), true);
});

test("automatic retention keep proves eligibility, writes a receipt, and preserves the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-retention-keep-"));
  const folder = join(root, "stage");
  mkdirSync(folder);
  const file = join(folder, "aged.txt");
  writeFileSync(file, "aged fixture");
  const agedSeconds = (Date.now() - 2 * 86_400_000) / 1000;
  utimesSync(file, agedSeconds, agedSeconds);
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "staging", retention_days: 1, only_copy_action: "keep" },
    ] } },
  }));
  const state = { version: 1, done: { "aged.txt": "a" }, skipped: {} };
  const ingest = await import("../ingest/run.mjs");
  let proofCalls = 0;
  let trashCalls = 0;
  let ownedChecks = 0;
  const receipt = await runAutomaticLocalRetentionCleanup({
    manifestPath: manifest,
    sourceName: "drop",
    sourceDeclaration: { role: "staging", retention_days: 1, only_copy_action: "keep" },
    assertLockOwned: () => { ownedChecks++; return true; },
    options: {
      withSourceIngestLock: async () => { throw new Error("same-source lease was reacquired"); },
      ingestLib: async () => ({
        ...ingest,
        loadState: () => state,
        saveState: (_path, value) => Object.assign(state, value),
      }),
      resolveBaseUrl: async () => "https://brain.example.invalid",
      resolveAdminKey: () => "fixture-key",
      requestProof: async (_base, _key, body) => {
        proofCalls++;
        return { confirmations: body.candidates.map((candidate) => ({
          source_id: candidate.source_id,
          accepted_resolution_current: true,
          proof: "p".repeat(64),
        })) };
      },
      trash: async () => { trashCalls++; },
      now: () => "2026-09-24T12:00:00.000Z",
    },
  });
  assert.equal(proofCalls, 1, "keep reached current Brain proof");
  assert.equal(ownedChecks, 1, "the already-held source lease was checked");
  assert.equal(trashCalls, 0);
  assert.equal(receipt.kept, 1);
  assert.equal(receipt.moved_to_trash, 0);
  assert.equal(existsSync(file), true);
  assert.equal(state.consumed, undefined);
  assert.equal(existsSync(join(root, ".brain-cleanup-receipts.jsonl")), true);
});

test("automatic retention refuses archive before proof or mutation", async () => {
  let cleanupCalls = 0;
  await assert.rejects(() => runAutomaticLocalRetentionCleanup({
    manifestPath: "/fixture/brain.manifest.json",
    sourceName: "drop",
    sourceDeclaration: { role: "staging", retention_days: 1, only_copy_action: "archive" },
    assertLockOwned: () => true,
    options: { cleanupLocal: async () => { cleanupCalls++; } },
  }), /cannot archive.*encrypted destination/i);
  assert.equal(cleanupCalls, 0, "the archive policy decision stopped before proof or mutation");
});

test("apply holds the source-ingest lease across proof, state writes, and Trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-lock-"));
  const folder = join(root, "stage");
  const trashRoot = join(root, "trash");
  mkdirSync(folder);
  mkdirSync(trashRoot);
  writeFileSync(join(folder, "a.txt"), "fixture");
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "staging" },
    ] } },
  }));
  const state = { version: 1, done: { "a.txt": "a" }, skipped: {} };
  const ingest = await import("../ingest/run.mjs");
  let held = false;
  let lockCalls = 0;
  let applyPhase = false;
  const common = {
    ingestLib: async () => ({
      ...ingest,
      loadState: () => state,
      saveState: (_path, value) => {
        assert.equal(held, true, "state writes stay inside the source lease");
        Object.assign(state, value);
      },
    }),
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-key",
    requestProof: async (_base, _key, body) => {
      if (applyPhase) assert.equal(held, true, "the current Brain proof stays inside the source lease");
      return { confirmations: body.candidates.map((candidate) => ({
        source_id: candidate.source_id,
        accepted_resolution_current: true,
        proof: "p".repeat(64),
      })) };
    },
    withSourceIngestLock: async (_options, task) => {
      lockCalls++;
      held = true;
      try {
        return await task({ assertOwned: () => {
          assert.equal(held, true);
          return true;
        } });
      } finally {
        held = false;
      }
    },
  };
  const preview = await cmdCleanupLocal(manifest, { ...common, flags: { json: true } });
  assert.equal(lockCalls, 0, "read-only preview takes no writer lease");
  applyPhase = true;
  await cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: preview.plan_id, "only-copy": "remove" },
    cleanupLease: {
      source: "other",
      assertOwned: () => assert.fail("a different source lease cannot authorize cleanup"),
    },
    trash: async (path) => {
      assert.equal(held, true, "Trash stays inside the source lease");
      renameSync(path, join(trashRoot, "a.txt"));
    },
  });
  assert.equal(lockCalls, 1, "apply takes exactly one lease when the offered lease belongs to another source");
});

test("one-time retirement refuses a current file that has not been confirmed in the Brain", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-retire-cli-"));
  const folder = join(root, "stage");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  writeFileSync(join(folder, "new.txt"), "not loaded");
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { upload: { enabled: true, folders: [
      { path: folder, source: "drop", role: "one-time-import" },
    ] } },
  }));
  let proofCalls = 0;
  await assert.rejects(() => cmdCleanupLocal(manifest, {
    flags: { source: "drop", retire: "drop" },
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-key",
    requestProof: async (_base, _key, body) => {
      proofCalls++;
      return { confirmations: body.candidates.map((candidate) => ({
        source_id: candidate.source_id,
        accepted_resolution_current: false,
        proof: null,
      })) };
    },
  }), /1 current file\(s\) are not confirmed/);
  assert.equal(proofCalls, 1, "retirement reached the authoritative proof decision");
});
