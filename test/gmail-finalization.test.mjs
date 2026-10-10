import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdIngestRemote, cmdLoad, describeLoadResult, credentialScannerFingerprint } from "../brain.mjs";
import { gmailPolicyFingerprint } from "../connectors/gmail.mjs";
import * as ingest from "../ingest/run.mjs";
import { retryIngestFinalization } from "../operations/ingest-finalization-retry.mjs";

const finalizationError = "ingest finalization failed; retry this document";
const cpuError = "D1_ERROR: Database reset because it exceeded its CPU time limit";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

// Exercise the real remote runner, batching, HTTP receipt validation and atomic
// state persistence. Only provider reads, fetch, lease and removal preview are
// injected; no external service or machine credential can be consulted.
async function fixture(run, source = "gmail") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gmail-finalization-")));
  const manifestPath = join(root, "fixture.manifest.json");
  const statePath = join(root, `.brain-ingest-${source}.json`);
  const manifest = {
    corpora: { gmail: { enabled: true } },
    client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
  };
  const key = "01234567".repeat(8);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(root, ".brain-admin-key"), key, { mode: 0o600 });
  const scanner = credentialScannerFingerprint(true);
  ingest.saveState(statePath, {
    version: 1, done: {}, skipped: {}, history_id: "prior",
    credential_scanner_fingerprint: scanner,
    gmail_policy_fingerprint: gmailPolicyFingerprint({ credentialScannerFingerprint: scanner }),
  });
  const f = {
    ids: ["stubborn", "clean"], marker: "next", calls: [], sleeps: [], receipts: [],
    reads: [], saves: [], previews: 0, forgotten: 0, leases: 0, policyReads: [], stored: new Set(),
    policy: () => ({ allowed: true }), content: null, lostLease: false,
    respond: (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "created", chunks: 1 })) }),
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    setState: (state) => ingest.saveState(statePath, state),
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  console.log = console.warn = (...args) => logs.push(args.join(" "));
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/admin/brain/ingest/batch") {
      const docs = JSON.parse(options.body).docs;
      f.calls.push(docs.map((doc) => doc.source_id));
      return f.respond(docs);
    }
    if (path === "/api/admin/brain/documents") return json({ vector_backlog: { pending: 1 } });
    f.forgotten++;
    throw new Error("unexpected fixture HTTP route");
  };
  f.once = async (flags = {}, loadOptions = null) => {
    logs.length = 0;
    let error = null;
    let result = null;
    try {
      const dependencies = {
        withSourceIngestLock: async (_options, task) => task({ assertOwned: () => {
          f.leases++;
          if (f.lostLease) throw Object.assign(new Error("fixture lease lost"), { code: "source_ingest_lock_lost" });
        } }),
        resolveBaseUrl: async () => "https://fixture.invalid",
        resolveAdminKey: () => key,
        getAccessToken: async () => { throw new Error("provider credential seam must not be used"); },
        ingestRetrySleep: async (ms) => { f.sleeps.push(ms); f.onSleep?.(ms); },
        ingestLib: async () => ({ ...ingest, saveState: (path, state) => {
          f.beforeSave?.(state);
          f.saves.push(structuredClone(state));
          ingest.saveState(path, state);
        } }),
        gmail: {
          currentHistoryId: async () => f.marker,
          listHistory: async () => ({ ids: f.ids, deletedIds: [], historyId: f.marker }),
          listMessages: async function* () { yield* f.ids; },
          messagePolicy: async (_token, id) => { f.policyReads.push(id); return f.policy(id); },
          toEnvelope: async (_token, id) => {
            f.reads.push(id);
            return { version: "revision", envelope: {
              source_type: source, source_id: id, title: "Synthetic correspondence",
              content: f.content || "Ordinary invented correspondence for the offline storage probe.",
            } };
          },
        },
        listStoredSourceFamilies: async () => f.stored,
        postSourceReceipt: async (_base, _key, receipt) => { f.receipts.push(receipt); return receipt; },
        removalPlanRequest: async ({ body }) => {
          assert.equal(body.action, "preview");
          f.previews++;
          return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" }, targets: [], documents: 0 };
        },
      };
      const ingestRemote = async (m, path, args) => {
        const value = await cmdIngestRemote(m, path, args, dependencies);
        f.loadLeg = describeLoadResult(value);
        return value;
      };
      result = loadOptions
        ? await cmdLoad(manifestPath, {
            flags, lifecycleLockHeld: true, probes: { gmail: () => ({ connected: true }) },
            commands: { ingestRemote }, ...loadOptions,
          })
        : await cmdIngestRemote(manifest, manifestPath, { from: "gmail", source, ...flags }, dependencies);
    } catch (caught) { error = caught; }
    return { error, result, output: logs.join("\n"), receipt: f.receipts.at(-1), state: f.state() };
  };
  try { await run(f); }
  finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a stubborn finalization is durable before cursor advance, exits once, then recovers", async () => fixture(async (f) => {
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id,
    status: doc.source_id === "stubborn" ? "failed" : "created", chunks: 1,
    ...(doc.source_id === "stubborn" ? { error: finalizationError } : {}),
  })) });
  const first = await f.once();
  assert.ok(f.calls.length > 0 && f.previews > 0, "batch and cleanup decision points were reached");
  assert.ok(first.error, "a new held failure exits nonzero");
  assert.equal(first.state.history_id, "next", "pinned-cursor regression");
  assert.deepEqual(first.state.gmail_retry, { "gmail:stubborn": true }, "retry state stores identities only");
  assert.equal(first.state.done["gmail:clean"], "revision");
  assert.equal(first.state.done["gmail:stubborn"], undefined);
  assert.equal(f.calls.length, 5, "bounded finalization attempts");
  assert.deepEqual(f.calls.slice(1), Array(4).fill(["stubborn"]), "successful members are never resent");
  assert.deepEqual(f.sleeps, [2000, 4000, 8000, 16000]);
  const held = f.saves.findIndex((state) => state.gmail_retry?.["gmail:stubborn"] === true);
  const advanced = f.saves.findIndex((state) => state.history_id === "next");
  assert.ok(held >= 0 && held < advanced, "exact held identity is saved before advancing");
  assert.equal(first.receipt.status, "error");
  assert.equal(first.receipt.complete_sweep, false);
  assert.equal(first.receipt.docs_failed, 1);
  assert.match(first.output, /1 held for retry/);

  f.ids = ["new-clean"];
  f.marker = "later";
  f.calls.length = f.reads.length = 0;
  const again = await f.once();
  assert.equal(again.error, null, "an existing held failure does not exit nonzero again");
  assert.equal(f.reads[0], "stubborn", "durable retries precede new history");
  assert.equal(f.calls.length, 5);
  assert.equal(again.state.history_id, "later");
  assert.deepEqual(again.state.gmail_retry, first.state.gmail_retry);
  assert.equal(again.receipt.status, "error", "exit zero does not mean complete");
  assert.equal(again.receipt.complete_sweep, false);
  assert.equal(again.receipt.docs_failed, 1);
  assert.equal(again.result.held_for_retry, 1);
  assert.equal(again.result.complete, false);
  assert.match(again.output, /1 held for retry/);

  f.ids = [];
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) });
  f.calls.length = 0;
  const recovered = await f.once();
  assert.equal(recovered.error, null);
  assert.deepEqual(f.calls, [["stubborn"]], "empty history still retries the held document");
  assert.equal(recovered.state.gmail_retry, undefined);
  assert.equal(recovered.state.done["gmail:stubborn"], "revision");
  assert.equal(recovered.receipt.status, "ready");
  assert.equal(recovered.receipt.docs_failed, 0);
  assert.equal(f.forgotten, 0, "accepted control reached cleanup preview without forget");
}));

