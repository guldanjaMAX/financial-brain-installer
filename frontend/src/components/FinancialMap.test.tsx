import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import type { FinancialMapReview, MapReviewField } from "../lib/financial-map";
import {
  copyFinancialMapAssistantPrompt, exactReviewedMapIsActive, financialMapAssistantPrompt,
  financialMapReadFailure, FinancialMap, FinancialMapAssistantPath,
  FinancialMapCorrectionChoice, FinancialMapFieldList,
} from "./FinancialMap";

afterEach(() => vi.unstubAllGlobals());

describe("Financial Map review clarity", () => {
  it("treats a missing review route as unavailable rather than an empty queue", () => {
    const state = financialMapReadFailure(new ApiError(404, { error: "not found" }, "HTTP 404"));

    expect(state.kind).toBe("unavailable");
    expect(state.message).toContain("not an empty review queue");
    expect(state.message).toMatch(/ask the installer/i);
    expect(state.message).not.toContain("Update the Brain");
  });

  it("frames the map as bounded owner scope rather than a completeness claim", () => {
    const html = renderToStaticMarkup(<FinancialMap />);

    expect(html).toContain("you want this review to cover");
    expect(html).toContain("Unknown or later items remain open");
    expect(html).not.toContain("complete financial picture");
  });

  it("never presents a bare HTTP detail as Financial Map guidance", () => {
    const state = financialMapReadFailure(new ApiError(500, { detail: "HTTP 500" }));

    expect(state.kind).toBe("unavailable");
    expect(state.message).toContain("could not confirm what happened");
    expect(state.message).not.toContain("HTTP 500");
  });

  it("recognises only the exact authoritative reviewed map as active", () => {
    const review = {
      expected_sequence: 7,
      map_hash: "a".repeat(64),
      denominator_hash: "b".repeat(64),
    } as FinancialMapReview;
    const active = {
      status: "no_pending_review",
      review_state: "none",
      complete: true,
      truncated: false,
      active_map_present: true,
      active_map_authoritative: true,
      active_sequence: 7,
      active_map_hash: review.map_hash,
      active_denominator_hash: review.denominator_hash,
      active_activated_at: 1770000000000,
      owner_message: "No Financial Map is waiting for review.",
    };

    expect(exactReviewedMapIsActive(active, review)).toBe(true);
    expect(exactReviewedMapIsActive({ ...active, active_map_hash: "c".repeat(64) }, review)).toBe(false);
    expect(exactReviewedMapIsActive({ ...active, active_map_authoritative: false }, review)).toBe(false);
  });

  it("keeps the owner and current-record labels visible for every compared field", () => {
    const fields: Record<string, MapReviewField> = {
      tax_class: {
        assessment: "confirmed",
        owner_value: "S corporation",
        current_value: "LLC",
        comparison: "differs_from_current",
      },
      status: {
        assessment: "confirmed",
        owner_value: "Active",
        current_value: "Active",
        comparison: "matches_current",
      },
    };

    const html = renderToStaticMarkup(
      <FinancialMapFieldList fields={fields} order={["tax_class", "status"]} />,
    );

    expect(html).toContain('aria-label="Financial Map field comparison"');
    expect(html.match(/Owner answer/g)).toHaveLength(2);
    expect(html.match(/Current record/g)).toHaveLength(2);
    expect(html.match(/Comparison/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Tax Class comparison"');
    expect(html).toContain("S corporation");
    expect(html).toContain("LLC");
    expect(html).toContain("Different from current");
    expect(html).toContain("What confirming this difference accepts");
    expect(html.match(/What confirming this difference accepts/g)).toHaveLength(1);
    expect(html).toContain("becomes the owner-approved Tax Class in this Financial Map");
    expect(html).toContain("does not rewrite that record or remove its supporting evidence");
    expect(html).toContain("earlier confirmed Financial Maps remain preserved in history");
    expect(html).not.toContain("sm:hidden");
  });

  it("provides the available assistant read and separately approved preview path", () => {
    const onReadLatest = vi.fn();
    const html = renderToStaticMarkup(
      <FinancialMapAssistantPath action="create" onReadLatest={onReadLatest} />,
    );

    expect(html).toContain("Open Claude Code or Codex where it is already connected to this Brain");
    expect(html).toContain("brain_financial_map");
    expect(html).toContain("read mode first");
    expect(html).toContain("ask for my approval before using it");
    expect(html).toContain("It cannot confirm the map");
    expect(html).toContain("Copy request");
    expect(html).toContain("does not contact the Brain, create a preview, or confirm a map");
    expect(html).toContain("Read latest map");
    expect(onReadLatest).not.toHaveBeenCalled();
  });

  it("copies only the exact non-authorizing assistant request", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(copyFinancialMapAssistantPrompt("correct", writeText)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(financialMapAssistantPrompt("correct"));
    expect(financialMapAssistantPrompt("correct")).toContain("read mode first");
    expect(financialMapAssistantPrompt("correct")).toContain("ask for my approval before using it");
    expect(financialMapAssistantPrompt("correct")).toContain("useful starting Owner Financial Map");
    expect(financialMapAssistantPrompt("correct")).toContain("possible mentions until I confirm them");
    expect(financialMapAssistantPrompt("correct")).not.toContain("my complete Owner Financial Map");
  });

  it("fails closed when clipboard access is unavailable", async () => {
    const writeText = vi.fn(async () => { throw new Error("clipboard blocked"); });

    await expect(copyFinancialMapAssistantPrompt("create", writeText)).resolves.toBe(false);
  });

  it("renders a correction stop without invoking callbacks or a passkey prompt", () => {
    const get = vi.fn();
    const onRequest = vi.fn();
    const onContinue = vi.fn();
    vi.stubGlobal("window", { PublicKeyCredential: class {} });
    vi.stubGlobal("navigator", { credentials: { get } });

    const html = renderToStaticMarkup(
      <FinancialMapCorrectionChoice
        requested={false}
        confirmationInProgress={false}
        confirmationUnresolved={false}
        onRequest={onRequest}
        onContinue={onContinue}
        onReadLatest={() => undefined}
      />,
    );

    expect(html).toContain("Something is wrong?");
    expect(html).toContain("Do not confirm this version");
    expect(html).toContain("exact Claude Code or Codex request and refresh path");
    expect(onRequest).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("makes the selected correction state explicit and non-authorizing", () => {
    const html = renderToStaticMarkup(
      <FinancialMapCorrectionChoice
        requested
        confirmationInProgress={false}
        confirmationUnresolved={false}
        onRequest={() => undefined}
        onContinue={() => undefined}
        onReadLatest={() => undefined}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Stop here and correct the preview");
    expect(html).toContain("Open Claude Code or Codex where it is already connected to this Brain");
    expect(html).toContain(financialMapAssistantPrompt("correct"));
    expect(html).toContain("Copy request");
    expect(html).toContain("Copying only places this request on your clipboard");
    expect(html).toContain("does not contact the Brain, create a preview, or confirm a map");
    expect(html).toContain("Read latest map");
    expect(html).toContain("did not activate or change anything");
    expect(html).toContain("no passkey window opened");
  });

  it("stops the synthetic rehearsal correction path before an unavailable assistant", () => {
    vi.stubGlobal("location", { hostname: "127.0.0.1", search: "?state=financial-map&view=financial-map" });
    const html = renderToStaticMarkup(
      <FinancialMapCorrectionChoice
        requested
        confirmationInProgress={false}
        confirmationUnresolved={false}
        onRequest={() => undefined}
        onContinue={() => undefined}
        onReadLatest={() => undefined}
      />,
    );

    expect(html).toContain("Correction path found");
    expect(html).toContain("not connected to your Claude Code or Codex Owner assistant");
    expect(html).toContain("cannot create or read a fresh Financial Map preview");
    expect(html).toContain("Note what felt wrong for your technician instead");
    expect(html).toContain("Keep reviewing this synthetic preview");
    expect(html).not.toContain("Copy request");
    expect(html).not.toContain("Read latest map");
  });
});
