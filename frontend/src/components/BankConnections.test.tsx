import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BankConnection } from "../lib/api";
import { BankConnectionsSection } from "./Settings";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const loading: BankConnection = {
  item_ref: "synthetic-bank", institution_label: "Example bank", status: "connected",
  connected_at: "2026-11-17T11:00:00.000Z", health: { state: "waiting" },
};
const healthy: BankConnection = {
  ...loading, last_synced_at: "2026-11-17T11:59:00.000Z",
  health: { state: "healthy", last_successful_sync_at: "2026-11-17T11:59:00.000Z" },
};

function render(bank: BankConnection, needsAttention = true, rehearsal = false) {
  const html = renderToStaticMarkup(<BankConnectionsSection readState="ready"
    banks={{ configured: true, connections: [bank], needs_attention: needsAttention ? [bank] : [] }}
    busy={false} rehearsal={rehearsal} onDisconnect={() => { throw new Error("render must not disconnect"); }} />);
  expect(html).toContain("Example bank"); // Every negative assertion reaches an actual bank row.
  return html;
}

describe("Banks status words and connection guards", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([null, "BANK_SYNC_PARTIAL"])("shows a calm first sync with code %s", (code) => {
    const html = render({ ...loading, status_line: "The bank returned incomplete activity; current coverage is not yet verified.",
      health: { state: code ? "error" : "waiting", last_error_code: code } });
    expect(html).toContain("Working on it");
    expect(html).toContain("Loading your transactions");
    expect(html).not.toMatch(/Problem|Not checked yet|Repair connection|incomplete activity|stopped working/);
    expect(html).toContain("Answers about money won&#x27;t include this bank until loading finishes.");
  });

  it("sends waiting account owners to the account choices", () => {
    const html = render({ ...loading, accounts_needing_owner: 3 });
    expect(html).toContain("Needs you");
    expect(html).toContain("3 accounts need an owner.");
    expect(html).toContain('href="/app/connect/bank#accounts"');
    expect(html).toContain("Choose owners");
    expect(html).not.toMatch(/Problem|Repair connection|Access &gt; Banks/);
  });

  it("keeps a partly downloaded first sync calm despite a legacy download timestamp", () => {
    const html = render({ ...loading, last_synced_at: "2026-11-17T11:59:00.000Z",
      health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL", last_successful_sync_at: null } });
    expect(html).toContain("Working on it");
    expect(html).toContain("Loading your transactions");
    expect(html).not.toMatch(/Last checked|Problem|Repair connection|>Disconnect</);
  });

  it("uses singular words for one waiting account", () => {
    expect(render({ ...loading, accounts_needing_owner: 1 })).toContain("1 account needs an owner.");
  });

  it.each(["needs_sign_in", "reauth_required", "permission_revoked"])("retains Problem and Repair for %s (sign-in control)", (reason) => {
    const bank = { ...loading, status: reason === "needs_sign_in" ? "connected" : reason,
      health: { state: "login_required", needs_sign_in: reason === "needs_sign_in", last_error_code: "ITEM_LOGIN_REQUIRED" } };
    const html = render(bank);
    expect(html).toContain("Problem");
    expect(html).toContain("Repair connection");
    expect(html).toContain("mode=reauthorise");
    expect(html).not.toContain(">Disconnect<");
  });

  it.each([
    loading,
    { ...loading, accounts_needing_owner: 2 },
    { ...loading, health: { state: "error", last_error_code: "BANK_SYNC_PARTIAL" } },
    healthy,
  ])("preserves the original attention-set Disconnect guard (control): %j", (bank) => {
    expect(render(bank)).not.toContain(">Disconnect<");
  });

  it("hides Disconnect when local health adds a loading bank to attention (control)", () => {
    expect(render(loading, false)).not.toContain(">Disconnect<");
    expect(render({ ...loading, accounts_needing_owner: 2 }, false)).not.toContain(">Disconnect<");
  });

  it("shows Current without Repair for a healthy bank outside attention", () => {
    const html = render(healthy, false);
    expect(html).toContain("Current");
    expect(html).toContain("Last checked today");
    expect(html).toContain(">Disconnect<");
    expect(html).not.toContain("Repair connection");
  });

  it("keeps Disconnect available for a healthy bank outside attention (green control)", () => {
    expect(render(healthy, false)).toContain(">Disconnect<");
  });

  it("keeps overdue partial syncs a Problem without offering Repair", () => {
    const html = render({ ...loading, connected_at: "2026-11-15T11:00:00.000Z",
      status_line: "No successful bank sync for more than 48 hours.",
      health: { state: "overdue", overdue: true, last_error_code: "BANK_SYNC_PARTIAL" } });
    expect(html).toContain("Problem");
    expect(html).toContain("48 hours");
    expect(html).not.toMatch(/Repair connection|Working on it/);
  });

  it("retains unreadable-access replacement instead of Repair (control)", () => {
    const html = render({ ...loading, health: { state: "needs_reconnect", needs_reconnect: true,
      last_error_code: "BANK_ACCESS_REFERENCE_UNREADABLE" } });
    expect(html).toContain("Problem");
    expect(html).toContain("Replace unreadable connection");
    expect(html).toContain("mode=replace");
    expect(html).not.toMatch(/Repair connection|>Disconnect</);
  });

  it("keeps rehearsal links unavailable, including owner choices (control)", () => {
    expect(render({ ...loading, accounts_needing_owner: 2 }, true, true)).not.toContain('href="/app/connect/bank');
  });
});
