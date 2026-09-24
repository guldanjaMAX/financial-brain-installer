/**
 * The scanned-PDF and thin-OCR refusal messages must name the real numbers.
 *
 * WHY THIS EXISTS. Both refusals are built from a template with blanks: the
 * scanned page count, the OCR chars-per-page result, and the
 * MIN_CHARS_PER_PAGE floor. A regression that left any blank unfilled (a
 * literal "N" instead of the number) would still read as a complete
 * sentence, so a smoke test that only checks THAT the refusal fired, not
 * what it says, would not catch it. This pins the exact rendered text for a
 * real extractPdf() result and a real assembleOcr() verdict.
 *
 * evidence/WP-11-ocr-for-scans.md:192 documents the scanned-PDF opening
 * phrase as staying "byte for byte" stable, and writes it with "N" standing
 * in for the page count in prose. That is documentation shorthand, not the
 * shipped string: this test proves the code fills the blank in rather than
 * printing the letter "N" itself, on both current call sites
 * (ingest/formats.mjs and ingest/ocr.mjs).
 */

import { extractPdf, MIN_CHARS_PER_PAGE } from "../ingest/formats.mjs";
import { assembleOcr } from "../ingest/ocr.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

/* ---------------------------------- "no text layer" (ingest/formats.mjs) */

{
  // A real extractPdf() call, with only the byte-level PDF parse stubbed --
  // the same injection seam test/ocr.test.mjs uses -- so the refusal text is
  // built by the real code under test, not reconstructed by the fixture.
  const got = await extractPdf(Buffer.from("fixture pdf bytes"), {}, {
    pdfPassImpl: async () => ({ body: "", totalPages: 4, perPage: 0 }),
  });
  check(
    "the scanned-PDF refusal names the real page count, not a literal N",
    got.error === "no text layer: this is a scanned PDF (4 pages of images). It needs OCR before it can be indexed.",
    got.error,
  );

  const singular = await extractPdf(Buffer.from("fixture pdf bytes"), {}, {
    pdfPassImpl: async () => ({ body: "", totalPages: 1, perPage: 0 }),
  });
  check(
    "one page reads as singular, not \"1 pages\"",
    singular.error === "no text layer: this is a scanned PDF (1 page of images). It needs OCR before it can be indexed.",
    singular.error,
  );
}

/* -------------------------------------- "thin OCR result" (ingest/ocr.mjs) */

{
  // One page, read (its text clears MIN_PAGE_CHARS) but thin: 19 legible
  // characters against a totalPages of 1, so perPage is 19 -- well under the
  // 100-char floor -- without the document being refused outright as
  // unreadable (that is a different branch, covered in test/ocr.test.mjs).
  const page = { page: 1, text: "some real page text" };
  const verdict = assembleOcr([page], { totalPages: 1, model: "fixture-model" });
  check(
    "assembleOcr's thin-page refusal names the real chars-per-page and the real floor, not N and N",
    verdict.ok === false &&
      verdict.refusal ===
        `OCR was attempted and produced only ${page.text.length} characters per page, ` +
          `under the ${MIN_CHARS_PER_PAGE} a readable document clears`,
    JSON.stringify(verdict),
  );
  check(
    "the floor named in the message is the real MIN_CHARS_PER_PAGE constant, not a placeholder",
    MIN_CHARS_PER_PAGE === 100 && verdict.refusal.includes("under the 100 "),
    verdict.refusal,
  );
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
