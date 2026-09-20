import { describe, expect, it } from "vitest";
import {
  hasPrivateMapKey, validFinancialMapActivation, validFinancialMapNoPending,
  validFinancialMapReview, mapValue,
} from "./financial-map";

const hash = "a".repeat(64);
const counts = { entities: 1, accounts: 1, entity_years: 1, filing_units: 1, obligation_items: 5 };

function review() {
  const value = {
    status: "ready", review_state: "pending", authoritative: false,
    activation_performed: false, complete: true, truncated: false,
    review_id: `ofmp_${"b".repeat(64)}`, map_hash: hash,
    denominator_hash: "c".repeat(64), expected_sequence: 2,
    created_at: 1, expires_at: 2, counts,
    complete_preview: {
      population_state: "known_partial",
      tax_year_horizon: { start: 2025, end: 2025 },
      filing_units: [{ label: "Primary filing unit", assessment: "confirmed" }],
      entities: [{
        label: "Exact Family Business", disposition: "included",
        evidence_state: "linked_current_record",
        fields: {
          kind: { assessment: "confirmed", owner_value: "business", current_value: "business", comparison: "matches_current" },
          status: { assessment: "confirmed", owner_value: "active", current_value: "active", comparison: "matches_current" },
          holds: { assessment: "not_applicable", owner_value: null, current_value: null, comparison: "matches_current" },
          ownership: { assessment: "confirmed", owner_value: 10000, current_value: 10000, comparison: "matches_current" },
          tax_class: { assessment: "confirmed", owner_value: "S corporation", current_value: "S corporation", comparison: "matches_current" },
          relationship: { assessment: "confirmed", owner_value: "owned", current_value: "owned", comparison: "matches_current" },
          parent: { assessment: "not_applicable", owner_value: null, current_value: null, comparison: "matches_current" },
        },
        tax_years: [{
          tax_year: 2025, state: "included",
          filing_units: { assessment: "confirmed", labels: ["Primary filing unit"] },
          required_returns: { assessment: "confirmed", items: [{ label: "Form 1120-S", assessment: "confirmed" }] },
          required_forms: { assessment: "confirmed", items: [{ label: "State filing", assessment: "confirmed" }] },
          k1_roles: { assessment: "not_applicable", items: [] },
          books: { assessment: "confirmed", bookkeeping_company: { label: "Exact Books", assessment: "confirmed" } },
          payroll: { assessment: "not_applicable" },
          expected_sources: { assessment: "confirmed", items: [
            { label: "Operating 4242", kind: "banking", assessment: "confirmed" },
            { label: "Payroll source", kind: "payroll", assessment: "confirmed" },
          ] },
        }],
      }],
      accounts: [{
        label: "Operating 4242", disposition: "included",
        evidence_state: "linked_current_record", fields: {
          entity_assignment: { assessment: "confirmed", owner_value: "Exact Family Business", current_value: "Exact Family Business", comparison: "matches_current" },
          kind: { assessment: "confirmed", owner_value: "checking", current_value: "checking", comparison: "matches_current" },
          balance_role: { assessment: "confirmed", owner_value: "asset", current_value: "asset", comparison: "matches_current" },
          currency: { assessment: "confirmed", owner_value: "USD", current_value: "USD", comparison: "matches_current" },
          status: { assessment: "confirmed", owner_value: "open", current_value: "open", comparison: "matches_current" },
        },
      }],
    },
    prior_comparison: {
      state: "compared", changed: true, change_count: 1,
      changes: [{ area: "Entities", subject: "Exact Family Business", field: "tax class", before: "LLC", after: "S corporation" }],
      previous_confirmed_map: null as unknown,
    },
    unresolved_count: 0, unresolved_items: [],
    requires: "explicit_owner_passkey_confirmation",
  };
  value.prior_comparison.previous_confirmed_map = structuredClone(value.complete_preview);
  return value;
}

describe("Financial Map response gates", () => {
  it("keeps private labels and financial form text exact while formatting machine enums", () => {
    expect(mapValue("tax_class", "S corporation / Form 1120-S")).toBe("S corporation / Form 1120-S");
    expect(mapValue("entity_assignment", "McDONALD holdings, LLC · 4242")).toBe("McDONALD holdings, LLC · 4242");
    expect(mapValue("balance_role", "contra_asset")).toBe("Contra Asset");
  });

  it("accepts complete exact private labels while rejecting internal locators anywhere in the map", () => {
    const value = review();
    expect(validFinancialMapReview(value)).toBe(true);
    expect(hasPrivateMapKey(value)).toBe(false);
    expect(validFinancialMapReview({
      ...value,
      complete_preview: { ...value.complete_preview, account_slug: "private-account" },
    })).toBe(false);
    expect(validFinancialMapReview({
      ...value,
      complete_preview: {
        ...value.complete_preview,
        accounts: [{ ...value.complete_preview.accounts[0], fields: {} }],
      },
    })).toBe(false);
    expect(validFinancialMapReview({ ...value, truncated: true })).toBe(false);
    expect(validFinancialMapReview({ ...value, counts: { ...counts, accounts: 2 } })).toBe(false);
  });

  it("allows only the transient top-level verification fields required by activation", () => {
    const activation = {
      activated: true, replayed: false, sequence: 2, map_hash: hash,
      denominator_hash: "c".repeat(64), population_state: "known_partial",
      tax_year_horizon: { start: 2025, end: 2025 }, counts,
      request_id: "financial_map_fixture", activated_at: 2,
      mutations: {
        owner_financial_map_snapshot: "appended", ledger: "none", sources: "none",
        taxes: "none", books: "none", payroll: "none", accounts: "none",
      },
    };
    expect(validFinancialMapActivation(activation)).toBe(true);
    expect(validFinancialMapActivation({
      ...activation, mutations: { ...activation.mutations, ledger: "updated" },
    })).toBe(false);
    expect(validFinancialMapActivation({ ...activation, snapshot_ref: "ofm_private" })).toBe(false);
    expect(validFinancialMapActivation({
      ...activation, mutations: { ...activation.mutations, request_id: "nested-private" },
    })).toBe(false);
  });

  it("validates the authoritative reread without treating an absent map as current", () => {
    expect(validFinancialMapNoPending({
      status: "no_pending_review", review_state: "none", complete: true, truncated: false,
      active_map_present: true, active_map_authoritative: true, active_sequence: 2,
      active_map_hash: hash, active_denominator_hash: "c".repeat(64), active_activated_at: 2,
      owner_message: "Current.",
    })).toBe(true);
    expect(validFinancialMapNoPending({
      status: "no_pending_review", review_state: "none", complete: true, truncated: false,
      active_map_present: false, active_map_authoritative: true, active_sequence: null,
      active_map_hash: null, active_denominator_hash: null, active_activated_at: null,
      owner_message: "None.",
    })).toBe(false);
  });
});
