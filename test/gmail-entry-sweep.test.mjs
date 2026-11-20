import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { install, points, arm, disarm } from "./fixtures/gmail-entry-faults.mjs";
install();
const { fixture } = await import("./helpers/gmail-batch-fixture.mjs");
const native = await import("../connectors/gmail.mjs");
const { prefetch, splitOversized } = await import("../ingest/run.mjs");
const { requestIngestBatch } = await import("../brain.mjs");
const json = value => new Response(JSON.stringify(value));
const deletedPolicy = () => ({ allowed: false, source_deleted: true, removal_cause: "explicit_deletion",
  skip: { reason: "synthetic current source deletion" } });
const preserveOwnerDecision = f => {
  const policy = f.policy;
  f.policy = id => id === "owner-decision" ? deletedPolicy() : policy(id);
};

function scenario(f, branch) {
  f.ids = ["fault-entry", "healthy-control"];
  f.options = { deferGmailRemovals: true };
  f.ingestOverrides = { prefetch: (ids, read) => prefetch(ids, id => { globalThis.__gmailEntryIdentity = id; return read(id); }, { concurrency: 1 }) };
  if (["held-failure", "auth-failure"].includes(branch)) f.policy = id => {
    if (id === "fault-entry") throw Object.assign(new Error("synthetic entry failure"),
      branch === "auth-failure" ? { needsReauth: true } : {});
    return { allowed: true };
  };
  if (branch.startsWith("deadline-") || branch === "send-expired") {
    const clock = { now: 0 };
    f.options = { ...f.options, ingestNowMs: () => clock.now, ingestDeadlineAt: 500 };
    if (branch === "send-expired") f.onEnvelope = () => { clock.now = 500; };
    else {
      f.respond = docs => {
        if (branch === "deadline-before-sleep") clock.now = 500;
        return json({ results: docs.map(doc => ({ source_id: doc.source_id, status: "failed",
          error: "ingest finalization failed; retry this document" })) });
      };
      f.onSleep = ms => { clock.now += ms; };
    }
  }
  if (["resumed", "unchanged"].includes(branch)) {
    f.stored.add("gmail:fault-entry");
    const content = "Ordinary invented correspondence for the offline storage probe.";
    f.remoteParts.set("fault-entry",{source_id:"fault-entry",content});
    f.setState({ ...f.state(), done: { "gmail:fault-entry": "revision" }, gmail_accepted_parts:{"gmail:fault-entry":{
      revision:"revision",policy_fingerprint:f.state().gmail_policy_fingerprint,geometry:{size:1500,overlap:300},
      parts:[{source_id:"fault-entry",content_hash:createHash('sha256').update(`chunk-v1:1500:300\0${content}`).digest('hex'),chunk_count:1}],
    }} });
    if (branch === "resumed") {
      const state = f.state(); delete state.history_id; f.setState(state);
    }
  }
  if (["skip", "retained"].includes(branch)) f.policy = id => id !== "fault-entry" ? { allowed: true } : {
    allowed: false, policy_skip: branch === "skip", retain_existing: branch === "retained",
    removal_cause: "scope_or_filter_change", skip: { reason: "synthetic policy decision" },
  };
  if (branch === "scanner") f.setState({ ...f.state(), credential_scanner_fingerprint: "prior" });
  if (branch === "paced") f.flags = { "pace-vectors-per-minute": "40" };
  if (branch === "bounded-retry") f.options = { ...f.options, ingestDeadlineAt: 60000, ingestNowMs: () => 0 };
  if (["retry", "bounded-retry", "worker-failed"].includes(branch)) {
    const accept = f.respond;
    f.respond = docs => {
      if (docs[0].source_id === "fault-entry" && (branch === "worker-failed" || f.calls.length === 1)) {
        return json({ results: docs.map(doc => ({ source_id: doc.source_id, status: "failed",
          error: branch !== "worker-failed" ? "ingest finalization failed; retry this document" : "synthetic item failure" })) });
      }
      return accept(docs);
    };
  }
  if (branch.startsWith("receipt-")) {
    const accepted = f.respond;
    f.respond = docs => {
      if (docs[0].source_id !== "fault-entry") return accepted(docs);
      const row = { source_id: "fault-entry", status: "created", chunks: 1 };
      const shapes = {
        "receipt-array": { results: null },
        "receipt-unknown": { results: [{ ...row, source_id: "foreign-control" }] },
        "receipt-duplicate": { results: [row, row] },
        "receipt-status": { results: [{ ...row, status: "unknown" }] },
        "receipt-missing": { results: [] },
      };
      return json(shapes[branch]);
    };
  }
  if (branch === "request-id") {
    f.customEnvelope = id => ({ version: "revision", envelope: { source_type: "gmail",
      source_id: id === "fault-entry" ? "" : id, title: "Synthetic correspondence",
      content: "Ordinary synthetic correspondence for exact request identity checks." } });
  }
  if (branch === "request-duplicate") f.ingestOverrides.splitOversized = envelope =>
    envelope.source_id === "fault-entry" ? [envelope, { ...envelope }] : splitOversized(envelope);
  if (branch === "native") {
    f.policy = id => native.messagePolicy(async () => "synthetic", id);
    f.customEnvelope = id => native.toEnvelope(async () => "synthetic", id, { trustedEligible: true });
    f.providerFetch = url => {
      globalThis.__gmailEntryIdentity = new URL(url).pathname.split("/").at(-1);
      return json({ labelIds: ["INBOX"], internalDate: "1767268800000", historyId: "revision",
      raw: Buffer.from("Subject: Synthetic correspondence\r\nContent-Type: text/plain\r\n\r\nOrdinary synthetic correspondence for native extraction and classification.").toString("base64url") });
    };
  }
}

