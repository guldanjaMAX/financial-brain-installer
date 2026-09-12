import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { FinanceScopeProvider } from "./FinanceScope";
import { Gate, gatePasskeyFailure } from "./Gate";
import { AddPasskeyContext, Settings, addPasskeyFailure } from "./Settings";

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
      <Gate owner="Dana Owner" inviteCode="fixture-invite" onIn={() => undefined} />,
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
      <Gate owner="Dana Owner" inviteCode={null} onIn={() => undefined} />,
    );

    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
    expect(html).toContain("normal passkey window only after you choose the button below");
    expect(html).toContain("answer the system prompt yourself");
    expect(html).toContain("Continue to my passkey");
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
    const add = addPasskeyFailure(raw404, false);

    expect(gate.unavailable).toBe(true);
    expect(gate.message).toContain("No passkey was enrolled");
    expect(gate.message).toContain("Ask your installer for a fresh private setup link");
    expect(gate.message).not.toContain("404");
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
      <Gate owner="Dana Owner" inviteCode="local-rehearsal-only" onIn={() => undefined} />,
    );
    const settings = renderToStaticMarkup(
      <FinanceScopeProvider>
        <Settings devices={[]} connections={[]} onChange={() => undefined} />
      </FinanceScopeProvider>,
    );

    expect(gate).toContain("intentionally unavailable in this local rehearsal");
    expect(gate).toContain("Passkey setup unavailable here");
    expect(gate).toContain("disabled");
    expect(settings).toContain("Adding a passkey is intentionally unavailable in this local rehearsal");
    expect(settings).toContain("Passkey setup unavailable");
    expect(settings).not.toContain("Continue to my device");
    expect(settings.indexOf("Your passkeys")).toBeLessThan(settings.indexOf("Passkey checks"));
    expect(settings.indexOf("Passkey checks")).toBeLessThan(settings.indexOf("Shared document access"));
    expect(settings.indexOf("Passkey checks")).toBeLessThan(settings.indexOf("Owner preferences"));
  });
});
