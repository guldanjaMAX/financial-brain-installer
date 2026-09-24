import { textQuality, isLikelyBinary, stripMarkup, MIN_CHARS } from "../ingest/quality.mjs";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

const PROSE = "We agreed to defer the retainer increase until October, and to revisit the coverage register before the quarterly review. Taylor will send the updated schedule.";
const MAX_TEXT_CHARS = 8 * 1024 * 1024;

function legacyEncodedRatio(text) {
  const base64 = text.match(/[A-Za-z0-9+/=]{200,}/g) || [];
  const hex = text.match(/[0-9a-fA-F]{300,}/g) || [];
  const encoded = [...base64, ...hex].reduce((total, match) => total + match.length, 0);
  return +(encoded / text.length).toFixed(3);
}

/* ---- real text must pass. A false reject silently loses a document. ---- */
check("ordinary prose passes", textQuality(PROSE).ok);
check("a short but real note passes", textQuality("Call Devon about the Northwind pricing change tomorrow.").ok);
check("prose that MENTIONS a token is not junk",
  textQuality(PROSE + " The key was rotated: sk-live-abcdefghijklmnop.").ok);
check("a table of numbers is still text", textQuality(
  ["Account,Balance", "Checking,15234.11", "Savings,80100.00", "Loan,-42311.87"].join("\n") + "\n" + PROSE).ok);

const sparseNumericCsv = [
  "period,account,,,,debit,credit,balance",
  ...Array.from({ length: 180 }, (_, i) =>
    `,,,${i % 3 ? "" : `${i}.25`},,,,${i % 3 ? `${i}.75` : ""},,,${9000 - i}.00,,,,`
  ),
].join("\n");
check("a sparse numeric CSV with empty columns is not refused",
  textQuality(sparseNumericCsv, { format: ".csv" }).ok,
  JSON.stringify(textQuality(sparseNumericCsv, { format: ".csv" })));

const codedInventory = [
  "SKU\tBIN\tCUSTOMER\tQTY\tSTATUS",
  ...Array.from({ length: 220 }, (_, i) =>
    `ZXQ${String(i).padStart(6, "0")}\tBRK${String(i % 48).padStart(3, "0")}\tCST${String(80000 + i)}\tQT${i % 17}\tHLD`
  ),
].join("\n");
check("a coded inventory export is not refused",
  textQuality(codedInventory, { format: ".tsv" }).ok,
  JSON.stringify(textQuality(codedInventory, { format: ".tsv" })));

const bankTransactions = [
  "Date,Description,Reference,Debit,Credit,Balance",
  ...Array.from({ length: 160 }, (_, i) =>
    `2026-09-${String((i % 28) + 1).padStart(2, "0")},ACH ${i % 2 ? "PAYMENT" : "DEPOSIT"},TRX${String(i).padStart(8, "0")},${i % 2 ? `${i}.19` : ""},${i % 2 ? "" : `${i}.41`},${12000 - i}.82`
  ),
].join("\n");
check("a bank transaction export is not refused",
  textQuality(bankTransactions, { format: ".csv", sourceKind: "bank" }).ok,
  JSON.stringify(textQuality(bankTransactions, { format: ".csv", sourceKind: "bank" })));

const profitAndLoss = [
  "Profit and Loss\tCurrent Month\tYear to Date",
  "Income\t\t",
  ...Array.from({ length: 90 }, (_, i) =>
    `  ${i % 3 ? "Service" : "Product"} income ${1000 + i}\t${(i * 73).toFixed(2)}\t${(i * 811).toFixed(2)}`
  ),
  "Gross Profit\t65700.00\t729900.00",
  "Expenses\t\t",
  "Net Income\t31400.00\t348500.00",
].join("\n");
check("a bookkeeping profit-and-loss export is not refused",
  textQuality(profitAndLoss, { format: ".xlsx" }).ok,
  JSON.stringify(textQuality(profitAndLoss, { format: ".xlsx" })));

