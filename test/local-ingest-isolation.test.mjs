import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdIngestLocal } from "../brain.mjs";
import {
  batchStream,
  removedSinceLastRun,
  splitOversized,
} from "../ingest/run.mjs";

test("one unexpected file preparation error is recorded while neighboring files load", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-local-isolation-"));
  const sourceRoot = join(root, "source");
  const manifestPath = join(root, "brain.manifest.json");
  mkdirSync(sourceRoot);
  writeFileSync(manifestPath, JSON.stringify({ brain: { domain: "brain.example.invalid" } }));

  const files = ["good-before.txt", "throws.txt", "refused.txt", "good-after.txt"]
    .map((rel) => ({ name: rel, rel }));
  const savedStates = [];
  const receipts = [];
  const sent = [];
  const reconciled = [];
  const output = [];
  const priorLog = console.log;
  console.log = (...parts) => output.push(parts.join(" "));

  try {
    const result = cmdIngestLocal(
      { brain: { domain: "brain.example.invalid" }, safety: { credential_scanner: { enabled: true } } },
      manifestPath,
      { path: sourceRoot, source: "upload" },
      {
        withSourceIngestLock: async (_lock, run) => run({ assertOwned: () => true }),
        resolveBaseUrl: async () => "https://brain.example.invalid",
        resolveAdminKey: () => "fixture-owner-proof",
        ingestLib: async () => ({
          walk: () => ({ files, skipped: [], complete: true }),
          prepare: async (file) => {
            if (file.rel === "throws.txt") throw new Error("synthetic extractor failure");
            const credential = ["sk", "a".repeat(32)].join("-");
            return {
              hash: `hash-${file.rel}`,
              envelope: {
                source_type: "upload",
                source_id: file.rel,
                title: file.rel,
                content: file.rel === "refused.txt"
                  ? `This fixture carries ${credential}`
                  : `Readable synthetic content for ${file.rel}`,
              },
            };
          },
          batchStream,
          splitOversized,
          loadState: () => ({ version: 1, done: {}, skipped: {} }),
          saveState: (_path, state) => savedStates.push(structuredClone(state)),
          removedSinceLastRun,
        }),
        postSourceReceipt: async (_base, _key, receipt) => {
          receipts.push(structuredClone(receipt));
          return receipt;
        },
        sendBatches: async ({ groups, onResult }) => {
          const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
          for (const item of groups.flat()) {
            sent.push(item.envelope.source_id);
            tally.created++;
            onResult?.(item, { source_id: item.envelope.source_id, status: "created" });
          }
          return tally;
        },
        reconcileDocumentFamilies: async ({ families }) => {
          reconciled.push(...families);
          return { reconciled: families.length };
        },
        listStoredSourceFamilies: async () => new Set(),
      },
    );

    await assert.rejects(
      result,
      /1 file failed, so this ingest is incomplete/,
    );
    assert.deepEqual(sent, ["good-before.txt", "good-after.txt"]);
    assert.equal(reconciled.length, 2);
    assert.equal(receipts.at(-1)?.status, "error");
    assert.equal(receipts.at(-1)?.docs_failed, 1);
    assert.equal(receipts.at(-1)?.docs_refused, 1);
    assert.match(receipts.at(-1)?.detail || "", /completed with document failures/);
    assert.equal(savedStates.at(-1)?.skipped?.["throws.txt"],
      "file preparation failed unexpectedly; it was left for retry");
    assert.match(savedStates.at(-1)?.skipped?.["refused.txt"] || "", /^refused: carries /);
    assert.match(output.join("\n"), /file preparation failed unexpectedly; it was left for retry/);
    assert.match(output.join("\n"), /e\.g\. throws\.txt/);
    assert.match(output.join("\n"), /2 created, 0 updated, 0 unchanged, 1 failed/);
  } finally {
    console.log = priorLog;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, preparationError] of [
  ["OCR spend-cap refusal", Object.assign(new Error("synthetic OCR cap"), {
    fatal: true,
    llm_cap_exceeded: true,
  })],
  ["extractor-system failure", Object.assign(new Error("synthetic extractor unavailable"), {
    name: "ExtractorSystemError",
    fatal: true,
  })],
  ["local identity refusal", Object.assign(new Error("synthetic identity change"), {
    name: "LocalFileSafetyError",
    code: "LOCAL_FILE_IDENTITY_CHANGED",
  })],
  ["local hard-link refusal", Object.assign(new Error("synthetic link refusal"), {
    name: "LocalFileSafetyError",
    code: "LOCAL_FILE_LINK_REFUSED",
  })],
  ["local post-walk change refusal", Object.assign(new Error("synthetic post-walk change"), {
    name: "LocalFileSafetyError",
    code: "LOCAL_FILE_CHANGED_DURING_READ",
  })],
  ["OCR transport failure", Object.assign(new Error("synthetic OCR transport"), {
    fatal: true,
  })],
]) {
  test(`${label} stops the local command before later mutation paths`, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-local-systemic-"));
    const sourceRoot = join(root, "source");
    const manifestPath = join(root, "brain.manifest.json");
    mkdirSync(sourceRoot);
    writeFileSync(manifestPath, JSON.stringify({ brain: { domain: "brain.example.invalid" } }));

    const calls = {
      prepare: [],
      laterOcr: 0,
      send: 0,
      reconcile: 0,
      inventory: 0,
    };
    try {
      await assert.rejects(
        cmdIngestLocal(
          { brain: { domain: "brain.example.invalid" }, safety: { credential_scanner: { enabled: true } } },
          manifestPath,
          { path: sourceRoot, source: "upload" },
          {
            withSourceIngestLock: async (_lock, run) => run({ assertOwned: () => true }),
            resolveBaseUrl: async () => "https://brain.example.invalid",
            resolveAdminKey: () => "fixture-owner-proof",
            ingestLib: async () => ({
              walk: () => ({
                files: ["blocked.txt", "later.txt"].map((rel) => ({ name: rel, rel })),
                skipped: [],
                complete: true,
              }),
              prepare: async (file) => {
                calls.prepare.push(file.rel);
                if (file.rel === "blocked.txt") throw preparationError;
                calls.laterOcr++;
                return {
                  hash: "later-hash",
                  envelope: {
                    source_type: "upload",
                    source_id: file.rel,
                    title: file.rel,
                    content: "Readable synthetic later content",
                  },
                };
              },
              batchStream,
              splitOversized,
              loadState: () => ({ version: 1, done: {}, skipped: {} }),
              saveState: () => {},
              removedSinceLastRun,
            }),
            postSourceReceipt: async (_base, _key, receipt) => receipt,
            sendBatches: async () => {
              calls.send++;
              return { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
            },
            reconcileDocumentFamilies: async () => {
              calls.reconcile++;
              return { reconciled: 0 };
            },
            listStoredSourceFamilies: async () => {
              calls.inventory++;
              return new Set();
            },
          },
        ),
        (error) => error === preparationError,
      );
      assert.deepEqual(calls.prepare, ["blocked.txt"]);
      assert.equal(calls.laterOcr, 0);
      assert.equal(calls.send, 0);
      assert.equal(calls.reconcile, 0);
      assert.equal(calls.inventory, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("an isolated preparation failure keeps the credential-scanner upgrade unfinished, so the next run rechecks that file", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-local-scanner-fence-"));
  const sourceRoot = join(root, "source");
  const manifestPath = join(root, "brain.manifest.json");
  mkdirSync(sourceRoot);
  writeFileSync(manifestPath, JSON.stringify({ brain: { domain: "brain.example.invalid" } }));

  const files = ["kept.txt", "flaky.txt"].map((rel) => ({ name: rel, rel }));
  const credential = ["sk", "b".repeat(32)].join("-");
  // Both files were indexed under an earlier scanner; the stored fingerprint is stale.
  let persisted = {
    version: 1,
    done: { "kept.txt": "hash-kept.txt", "flaky.txt": "hash-flaky.txt" },
    skipped: {},
    credential_scanner_fingerprint: "pre-upgrade-fingerprint",
  };
  let run = 0;
  const prepared = [];
  const priorLog = console.log;
  console.log = () => {};

  const deps = () => ({
    withSourceIngestLock: async (_lock, fn) => fn({ assertOwned: () => true }),
    resolveBaseUrl: async () => "https://brain.example.invalid",
    resolveAdminKey: () => "fixture-owner-proof",
    ingestLib: async () => ({
      walk: () => ({ files, skipped: [], complete: true }),
      prepare: async (file) => {
        prepared.push(`${run}:${file.rel}`);
        if (run === 1 && file.rel === "flaky.txt") throw new Error("synthetic one-off parser failure");
        return {
          hash: `hash-${file.rel}`,
          envelope: {
            source_type: "upload",
            source_id: file.rel,
            title: file.rel,
            // The unchanged revision indexed under the old scanner carries a credential.
            content: file.rel === "flaky.txt" ? `Old revision carries ${credential}` : "Readable synthetic content",
          },
        };
      },
      batchStream,
      splitOversized,
      loadState: () => structuredClone(persisted),
      saveState: (_path, state) => { persisted = structuredClone(state); },
      removedSinceLastRun,
    }),
    postSourceReceipt: async (_base, _key, receipt) => receipt,
    sendBatches: async ({ groups, onResult }) => {
      const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
      for (const item of groups.flat()) {
        tally.unchanged++;
        onResult?.(item, { source_id: item.envelope.source_id, status: "unchanged" });
      }
      return tally;
    },
    reconcileDocumentFamilies: async ({ families }) => ({ reconciled: families.length }),
    listStoredSourceFamilies: async () => new Set(),
  });
  const manifest = { brain: { domain: "brain.example.invalid" }, safety: { credential_scanner: { enabled: true } } };

  try {
    run = 1;
    await assert.rejects(
      cmdIngestLocal(manifest, manifestPath, { path: sourceRoot, source: "upload" }, deps()),
      /1 file failed, so this ingest is incomplete/,
    );
    // Decision point reached: the failure was isolated and recorded ...
    assert.ok(prepared.includes("1:flaky.txt"));
    assert.equal(persisted.skipped["flaky.txt"], "file preparation failed unexpectedly; it was left for retry");
    // ... and the scanner upgrade was NOT marked complete.
    assert.equal(persisted.credential_scanner_fingerprint, "pre-upgrade-fingerprint");

    run = 2;
    try {
      await cmdIngestLocal(manifest, manifestPath, { path: sourceRoot, source: "upload" }, deps());
    } catch {
      // A refusal of a previously indexed file may stop the run for owner review; either way
      // the file must have been rechecked, not short-circuited as unchanged.
    }
    assert.ok(prepared.includes("2:flaky.txt"), "the failed file is prepared again on the next run");
    assert.match(persisted.skipped["flaky.txt"] || "", /^refused: carries /,
      "the next run applies the current credential scanner to the old revision instead of reporting it unchanged");
  } finally {
    console.log = priorLog;
    rmSync(root, { recursive: true, force: true });
  }
});
