import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BankConnection } from "../lib/api";
import { BankConnectionsSection, Settings } from "./Settings";
import { DocumentAccess } from "./DocumentAccess";
import { FinanceScopeProvider } from "./FinanceScope";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const firstSync: BankConnection = {
  item_ref: "first-sync", institution_label: "Loading bank", status: "connected",
  connected_at: "2026-11-17T11:00:00.000Z", health: { state: "waiting" },
};
const waiting: BankConnection = {
  ...firstSync, item_ref: "waiting", institution_label: "Waiting bank", accounts_needing_owner: 2,
};
const healthy: BankConnection = {
  ...firstSync, item_ref: "healthy", institution_label: "Current bank",
  last_synced_at: "2026-11-17T11:59:00.000Z",
  status_line: "Bank connection is up to date. Last successful sync: 2026-11-17T11:59:00.000Z.",
  health: { state: "healthy", last_successful_sync_at: "2026-11-17T11:59:00.000Z" },
};
const signin: BankConnection = {
  ...firstSync, item_ref: "signin", institution_label: "Sign-in bank", status: "reauth_required",
  status_line: "Your bank needs you to sign in again. Last successful sync: 2026-11-15T11:59:00.000Z. Sign in again, then use Repair connection in Access > Banks.",
  status_detail: "Your bank needs you to sign in again.",
  health: { state: "login_required", needs_sign_in: true, last_error_code: "ITEM_LOGIN_REQUIRED" },
};

function render(connections: BankConnection[]) {
  const html = renderToStaticMarkup(<BankConnectionsSection readState="ready"
    banks={{ configured: true, connections, needs_attention: connections.filter((bank) => bank !== healthy) }}
    busy={false} onDisconnect={() => { throw new Error("render must not disconnect"); }} />);
  for (const bank of connections) expect(html).toContain(bank.institution_label);
  return html;
}

