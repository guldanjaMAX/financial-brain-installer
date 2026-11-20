import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ownerThinkResponse } from "../../test/rehearsal-responses.mjs";
const screenState = vi.hoisted(() => ({
  enabled: false, index: 0, values: [] as unknown[], scope: null as string | null,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState(initial: unknown) {
    if (!screenState.enabled) return actual.useState(initial);
    const index = screenState.index++;
    if (!(index in screenState.values)) screenState.values[index] = typeof initial === "function" ? initial() : initial;
    return [screenState.values[index], (value: unknown) => { screenState.values[index] = value; }];
  } };
});
vi.mock("./FinanceScope", () => ({
  useFinanceScope: () => ({ activeLabel: "Selected records", scope: screenState.scope }),
  FinanceScopeBar: () => null,
}));
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(), api: vi.fn(),
}));
import { api } from "../lib/api";
import type { Answer } from "../lib/api";
import { moneyQuestionHandoff } from "../../../worker/src/lib/money-handoff.js";
import {
  ANSWER_ERROR_MESSAGES, answerText, confidenceText, documentResponseConfidence, nextActionText,
} from "../lib/answer-render.js";
import { unavailableNotice } from "../lib/retrieval-status.js";
import {
  Ask, Trust, CitationSources, EvidenceGateReason, SCOPED_SEARCH_UNAVAILABLE, ScannedEvidenceNote,
  citationMeta, citationTitle, evidenceGateNote, readAskDraft, writeAskDraft,
} from "./Ask";

// The owner reads the answer and its evidence note together. Deduplicated facts
// may live in either place, but must never disappear into input metadata.
const ownerReading = (answer: Answer) => renderToStaticMarkup(<><p>{answerText(answer)}</p><Trust answer={answer} /></>);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  screenState.enabled = false;
  screenState.index = 0;
  screenState.values = [];
  screenState.scope = null;
  vi.mocked(api).mockReset();
});
afterEach(() => { screenState.enabled = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("answer messages", () => {
  it("keeps the typed owner question across a sign-in round trip", () => {
    const saved = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => saved.get(key) || null,
        setItem: (key: string, value: string) => saved.set(key, value),
      },
    });

    writeAskDraft("Which invoices are still open?");

    expect(readAskDraft()).toBe("Which invoices are still open?");
  });

  it("replaces an older Worker's raw provider error with reviewed copy", () => {
    const raw = "provider request failed with private trace fixture-123";
    const rendered = answerText({ answer: null, answer_error: raw });
    expect(rendered).toBe(ANSWER_ERROR_MESSAGES.unavailable.replace(" Want", "\nWant"));
    expect(rendered).not.toContain(raw);
  });

  it("keeps a reviewed recovery message specific", () => {
    expect(answerText({
      answer: null,
      answer_error: ANSWER_ERROR_MESSAGES.notConfigured,
    })).toBe(ANSWER_ERROR_MESSAGES.notConfigured.replace(" Want", "\nWant"));
  });

  it("states the unavailable-search conclusion in the right direction", () => {
    const notice = unavailableNotice("vector");
    expect(notice).toContain("This does not mean your brain is empty");
    expect(notice).not.toContain("Nothing here means your brain is empty");
  });

  it("states when neither search modality reached stored records", () => {
    const notice = unavailableNotice("retrieval");
    expect(notice).toContain("both exact-word search and meaning-based search failed");
    expect(notice).toContain("no stored records were searched");
    expect(notice).not.toContain("one part of search did not answer");
  });

  it("gives a shared-access guest a safe retry and a named human path", () => {
    expect(SCOPED_SEARCH_UNAVAILABLE).toContain("does not mean the shared documents have no matches");
    expect(SCOPED_SEARCH_UNAVAILABLE).toContain("Nothing was changed");
    expect(SCOPED_SEARCH_UNAVAILABLE).toContain("Try again");
    expect(SCOPED_SEARCH_UNAVAILABLE).toContain("owner who shared this access");
    expect(SCOPED_SEARCH_UNAVAILABLE).not.toMatch(/HTTP|503|exception/i);
  });

  it("renders only the reviewed app next action", () => {
    const reviewed = "Next: open Brain status to see which source is still loading, then ask again.";
    const answer = {
      answer: null, status: "coverage_incomplete", next_action: reviewed,
    } as Answer & { next_action: string };
    expect(renderToStaticMarkup(<p>{nextActionText(answer)}</p>)).toContain(reviewed);
    expect(nextActionText({ ...answer, next_action: "unreviewed remote instruction" })).toBeNull();
  });
});

