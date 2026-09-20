import { fetchBrainWithAdminKey } from "../components/brain-http.mjs";
import {
  assertFinancialPicturePublicReceipt,
  FINANCIAL_PICTURE_SECTIONS,
} from "../worker/src/lib/financial-picture-contract.js";

export const FINANCIAL_PICTURE_PATH = "/api/fin/financial-picture";
export { assertFinancialPicturePublicReceipt, FINANCIAL_PICTURE_SECTIONS };

const SECTION_SET = new Set(FINANCIAL_PICTURE_SECTIONS);
const FLAG_NAMES = Object.freeze([
  "json", "entity", "year", "period-start", "period-end", "sections", "limit", "cursor",
  "provenance-baseline",
]);
const FLAG_SET = new Set(FLAG_NAMES);
const VALUE_FLAG_SET = new Set(FLAG_NAMES.filter((name) => name !== "json"));
const ENTITY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function safeOptionName(value) {
  const name = String(value || "").split("=", 1)[0];
  return /^[a-z0-9-]{1,64}$/.test(name) ? name : "unknown";
}

function calendarDate(value, flag) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new TypeError(`--${flag} takes an exact calendar date such as 2025-01-31`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`--${flag} is not a real calendar date`);
  }
  return text;
}

function provenanceBaseline(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    throw new TypeError("--provenance-baseline takes the exact UTC snapshot.as_of from a prior receipt");
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time)) {
    throw new TypeError("--provenance-baseline is not a real instant");
  }
  return new Date(time).toISOString();
}

/**
 * Validate the command's complete public argument surface. In particular,
 * there is intentionally no credential flag: shell history and `ps` are not
 * credential stores.
 */
export function parseFinancialPictureFlags(raw = {}) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(input).filter((key) => !FLAG_SET.has(key));
  if (unknown.length) {
    throw new TypeError(
      `unknown option ${unknown.map((key) => `--${safeOptionName(key)}`).join(", ")}; allowed options: ` +
      FLAG_NAMES.map((key) => `--${key}`).join(", "),
    );
  }
  if (input.json !== undefined && input.json !== true) {
    throw new TypeError("--json is a switch and does not take a value");
  }

  let sections = null;
  if (input.sections !== undefined) {
    const values = String(input.sections).split(",").map((value) => value.trim()).filter(Boolean);
    const unknownSections = values.filter((value) => !SECTION_SET.has(value));
    if (!values.length) throw new TypeError("--sections needs at least one section name");
    if (unknownSections.length) {
      throw new TypeError(`unknown section: ${[...new Set(unknownSections)].join(", ")}`);
    }
    sections = [...new Set(values)];
  }

  let entitySlug = null;
  if (input.entity !== undefined) {
    entitySlug = String(input.entity).trim();
    if (!ENTITY.test(entitySlug)) {
      throw new TypeError("--entity takes an exact lowercase entity id: letters, digits, - and _, up to 64 characters");
    }
  }

  let taxYear = null;
  if (input.year !== undefined) {
    taxYear = Number(input.year);
    if (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 2200) {
      throw new TypeError("--year takes a four-digit tax year from 1900 through 2200");
    }
  }

  let limit = 100;
  if (input.limit !== undefined) {
    limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("--limit must be an integer between 1 and 500");
    }
  }

  const periodStart = input["period-start"] === undefined
    ? null
    : calendarDate(input["period-start"], "period-start");
  const periodEnd = input["period-end"] === undefined
    ? null
    : calendarDate(input["period-end"], "period-end");
  if (periodStart && periodEnd && periodEnd < periodStart) {
    throw new TypeError("--period-end cannot be before --period-start");
  }

  const cursor = input.cursor === undefined ? null : String(input.cursor).trim();
  if (cursor !== null && (!cursor || cursor.length > 2048)) {
    throw new TypeError("--cursor takes the bounded cursor returned by one inventory section");
  }
  if (cursor && (!sections || sections.length !== 1)) {
    throw new TypeError("--cursor requires --sections with exactly one section");
  }
  const baselineRecordedAt = input["provenance-baseline"] === undefined
    ? null
    : provenanceBaseline(input["provenance-baseline"]);

  return Object.freeze({
    json: input.json === true,
    sections: sections ? Object.freeze(sections) : null,
    filters: Object.freeze({
      entity_slug: entitySlug,
      tax_year: taxYear,
      period_start: periodStart,
      period_end: periodEnd,
    }),
    limit,
    cursor,
    provenanceBaseline: baselineRecordedAt
      ? Object.freeze({ recorded_at: baselineRecordedAt })
      : null,
  });
}

