import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gate } from "./Gate";
import { AddPasskeyContext } from "./Settings";

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
});
