import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  App, GRANT_VIEWS, GrantWorkspace, OWNER_VIEWS, OwnerHeader, OwnerWorkspace,
  SIGNED_OUT_NOTICE,
  enrollmentInviteFromHash, initialOwnerView, ownerViewRequiresEntity, ownerViewScopeGate,
  scopeGateRequiresEntity, visibleView,
} from "./App";
import { Gate } from "./components/Gate";
import { FinanceScopeProvider } from "./components/FinanceScope";
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

const ownerMe: Me = {
  signed_in: true,
  brain: "Fixture Brain",
  principal: { kind: "owner", grant_id: null },
  devices: [],
  connections: [],
};

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: vi.fn(original.useState), useEffect: vi.fn(original.useEffect), useRef: vi.fn(original.useRef), useCallback: vi.fn(original.useCallback) };
});

afterEach(async () => {
  const original = await vi.importActual<typeof import("react")>("react");
  vi.mocked(React.useState).mockImplementation(original.useState);
  vi.mocked(React.useEffect).mockImplementation(original.useEffect);
  vi.mocked(React.useRef).mockImplementation(original.useRef);
  vi.mocked(React.useCallback).mockImplementation(original.useCallback);
  vi.unstubAllGlobals();
});

function appHarness() {
  const states: unknown[] = [];
  let cursor = 0;
  const effects: React.EffectCallback[] = [];
  vi.mocked(React.useState).mockImplementation(((initial: unknown) => {
    const slot = cursor++;
    if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
    return [states[slot], (next: unknown) => { states[slot] = typeof next === "function" ? next(states[slot]) : next; }];
  }) as typeof React.useState);
  vi.mocked(React.useCallback).mockImplementation((callback) => callback);
  vi.mocked(React.useRef).mockImplementation(((value: unknown) => ({ current: value })) as typeof React.useRef);
  vi.mocked(React.useEffect).mockImplementation((effect) => { effects.push(effect); });
  vi.stubGlobal("location", { search: "", hash: "", hostname: "brain.invalid" });
  return { render: () => { cursor = 0; return App(); }, effects };
}

describe("opening and first Home", () => {
  it("shows a centred opening mark while the real session read is pending, without flashing sign-in", async () => {
    const harness = appHarness();
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    const pending = renderToStaticMarkup(harness.render());
    harness.effects[0]();
    expect(fetch).toHaveBeenCalledWith("/api/app/me", expect.anything());
    expect(pending).toContain("Opening your Brain…");
    expect(pending).toContain("FB");
    expect(pending).toContain('role="status"');
    expect(pending).not.toContain("Welcome back");
    resolve(Response.json({ signed_in: false }));
    await vi.waitFor(() => expect(harness.render()?.type).toBe(Gate));
  });

  it("shows the enrollment notice on the first Home only, and never again after leaving", async () => {
    const harness = appHarness();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ signed_in: false })).mockResolvedValueOnce(Response.json(ownerMe));
    vi.stubGlobal("fetch", fetch);
    harness.render();
    harness.effects[0]();
    await vi.waitFor(() => expect(harness.render()?.type).toBe(Gate));
    const gate = harness.render() as React.ReactElement<React.ComponentProps<typeof Gate>>;
    await gate.props.onIn("✓ Passkey saved. Sign in with Touch ID from now on.");
    await vi.waitFor(() => expect(harness.render()?.type).toBe(FinanceScopeProvider));
    expect(fetch).toHaveBeenCalledTimes(2);
    const workspace = () => (harness.render() as React.ReactElement<{ children: React.ReactElement<React.ComponentProps<typeof OwnerWorkspace>> }>).props.children;
    expect(workspace().props.notice).toBe("✓ Passkey saved. Sign in with Touch ID from now on.");
    expect(workspace().props.view).toBe("home");
    workspace().props.setView("access");
    expect(workspace().props.notice).toBeNull();
    workspace().props.setView("home");
    expect(workspace().props.notice).toBeNull();
  });

  it("renders the success notice as a calm status on Home only", () => {
    const props = { owner: "Fixture Owner", me: ownerMe, setView: () => undefined, refresh: async () => undefined, notice: "✓ Passkey saved. Sign in with Touch ID from now on." };
    const home = renderToStaticMarkup(<FinanceScopeProvider><OwnerWorkspace {...props} view="home" /></FinanceScopeProvider>);
    expect(home).toContain(props.notice);
    expect(home).toMatch(/role="status"[^>]*bg-good-bg/);
    const access = renderToStaticMarkup(<FinanceScopeProvider><OwnerWorkspace {...props} view="access" /></FinanceScopeProvider>);
    expect(access).toContain("Your passkeys");
    expect(access).not.toContain(props.notice);
  });
});

