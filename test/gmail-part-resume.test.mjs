import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fixture, dailyFixture } from "./helpers/gmail-batch-fixture.mjs";
import { splitOversized, batchStream } from "../ingest/run.mjs";
import { planGmailParts, acceptGmailPart, clearGmailParts } from "../operations/gmail-part-progress.mjs";
import { processGmailEntries, gmailDeadlineError } from "../operations/gmail-entry.mjs";

const json = results => new Response(JSON.stringify({ results }));
const hash = content => createHash("sha256").update(content).digest("hex");
const body = n => "Ordinary synthetic correspondence. ".repeat(Math.ceil(n / 34)).slice(0, n);

for (const slow of [true, false]) test(`bounded daily split restart: ${slow ? "recurring deadline" : "green control"}`, async () => fixture(async f => {
  f.ids = ["split-entry", "healthy-control"];
  f.content = id => id === "split-entry" ? body(1_200_000) : body(100);
  const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
  f.options = { ingestNowMs: () => clock.now };
  f.captureSaves = false;
  const accepted = new Map();
  const physicalParts = new Map();
  let inventory = 0, persisted = 0, savedCalls = 0;
  f.inventory = args => {
    inventory++;
    if (slow) clock.now += 6000;
    return new Set([...f.stored].filter(uid => args.uids.includes(uid)));
  };
  f.beforeSave = state => {
    if (f.calls.length > savedCalls) {
      if (slow) clock.now += 1000;
      savedCalls = f.calls.length;
    }
    if (state.gmail_part_progress?.["gmail:split-entry"]) persisted++;
  };
  f.respond = docs => {
    if (slow) clock.now += 26000;
    return json(docs.map(doc => {
      const key = doc.source_id;
      accepted.set(key, (accepted.get(key) || 0) + 1);
      const contentHash = hash(doc.content);
      const unchanged = physicalParts.get(key) === contentHash;
      physicalParts.set(key, contentHash);
      f.stored.add(`gmail:${key.split("#part")[0]}`);
      return { source_id: key, status: unchanged ? "unchanged" : "created", chunks: 1 };
    }));
  };
  const decisions = { "gmail:owner-decision": "explicit_deletion" };
  f.stored.add("gmail:owner-decision");
  f.policy = id => id === "owner-decision" ? { allowed: false, source_deleted: true,
    removal_cause: "explicit_deletion", skip: { reason: "synthetic source deletion" } } : { allowed: true };
  f.setState({ ...f.state(), gmail_owner_removals: decisions });
  const first = await dailyFixture(f, clock);
  assert.ok(inventory > 0 && f.calls.length > 0, "real inventory and sender reached");
  if (slow) {
    assert.equal(first.sources[0].status, "deferred");
    assert.equal(accepted.size, 2, "two real split receipts arrived before the next dispatch deadline");
    const state = f.state();
    assert.equal(state.done["gmail:split-entry"], undefined);
    assert.equal(state.history_id, "prior");
    assert.equal(state.gmail_batch_window.remaining_ids.includes("split-entry"), true);
    assert.equal(f.receipts.at(-1).complete_sweep, false);
    assert.equal(accepted.has("healthy-control"), false);
    assert.ok(persisted >= 2, "each accepted physical part was durably recorded");
    const progress = state.gmail_part_progress["gmail:split-entry"];
    assert.equal(progress.revision, "revision");
    assert.equal(Object.keys(progress.parts).length, 2);
    for (const part of Object.values(progress.parts)) {
      assert.match(part.content_hash, /^[a-f0-9]{64}$/);
      assert.equal(part.content_hash, physicalParts.get(part.source_id), "exact accepted provider part readback");
    }
  }
  let runs = 1;
  while (f.state().history_id !== "next" && runs < 3) {
    clock.now += 86400000;
    await dailyFixture(f, clock);
    runs++;
  }
  assert.ok(runs <= Math.ceil(3 / (slow ? 2 : 3)) + 1);
  assert.equal(f.state().done["gmail:split-entry"], "revision");
  assert.equal(f.state().done["gmail:healthy-control"], "revision");
  assert.equal(f.state().history_id, "next");
  assert.deepEqual([...accepted.values()], [1, 1, 1, 1], "no accepted part replayed under the recurring budget");
  assert.deepEqual(f.state().gmail_owner_removals, decisions, "unvisited decision survives");
  assert.equal(f.forgotten, 0);
}));

