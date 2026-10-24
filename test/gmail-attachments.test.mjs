import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as XLSX from "@e965/xlsx";
import * as gmail from "../connectors/gmail.mjs";

const MIB = 1024 * 1024;
const RECEIVED = "2026-10-22T12:00:00.000Z";
const REPORT = "Report as of: 2026-10-15\nAccount,Amount\nService revenue,1200\nOffice expense,200\nNet income,1000\n";
const BODY = "The scheduled financial reports are attached for review by the owner.";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function workbook(type = "xlsx", date = "As of October 15, 2026") {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["Balance sheet"], [date], ["Account", "Amount"],
    ["Operating cash", 1200], ["Accounts payable", 200], ["Retained earnings", 1000],
  ]), "Report");
  return XLSX.write(book, { type: "buffer", bookType: type });
}

function pdf({ encrypted = false, thin = false } = {}) {
  const lines = thin ? ["short"] : ["Balance sheet", "As of October 15, 2026",
    "Operating cash 1200. Accounts payable 200. Retained earnings 1000.",
    "This scheduled report summarizes the accounts for the stated reporting date."];
  const stream = `BT /F1 12 Tf 40 740 Td ${lines.map((line) => `(${line}) Tj 0 -18 Td`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...(encrypted ? [`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> >>`] : []),
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R`;
  if (encrypted) out += ` /Encrypt 6 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]`;
  out += ` >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

function encryptedOffice() {
  const file = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(file, "EncryptionInfo", Buffer.alloc(16));
  XLSX.CFB.utils.cfb_add(file, "EncryptedPackage", Buffer.alloc(32));
  return Buffer.from(XLSX.CFB.write(file, { type: "buffer" }));
}

function mime(attachments = [], body = BODY) {
  const boundary = "synthetic-report-boundary";
  const parts = [
    "From: reports@example.invalid", "To: owner@example.invalid", "Subject: Scheduled reports",
    "Date: Thu, 22 Oct 2026 12:00:00 +0000", "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", body,
  ];
  for (const { name = "report.csv", bytes = Buffer.from(REPORT), type = "application/octet-stream" } of attachments) {
    parts.push(`--${boundary}`, `Content-Type: ${type}`,
      `Content-Disposition: attachment${name ? `; filename="${name}"` : ""}`,
      "Content-Transfer-Encoding: base64", "", Buffer.from(bytes).toString("base64"));
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n"));
}

async function read(attachments, { id = "delivery-one", received = RECEIVED, raw = mime(attachments), body } = {}) {
  if (body !== undefined) raw = mime(attachments, body);
  return gmail.toEnvelope(async () => "synthetic-access", id, { sourceName: "gmail" }, {
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("format"), "raw");
      return new Response(JSON.stringify({ id, threadId: "synthetic-thread", labelIds: ["INBOX"],
        historyId: "history-one", internalDate: String(Date.parse(received)), raw: raw.toString("base64url") }));
    },
  });
}

function items(result) {
  assert.ok(result.envelope, "a readable complete message must have an envelope");
  assert.ok(result.envelope.metadata.gmail_attachments, "attachment coverage must be explicit");
  return result.envelope.metadata.gmail_attachments.items;
}

function refused(result, code) {
  assert.ok(result.envelope === undefined, "no body or sibling may be sent after an attachment refusal");
  assert.equal(result.retain_existing, true);
  assert.equal(result.cursor_blocking, true);
  assert.equal(result.attachment_failure, code);
  assert.ok(result.skip.reason.includes(code));
  assert.ok(!result.skip.reason.includes("private-report"), "diagnostics must not expose attachment names");
}

test("passing control: an ordinary message still loads", async () => {
  const result = await read([]);
  assert.ok(result.envelope.content.includes(BODY));
  assert.equal(result.envelope.source_id, "delivery-one");
  assert.equal(result.envelope.occurred_at, RECEIVED);
});

for (const extension of ["csv", "xlsx", "xls", "pdf"]) {
  test(`reads synthetic ${extension} report bytes with separate delivery and report dates`, async () => {
    const bytes = extension === "csv" ? Buffer.from(REPORT) : extension === "pdf" ? pdf() : workbook(extension);
    const result = await read([{ name: `report.${extension.toUpperCase()}`, bytes }]);
    const [item] = items(result);
    assert.ok(result.envelope.content.includes(extension === "csv" ? "Service revenue" : "Operating cash"));
    assert.equal(item.name, `report.${extension.toUpperCase()}`);
    assert.equal(item.sha256, digest(bytes));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.message_id, "delivery-one");
    assert.equal(item.received_at, RECEIVED);
    assert.equal(item.report_as_of, "2026-10-15");
    assert.equal(item.report_as_of_status, "explicit");
    assert.equal(item.status, "read");
    assert.equal(result.envelope.occurred_at, RECEIVED);
    assert.equal(result.envelope.text_reliable, true);
    assert.ok(result.version.startsWith("gmail-extraction-2:"));
  });
}

test("attachment-only mail has searchable report text", async () => {
  const result = await read([{ name: "report.csv" }], { body: "" });
  assert.ok(result.envelope.content.includes("Service revenue"));
});

test("dedupe preserves occurrences, changed bytes, and weekly delivery provenance", async () => {
  const bytes = Buffer.from(REPORT);
  const first = await read([{ name: "report.csv", bytes }, { name: "copy.csv", bytes },
    { name: "report.csv", bytes: Buffer.from(REPORT.replace("1200", "1300")) }]);
  const records = items(first);
  assert.equal(records.length, 3);
  assert.equal(records[1].status, "duplicate");
  assert.equal(records[1].duplicate_of, 1);
  assert.equal(records[0].sha256, records[1].sha256);
  assert.notEqual(records[0].sha256, records[2].sha256);
  assert.equal(first.envelope.content.split("Service revenue").length - 1, 2);
  const again = await read([{ name: "renamed.csv", bytes }], {
    id: "delivery-two", received: "2026-10-29T12:00:00.000Z",
  });
  assert.equal(items(again)[0].sha256, records[0].sha256);
  assert.equal(items(again)[0].report_as_of, "2026-10-15");
  assert.notEqual(again.envelope.source_id, first.envelope.source_id);
  assert.notEqual(items(again)[0].received_at, records[0].received_at);
  assert.deepEqual(await read([{ name: "report.csv", bytes }]), await read([{ name: "report.csv", bytes }]));
});

for (const [label, text, status] of [
  ["missing", REPORT.replace("Report as of: 2026-10-15\n", ""), "unknown"],
  ["invalid", REPORT.replace("2026-10-15", "2026-02-30"), "unknown"],
  ["ambiguous", REPORT + "As of October 16, 2026\n", "ambiguous"],
  ["numeric locale", REPORT.replace("2026-10-15", "10/11/2026"), "unknown"],
]) {
  test(`${label} freshness is never inferred from a filename or receipt date`, async () => {
    const result = await read([{ name: "report-as-of-2026-10-22.csv", bytes: Buffer.from(text) }]);
    assert.equal(items(result)[0].report_as_of, null);
    assert.equal(items(result)[0].report_as_of_status, status);
  });
}

test("unsupported and unnamed attachments are explicit exclusions", async () => {
  const result = await read([{ name: "logo.png", bytes: Buffer.from("image placeholder") },
    { name: "", type: "application/pdf", bytes: pdf() },
    { name: "nested.eml", type: "message/rfc822", bytes: mime([{ name: "nested.csv" }]) },
    { name: "macro.xlsm", bytes: workbook() }]);
  assert.equal(items(result).length, 4);
  assert.ok(items(result).every((item) => item.status === "excluded"));
  assert.ok(result.envelope.content.includes("excluded"));
  assert.ok(!result.envelope.content.includes("Service revenue"));
});

test("nested messages and images cannot opt in through a report filename", async () => {
  assert.equal(items(await read([{ name: "control.csv" }]))[0].status, "read");
  const result = await read([
    { name: "forwarded.csv", type: "message/rfc822", bytes: mime([{ name: "hidden.csv" }]) },
    { name: "inline.csv", type: "image/png", bytes: Buffer.from(REPORT) },
  ]);
  assert.deepEqual(items(result).map((item) => item.reason), ["nested_message", "image_part"]);
  assert.ok(items(result).every((item) => item.status === "excluded"));
  assert.ok(!result.envelope.content.includes("Service revenue"));
});

for (const [label, attachment, code] of [
  ["malformed CSV", { name: "private-report.csv", bytes: Buffer.from(REPORT + '"unclosed field') }, "incomplete_attachment"],
  ["malformed XLSX", { name: "private-report.xlsx", bytes: Buffer.from(REPORT) }, "malformed_attachment"],
  ["disguised XLS", { name: "private-report.xls", bytes: Buffer.from(REPORT) }, "malformed_attachment"],
  ["malformed PDF", { name: "private-report.pdf", bytes: Buffer.from("%PDF-1.4\nnot a document") }, "malformed_attachment"],
  ["encrypted PDF", { name: "private-report.pdf", bytes: pdf({ encrypted: true }) }, "encrypted_attachment"],
  ["encrypted Office", { name: "private-report.xlsx", bytes: encryptedOffice() }, "encrypted_attachment"],
  ["thin PDF", { name: "private-report.pdf", bytes: pdf({ thin: true }) }, "incomplete_attachment"],
  ["empty CSV", { name: "private-report.csv", bytes: Buffer.alloc(0) }, "unreadable_attachment"],
  ["blank CSV", { name: "private-report-empty.csv", bytes: Buffer.from(" \n\t\n") }, "unreadable_attachment"],
  ["binary CSV", { name: "private-report.csv", bytes: Buffer.from([0, 1, 2, 3]) }, "malformed_attachment"],
  ["oversized", { name: "private-report.csv", bytes: Buffer.alloc(5 * MIB + 1, 32) }, "attachment_size_limit"],
]) {
  test(`${label} refuses the replacement despite a readable sibling`, async () => {
    assert.ok((await read([{ name: "control.csv" }])).envelope, "passing readable control");
    refused(await read([{ name: "control.csv" }, attachment]), code);
  });
}

test("count cap includes unsupported parts and accepts its exact boundary", async () => {
  const attachments = Array.from({ length: 10 }, (_, index) => ({ name: `logo-${index}.png`, bytes: Buffer.from("image") }));
  assert.equal(items(await read(attachments)).length, 10);
  refused(await read([...attachments, { name: "eleventh.png", bytes: Buffer.from("image") }]), "attachment_count_limit");
});

test("individual and aggregate byte caps include exclusions and accept exact boundaries", async () => {
  const big = { name: "image.png", bytes: Buffer.alloc(5 * MIB, 1) };
  assert.equal(items(await read([big, big, big])).length, 3);
  refused(await read([big, big, big, { name: "extra.png", bytes: Buffer.from("x") }]), "attachment_total_limit");
});

test("raw message cap refuses before MIME decoding", async () => {
  assert.ok((await read([])).envelope, "passing small message control");
  refused(await read([], { raw: Buffer.alloc(25 * MIB + 1, 32) }), "message_size_limit");
});

test("invalid filename is refused without exposing it", async () => {
  assert.ok((await read([{ name: "valid.csv" }])).envelope);
  refused(await read([{ name: "x".repeat(256) + ".csv" }]), "attachment_name_invalid");
});

test("row truncation is refused instead of indexing a partial report", async () => {
  assert.ok((await read([{ name: "control.csv" }])).envelope);
  const rows = ["Account,Amount", ...Array.from({ length: 5001 }, (_, i) => `Account ${i},${i}`)];
  refused(await read([{ name: "large.csv", bytes: Buffer.from(rows.join("\n")) }]), "incomplete_attachment");
});

test("expanded report text is bounded independently of input bytes", async () => {
  assert.ok((await read([{ name: "control.csv" }])).envelope);
  const rows = ["Account,Description", ...Array.from({ length: 4000 }, (_, i) =>
    `Account ${i},${(`entry-${i} detail `).repeat(25)}`)];
  const bytes = Buffer.from(rows.join("\n"));
  assert.ok(bytes.length < 5 * MIB);
  refused(await read([{ name: "large.csv", bytes }]), "attachment_text_limit");
});

test("invalid UTF-8 CSV is refused while a valid UTF-16 report loads", async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(REPORT, "utf16le")]);
  assert.equal(items(await read([{ name: "utf16.csv", bytes: utf16 }]))[0].status, "read");
  refused(await read([{ name: "invalid.csv", bytes: Buffer.concat([Buffer.from(REPORT), Buffer.from([0xff])]) }]), "malformed_attachment");
});

test("combined message quality refusal keeps the message retryable", async () => {
  const attachments = Array.from({ length: 10 }, (_, index) => ({
    name: `report-${index}.csv`,
    bytes: Buffer.from("Account,Amount\n" + "Cash,100\n".repeat(80) + `Receivable,${index}\n`),
  }));
  assert.equal(items(await read(attachments.slice(0, 1)))[0].status, "read");
  refused(await read(attachments), "unreadable_message");
});