/**
 * Parse the real argv surface without accepting an ignored positional value.
 * This matters for credentials: a value typed after the manifest must be
 * refused without ever being repeated in an error message.
 */
export function parseFinancialPictureArgv(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("financial-picture arguments must be a list");
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--") || token === "--") {
      throw new TypeError("unexpected positional argument; this command never accepts a credential argument");
    }
    const key = token.slice(2);
    if (key.includes("=")) {
      const safe = safeOptionName(key);
      throw new TypeError(`--${safe} must be written as a separate option and value`);
    }
    if (!FLAG_SET.has(key)) {
      throw new TypeError(
        `unknown option --${safeOptionName(key)}; allowed options: ` +
        FLAG_NAMES.map((name) => `--${name}`).join(", "),
      );
    }
    if (key === "json") {
      raw.json = true;
      continue;
    }
    if (!VALUE_FLAG_SET.has(key)) throw new TypeError("unknown financial-picture option");
    const next = argv[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new TypeError(`--${key} needs a value`);
    }
    raw[key] = String(next);
    index += 1;
  }
  return parseFinancialPictureFlags(raw);
}

export function financialPictureRequestFromFlags(parsed) {
  const request = {
    ...(parsed.sections ? { sections: [...parsed.sections] } : {}),
    filters: { ...parsed.filters },
    limit: parsed.limit,
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
    ...(parsed.provenanceBaseline
      ? { provenance_baseline: { ...parsed.provenanceBaseline } }
      : {}),
  };
  return request;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedReceiptEcho(request = {}) {
  return {
    sections_requested: Array.isArray(request.sections)
      ? [...new Set(request.sections)]
      : [...FINANCIAL_PICTURE_SECTIONS],
    filters: {
      entity_slug: request.filters?.entity_slug ?? null,
      tax_year: request.filters?.tax_year ?? null,
      period_start: request.filters?.period_start ?? null,
      period_end: request.filters?.period_end ?? null,
    },
    page_limit: request.limit ?? 100,
    provenance_baseline: request.provenance_baseline ?? null,
    cursor: request.cursor ?? null,
  };
}

async function validReceipt(body, request) {
  const expected = expectedReceiptEcho(request);
  try {
    assertFinancialPicturePublicReceipt(body);
  } catch {
    return false;
  }
  const shape = body && typeof body === "object" && !Array.isArray(body) &&
    body.schema_version === 2 && body.operation === "financial_picture.inventory" &&
    body.read_only === true && body.mutation_count === 0 &&
    body.completeness_verdict === "not_computed" &&
    body.correctness_verdict === "not_computed" &&
    body.provenance_debt_gate && typeof body.provenance_debt_gate.state === "string" &&
    body.sections && typeof body.sections === "object" &&
    FINANCIAL_PICTURE_SECTIONS.every((name) => {
      const section = body.sections[name];
      return section && typeof section === "object" &&
        typeof section.unavailable === "boolean" &&
        Object.hasOwn(section, "total") && Object.hasOwn(section, "returned") &&
        Object.hasOwn(section, "truncated") && Object.hasOwn(section, "cursor") &&
        Object.hasOwn(section, "next_cursor");
    }) &&
    typeof body.snapshot?.captured_at === "string" &&
    body.snapshot?.as_of === body.snapshot?.captured_at &&
    ["single_d1_batch", "unavailable"].includes(body.snapshot?.consistency) &&
    ["available", "unavailable"].includes(body.snapshot?.database_bookmark_state) &&
    (body.snapshot?.database_bookmark_state === "available"
      ? /^database_snapshot_v2_[a-f0-9]{64}$/.test(String(body.snapshot?.database_version_ref || ""))
      : body.snapshot?.database_version_ref === null) &&
    /^[a-f0-9]{64}$/.test(String(body.snapshot?.content_sha256 || "")) &&
    exactJson(body.sections_requested, expected.sections_requested) &&
    exactJson(body.filters, expected.filters) &&
    body.page_limit === expected.page_limit &&
    exactJson(body.provenance_baseline, expected.provenance_baseline) &&
    body.request_cursor === expected.cursor &&
    FINANCIAL_PICTURE_SECTIONS.every((name) => {
      const section = body.sections[name];
      if (!expected.sections_requested.includes(name) || section.unavailable) {
        return section.cursor === null;
      }
      return section.cursor === (
        expected.sections_requested.length === 1 ? expected.cursor : null
      );
    });
  if (!shape) return false;
  const snapshot = { ...body.snapshot };
  delete snapshot.content_sha256;
  const receiptWithoutHash = { ...body, snapshot };
  return await sha256(JSON.stringify(receiptWithoutHash)) === body.snapshot.content_sha256;
}

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Request a read-only inventory through the Brain's data plane. `credential`
 * must be a resolver callback so destination validation completes before the
 * durable admin key is read. A literal key is not part of this API.
 */
export async function requestFinancialPicture({ baseUrl, request, credential, fetchImpl = fetch } = {}) {
  if (typeof credential !== "function") {
    throw new TypeError("a durable credential resolver is required");
  }
  let endpoint;
  try {
    endpoint = new URL(FINANCIAL_PICTURE_PATH, `${String(baseUrl || "").replace(/\/$/, "")}/`);
  } catch {
    throw new TypeError("the Brain address is invalid");
  }
  let response;
  try {
    response = await fetchBrainWithAdminKey(fetchImpl, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request || {}),
    }, credential);
  } catch (error) {
    const detail = String(error?.message || "");
    if (/admin key is missing/i.test(detail)) {
      throw clientError("admin_key_unavailable", "the Brain's durable admin credential is unavailable");
    }
    if (/HTTPS|request URL|must not contain credentials/i.test(detail)) {
      throw clientError(
        "invalid_brain_address",
        "authenticated Brain requests require HTTPS; HTTP is allowed only for loopback tests",
      );
    }
    if (/redirect|different origin/i.test(detail)) {
      throw clientError(
        "response_origin_refused",
        "the authenticated Brain request was redirected or changed origin",
      );
    }
    throw clientError("financial_picture_transport_failed", "the read-only financial picture request did not complete");
  }
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = response.status === 401 ? "admin_key_rejected"
      : response.status === 403 ? "owner_access_required"
        : response.status === 400 ? "inventory_request_rejected"
          : response.status === 404 ? "entity_filter_not_found"
            : response.status === 503 ? "financial_picture_unavailable"
              : "financial_picture_http_error";
    throw clientError(code,
      `the Brain could not produce the read-only financial picture (HTTP ${response.status}). ` +
      "No financial record was changed.",
    );
  }
  if (!await validReceipt(body, request || {})) {
    throw clientError(
      "invalid_financial_picture_receipt",
      "the Brain did not return a valid inventory receipt. It was not request-bound and no financial record was changed.",
    );
  }
  return body;
}

export function renderFinancialPicture(receipt) {
  const lines = [
    "Financial picture inventory (read-only)",
    `Snapshot ${receipt.snapshot.content_sha256} captured ${receipt.snapshot.captured_at}`,
    "This is stored evidence, not a completeness or correctness verdict.",
    "",
  ];
  for (const name of FINANCIAL_PICTURE_SECTIONS) {
    const section = receipt.sections?.[name];
    if (!section) continue;
    if (section.unavailable) {
      lines.push(`${name}: Unavailable (${section.unavailable_reason || "no supported evidence"})`);
    } else {
      lines.push(
        `${name}: ${section.returned} of ${section.total}` +
        `${section.truncated ? " (more available; use the section cursor)" : ""}` +
        `${section.state === "partial" ? " [schema limitations named in JSON]" : ""}`,
      );
    }
  }
  lines.push("", "No corpus, configuration, access, or index changes were made.");
  return lines.join("\n");
}
