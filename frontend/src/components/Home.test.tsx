import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinanceScopeProvider } from "./FinanceScope";
import { AttentionList, FirstFinancialEntityPrompt, Home, needsFirstFinancialEntity, SourceChip } from "./Home";
import type { FinSnapshot } from "../lib/api";

describe("home composition", () => {
  it("mounts durable change history before financial reads resolve", () => {
    const html = renderToStaticMarkup(
      <FinanceScopeProvider><Home /></FinanceScopeProvider>,
    );
    expect(html).toContain("What changed");
    expect(html).not.toContain("visit-to-visit change history is not available");
  });

  it("gives every owner-action row an explicit destination", () => {
    const snapshot = {
      ledger_installed: true,
      deadlines: [{
        deadline_uid: "deadline-1", entity_slug: "mesa", item: "File the return",
        due_date: "2026-10-15", owner_party: "owner", waiting_on: null,
        urgency: "asap", basis_state: "confirmed", consequence: null,
      }],
      exceptions: [{
        exception_uid: "exception-1", entity_slug: "mesa", issue: "Choose a category",
        amount_minor: null, currency: "USD", waiting_on: null,
      }],
      documents: [],
      reconciliations: [],
    } as unknown as FinSnapshot;
    const html = renderToStaticMarkup(
      <AttentionList snapshot={snapshot} entities={[]} scopeName="Mesa Coffee" onNavigate={() => undefined} />,
    );
    expect(html).toContain("Open This Year");
    expect(html).toContain("Open Add &amp; Review");
  });

  it("gives a brand-new owner one plain-language path to the reviewed entity form", () => {
    const html = renderToStaticMarkup(<FirstFinancialEntityPrompt onStart={() => undefined} />);

    expect(html).toContain("Start with one part of your finances");
    expect(html).toContain("will not guess or combine");
    expect(html).toContain("Add my first financial entity");
    expect(html).not.toContain("entity_slug");
  });

  it("never mistakes an unselected existing entity or Whole Brain choice for a brand-new Brain", () => {
    const existing = [{
      entity_slug: "example-business",
      label: "Example Business",
      legal_name: "Example Business",
      kind: "business",
      status: "active",
      relationship: "owned",
      counterparty: false,
    }];

    expect(needsFirstFinancialEntity("required", [])).toBe(true);
    expect(needsFirstFinancialEntity("required", existing)).toBe(false);
    expect(needsFirstFinancialEntity("selected", [])).toBe(false);
  });

  it("names unreadable documents and stale sources instead of relying on the generic problem state", () => {
    const snapshot = {
      ledger_installed: true,
      deadlines: [],
      exceptions: [],
      documents: [{
        fin_doc_uid: "doc-1", entity_slug: "mesa", title: "Receipt scan",
        readable: false, unreadable_reason: "image too dark", availability: "have_it",
      }],
      reconciliations: [],
    } as unknown as FinSnapshot;
    const documents = renderToStaticMarkup(
      <AttentionList snapshot={snapshot} entities={[]} scopeName="Mesa Coffee" />,
    );
    const source = renderToStaticMarkup(<SourceChip state="stale" />);

    expect(documents).toContain("Unreadable copy");
    expect(documents).toContain("This copy could not be read");
    expect(source).toContain("Source out of date");
    expect(source).toContain("Problem");
  });
});
