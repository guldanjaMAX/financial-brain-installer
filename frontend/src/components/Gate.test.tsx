import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { explainCeremonyFailure } from "../lib/passkey";
import { FinanceScopeProvider } from "./FinanceScope";
import { Gate, gatePasskeyFailure } from "./Gate";
import { AddPasskeyContext, BankConnectionsSection, DISCONNECT_BANK_QUESTION, Settings, addPasskeyFailure } from "./Settings";

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
    expect(html).toContain("Here is what happens next");
    expect(html).toContain("Tap the button below. Your device will open its secure passkey window and ask for Face ID, Touch ID, or your screen lock. No password is needed.");
    expect(html).toContain("How this keeps you safe");
    expect(html).toContain("Create my owner passkey");
    expect(html).toContain("brain.fixture.test");
    // The owner scope, privacy and Cancel sentences are in view, before the
    // collapsed section, not hidden inside it.
    for (const visible of [
      "This verifies that you are the owner and protects your private owner area",
      "cannot see or store your passkey, Face ID, fingerprint, or device PIN",
      "choose Cancel. Nothing is enrolled.",
    ]) {
      expect(html).toContain(visible);
      expect(html.indexOf(visible)).toBeLessThan(html.indexOf("<details"));
    }
    expect(html).toContain("Canceling the device prompt does not use it");
    expect(html).toContain("material connected to your Brain");
    expect(html).toContain("coverage it cannot prove");
    expect(html).not.toContain("Everything you have written");
    expect(html).toContain("biometric data and device PIN never go to Financial Brain");
    expect(html).toContain("private passkey stays with your device or passkey provider");
    expect(html).toContain("does not connect your files, messages, accounts, or other device data");
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
    expect(html).toContain("New computer? In the passkey window choose to use your phone, then scan the code with the phone you set up. Lost your phone? Ask for a new setup link.");
    expect(html).not.toContain("Welcome back, Dana");
  });

  it("does not show browser exception names after a canceled passkey window", () => {
    const failure = explainCeremonyFailure(
      { name: "NotAllowedError" },
      "brain.fixture.test",
      "sign_in",
    );
    expect(failure.message).toContain("prompt was dismissed");
    expect(failure.message).not.toContain("NotAllowedError");
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
    for (const visible of [
      "does not make you an owner of the Brain",
      "It unlocks only the exact shared documents already chosen by the Brain owner.",
      "cannot see or store your passkey, Face ID, fingerprint, or device PIN",
      "choose Cancel. Nothing is enrolled.",
    ]) {
      expect(html).toContain(visible);
      expect(html.indexOf(visible)).toBeLessThan(html.indexOf("<details"));
    }
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

  it("maps used setup links and rejected sign-ins to owner recovery choices", () => {
    const expiredLinks = [
      "a valid enrollment link is required",
      "the enrollment link is invalid, expired, or already used",
    ].map((error) => gatePasskeyFailure(
      new ApiError(403, { error }),
      { enrolling: true, enrollmentKind: "owner", rehearsal: false },
    ));
    const unknownPasskey = gatePasskeyFailure(
      new ApiError(403, { error: "unknown passkey" }),
      { enrolling: false, rehearsal: false },
    );
    const expiredChallenge = gatePasskeyFailure(
      new ApiError(403, { error: "unknown or expired challenge" }),
      { enrolling: false, rehearsal: false },
    );

    for (const expired of expiredLinks) {
      expect(expired).toEqual({
        message: "This setup link has expired or was already used. Links work once and expire 15 minutes after they're made. If you already made a passkey on this device, choose Sign in instead. Otherwise ask for a new link.",
        unavailable: true,
        allowSignIn: true,
      });
    }
    expect(unknownPasskey.message).toContain("doesn't recognize this passkey");
    expect(expiredChallenge.message).toContain("sign-in expired");
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
    expect(gate).toContain("Tap the button below");
    expect(gate).toContain("Passkey setup unavailable here");
    expect(gate).toContain("disabled");
    expect(settings).toContain("Adding a passkey is intentionally unavailable in this local rehearsal");
    expect(settings).toContain("Passkey setup unavailable");
    expect(settings).not.toContain("Continue to my device");
    const ordered = ["Your passkeys", "Connected AI", "Banks", "Shared document access", "Owner preferences", "Signing out"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(settings.indexOf(ordered[index - 1])).toBeLessThan(settings.indexOf(ordered[index]));
    }
    expect(settings).toContain("Technical details for your installer");
    expect(settings).toContain("<details");
    expect(settings.indexOf("Signing out")).toBeLessThan(settings.indexOf("Passkey checks"));
  });

  it("names the real host on the real page and never a loopback host in rehearsal", () => {
    const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
    vi.stubGlobal("window", { PublicKeyCredential: class {} });
    for (const enrollmentKind of ["owner", "document"] as const) {
      vi.stubGlobal("location", { hostname: "fixture-brain.example", search: "" });
      const real = renderToStaticMarkup(
        <Gate owner="Dana Owner" inviteCode="fixture-invite" enrollmentKind={enrollmentKind} onIn={() => undefined} />,
      );
      expect(real).toContain("Check that this page is at <strong>fixture-brain.example</strong>.");
      expect(real).not.toContain("What happens on the real");

      const address = enrollmentKind === "document" ? "that Brain&#x27;s normal web address" : "your Brain&#x27;s normal web address";
      for (const loopback of loopbackHosts) {
        vi.stubGlobal("location", { hostname: loopback, search: "?state=populated" });
        const rehearsal = renderToStaticMarkup(
          <Gate owner="Dana Owner" inviteCode="local-rehearsal-only" enrollmentKind={enrollmentKind} onIn={() => undefined} />,
        );
        expect(rehearsal).toContain(enrollmentKind === "document"
          ? "What happens on the real shared-access page"
          : "What happens on the real setup page");
        expect(rehearsal).toContain(`Check that this page is at <strong>${address}</strong>. If the address or secure window looks unexpected, choose Cancel. Nothing is enrolled.`);
        for (const host of loopbackHosts) expect(rehearsal).not.toContain(host);
        expect(rehearsal).not.toContain("fixture-brain.example");
      }
    }
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
    expect(settings).toContain("https://127.0.0.1/mcp");
    expect(settings).toContain("Copy");
    expect(settings).toContain("In Claude on the web, open Settings, then Connectors, then Add custom connector.");
    expect(settings).toContain("Paste this address.");
    expect(settings).toContain("approve with your passkey");
    expect(settings).toContain("It then works in the Claude phone app too.");
    expect(settings).toContain("Claude remote connector (Librarian)");
    expect(settings).toContain("Reads only");
    expect(settings).toContain("Claude Code or Codex on your computer is connected separately and isn&#x27;t listed here.");
    expect(settings).not.toContain("brain_remember");
    expect(settings).toContain("Your installer also holds a recovery key. At handoff, ask them to replace it and tell you where the new one is kept.");
    expect(settings).not.toContain("Display-currency conversion and fiscal-year grouping");
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
    expect(unconfigured).toContain("Bank connections aren&#x27;t set up for this Brain yet. Your installer can turn them on.");
    expect(unconfigured).not.toContain("Connect a bank");
    expect(configuredEmpty).toContain("Connect a bank");
    expect(configuredEmpty).toContain('href="/app/connect/bank"');
    expect(rehearsalConfigured).toContain("Bank review and repair are intentionally unavailable");
    expect(rehearsalConfigured).toContain("no real bank is connected");
    expect(rehearsalConfigured).toContain("Repair unavailable in rehearsal");
    expect(rehearsalConfigured).not.toContain("/app/connect/bank");
    expect(rehearsalConfigured).not.toContain("Repair connection");
  });

  it("shows a connection waiting on account owner choices as one plain sentence", () => {
    const detail = "2 accounts need an owner choice before their transactions can load. Choose who owns each account on the Connect a bank page.";
    const waiting = renderToStaticMarkup(
      <BankConnectionsSection
        readState="ready"
        banks={{
          configured: true,
          connections: [{ item_ref: "synthetic-bank", institution_label: "Example Bank", status: "connected", status_detail: detail }],
          needs_attention: [{ item_ref: "synthetic-bank", institution_label: "Example Bank", status: "connected" }],
        }}
        busy={false}
        onDisconnect={() => undefined}
      />,
    );
    expect(waiting).toContain(`${detail} Answers about money`);
    expect(waiting).toContain("Connect another bank or choose account owners");
    expect(DISCONNECT_BANK_QUESTION).toBe("Disconnect this bank? New transactions stop. Your saved history stays.");
    expect(waiting).not.toContain("page..");
  });
});
