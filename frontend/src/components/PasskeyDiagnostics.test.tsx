import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PasskeyStatus } from "../lib/api";
import { PasskeyStatusDetails } from "./PasskeyDiagnostics";

const status: PasskeyStatus = {
  status: "ready",
  rp_id: "brain.fixture.test",
  proof: { configured: true, locally_verified: true, live_proven: false },
  devices: { owner: 1, grant: 2 },
  ceremonies: [],
  privacy: "No private passkey material is recorded here.",
};

describe("owner-facing passkey checks", () => {
  it("explains the address and proof boundaries without protocol jargon", () => {
    const html = renderToStaticMarkup(<PasskeyStatusDetails status={status} />);

    expect(html).toContain("Brain setup");
    expect(html).toContain("Successful passkey activity");
    expect(html).toContain("A successful action is recorded");
    expect(html).toContain("Where it happened");
    expect(html).toContain("Not identified");
    expect(html).toContain("is not proof of an independent check");
    expect(html).toContain("Passkeys are tied to this web address: brain.fixture.test");
    expect(html).toContain("shared-document passkeys");
    expect(html).toContain("No privacy-safe passkey result is recorded yet");
    expect(html).not.toContain("Relying party");
    expect(html).not.toContain("Not confirmed at this level");
    expect(html).not.toContain("ceremony outcome");
    expect(html).not.toContain("Practice check");
    expect(html).not.toContain("A local check worked");
    expect(html).not.toContain("Your live Brain");
    expect(html).not.toContain("Not checked live yet");
  });

  it("does not turn the status flags into an environment claim", () => {
    const withoutActivity = renderToStaticMarkup(
      <PasskeyStatusDetails status={{ ...status, proof: { ...status.proof, locally_verified: false } }} />,
    );

    expect(withoutActivity).toContain("No successful action is recorded");
    expect(withoutActivity).toContain("Where it happened");
    expect(withoutActivity).toContain("Not identified");
    expect(withoutActivity).not.toContain("live check");
    expect(withoutActivity).not.toContain("practice environment");
  });
});