test("compact real runner converges across fifty parts with one accepted part per run", async () => fixture(async f => {
  f.ids = ["split-entry", "healthy-control"];
  f.content = id => body(id === "split-entry" ? 50 * 128 : 64);
  f.captureSaves = false;
  f.ingestOverrides = {
    splitOversized: envelope => splitOversized(envelope, 128),
    batchStream: (files, prepare, options) => batchStream(files, prepare, { ...options, maxDocs: 1 }),
  };
  const clock = { now: 0 };
  const sent = new Set();
  f.respond = docs => {
    clock.now += 100;
    for (const doc of docs) {
      assert.equal(sent.has(doc.source_id), false, "durably accepted part never resent");
      sent.add(doc.source_id);
      f.stored.add(`gmail:${doc.source_id.split("#part")[0]}`);
    }
    return json(docs.map(doc => ({ source_id: doc.source_id, status: "created", chunks: 1 })));
  };
  let runs = 0;
  while (!f.state().done["gmail:healthy-control"] && runs < 51) {
    f.options = { deferGmailRemovals: true, ingestNowMs: () => clock.now, ingestDeadlineAt: clock.now + 100 };
    const run = await f.once();
    assert.equal(run.error, null, run.error?.message);
    runs++;
    assert.equal(sent.size, runs, "each finite budget accepts exactly one new part or the healthy sibling");
    if (runs < 50) {
      assert.equal(run.state.done["gmail:split-entry"], undefined);
      assert.equal(run.state.history_id, "prior");
      assert.equal(run.receipt.complete_sweep, false);
    }
  }
  assert.equal(runs, Math.ceil(50 / 1) + 1);
  assert.equal(sent.size, 51);
  assert.equal(f.state().done["gmail:healthy-control"], "revision");
  // An exact deadline can defer the cursor-only commit to one fresh budget.
  f.options = { deferGmailRemovals: true, ingestNowMs: () => clock.now, ingestDeadlineAt: clock.now + 100 };
  assert.equal((await f.once()).error, null);
  assert.equal(sent.size, 51, "cursor-only restart sends nothing");
  assert.equal(f.state().history_id, "next");
  assert.equal(f.forgotten, 0);
}));

// Exhaust all prefix deadlines and recurring capacities, rather than dropping
// the budget after the first interruption. Compact real splitting/batching
// keeps the property seconds-long; the default geometry is tested above.
for (let n = 1; n <= 50; n++) test(`part convergence property N=${n}, every prefix and recurring capacity`, async () => {
  let schedules = 0;
  for (let capacity = 1; capacity <= n; capacity++) for (const cold of [false, true]) {
    const envelopes = splitOversized({ source_type: "gmail", source_id: "entry",
      content: body(128 * n), title: "Synthetic correspondence" }, 128);
    assert.equal(envelopes.length, n);
    let durable = JSON.stringify({ done: {} });
    const sent = new Set();
    let runs = 0, settledAt = null, healthy = false;
    const save = state => { durable = JSON.stringify(state); };
    const bound = Math.ceil(n / capacity) + 1;
    while (!healthy && runs <= bound) {
      const state = JSON.parse(durable);
      const limit = cold && runs === 0 ? 0 : capacity;
      let dispatches = 0, deadlineReached = false;
      await processGmailEntries({ ids: ["entry", "healthy"],
        prefetch: async function* (ids, read) { for (const id of ids) yield await read(id); },
        read: async id => id, budgetExpired: () => dispatches >= limit,
        onDeadline: () => { deadlineReached = true; save(state); },
        hold: () => assert.fail("accepted property schedule must never enter item recovery"),
        processEntry: async id => {
          if (id === "healthy") {
            if (dispatches >= limit) throw gmailDeadlineError();
            assert.equal(sent.has(id), false); sent.add(id); dispatches++; healthy = true;
            return;
          }
          if (state.done.entry) return;
          const plan = planGmailParts(state, { stateKey: "entry", revision: "revision",
            envelopes, policyFingerprint: "policy", stored: sent.size > 0,
            currentProof:{parts:envelopes.filter(e=>sent.has(e.source_id))} });
          for await (const group of batchStream([plan], value => ({ envelopes: value.pending }), { maxDocs: 1 })) {
            if (dispatches >= limit) throw gmailDeadlineError();
            const envelope = group[0].envelope;
            assert.equal(sent.has(envelope.source_id), false, "same revision part never sent twice");
            sent.add(envelope.source_id); dispatches++;
            assert.equal(acceptGmailPart(state, "entry", plan, envelope), true);
            save(state);
            const receipt = JSON.parse(durable).gmail_part_progress.entry;
            const part = Object.values(receipt.parts).find(part => part.source_id === envelope.source_id);
            assert.equal(part.content_hash, hash(envelope.content));
          }
          assert.equal(Object.keys(plan.progress.parts).length, n);
          state.done.entry = "revision"; clearGmailParts(state, "entry"); save(state);
          settledAt = runs + 1;
        },
      });
      runs++;
      assert.ok(dispatches <= limit, "every resumed run retains its finite budget");
      if (!JSON.parse(durable).done.entry) {
        assert.ok(deadlineReached, "pending arm reached the actual deadline decision");
        assert.ok(sent.size < n);
      }
    }
    assert.ok(settledAt <= bound, `message settles within ceil(${n}/${capacity})+1`);
    assert.ok(healthy, "later healthy message accepted under the same recurring budget");
    assert.ok(runs <= Math.ceil((n + 1) / capacity) + (cold ? 1 : 0));
    assert.equal(sent.size, n + 1);
    schedules++;
  }
  assert.equal(schedules, 2 * n);
});

