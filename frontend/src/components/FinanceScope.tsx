import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import {
  api, type FinEntity, type FinSnapshot, type OwnerPreference, type OwnerPreferencesResponse,
} from "../lib/api";
import { activeScopeLabel } from "../lib/finance";
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
  refresh: () => Promise<void>;
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

export function FinanceScopeProvider({ children }: { children: ReactNode }) {
  const [initialSelection] = useState(savedSelection);
  const [scope, setScopeState] = useState<string | null>(initialSelection.scope);
  const [scopeChoiceMade, setScopeChoiceMade] = useState(initialSelection.choiceMade);
  const scopeRef = useRef(scope);
  const scopeChoiceMadeRef = useRef(scopeChoiceMade);
  const choiceRevisionRef = useRef(0);
  const refreshRevisionRef = useRef(0);
  const [entities, setEntities] = useState<FinEntity[]>([]);
  const [status, setStatus] = useState<ScopeStatus>("loading");

  const setScope = useCallback((next: string | null) => {
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

  const refresh = useCallback(async () => {
    const refreshRevision = ++refreshRevisionRef.current;
    setStatus("loading");
    try {
      const snapshot = await api<FinSnapshot>("/api/fin/snapshot", { sections: ["entities"] });
      if (refreshRevision !== refreshRevisionRef.current) return;
      if (!snapshot.ledger_installed) {
        clearScope();
        setEntities([]);
        setStatus("not_installed");
        return;
      }
      if (!Array.isArray(snapshot.entities)) {
        clearScope();
        setEntities([]);
        setStatus("unavailable");
        return;
      }
      setEntities(snapshot.entities);
      setStatus("ready");
      const currentScope = scopeRef.current;
      const retained = retainExplicitEntityScope(currentScope, snapshot.entities);
      if (retained !== currentScope) {
        clearScope();
      } else if (!currentScope && !scopeChoiceMadeRef.current) {
        const requestedChoiceRevision = choiceRevisionRef.current;
        try {
          const preferences = await api<OwnerPreferencesResponse>("/api/owner/preferences/read", {});
          if (refreshRevision !== refreshRevisionRef.current) return;
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
    } catch {
      if (refreshRevision !== refreshRevisionRef.current) return;
      clearScope();
      setEntities([]);
      setStatus("unavailable");
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