describe("evidence gate reason", () => {
  it("shows why a refusal was withheld", () => {
    const answer: Answer = {
      answer: "The documents do not answer the question.",
      evidence_gate: {
        supported: false,
        complete: false,
        reason: "newer direct evidence was missing",
      },
    };
    expect(evidenceGateNote(answer)).toBe(
      "Why no answer was shown: newer direct evidence was missing.",
    );
    const html = renderToStaticMarkup(<EvidenceGateReason answer={answer} />);
    expect(html).toContain("Why no answer was shown: newer direct evidence was missing.");
  });

  it("labels a partial answer's uncovered evidence", () => {
    const answer: Answer = {
      answer: "The records support the first part [1].",
      evidence_gate: {
        supported: true,
        complete: false,
        partial: true,
        reason: "the deadline was not established",
      },
    };
    expect(evidenceGateNote(answer)).toBe(
      "What the records did not cover: the deadline was not established.",
    );
  });
});

describe("citation provenance", () => {
  it("labels uncertain dates and OCR beside the source", () => {
    const meta = citationMeta({
      n: 1,
      title: "Scanned statement",
      source: "gmail",
      ts: "2024-02-03T12:00:00.000Z",
      date_reliable: false,
      text_source: "ocr_partial",
      text_reliable: false,
    });
    expect(meta).toBe("Email · around Feb 3, 2024 · OCR text may be incomplete");
  });

  it("keeps a legacy citation with missing date trust uncertain", () => {
    const meta = citationMeta({
      n: 1,
      title: "Legacy note",
      source: "drive",
      ts: "2024-02-03T00:00:00.000Z",
    });
    expect(meta).toBe("Google Drive · around Feb 3, 2024");
  });

  it("renders provenance on the citation instead of silently dropping it", () => {
    const html = renderToStaticMarkup(<CitationSources citations={[{
      n: 2,
      title: "Native note",
      source: "drive",
      ts: "2024-04-05T00:00:00.000Z",
      date_reliable: true,
      text_source: "native",
      text_reliable: true,
    }]} />);
    expect(html).toContain("Google Drive");
    expect(html).toContain("Apr 5, 2024");
  });

  it("shows a valid short authority label for owner and scoped citation lists", () => {
    const citation = {
      n: 1,
      title: "Owner-confirmed mailing address",
      source: "curated",
      authority: {
        tier: "T1" as const,
        rank: 1,
        name: "primary",
        reason: "owner-confirmed operative mailing address as of 2026-09-01",
      },
    };
    expect(citationMeta(citation)).toBe("Files you uploaded · Original record");
    const html = renderToStaticMarkup(<CitationSources citations={[citation]} />);
    expect(html).toContain("Original record");
    expect(html).not.toContain("T1 primary");
    expect(html).not.toContain("owner-confirmed operative mailing address");
  });

  it("does not display an authority label when the tier and name disagree", () => {
    expect(citationMeta({
      n: 1,
      title: "Untrusted authority payload",
      authority: {
        tier: "T1",
        rank: 1,
        name: "recollection",
        reason: "malformed",
      },
    })).toBe("");
  });
});

