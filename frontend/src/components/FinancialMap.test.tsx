import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapReviewField } from "../lib/financial-map";
import { FinancialMapCorrectionChoice, FinancialMapFieldList } from "./FinancialMap";

afterEach(() => vi.unstubAllGlobals());

describe("Financial Map review clarity", () => {
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
    expect(html).not.toContain("sm:hidden");
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
      />,
    );

    expect(html).toContain("Something is wrong?");
    expect(html).toContain("Do not confirm this version");
    expect(html).toContain("complete fresh preview");
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
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Stop here and correct the preview");
    expect(html).toContain("Return to the Claude Code or Codex conversation");
    expect(html).toContain("did not activate or change anything");
    expect(html).toContain("no passkey window opened");
  });
});
