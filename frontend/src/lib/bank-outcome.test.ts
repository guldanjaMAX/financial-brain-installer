import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BankConnection } from "./api";
import { BANK_OVERDUE_SECONDS, bankRowOutcome } from "./bank-outcome";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const connected = (hours: number): BankConnection => ({
  item_ref: "synthetic-bank", institution_label: "Example bank", status: "connected",
  connected_at: new Date(NOW - hours * 3_600_000).toISOString(),
  health: { state: "waiting" },
});

describe("bank row outcome", () => {
  it("mirrors the server's unchanged 48-hour threshold", () => {
    const source = readFileSync(new URL("../../../worker/src/lib/bank-feed-health.js", import.meta.url), "utf8");
    expect(Number(source.match(/export const BANK_OVERDUE_SECONDS = (\d+);/)?.[1])).toBe(BANK_OVERDUE_SECONDS);
    expect(BANK_OVERDUE_SECONDS).toBe(48 * 3_600);
  });

  it("asks for account owners", () => {
    expect(bankRowOutcome({ ...connected(1), accounts_needing_owner: 3 }, NOW)).toBe("NEEDS");
  });

  it.each([null, "BANK_SYNC_PARTIAL"])("calmly loads a recent first sync with code %s", (code) => {
    expect(bankRowOutcome({ ...connected(1), health: { state: code ? "error" : "waiting", last_error_code: code } }, NOW)).toBe("WORKING");
  });

  it("shows a verified healthy bank as Current", () => {
    expect(bankRowOutcome({ ...connected(72), last_synced_at: new Date(NOW - 60_000).toISOString(),
      health: { state: "healthy", last_successful_sync_at: new Date(NOW - 60_000).toISOString() } }, NOW)).toBe("CURRENT");
  });

  it("keeps exactly 48 hours inside the first-sync wait", () => {
    expect(bankRowOutcome(connected(48), NOW)).toBe("WORKING");
    expect(bankRowOutcome(connected(48 + 1 / 3_600_000), NOW)).toBe("PROBLEM");
  });

  it("keeps a 49-hour-old partial bank a Problem (overdue control)", () => {
    expect(bankRowOutcome({ ...connected(49), health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL" } }, NOW)).toBe("PROBLEM");
  });

  it.each(["ITEM_LOGIN_REQUIRED", "BANK_ACCESS_REFERENCE_UNREADABLE", "BANK_SYNC_FAILED", "RATE_LIMIT_EXCEEDED"])("never calms a real error: %s", (code) => {
    expect(bankRowOutcome({ ...connected(1), health: { state: "error", last_error_code: code } }, NOW)).toBe("PROBLEM");
  });

  it.each(["reauth_required", "permission_revoked", "error", "removed", "unknown"])("never calms status %s", (status) => {
    expect(bankRowOutcome({ ...connected(1), status }, NOW)).toBe("PROBLEM");
  });

  it.each([
    { state: "waiting", overdue: true },
    { state: "waiting", pending_overdue: true },
    { state: "waiting", needs_sign_in: true },
    { state: "waiting", needs_reconnect: true },
    { state: "unknown" },
  ])("keeps explicit health problems visible: %j", (health) => {
    expect(bankRowOutcome({ ...connected(1), health }, NOW)).toBe("PROBLEM");
  });

  it("does not treat an earlier successful sync as a first-sync wait", () => {
    expect(bankRowOutcome({ ...connected(1), health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL",
      last_successful_sync_at: new Date(NOW - 60_000).toISOString() } }, NOW)).toBe("PROBLEM");
  });

  it("does not mistake a partial download timestamp for a successful first sync", () => {
    expect(bankRowOutcome({ ...connected(1), last_synced_at: new Date(NOW - 60_000).toISOString(),
      health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL", last_successful_sync_at: null } }, NOW)).toBe("WORKING");
  });

  it.each([null, "invalid", new Date(NOW + 60_000).toISOString()])("requires a known recent connection time: %s", (connected_at) => {
    expect(bankRowOutcome({ ...connected(1), connected_at }, NOW)).toBe("PROBLEM");
  });

  it("keeps recovery review and sign-in visible even while owners are waiting", () => {
    expect(bankRowOutcome({ ...connected(1), replacement_state: "history_review" }, NOW)).toBe("PROBLEM");
    expect(bankRowOutcome({ ...connected(1), accounts_needing_owner: 2, health: { state: "login_required", needs_sign_in: true } }, NOW)).toBe("PROBLEM");
  });
});
