import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { explainCeremonyFailure } from "../lib/passkey";
import { FinanceScopeProvider } from "./FinanceScope";
import { Gate, gatePasskeyFailure } from "./Gate";
import { AddPasskeyContext, BankConnectionsSection, DISCONNECT_BANK_QUESTION, Settings, addPasskeyFailure } from "./Settings";

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: vi.fn(original.useState) };
});

afterEach(async () => {
  const original = await vi.importActual<typeof import("react")>("react");
  vi.mocked(React.useState).mockImplementation(original.useState);
  vi.unstubAllGlobals();
});

function supportedPasskeyBrowser() {
  const create = vi.fn();
  const get = vi.fn();
  vi.stubGlobal("window", { PublicKeyCredential: class {} });
  vi.stubGlobal("location", { hostname: "brain.fixture.test" });
  vi.stubGlobal("navigator", { credentials: { create, get } });
  return { create, get };
}

// Exercise the component's actual click handlers and passkey client without
// adding a DOM dependency. State slots also let the expired-invite recovery
// button be reached through the same first failed click as in the browser.
function signInHarness(search: string, inviteCode: string | null = null) {
  const credentials = supportedPasskeyBrowser();
  credentials.get.mockResolvedValue({
    id: "fixture-credential",
    response: {
      authenticatorData: new Uint8Array([1]).buffer,
      clientDataJSON: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
    },
  });
  const assign = vi.fn();
  const replaceState = vi.fn();
  const onIn = vi.fn();
  vi.stubGlobal("location", { hostname: "brain.invalid", search, assign });
  vi.stubGlobal("history", { replaceState });
  const fetch = vi.fn(async (path: string) => {
    if (path === "/auth/register/options") {
      return Response.json({ error: "the enrollment link is invalid, expired, or already used" }, { status: 403 });
    }
    if (path === "/auth/login/options") {
      return Response.json({ challenge: "Zml4dHVyZQ", rp_id: "brain.invalid" });
    }
    if (path === "/auth/login/verify") return Response.json({ ok: true });
    throw new Error("unexpected fixture request");
  });
  vi.stubGlobal("fetch", fetch);

  const states: unknown[] = [];
  let cursor = 0;
  const useState = ((initial: unknown) => {
    const slot = cursor++;
    if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
    return [states[slot], (value: unknown) => { states[slot] = value; }];
  }) as typeof React.useState;
  vi.mocked(React.useState).mockImplementation(useState);

  function tree() {
    cursor = 0;
    return Gate({ owner: "Fixture Owner", inviteCode, enrollmentKind: inviteCode ? "owner" : null, onIn });
  }
  function button(label: string) {
    function find(node: React.ReactNode): React.ReactElement<{ onClick: () => Promise<void>; children: React.ReactNode }> | undefined {
      for (const child of React.Children.toArray(node)) {
        if (!React.isValidElement<{ onClick: () => Promise<void>; children: React.ReactNode }>(child)) continue;
        if (child.type === "button" && child.props.children === label) return child;
        const found = find(child.props.children);
        if (found) return found;
      }
    }
    const found = find(tree());
    expect(found, `the real Gate must expose ${label}`).toBeDefined();
    return found!;
  }
  return { ...credentials, assign, replaceState, onIn, fetch, button, html: () => renderToStaticMarkup(tree()) };
}