for (const perDocument of [false, true]) {
  test(`transient D1 CPU reset retries through ${perDocument ? "a failed member" : "HTTP 400"}`, async () => fixture(async (f) => {
    f.respond = (docs) => f.calls.length === 1
      ? perDocument
        ? json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed", error: cpuError })) })
        : json({ error: cpuError }, 400)
      : json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "created" })) });
    const result = await f.once();
    assert.equal(f.calls.length, 2, "transient decision reached and retried");
    assert.equal(result.error, null);
    assert.equal(result.receipt.status, "ready");
    assert.equal(result.state.history_id, "next");
    assert.equal(result.state.gmail_retry, undefined);
  }));
}

test("ordinary HTTP 400 and unauthorized controls stay failed without retry or cursor advance", async () => {
  for (const [status, message] of [
    [400, "invalid envelope"], [401, cpuError], [403, cpuError],
    [400, "D1_ERROR: no such table; the database was reset"],
    [400, "D1_ERROR: query exceeded the memory limit"],
    [400, "D1_ERROR: daily row read limit\nOther request exceeded its CPU time limit"],
  ]) await fixture(async (f) => {
    f.respond = () => json({ error: message }, status);
    const result = await f.once();
    assert.equal(f.calls.length, 1, "HTTP decision reached once");
    assert.ok(result.error);
    assert.equal(result.state.history_id, "prior");
    assert.equal(result.state.gmail_retry, undefined);
    assert.equal(f.sleeps.length, 0);
  });
});

