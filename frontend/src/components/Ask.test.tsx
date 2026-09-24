import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Answer } from "../lib/api";
import {
  ANSWER_ERROR_MESSAGES, answerText,
} from "../lib/answer-render.js";
import { unavailableNotice } from "../lib/retrieval-status.js";
import {
  CitationSources, EvidenceGateReason, SCOPED_SEARCH_UNAVAILABLE, ScannedEvidenceNote,
  citationMeta, citationTitle, evidenceGateNote,
} from "./Ask";

describe("answer messages", () => {
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
  // Spelled out so a change to the shared constant cannot rewrite this check.
  const NOTICE =
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
    answer: "The monthly storage fee is $1,240 [1].",
    citations: [scanned],
    gaps: [{ type: "scanned_evidence", count: 1, total: 1, detail: NOTICE }],
    evidence_gate: { supported: true, complete: true },
  };

  it("states the fixed scanned-copy notice beside an answer that rests on a scan", () => {
    const html = renderToStaticMarkup(<ScannedEvidenceNote answer={answered} />);
    expect(html).toContain(NOTICE);
  });

  it("marks the scanned citation and keeps its OCR provenance", () => {
    expect(citationTitle(scanned)).toBe("Storage contract scan (scanned)");
    expect(citationMeta(scanned)).toBe("Google Drive · OCR text, verify key details");
    const html = renderToStaticMarkup(<CitationSources citations={[scanned]} />);
    expect(html).toContain("Storage contract scan (scanned)");
  });

  it("says nothing about scans for native text or a partial read", () => {
    const native = { n: 1, title: "Native contract", source: "drive", text_source: "native", text_reliable: true };
    const partial = { n: 2, title: "Half-read scan", source: "drive", text_source: "ocr_partial", text_reliable: false };
    expect(citationTitle(native)).toBe("Native contract");
    expect(citationTitle(partial)).toBe("Half-read scan");
    expect(citationMeta(partial)).toBe("Google Drive · OCR text may be incomplete");
    const html = renderToStaticMarkup(<ScannedEvidenceNote answer={{
      answer: "The fee is recorded [1] [2].",
      citations: [native, partial],
      gaps: [],
    }} />);
    expect(html).toBe("");
  });

  it("leaves an OCR citation the Worker did not flag with only its OCR label", () => {
    // A complete read whose cited passage the model marked illegible, or one
    // stored with no OCR receipt: findable and citable, never proof, and not
    // marked as if it were.
    const unflagged = { n: 1, title: "Marked scan", source: "drive", text_source: "ocr", text_reliable: false };
    expect(citationTitle(unflagged)).toBe("Marked scan");
    expect(citationMeta(unflagged)).toBe("Google Drive · OCR text, verify key details");
    const html = renderToStaticMarkup(<ScannedEvidenceNote answer={{
      answer: "The fee is recorded [1].",
      citations: [unflagged],
      gaps: [],
    }} />);
    expect(html).toBe("");
  });

  it("carries no scanned notice on a refusal or a provisional result", () => {
    for (const answer of [
      { answer: "The documents do not answer the question.", citations: [], gaps: [] },
      { answer: null, status: "coverage_incomplete", notice: "provisional", citations: [scanned], gaps: [] },
    ] as Answer[]) {
      expect(renderToStaticMarkup(<ScannedEvidenceNote answer={answer} />)).toBe("");
    }
  });
});
