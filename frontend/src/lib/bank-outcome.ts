import type { BankConnection } from "./api";
import type { OutcomeKey } from "./outcome";

// Presentation only. The server's health, exceptions and answer confidence stay authoritative.
// Keep this mirror pinned to bank-feed-health.js with the equality test.
export const BANK_OVERDUE_SECONDS = 172800;

export function bankRowOutcome(bank: BankConnection, now: number): OutcomeKey {
  const health = bank.health;
  const code = health?.last_error_code;
  if (bank.status !== "connected" || health?.overdue || health?.pending_overdue ||
      health?.needs_sign_in || health?.needs_reconnect || bank.replacement_ref ||
      bank.replacement_state === "history_review" ||
      (health && !["healthy", "waiting", "error"].includes(health.state)) ||
      (code && code !== "BANK_SYNC_PARTIAL")) return "PROBLEM";

  if ((bank.accounts_needing_owner || 0) > 0) return "NEEDS";

  // Partial promotions advance the legacy timestamp too. When health exists,
  // only its complete-sync receipt can end the first-sync wait.
  const success = health ? health.last_successful_sync_at : bank.last_synced_at;
  if (health?.state === "healthy" && !code) return "CURRENT";

  const age = now - Date.parse(bank.connected_at || "");
  if (!success && Number.isFinite(age) && age >= 0 && age <= BANK_OVERDUE_SECONDS * 1000 &&
      (code === "BANK_SYNC_PARTIAL" || !health || health.state === "waiting")) return "WORKING";
  return "PROBLEM";
}
