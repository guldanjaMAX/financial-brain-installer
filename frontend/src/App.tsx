import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, type Me } from "./lib/api";
import { Gate } from "./components/Gate";
import { Ask, ScopedAsk } from "./components/Ask";
import { Settings } from "./components/Settings";
import { Home } from "./components/Home";
import { Documents } from "./components/Documents";
import { ThisYear } from "./components/ThisYear";
import { AddReview } from "./components/AddReview";
import {
  FinanceScopeBar, FinanceScopeProvider, useFinanceScope, type EntityScopeState,
} from "./components/FinanceScope";
import { ScopedDocuments } from "./components/ScopedDocuments";
import { FinancialMap } from "./components/FinancialMap";
import { Attention } from "./components/ui";
import { grantWorkspaceConfirmed } from "./lib/security";

// The invite arrives as /app#enroll=<code>. It lives in the fragment on
// purpose: a fragment is never sent to the server in a request line and never
// lands in an access log or a referrer header.
const inviteCode = (typeof location === "undefined" ? null : (location.hash.match(/enroll=([A-Za-z0-9_-]+)/) || [])[1]) || null;

// The owner's name comes from the server-rendered shell, not from /api/app/me.
// A signed-out visitor cannot call that endpoint, and the FIRST screen a client
// ever sees is the one that most needs to greet them by name.
const root = typeof document === "undefined" ? null : document.getElementById("root");
const shellOwner = root?.dataset.owner || "";

export type View = "home" | "year" | "financial-map" | "documents" | "ask" | "review" | "access";
export const OWNER_VIEWS: readonly View[] = ["home", "year", "financial-map", "documents", "ask", "review", "access"];
export const GRANT_VIEWS: readonly View[] = ["documents", "ask"];
const ENTITY_REQUIRED_VIEWS: readonly View[] = ["year", "review"];
const SCOPE_CHOICE_VIEWS: readonly View[] = ["home", "documents", "ask"];

export function ownerViewRequiresEntity(view: View): boolean {
  return ENTITY_REQUIRED_VIEWS.includes(view);
}

export function ownerViewScopeGate(
  view: View,
  scopeChoiceMade: boolean,
  entityScopeState: EntityScopeState,
): "entity" | "choice" | "checking" | null {
  // These pages contain entity-scoped writes, so a stale saved choice or an
  // unavailable inventory never opens them. The backend validates any owned
  // financial entity, not businesses alone.
  if (ownerViewRequiresEntity(view) && entityScopeState !== "selected") return "entity";
  if (SCOPE_CHOICE_VIEWS.includes(view) && !scopeChoiceMade) {
    if (entityScopeState === "checking") return "checking";
    if (entityScopeState === "required") return "choice";
    // Whole-Brain reads remain useful when the optional financial ledger is
    // absent or temporarily unavailable. Their own read boundaries still say
    // whether the requested data was available.
    return null;
  }
  return null;
}

export function initialOwnerView(): View {
  if (typeof location === "undefined") return "home";
  const requested = new URLSearchParams(location.search).get("view") as View | null;
  return requested && OWNER_VIEWS.includes(requested) ? requested : "home";
}

