import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { FinanceScopeProvider } from "./FinanceScope";
import { Gate, gatePasskeyFailure } from "./Gate";
import { AddPasskeyContext, BankConnectionsSection, Settings, addPasskeyFailure } from "./Settings";

afterEach(() => vi.unstubAllGlobals());

function supportedPasskeyBrowser() {
  const create = vi.fn();
  const get = vi.fn();
  vi.stubGlobal("window", { PublicKeyCredential: class {} });
  vi.stubGlobal("location", { hostname: "brain.fixture.test" });
  vi.stubGlobal("navigator", { credentials: { create, get } });
  return { create, get };
}

describe("passkey ceremony context", () => {
  it("explains owner enrollment without opening a system prompt during render", () => {
    const credentials = supportedPasskeyBrowser();
    const html = renderToStaticMarkup(
      <Gate owner="Dana Owner" inviteCode="fixture-invite" enrollmentKind="owner" onIn={() => undefined} />,
    );

    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
    expect(html).toContain("What will happen");
    expect(html).toContain("Create my owner passkey");
    expect(html).toContain("Nothing opens until you choose");
    expect(html).toContain("brain.fixture.test");
    expect(html).toContain("material connected to your Brain");
    expect(html).toContain("coverage it cannot prove");
    expect(html).not.toContain("Everything you have written");
    expect(html).toContain("biometric data and device PIN never go to Financial Brain");
    expect(html).toContain("private passkey stays with your device or passkey provider");
    expect(html).toContain("does not connect files, messages, accounts, or other device data");
    expect(html).toContain("Canceling the device prompt does not use it");
    expect(html).not.toContain("Set up with Face ID");
    expect(html).not.toContain("Works on every device");
  });

  it("warns what sign-in will open before the owner clicks", () => {
    const credentials = supportedPasskeyBrowser();
    const html = renderToStaticMarkup(
      <Gate owner="Dana Owner" inviteCode={null} enrollmentKind={null} onIn={() => undefined} />,
    );

    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
    expect(html).toContain("normal passkey window only after you choose the button below");
    expect(html).toContain("answer the system prompt yourself");
    expect(html).toContain("Continue with a passkey");
    expect(html).not.toContain("Welcome back, Dana");
  });

  it("explains document-only recipient scope on mobile before WebAuthn can open", () => {
    const credentials = supportedPasskeyBrowser();
    vi.stubGlobal("window", { PublicKeyCredential: class {}, innerWidth: 390 });
    const html = renderToStaticMarkup(
      <Gate
        owner="Dana Owner"
        inviteCode="doc_fixture-private-invite"
        enrollmentKind="document"
        onIn={() => undefined}
      />,
    );

    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
    expect(html).toContain("Set up your shared document access");
    expect(html).toContain("only the exact documents they chose");
    expect(html).toContain("will not get owner controls or anything else in this Brain");
    expect(html).toContain("Create my passkey for shared access");
    expect(html).toContain("does not make you an owner of the Brain");
    expect(html).toContain("does not connect your files, messages, accounts, or other device data");
    expect(html).not.toContain("your brain is ready");
    expect(html).not.toContain("This verifies that you are the owner");
    expect(html.indexOf("only the exact documents they chose")).toBeLessThan(
      html.indexOf("Create my passkey for shared access"),
    );
  });

  it("puts an explanation between Add a passkey and the device prompt", () => {
    const onContinue = vi.fn();
    const html = renderToStaticMarkup(
      <AddPasskeyContext
        busy={false}
        hostname="brain.fixture.test"
        onContinue={onContinue}
        onCancel={() => undefined}
      />,
    );

    expect(onContinue).not.toHaveBeenCalled();
    expect(html).toContain("Before your device opens a passkey window");
    expect(html).toContain("another owner sign-in");
    expect(html).toContain("Complete that system step yourself");
    expect(html).toContain("Continue to my device");
    expect(html).toContain("Cancel");
  });

  it("turns a missing passkey route into calm context and a real next step", () => {
    const raw404 = new ApiError(404, { error: "not found" }, "HTTP 404");
    const gate = gatePasskeyFailure(raw404, { enrolling: true, rehearsal: false });
    const documentGate = gatePasskeyFailure(raw404, {
      enrolling: true,
      enrollmentKind: "document",
      rehearsal: false,
    });
    const add = addPasskeyFailure(raw404, false);

    expect(gate.unavailable).toBe(true);
    expect(gate.message).toContain("No passkey was enrolled");
    expect(gate.message).toContain("Ask your installer for a fresh private setup link");
    expect(gate.message).not.toContain("404");
    expect(documentGate.unavailable).toBe(true);
    expect(documentGate.message).toContain("No passkey was created, no document was opened");
    expect(documentGate.message).toContain("Ask the Brain owner for a fresh private shared-access link");
    expect(documentGate.message).not.toContain("owner passkey");
    expect(documentGate.message).not.toContain("404");
    expect(add.unavailable).toBe(true);
    expect(add.message).toContain("No passkey was added");
    expect(add.message).toContain("Reload Access once");
    expect(add.message).not.toContain("404");
  });

  it("preserves a real non-404 passkey error", () => {
    const failure = addPasskeyFailure(new Error("The device declined the passkey request."), false);
    expect(failure).toEqual({
      message: "The device declined the passkey request.",
      unavailable: false,
    });
  });

  it("labels passkey actions unavailable in rehearsal before they can look live", () => {
    vi.stubGlobal("window", { PublicKeyCredential: class {} });
    vi.stubGlobal("location", { hostname: "127.0.0.1", search: "?state=populated" });
    const gate = renderToStaticMarkup(
      <Gate owner="Dana Owner" inviteCode="local-rehearsal-only" enrollmentKind="owner" onIn={() => undefined} />,
    );
    const settings = renderToStaticMarkup(
      <FinanceScopeProvider>
        <Settings devices={[]} connections={[]} onChange={() => undefined} />
      </FinanceScopeProvider>,
    );

    expect(gate).toContain("intentionally unavailable in this local rehearsal");
    expect(gate).toContain("On the real page, your device");
    expect(gate).toContain("Passkey setup unavailable here");
    expect(gate).toContain("disabled");
    expect(settings).toContain("Adding a passkey is intentionally unavailable in this local rehearsal");
    expect(settings).toContain("Passkey setup unavailable");
    expect(settings).not.toContain("Continue to my device");
    expect(settings.indexOf("Your passkeys")).toBeLessThan(settings.indexOf("Passkey checks"));
    expect(settings.indexOf("Passkey checks")).toBeLessThan(settings.indexOf("Shared document access"));
    expect(settings.indexOf("Passkey checks")).toBeLessThan(settings.indexOf("Owner preferences"));
  });

  it("explains every owner-side guest access prerequisite in its direct rehearsal", () => {
    vi.stubGlobal("window", { PublicKeyCredential: class {} });
    vi.stubGlobal("location", { hostname: "127.0.0.1", search: "?state=owner-access&view=access" });
    const settings = renderToStaticMarkup(
      <FinanceScopeProvider>
        <Settings devices={[]} connections={[]} onChange={() => undefined} />
      </FinanceScopeProvider>,
    );

    for (const phrase of [
      "What real guest access needs",
      "normal HTTPS address",
      "owner passkey",
      "Shared document access",
      "owner-confirmed financial entity",
      "searchable document assigned to that exact entity",
      "Create exact document access",
      "private, expiring enrollment link",
      "create their own passkey",
      "never owner controls or the whole entity",
      "Revoke ends the access",
    ]) expect(settings).toContain(phrase);
  });

  it("separates read-only remote OAuth access from the local Owner assistant", () => {
    vi.stubGlobal("location", { hostname: "127.0.0.1", search: "?state=owner-access&view=access" });
    const settings = renderToStaticMarkup(
      <FinanceScopeProvider>
        <Settings
          devices={[]}
          connections={[{
            client_id: "app",
            name: "Claude remote connector (Librarian)",
            can_write: false,
            connected_at: Date.now(),
            last_used_at: null,
          }]}
          onChange={() => undefined}
        />
      </FinanceScopeProvider>,
    );

    expect(settings).toContain("Remote apps you approved in a browser with your passkey");
    expect(settings).toContain("Claude remote connector (Librarian)");
    expect(settings).toContain("Reads only");
    expect(settings).toContain("local Claude Code or Codex Owner assistant");
    expect(settings).toContain("does not appear in these remote OAuth rows");
    expect(settings).toContain("brain_remember");
    expect(settings).toContain("explicitly approve the exact proposed record");
    expect(settings).toContain("You are the owner administrator");
    expect(settings).toContain("separate installation and recovery capability");
    expect(settings).toContain("rotate the operator key");
    expect(settings).toContain("approved custody plan");
    expect(settings).not.toContain("Your move, and it is a real one");
  });

  it("renders bank status as loading, unavailable, or intentionally unconfigured instead of hiding it", () => {
    const loading = renderToStaticMarkup(
      <BankConnectionsSection readState="loading" banks={null} busy={false} onDisconnect={() => undefined} />,
    );
    const unavailable = renderToStaticMarkup(
      <BankConnectionsSection readState="unavailable" banks={null} busy={false} onDisconnect={() => undefined} />,
    );
    const unconfigured = renderToStaticMarkup(
      <BankConnectionsSection readState="ready" banks={{ configured: false }} busy={false} onDisconnect={() => undefined} />,
    );
    const configuredEmpty = renderToStaticMarkup(
      <BankConnectionsSection readState="ready" banks={{ configured: true, connections: [] }} busy={false} onDisconnect={() => undefined} />,
    );
    const rehearsalConfigured = renderToStaticMarkup(
      <BankConnectionsSection
        readState="ready"
        banks={{
          configured: true,
          connections: [{ item_ref: "synthetic-bank", institution_label: "Example Bank", status: "healthy" }],
          needs_attention: [],
        }}
        busy={false}
        rehearsal
        onDisconnect={() => undefined}
      />,
    );

    expect(loading).toContain("Until this finishes, the state is unknown");
    expect(unavailable).toContain("cannot say whether a bank is linked");
    expect(unavailable).toContain("not the same as no bank");
    expect(unavailable).toContain("reload Access");
    expect(unconfigured).toContain("not enabled for this Brain");
    expect(unconfigured).toContain("expected state during ordinary onboarding");
    expect(unconfigured).toContain("older records may still exist");
    expect(unconfigured).not.toContain("Connect a bank");
    expect(configuredEmpty).toContain("Starting a new one remains outside ordinary onboarding");
    expect(configuredEmpty).toContain("separately reviewed pilot plan");
    expect(configuredEmpty).not.toContain("Connect a bank");
    expect(rehearsalConfigured).toContain("Bank review and repair are intentionally unavailable");
    expect(rehearsalConfigured).toContain("no real bank is connected");
    expect(rehearsalConfigured).toContain("Repair unavailable in rehearsal");
    expect(rehearsalConfigured).not.toContain("/app/connect/bank");
    expect(rehearsalConfigured).not.toContain("Repair connection");
  });
});
