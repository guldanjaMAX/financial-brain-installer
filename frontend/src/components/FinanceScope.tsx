import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import {
  ApiError, api, ownerError, requestId, type FinEntity, type FinSnapshot,
  type OwnerPreference, type OwnerPreferencesResponse,
} from "../lib/api";
import { activeScopeLabel, orderedScopes } from "../lib/finance";
import { defaultEntityScope } from "../lib/owner";
import { Attention } from "./ui";
import { ScopeBar } from "./ScopeBar";

export type ScopeStatus = "loading" | "ready" | "not_installed" | "unavailable";
export type EntityScopeState = "checking" | "required" | "selected" | "not_installed" | "unavailable";
type FinanceScopeValue = {
  scope: string | null;
  setScope: (scope: string | null) => void;
  scopeChoiceMade: boolean;
  entities: FinEntity[];
  status: ScopeStatus;
  entityScopeState: EntityScopeState;
  activeLabel: string;
  refresh: (options?: { quiet?: boolean }) => Promise<FinEntity[] | null>;
};

const STORAGE_KEY = "financial-brain:entity-scope";
const CHOICE_KEY = "financial-brain:entity-scope-choice";
const FinanceScopeContext = createContext<FinanceScopeValue | null>(null);

function savedSelection(): { scope: string | null; choiceMade: boolean } {
  try {
    const scope = sessionStorage.getItem(STORAGE_KEY) || null;
    const choice = sessionStorage.getItem(CHOICE_KEY);
    // A prior entity choice already used STORAGE_KEY. Keep that explicit
    // session behavior while the new marker makes an explicit All choice
    // distinguishable from a visit where the owner chose nothing.
    return { scope, choiceMade: Boolean(scope) || choice === "all" };
  } catch {
    return { scope: null, choiceMade: false };
  }
}

/** A scope may survive only when the owner already chose it in this browser
 *  session and the current inventory still contains it. The backend's scope
 *  is one owned financial entity, which intentionally includes people,
 *  households, trusts, businesses, properties, and investments. */
export function retainExplicitEntityScope(current: string | null, entities: FinEntity[]): string | null {
  return current && entities.some((entity) =>
    !entity.counterparty && entity.entity_slug === current) ? current : null;
}

/** A saved default is an earlier owner choice, not an inferred choice. It is
 *  still accepted only when the current inventory proves it is active and
 *  owner-controlled. */
export function savedDefaultEntityScope(entities: FinEntity[], preferences: OwnerPreference[]): string | null {
  return defaultEntityScope(entities, preferences);
}

export function entityScopeState(status: ScopeStatus, scope: string | null): EntityScopeState {
  if (status === "loading") return "checking";
  if (status === "not_installed") return "not_installed";
  if (status === "unavailable") return "unavailable";
  return scope ? "selected" : "required";
}

export function financeScopeLabel(entities: FinEntity[], scope: string | null, choiceMade: boolean): string {
  if (scope) return activeScopeLabel(entities, scope);
  return choiceMade ? "Whole Brain" : "No financial entity selected";
}

/** A preferences read starts before the owner may make a choice. Its response
 *  can apply only if that exact no-choice state still exists. */
export function savedDefaultStillApplies({
  preferred, requestedChoiceRevision, currentChoiceRevision, currentScope, choiceMade,
}: {
  preferred: string | null;
  requestedChoiceRevision: number;
  currentChoiceRevision: number;
  currentScope: string | null;
  choiceMade: boolean;
}): preferred is string {
  return Boolean(preferred)
    && requestedChoiceRevision === currentChoiceRevision
    && currentScope === null
    && !choiceMade;
}

export function scopeStatusMessage(status: ScopeStatus, requireEntity: boolean): {
  title: string;
  detail: string;
} | null {
  if (status === "loading") {
    return {
      title: "Checking your financial list",
      detail: "This usually takes only a moment. No financial entity will be chosen for you.",
    };
  }
  if (status === "not_installed") {
    return {
      title: "Your financial list is not set up yet",
      detail: requireEntity
        ? "This section stays closed until setup can verify one exact person, household, business, trust, property, or investment. Nothing can be added to an unverified place."
        : "You can still use this whole-Brain read-only page. Setup will add the financial list later.",
    };
  }
  if (status === "unavailable") {
    return {
      title: "Your financial list could not be read just now",
      detail: requireEntity
        ? "This section stays closed because the Brain cannot verify where a change would go. Nothing has been added or changed."
        : "You can still use this whole-Brain read-only page. It will not be presented as narrowed to one financial entity.",
    };
  }
  return null;
}