describe("scanned evidence", () => {
  const notice =
    "Part of this answer comes from a scanned document read by OCR. Check the original for exact figures.";
  const scanned = {
    n: 1,
    title: "Storage contract scan",
    source: "drive",
    text_source: "ocr",
    text_reliable: false,
    scanned: true,
  };
  const answered: Answer = {
    answer: "The monthly storage fee is recorded [1].",
    citations: [scanned],
    gaps: [{ type: "scanned_evidence", count: 1, total: 1, detail: notice }],
    evidence_gate: { supported: true, complete: true },
  };

  it("states the fixed scanned-copy notice beside an answer that rests on a scan", () => {
    expect(renderToStaticMarkup(<ScannedEvidenceNote answer={answered} />)).toContain(notice);
  });

  it("marks the scanned citation and keeps its OCR provenance", () => {
    expect(citationTitle(scanned)).toBe("Storage contract scan (scanned)");
    expect(citationMeta(scanned)).toBe("Google Drive · OCR text, verify key details");
    expect(renderToStaticMarkup(<CitationSources citations={[scanned]} />))
      .toContain("Storage contract scan (scanned)");
  });

  it("does not promote native, partial, or unflagged OCR citations", () => {
    const native = { n: 1, title: "Native contract", source: "drive", text_source: "native", text_reliable: true };
    const partial = { n: 2, title: "Half-read scan", source: "drive", text_source: "ocr_partial", text_reliable: false };
    const unflagged = { n: 3, title: "Marked scan", source: "drive", text_source: "ocr", text_reliable: false };
    expect(citationTitle(native)).toBe("Native contract");
    expect(citationTitle(partial)).toBe("Half-read scan");
    expect(citationTitle(unflagged)).toBe("Marked scan");
    expect(citationMeta(partial)).toBe("Google Drive · OCR text may be incomplete");
    expect(renderToStaticMarkup(<ScannedEvidenceNote answer={{
      answer: "The records were checked [1] [2] [3].",
      citations: [native, partial, unflagged],
      gaps: [],
    }} />)).toBe("");
  });

  it("carries no scanned notice on a refusal or provisional result", () => {
    for (const answer of [
      { answer: "The documents do not answer the question.", citations: [], gaps: [] },
      { answer: null, status: "coverage_incomplete", notice: "provisional", citations: [scanned], gaps: [] },
    ] as Answer[]) {
      expect(renderToStaticMarkup(<ScannedEvidenceNote answer={answer} />)).toBe("");
    }
  });
});

describe("explicit tax evidence action", () => {
  it("sends only the chosen entity and typed year, never the draft question", async () => {
    const { taxEvidenceAction } = await import("./Ask");
    expect(taxEvidenceAction("fixture-entity", "2025")).toEqual({
      workflow: "tax_evidence_checklist", entity: "fixture-entity", year: 2025,
    });
    for (const year of ["", "2025.5", "2e3", "2025 text", "1899", "2201"]) {
      expect(taxEvidenceAction("fixture-entity", year)).toBeNull();
    }
    expect(taxEvidenceAction(null, "2025")).toBeNull();
  });

  it("shows the action only to an owner and requires entity and year choices", async () => {
    const { TaxEvidenceControl } = await import("./Ask");
    const props = { owner: true, scope: "fixture-entity", year: "2025", busy: false,
      onYear: () => undefined, onCheck: () => undefined };
    const owner = renderToStaticMarkup(<TaxEvidenceControl {...props} />);
    expect(owner).toContain("Tax evidence checklist");
    expect(owner).toContain("Tax year");
    expect(owner).toContain("Tax amounts and filing readiness are not checked");
    expect(owner).not.toContain('disabled=""');
    expect(renderToStaticMarkup(<TaxEvidenceControl {...props} owner={false} />)).toBe("");
    expect(renderToStaticMarkup(<TaxEvidenceControl {...props} scope={null} />)).toBe("");
    for (const patch of [{ year: "" }, { busy: true }]) {
      expect(renderToStaticMarkup(<TaxEvidenceControl {...props} {...patch} />)).toContain('disabled=""');
    }
  });
});

