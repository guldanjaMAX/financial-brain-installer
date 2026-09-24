import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinanceScopeProvider } from "./FinanceScope";
import { AttentionList, FirstFinancialEntityPrompt, Glance, Home, needsFirstFinancialEntity, SourceChip } from "./Home";
import { CashSection } from "./ThisYear";
import { UnsortedReview } from "./AddReview";
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

describe("a rounded bank balance never reads as exact", () => {
  const cash = (rounded: number | undefined) => ({
    ledger_installed: true,
    cash: {
      as_of: "2026-09-20", total_minor: 2536298, currency: "USD", mixed_currency: false,
      covered: [
        { account_slug: "fixture-checking", label: "Checking", amount_minor: 11000, currency: "USD", as_of: "2026-09-20", minor_rounded: false },
        { account_slug: "fixture-savings", label: "Savings", amount_minor: 2525298, currency: "USD", as_of: "2026-09-20", minor_rounded: rounded === 1 },
      ],
      missing: [], excluded: [], accounts_covered: 2, accounts_considered: 2, complete: true,
      ...(rounded === undefined ? {} : { rounded_accounts: rounded }),
    },
  }) as unknown as FinSnapshot;

  it("names the rounded balance on Home and on This Year", () => {
    const home = renderToStaticMarkup(<Glance snapshot={cash(1)} scopeName="Fixture Household" />);
    const year = renderToStaticMarkup(<CashSection snapshot={cash(1)} />);
    for (const html of [home, year]) {
      expect(html).toContain("Rounded: 1 balance came from the bank with more decimal places than the currency uses");
      expect(html).toContain("not exact");
    }
  });

  it("stays silent for an exact total and for an older Brain that sends no count", () => {
    for (const snapshot of [cash(0), cash(undefined)]) {
      expect(renderToStaticMarkup(<Glance snapshot={snapshot} scopeName="Fixture Household" />)).not.toContain("Rounded:");
      expect(renderToStaticMarkup(<CashSection snapshot={snapshot} />)).not.toContain("Rounded:");
    }
  });

  it("names rounded lines inside an uncategorized spending total", () => {
    const snapshot = {
      ledger_installed: true,
      accounts: [{ account_slug: "fixture-card", label: "Card", account_kind: "card", balance_role: "liability" }],
      unsorted_spending: [{
        account_slug: "fixture-card", currency: "USD", outflow_minor: 2470,
        counted_lines: 3, unreadable_lines: 0, rounded_lines: 2,
      }],
    } as unknown as FinSnapshot;
    expect(renderToStaticMarkup(<UnsortedReview snapshot={snapshot} />)).toContain("Rounded: 2 lines came from the bank");
  });
});

describe("restricted cash stays visible without inflating spendable cash", () => {
  const snapshot = {
    ledger_installed: true,
    cash: {
      as_of: "2026-09-24", total_minor: 30000, currency: "USD", mixed_currency: false,
      covered: [
        { account_slug: "fixture-checking", label: "Checking", account_kind: "checking", amount_minor: 10000, currency: "USD", as_of: "2026-09-24" },
        { account_slug: "fixture-savings", label: "Savings", account_kind: "savings", amount_minor: 20000, currency: "USD", as_of: "2026-09-24" },
      ],
      missing: [], excluded: [], accounts_covered: 2, accounts_considered: 2, complete: true,
      restricted_cash: {
        label: "Restricted cash",
        explanation: "Restricted cash is money you have, but it is not counted as available to spend.",
        as_of: "2026-09-24", total_minor: 70000, currency: "USD", mixed_currency: false,
        covered: [
          { account_slug: "fixture-cd", label: "Certificate", account_kind: "cd", amount_minor: 30000, currency: "USD", as_of: "2026-09-24" },
          { account_slug: "fixture-hsa", label: "Health savings", account_kind: "hsa", amount_minor: 40000, currency: "USD", as_of: "2026-09-24" },
        ],
        missing: [], accounts_covered: 2, accounts_considered: 2, complete: true,
      },
    },
  } as unknown as FinSnapshot;

  it("shows separate spendable and restricted totals on both cash summaries", () => {
    for (const html of [
      renderToStaticMarkup(<Glance snapshot={snapshot} scopeName="Fixture household" />),
      renderToStaticMarkup(<CashSection snapshot={snapshot} />),
    ]) {
      expect(html).toContain("Spendable cash");
      expect(html).toContain("Restricted cash");
      expect(html).toContain("$300");
      expect(html).toContain("$700");
      expect(html).toContain("not counted as available to spend");
    }
  });
});
