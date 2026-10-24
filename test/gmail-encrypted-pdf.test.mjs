import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getDocumentProxy } from "unpdf";
import { extractPdf } from "../ingest/formats.mjs";
import { toEnvelope } from "../connectors/gmail.mjs";

const PADDING = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (bytes) => createHash("md5").update(bytes).digest();
const pad = (text) => Buffer.concat([Buffer.from(text, "ascii"), PADDING]).subarray(0, 32);

// A synthetic Standard Security revision-2 PDF uses RC4 for its stream. Keeping
// this tiny fixture builder local avoids a binary fixture or an external tool.
function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(input.map((byte) => {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 255];
  }));
}

function reportPdf({ encrypted = false } = {}) {
  const lines = ["Balance sheet", "As of October 15, 2026",
    "Operating cash 1200. Accounts payable 200. Retained earnings 1000.",
    "This scheduled report summarizes the accounts for the stated reporting date."];
  let stream = Buffer.from(`BT /F1 12 Tf 40 740 Td ${lines.map((line) => `(${line}) Tj 0 -18 Td`).join(" ")} ET`);
  const id = Buffer.alloc(16, 0x11);
  let encryption;
  if (encrypted) {
    const owner = rc4(md5(pad("synthetic owner passphrase")).subarray(0, 5), pad(""));
    const permission = Buffer.alloc(4);
    permission.writeInt32LE(-4);
    const key = md5(Buffer.concat([pad(""), owner, permission, id])).subarray(0, 5);
    const user = rc4(key, PADDING);
    const streamKey = md5(Buffer.concat([key, Buffer.from([5, 0, 0, 0, 0])])).subarray(0, 10);
    stream = rc4(streamKey, stream);
    encryption = `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> >>`;
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    ...(encrypted ? [encryption] : []),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  }
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  tail += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R`;
  if (encrypted) tail += ` /Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`;
  tail += ` >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(tail)]);
}

test("control: ordinary PDF remains readable under the Gmail encryption policy", async () => {
  const result = await extractPdf(reportPdf(), { rejectEncrypted: true });
  assert.ok(result.text.includes("Operating cash"));
  assert.equal(result.incomplete, undefined);
});

test("control: empty-password encryption is real and the default extractor can read it", async () => {
  const bytes = reportPdf({ encrypted: true });
  const document = await getDocumentProxy(new Uint8Array(bytes));
  try {
    assert.equal((await document.getMetadata()).info.EncryptFilterName, "Standard");
  } finally {
    await document.loadingTask.destroy();
  }
  const result = await extractPdf(bytes);
  assert.ok(result.text.includes("Operating cash"));
  assert.equal(result.incomplete, undefined);
});

test("Gmail refuses encrypted PDF even when an empty user password opens it", async () => {
  const result = await extractPdf(reportPdf({ encrypted: true }), { rejectEncrypted: true });
  assert.equal(result.text, null);
  assert.match(result.error, /encrypted/);
  assert.equal(result.observation.state, "password_protected");
});

test("Gmail's message boundary excludes an encrypted PDF and keeps its body", async () => {
  const raw = Buffer.from([
    "From: reports@example.invalid", "To: owner@example.invalid", "Subject: Scheduled report",
    'Content-Type: multipart/mixed; boundary="synthetic-boundary"', "",
    "--synthetic-boundary", "Content-Type: text/plain", "",
    "The scheduled report is attached for review by the owner.",
    "--synthetic-boundary", "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64", "", reportPdf({ encrypted: true }).toString("base64"),
    "--synthetic-boundary--", "",
  ].join("\r\n")).toString("base64url");
  const result = await toEnvelope(async () => "synthetic-access", "synthetic-delivery", {}, {
    fetchImpl: async () => new Response(JSON.stringify({
      id: "synthetic-delivery", labelIds: ["INBOX"], internalDate: "1792670400000", raw,
    })),
  });
  assert.ok(result.envelope.content.includes("scheduled report is attached"));
  assert.equal(result.envelope.metadata.gmail_attachments.items[0].reason, "encrypted_attachment");
  assert.equal(result.envelope.metadata.gmail_attachments.items[0].status, "excluded");
  assert.notEqual(result.cursor_blocking, true);
});
