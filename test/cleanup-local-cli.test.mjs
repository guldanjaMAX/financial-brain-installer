import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdCleanupLocal } from "../brain.mjs";

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
