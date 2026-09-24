import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdCleanupLocal } from "../brain.mjs";
import { missingOngoingKeys } from "../operations/local-staging-cleanup.mjs";

test("cleanup-local previews, requires its exact fingerprint, records consumed state, and uses Trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-cli-"));
  const folder = join(root, "stage");
  const file = join(folder, "fixture.txt");
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
    trash: async () => { trashCalls++; },
  }), /exact preview fingerprint/);
  assert.equal(proofCalls, 2, "the refused invocation reached its own authoritative proof decision");
  assert.equal(trashCalls, 0);
  assert.equal(state.consumed, undefined, "a refused approval cannot mark anything consumed");

  const receipt = await cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: preview.plan_id, "only-copy": "remove" },
    trash: async () => { trashCalls++; },
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
  }), /external copy.*no longer|only copy/i);
  assert.equal(trashCalls, 0);
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
  let trashCalls = 0;
  await assert.rejects(() => cmdCleanupLocal(manifest, {
    ...common,
    flags: { apply: true, approve: preview.plan_id, "only-copy": "remove" },
    trash: async () => {
      trashCalls++;
      if (trashCalls === failAt) throw new Error("fixture Trash unavailable");
    },
  }), /fixture Trash unavailable/);
  return { state, trashCalls };
}

test("a first-file Trash failure leaves every untouched key visible to missing-file decisions", async () => {
  const { state, trashCalls } = await cleanupFailureFixture({ failAt: 1 });
  assert.equal(trashCalls, 1, "the Trash decision point was reached");
  assert.deepEqual(Object.keys(state.consumed || {}), []);
  assert.deepEqual(missingOngoingKeys({
    knownKeys: Object.keys(state.done), presentKeys: [], role: "staging", consumed: state.consumed,
  }), ["a.txt", "b.txt", "c.txt"]);
});

test("a mid-plan Trash failure consumes only the file already moved", async () => {
  const { state, trashCalls } = await cleanupFailureFixture({ failAt: 2 });
  assert.equal(trashCalls, 2, "execution reached the second Trash decision point");
  assert.deepEqual(Object.keys(state.consumed || {}), ["a.txt"]);
  assert.deepEqual(missingOngoingKeys({
    knownKeys: Object.keys(state.done), presentKeys: [], role: "staging", consumed: state.consumed,
  }), ["b.txt", "c.txt"]);
});

test("apply holds the source-ingest lease across proof, state writes, and Trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cleanup-lock-"));
  const folder = join(root, "stage");
  mkdirSync(folder);
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
    trash: async () => { assert.equal(held, true, "Trash stays inside the source lease"); },
  });
  assert.equal(lockCalls, 1, "apply takes exactly one lease for the source");
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