const FIRST_ENTITY_KINDS = Object.freeze([
  ["person", "Person"],
  ["household", "Household"],
  ["business", "Business"],
  ["trust", "Trust"],
  ["property", "Property"],
  ["investment", "Investment"],
] as const);
type FirstEntityKind = typeof FIRST_ENTITY_KINDS[number][0];
type FirstEntityReview = {
  legalName: string;
  kind: FirstEntityKind;
  requestId: string;
  entitySlug: string;
};
type EntityCreateReceipt = {
  request_id?: string;
  entity_scope?: { entity_slug?: string };
  entity?: { entity_slug?: string; legal_name?: string; kind?: string };
  changed?: boolean;
  replayed?: boolean;
};

export function firstEntitySlug(legalName: string, actionId: string): string {
  const stem = legalName.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45) || "entity";
  const suffix = actionId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-8) || "new";
  return `${stem}-${suffix}`.slice(0, 64).replace(/-+$/g, "");
}

export function matchingEntityCreateReceipt(
  value: EntityCreateReceipt,
  review: FirstEntityReview,
): boolean {
  return value.request_id === review.requestId
    && value.entity_scope?.entity_slug === review.entitySlug
    && value.entity?.entity_slug === review.entitySlug
    && value.entity?.legal_name === review.legalName
    && value.entity?.kind === review.kind
    && typeof value.changed === "boolean"
    && typeof value.replayed === "boolean";
}