test("unacknowledged batch member cannot be advanced or recorded as an accepted retry", async () => fixture(async (f) => {
  f.respond = () => json({ results: [{ source_id: "stubborn", status: "failed", error: finalizationError }] });
  const result = await f.once();
  assert.equal(f.calls.length, 1, "invalid receipt decision reached");
  assert.ok(result.error);
  assert.equal(result.state.history_id, "prior");
  assert.equal(result.state.gmail_retry, undefined);
}));

test("an unchanged legacy retry backlog stays visibly incomplete without a new process failure", async () => fixture(async (f) => {
  f.setState({ ...f.state(), gmail_retry: { "gmail:stubborn": "legacy-revision" } });
  f.ids = [];
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed" })) });
  const result = await f.once();
  assert.deepEqual(f.calls, [["stubborn"]], "held message reached the real batch path");
  assert.equal(result.error, null);
  assert.equal(result.receipt.status, "error");
  assert.equal(result.receipt.docs_failed, 1);
  assert.match(result.output, /1 held for retry/);
}));

test("reset retries held identities first even when the full query omits them", async () => fixture(async (f) => {
  f.setState({ ...f.state(), gmail_retry: { "gmail:stubborn": "legacy-revision" } });
  f.ids = ["clean"];
  const result = await f.once({ reset: true });
  assert.equal(result.error, null);
  assert.deepEqual(f.reads, ["stubborn", "clean"]);
  assert.equal(result.state.gmail_retry, undefined);
  assert.equal(result.receipt.status, "ready");
}));

test("a newly failing document still exits when another document was already held", async () => fixture(async (f) => {
  f.setState({ ...f.state(), gmail_retry: { "gmail:stubborn": true } });
  f.ids = ["new-failure", "clean"];
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id,
    status: doc.source_id === "clean" ? "created" : "failed" })) });
  const result = await f.once();
  assert.deepEqual(f.calls, [["stubborn", "new-failure", "clean"]]);
  assert.ok(result.error);
  assert.deepEqual(result.state.gmail_retry, { "gmail:stubborn": true, "gmail:new-failure": true });
  assert.equal(result.state.history_id, "next");
  assert.match(result.output, /2 held for retry; 1 newly held/);
}));

test("exhausted HTTP reset and transport attempts remain durable failures", async () => {
  for (const transport of [false, true]) await fixture(async (f) => {
    f.respond = () => {
      if (transport) throw Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
      return json({ error: cpuError }, 400);
    };
    const result = await f.once();
    assert.equal(f.calls.length, 5);
    assert.ok(result.error);
    assert.deepEqual(result.state.gmail_retry, { "gmail:stubborn": true, "gmail:clean": true });
    assert.equal(result.state.history_id, "next");
    assert.equal(result.receipt.status, "error");
    assert.equal(result.receipt.docs_failed, 2);
  });
});

test("a failed durable save prevents cursor advancement after retries were attempted", async () => fixture(async (f) => {
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed" })) });
  let reached = 0;
  f.beforeSave = (state) => {
    if (state.gmail_retry) { reached++; throw new Error("fixture storage unavailable"); }
  };
  const result = await f.once();
  assert.equal(f.calls.length, 1);
  assert.equal(reached, 1, "durable retry write decision reached");
  assert.ok(result.error);
  assert.equal(result.state.history_id, "prior");
}));

