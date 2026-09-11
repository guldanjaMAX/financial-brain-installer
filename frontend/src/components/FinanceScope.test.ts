import { describe, expect, it } from "vitest";
import type { FinEntity } from "../lib/api";
import {
  entityScopeState, financeScopeLabel, firstEntitySlug, matchingEntityCreateReceipt,
  retainExplicitEntityScope, savedDefaultEntityScope, savedDefaultStillApplies,
  scopeStatusMessage,
} from "./FinanceScope";

const entities: FinEntity[] = [
  {
    entity_slug: "company-alpha",
    legal_name: "Company Alpha LLC",
    label: "Company Alpha",
    kind: "business",
    status: "active",
    relationship: "owned",
    counterparty: false,
    fixed: false,
  },
  {
    entity_slug: "family-home",
    legal_name: "Example Household",
    label: "Household",
    kind: "household",
    status: "active",
    relationship: "owned",
    counterparty: false,
    fixed: true,
  },
  {
    entity_slug: "vendor-beta",
    legal_name: "Vendor Beta LLC",
    label: "Vendor Beta",
    kind: "business",
    status: "active",
    relationship: "counterparty",
    counterparty: true,
    fixed: false,
  },
];

describe("explicit financial-entity scope", () => {
  it("does not select the only available owner entity when the owner has not chosen", () => {
    expect(retainExplicitEntityScope(null, [entities[0]])).toBeNull();
    expect(entityScopeState("ready", null)).toBe("required");
  });

  it("retains owned entities of every supported kind and rejects missing or counterparty choices", () => {
    expect(retainExplicitEntityScope("company-alpha", entities)).toBe("company-alpha");
    expect(retainExplicitEntityScope("family-home", entities)).toBe("family-home");
    expect(retainExplicitEntityScope("vendor-beta", entities)).toBeNull();
    expect(retainExplicitEntityScope("missing-business", entities)).toBeNull();
    expect(entityScopeState("ready", "family-home")).toBe("selected");
  });

  it("treats only a valid saved owner default as an explicit prior choice", () => {
    expect(savedDefaultEntityScope(entities, [{
      preference_key: "default_entity", entity_slug: null, value: "company-alpha",
    }])).toBe("company-alpha");
    expect(savedDefaultEntityScope(entities, [])).toBeNull();
    expect(savedDefaultEntityScope(entities, [{
      preference_key: "default_entity", entity_slug: null, value: "missing-business",
    }])).toBeNull();
    expect(savedDefaultEntityScope(entities, [{
      preference_key: "default_entity", entity_slug: null, value: "vendor-beta",
    }])).toBeNull();
    expect(savedDefaultEntityScope([{ ...entities[0], status: "closed" }], [{
      preference_key: "default_entity", entity_slug: null, value: "company-alpha",
    }])).toBeNull();
  });

  it("keeps each non-ready inventory state distinct", () => {
    expect(entityScopeState("loading", "company-alpha")).toBe("checking");
    expect(entityScopeState("unavailable", "company-alpha")).toBe("unavailable");
    expect(entityScopeState("not_installed", null)).toBe("not_installed");
  });

  it("distinguishes no choice from an explicit whole-Brain choice in owner-facing labels", () => {
    expect(financeScopeLabel(entities, null, false)).toBe("No financial entity selected");
    expect(financeScopeLabel(entities, null, true)).toBe("Whole Brain");
    expect(financeScopeLabel(entities, "company-alpha", true)).toBe("Company Alpha");
  });

  it("never lets a delayed saved default replace a fresh owner choice", () => {
    expect(savedDefaultStillApplies({
      preferred: "company-alpha",
      requestedChoiceRevision: 0,
      currentChoiceRevision: 1,
      currentScope: "family-home",
      choiceMade: true,
    })).toBe(false);
    expect(savedDefaultStillApplies({
      preferred: "company-alpha",
      requestedChoiceRevision: 0,
      currentChoiceRevision: 1,
      currentScope: null,
      choiceMade: true,
    })).toBe(false);
    expect(savedDefaultStillApplies({
      preferred: "company-alpha",
      requestedChoiceRevision: 0,
      currentChoiceRevision: 0,
      currentScope: null,
      choiceMade: false,
    })).toBe(true);
  });

  it("gives loading and unavailable states an explicit recovery path", () => {
    expect(scopeStatusMessage("loading", true)?.title).toBe("Checking your financial list");
    expect(scopeStatusMessage("not_installed", false)?.detail).toContain("whole-Brain read-only page");
    expect(scopeStatusMessage("unavailable", true)?.detail).toContain("Nothing has been added or changed");
    expect(scopeStatusMessage("ready", true)).toBeNull();
  });

  it("creates a private transport slug without treating the owner's label as an identifier", () => {
    const first = firstEntitySlug(" Rivera & Family, LLC ", "entity_12345678");
    expect(first).toBe("rivera-family-llc-12345678");
    expect(first).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    expect(firstEntitySlug("Rivera & Family, LLC", "entity_87654321")).not.toBe(first);
    expect(firstEntitySlug("家族", "entity_12345678")).toBe("entity-12345678");
  });

  it("accepts only the exact first-entity receipt before selecting it", () => {
    const review = {
      legalName: "Rivera Household",
      kind: "household" as const,
      requestId: "entity_12345678",
      entitySlug: "rivera-household-12345678",
    };
    const receipt = {
      request_id: review.requestId,
      entity_scope: { entity_slug: review.entitySlug },
      entity: {
        entity_slug: review.entitySlug,
        legal_name: review.legalName,
        kind: review.kind,
      },
      changed: true,
      replayed: false,
    };
    expect(matchingEntityCreateReceipt(receipt, review)).toBe(true);
    expect(matchingEntityCreateReceipt({
      ...receipt, entity_scope: { entity_slug: "another-entity" },
    }, review)).toBe(false);
    expect(matchingEntityCreateReceipt({ ...receipt, replayed: undefined }, review)).toBe(false);
  });
});