/* ---- the case this was built for ---- */
{
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" .repeat(60);
  const r = textQuality(`<img src="data:image/png;base64,${b64}">` + " a caption");
  check("a file that is mostly base64 is rejected", !r.ok, JSON.stringify(r.metrics));
  check("and the reason is legible to a client", /encoded data/.test(r.reason || ""), r.reason);
  check("with the ratio recorded", r.metrics.encoded_ratio > 0.35, JSON.stringify(r.metrics));
}
{
  const r = textQuality("BEGIN CERT " + "a1b2c3d4e5f6".repeat(40) + " END");
  check("a long hex blob is rejected", !r.ok, JSON.stringify(r.metrics));
}
{
  const mixed = [
    PROSE,
    "A".repeat(199),
    "!",
    "g+/=".repeat(75),
    "?",
    "a1b2c3".repeat(50),
    " ordinary words between encoded runs ",
    "F".repeat(299),
  ].join("");
  const result = textQuality(mixed);
  check("mixed encoded runs keep the legacy base64-plus-hex ratio",
    result.metrics.encoded_ratio === legacyEncodedRatio(mixed),
    `${result.metrics.encoded_ratio} != ${legacyEncodedRatio(mixed)}`);
}

/* ---- maximum-size quality checks must stay stack-safe and bounded ---- */
{
  const repeated = "A".repeat(MAX_TEXT_CHARS);
  let result;
  let error = null;
  try { result = textQuality(repeated); } catch (caught) { error = caught; }
  check("an 8 MiB single-character run is stack-safe", error === null, error?.stack || error);
  check("the 8 MiB single-character run keeps its double-counted legacy ratio",
    result?.metrics?.encoded_ratio === 2, JSON.stringify(result?.metrics));
}
{
  const base64 = "gh+/".repeat(MAX_TEXT_CHARS / 4);
  let result;
  let error = null;
  try { result = textQuality(base64); } catch (caught) { error = caught; }
  check("an 8 MiB base64 run is stack-safe", error === null, error?.stack || error);
  check("the 8 MiB base64 run keeps its legacy ratio",
    result?.metrics?.encoded_ratio === 1, JSON.stringify(result?.metrics));
}

/* ---- failed extraction must not enter as an empty document ---- */
check("empty text is rejected", !textQuality("").ok);
check("whitespace only is rejected", !textQuality("   \n\t  ").ok);
check("below the floor is rejected", !textQuality("x".repeat(MIN_CHARS - 1)).ok);
check("the empty-extraction message names the real cause", /empty result/.test(textQuality("").reason));
check("a bad decode is rejected", !textQuality("�".repeat(100) + " some text here to pad it out").ok);

/* ---- cheap deterministic nonsense checks ---- */
{
  const binaryText = ("statement total paid\u0000\u0001\u0002\u0003".repeat(80));
  const r = textQuality(binaryText);
  check("binary decoded as text is rejected", !r.ok && /binary data decoded as text/.test(r.reason || ""), JSON.stringify(r));
}
{
  const soup = Array.from({ length: 240 }, (_, i) => `xq${i % 10} @@@ ### %%% ||| <>`).join(" ");
  const r = textQuality(soup);
  check("symbol soup is rejected", !r.ok && /symbols with too little readable text/.test(r.reason || ""), JSON.stringify(r));
}
{
  const punctuation = Array.from({ length: 180 }, (_, i) =>
    `${"!@#$%^&*()_+-=[]{};':\",./<>?".slice(i % 12)} ${"~|`".repeat((i % 4) + 1)}`
  ).join("\n");
  const r = textQuality(punctuation);
  check("punctuation density alone does not refuse text", r.ok, JSON.stringify(r));
}
{
  const garbage = Array.from({ length: 260 }, (_, i) => `xqz${i} brt${i} nvm${i} :::`).join(" ");
  const r = textQuality(garbage);
  check("OCR-like garbage is rejected", !r.ok && /OCR-like unreadable word shapes/.test(r.reason || ""), JSON.stringify(r));
}
{
  const r = textQuality(("CONFIDENTIAL EXPORT PAGE FOOTER\n").repeat(180) + PROSE);
  check("repeated-line boilerplate is rejected", !r.ok && /same boilerplate line/.test(r.reason || ""), JSON.stringify(r));
}
{
  const mail = "View in browser\nManage preferences\nPrivacy policy\nUnsubscribe\nCopyright 2026\nClick here";
  const r = textQuality(mail, { sourceKind: "gmail" });
  check("near-empty templated mail is rejected for mail sources", !r.ok && /mail template with almost no message/.test(r.reason || ""), JSON.stringify(r));
  check("the same short text is not silently treated as mail for a folder source", textQuality(mail, { sourceKind: "upload" }).ok);
}

