import assert from "node:assert/strict";
import test from "node:test";
import * as gmail from "../connectors/gmail.mjs";
import { fixture, dailyFixture } from "./helpers/gmail-batch-fixture.mjs";

const ownerLine = "Google asked us to slow down. Gmail will continue on the next run.";
const json = (body, status = 200, headers) => Response.json(body, { status, headers });
const quota = (reason = "rateLimitExceeded", status = 403, headers) =>
  json({ error: { errors: [{ reason }] } }, status, headers);

function provider(f, reply) {
  let now = Date.parse("2026-01-01T12:00:00Z");
  const waits = [];
  const calls = [];
  const clock = { get now() { return now; } };
  const token = async () => "";
  const fetchImpl = async url => {
    const id = url.pathname.split("/").at(-1);
    const format = url.searchParams.get("format");
    calls.push({ id, format, pageToken: url.searchParams.get("pageToken") });
    const response = await reply({ id, format });
    if (response) return response;
    if (id === "history") return json({ historyId: "next", history: [{
      id: "101", messagesAdded: f.ids.map(id => ({ message: { id } })),
    }] });
    return json({ labelIds: ["INBOX"], ...(format === "raw" ? {
      raw: Buffer.from("Subject: Synthetic mail\r\n\r\nOrdinary invented correspondence for the offline storage probe.").toString("base64url"),
    } : {}) });
  };
  const opts = options => ({ ...options, fetchImpl, sleep: async ms => { waits.push(ms); now += ms; } });
  f.options = {
    ingestNowMs: () => now,
    gmailQuotaSleep: async ms => { waits.push(ms); now += ms; },
    gmailQuotaRandom: () => 0.5,
    gmail: {
      listHistory: (_token, marker, options) => gmail.listHistory(token, marker, opts(options)),
      messagePolicy: (_token, id, options) => gmail.messagePolicy(token, id, opts(options)),
      toEnvelope: (_token, id, meta, options) => gmail.toEnvelope(token, id, meta, opts(options)),
    },
  };
  return { calls, waits, clock };
}

for (const header of ["7", "Thu, 01 Jan 2026 12:00:07 GMT"]) {
  test(`mid-page quota honors Retry-After ${header} and serializes subsequent Gmail fetches`, async () => fixture(async f => {
    f.ids = Array.from({ length: 20 }, (_, i) => `mail-${String(i).padStart(2, "0")}`);
    let throttled = false;
    let active = 0;
    let peakAfterPause = 0;
    const { calls, waits } = provider(f, async ({ id, format }) => {
      if (id === "mail-02" && format === "raw" && !throttled) {
        throttled = true;
        return quota("rateLimitExceeded", 403, { "Retry-After": header });
      }
      active++;
      await new Promise(resolve => setImmediate(resolve));
      if (waits.length) peakAfterPause = Math.max(peakAfterPause, active);
      active--;
    });
    const run = await f.once();
    assert.ifError(run.error);
    assert.deepEqual(waits, [7000]);
    assert.equal(peakAfterPause, 1);
    assert.equal(calls.filter(call => call.id === "mail-02" && call.format === "raw").length, 2);
    assert.equal(f.stored.size, f.ids.length);
    assert.equal(run.state.history_id, "next");
    assert.equal(run.result.complete, true);
  }));
}

test("persistent quota saves the remaining window and resumes without fetching accepted mail", async () => fixture(async f => {
  f.ids = ["accepted", "pending", "sibling"];
  let limited = true;
  const { calls, waits } = provider(f, async ({ id, format }) => {
    if (limited && id === "pending" && format === "raw") {
      await new Promise(resolve => setImmediate(resolve));
      return quota("userRateLimitExceeded");
    }
  });
  const first = await f.once({ only: "gmail" }, {});
  assert.ifError(first.error);
  assert.equal(first.result.partial, 1);
  assert.equal(first.result.more_history, true);
  assert.match(first.output, /Google asked us to slow down\. Gmail will continue on the next run\./);
  assert.equal(first.state.history_id, "prior");
  assert.deepEqual(first.state.gmail_batch_window.remaining_ids, ["pending"]);
  assert.deepEqual([...f.stored].sort(), ["gmail:accepted", "gmail:sibling"]);
  assert.ok(waits.length > 1 && waits[1] > waits[0]);
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 120000);
  limited = false;
  calls.length = 0;
  const second = await f.once();
  assert.ifError(second.error);
  assert.deepEqual(calls.map(call => call.id), ["pending"]);
  assert.equal(second.state.history_id, "next");
  assert.equal(second.result.complete, true);
}));

test("daily quota deferral makes one attempt when Retry-After exceeds the budget", async () => fixture(async f => {
  const providerText = "Invented provider detail";
  const { calls, waits, clock } = provider(f, () => json(
    { error: { message: providerText } }, 429, { "Retry-After": "600" },
  ));
  const daily = await dailyFixture(f, clock);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(daily.sources[0].status, "deferred");
  assert.equal(daily.sources[0].reason, ownerLine);
  assert.equal(f.receipts.at(-1).provider_check_complete, false);
  assert.ok(!JSON.stringify([daily, f.receipts]).includes(providerText));
  assert.equal(f.state().history_id, "prior");
}));

test("quota on every call preserves the saved history page token for the next run", async () => fixture(async f => {
  f.ids = ["later-mail"];
  const saved = { version: 1, start_history_id: "prior", page_token: "later-page", offset: 0, digest: null };
  f.setState({ ...f.state(), gmail_history_continuation: saved });
  let limited = true;
  const { calls } = provider(f, () => {
    if (limited) return quota("quotaExceeded");
  });
  const first = await f.once();
  assert.ifError(first.error);
  assert.equal(first.result.complete, false);
  assert.ok(calls.length > 5);
  assert.ok(calls.every(call => call.id === "history" && call.pageToken === "later-page"));
  assert.deepEqual(first.state.gmail_history_continuation, saved);
  limited = false;
  calls.length = 0;
  const second = await f.once();
  assert.ifError(second.error);
  assert.equal(calls[0].pageToken, "later-page");
  assert.equal(second.state.history_id, "next");
  assert.equal(second.result.complete, true);
}));

test("healthy Gmail retains parallel fetches and completes without quota waits", async () => fixture(async f => {
  f.ids = ["mail-a", "mail-b", "mail-c", "mail-d"];
  let active = 0;
  let peak = 0;
  const { waits } = provider(f, async ({ format }) => {
    if (format !== "raw") return;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  });
  const run = await f.once();
  assert.ifError(run.error);
  assert.ok(peak > 1);
  assert.deepEqual(waits, []);
  assert.equal(run.result.complete, true);
  assert.equal(run.state.history_id, "next");
  assert.equal(f.stored.size, 4);
}));