describe("calm Explore presentation", () => {
  const facts = "The recorded fee is $42 for October 2026 [1].";
  const coverage = "Coverage: Account ending 4321, October 1 through October 31, 2026.\nMissing or counted twice: A second statement.\nEstimates: Likely current, based on the dated record.\nHow to check: Open the original statement.";
  const basis = ["One original read.", "The record has a reliable date.", "A second statement is missing.", "Independent checks are incomplete."];
  function supported(percent = 69): Answer {
    return { ...ownerThinkResponse("empty"), status: "ok", answer: `${facts}\n\n${coverage}`,
      answer_contract: { version: 1, kind: "document" },
      confidence: { percent, band: "High", basis, missing: ["A second statement."] },
      citations: [{ n: 1, title: "Original statement", source: "drive" }],
    } as Answer;
  }
  function ownerView(answer: Answer | null, busy = false) {
    screenState.enabled = true;
    screenState.index = 0;
    screenState.values = ["What is the recorded fee?", "", answer, busy, null, "All finances"];
    return renderToStaticMarkup(<Ask owner />);
  }
  // CONF-HIDE-1117 (founder 11-17): owners never see the confidence word or
  // score. The internal score is unchanged and thin evidence gets one plain note.
  const scoreLine = /Confidence\s*:|\b(?:High|Medium|Low)\s*\(?\d+%/i;
  const plainNote = "this answer may be incomplete.";
  function plainLow(html: string, answer: Answer) {
    expect(html).not.toMatch(scoreLine);
    expect(documentResponseConfidence(answer).percent, "internal score stays Low").toBeLessThan(70);
    expect(html).toContain(plainNote);
  }
  function sections(html: string) {
    const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) || [];
    expect(details, "one shared explanation was reached").toHaveLength(1);
    expect(details[0]).toContain("Coverage and how to check");
    expect(details[0].match(/^<details\b[^>]*>/)?.[0]).not.toMatch(/\bopen(?:=|\s|>)/);
    return { closed: details[0], visible: html.replace(details[0], "") };
  }
  function button(tree: ReactNode, label: string): ReactElement<{ onClick: () => Promise<void> }> | undefined {
    if (Array.isArray(tree)) return tree.map(child => button(child, label)).find(Boolean);
    if (!tree || typeof tree !== "object" || !("props" in tree)) return undefined;
    const element = tree as ReactElement<{ children?: ReactNode; onClick: () => Promise<void> }>;
    if (element.type === "button" && element.props.children === label) return element;
    return button(element.props.children, label);
  }

  it("keeps the answer, sources and internal Low score as a green control", () => {
    const answer = supported(69);
    const html = ownerView(answer);
    expect(html).toContain(facts);
    expect(html).toContain("Original statement");
    plainLow(html, answer);
    expect(documentResponseConfidence(answer).percent).toBe(69);
    expect(html).not.toContain("Confidence: High");
  });

  it("shows one plain evidence note, with the coverage block in one closed explanation", () => {
    const answer = supported();
    const { visible, closed } = sections(ownerView(answer));
    expect(visible).toContain(facts);
    plainLow(visible, answer);
    expect(closed).not.toMatch(scoreLine);
    // The reasons now travel in the one plain note (CONF-HIDE), each shown once.
    for (const reason of basis.map(text => text.replace(/\.$/, ""))) {
      expect(visible).toContain(reason);
      expect(closed).not.toContain(reason);
    }
    expect(closed).toContain(coverage);
    expect(visible).not.toContain("Coverage:");
    expect(closed).not.toContain("Missing: A second statement.");
  });

  it("keeps a distinct missing-evidence explanation when the body has no missing block", () => {
    const answer = { ...supported(), answer: facts };
    const html = ownerView(answer);
    expect(html.match(/<details\b/g), "no empty explanation without a coverage block").toBeNull();
    expect(html).toContain("Still needed: A second statement");
    expect(html).not.toContain("Missing:");
    plainLow(html, answer);
  });

  it("finds Coverage at the first line boundary even without a blank paragraph", () => {
    const { visible, closed } = sections(ownerView({ ...supported(), answer: `${facts}\n${coverage}` }));
    expect(visible).toContain(facts);
    expect(closed).toContain(coverage);
    expect(visible).not.toContain("How to check:");
  });

  it("keeps complete answer contracts despite older unavailable metadata", () => {
    for (const status of ["coverage_incomplete", "search_unavailable", "answer_withheld"]) {
      const answer = { ...supported(), status };
      const html = ownerView(answer);
      expect(html).toContain(facts);
      expect(html).toContain(coverage);
      plainLow(html, answer);
      expect(documentResponseConfidence(answer).percent).toBe(69);
    }
  });

  for (const status of ["coverage_incomplete", "search_unavailable", "answer_withheld"]) {
    for (const readable of [true, false]) {
      it(`preserves the ${readable ? "readable legacy answer" : "empty legacy reading"} inside the recovery layout for ${status}`, async () => {
        const record = { n: 1, title: "Original statement", source: "drive",
          text: "The recorded fee is $42 for October 2026.", ts: "2026-10-31" };
        const answer = { status, answer: null, results: readable ? [record] : [],
          citations: readable ? [{ n: record.n, title: record.title, source: record.source, ts: record.ts }] : [],
        } as Answer;
        ownerView(null);
        vi.mocked(api).mockResolvedValue(answer);
        screenState.index = 0;
        const ask = button(Ask({ owner: true }), "Ask");
        expect(ask, "real submit decision point").toBeDefined();
        await ask!.props.onClick();
        expect(api).toHaveBeenCalledTimes(1);
        expect(api).toHaveBeenCalledWith("/api/rag/think", { q: "What is the recorded fee?", limit: 12 });
        screenState.index = 0;
        const html = renderToStaticMarkup(<Ask owner />);
        const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/);
        expect(article, "real answer article rendered").not.toBeNull();
        const { visible, closed } = sections(article![1]);
        expect(visible, "recovery branch reached").toContain(`Code: ${status}`);
        expect(visible).toContain("Try again");
        const action = renderToStaticMarkup(<>{nextActionText(answer)}</>);
        expect(visible).toContain(action);
        plainLow(visible, answer);
        expect(closed).not.toMatch(scoreLine);
        expect(visible).not.toContain("Confidence: High");
        if (readable) {
          expect(visible).toContain(record.text);
          expect(visible).toContain("Likely relevant: As of 2026-10-31");
          expect(visible).toContain("Original statement");
          expect(visible).toContain("[1]");
          expect(closed).toContain("Read 1 of 1 retrieved records");
          expect(closed).toContain("attributed statements are not confirmation");
        } else {
          expect(closed).toContain("The available reading contains no readable matching statement.");
          expect(visible).not.toContain("The available reading contains no readable matching statement.");
          expect(visible).not.toContain("This result is provisional.");
          expect(closed).toContain("Read 0 of 0 retrieved records");
        }
        for (const label of ["Coverage:", "Missing or counted twice:", "Estimates:", "How to check:"]) {
          expect(closed).toContain(label);
          expect(visible).not.toContain(label);
        }
        // Preserve every shared-renderer qualification, not just its headings.
        for (const line of answerText(answer).split("\n").filter(Boolean)) {
          expect(article![1]).toContain(renderToStaticMarkup(<>{line}</>));
        }
        expect(visible.split(action)).toHaveLength(2);
      });
    }
  }

  it("keeps an unverified legacy draft out of the answer while retaining attributed record evidence", () => {
    const answer = { status: "coverage_incomplete", answer: "The recorded fee is $999 for October 2026 [1].",
      results: [{ n: 1, title: "Original statement", source: "drive",
        text: "The recorded fee is $42 for October 2026.", ts: "2026-10-31" }],
      confidence: { percent: 99, band: "High" },
    } as Answer;
    const { visible, closed } = sections(ownerView(answer));
    expect(visible, "recovery branch reached").toContain("Code: coverage_incomplete");
    expect(visible).toContain("The recorded fee is $42 for October 2026.");
    expect(visible).toContain("Likely relevant: As of 2026-10-31");
    plainLow(visible, answer);
    expect(visible + closed).not.toContain("$999");
    expect(visible + closed).not.toContain("Confidence: High");
    expect(closed).toContain("How to check:");
  });

  it("offers the reviewed outage action and retry with a separate code, with the provisional wall collapsed", () => {
    const answer = { ...ownerThinkResponse("empty"), status: "search_unavailable",
      gaps: [{ type: "search_unavailable" }],
    } as Answer;
    const html = ownerView(answer);
    expect(html).toContain("ask again in a minute");
    expect(html).toContain("Try again");
    expect(html).toContain("Code: search_unavailable");
    plainLow(html, answer);
    expect(html).not.toContain("resolve: search_unavailable");
    expect(html).not.toContain("Coverage gap: search_unavailable");
    const { visible, closed } = sections(html);
    expect(visible).not.toContain("Source coverage is incomplete. This result is provisional.");
    expect(closed).toContain("Source coverage is incomplete. This result is provisional.");
    expect(ownerView(supported())).not.toContain("Try again");
  });

  it("retries the submitted question even after the owner edits the draft", async () => {
    ownerView(null);
    vi.mocked(api).mockResolvedValue({ ...ownerThinkResponse("empty"), status: "search_unavailable" });
    screenState.index = 0;
    const ask = button(Ask({ owner: true }), "Ask");
    expect(ask, "real Ask decision point").toBeDefined();
    await ask!.props.onClick();
    expect(api).toHaveBeenCalledTimes(1);
    screenState.values[0] = "An edited draft for later";
    screenState.index = 0;
    const retry = button(Ask({ owner: true }), "Try again");
    expect(retry, "real retry decision point").toBeDefined();
    await retry!.props.onClick();
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls[1]).toEqual(vi.mocked(api).mock.calls[0]);
  });

  it("retries the exact entity request even after the selection changes", async () => {
    screenState.scope = "fixture-entity";
    ownerView(null);
    vi.mocked(api).mockResolvedValue({ ...ownerThinkResponse("empty", "fixture-entity"), status: "search_unavailable" });
    screenState.index = 0;
    const ask = button(Ask({ owner: true }), "Ask");
    expect(ask).toBeDefined();
    await ask!.props.onClick();
    expect(api).toHaveBeenCalledWith("/api/rag/think", { q: "What is the recorded fee?", limit: 12, entity_slug: "fixture-entity" });
    screenState.scope = null;
    screenState.index = 0;
    const retry = button(Ask({ owner: true }), "Try again");
    expect(retry).toBeDefined();
    await retry!.props.onClick();
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls[1]).toEqual(vi.mocked(api).mock.calls[0]);
    screenState.index = 0;
    expect(renderToStaticMarkup(<Ask owner />)).toContain("Selected records");
  });

  it("explains the wait while thinking and stays quiet when idle", () => {
    const line = "Reading your records. This usually takes under a minute.";
    const busy = ownerView(null, true);
    expect(busy).toContain("Thinking…");
    expect(busy).toContain(line);
    expect(ownerView(null)).not.toContain(line);
  });

  it("shows the keyboard hint only on Mac, with a phone-hidden style", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const mac = ownerView(null);
    expect(mac).toMatch(/<span[^>]*class="[^"]*hidden sm:inline[^"]*"[^>]*>⌘ \+ Enter<\/span>/);
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(ownerView(null)).not.toContain("⌘ + Enter");
  });

  it("uses a neutral note for a healthy no-match without raising its score", () => {
    for (const answer of [ownerThinkResponse("empty") as Answer,
      { ...supported(5), status: "no_results", answer: "Not found in the records returned by this search." }]) {
      const html = ownerView(answer);
      expect(html).toContain(answer.answer || "matching record in this search");
      plainLow(html, answer);
      expect(documentResponseConfidence(answer).percent).toBe(5);
      expect(html).not.toMatch(/text-red|bg-red|text-bad|bg-bad/);
      // No chip remains (CONF-HIDE); the plain note is the neutral TruthNote.
      expect(html).not.toMatch(/text-act|bg-act/);
      expect(html).toMatch(/<div class="border border-line bg-card rounded-2xl[^"]*"><div class="[^"]*text-ink-soft[^"]*">[^<]*this answer may be incomplete\.<\/div>/);
    }
  });

  it("shows the checklist only with one chosen entity, including a positive control", () => {
    expect(ownerView(null)).not.toContain("Tax evidence checklist");
    screenState.scope = "fixture-entity";
    expect(ownerView(null)).toContain("Tax evidence checklist");
  });
});