describe("Access bank card layout", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("places a secondary Connect button in the padded card header", () => {
    const header = render([waiting]).match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
    expect(header).toBeDefined();
    expect(header).toContain('href="/app/connect/bank"');
    expect(header).toContain("+ Connect a bank");
    expect(header).toContain("border-line-strong");
  });

  it("gives an owner-waiting row one padded button for account choices", () => {
    const html = render([waiting]);
    const choice = html.match(/<a[^>]+href="\/app\/connect\/bank#accounts"[^>]*>/)?.[0];
    expect(choice).toBeDefined();
    expect(choice).toContain("min-h-11");
    expect(choice).toContain("px-4");
  });

  it("keeps owner choices visible when an overdue sync takes priority", () => {
    const html = render([{
      ...waiting, accounts_needing_owner: 14,
      connected_at: "2026-11-13T12:00:00.000Z",
      last_synced_at: "2026-11-14T12:00:00.000Z",
      status_line: "No successful bank sync for more than 48 hours.",
      health: { state: "overdue", overdue: true, last_successful_sync_at: "2026-11-14T12:00:00.000Z" },
    }]);
    expect(html).toContain(">Problem<");
    expect(html).toContain("No successful bank sync for more than 48 hours.");
    expect(html).toContain("Code BANK_SYNC_FAILED");
    expect(html).toContain("14 accounts need an owner.");
    expect(html).toMatch(/href="\/app\/connect\/bank#accounts"[^>]*>Choose owners<\/a>/);
    // Exclude the section's Connect action; this real row has exactly one action.
    const row = html.split("Waiting bank")[1];
    expect(row.match(/<button\b|<a\b/g)).toHaveLength(1);
    expect(row).not.toContain(">Disconnect<");
  });

  it.each(["signin", "replacement"])("retains the owner count and single recovery action for %s", (recovery) => {
    const bank = recovery === "signin" ? { ...signin, accounts_needing_owner: 14 } : {
      ...waiting, accounts_needing_owner: 14,
      health: { state: "needs_reconnect", needs_reconnect: true, last_error_code: "BANK_ACCESS_REFERENCE_UNREADABLE" },
    };
    const html = render([bank]);
    expect(html).toContain(">Problem<");
    expect(html).toContain(recovery === "signin" ? "Repair connection" : "Replace unreadable connection");
    expect(html).toContain(recovery === "signin" ? "Code ITEM_LOGIN_REQUIRED" : "Code BANK_ACCESS_REFERENCE_UNREADABLE");
    expect(html).toContain("14 accounts need an owner.");
    const row = html.split(bank.institution_label!)[1];
    expect(row.match(/<button\b|<a\b/g)).toHaveLength(1);
    expect(row).not.toContain("Choose owners");
    expect(row).not.toContain(">Disconnect<");
  });

  it("does not repeat the count in the calm owner-choice row (green control)", () => {
    const html = render([waiting]);
    expect(html).toContain(">Needs you<");
    expect(html.match(/2 accounts need an owner\./g)).toHaveLength(1);
    expect(html).toContain(">Choose owners</a>");
  });

  it("gives the Technical details summary its own 44 px target", () => {
    const html = renderToStaticMarkup(<FinanceScopeProvider><Settings devices={[]} connections={[]} onChange={() => undefined} /></FinanceScopeProvider>);
    const summary = html.match(/<summary[^>]*>Technical details for your installer<\/summary>/)?.[0];
    expect(summary).toBeDefined();
    expect(summary).toContain("min-h-11");
  });

  it("shows one Problem code line and one repair action across four distinct states", () => {
    const html = render([waiting, firstSync, healthy, signin]);
    expect(html).toContain("Code ITEM_LOGIN_REQUIRED");
    expect(html.match(/Your bank needs you to sign in again\./g)).toHaveLength(1);
    expect(html.match(/>Problem</g)).toHaveLength(1);
    expect(html.match(/>Working on it</g)).toHaveLength(1);
    // Each name begins a real row; count both button elements and links styled as actions.
    const rows = html.split(/(?:Waiting bank|Loading bank|Current bank|Sign-in bank)/).slice(1);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect((row.match(/<button\b|<a\b/g) || []).length).toBeLessThanOrEqual(1);
  });

  it("formats dates in joined server text and keeps extra sentences in closed Details", () => {
    const html = render([signin]);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(html).toMatch(/<details\b[^>]*><summary[^>]*>Details<\/summary>/);
    expect(html).not.toMatch(/<details\b[^>]*\bopen/);
    expect(html).toContain("Last successful sync:");
  });

  it("keeps healthy rows to the single last-checked line", () => {
    const html = render([healthy]);
    expect(html).toContain("Current");
    expect(html).not.toContain("Last successful sync");
  });

  it("retains a masked provider explanation when sign-in also needs attention", () => {
    const html = render([{ ...signin, status_line: "The bank asked for another identity check. Try again after completing that check." }]);
    expect(html).toContain("The bank asked for another identity check.");
    expect(html).toContain("Try again after completing that check.");
  });

  it("shows a joined detail sentence only once", () => {
    const detail = "The bank needs review. Your saved history stays available.";
    const html = render([{ ...firstSync, status: "error", status_detail: detail }]);
    expect(html.match(/The bank needs review\./g)).toHaveLength(1);
    expect(html.match(/Your saved history stays available\./g)).toHaveLength(1);
  });

  it("uses a short loading line and insets the unavailable notice", () => {
    const loading = renderToStaticMarkup(<BankConnectionsSection readState="loading" banks={null} busy={false} onDisconnect={() => undefined} />);
    expect(loading).toContain("Checking your banks…");
    const unavailable = renderToStaticMarkup(<BankConnectionsSection readState="unavailable" banks={null} busy={false} onDisconnect={() => undefined} />);
    expect(unavailable).toContain("cannot say whether a bank is linked");
    expect(unavailable).toContain("m-4 rounded-xl");
  });

  it("keeps L2's states, coverage caveat, and healthy Disconnect (green control)", () => {
    const html = render([waiting, firstSync, healthy, signin]);
    expect(html).toContain("Needs you");
    expect(html).toContain("Working on it");
    expect(html).toContain("Current");
    expect(html).toContain("Problem");
    expect(html).toContain("Answers about money won&#x27;t include this bank until loading finishes.");
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
    expect(html.match(/mode=reauthorise/g)).toHaveLength(1);
  });

  it("explains exact-document sharing in owner words without changing its scope", () => {
    const html = renderToStaticMarkup(<FinanceScopeProvider><DocumentAccess /></FinanceScopeProvider>);
    expect(html).toContain("Shared document access");
    expect(html).toContain("Choosing a person or business only helps you find documents. It does not share everything they own.");
    expect(html).toContain("Each access link is limited to the documents you choose, and that list cannot be changed.");
  });
});