describe("bank page return after sign-in", () => {
  it("returns to the fixed bank page only after sign-in verification succeeds", async () => {
    const harness = signInHarness("?then=connect-bank");
    let verify!: (response: Response) => void;
    harness.fetch.mockImplementationOnce(async () => Response.json({ challenge: "Zml4dHVyZQ", rp_id: "brain.invalid" }));
    harness.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { verify = resolve; }));
    const signingIn = harness.button("Continue with a passkey").props.onClick();
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledWith("/auth/login/verify", expect.anything()));
    expect(harness.get).toHaveBeenCalledOnce();
    expect(harness.assign).not.toHaveBeenCalled();
    expect(harness.onIn).not.toHaveBeenCalled();
    verify(Response.json({ ok: true }));
    await signingIn;
    expect(harness.assign).toHaveBeenCalledExactlyOnceWith("/app/connect/bank");
    expect(harness.onIn).not.toHaveBeenCalled();
  });

  it.each([
    "", // Ordinary sign-in is the unchanged green control.
    "?then=https://evil.example",
    "?then=//evil.example",
    "?then=/anything-else",
    "?then=https%3A%2F%2Fevil.example",
    "?then=%2F%2Fevil.example",
    "?then=javascript:alert(1)",
    "?then=connect-bank%2Fanything-else",
  ])("keeps an ordinary or unrecognised destination on the app: %s", async (search) => {
    const harness = signInHarness(search);
    await harness.button("Continue with a passkey").props.onClick();
    expect(harness.get).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledWith("/auth/login/verify", expect.anything());
    expect(harness.onIn).toHaveBeenCalledOnce();
    expect(harness.assign).not.toHaveBeenCalled();
  });

  it("does not navigate or open the workspace when bank sign-in fails (control)", async () => {
    const harness = signInHarness("?then=connect-bank");
    harness.get.mockRejectedValueOnce({ name: "NotAllowedError" });
    await harness.button("Continue with a passkey").props.onClick();
    expect(harness.get).toHaveBeenCalledOnce();
    expect(harness.assign).not.toHaveBeenCalled();
    expect(harness.onIn).not.toHaveBeenCalled();
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it("also returns to the bank page through Sign in instead after an expired invite", async () => {
    const harness = signInHarness("?then=connect-bank", "fixture-invite");
    await harness.button("Create my owner passkey").props.onClick();
    expect(harness.fetch).toHaveBeenCalledWith("/auth/register/options", expect.anything());
    expect(harness.assign).not.toHaveBeenCalled();
    await harness.button("Sign in instead").props.onClick();
    expect(harness.get).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledWith("/auth/login/verify", expect.anything());
    expect(harness.assign).toHaveBeenCalledExactlyOnceWith("/app/connect/bank");
    expect(harness.onIn).not.toHaveBeenCalled();
  });
});