describe("document reading confidence", () => {
  const confidence = { percent: 80, band: "high", basis: ["checked 2 nearest candidates; none supported the claim"] };
  it("preserves candidates without claiming corpus absence", () => {
    const answer: Answer = { answer: "The documents do not answer the question.", confidence,
      results: [{ title: "Synthetic record" }, { title: "Other record" }] } as Answer;
    const html = renderToStaticMarkup(<Trust answer={answer} />);
    expect(html).not.toMatch(/Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
    expect(documentResponseConfidence(answer).percent).toBe(30);
    expect(html).toContain("A record that states the answer");
    expect(documentResponseConfidence(answer).missing).toContain("A record that states the answer.");
    expect(documentResponseConfidence(answer).basis.join(" ")).toContain("2 retrieved records");
    expect(html).not.toContain("nothing is recorded");
    expect(answerText(answer)).toContain("found 2 records in this search");
    expect(confidenceText(answer)).toMatch(/^Confidence: Low \(30%\).*Why:.*Missing:/s);
    expect(confidenceText(answer)).toContain("No record read here answers the question");
  });
  it("distinguishes supported answers, empty searches and incomplete searches", () => {
    const supported: Answer = { answer: "The records support 42 [1].", confidence };
    expect(answerText(supported)).toBe(`${supported.answer}\nWant to check the original record?`);
    expect(renderToStaticMarkup(<Trust answer={supported} />)).not.toContain("confidence in this search result");
    const empty: Answer = { answer: "The documents do not answer the question.", results: [], confidence };
    expect(answerText(empty)).toContain("matching record in this search");
    for (const status of ["search_unavailable", "coverage_incomplete"]) {
      const incomplete = { ...empty, status, confidence: {percent:10,band:'Low',basis:['The search did not complete.'],missing:['A complete source search.']} } as Answer;
      const html = renderToStaticMarkup(<Trust answer={incomplete} />);
      expect(html).not.toContain("80%");
      expect(html).not.toMatch(/Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
      expect(documentResponseConfidence(incomplete).percent).toBe(10);
      expect(documentResponseConfidence(incomplete).missing).toContain("A completed search over the requested sources and periods.");
      expect(ownerReading(incomplete)).toContain("A completed search over the requested sources and periods");
      expect(html).not.toContain("nothing is recorded");
      expect(confidenceText(incomplete)).toMatch(/^Confidence: Low \(10%\).*Why:.*Missing:/s);
      expect(confidenceText(incomplete)).toContain("0 source records read");
    }
  });
});


describe("Worker document confidence contract", () => {
  it("renders the real handoff and tolerates legacy missing basis", () => {
    const answer = moneyQuestionHandoff('How much did I spend last month?') as Answer;
    expect(answer.confidence?.basis?.length).toBeGreaterThan(0);
    for (const legacy of [false, true]) {
      if (legacy && answer.confidence) delete answer.confidence.basis;
      const html = renderToStaticMarkup(<Trust answer={answer} />);
      expect(html).not.toMatch(/Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
      expect(documentResponseConfidence(answer).percent).toBe(0);
      expect(documentResponseConfidence(answer).basis?.join(' ') || documentResponseConfidence(answer).reasons?.join(' ')).toContain('No bank rows have been read');
      expect(ownerReading(answer)).toContain('No bank rows have been read');
      expect(ownerReading(answer)).toContain('Read the owner money overview and the requested account/date rows');
      expect(html).toBe('', 'handoff evidence already in the answer is not repeated');
    }
    expect(renderToStaticMarkup(<Trust answer={{answer:'The bank reading is incomplete.',confidence:{percent:0,band:'Low'}}} />)).toContain('may be incomplete.');
  });
  it("keeps the Worker score internal and missing evidence available after a failed check", () => {
    const answer: Answer = {
      answer: 'As of November 10, the record says the review is November 13 [1].',
      answer_contract: { version: 1, kind: 'document' },
      confidence: {percent:10,band:'Low',basis:['The search did not complete.'],missing:['A complete source search.']},
      evidence_gate: {supported:false,complete:false,reason:'Owner link missing.'},
    } as Answer;
    const html=renderToStaticMarkup(<Trust answer={answer} />);
    expect(html).not.toMatch(/Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
    expect(documentResponseConfidence(answer).percent).toBe(10);
    expect(documentResponseConfidence(answer).missing).toContain('A complete source search.');
    expect(html).toContain('A complete source search');
    expect(html).toContain('may be incomplete.');
    expect(evidenceGateNote(answer)).toBe('Why this answer is provisional: Owner link missing.');
  });
});

it.each([undefined, 0, 99])('the plain caution retains internal scoring for raw incomplete evidence (%s)', percent => {
  const answer = { status: 'coverage_incomplete', answer: 'The documents do not answer the question.',
    results: [{ title: 'Candidate' }], ...(percent === undefined ? {} : { confidence: { percent, band: 'High', basis: ['legacy'] } }) } as Answer;
  const html = renderToStaticMarkup(<Trust answer={answer} />);
  expect(html).not.toMatch(/Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
  expect(documentResponseConfidence(answer).percent).toBe(percent === 0 ? 0 : 10);
  expect(html).not.toContain('High');
  expect(ownerReading(answer)).toContain('A completed search over the requested sources and periods');
  expect(documentResponseConfidence(answer).missing.length).toBeGreaterThan(0);
});


it("shows no extra trust panel for complete evidence while retaining its internal score", () => {
  const answer: Answer = { answer: "The review is November 13 [1].", answer_contract: { version: 1, kind: "document" },
    confidence: { percent: 100, band: "High", basis: ["Source and checks complete."], missing: [] } } as Answer;
  expect(answerText(answer)).toBe(answer.answer);
  expect(renderToStaticMarkup(<Trust answer={answer} />)).toBe("");
  expect(documentResponseConfidence(answer).percent).toBe(100);
  const thin = { ...answer, confidence: { percent: 10, band: "Low", basis: ["Search incomplete."], missing: ["Complete search."] } };
  const html = renderToStaticMarkup(<Trust answer={thin} />);
  expect(html).toContain("Search incomplete");
  expect(html).toContain("Complete search");
  expect(html).not.toMatch(/Confidence:|\b(?:High|Medium|Low)\s*\(?\d+%/);
});