test("an interruption after family settlement cannot lose the held retry", async () => fixture(async (f) => {
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id,
    status: doc.source_id === "stubborn" ? "failed" : "created" })) });
  const result = await f.once({ "pace-vectors-per-minute": "40" });
  assert.deepEqual(f.calls, [["stubborn", "clean"]]);
  assert.match(result.error?.message || "", /chunk count/, "post-settlement pacing refusal reached");
  assert.equal(result.state.history_id, "prior");
  assert.deepEqual(result.state.gmail_retry, { "gmail:stubborn": true });
}));

test("losing the source lease between attempts prevents another request", async () => fixture(async (f) => {
  f.respond = () => json({ error: cpuError }, 400);
  f.onSleep = () => { f.lostLease = true; };
  const result = await f.once();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sleeps.length, 1, "retry was scheduled before lease loss");
  assert.ok(result.error);
  assert.equal(result.state.history_id, "prior");
}));

test("split failures retain one logical identity until every part succeeds", async () => fixture(async (f) => {
  f.ids = ["stubborn"];
  const text = "Synthetic ordinary correspondence. ";
  f.content = text.repeat(Math.ceil(ingest.MAX_DOC_CHARS * 2.1 / text.length));
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed" })) });
  const first = await f.once();
  assert.ok(f.calls.flat().length > 1, "split family decision reached");
  assert.ok(first.error);
  assert.deepEqual(first.state.gmail_retry, { "gmail:stubborn": true });
  assert.equal(first.state.history_id, "next");
  const second = await f.once();
  assert.equal(second.error, null);
  assert.equal(second.receipt.status, "error");
  assert.equal(second.state.done["gmail:stubborn"], undefined);
}));

test("full sweeps deduplicate retried ids and require current policy before ingestion", async () => fixture(async (f) => {
  f.setState({ ...f.state(), gmail_retry: { "gmail:stubborn": true } });
  f.policy = () => ({ allowed: false, cursor_blocking: true, retain_existing: true,
    skip: { path: "synthetic", reason: "synthetic label evidence unavailable" } });
  const result = await f.once({ reset: true });
  assert.deepEqual(f.policyReads, ["stubborn"], "held id policy decision reached");
  assert.deepEqual(f.calls, [["clean"]], "clean control is sent; held id is not");
  assert.ok(result.error);
  assert.equal(result.state.history_id, undefined);
  assert.deepEqual(result.state.gmail_retry, { "gmail:stubborn": true });
  assert.equal(result.receipt.status, "error");
}));

test("stored done markers cannot shortcut a held retry on a sweep or incremental pass", async () => {
  for (const sweep of [false, true]) await fixture(async (f) => {
    const state = f.state();
    f.setState({ ...state, history_id: sweep ? undefined : state.history_id,
      done: { "gmail:stubborn": "revision" }, gmail_retry: { "gmail:stubborn": true } });
    f.stored = new Set(["gmail:stubborn"]);
    f.ids = ["stubborn"];
    const result = await f.once();
    assert.equal(result.error, null);
    assert.deepEqual(f.calls, [["stubborn"]], "held id reaches the Worker despite the older done marker");
    assert.equal(result.state.gmail_retry, undefined);
  });
});

test("revision verification retries but success and deterministic rejection do not", async () => fixture(async (f) => {
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id,
    status: doc.source_id === "clean" || f.calls.length > 1 ? "created" : "failed",
    error: "ingest revision could not be verified; retry this document",
  })) });
  const result = await f.once();
  assert.deepEqual(f.calls, [["stubborn", "clean"], ["stubborn"]]);
  assert.equal(result.error, null);
  assert.equal(result.receipt.status, "ready");
}));