describe("principal workspace routing", () => {
  it("explains a mid-session sign-out without losing the owner's place", () => {
    expect(SIGNED_OUT_NOTICE).toBe("Your sign-in ended. Sign in again to pick up where you left off.");
  });

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

  it("uses a visible mobile menu and keeps Access and passkeys directly findable", () => {
    const html = renderToStaticMarkup(
      <OwnerHeader owner="Fixture Owner" now="home" go={() => undefined} />,
    );

    expect(html).toContain("Access &amp; passkeys");
    expect(html).toContain('aria-label="Open Access and passkeys"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="owner-primary-navigation"');
    expect(html).toContain("Menu");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("guards entity-specific owner pages without narrowing owner-wide pages", () => {
    expect(ownerViewRequiresEntity("year")).toBe(true);
    expect(ownerViewRequiresEntity("review")).toBe(true);
    expect(ownerViewRequiresEntity("access")).toBe(false);
    expect(ownerViewRequiresEntity("home")).toBe(false);
    expect(ownerViewRequiresEntity("financial-map")).toBe(false);
    expect(ownerViewRequiresEntity("documents")).toBe(false);
    expect(ownerViewRequiresEntity("ask")).toBe(false);
    expect(ownerViewScopeGate("access", true, "required")).toBeNull();
    expect(ownerViewScopeGate("access", false, "checking")).toBeNull();
    expect(ownerViewScopeGate("financial-map", false, "checking")).toBeNull();

    const html = renderToStaticMarkup(
      <FinanceScopeProvider>
        <OwnerWorkspace
          owner="Fixture Owner"
          me={ownerMe}
          view="review"
          setView={() => undefined}
          refresh={async () => undefined}
        />
      </FinanceScopeProvider>,
    );
    expect(html).toContain('id="scope-required-title"');
    expect(html).toContain("Add &amp; Review</h1>");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toContain("Choose one financial entity");
    expect(html).not.toContain("Intake and decisions");

    const access = renderToStaticMarkup(
      <FinanceScopeProvider>
        <OwnerWorkspace
          owner="Fixture Owner"
          me={ownerMe}
          view="access"
          setView={() => undefined}
          refresh={async () => undefined}
        />
      </FinanceScopeProvider>,
    );
    expect(access).toContain("Your passkeys");
    expect(access).toContain("Passkey checks");
    expect(access).not.toContain("Select one person, household, business, trust, property, or investment");
  });

  it("waits for inventory, quarantines saved scope, then allows safe fallback reads", () => {
    expect(ownerViewScopeGate("home", false, "checking")).toBe("checking");
    expect(ownerViewScopeGate("home", false, "required", false)).toBeNull();
    expect(ownerViewScopeGate("home", false, "required", true)).toBe("choice");
    expect(ownerViewScopeGate("home", true, "required", true)).toBeNull();
    expect(ownerViewScopeGate("documents", false, "required", true)).toBe("choice");
    expect(ownerViewScopeGate("ask", false, "required", true)).toBe("choice");
    expect(scopeGateRequiresEntity("choice")).toBe(false);
    expect(scopeGateRequiresEntity("entity")).toBe(true);
    expect(ownerViewScopeGate("documents", false, "unavailable")).toBeNull();
    expect(ownerViewScopeGate("ask", false, "not_installed")).toBeNull();
    expect(ownerViewScopeGate("review", false, "unavailable")).toBe("entity");
    expect(ownerViewScopeGate("year", true, "checking")).toBe("entity");
    expect(ownerViewScopeGate("ask", true, "required")).toBeNull();

    const waiting = renderToStaticMarkup(
      <FinanceScopeProvider>
        <OwnerWorkspace
          owner="Fixture Owner"
          me={ownerMe}
          view="home"
          setView={() => undefined}
          refresh={async () => undefined}
        />
      </FinanceScopeProvider>,
    );
    expect(waiting).toContain("Checking your financial list");
    expect(waiting.match(/Checking your financial list/g)).toHaveLength(1);
    expect(waiting).not.toContain("What deserves your attention");

    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => key === "financial-brain:entity-scope-choice" ? "all" : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const savedAllStillChecking = renderToStaticMarkup(
      <FinanceScopeProvider>
        <OwnerWorkspace
          owner="Fixture Owner"
          me={ownerMe}
          view="home"
          setView={() => undefined}
          refresh={async () => undefined}
        />
      </FinanceScopeProvider>,
    );
    expect(savedAllStillChecking).toContain("Checking your financial list");
    expect(savedAllStillChecking).not.toContain("What deserves your attention");
    expect(savedAllStillChecking).not.toContain("Choose one part of your finances or Whole Brain");
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
  it("keeps owner and document-recipient invitation classes explicit and fails closed", () => {
    expect(enrollmentInviteFromHash("#enroll=owner_fixture_invite_1234")).toEqual({
      code: "owner_fixture_invite_1234",
      kind: "owner",
    });
    expect(enrollmentInviteFromHash("#document-enroll=doc_fixture_invite_1234")).toEqual({
      code: "doc_fixture_invite_1234",
      kind: "document",
    });
    expect(enrollmentInviteFromHash("#enroll=doc_fixture_invite_1234")).toBeNull();
    expect(enrollmentInviteFromHash("#document-enroll=owner_fixture_invite_1234")).toBeNull();
    expect(enrollmentInviteFromHash("#enroll=owner_fixture_invite_1234&document-enroll=doc_fixture_invite_1234")).toBeNull();
    expect(enrollmentInviteFromHash("#support-enroll=doc_fixture_invite_1234")).toBeNull();
  });

  it("explains the secure device window and privacy boundary before offering enrollment", () => {
    vi.stubGlobal("window", { PublicKeyCredential: class {} });
    const html = renderToStaticMarkup(
      <Gate owner="Fixture Owner" inviteCode="synthetic-invite" enrollmentKind="owner" onIn={() => undefined} />,
    );
    expect(html).toContain("Here is what happens next");
    expect(html).toContain("secure passkey window");
    expect(html).toContain("This verifies that you are the owner");
    expect(html).toContain("cannot see or store your passkey, Face ID, fingerprint, or device PIN");
    expect(html).toContain("choose Cancel");
    expect(html).toContain("Tap the button below");
    expect(html).toContain("How this keeps you safe");
    expect(html).toContain("No password is needed");
    expect(html).toContain("biometric data and device PIN never go to Financial Brain");
    expect(html).not.toContain("Set up with Face ID");
    expect(html).not.toContain("Works on every device you own");
  });
});
