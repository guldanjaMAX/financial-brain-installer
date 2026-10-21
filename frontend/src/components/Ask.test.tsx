import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Answer } from "../lib/api";
import {
  ANSWER_ERROR_MESSAGES, answerText, confidenceText, nextActionText,
} from "../lib/answer-render.js";
import { unavailableNotice } from "../lib/retrieval-status.js";
import {
  Trust, CitationSources, EvidenceGateReason, SCOPED_SEARCH_UNAVAILABLE, ScannedEvidenceNote,
  citationMeta, citationTitle, evidenceGateNote, readAskDraft, writeAskDraft,
} from "./Ask";

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
    expect(rendered).toBe(ANSWER_ERROR_MESSAGES.unavailable);
    expect(rendered).not.toContain(raw);
  });

  it("keeps a reviewed recovery message specific", () => {
    expect(answerText({
      answer: null,
      answer_error: ANSWER_ERROR_MESSAGES.notConfigured,
    })).toBe(ANSWER_ERROR_MESSAGES.notConfigured);
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
    expect(citationMeta(citation)).toBe("Files you uploaded · T1 primary");
    const html = renderToStaticMarkup(<CitationSources citations={[citation]} />);
    expect(html).toContain("T1 primary");
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
    for (const patch of [{ scope: null }, { year: "" }, { busy: true }]) {
      expect(renderToStaticMarkup(<TaxEvidenceControl {...props} {...patch} />)).toContain('disabled=""');
    }
  });
});


describe("search-scoped refusal confidence", () => {
  const confidence = { percent: 80, band: "high", basis: ["checked 2 nearest candidates; none supported the claim"] };
  it("preserves candidates without claiming corpus absence", () => {
    const answer: Answer = { answer: "The documents do not answer the question.", confidence,
      results: [{ title: "Synthetic record" }, { title: "Other record" }] } as Answer;
    const html = renderToStaticMarkup(<Trust answer={answer} />);
    expect(html).toContain("80% high");
    expect(html).toContain("confidence in this search result");
    expect(html).toContain("checked 2 nearest candidates");
    expect(html).not.toContain("nothing is recorded");
    expect(answerText(answer)).toContain("found 2 records in this search");
    expect(confidenceText(answer)).toContain("Confidence in this search result");
  });
  it("distinguishes supported answers, empty searches and incomplete searches", () => {
    const supported: Answer = { answer: "The records support 42 [1].", confidence };
    expect(answerText(supported)).toBe(supported.answer);
    expect(renderToStaticMarkup(<Trust answer={supported} />)).not.toContain("confidence in this search result");
    const empty: Answer = { answer: "The documents do not answer the question.", results: [], confidence };
    expect(answerText(empty)).toContain("matching record in this search");
    for (const status of ["search_unavailable", "coverage_incomplete"]) {
      const incomplete = { ...empty, status } as Answer;
      const html = renderToStaticMarkup(<Trust answer={incomplete} />);
      expect(html).not.toContain("80%");
      expect(html).not.toContain("nothing is recorded");
      expect(confidenceText(incomplete)).toMatch(/incomplete/i);
    }
  });
});
