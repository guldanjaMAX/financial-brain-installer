import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Execute the complete pinned production function with boundary replacements.
// This function currently closes over control-plane dependencies, so extracting
// its exact declaration avoids either a credential lookup or a real upload.
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function cmdDeployWithPrompts(");
const end = source.indexOf("\n/**\n * A control-plane prompt owns stdin", start);
assert.ok(start > 0 && end > start);
const deploySource = source.slice(start, end);
function scheduleFixture(arm) {
  let schedules = arm === "present" ? ["* * * * *", "7 6 * * *"] : ["7 6 * * *"];
  const events = [], messages = [];
  let reads = 0, writes = 0;
  const manifest = { client: { slug: "fixture" }, brain: { domain: "brain.invalid", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { d1_database_id: "fixture-db", vectorize_index: "fixture-index" } } };
  const bindings = {
    join, relative, sep, HERE: "/fixture", FormData, Blob,
    loadManifest: () => ({ m: manifest }), bankFeedWorkerVars: () => [],
    readWorkerBankProvider: async () => { throw new Error("provider read must stay unreachable"); },
    assertReviewedAnswerModels: () => {},
    resolveAccount: async () => ({ id: "fixture-account" }),
    collectWorkerFiles: root => [join(root, "index.js")], readFileSync: () => "export default {};",
    workerBindings: () => [], die: message => { throw new Error(message); },
    info: message => messages.push(message), ok: message => messages.push(message), warn: message => messages.push(message),
    cf: async (path, options = {}) => {
      events.push([options.method || "GET", path]);
      if (!path.endsWith("/schedules")) return {};
      if (options.method === "PUT") {
        writes++;
        if (arm !== "lost-write") schedules = options.body.map(row => row.cron);
        return {};
      }
      reads++;
      if (arm === "unreadable" || (arm === "readback-unreadable" && reads > 1)) throw new Error("fixture unavailable inventory");
      if (arm === "missing-inventory") return {};
      return schedules.map(cron => ({ cron }));
    },
  };
  const deploy = new Function(...Object.keys(bindings), `${deploySource}\nreturn cmdDeployWithPrompts;`)(...Object.values(bindings));
  return { run: () => deploy("fixture-manifest", { persistDomain: false, nextSteps: false }),
    state: () => ({ reads, writes, schedules, messages, events }) };
}
for (const arm of ["present", "added", "lost-write", "unreadable", "missing-inventory", "readback-unreadable"]) {
  test(`S2 cron exact readback and preservation: ${arm}`, async () => {
    const f = scheduleFixture(arm);
    let failure;
    try { await f.run(); } catch (error) { failure = error; }
    const state = f.state();
    assert.ok(state.events.some(([method, path]) => method === "PUT" && path.endsWith("/fixture-brain")), "real deployment decision reached");
    assert.ok(state.reads >= 1, "schedule inventory decision reached");
    if (["present", "added"].includes(arm)) {
      assert.equal(failure, undefined);
      assert.ok(state.schedules.includes("7 6 * * *"), "unrelated cron retained");
      assert.ok(state.schedules.includes("* * * * *"));
      assert.equal(state.writes, arm === "present" ? 0 : 1);
      assert.equal(state.reads, arm === "present" ? 1 : 2);
    } else {
      assert.ok(failure, "unknown or missing scheduling proof must fail");
      assert.equal(state.writes, ["unreadable", "missing-inventory"].includes(arm) ? 0 : 1);
      assert.equal(state.messages.some(message => /drain (?:already )?scheduled/.test(message)), false);
    }
  });
}

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { cmdAsk } from "../brain.mjs";
import { refusalConfidence } from "../worker/src/lib/confidence.js";
for (const arm of ["candidates", "no-candidates", "missing-results", "incomplete", "answer"]) {
  test(`S2 CLI refusal scope: ${arm}`, async t => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "scope-answer-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const manifest = join(home, "brain.manifest.json"), keyPath = join(home, "fixture-admin-key");
    writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    writeFileSync(manifest, JSON.stringify({ client: { slug: "fixture" }, brain: { domain: "brain.invalid" },
      credentials: { admin_key: { backend: "file", path: keyPath } } }));
    const candidates = arm === "no-candidates" ? [] : [{ title: "Fixture record" }, { title: "Another fixture record" }];
    const body = { answer: arm === "answer" ? "The fixture supports this answer." : "The documents do not answer the question.",
      results: candidates, evidence_gate: { supported: arm === "answer", reason: "Fixture evidence limit" },
      confidence: refusalConfidence({ resultCount: candidates.length }),
      ...(arm === "incomplete" ? { status: "search_unavailable", degraded: "fts" } : {}) };
    if (arm === "missing-results") delete body.results;
    const printed = [], oldLog = console.log;
    let requests = 0;
    console.log = (...parts) => printed.push(parts.join(" "));
    try {
      await cmdAsk(manifest, { adminKey: readFileSync(keyPath, "utf8"), ask: async () => "Does the fixture support the claim?", http: async (_url, request) => {
        requests++;
        assert.ok(JSON.parse(request.body).q.length > 0, "the real nonempty private query reached dispatch");
        return new Response(JSON.stringify(body), { status: 200 });
      } });
    } finally { console.log = oldLog; }
    assert.equal(requests, 1);
    const text = printed.join("\n");
    assert.doesNotMatch(text, /Confidence nothing is recorded/i);
    if (arm === "incomplete") {
      assert.match(text, /search could not be completed/i);
      assert.doesNotMatch(text, /Confidence[^\n]*%/i);
    } else if (arm === "candidates") {
      assert.match(text, /I found 2 records in this search, but none supported an answer/);
      assert.doesNotMatch(text, /Confidence[^\n]*%/i);
      assert.match(text, /Fixture evidence limit/);
      assert.match(text, /Next: ask about one record at a time/);
    } else if (arm === "no-candidates") {
      assert.match(text, /I didn't find a matching record in this search/);
      assert.doesNotMatch(text, /Confidence[^\n]*%/i);
      assert.match(text, /Fixture evidence limit/);
      assert.match(text, /Next: ask again with a name, date or exact phrase/);
    } else if (arm === "missing-results") {
      assert.match(text, /The records checked did not support an answer to this question/);
      assert.doesNotMatch(text, /I didn't find a matching record|I found 0/);
    }
    else assert.match(text, /fixture supports this answer/);
  });
}
