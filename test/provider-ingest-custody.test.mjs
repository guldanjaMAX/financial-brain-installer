import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdIngestProvider } from "../brain.mjs";
import * as oauth from "../connectors/provider-oauth.mjs";
import { acquireSourceIngestLock, sourceIngestLockPath, withSourceIngestLock } from "../operations/source-ingest-lock.mjs";
import { ingestionOutcome } from "../ingest/outcome.mjs";

// Two manifest directories still write one per-user provider credential record.
// Use the actual credential/cursor file, real CLI path and real filesystem locks.
for (const differentSource of [false, true]) test(`provider record excludes a second manifest${differentSource ? " and source" : ""} before reads`, async t => {
  const home = mkdtempSync(join(tmpdir(), "brain-provider-custody-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = ["one", "two"].map(name => {
    const directory = join(home, name); mkdirSync(directory);
    const path = join(directory, "brain.manifest.json"); writeFileSync(path, "{}"); return path;
  });
  const storage = { home, backend: "file", platform: process.platform, path: join(home, "slack.json") };
  oauth.saveProviderCredentials("slack", { access_token: "synthetic-unused-token", sync_states: {} }, storage);
  let started; const ready = new Promise(resolve => { started = resolve; });
  let finish; const barrier = new Promise(resolve => { finish = resolve; });
  let loads = 0, writes = 0;
  const options = {
    storage, sourceIngestLockOptions: { home }, oauth,
    resolveAdminKey: () => "synthetic-unused-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    sync: async () => { throw Error("unexpected network adapter"); },
    runtime: { runProviderConnector: async ({ loadState, saveState, assertOwned }) => {
      loads++; assertOwned(); const prior = await loadState(); started();
      if (loads === 1) await barrier;
      assertOwned(); await saveState({ ...prior, cursor: "terminal-fixture-cursor" }); writes++;
      return { tally: { created: 0, updated: 0, unchanged: 0 }, removed: 0,
        outcome: { kind: "completed" }, cursor_advanced: true };
    } },
  };
  const manifest = { brain: { domain: "fixture.invalid" }, corpora: { slack: { enabled: true } } };
  const first = cmdIngestProvider(manifest, paths[0], { from: "slack" }, options);
  await ready;
  try {
    await assert.rejects(
      cmdIngestProvider(manifest, paths[1], { from: "slack", ...(differentSource ? { source: "other" } : {}) }, options),
      /ingest is already running/,
    );
    assert.equal(loads, 1, "blocked ingest must not read or mutate the shared record");
  } finally { finish(); await first; }
  assert.equal(writes, 1);
  assert.equal(oauth.loadProviderSyncState("slack", "slack", storage).cursor, "terminal-fixture-cursor");
  await cmdIngestProvider(manifest, paths[1], { from: "slack" }, options);
  assert.equal(loads, 2, "a later invocation can acquire the released record");
});

for (const phase of ["before_refresh", "after_walk", "after_delivery"]) {
  test(`lost shared-record ownership ${phase} blocks stale work while the source lease stays owned`, async t => {
    const home = mkdtempSync(join(tmpdir(), "brain-provider-record-loss-"));
    let successor = null;
    t.after(() => { successor?.release(); rmSync(home, { recursive: true, force: true }); });
    const manifestPath = join(home, "brain.manifest.json"); writeFileSync(manifestPath, "{}");
    const storage = { home, backend: "file", platform: process.platform, path: join(home, "slack.json") };
    oauth.saveProviderCredentials("slack", {
      access_token: "synthetic-unused-access", refresh_token: "synthetic-unused-refresh",
      expires_at: phase === "before_refresh" ? 1 : Date.now() + 60 * 60_000,
      client_id: "synthetic-client-id", client_secret: "synthetic-client-secret", sync_states: {},
    }, storage);
    const before = readFileSync(storage.path);
    const receipts = [];
    const calls = { access: 0, fetch: 0, sync: 0, delivery: 0, save: 0, lost: 0 };
    let assertSourceOwned;
    const recordOptions = { sourceName: "slack", sharedRecord: "provider:slack", home };
    const loseSharedRecord = () => {
      assert.equal(assertSourceOwned(), true);
      // Replace only this private synthetic shared owner. The source's real
      // filesystem lease remains owned, so a source-only callback would pass.
      rmSync(sourceIngestLockPath(recordOptions), { recursive: true });
      successor = acquireSourceIngestLock(recordOptions);
      assert.equal(assertSourceOwned(), true);
      assert.equal(successor.assertOwned(), true);
      calls.lost++;
    };
    const manifest = { brain: { domain: "fixture.invalid" }, corpora: { slack: { enabled: true } } };
    await assert.rejects(cmdIngestProvider(manifest, manifestPath, { from: "slack" }, {
      storage, sourceIngestLockOptions: { home },
      withSourceIngestLock: (options, task) => withSourceIngestLock(options, ownership => {
        if (!options.sharedRecord) assertSourceOwned = ownership.assertOwned;
        return task(ownership);
      }),
      oauth: {
        ...oauth,
        providerAccessToken: (...args) => { calls.access++; return oauth.providerAccessToken(...args); },
        saveProviderSyncState: (...args) => { calls.save++; return oauth.saveProviderSyncState(...args); },
      },
      resolveAdminKey: () => "synthetic-unused-key",
      resolveBaseUrl: async () => "https://fixture.invalid",
      fetchImpl: async () => { calls.fetch++; throw Error("unexpected provider refresh/network"); },
      postSourceReceipt: async (_base, _key, receipt) => {
        receipts.push(receipt);
        if (phase === "before_refresh" && receipt.status === "indexing") loseSharedRecord();
        return receipt;
      },
      sync: async () => {
        calls.sync++;
        if (phase === "after_walk") loseSharedRecord();
        return {
          provider: "slack", warnings: [], deletions: [], deletion_authority: "none",
          documents: [{ source_type: "slack", source_id: "synthetic-one", title: "Synthetic fixture",
            content: "Synthetic fixture content", occurred_at: null, date_source: "none", date_reliable: false,
            uri: null, metadata: {} }],
          proposed_cursor: "synthetic-uncommitted-cursor", cursor_can_advance: true,
          outcome: ingestionOutcome("completed"),
        };
      },
      requestIngestBatch: async ({ docs }) => {
        calls.delivery++;
        if (phase === "after_delivery") loseSharedRecord();
        return { res: { ok: true }, raw: JSON.stringify({
          results: docs.map(doc => ({ source_id: doc.source_id, status: "unchanged" })),
        }) };
      },
      applyDriveRemovals: async () => { throw Error("unexpected deletion"); },
    }), /local ingest lock changed/);
    assert.equal(calls.lost, 1);
    assert.equal(calls.fetch, 0, "ownership loss cannot trigger a credential refresh");
    assert.equal(calls.access, phase === "before_refresh" ? 0 : 1);
    assert.equal(calls.sync, phase === "before_refresh" ? 0 : 1);
    assert.equal(calls.delivery, phase === "after_delivery" ? 1 : 0);
    assert.equal(calls.save, 0, "the shared cursor must remain uncommitted");
    assert.deepEqual(receipts.map(receipt => receipt.status), ["indexing"], "a stale run cannot replace the successor's terminal status");
    assert.deepEqual(readFileSync(storage.path), before, "credentials and source cursor retain exact bytes");
    assert.equal(successor.assertOwned(), true, "the old finally block cannot release the replacement record owner");
  });
}