test("accepted subset survives a deadline inside the real finalization retry", async () => fixture(async f => {
  f.ids = ["split-entry", "healthy-control"];
  f.content = id => body(id === "split-entry" ? 3 * 128 : 64);
  f.ingestOverrides = { splitOversized: envelope => splitOversized(envelope, 128) };
  const clock = { now: 0 };
  f.options = { deferGmailRemovals: true, ingestNowMs: () => clock.now, ingestDeadlineAt: 100 };
  let pending = true;
  const accepted = [];
  f.respond = docs => json(docs.map(doc => {
    if (pending && doc.source_id.includes("#part2")) return { source_id: doc.source_id,
      status: "failed", error: "ingest finalization failed; retry this document" };
    accepted.push(doc.source_id); f.stored.add(`gmail:${doc.source_id.split("#part")[0]}`);
    return { source_id: doc.source_id, status: "created", chunks: 1 };
  }));
  f.onSleep = ms => {
    assert.equal(Object.keys(f.state().gmail_part_progress["gmail:split-entry"].parts).length, 2,
      "accepted subset is on disk before retry backoff");
    clock.now += ms;
  };
  const first = await f.once();
  assert.equal(first.error, null);
  assert.equal(f.calls.length, 1, "one real batch reached partial finalization");
  assert.equal(f.sleeps.length, 1, "actual retry deadline decision reached");
  assert.equal(first.state.done["gmail:split-entry"], undefined);
  assert.equal(first.state.history_id, "prior");
  pending = false;
  f.options.ingestDeadlineAt = clock.now + 100;
  const second = await f.once();
  assert.equal(second.error, null);
  assert.deepEqual(f.calls[1], ["split-entry#part2of3"], "resume sends only unaccepted middle part");
  assert.equal(new Set(accepted).size, accepted.length, "accepted parts never replay");
  assert.equal(second.state.done["gmail:split-entry"], "revision");
  assert.equal(second.state.done["gmail:healthy-control"], "revision");
  assert.equal(second.state.history_id, "next");
  assert.equal(f.forgotten, 0);
}));

