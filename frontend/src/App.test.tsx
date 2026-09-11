import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRANT_VIEWS, GrantWorkspace, OWNER_VIEWS, initialOwnerView, visibleView,
} from "./App";
import { Gate } from "./components/Gate";
import type { Me } from "./lib/api";

const grantMe: Me = {
  signed_in: true,
  brain: "Fixture Brain",
  principal: {
    kind: "grant",
    grant_id: "dg_fixture",
    entity_slug: "fixture-entity",
    document_count: 2,
    capabilities: ["documents:read", "ask"],
  },
  workspace: {
    home: false,
    documents: true,
    ask: true,
    add_review: false,
    access: false,
    bank: false,
    targets: false,
    preferences: false,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("principal workspace routing", () => {
  it("keeps the full owner navigation and limits a grant to Documents and Explore", () => {
    expect(OWNER_VIEWS).toEqual(["home", "year", "financial-map", "documents", "ask", "review", "access"]);
    expect(GRANT_VIEWS).toEqual(["documents", "ask"]);
    for (const forbidden of ["home", "year", "financial-map", "review", "access"] as const) {
      expect(visibleView("grant", forbidden)).toBe("documents");
    }
    expect(visibleView("grant", "ask")).toBe("ask");
    expect(visibleView("owner", "access")).toBe("access");
  });

  it("allows a non-secret direct owner view while refusing unknown query state", () => {
    vi.stubGlobal("location", { search: "?state=financial-map&view=financial-map" });
    expect(initialOwnerView()).toBe("financial-map");
    vi.stubGlobal("location", { search: "?view=ofmp_private" });
    expect(initialOwnerView()).toBe("home");
  });

  it("renders no owner navigation or owner-only route in the grant shell", () => {
    const html = renderToStaticMarkup(<GrantWorkspace me={grantMe} onAccessEnded={() => undefined} />);
    expect(html).toContain("Shared documents");
    expect(html).toContain("Explore");
    expect(html).not.toContain("Home</button>");
    expect(html).not.toContain("This Year");
    expect(html).not.toContain("Financial Map");
    expect(html).not.toContain("Add &amp; Review");
    expect(html).not.toContain("Access</button>");
    expect(html).not.toContain("Owner preferences");
    expect(html).not.toContain("Add a text record");
  });
});

describe("passkey enrollment welcome", () => {
  it("explains the secure device window and privacy boundary before offering enrollment", () => {
    const html = renderToStaticMarkup(
      <Gate owner="Morgan Example" inviteCode="synthetic-invite" onIn={() => undefined} />,
    );
    expect(html).toContain("Here is what happens next");
    expect(html).toContain("Create my owner passkey");
    expect(html).toContain("secure passkey window");
    expect(html).toContain("This verifies that you are the owner");
    expect(html).toContain("cannot see or store your passkey, Face ID, fingerprint, or device PIN");
    expect(html).toContain("choose Cancel");
    expect(html).not.toContain("Set up with Face ID");
    expect(html).not.toContain("Works on every device you own");
  });
});
