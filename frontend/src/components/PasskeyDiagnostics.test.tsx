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
    expect(html).toContain("Practice check");
    expect(html).toContain("Your live Brain");
    expect(html).toContain("Not checked live yet");
    expect(html).toContain("Passkeys are tied to this web address: brain.fixture.test");
    expect(html).toContain("shared-document passkeys");
    expect(html).toContain("No privacy-safe passkey result is recorded yet");
    expect(html).not.toContain("Relying party");
    expect(html).not.toContain("Not confirmed at this level");
    expect(html).not.toContain("ceremony outcome");
  });
});