for (const point of points) test(`FAULT SWEEP ${point.id} ${point.branch}`, async () => fixture(async f => {
  scenario(f, point.branch);
  const fault = arm(point);
  let run;
  try { run = await f.once(f.flags); } finally { disarm(); }
  assert.ok(fault.reached > 0, "the enumerated decision point was reached");
  if (["transport", "persistence", "auth"].includes(point.scope)) {
    assert.ok(run.error, "the actual HTTP boundary classifies the transport failure globally");
    assert.ok(!f.stored.has("gmail:healthy-control"));
    assert.equal(run.state.history_id, "prior");
    assert.equal(run.state.gmail_retry, undefined);
    assert.equal(f.forgotten, 0);
    return;
  }
  if (point.scope === "deadline") {
    assert.equal(run.error, null);
    assert.equal(run.result.more_history, true);
    assert.ok(!f.stored.has("gmail:healthy-control"));
    assert.equal(run.state.history_id, "prior");
    assert.ok(run.state.gmail_batch_window.remaining_ids.includes("fault-entry"));
    assert.equal(f.forgotten, 0);
    return;
  }
  assert.equal(run.error, null, run.error?.message);
  assert.ok(f.stored.has("gmail:healthy-control"), "entry 2 actually accepted through the real sender");
  assert.equal(run.state.gmail_retry?.["gmail:fault-entry"], true, "entry 1 retained a durable retry");
  assert.equal(run.state.gmail_entry_failures?.["gmail:fault-entry"]?.version, 1);
  assert.ok(run.state.gmail_entry_failures?.["gmail:fault-entry"]?.class);
  assert.ok(run.state.skipped?.["gmail:fault-entry"]);
  assert.ok(run.state.history_id === "next" || run.state.gmail_recovery?.stage === "stored", "history token or bootstrap offset advanced");
  assert.equal(run.receipt.status, "error");
  assert.equal(run.receipt.complete_sweep, false);
  assert.equal(f.forgotten, 0);
}));

for (const kind of ["auth", "transport"]) test(`FAULT SWEEP global ${kind} stops before entry 2`, async () => fixture(async f => {
  scenario(f, "normal");
  const fault = arm(points[0], kind);
  let run;
  try { run = await f.once(); } finally { disarm(); }
  assert.ok(fault.reached > 0);
  assert.ok(run.error, "global control is different from item arms");
  assert.equal(f.stored.size, 0);
  assert.equal(run.state.history_id, "prior");
  assert.equal(run.state.gmail_retry, undefined);
  assert.equal(f.forgotten, 0);
}));

test("FAULT SWEEP green control accepts both entries without a retry", async () => fixture(async f => {
  scenario(f, "normal"); disarm();
  const run = await f.once();
  assert.equal(run.error, null);
  assert.equal(f.stored.size, 2);
  assert.equal(run.state.history_id, "next");
  assert.equal(run.state.gmail_retry, undefined);
  assert.equal(run.state.gmail_entry_failures, undefined);
  assert.equal(run.receipt.status, "ready");
}));

