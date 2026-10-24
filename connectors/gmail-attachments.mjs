import { createHash } from "node:crypto";
import { CFB } from "@e965/xlsx";
import { extract, extensionOf } from "../ingest/extract.mjs";
import { parseEmailMessage } from "../ingest/formats.mjs";
import { isLikelyBinary, textQuality, utf16Encoding } from "../ingest/quality.mjs";
import { scanEnvelope, sanitizeEnvelope } from "../worker/src/lib/secret-scan.js";

export const GMAIL_ATTACHMENT_LIMITS = Object.freeze({
  count: 10,
  bytes: 5 * 1024 * 1024,
  totalBytes: 15 * 1024 * 1024,
  messageBytes: 25 * 1024 * 1024,
  textBytes: 1024 * 1024,
  nameChars: 255,
});
const TYPES = new Set([".xlsx", ".xls", ".csv", ".pdf"]);
const OLE = Buffer.from("d0cf11e0a1b11ae1", "hex");
const MONTHS = "January February March April May June July August September October November December".split(" ");

// Only message-wide evidence failures block history. Immutable attachment
// failures become fixed exclusions so a later resend remains reachable.
function failure(code) {
  return { text: null, attachment_failure: code,
    error: `Gmail message could not be read (${code}). Required message evidence remains unavailable.` };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function attachmentReportDate(text) {
  const dates = new Set();
  let invalid = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:report\s+)?as\s+of\s*:?\s*(.*?)\s*$/i);
    if (!match) continue;
    let date = validDate(match[1]);
    if (!date) {
      // CSV renders a comma-separated title row with a pipe between cells.
      const parts = match[1].match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*|\s*\|\s*|\s+)(\d{4})$/);
      const month = parts ? MONTHS.findIndex((name) => name.toLowerCase() === parts[1].toLowerCase()) + 1 : 0;
      if (month) date = validDate(`${parts[3]}-${String(month).padStart(2, "0")}-${parts[2].padStart(2, "0")}`);
    }
    if (date) dates.add(date);
    else invalid = true;
  }
  const status = dates.size > 1 ? "ambiguous" : dates.size === 1 && !invalid ? "explicit" : "unknown";
  return { report_as_of: status === "explicit" ? [...dates][0] : null, report_as_of_status: status };
}

