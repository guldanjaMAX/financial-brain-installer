import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinanceScopeProvider } from "./FinanceScope";
import { AttentionList, FirstFinancialEntityPrompt, Glance, Home, needsFirstFinancialEntity, pendingCountLabel, PhaseNotice, SourceChip, SystemProblems } from "./Home";
import { CashSection } from "./ThisYear";
import { UnsortedReview } from "./AddReview";
import type { FinSnapshot } from "../lib/api";
import { derivePhase, phraseFor } from "../lib/phase";

describe("home composition", () => {
  it("renders a partial status with a verified document count as still loading, not unreachable", () => {
    const status = {
      status: "ok",
      accepting_documents: true,
      documents: 12,
      unavailable: ["diagnose"],
      sources: [],
      vectors: null,
    } as never;

    const phase = derivePhase(status);
    const html = renderToStaticMarkup(<PhaseNotice phase={phase} status={status} />);

    expect(phase).toBe("coverage_unknown");
    expect(html).toContain("Your brain is still loading");
    expect(html).not.toContain("could not be reached");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });

  it("renders a capped vector queue as a lower bound rather than an exact count", () => {
    expect(pendingCountLabel(10_001, true)).toBe("10,000+");
    expect(pendingCountLabel(105, false)).toBe("105");
  });

  it("reserves the red Problem treatment for critical findings", () => {
    const status = {
      documents: 3,
      problems: [
        { id: "undated", area: "coverage", severity: "warn", count: 3, title: "technical date warning", detail: "operator detail" },
        { id: "damaged", area: "integrity", severity: "crit", count: 1, title: "A critical finding", detail: "Critical detail" },
      ],
    } as never;

    const html = renderToStaticMarkup(<SystemProblems status={status} />);

    expect(html).toContain("Some documents have no date (3 of 3)");
    expect(html).toContain("Questions like &#x27;what&#x27;s the latest?&#x27; can only use dated documents. Nothing is wrong with your Brain.");
    expect(html).toContain("Worth knowing");
    expect(html.match(/Problem/g)).toHaveLength(1);
    expect(html).not.toContain("This is not an owner remedy");

    const phase = derivePhase({
      status: "ok",
      accepting_documents: true,
      documents: 3,
      unavailable: [],
      sources: [],
      vectors: { ready: true, expected: 3, visible: 3, pending: 0, pending_is_capped: false, percent_visible: 100 },
      problem_counts: { crit: 0, warn: 1, info: 0 },
      problems: status.problems.slice(0, 1),
    });
    expect(phase).toBe("ready");
  });

  it("keeps integrity warnings in the installer-owned problems phase", () => {
    const integrityWarning = {
      id: "chunk_document_source_mismatch",
      area: "integrity",
      severity: "warn",
      count: 1,
      title: "Chunk source does not match its document",
      detail: "Source filters and provenance can still be misleading.",
      fix_owner: "installer",
    } as const;
    const status = {
      status: "ok",
      accepting_documents: true,
      documents: 3,
      unavailable: [],
      sources: [],
      vectors: { ready: true, expected: 3, visible: 3, pending: 0, pending_is_capped: false, percent_visible: 100 },
      problem_counts: { crit: 0, warn: 1, info: 0 },
      problems: [integrityWarning],
    };

    expect(status.problems).toContain(integrityWarning);
    const phase = derivePhase(status);
    expect(phase).toBe("problems");
    expect(phraseFor(phase, status)).toContain("your installer should look at");
  });

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
