/**
 * The synthetic ingest folder, materialized into a disposable directory.
 *
 * Text fixtures live as readable files under `files/`. The binary ones (PDFs,
 * a workbook) are built byte by byte here rather than checked in, for the same
 * reason test/fixtures/scan-pdf.mjs gives: a fixture you can read is a fixture
 * you can trust. Every PDF below is provably a text page, provably a scan (an
 * image object and no text operator), or provably both on different pages.
 *
 * Nothing here is a real document. Every party is a role word (Store North,
 * Lender One, Payer One, Payee One, Licensee Alpha), every address is on the
 * reserved `.invalid` domain, and every figure is invented. The words OCR
 * returns are whatever the per-page stub in the harness is told to return.
 */

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import * as XLSX from "@e965/xlsx";

export const SYNTHETIC_FILES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "files");

/** The manifest prefix that must exclude `private-ledger/`. */
export const SYNTHETIC_PRIVATE_PREFIX = "private-";

/** A text page long enough to clear the 100 characters per page floor. */
export const NATIVE_STATEMENT_LINES = [
  "Store North monthly statement for March 2026.",
  "Opening balance 18,240.11. Deposits 9,410.00. Withdrawals 7,902.35.",
  "Closing balance 19,747.76. Deposit from Payer One on 2026-03-31 for 4,200.00.",
  "Loan payment to Lender One on 2026-03-15 for 1,150.00.",
];

/** The text half of the hybrid PDF. Page two of that file is a scan. */
export const HYBRID_TEXT_LINES = [
  "Store North equipment lease schedule, page one of two, issued by Lender One.",
  "Lease term thirty six months beginning 2026-01-01. Monthly payment 640.00.",
  "The signed acceptance and the payment table are on the scanned second page.",
];

/* ------------------------------------------------------------------ pdf */

function assemble(objects) {
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((object, index) => {
    const n = index + 1;
    const body = typeof object === "string"
      ? Buffer.from(`${n} 0 obj\n${object}\nendobj\n`)
      : Buffer.concat([
        Buffer.from(`${n} 0 obj\n${object.dict}\nstream\n`),
        object.stream,
        Buffer.from("\nendstream\nendobj\n"),
      ]);
    offsets.push(pos);
    parts.push(body);
    pos += body.length;
  });
  const xrefAt = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

/** Synthetic ink: one dark bar on a white 8-bit gray field. */
function inkImage(width = 160, height = 100) {
  const raw = Buffer.alloc(width * height, 0xff);
  for (let y = 20; y < 40; y++) {
    for (let x = 12; x < width - 12; x++) raw[y * width + x] = 0x11;
  }
  return deflateSync(raw);
}

const pdfString = (value) => String(value).replace(/[\\()]/g, (c) => `\\${c}`);

function textStream(lines) {
  return lines.map((line, index) =>
    `BT\n/F1 11 Tf\n72 ${720 - index * 16} Td\n(${pdfString(line)}) Tj\nET\n`).join("");
}

/**
 * Build a PDF from a list of page kinds:
 *   { text: [lines] }          a page with a text layer and no image
 *   { scan: true }             a page with one image and no text operator
 *   { scan: true, label }      a scan page carrying a tiny stray text label
 */
export function syntheticPdf(pages) {
  const width = 160;
  const height = 100;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const imageStream = inkImage(width, height);
  objects.push({
    dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageStream.length} >>`,
    stream: imageStream,
  });
  const fontRef = 3;
  const imageRef = 4;
  const kids = [];
  for (const page of pages) {
    let content = "";
    const resources = [];
    if (page.text) {
      content += textStream(page.text);
      resources.push(`/Font << /F1 ${fontRef} 0 R >>`);
    }
    if (page.scan) {
      content += `q ${width * 3} 0 0 ${height * 3} 36 300 cm /Im0 Do Q\n`;
      resources.push(`/XObject << /Im0 ${imageRef} 0 R >>`);
      if (page.label) {
        content += textStream([page.label]);
        resources.push(`/Font << /F1 ${fontRef} 0 R >>`);
      }
    }
    const bytes = Buffer.from(content);
    objects.push({ dict: `<< /Length ${bytes.length} >>`, stream: bytes });
    const contentRef = objects.length;
    const uniqueResources = [...new Set(resources)].join(" ");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << ${uniqueResources} >> /Contents ${contentRef} 0 R >>`,
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  return assemble(objects);
}

/* ---------------------------------------------------------- spreadsheet */

/**
 * A workbook whose first rows are a title block, not a header row. This is
 * the shape a payroll or point-of-sale export usually has.
 */
export function titledWorkbook() {
  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ["Store North Sales Summary"],
    ["Prepared for Licensee Alpha"],
    [],
    ["Week Ending", "Gross Sales", "Returns", "Net Sales"],
    ["2026-03-07", "5210.40", "120.00", "5090.40"],
    ["2026-03-14", "4988.15", "64.50", "4923.65"],
    ["2026-03-21", "5302.90", "0.00", "5302.90"],
  ]);
  XLSX.utils.book_append_sheet(workbook, summary, "Weekly");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/* --------------------------------------------------------------- folder */

/**
 * The generated part of the tree, keyed by POSIX path relative to the root.
 * `credential` is assembled at runtime so no credential-shaped string is ever
 * committed; the scanner must still refuse it.
 */
export function generatedFiles() {
  const credential = ["sk", "a".repeat(32)].join("-");
  return new Map([
    ["statements/2026-03-31 Store North statement.pdf",
      syntheticPdf([{ text: NATIVE_STATEMENT_LINES }])],
    ["statements/Lender One lease schedule.pdf",
      syntheticPdf([{ text: HYBRID_TEXT_LINES }, { scan: true }])],
    ["scans/Payer One remittance scan.pdf",
      syntheticPdf([{ scan: true }, { scan: true }])],
    ["scans/thin-text receipt.pdf",
      syntheticPdf([{ scan: true, label: "Receipt 0042" }])],
    // Scans carrying stray form labels: enough text to pass the quality gate,
    // far under the 100 characters per page a real text layer clears.
    ["scans/Store North intake form.pdf",
      syntheticPdf([
        { scan: true, label: "Store North intake form, page 1 of 2" },
        { scan: true, label: "Store North intake form, page 2 of 2" },
      ])],
    ["sheets/sales-summary-2026-03.xlsx", titledWorkbook()],
    ["notes/empty placeholder.txt", Buffer.alloc(0)],
    ["notes/pasted settings.txt",
      Buffer.from(`Store North point-of-sale settings copied for support.\nkey=${credential}\n`)],
  ]);
}

/** Copy the static files and write the generated ones under `root`. */
export function materializeSyntheticFolder(root) {
  mkdirSync(root, { recursive: true });
  cpSync(SYNTHETIC_FILES_ROOT, root, { recursive: true });
  for (const [rel, bytes] of generatedFiles()) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  return root;
}