// Discover the checkpoint count from a green real execution, then expire the
// anchored deadline at each actual save, including saves in nested send/settle.
// No timer or implementation-specific fixed checkpoint count drives the test.
const deadlineReceipts = { ready: 0, error: 0 };
test.after(() => {
  assert.ok(deadlineReceipts.ready > 0, "a settled window at the deadline is the green receipt control");
  assert.ok(deadlineReceipts.error > 0, "unfinished deadline windows still reach an incomplete receipt");
});
for (const branch of ["normal", "unchanged", "skip", "retained", "worker-failed", "retry", "scanner", "split"]) {
  test(`DEADLINE SWEEP every durable checkpoint: ${branch}`, async () => {
    let checkpoints = 0;
    await fixture(async f => {
      scenario(f, branch);
      preserveOwnerDecision(f);
      if (branch === "split") f.content = "Ordinary invented correspondence. ".repeat(35000);
      f.stored.add("gmail:owner-decision");
      f.setState({ ...f.state(), gmail_owner_removals: { "gmail:owner-decision": "explicit_deletion" } });
      f.beforeSave = () => { checkpoints++; };
      const run = await f.once();
      assert.equal(run.error, null);
      assert.ok(f.stored.has("gmail:healthy-control"));
      assert.equal(run.state.gmail_owner_removals["gmail:owner-decision"], "explicit_deletion");
    });
    assert.ok(checkpoints > 2, "green control reaches window, inventory and entry checkpoints");
    for (let at = 1; at <= checkpoints; at++) await fixture(async f => {
      scenario(f, branch);
      preserveOwnerDecision(f);
      if (branch === "split") f.content = "Ordinary invented correspondence. ".repeat(35000);
      f.stored.add("gmail:owner-decision");
      f.setState({ ...f.state(), gmail_owner_removals: { "gmail:owner-decision": "explicit_deletion" } });
      const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
      const deadline = clock.now + 60000;
      f.options = { ...f.options, ingestNowMs: () => clock.now, ingestDeadlineAt: deadline };
      let reached = 0, fired = false;
      f.beforeSave = () => { if (++reached === at) { fired = true; clock.now = deadline; } };
      const first = await f.once();
      assert.ok(fired, `checkpoint ${at}/${checkpoints} reached`);
      assert.equal(first.error, null, first.error?.message);
      assert.equal(first.state.gmail_owner_removals["gmail:owner-decision"], "explicit_deletion");
      // A deadline at the final save can follow a fully settled window.
      // Owner review keeps coverage incomplete but no longer blocks readiness.
      const settled = !first.state.gmail_batch_window && first.state.history_id === "next" &&
        !Object.keys(first.state.gmail_retry || {}).length && first.receipt.docs_failed === 0 &&
        f.ids.every(id => first.state.done[`gmail:${id}`] || first.state.skipped[`gmail:${id}`]);
      assert.equal(first.receipt.status, settled ? "ready" : "error", `${branch} checkpoint ${at}/${checkpoints}`);
      deadlineReceipts[first.receipt.status]++;
      assert.equal(first.receipt.complete_sweep, false);
      assert.ok(first.state.gmail_batch_window || first.state.history_id === "next" || first.state.gmail_recovery || first.state.credential_scanner_progress,
        "deadline leaves a durable window, cursor or recovery offset");
      for (const [key, revision] of Object.entries(first.state.done)) {
        assert.ok(f.stored.has(key), `accepted checkpoint ${key} has a real stored family`);
        assert.ok(revision);
      }
      const unresolved = new Set(first.state.gmail_batch_window?.remaining_ids || []);
      if (first.state.gmail_batch_window || first.state.history_id === "next") for (const id of f.ids) assert.ok(first.state.done[`gmail:${id}`] || first.state.skipped[`gmail:${id}`] || unresolved.has(id),
        "every entry remains accepted, visibly skipped or in the saved suffix");
      f.beforeSave = null;
      f.options = { deferGmailRemovals: true };
      // The control supplies successful evidence for prior typed or store gaps.
      f.policy = id => id === "owner-decision" ? deletedPolicy() : { allowed: true };
      const accept = docs => {
        for (const doc of docs) f.stored.add(`gmail:${doc.source_id.split("#part")[0]}`);
        return json({ results: docs.map(doc => ({ source_id: doc.source_id, status: "created", chunks: 1 })) });
      };
      f.respond = accept;
      for (let attempt = 0; attempt < 3 && f.state().history_id !== "next"; attempt++) {
        const resumed = await f.once();
        assert.equal(resumed.error, null);
      }
      assert.equal(f.state().history_id, "next", "restart completes the exact saved work");
      assert.equal(f.state().gmail_owner_removals["gmail:owner-decision"], "explicit_deletion");
      assert.ok(f.stored.has("gmail:healthy-control"), "positive restart control accepted entry 2");
      assert.equal(f.forgotten, 0);
    });
    console.log(JSON.stringify({ probe: "deadline-checkpoints", branch, checkpoints }));
  });
}