test("retry helper independently enforces its lease and non-transient error boundary", async () => {
  const docs = [{ source_id: "fixture" }];
  let sent = 0;
  let checks = 0;
  const lost = new Error("fixture lease ended");
  await assert.rejects(retryIngestFinalization({
    docs, validate: (body) => body.results, sleep: async () => {},
    assertOwned: () => { if (++checks === 2) throw lost; },
    send: async () => { sent++; return { res: { ok: false, status: 503 }, raw: "{}" }; },
  }), (error) => error === lost);
  assert.equal(checks, 2);
  assert.equal(sent, 1);
  const terminal = new Error("fixture permanent rejection");
  let terminalCalls = 0;
  await assert.rejects(retryIngestFinalization({
    docs, validate: (body) => body.results, sleep: async () => {},
    send: async () => { terminalCalls++; throw terminal; },
  }), (error) => error === terminal);
  assert.equal(terminalCalls, 1);
});

test("a named Gmail source keeps its own retry identities across runs", async () => fixture(async (f) => {
  f.ids = ["stubborn"];
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed" })) });
  const first = await f.once();
  assert.equal(f.calls.length, 1);
  assert.ok(first.error);
  assert.deepEqual(first.state.gmail_retry, { "mailbox:stubborn": true });
  assert.equal(first.state.history_id, "next");
  const second = await f.once();
  assert.equal(f.calls.length, 2);
  assert.equal(second.error, null);
  assert.equal(second.receipt.status, "error");
}, "mailbox"));


for (const allowPartialRefresh of [false, true]) {
  test(`held Gmail finalizations stay partial in the real load report (allowPartialRefresh=${allowPartialRefresh})`, async () => fixture(async (f) => {
    f.setState({ ...f.state(), gmail_retry: { "gmail:stubborn": true } });
    f.ids = ["clean"];
    f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id,
      status: doc.source_id === "stubborn" ? "failed" : "created", chunks: 1,
      ...(doc.source_id === "stubborn" ? { error: finalizationError } : {}),
    })) });
    const held = await f.once({}, { allowPartialRefresh });
    assert.equal(f.calls.length, 5, "real load leg reached all finalization attempts");
    assert.equal(f.previews, 1, "real cleanup decision reached");
    assert.equal(held.receipt.status, "error");
    assert.deepEqual(held.state.gmail_retry, { "gmail:stubborn": true });
    assert.equal(held.state.history_id, "next");
    assert.equal(f.loadLeg.partial, true, "held source must remain partial");
    assert.equal(f.loadLeg.outcome.kind, "partial");
    assert.equal(f.loadLeg.refreshSucceeded, false);
    assert.match(f.loadLeg.text, /1 held for retry/);
    assert.match(held.error?.message || "", /1 partial source outcome/);
    assert.match(held.output.replace(/\x1b\[[0-9;]*m/g, ""), /partly loaded\s+Gmail/);

    f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) });
    f.calls.length = 0;
    const recovered = await f.once({}, { allowPartialRefresh });
    assert.deepEqual(f.calls, [["stubborn", "clean"]], "accepted control reaches the same load leg");
    assert.equal(recovered.error, null);
    assert.equal(recovered.result.entries[0].status, "loaded");
    assert.equal(recovered.result.entries[0].outcome.kind, "completed");
    assert.equal(recovered.result.entries[0].refreshSucceeded, true);
    assert.equal(recovered.state.gmail_retry, undefined);
  }));
}

test("load classification independently honors explicit incompletion and held identities", () => {
  for (const result of [{ complete: false }, { held_for_retry: 2 }]) {
    const described = describeLoadResult({ created: 1, ...result });
    assert.deepEqual(described.counts, { created: 1, updated: 0, unchanged: 0 });
    assert.equal(described.partial, true);
    assert.equal(described.outcome.kind, "partial");
    assert.equal(described.refreshSucceeded, false);
  }
  const accepted = describeLoadResult({ created: 1, complete: true, held_for_retry: 0 });
  assert.equal(accepted.partial, false);
  assert.equal(accepted.outcome.kind, "completed");
  assert.equal(accepted.refreshSucceeded, true);
});