test("changed revision restarts only that message and retains another accepted prefix", async () => fixture(async f => {
  const envelopes = id => splitOversized({ source_type: "gmail", source_id: id,
    title: "Synthetic correspondence", content: body(3 * 128) }, 128);
  const state = f.state();
  for (const id of ["changed-entry", "stable-entry"]) {
    const parts = envelopes(id);
    const plan = planGmailParts(state, { stateKey: `gmail:${id}`, revision: "revision-one", envelopes: parts,
      policyFingerprint: state.gmail_policy_fingerprint, stored: false });
    for (const part of parts.slice(0, 2)) acceptGmailPart(state, `gmail:${id}`, plan, part);
    for (const part of parts.slice(0, 2)) f.remoteParts.set(part.source_id,part);
    f.stored.add(`gmail:${id}`);
  }
  f.setState(state);
  const stable = structuredClone(state.gmail_part_progress["gmail:stable-entry"]);
  f.ids = ["changed-entry", "stable-entry", "healthy-control"];
  f.customEnvelope = id => ({ version: id === "changed-entry" ? "revision-two" : "revision-one",
    envelope: { source_type: "gmail", source_id: id, title: "Synthetic correspondence",
      content: body(id === "healthy-control" ? 64 : 3 * 128) } });
  f.ingestOverrides = { splitOversized: envelope => splitOversized(envelope, 128),
    batchStream: (files, prepare, opts) => batchStream(files, prepare, { ...opts, maxDocs: 1 }) };
  const clock = { now: 0 };
  const accept = f.respond;
  f.respond = docs => { clock.now += 100; return accept(docs); };
  const once = () => {
    f.options = { deferGmailRemovals: true, ingestNowMs: () => clock.now, ingestDeadlineAt: clock.now + 100 };
    return f.once();
  };
  const first = await once();
  assert.equal(first.error, null);
  assert.deepEqual(first.state.gmail_part_progress["gmail:stable-entry"], stable);
  assert.equal(first.state.gmail_part_progress["gmail:changed-entry"].revision, "revision-two");
  assert.equal(Object.keys(first.state.gmail_part_progress["gmail:changed-entry"].parts).length, 1);
  for (let run = 0; run < 5 && f.state().history_id !== "next"; run++) assert.equal((await once()).error, null);
  assert.deepEqual(f.calls.flat(), ["changed-entry#part1of3", "changed-entry#part2of3", "changed-entry#part3of3",
    "stable-entry#part3of3", "healthy-control"]);
  assert.equal(f.state().done["gmail:changed-entry"], "revision-two");
  assert.equal(f.state().done["gmail:stable-entry"], "revision-one");
  assert.equal(f.state().gmail_part_progress, undefined, "logical settlement removes only completed continuations");
  assert.equal(f.forgotten, 0);
}));

test("part receipts require exact identity, hash, revision, geometry, policy and stored family", () => {
  const envelopes = splitOversized({ source_type: "gmail", source_id: "entry", content: body(384) }, 128);
  const args = { stateKey: "gmail:entry", revision: "revision", envelopes, policyFingerprint: "policy", stored: true,
    currentProof:{parts:[envelopes[0]]} };
  const state = {};
  const plan = planGmailParts(state, args);
  assert.equal(acceptGmailPart(state, args.stateKey, plan, envelopes[0]), true);
  assert.equal(acceptGmailPart(state, args.stateKey, plan, envelopes[0]), false, "acceptance itself is idempotent");
  assert.equal(planGmailParts(structuredClone(state), args).accepted, 1, "exact receipt green control");
  for (const patch of [{ revision: "new" }, { policyFingerprint: "new" }, { stored: false }, {currentProof:null},
    { envelopes: envelopes.slice(0, 2) }, { envelopes: envelopes.map(e => ({ ...e, content: e.content + "changed" })) },
    { envelopes: envelopes.map(e => ({ ...e, source_id: e.source_id + "changed" })) }]) {
    const resumed = planGmailParts(structuredClone(state), { ...args, ...patch });
    assert.equal(resumed.accepted, 0, "mismatched proof reached the resume decision and cannot skip a part");
    assert.ok(resumed.pending.length > 0);
  }
  assert.throws(() => acceptGmailPart(state, args.stateKey, plan, { ...envelopes[0], content: "changed" }), /does not match/);
});

test("all part receipts on disk settle after interruption without any message resend", async () => fixture(async f => {
  f.ids = ["split-entry", "healthy-control"];
  f.content = id => body(id === "split-entry" ? 384 : 64);
  f.ingestOverrides = { splitOversized: envelope => splitOversized(envelope, 128) };
  let complete = 0;
  f.beforeSave = state => {
    if (Object.keys(state.gmail_part_progress?.["gmail:split-entry"]?.parts || {}).length === 3 && ++complete === 2) {
      throw Object.assign(new Error("synthetic durable interruption after the last accepted receipt"), { ingestStateWriteFailed: true });
    }
  };
  const first = await f.once();
  assert.ok(first.error && complete >= 2, "post-receipt durable interruption reached");
  assert.equal(f.calls.length, 1);
  assert.equal(first.state.done["gmail:split-entry"], undefined);
  assert.equal(Object.keys(first.state.gmail_part_progress["gmail:split-entry"].parts).length, 3);
  assert.equal(f.stored.has("gmail:healthy-control"), false);
  assert.equal(first.state.history_id, "prior");
  f.beforeSave = null;
  const second = await f.once();
  assert.equal(second.error, null);
  assert.deepEqual(f.calls[1], ["healthy-control"], "zero-send settlement uses all saved receipts");
  assert.equal(f.calls.length, 2);
  assert.equal(second.state.done["gmail:split-entry"], "revision");
  assert.equal(second.state.done["gmail:healthy-control"], "revision");
  assert.equal(second.state.history_id, "next");
  assert.equal(f.forgotten, 0);
}));
