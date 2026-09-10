/**
 * remember-contract — the rules a correction has to satisfy before it is
 * allowed to change what the brain believes.
 *
 * Shared by the local MCP server and the remote connector used by Claude and
 * ChatGPT. Two surfaces writing to one brain under different standards is how
 * a record quietly becomes untrustworthy.
 *
 * What it refuses, and why each refusal exists:
 *
 *   A body under 40 characters. A lesson too short to state its own conditions
 *   cannot be applied later; it is a note to nobody.
 *
 *   "verified" without saying how you know. If you cannot say how, the honest
 *   value is "inferred", and the difference is the whole point of recording a
 *   confidence at all.
 *
 *   A single observation claiming a pattern. "always", "every time", "keeps
 *   failing" are claims about a population that one occurrence cannot support,
 *   so confidence is capped rather than the write being rejected.
 *
 *   A figure with no date anchor. Prices, counts and balances rot. The caller
 *   has to provide the date instead of letting write time impersonate the date
 *   when the fact was true.
 *
 * Every record gets a SHA-256 content identity derived by the server from its
 * normalized rendered content and provenance. A response-loss retry targets
 * the same id, while any changed content gets a new id. `supersedes` carries
 * the id of what a correction replaces and is part of that identity.
 *
 * Pure and dependency-free, because it runs in a Worker and in Node.
 */

export const CONFIDENCE = Object.freeze(["verified", "inferred", "unverified"]);
export const REMEMBER_LIMITS = Object.freeze({
  title: 200,
  bodyMin: 40,
  bodyMax: 20_000,
  verification: 2_000,
  supersedes: 240,
  tags: 20,
  tag: 80,
});
export const REMEMBER_FIELDS = Object.freeze([
  "title", "body", "confidence", "verification", "supersedes", "tags",
]);
export const REMEMBER_RECEIPT_ACTIONS = Object.freeze(["created", "updated", "unchanged"]);
const OVERGENERALISED =
  /\b(always|every ?time|never fails?|keeps? failing|invariably|in every case|without fail)\b/i;
const VOLATILE =
  /(\$[\d,]+|\b\d[\d,._]*\s*(%|users?|customers?|clients?|leads?|per month|\/mo|per day|\/day)\b)/i;
const DATE_ANCHOR = /\bas of\b|\b\d{4}-\d{2}-\d{2}\b/i;

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
  "lesson";
