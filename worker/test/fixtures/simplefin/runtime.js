import { claimSimpleFinAccess, runSimpleFinMaintenance } from "../../../src/lib/simplefin-bank-feed.js";

function check(condition, message) { if (!condition) throw new Error(message); }

// Transport-only D1 double. The Node regression suite executes every SQL
// statement and rollback against real SQLite; this fixture tests native fetch.
function database() {
  let item = null, connection = null, staged = 0;
  const prepare = (sql, params = []) => ({ sql, params,
    bind: (...values) => prepare(sql, values),
    async first() {
      if (/SELECT COUNT\(\*\) n FROM simplefin_stage_transactions/.test(sql)) return { n: staged };
      if (/SELECT backfill_next FROM simplefin_connections/.test(sql)) return connection;
      throw new Error("native database unexpected read");
    },
    async all() {
      if (/SELECT c\.\*,i\.access_ciphertext/.test(sql)) return { results: [{ ...connection, ...item }] };
      if (/SELECT item_ref,backfill_next,backfill_end/.test(sql)) return { results: [connection] };
      if (/FROM simplefin_sync_windows/.test(sql)) return { results: [] };
      throw new Error("native database unexpected listing");
    },
    async run() {
      if (/INSERT INTO bank_feed_items/.test(sql)) item = { item_ref: params[1],
        access_ciphertext: params[2], access_iv: params[3], key_version: params[4], status: "connected" };
      if (/INSERT INTO simplefin_connections/.test(sql)) connection = { item_ref: params[1],
        backfill_start: params[2], backfill_next: params[3], backfill_end: params[4], next_pull_at: params[5] };
      if (/INSERT INTO simplefin_stage_transactions/.test(sql)) staged++;
      return { success: true, meta: { changes: 1 }, results: [] };
    },
  });
  return { prepare, batch: (statements) => Promise.all(statements.map((statement) => statement.run())) };
}

export default {
  async test() {
    // No sockets or network service exists: global fetch reaches only the fake provider.
    const control = await fetch("https://provider.invalid/control", { redirect: "manual" });
    check((await control.json()).fixture === true, "manual-mode native control did not reach provider");
    let unsupported = false;
    try { await fetch("https://provider.invalid/control", { redirect: "error" }); }
    catch (error) { unsupported = error.message.includes("redirect"); }
    check(unsupported, "native engine did not reproduce the rejected redirect mode");
    console.log("native manual-mode control passed");
    const env = { DB: database(), STORAGE: "d1",
      BANK_FEED_PROVIDER: "simplefin", BANK_FEED_ENV: "production",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}` };
    const now = "2026-10-07T12:00:00.000Z";
    const claimUrl = new URL("https://provider.invalid/claim");
    claimUrl.username = "fixture-user"; claimUrl.password = "fixture-password";
    const claim = await claimSimpleFinAccess(env, { now, requestId: "native-runtime-claim-0001",
      setupToken: btoa(claimUrl.href) });
    check(claim.status === 201, "native product claim failed");
    const pull = await runSimpleFinMaintenance(env, { now, maxRequestsPerItem: 1 });
    check(pull.items[0]?.ok === true, "native product pull failed");
    const staged = await env.DB.prepare("SELECT COUNT(*) n FROM simplefin_stage_transactions").first();
    check(staged.n === 1, "native product pull did not stage transaction");
    const calls = await (await fetch("https://provider.invalid/counts", { redirect: "manual" })).json();
    check(calls.claims === 1 && calls.pulls === 1, "native provider decision counts differ");
    const redirectUrl = new URL(claimUrl); redirectUrl.pathname = "/redirect";
    let refused = false;
    try { await claimSimpleFinAccess(env, { now, requestId: "native-runtime-redirect-0001",
      setupToken: btoa(redirectUrl.href) }); }
    catch (error) { refused = error.code === "simplefin_claim_refused"; }
    check(refused, "native redirect was not explicitly refused");
    await fetch("https://provider.invalid/redirect-pulls", { redirect: "manual" });
    const redirected = await runSimpleFinMaintenance(env, { now, maxRequestsPerItem: 1 });
    check(redirected.items[0]?.code === "simplefin_pull_refused", "native pull redirect was not refused");
    console.log("native claim, pull, auth, staging, redirect and provider-count checks passed");
  },
};
