import { bankAccessWrappingKeyConfigured } from "./bank-feed.js";
import { BANK_PENDING_OVERDUE_SECONDS, bankConnectionHealth } from "./bank-feed-health.js";

const CACHE_MS = 60_000;
const MAX_BANK_LINKS = 64;
const ANSWER_LOG_WINDOW = 256;
const unknown = Object.freeze({ bank: "unknown", answers: "unknown" });
const cache = new WeakMap();
const ANSWER_CHECK_LABEL = "answer-check-outcome";
const ACTIVE_RECONCILIATION = new Set(["pending", "running", "retryable"]);

export function answerCheckModels(env) {
  // Packaged deploys set this binding explicitly. The built-in default keeps
  // direct and unbound invocations on the public no-key path.
  const answer = env.ANSWER_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  return [answer, env.GATE_MODEL || answer];
}

export async function recordAnswerCheck(db, answer, gate) {
  const statuses = [answer.status, gate.status];
  // An unchecked built-in model cannot be evidence of success. A known
  // failure still takes precedence when its sibling was unchecked.
  const status = statuses.some(value => value !== "ok" && value !== "built_in") ? "error"
    : statuses.every(value => value === "ok") ? "ok" : "unknown";
  const stamp = new Date().toISOString();
  cache.delete(db);
  await db.prepare(`
    INSERT INTO llm_call_log (ts,day,label,model,status,est_cost_usd_micros)
    VALUES (?,?,?,?,?,0)
  `).bind(stamp, stamp.slice(0, 10), ANSWER_CHECK_LABEL,
    JSON.stringify([answer.model, gate.model]), status).run();
  cache.delete(db);
}

function evidenceTime(value) {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const canonical = new Date(parsed).toISOString();
  return value === canonical || value === canonical.replace(/\.000Z$/, "Z") ? parsed : NaN;
}

function healthyBankLink(row, now) {
  const success = evidenceTime(row.last_successful_sync_at);
  if (row.status !== "connected" || !Number.isFinite(success) || success > now ||
      bankConnectionHealth(row, now).state !== "healthy") return false;

  // Validate each required clock before combining it with an optional
  // provider cooldown. A valid sibling must never hide a malformed clock.
  const schedules = [];
  if (row.has_simplefin) schedules.push([row.next_pull_at]);
  if (ACTIVE_RECONCILIATION.has(row.reconciliation_state)) {
    schedules.push(row.provider_retry_not_before === null ? [row.due_at]
      : [row.due_at, row.provider_retry_not_before]);
  }
  return schedules.every(fields => {
    const times = fields.map(evidenceTime);
    return times.every(Number.isFinite) &&
      now - Math.max(...times) <= BANK_PENDING_OVERDUE_SECONDS * 1000;
  });
}

async function readBankFlag(db, tenant, keyConfigured, now) {
  // The live-item index scopes the scan. Each joined status row is keyed by
  // tenant and item. Keep account, institution and credential columns out.
  const { results } = await db.prepare(`
    SELECT i.status,i.connected_at,h.last_attempt_at,h.last_successful_sync_at,
      CASE WHEN r.last_error_code='BANK_ACCESS_REFERENCE_UNREADABLE'
        THEN r.last_error_code ELSE h.last_error_code END AS last_error_code,
      c.item_ref IS NOT NULL AS has_simplefin,c.next_pull_at,
      r.state AS reconciliation_state,r.due_at,r.provider_retry_not_before
    FROM bank_feed_items i
    LEFT JOIN bank_feed_health h ON h.tenant_id=i.tenant_id AND h.item_ref=i.item_ref
    LEFT JOIN plaid_reconciliation r ON r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref
    LEFT JOIN simplefin_connections c ON c.tenant_id=i.tenant_id AND c.item_ref=i.item_ref
    WHERE i.tenant_id=? AND i.removed_at IS NULL LIMIT ?
  `).bind(tenant, MAX_BANK_LINKS + 1).all();
  if (results.length === 0) return "none";
  if (!keyConfigured || results.some(row => !healthyBankLink(row, now))) return "needs_attention";
  return results.length <= MAX_BANK_LINKS ? "ok" : "unknown";
}

async function readAnswerFlag(db, configuration) {
  // Walk the existing integer primary key backwards. The check label has no
  // index, so limit the tail before filtering, including when no check exists.
  const row = await db.prepare(`
    SELECT model,status FROM (
      SELECT id,label,model,status FROM llm_call_log ORDER BY id DESC LIMIT ?
    ) WHERE label=? ORDER BY id DESC LIMIT 1
  `).bind(ANSWER_LOG_WINDOW, ANSWER_CHECK_LABEL).first();
  if (row?.model !== configuration) return "unknown";
  if (row?.status === "ok") return "ok";
  if (["blocked", "error", "timeout"].includes(row?.status)) return "needs_attention";
  return "unknown";
}

export async function publicHealthFlags(env, activeD1, now = Date.now()) {
  if (!activeD1) return unknown;
  const db = env.DB;
  if (typeof db?.prepare !== "function") return unknown;
  const tenant = String(env.BANK_FEED_TENANT || "primary");
  const keyConfigured = bankAccessWrappingKeyConfigured(env);
  const configuration = JSON.stringify(answerCheckModels(env));
  const cached = cache.get(db);
  if (cached?.tenant === tenant && cached.keyConfigured === keyConfigured &&
      cached.configuration === configuration && now < cached.expires) {
    return cached.flags;
  }

  const [bank, answers] = await Promise.all([
    readBankFlag(db, tenant, keyConfigured, now).catch(() => "unknown"),
    readAnswerFlag(db, configuration).catch(() => "unknown"),
  ]);
  const flags = { bank, answers };
  // Cache settled flag values. D1 promises belong to the request that starts them.
  cache.set(db, { tenant, keyConfigured, configuration, expires: now + CACHE_MS, flags });
  return flags;
}