export function FirstEntitySetup({
  refresh, select,
}: {
  refresh: (options?: { quiet?: boolean }) => Promise<FinEntity[] | null>;
  select: (scope: string) => void;
}) {
  const [legalName, setLegalName] = useState("");
  const [kind, setKind] = useState<FirstEntityKind | "">("");
  const [review, setReview] = useState<FirstEntityReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edit = () => {
    setReview(null);
    setMessage(null);
    setError(null);
  };

  const prepare = () => {
    const exactName = legalName.trim();
    if (!exactName) {
      setError("Enter the exact name you use for this part of your finances.");
      return;
    }
    if (!kind) {
      setError("Choose what this is. Financial Brain will not choose a type for you.");
      return;
    }
    const actionId = requestId("entity");
    setError(null);
    setMessage(null);
    setReview({
      legalName: exactName,
      kind,
      requestId: actionId,
      entitySlug: firstEntitySlug(exactName, actionId),
    });
  };

  const create = async () => {
    if (!review || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const receipt = await api<EntityCreateReceipt>("/api/owner/entities/create", {
        request_id: review.requestId,
        entity_slug: review.entitySlug,
        legal_name: review.legalName,
        kind: review.kind,
      });
      if (!matchingEntityCreateReceipt(receipt, review)) {
        await refresh({ quiet: true });
        throw new Error("The Brain did not return a matching confirmation. Nothing else will open until the financial list is checked again.");
      }
      const current = await refresh({ quiet: true });
      if (current?.some((entity) => !entity.counterparty && entity.entity_slug === review.entitySlug)) {
        select(review.entitySlug);
        return;
      }
      setMessage("The Brain confirmed the new financial entity, but the list has not refreshed yet. Choose Check again before adding records.");
    } catch (next) {
      if (next instanceof ApiError && next.status === 409 && next.body.code === "entity_already_exists") {
        await refresh({ quiet: true });
        setError("That financial entity already exists. Choose it from the refreshed list instead of adding another copy.");
      } else if (next instanceof ApiError && next.status === 404) {
        setError("This Brain needs an update before it can add the first financial entity here. Nothing was added. Ask your installer to update it before trying again.");
      } else {
        setError(ownerError(next).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4 text-amber-950 sm:px-5">
      <p className="text-[15px] font-semibold">Add your first financial entity</p>
      <p className="mt-1.5 text-[13.5px] leading-relaxed">
        Nothing has been guessed or combined. Enter one exact person, household, business, trust,
        property, or investment so Financial Brain knows where future records belong. This does not
        import an account, decide a tax treatment, or claim that your Financial Map is complete.
      </p>
      {!review ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
          <label className="text-[13px] font-medium">
            Exact name
            <input
              value={legalName}
              maxLength={160}
              onChange={(event) => { setLegalName(event.target.value); edit(); }}
              className="mt-1.5 w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
              placeholder="For example, Rivera Household"
            />
          </label>
          <label className="text-[13px] font-medium">
            What is it?
            <select
              value={kind}
              onChange={(event) => { setKind(event.target.value as FirstEntityKind | ""); edit(); }}
              className="mt-1.5 w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
            >
              <option value="" disabled>Choose one</option>
              {FIRST_ENTITY_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={prepare}
            className="rounded-lg bg-amber-900 px-3.5 py-2 text-[13.5px] font-semibold text-white hover:brightness-95"
          >
            Review
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-amber-400 bg-white px-4 py-4">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">Review before adding</p>
          <p className="mt-2 text-[14px]"><strong>{review.legalName}</strong> will be added as a {kindLabel(review.kind).toLowerCase()} based only on your answer.</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            This creates one owner-confirmed place for records. Review it carefully. If it needs correction
            after you add it, stop and ask your installer to repair it. Financial Brain will not treat this
            as a complete list of your finances.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => { void create(); }}
              className="rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Adding" : "Add this financial entity"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={edit}
              className="rounded-lg border border-line px-3.5 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-50"
            >
              Go back
            </button>
          </div>
        </div>
      )}
      {message && <p role="status" className="mt-3 text-[13.5px] leading-relaxed">{message}</p>}
      {error && <p role="alert" className="mt-3 text-[13.5px] leading-relaxed text-red-800">{error}</p>}
      <p className="mt-3 text-[12.5px] leading-relaxed">
        Not sure what belongs here? Stop and ask your Financial Brain installer to guide the Financial Map interview with you. Do not guess.
      </p>
    </div>
  );
}

function kindLabel(kind: FirstEntityKind): string {
  return FIRST_ENTITY_KINDS.find(([value]) => value === kind)?.[1] || "Financial entity";
}

export function FinanceScopeProvider({ children }: { children: ReactNode }) {
  const [initialSelection] = useState(savedSelection);
  // A browser-saved choice is only a candidate until this Brain's current
  // entity inventory verifies it. Never expose that slug to a search or write
  // while the inventory request is still in flight.
  const pendingInitialSelection = useRef<{ scope: string | null; choiceMade: boolean } | null>(initialSelection);
  const [scope, setScopeState] = useState<string | null>(null);
  const [scopeChoiceMade, setScopeChoiceMade] = useState(false);
  const scopeRef = useRef(scope);
  const scopeChoiceMadeRef = useRef(scopeChoiceMade);
  const choiceRevisionRef = useRef(0);
  const refreshRevisionRef = useRef(0);
  const [entities, setEntities] = useState<FinEntity[]>([]);
  const [status, setStatus] = useState<ScopeStatus>("loading");

  const setScope = useCallback((next: string | null) => {
    pendingInitialSelection.current = null;
    choiceRevisionRef.current += 1;
    scopeRef.current = next;
    scopeChoiceMadeRef.current = true;
    setScopeState(next);
    setScopeChoiceMade(true);
    try {
      if (next) {
        sessionStorage.setItem(STORAGE_KEY, next);
        sessionStorage.setItem(CHOICE_KEY, "entity");
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.setItem(CHOICE_KEY, "all");
      }
    } catch {
      // Storage is a convenience. A private browsing restriction must not
      // make the financial screens unusable.
    }
  }, []);

  const clearScope = useCallback(() => {
    pendingInitialSelection.current = null;
    choiceRevisionRef.current += 1;
    scopeRef.current = null;
    scopeChoiceMadeRef.current = false;
    setScopeState(null);
    setScopeChoiceMade(false);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(CHOICE_KEY);
    } catch {
      // The in-memory state still fails closed when storage is unavailable.
    }
  }, []);

  const refresh = useCallback(async (
    options: { quiet?: boolean } = {},
  ): Promise<FinEntity[] | null> => {
    const refreshRevision = ++refreshRevisionRef.current;
    if (!options.quiet) setStatus("loading");
    try {
      const snapshot = await api<FinSnapshot>("/api/fin/snapshot", { sections: ["entities"] });
      if (refreshRevision !== refreshRevisionRef.current) return null;
      if (!snapshot.ledger_installed) {
        clearScope();
        setEntities([]);
        setStatus("not_installed");
        return null;
      }
      if (!Array.isArray(snapshot.entities)) {
        clearScope();
        setEntities([]);
        setStatus("unavailable");
        return null;
      }
      setEntities(snapshot.entities);
      setStatus("ready");
      const currentScope = scopeRef.current;
      const pending = pendingInitialSelection.current;
      pendingInitialSelection.current = null;
      if (!currentScope && !scopeChoiceMadeRef.current && pending?.choiceMade) {
        if (pending.scope === null) {
          setScope(null);
        } else {
          const verifiedSavedScope = retainExplicitEntityScope(pending.scope, snapshot.entities);
          if (verifiedSavedScope) setScope(verifiedSavedScope);
          else clearScope();
        }
        return snapshot.entities;
      }
      const retained = retainExplicitEntityScope(currentScope, snapshot.entities);
      if (retained !== currentScope) {
        clearScope();
      } else if (!currentScope && !scopeChoiceMadeRef.current) {
        const requestedChoiceRevision = choiceRevisionRef.current;
        try {
          const preferences = await api<OwnerPreferencesResponse>("/api/owner/preferences/read", {});
          if (refreshRevision !== refreshRevisionRef.current) return null;
          const preferred = savedDefaultEntityScope(snapshot.entities, preferences.preferences || []);
          if (savedDefaultStillApplies({
            preferred,
            requestedChoiceRevision,
            currentChoiceRevision: choiceRevisionRef.current,
            currentScope: scopeRef.current,
            choiceMade: scopeChoiceMadeRef.current,
          })) setScope(preferred);
        } catch {
          // With no trustworthy saved default, the owner must choose now.
        }
      }
      return snapshot.entities;
    } catch {
      if (refreshRevision !== refreshRevisionRef.current) return null;
      clearScope();
      setEntities([]);
      setStatus("unavailable");
      return null;
    }
  }, [clearScope, setScope]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<FinanceScopeValue>(() => ({
    scope,
    setScope,
    scopeChoiceMade,
    entities,
    status,
    entityScopeState: entityScopeState(status, scope),
    activeLabel: financeScopeLabel(entities, scope, scopeChoiceMade),
    refresh,
  }), [entities, refresh, scope, scopeChoiceMade, setScope, status]);

  return <FinanceScopeContext.Provider value={value}>{children}</FinanceScopeContext.Provider>;
}

export function useFinanceScope(): FinanceScopeValue {
  const value = useContext(FinanceScopeContext);
  if (!value) throw new Error("useFinanceScope must be used inside FinanceScopeProvider");
  return value;
}

export function FinanceScopeBar({ unavailableMessage = true, requireEntity = false }: {
  unavailableMessage?: boolean;
  requireEntity?: boolean;
}) {
  const { entities, scope, setScope, scopeChoiceMade, status, refresh } = useFinanceScope();
  const statusMessage = scopeStatusMessage(status, requireEntity);
  if (statusMessage) {
    return unavailableMessage ? (
      <Attention>
        <p className="font-semibold">{statusMessage.title}</p>
        <p className="mt-1.5">{statusMessage.detail}</p>
        <button
          type="button"
          onClick={() => { void refresh(); }}
          className="mt-3 rounded-xl border border-current px-3.5 py-2 text-[13.5px] font-semibold hover:bg-white/50"
        >
          Check again
        </button>
      </Attention>
    ) : null;
  }
  if (requireEntity && orderedScopes(entities).length === 0) {
    return <FirstEntitySetup refresh={refresh} select={setScope} />;
  }
  return (
    <ScopeBar
      entities={entities}
      value={scope}
      choiceMade={scopeChoiceMade}
      requireEntity={requireEntity}
      onChange={setScope}
    />
  );
}
