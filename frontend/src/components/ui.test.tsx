import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Attention, Badge, Chip, Confirm, EditableName, Row, Section } from "./ui";

describe("shared owner surface styles", () => {
  it("can keep the section action inside a padded card header", () => {
    const html = renderToStaticMarkup(<Section title="Banks" headerInCard action={<button>Connect a bank</button>}><Row>Saved bank</Row></Section>);
    const card = html.split('class="mt-3 bg-card')[1];
    expect(card).toContain("<header");
    expect(card).toContain("border-b border-line p-4 sm:p-5");
    expect(card).toContain("Connect a bank</button>");
  });
  it("keeps the section heading and blurb legible", () => {
    const html = renderToStaticMarkup(<Section title="Owner section" blurb="Owner detail"><Row>Saved record</Row></Section>);
    expect(html).toContain("Owner section");
    expect(html).toContain("Saved record");
    expect(html).toContain("text-[17px] font-semibold");
    expect(html).toContain("max-w-[42rem]");
  });
  it("insets only notices placed directly in a card", () => {
    const inset = renderToStaticMarkup(<Attention inset>Saved record unavailable</Attention>);
    const outside = renderToStaticMarkup(<Attention>Saved record unavailable</Attention>);
    expect(inset).toContain('role="status"');
    expect(inset).toContain("m-4 rounded-xl");
    expect(inset).not.toContain("mb-4");
    expect(outside).toContain("rounded-2xl mb-4");
  });
  it("gives row text room before actions wrap and aligns at the top", () => {
    const html = renderToStaticMarkup(<Row><span>Saved record</span><button>Open</button></Row>);
    expect(html).toContain("px-4");
    expect(html).toContain("items-start");
    expect(html).toContain("min-w-[min(100%,16rem)]");
    expect(html).toContain("flex-1");
  });
  it("shows readable token-based status chips with a glyph and a word", () => {
    const html = renderToStaticMarkup(<Chip state="WORKING" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Working on it");
    expect(html).toContain("bg-wait-bg");
    expect(html).toContain("text-[12.5px]");
    const badge = renderToStaticMarkup(<Badge tone="warn">Owner action</Badge>);
    expect(badge).toContain("Owner action");
    expect(badge).toContain("text-[12.5px]");
    expect(badge).toContain("bg-act-bg");
  });
  it("keeps shared controls touch-safe and aligns quiet action text", () => {
    const confirm = renderToStaticMarkup(<Confirm label="Remove" question="Remove record?" onConfirm={() => undefined} />);
    expect(confirm).toContain("Remove");
    expect(confirm).toContain("-mx-2");
    expect(confirm).toContain("min-h-11");
    expect(confirm).toContain("text-[15px] font-semibold");
    const rename = renderToStaticMarkup(<EditableName value="Owner record" onSave={() => undefined} />);
    expect(rename).toContain("min-h-11");
  });
});