/* ---- conservative controls: useful difficult documents stay accepted ---- */
{
  const taxForm = Array.from({ length: 90 }, (_, i) =>
    `Line ${i + 1} W-2 1099-R EIN 00-0000000 wages ${1200 + i}.00 withholding ${120 + i}.00`
  ).join("\n");
  check("a tax-form transcription is not refused",
    textQuality(taxForm, { format: ".txt" }).ok,
    JSON.stringify(textQuality(taxForm, { format: ".txt" })));
}
{
  const sheet = Array.from({ length: 240 }, (_, i) =>
    `Account: ${1000 + i} | Date: 2026-09-${String((i % 28) + 1).padStart(2, "0")} | Debit: ${i}.25 | Status: posted`
  ).join("\n");
  check("spreadsheet text is not refused", textQuality(sheet).ok, JSON.stringify(textQuality(sheet)));
}
{
  const legal = Array.from({ length: 80 }, (_, i) =>
    `Section ${i + 1}. The party shall preserve the record and may request review under the applicable agreement.`
  ).join("\n");
  check("legal PDF text is not refused", textQuality(legal).ok, JSON.stringify(textQuality(legal)));
}
{
  const transcript = Array.from({ length: 100 }, (_, i) =>
    `Speaker ${i % 3 + 1}: We reviewed item ${i + 1}, the current evidence, and the next action for the project.`
  ).join("\n");
  check("transcript text is not refused", textQuality(transcript).ok, JSON.stringify(textQuality(transcript)));
}

{
  const garbage = Array.from({ length: 260 }, (_, i) => `xqz${i} brt${i} nvm${i} :::`).join(" ");
  const relaxed = textQuality(garbage, { policy: { min_word_like_ratio: 0 } });
  check("per-source thresholds can conservatively disable one heuristic", relaxed.ok, JSON.stringify(relaxed));
}

/* ---- repetition, but only where it is genuinely pathological ---- */
{
  const r = textQuality("row,1,ok\n".repeat(900));
  check("a giant file of one repeated row is rejected", !r.ok, JSON.stringify(r.metrics));
  const varied = Array.from({ length: 900 }, (_, i) => `invoice ${i} client acme amount ${i * 37} status paid`).join("\n");
  check("a large file with genuinely varied rows passes", textQuality(varied).ok, JSON.stringify(textQuality(varied).metrics));
  check("a SHORT repetitive note is not judged", textQuality("ok ok ok ok ok ok ok ok ok ok").ok);
}

/* ---- binary detection runs on raw bytes ---- */
check("a NUL byte marks it binary", isLikelyBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41])));
check("plain ascii is not binary", !isLikelyBinary(Buffer.from(PROSE, "utf8")));
check("utf8 accents are not binary", !isLikelyBinary(Buffer.from("café résumé naïve — dash", "utf8")));
check("tabs and newlines are not binary", !isLikelyBinary(Buffer.from("a\tb\r\nc\n", "utf8")));
check("empty buffer is not binary", !isLikelyBinary(Buffer.alloc(0)));

/* ---- markup stripping ---- */
{
  const html = `<html><head><style>body{color:red}</style><script>var x=1;</script></head>
    <body><!-- hidden --><h1>Q3 Review</h1><p>We agreed to &amp; then defer.</p><ul><li>One</li><li>Two</li></ul></body></html>`;
  const t = stripMarkup(html);
  check("script contents are removed", !/var x/.test(t), t);
  check("style contents are removed", !/color:red/.test(t), t);
  check("comments are removed", !/hidden/.test(t), t);
  check("visible text survives", /Q3 Review/.test(t) && /defer/.test(t), t);
  check("entities are decoded", /& then/.test(t), t);
  check("block elements become line breaks", /One\s*\n\s*Two/.test(t), JSON.stringify(t));
}

console.log(fail ? `\n${fail} FAILURES` : `\nquality: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