for (const reset of [false, true]) {
 test(`a shared run backoff allowance lets fresh mail pass a held prefix on consecutive daily windows (reset=${reset})`, async () => fixture(async (f) => {
  const heldIds = Array.from({ length: 100 }, (_, index) => `held-${index}`);
  const retries = Object.fromEntries(heldIds.map((id) => [`gmail:${id}`, true]));
  f.setState({ ...f.state(), gmail_retry: retries });
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id,
    status: heldIds.includes(doc.source_id) ? "failed" : "created", chunks: 1,
    ...(heldIds.includes(doc.source_id) ? { error: finalizationError } : {}),
  })) });
  let elapsed = 0;
  let deadlines = 0;
  f.onSleep = (ms) => {
    elapsed += ms;
    if (elapsed >= 60_000) { deadlines++; throw new Error("fixture daily deadline"); }
  };
  for (let run = 1; run <= 2; run++) {
    elapsed = 0;
    f.calls.length = f.sleeps.length = f.reads.length = 0;
    f.ids = [`fresh-${run}`];
    f.marker = `window-${run}`;
    const result = await f.once({ reset });
    assert.ok(f.calls.length >= 5, "held finalization retry decision reached");
    assert.deepEqual(f.reads.slice(0, 100), heldIds, "held identities attempted before new history");
    assert.equal(deadlines, 0, "held retries cannot consume a minute in sleeps");
    assert.equal(result.error, null, "no new failure exit for the existing held list");
    assert.deepEqual(f.calls.at(-1), [`fresh-${run}`], "fresh-mail batch reached before deadline");
    assert.equal(f.calls.length, 7, "three groups share four retries");
    assert.deepEqual(f.sleeps, [2000, 4000, 8000, 16000]);
    assert.deepEqual(result.state.gmail_retry, retries, "every held identity remains durable");
    assert.equal(result.state.history_id, f.marker);
    assert.equal(result.state.done[`gmail:fresh-${run}`], "revision");
    assert.equal(result.receipt.status, "error");
    assert.equal(result.receipt.docs_failed, 100);
    assert.equal(result.result.complete, false);
    assert.match(result.output, /100 held for retry/);
    const heldSave = f.saves.findIndex((state) => Object.keys(state.gmail_retry || {}).length === 100);
    const cursorSave = f.saves.findIndex((state) => state.history_id === f.marker);
    assert.ok(heldSave >= 0 && heldSave < cursorSave, "durable coverage precedes cursor advancement");
  }
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) });
  f.ids = ["fresh-control"];
  elapsed = 0;
  f.calls.length = f.sleeps.length = 0;
  const accepted = await f.once();
  assert.equal(f.calls.length, 3, "successful control visits all three groups");
  assert.deepEqual(f.calls.at(-1), ["fresh-control"]);
  assert.equal(accepted.error, null);
  assert.equal(accepted.state.gmail_retry, undefined);
  assert.equal(accepted.receipt.status, "ready");
  assert.equal(elapsed, 0);
}));
}


test("exhausting the shared budget still attempts and durably holds new failures", async () => fixture(async (f) => {
  const heldIds = Array.from({ length: 50 }, (_, index) => `held-${index}`);
  f.setState({ ...f.state(), gmail_retry: Object.fromEntries(heldIds.map((id) => [`gmail:${id}`, true])) });
  f.ids = ["new-failure"];
  f.respond = () => json({ error: cpuError }, 400);
  const result = await f.once();
  assert.equal(f.calls.length, 6, "held group exhausts four retries; new group still reaches HTTP decision");
  assert.deepEqual(f.calls.at(-1), ["new-failure"]);
  assert.deepEqual(f.sleeps, [2000, 4000, 8000, 16000]);
  assert.ok(result.error, "a newly held failure still exits nonzero");
  assert.equal(Object.keys(result.state.gmail_retry).length, 51);
  assert.equal(result.state.gmail_retry["gmail:new-failure"], true);
  assert.equal(result.state.history_id, "next");
  assert.equal(result.receipt.docs_failed, 51);
  assert.match(result.output, /51 held for retry; 1 newly held/);
  f.respond = (docs) => json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) });
  f.calls.length = 0;
  const recovered = await f.once();
  assert.equal(f.calls.length, 2, "recovery visits both groups");
  assert.equal(recovered.error, null);
  assert.equal(recovered.state.gmail_retry, undefined);
  assert.equal(recovered.receipt.status, "ready");
}));