export function visibleView(kind: "owner" | "grant", requested: View): View {
  const allowed = kind === "grant" ? GRANT_VIEWS : OWNER_VIEWS;
  return allowed.includes(requested) ? requested : allowed[0];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>(initialOwnerView);
  const [ready, setReady] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/app/me"));
      setAuthNotice(null);
    } catch (next) {
      // A 401 is the ordinary signed-out case, not an error worth showing.
      setMe(null);
      setAuthNotice(next instanceof ApiError && next.status === 403 && typeof next.body.recovery === "string"
        ? next.body.recovery
        : null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Nothing until the session is known: flashing the sign-in screen at someone
  // who is already signed in reads as being logged out.
  if (!ready) return null;

  if (!me?.signed_in) {
    return <Gate owner={me?.owner || shellOwner} inviteCode={inviteCode} notice={authNotice} onIn={refresh} />;
  }

  if (me.principal?.kind === "grant") {
    if (!grantWorkspaceConfirmed(me.workspace)) {
      return <UnavailableSession message="The brain did not return the exact shared-workspace allowlist. No owner or document surface is being opened." />;
    }
    return <GrantWorkspace me={me} onAccessEnded={refresh} />;
  }

  if (me.principal?.kind !== "owner") {
    return <UnavailableSession message="The brain could not prove whether this is an owner or document-only session. No workspace is being opened." />;
  }

  const owner = me.owner || shellOwner;

  return (
    <FinanceScopeProvider>
      <OwnerWorkspace
        owner={owner}
        me={me}
        view={view}
        setView={setView}
        refresh={refresh}
      />
    </FinanceScopeProvider>
  );
}

export function OwnerWorkspace({ owner, me, view, setView, refresh }: {
  owner: string;
  me: Me;
  view: View;
  setView: (view: View) => void;
  refresh: () => Promise<void>;
}) {
  const { entityScopeState, scopeChoiceMade } = useFinanceScope();
  const scopeGate = ownerViewScopeGate(view, scopeChoiceMade, entityScopeState);
  const guardedTitle = view === "year" ? "This Year" : "Add & Review";

  return (
    <div className="min-h-dvh">
      <OwnerHeader owner={owner} now={view} go={setView} />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-7 sm:py-9 pb-24">
        {scopeGate ? (
          <section className="max-w-2xl" aria-labelledby="scope-required-title">
            <p className="eyebrow">
              {scopeGate === "entity" ? "Choose one financial entity"
                : scopeGate === "checking" ? "Checking your financial list" : "Choose what to view"}
            </p>
            <h1 id="scope-required-title" className="page-title">
              {scopeGate === "entity" ? guardedTitle : view === "ask" ? "Ask & Explore" : view === "documents" ? "Documents" : "Home"}
            </h1>
            <p className="page-intro">
              {scopeGate === "entity"
                ? "Select one person, household, business, trust, property, or investment before opening this page. This keeps separate financial records and decisions from being combined."
                : scopeGate === "checking"
                  ? "The Brain is checking which parts of your finances are available before it opens this page."
                  : "Choose one part of your finances or Whole Brain before opening this page. Nothing is combined until you make that choice."}
            </p>
            <div className="mt-6"><FinanceScopeBar requireEntity={scopeGate === "entity"} /></div>
          </section>
        ) : (
          <>
            {view === "home" && <Home onNavigate={setView} />}
            {view === "year" && <ThisYear />}
            {view === "financial-map" && <FinancialMap />}
            {view === "documents" && <Documents />}
            {view === "review" && <AddReview />}
            {view === "access" && (
              <Settings
                devices={me.devices || []}
                connections={me.connections || []}
                onChange={refresh}
              />
            )}
          </>
        )}
        {/* Keep an answer in place while the owner checks another page,
            including a page waiting for a financial-entity choice. */}
        {(scopeChoiceMade || (view === "ask" && scopeGate === null)) && (
          <div className={view === "ask" ? "" : "hidden"}>
            <Ask />
          </div>
        )}
      </main>
    </div>
  );
}

export function OwnerHeader({ owner, now, go }: {
  owner: string;
  now: View;
  go: (view: View) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "Your";
  const navigate = (view: View) => {
    setMenuOpen(false);
    go(view);
  };

  return (
    <header className="px-4 sm:px-6 lg:px-8 border-b border-line bg-card/90 backdrop-blur sticky top-0 z-20">
      <div className="max-w-6xl mx-auto min-h-16 py-3 lg:flex lg:items-center lg:justify-between lg:gap-6">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate("home")}
            className="flex items-center gap-2 min-w-0 text-[14.5px] text-ink-soft hover:text-ink"
          >
            <span className="w-7 h-7 rounded-lg bg-ink text-white grid place-items-center text-[12px] font-semibold shrink-0" aria-hidden="true">FB</span>
            <span className="truncate">{possessive} brain</span>
          </button>
          <div className="flex items-center gap-1.5 shrink-0 lg:hidden">
            <button
              type="button"
              onClick={() => navigate("access")}
              aria-label="Open Access and passkeys"
              aria-current={now === "access" ? "page" : undefined}
              className={`px-2.5 py-2 rounded-lg whitespace-nowrap text-[13px] font-medium ${
                now === "access" ? "bg-accent-soft text-accent" : "text-accent hover:bg-accent-soft"
              }`}
            >
              Access &amp; passkeys
            </button>
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls="owner-primary-navigation"
              onClick={() => setMenuOpen((open) => !open)}
              className="px-2.5 py-2 rounded-lg text-[13px] font-medium text-ink-soft hover:bg-paper hover:text-ink"
            >
              {menuOpen ? "Close" : "Menu"}
            </button>
          </div>
        </div>
        <nav
          id="owner-primary-navigation"
          aria-label="Primary"
          className={`${menuOpen ? "grid" : "hidden"} grid-cols-2 gap-1 w-full pt-2 mt-2 border-t border-line text-[13.5px] lg:mt-0 lg:flex lg:items-center lg:w-auto lg:pt-0 lg:border-0`}
        >
          <Tab now={now} go={navigate} to="home">Home</Tab>
          <Tab now={now} go={navigate} to="year">This Year</Tab>
          <Tab now={now} go={navigate} to="financial-map">Financial Map</Tab>
          <Tab now={now} go={navigate} to="documents">Documents</Tab>
          <Tab now={now} go={navigate} to="ask">Explore</Tab>
          <Tab now={now} go={navigate} to="review">Add &amp; Review</Tab>
          <Tab now={now} go={navigate} to="access" mobileHidden>Access</Tab>
        </nav>
      </div>
    </header>
  );
}

export function GrantWorkspace({ me, onAccessEnded }: { me: Me; onAccessEnded: () => void }) {
  const principal = me.principal;
  const [requested, setRequested] = useState<View>("documents");
  if (principal?.kind !== "grant") return null;
  const view = visibleView("grant", requested);
  const title = me.brain ? `${me.brain} · shared access` : "Shared brain access";
  return (
    <div className="min-h-dvh">
      <header className="px-4 sm:px-6 lg:px-8 border-b border-line bg-card/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto min-h-16 flex flex-col justify-center gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <button onClick={() => setRequested("documents")} className="flex items-center gap-2 text-[14.5px] text-ink-soft hover:text-ink shrink-0">
            <span className="w-7 h-7 rounded-lg bg-ink text-white grid place-items-center text-[12px] font-semibold" aria-hidden="true">FB</span>
            <span>{title}</span>
          </button>
          <nav aria-label="Shared workspace" className="flex items-center gap-1 text-[13.5px]">
            <Tab now={view} go={setRequested} to="documents">Documents</Tab>
            <Tab now={view} go={setRequested} to="ask">Explore</Tab>
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-7 sm:py-9 pb-24">
        {view === "documents" && <ScopedDocuments principal={principal} onAccessEnded={onAccessEnded} />}
        <div className={view === "ask" ? "" : "hidden"}>
          <ScopedAsk principal={principal} onAccessEnded={onAccessEnded} />
        </div>
      </main>
    </div>
  );
}

function UnavailableSession({ message }: { message: string }) {
  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <Attention>{message}</Attention>
    </main>
  );
}

function Tab({ now, to, go, children, mobileHidden = false }: {
  now: View;
  to: View;
  go: (v: View) => void;
  children: ReactNode;
  mobileHidden?: boolean;
}) {
  const active = now === to;
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) buttonRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => go(to)}
      aria-current={active ? "page" : undefined}
      className={`w-full px-3 py-2 rounded-lg whitespace-nowrap text-left lg:w-auto lg:text-center ${mobileHidden ? "hidden lg:block" : ""} ${
        active ? "bg-accent-soft text-accent font-medium" : "text-ink-soft hover:bg-paper hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
