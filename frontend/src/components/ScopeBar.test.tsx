import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FinEntity } from "../lib/api";
import { ScopeBar } from "./ScopeBar";

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
    fixed: false,
  },
];

describe("financial-entity scope choice", () => {
  it("requires one explicit choice, names the supported kinds, and visibly wraps choices", () => {
    const html = renderToStaticMarkup(
      <ScopeBar entities={entities} value={null} choiceMade={false} requireEntity onChange={vi.fn()} />,
    );

    expect(html).toContain('aria-label="Financial entity selection"');
    expect(html).toContain("Choose one part of your finances to continue");
    expect(html).toContain("person, household, business, trust, property, or investment");
    expect(html).toContain("flex flex-wrap gap-2");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toContain("Whole Brain");
    expect(html).toContain("Household");
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("preserves an explicit Whole Brain choice on unscoped evidence pages", () => {
    const html = renderToStaticMarkup(
      <ScopeBar entities={entities} value={null} choiceMade onChange={vi.fn()} />,
    );

    expect(html).toContain("Whole Brain");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Whole Brain<\/button>/);
    expect(html).not.toContain("Choose what to view");
  });

  it("does not make Whole Brain look selected before the owner chooses it", () => {
    const html = renderToStaticMarkup(
      <ScopeBar entities={entities} value={null} choiceMade={false} onChange={vi.fn()} />,
    );

    expect(html).toContain("Choose what to view");
    expect(html).toContain("Financial Brain will not silently choose for you");
    expect(html).toContain("Whole Brain");
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("shows the exact owner-selected financial entity", () => {
    const html = renderToStaticMarkup(
      <ScopeBar entities={entities} value="family-home" onChange={vi.fn()} />,
    );

    expect(html).toContain("Selected");
    expect(html).not.toContain("Choose one part of your finances to continue");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Household<\/button>/);
  });
});