describe("calm passkey recovery", () => {
  it("makes sign-in primary after the real expired-link decision and hides stale instructions", async () => {
    const harness = signInHarness("", "fixture-invite");
    expect(harness.html()).toContain("Here is what happens next"); // Green control.
    await harness.button("Create my owner passkey").props.onClick();
    expect(harness.fetch).toHaveBeenCalledWith("/auth/register/options", expect.anything());
    const html = harness.html();
    expect(html).toContain("This setup link can&#x27;t be used");
    expect(html).toContain("ask your installer for a new link");
    expect(html).not.toContain("Here is what happens next");
    expect(html).not.toContain("Usually");
    expect(html).not.toContain("Last step:");
    expect(html).not.toContain("Passkey setup unavailable here");
    expect(html).toMatch(/<button[^>]*bg-accent[^>]*>Sign in instead<\/button>/);
    await harness.button("Sign in instead").props.onClick();
    expect(harness.get).toHaveBeenCalledOnce();
    expect(harness.onIn).toHaveBeenCalledOnce();
  });

  it.each(["create", "get"] as const)("puts a %s cancellation above the action in amber with a stable code", async (method) => {
    const harness = signInHarness("", method === "create" ? "fixture-invite" : null);
    harness.fetch.mockImplementationOnce(async () => Response.json(method === "create"
      ? { challenge: "Zml4dHVyZQ", rp: { id: "brain.invalid", name: "Fixture Brain" }, user_name: "owner" }
      : { challenge: "Zml4dHVyZQ", rp_id: "brain.invalid" }));
    harness[method].mockRejectedValueOnce({ name: "NotAllowedError" });
    const label = method === "create" ? "Create my owner passkey" : "Continue with a passkey";
    await harness.button(label).props.onClick();
    expect(harness[method]).toHaveBeenCalledOnce();
    const html = harness.html();
    expect(html).toMatch(/role="alert"[^>]*bg-act-bg/);
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf("<button"));
    expect(html).toContain("Code PASSKEY_CANCELLED");
    expect(html).not.toContain("NotAllowedError");
    expect(harness.onIn).not.toHaveBeenCalled();
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "get"] as const)("also treats an empty %s prompt result as a calm cancellation", async (method) => {
    const harness = signInHarness("", method === "create" ? "fixture-invite" : null);
    harness.fetch.mockImplementationOnce(async () => Response.json(method === "create"
      ? { challenge: "Zml4dHVyZQ", rp: { id: "brain.invalid", name: "Fixture Brain" }, user_name: "owner" }
      : { challenge: "Zml4dHVyZQ", rp_id: "brain.invalid" }));
    harness[method].mockResolvedValueOnce(null);
    await harness.button(method === "create" ? "Create my owner passkey" : "Continue with a passkey").props.onClick();
    expect(harness[method]).toHaveBeenCalledOnce();
    expect(harness.html()).toContain("Code PASSKEY_CANCELLED");
    expect(harness.html()).toMatch(/role="alert"[^>]*bg-act-bg/);
    expect(harness.onIn).not.toHaveBeenCalled();
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it("offers sign-in for an existing passkey without putting exception names in owner copy", async () => {
    const harness = signInHarness("", "fixture-invite");
    harness.fetch.mockImplementationOnce(async () => Response.json({ challenge: "Zml4dHVyZQ", rp: { id: "brain.invalid", name: "Fixture Brain" }, user_name: "owner" }));
    harness.create.mockRejectedValueOnce({ name: "InvalidStateError" });
    await harness.button("Create my owner passkey").props.onClick();
    expect(harness.create).toHaveBeenCalledOnce();
    const html = harness.html();
    expect(html).toContain("already has an owner passkey");
    expect(html).toContain("Code PASSKEY_ALREADY_SAVED");
    expect(html).not.toContain("InvalidStateError");
    await harness.button("Sign in instead").props.onClick();
    expect(harness.onIn).toHaveBeenCalledOnce();
  });

  it.each(["SecurityError", "NotSupportedError", "AbortError"])("keeps %s as a support code rather than an exception suffix", (name) => {
    const error = explainCeremonyFailure({ name }, "brain.invalid");
    expect(error.message).not.toContain(name);
    const failure = gatePasskeyFailure(error, { enrolling: false, rehearsal: false });
    expect(failure.message).toBe(error.message);
  });

  it("offers a working copy action in an unsupported browser, and a calm fallback if copying fails", async () => {
    const harness = signInHarness("");
    vi.stubGlobal("window", {});
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Copy unavailable"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("location", { hostname: "brain.invalid", href: "https://brain.invalid/app", search: "" });
    const before = harness.html();
    expect(before).toContain("This browser cannot use passkeys");
    expect(before).toContain("bg-act-bg");
    await harness.button("Copy this link").props.onClick();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://brain.invalid/app");
    expect(harness.html()).toContain("Link copied. Open it in Safari or Chrome.");
    await harness.button("Copy this link").props.onClick();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(harness.html()).toContain("Copy the link from your address bar");
    expect(harness.html()).toContain("Code PASSKEY_COPY_UNAVAILABLE");
    expect(harness.onIn).not.toHaveBeenCalled();
  });

  it("hands the saved-passkey notice to the app only after successful owner enrollment", async () => {
    const harness = signInHarness("", "fixture-invite");
    harness.fetch.mockImplementationOnce(async () => Response.json({ challenge: "Zml4dHVyZQ", rp: { id: "brain.invalid", name: "Fixture Brain" }, user_name: "owner" }));
    harness.fetch.mockImplementationOnce(async () => Response.json({ ok: true }));
    harness.create.mockResolvedValueOnce({ id: "fixture-credential", response: { attestationObject: new Uint8Array([1]).buffer, clientDataJSON: new Uint8Array([2]).buffer } });
    await harness.button("Create my owner passkey").props.onClick();
    expect(harness.create).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledWith("/auth/register/verify", expect.anything());
    expect(harness.onIn).toHaveBeenCalledExactlyOnceWith("✓ Passkey saved. Sign in with Touch ID from now on.");
  });
});

describe("passkey ceremony context", () => {
  it("explains owner enrollment without opening a system prompt during render", () => {
    const credentials = supportedPasskeyBrowser();
    const html = renderToStaticMarkup(
      <Gate owner="Fixture Owner" inviteCode="fixture-invite" enrollmentKind="owner" onIn={() => undefined} />,
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
    expect(html).toMatch(/material connected to your Brain[\s\S]{0,100}coverage it cannot prove/);
    expect(html).toContain("Last step: save your passkey (about 10 seconds).");
    expect(html).toContain("STEP 1 of 1");
    expect(html).toContain("Fixture, your Brain is ready");
    expect(html).toContain("Fixture Owner&#x27;s Brain");
    expect(html).not.toContain("your Claude or Codex guide");
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
      <Gate owner="Fixture Owner" inviteCode={null} enrollmentKind={null} onIn={() => undefined} />,
    );

    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
    expect(html).toContain("normal passkey window only after you choose the button below");
    expect(html).toContain("answer the system prompt yourself");
    expect(html).toContain("Continue with a passkey");
    expect(html).toContain("New computer? In the passkey window choose to use your phone, then scan the code with the phone you set up. Lost your phone? Ask for a new setup link.");
    expect(html).not.toContain("Welcome back, Fixture");
  });

  it("does not show browser exception names after a canceled passkey window", () => {
    const failure = explainCeremonyFailure(
      { name: "NotAllowedError" },
      "brain.fixture.test",
      "sign_in",
    );
    expect(failure.message).toBe("Sign-in was cancelled or no passkey was found on this device. Tap Continue with a passkey to try again.");
    expect(failure.message).not.toContain("NotAllowedError");
  });

  it("explains document-only recipient scope on mobile before WebAuthn can open", () => {
    const credentials = supportedPasskeyBrowser();
    vi.stubGlobal("window", { PublicKeyCredential: class {}, innerWidth: 390 });
    const html = renderToStaticMarkup(
      <Gate
        owner="Fixture Owner"
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
    expect(html).not.toMatch(/your Brain is ready/i);
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
        message: "This setup link has expired or was already used. Links work once and expire 15 minutes after they're made. If you already made a passkey on this device, choose Sign in instead. Otherwise ask your installer for a new link.",
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
      <Gate owner="Fixture Owner" inviteCode="local-rehearsal-only" enrollmentKind="owner" onIn={() => undefined} />,
    );
    const settings = renderToStaticMarkup(
      <FinanceScopeProvider>
        <Settings devices={[]} connections={[]} onChange={() => undefined} />
      </FinanceScopeProvider>,
    );

    expect(gate).toContain("intentionally unavailable in this local rehearsal");
    expect(gate).toContain("This setup link can&#x27;t be used");
    expect(gate).not.toContain("Tap the button below");
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
        <Gate owner="Fixture Owner" inviteCode="fixture-invite" enrollmentKind={enrollmentKind} onIn={() => undefined} />,
      );
      expect(real).toContain("Check that this page is at <strong>fixture-brain.example</strong>.");
      expect(real).not.toContain("What happens on the real");

      const address = enrollmentKind === "document" ? "that Brain&#x27;s normal web address" : "your Brain&#x27;s normal web address";
      for (const loopback of loopbackHosts) {
        vi.stubGlobal("location", { hostname: loopback, search: "?state=populated" });
        const rehearsal = renderToStaticMarkup(
          <Gate owner="Fixture Owner" inviteCode="local-rehearsal-only" enrollmentKind={enrollmentKind} onIn={() => undefined} />,
        );
        expect(rehearsal).toContain(address);
        expect(rehearsal).not.toContain("Tap the button below");
        expect(rehearsal).not.toContain("Usually takes");
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
            connected_at: Date.UTC(2026, 0, 1),
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
          connections: [{ item_ref: "synthetic-bank", institution_label: "Example Bank", status: "connected", health: { state: "healthy" } }],
          needs_attention: [],
        }}
        busy={false}
        rehearsal
        onDisconnect={() => undefined}
      />,
    );

    expect(loading).toContain("Checking your banks…");
    expect(unavailable).toContain("cannot say whether a bank is linked");
    expect(unavailable).toContain("not the same as no bank");
    expect(unavailable).toContain("reload Access");
    expect(unconfigured).toContain("Bank connections aren&#x27;t set up for this Brain yet. Your installer can turn them on.");
    expect(unconfigured).not.toContain("Connect a bank");
    expect(configuredEmpty).toContain("Connect a bank");
    expect(configuredEmpty).toContain('href="/app/connect/bank"');
    expect(rehearsalConfigured).toContain("Bank review and repair are intentionally unavailable");
    expect(rehearsalConfigured).toContain("no real bank is connected");
    expect(rehearsalConfigured).not.toContain("Repair unavailable in rehearsal");
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
    expect(waiting).toContain("2 accounts need an owner choice before their transactions can load.");
    expect(waiting).toContain("Choose who owns each account on the Connect a bank page.");
    expect(waiting).toContain("Answers about money are missing anything that has happened here since the last complete bank sync.");
    expect(waiting).toContain("+ Connect a bank");
    expect(DISCONNECT_BANK_QUESTION).toBe("Disconnect this bank? New transactions stop. Your saved history stays.");
    expect(waiting).not.toContain("page..");
  });
});