const normalizeText = (value) => value.normalize("NFC").trim();

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateLesson(input, identityContext = {}) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: ["arguments must be an object containing only title, body, confidence, verification, supersedes, and tags"],
      warnings,
      value: null,
    };
  }

  const unknown = Object.keys(input).filter((key) => !REMEMBER_FIELDS.includes(key));
  if (unknown.length) {
    errors.push(
      `unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}. ` +
      `Accepted fields are: ${REMEMBER_FIELDS.join(", ")}`,
    );
  }

  const titleIsString = typeof input.title === "string";
  const bodyIsString = typeof input.body === "string";
  const confidenceIsString = typeof input.confidence === "string";
  const title = titleIsString ? normalizeText(input.title) : "";
  const body = bodyIsString ? normalizeText(input.body) : "";

  if (!titleIsString) errors.push("title must be a string");
  else if (!title) errors.push("title is required");
  else {
    if (/\r|\n/.test(title)) errors.push("title must be one line");
    if (title.length > REMEMBER_LIMITS.title)
      errors.push(`title must be at most ${REMEMBER_LIMITS.title} characters`);
  }

  if (!bodyIsString) errors.push("body must be a string");
  else if (body.length < REMEMBER_LIMITS.bodyMin)
    errors.push(
      `body must be at least ${REMEMBER_LIMITS.bodyMin} characters. A record too short to state its own conditions cannot be applied later.`
    );
  else if (body.length > REMEMBER_LIMITS.bodyMax)
    errors.push(`body must be at most ${REMEMBER_LIMITS.bodyMax} characters`);

  let confidence = confidenceIsString ? input.confidence.trim() : "";
  if (!confidenceIsString || !CONFIDENCE.includes(confidence))
    errors.push(`confidence must be one of: ${CONFIDENCE.join(" | ")}`);

  let verification = null;
  if (input.verification !== undefined) {
    if (typeof input.verification !== "string") {
      errors.push("verification must be a string");
    } else {
      verification = normalizeText(input.verification) || null;
      if (verification && verification.length > REMEMBER_LIMITS.verification)
        errors.push(`verification must be at most ${REMEMBER_LIMITS.verification} characters`);
    }
  }
  if (confidence === "verified" && !verification)
    errors.push(
      'confidence is "verified" but no verification was given. Say how you know. If you cannot, the honest value is "inferred".'
    );

  let supersedes = null;
  if (input.supersedes !== undefined) {
    if (typeof input.supersedes !== "string") {
      errors.push("supersedes must be a string");
    } else {
      supersedes = normalizeText(input.supersedes) || null;
      if (supersedes && /\r|\n/.test(supersedes))
        errors.push("supersedes must be one line");
      if (supersedes && supersedes.length > REMEMBER_LIMITS.supersedes)
        errors.push(`supersedes must be at most ${REMEMBER_LIMITS.supersedes} characters`);
    }
  }

  let tags = [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      errors.push("tags must be an array of strings");
    } else {
      if (input.tags.length > REMEMBER_LIMITS.tags)
        errors.push(`tags must contain at most ${REMEMBER_LIMITS.tags} items`);
      if (input.tags.some((tag) => typeof tag !== "string"))
        errors.push("every tag must be a string");
      const normalized = input.tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => normalizeText(tag))
        .filter(Boolean);
      if (normalized.some((tag) => tag.length > REMEMBER_LIMITS.tag))
        errors.push(`each tag must be at most ${REMEMBER_LIMITS.tag} characters`);
      tags = [...new Set(normalized)];
    }
  }

  if (errors.length) return { ok: false, errors, warnings, value: null };

  const volatile = VOLATILE.test(body);
  if (volatile && !DATE_ANCHOR.test(body)) {
    return {
      ok: false,
      errors: [
        "body states a changing figure without a date anchor. Add an explicit date, such as 'as of 2026-09-10'. Nothing was written.",
      ],
      warnings,
      value: null,
    };
  }

  const claimed = confidence;
  if (OVERGENERALISED.test(body) && confidence === "verified") {
    confidence = "inferred";
    warnings.push(
      'body generalises over occurrences, and one session sees one occurrence. Confidence capped at "inferred".'
    );
  }
  const slug = slugify(title);
  const value = {
    slug,
    source_id: null,
    title,
    body,
    confidence,
    claimed_confidence: claimed === confidence ? null : claimed,
    verification,
    volatile,
    supersedes,
    tags,
  };
  const provenance = {
    written_by: normalizeText(String(identityContext.written_by || "unspecified")),
    agent_profile: normalizeText(String(identityContext.agent_profile || "unspecified")),
    recorded_via: normalizeText(String(identityContext.recorded_via || "unspecified")),
  };
  const sourceType = normalizeText(String(identityContext.source_type || "owner-notes"));
  const digest = await sha256Hex(JSON.stringify({
    identity_version: 1,
    source_type: sourceType,
    content: renderLesson(value),
    metadata: {
      category: "lesson",
      ...provenance,
      confidence: value.confidence,
      claimed_confidence: value.claimed_confidence,
      verification: value.verification,
      volatile: value.volatile,
      supersedes: value.supersedes,
      tags: value.tags,
    },
  }));
  value.source_id = supersedes
    ? `lesson/${slug}-correction-${digest}`
    : `lesson/${slug}-${digest}`;
  return { ok: true, errors, warnings, value };
}

/**
 * A 2xx response only proves that the server answered. Do not tell the owner a
 * record was saved unless storage names the exact document and a known action.
 */
export function validateRememberReceipt(receipt, envelope) {
  const expectedDocUid = `${envelope?.source_type || ""}:${envelope?.source_id || ""}`;
  const exactDocument = receipt?.doc_uid === expectedDocUid;
  const knownAction = REMEMBER_RECEIPT_ACTIONS.includes(receipt?.action);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      !exactDocument || !knownAction) {
    return {
      ok: false,
      error:
        `The Brain did not return an exact storage receipt for ${expectedDocUid}. ` +
        "The request may have reached storage, but do not claim it was saved.",
      value: null,
    };
  }
  return {
    ok: true,
    error: null,
    value: { doc_uid: receipt.doc_uid, action: receipt.action },
  };
}

export function renderLesson(v) {
  const lines = [`# ${v.title}`, "", v.body, "", "---", `Confidence: ${v.confidence}`];
  if (v.claimed_confidence)
    lines.push(`Claimed confidence: ${v.claimed_confidence} (downgraded at write time)`);
  if (v.verification) lines.push(`Verification: ${v.verification}`);
  if (v.volatile) lines.push("Volatile: yes; the date anchor is in the record above");
  if (v.supersedes) lines.push(`Supersedes: ${v.supersedes}`);
  if (v.tags.length) lines.push(`Tags: ${v.tags.join(", ")}`);
  return lines.join("\n");
}