function formatFailure(bytes, extension) {
  if (!bytes.length) return "unreadable_attachment";
  if (extension === ".csv") {
    if (isLikelyBinary(bytes)) return "malformed_attachment";
    try { new TextDecoder(utf16Encoding(bytes) || "utf-8", { fatal: true }).decode(bytes); }
    catch { return "malformed_attachment"; }
  }
  if (extension === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "malformed_attachment";
  if (extension === ".xls" || extension === ".xlsx") {
    if (bytes.subarray(0, 8).equals(OLE)) {
      let file;
      try { file = CFB.read(bytes, { type: "buffer" }); }
      catch { return "malformed_attachment"; }
      if (CFB.find(file, "EncryptedPackage") || CFB.find(file, "EncryptionInfo")) return "encrypted_attachment";
      if (extension !== ".xls") return "malformed_attachment";
      const book = CFB.find(file, "Workbook") || CFB.find(file, "Book");
      if (!book?.content?.length) return "malformed_attachment";
      const stream = Buffer.from(book.content);
      // BIFF FilePass is encryption evidence even when no password is supplied.
      for (let offset = 0; offset + 4 <= stream.length;) {
        const tag = stream.readUInt16LE(offset);
        const size = stream.readUInt16LE(offset + 2);
        if (tag === 0x002f) return "encrypted_attachment";
        if (offset + 4 + size > stream.length) return "malformed_attachment";
        offset += 4 + size;
      }
    } else if (extension === ".xls" || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) {
      // The workbook reader intentionally accepts CSV disguised as XLS. Gmail
      // must not report a malformed binary attachment as a complete workbook.
      return "malformed_attachment";
    }
  }
  return null;
}

/** One bounded MIME read; attachments never acquire a separate deletion owner. */
export async function extractGmailMessage(raw, { messageId, receivedAt, scanCredentials = true }) {
  const limits = GMAIL_ATTACHMENT_LIMITS;
  // Guard the encoded value before allocating its decoded copy. Gmail's outer
  // transport is base64url; whitespace or a permissively decoded prefix is not
  // evidence that the complete message was read.
  if (typeof raw !== "string") return failure("malformed_message");
  if (raw.length > Math.ceil(limits.messageBytes / 3) * 4) return failure("message_size_limit");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw) || raw.replace(/=+$/, "").length % 4 === 1) return failure("malformed_message");
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length > limits.messageBytes) return failure("message_size_limit");
  let parsed;
  try { parsed = await parseEmailMessage(decoded, { includeAttachments: true }); }
  catch { return failure("malformed_message"); }
  if (parsed.error) return failure("malformed_message");
  const attachments = parsed.attachments;
  // Use the same scanner and capability-link sanitizer as the final envelope
  // boundary, before a credential in one immutable part can poison its siblings.
  const partRefused = (part) => scanCredentials && scanEnvelope(sanitizeEnvelope(part)).shouldRefuse;
  const body = partRefused({ content: parsed.text, title: parsed.subject })
    ? { status: "excluded", reason: "credential_detected" }
    : textQuality(parsed.text).ok ? { status: "read" }
      : { status: "excluded", reason: "unreadable_body" };
  const items = [];
  const sections = [body.status === "read" ? parsed.text : `Message body excluded: ${body.reason}`];
  const seen = new Map();
  let total = 0;
  let textBytes = 0;
  const exclude = (item, reason) => {
    Object.assign(item, { status: "excluded", reason });
    // No filename or parser diagnostic can enter an exclusion marker.
    sections.push(`Attachment ${item.index}\nAttachment excluded: ${reason}`);
  };
  for (const [offset, attachment] of attachments.entries()) {
    const bytes = Buffer.from(attachment.content);
    const name = attachment.filename || "";
    const invalidName = name.length > limits.nameChars || /[\u0000-\u001f\u007f]/.test(name);
    const extension = extensionOf(name);
    const mimeType = String(attachment.mimeType || "").toLowerCase();
    const item = { index: offset + 1, name: invalidName ? null : name, message_id: messageId, received_at: receivedAt,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      report_as_of: null, report_as_of_status: "unknown" };
    items.push(item);
    // A filename is part of its attachment, including unsupported and duplicate
    // occurrences. Withheld names must disappear from metadata as well as text.
    if (partRefused({ title: name })) {
      item.name = null;
      exclude(item, "credential_detected");
      continue;
    }
    const bound = offset >= limits.count ? "attachment_count_limit"
      : invalidName ? "attachment_name_invalid"
        : bytes.length > limits.bytes ? "attachment_size_limit"
          : total + bytes.length > limits.totalBytes ? "attachment_total_limit" : null;
    if (bound) { exclude(item, bound); continue; }
    // Admission budgets count every in-bound occurrence, even duplicates and
    // unsupported files. A rejected large part cannot starve a later small one.
    total += bytes.length;
    const exclusion = mimeType.startsWith("message/") ? "nested_message"
      : mimeType.startsWith("image/") ? "image_part"
        : !name ? "missing_filename" : !TYPES.has(extension) ? "unsupported_type" : null;
    if (exclusion) {
      exclude(item, exclusion);
      continue;
    }
    const invalid = formatFailure(bytes, extension);
    if (invalid) { exclude(item, invalid); continue; }
    const key = `${extension}:${item.sha256}`;
    const duplicate = seen.get(key);
    if (duplicate) {
      Object.assign(item, { status: "duplicate", duplicate_of: duplicate.index,
        report_as_of: duplicate.report_as_of, report_as_of_status: duplicate.report_as_of_status });
      sections.push(`Attachment ${item.index}: ${name}\nDuplicate of attachment ${duplicate.index}; report text appears there.`);
      continue;
    }
    const got = await extract(bytes, name, { rejectEncrypted: true });
    if (got.error || got.text == null) {
      exclude(item, got.observation?.state === "password_protected" || /password|encrypt/i.test(got.error || "")
        ? "encrypted_attachment" : got.observation?.state === "scan_only_ocr_needed"
          ? "incomplete_attachment" : "malformed_attachment");
      continue;
    }
    if (got.incomplete === true || got.provenance?.text_reliable === false) { exclude(item, "incomplete_attachment"); continue; }
    const size = Buffer.byteLength(got.text, "utf8");
    if (textBytes + size > limits.textBytes) { exclude(item, "attachment_text_limit"); continue; }
    if (partRefused({ content: got.text, title: name })) {
      exclude(item, "credential_detected");
      continue;
    }
    // A filename-generated table heading cannot prove that an empty CSV held
    // report data. Judge only the extracted rows, while keeping the label in
    // searchable content for provenance.
    const readableText = extension === ".csv" ? got.text.replace(/^Table:[^\n]*\n?/, "") : got.text;
    if (!textQuality(readableText).ok) { exclude(item, "unreadable_attachment"); continue; }
    textBytes += size;
    Object.assign(item, { status: "read", ...attachmentReportDate(got.text) });
    seen.set(key, item);
    sections.push(`Attachment ${item.index}: ${name}\nMessage received: ${receivedAt || "unknown"}\n` +
      `Report as of: ${item.report_as_of || "unknown"} (attachment text)\n\n${got.text}`);
  }
  // Preserve the established whole-family refusal when there is no readable
  // part left. A marker alone must not turn credential-only mail into acceptance.
  if (body.status !== "read" && !items.some((item) => item.status === "read") &&
      (body.reason === "credential_detected" || items.some((item) => item.reason === "credential_detected"))) {
    return { credential_refusal: true };
  }
  return { text: sections.join("\n\n"), subject: body.status === "read" ? parsed.subject : "Message with excluded body", body,
    attachments: { policy_version: 2, items,
      read_count: items.filter((item) => item.status === "read").length,
      duplicate_count: items.filter((item) => item.status === "duplicate").length,
      excluded_count: items.filter((item) => item.status === "excluded").length } };
}