test("FAULT SWEEP durable-write failure remains a global stop", async () => fixture(async f => {
  scenario(f, "normal");
  let reached = 0;
  f.beforeSave = state => {
    if (state.done["gmail:fault-entry"]) { reached++; throw new Error("synthetic durable storage failure"); }
  };
  const run = await f.once();
  assert.equal(reached, 1, "accepted-state persistence decision reached");
  assert.ok(run.error);
  assert.equal(run.state.history_id, "prior");
  assert.ok(!f.stored.has("gmail:healthy-control"));
  assert.equal(run.state.gmail_retry, undefined);
}));

// Emit a stable source census beside the executable sweep. Offsets are found
// in original source, so instrumentation cannot shift the reported locations.
test("FAULT SWEEP source census resolves every declared boundary", () => {
  const census = points.map(point => {
    const source = readFileSync(new URL(`../${point.file}`, import.meta.url), "utf8");
    const start = source.indexOf(point.section);
    const at = source.indexOf(point.needle, start);
    assert.ok(start >= 0 && at >= start, `missing original source site ${point.id}`);
    return { id: point.id, file: point.file, line: source.slice(0, at).split("\n").length,
      branch: point.branch, scope: point.scope || "item", site: point.needle };
  });
  assert.equal(new Set(census.map(point => point.id)).size, census.length);
  console.log(JSON.stringify({ probe: "entry-fault-census", points: census }));
});

test("DEADLINE SWEEP send timeout shares the daily deadline with an unbounded control", async () => {
  const original = AbortSignal.timeout;
  const timeouts = [];
  let sends = 0;
  AbortSignal.timeout = ms => { timeouts.push(ms); return new AbortController().signal; };
  try {
    for (const deadlineAt of [500, Infinity]) await requestIngestBatch({
      base: "https://fixture.invalid", adminKey: ["fixture", "value"].join("-"),
      docs: [{ source_id: "entry" }], deadlineAt, now: () => 0,
      fetchImpl: async () => { sends++; return json({ results: [] }); },
    });
  } finally { AbortSignal.timeout = original; }
  assert.equal(sends, 2, "both real request boundaries reached");
  assert.deepEqual(timeouts, [500, 180000]);
});

test("DEADLINE SWEEP finalization backoff cannot outlive the daily budget", async () => fixture(async f => {
  const clock = { now: 0 };
  f.ids = ["fault-entry", "healthy-control"];
  f.options = { ingestNowMs: () => clock.now, ingestDeadlineAt: 500 };
  // A member retry reaches the same bounded sleep as a transient HTTP result.
  f.respond = docs => json({ results: docs.map(doc => ({ source_id: doc.source_id, status: "failed",
    error: "ingest finalization failed; retry this document" })) });
  f.onSleep = ms => { clock.now += ms; };
  const run = await f.once();
  assert.ok(f.sleeps.length > 0 && f.calls.length > 0, "actual retry and sleep decision reached");
  assert.equal(clock.now, 500, "sleep is clipped to the remaining budget");
  assert.equal(run.error, null, "the expected deadline pauses the saved window");
  assert.equal(run.result.more_history, true);
  assert.equal(run.state.history_id, "prior");
  assert.ok(run.state.gmail_batch_window.remaining_ids.includes("fault-entry"));
  assert.equal(f.forgotten, 0);
}));
