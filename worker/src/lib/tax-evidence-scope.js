/**
 * Deterministic scope checks for exact tax-form questions.
 *
 * Retrieval is allowed to return near neighbors. An answer is not. A tax line
 * with the same label can mean something different on a partnership return,
 * a partner's Schedule K-1, and another entity's filing. This module therefore
 * requires a named single-entity, single-year, single-form question to bind to
 * the same three facts on the document before the record is answer-eligible.
 */

const QUESTION_FORM_PATTERNS = Object.freeze([
  ["schedule_k1", /\b(?:schedule\s+)?k[\s-]?1\b/i],
  ["1120s", /\bform\s+1120[\s-]?s\b/i],
  ["1120", /\bform\s+1120\b/i],
  ["1065", /\bform\s+1065\b/i],
  ["1040", /\bform\s+1040\b/i],
  ["1099", /\b(?:form\s+)?1099(?:[\s-]?[a-z]+)?\b/i],
  ["w2", /\b(?:form\s+)?w[\s-]?2\b/i],
]);

const DOCUMENT_FORM_PATTERNS = Object.freeze([
  ["schedule_k1", /\b(?:schedule\s+)?k[\s-]?1\b/i],
  ["1120s", /\b(?:form\s+)?1120[\s-]?s\b/i],
  ["1120", /\b(?:form\s+)?1120\b/i],
  ["1065", /\b(?:form\s+)?1065\b/i],
  ["1040", /\b(?:form\s+)?1040\b/i],
  ["1099", /\b(?:form\s+)?1099(?:[\s-]?[a-z]+)?\b/i],
  ["w2", /\b(?:form\s+)?w[\s-]?2\b/i],
]);

const jsonObject = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const words = (value) => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/'s\b/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean);

// Preserve every token in a parsed entity, including legal suffixes and words
// such as "Tax" or "Business". Those terms can distinguish separate legal
// entities, so discarding them would make this fail-open boundary ambiguous.
const entityWords = (value) => words(value);

const containsPhrase = (surface, phraseWords) => {
  if (!phraseWords.length) return false;
  const normalized = ` ${entityWords(surface).join(" ")} `;
  return normalized.includes(` ${phraseWords.join(" ")} `);
};

function detectedForm(value, patterns) {
  const text = String(value || "");
  for (const [form, pattern] of patterns) {
    if (pattern.test(text)) return form;
  }
  return null;
}

function queryEntity(question, yearIndex) {
  const prefix = String(question || "").slice(0, yearIndex)
    .replace(/[’']s\s*$/i, "")
    .trim();
  if (!prefix) return [];

  // This covers the ordinary owner phrasing: "what ... did Example Entity
  // 2023 Form 1065 report?" It also accepts lower-case names because the
  // grammar, rather than capitalization, identifies the subject slot.
  const grammatical = /\b(?:did|does|for|of|from)\s+(.{1,120}?)\s*$/i.exec(prefix)?.[1] || null;
  if (grammatical) {
    const candidate = entityWords(grammatical);
    if (candidate.length >= 1 && candidate.length <= 8) return candidate;
  }

  // Fallback for "What is Example Entity's 2023 Form 1065 ...". Choose the
  // last proper-name-shaped phrase before the year so question words cannot
  // become the entity.
  const properNames = [...prefix.matchAll(
    /\b[A-Z][A-Za-z0-9&.'’\-]*(?:\s+[A-Z][A-Za-z0-9&.'’\-]*){0,7}\b/g,
  )];
  for (let index = properNames.length - 1; index >= 0; index--) {
    const candidate = entityWords(properNames[index][0]);
    if (candidate.length >= 1 && candidate.length <= 8) return candidate;
  }
  return [];
}

/** Parse only an unambiguous named-entity, tax-year, exact-form question. */
export function taxQuestionScope(question = "") {
  const text = String(question || "");
  const form = detectedForm(text, QUESTION_FORM_PATTERNS);
  if (!form) return null;

  const years = [...text.matchAll(/\b(?:19|20)\d{2}\b/g)];
  const distinctYears = [...new Set(years.map((match) => match[0]))];
  if (distinctYears.length !== 1) return null;
  const yearMatch = years.find((match) => match[0] === distinctYears[0]);
  const entity = queryEntity(text, yearMatch.index);
  if (!entity.length) return null;
  return Object.freeze({ form, year: distinctYears[0], entity });
}

function projectedDocumentHead(row) {
  const present = Object.hasOwn(row || {}, "authority_document_head") ||
    Object.hasOwn(row || {}, "_authority_document_head");
  const value = Object.hasOwn(row || {}, "authority_document_head")
    ? row.authority_document_head
    : row?._authority_document_head;
  return { present, value };
}

function documentIdentityEvidence(row, metadata) {
  const authoritative = [];
  if (row?.entity_slug) authoritative.push({ value: row.entity_slug, exact: true });
  for (const key of [
    "entity_slug", "taxpayer_name", "filer_name", "partnership_name", "entity_name", "legal_name",
  ]) {
    if (metadata?.[key]) authoritative.push({ value: metadata[key], exact: true });
  }
  const head = projectedDocumentHead(row);
  if (head.present) authoritative.push({ value: head.value || "", exact: false });

  // Structured scope narrows identity, but it cannot overrule a contradictory
  // native header. Every available authoritative signal must agree. Filename
  // and arbitrary matching-body fallbacks are used only when none exists.
  return authoritative.length
    ? { surfaces: authoritative, requireAll: true }
    : {
        surfaces: [row?.title, row?.text, row?.snippet]
          .filter(Boolean)
          .map((value) => ({ value, exact: false })),
        requireAll: false,
      };
}

function documentTaxSurface(row) {
  const head = projectedDocumentHead(row);
  // Apply the same native-header precedence to year and form. Form detection
  // checks Schedule K-1 before Form 1065, so a standard K-1 header remains a
  // K-1 even though it also names the form used by the partnership.
  return head.present
    ? [head.value].filter(Boolean)
    : [row?.title, row?.text, row?.snippet].filter(Boolean);
}

function surfaceMatchesOnlyYear(surface, requestedYear) {
  const years = [...String(surface || "").matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => match[0]);
  const distinct = [...new Set(years)];
  return distinct.length === 1 && distinct[0] === requestedYear;
}

/**
 * Return null outside the narrow contract, otherwise an aggregate-only match
 * receipt safe to expose beside evidence. The requested entity name remains in
 * the private question and is deliberately omitted from this receipt.
 */
export function taxEvidenceScope(row = {}, question = "") {
  const requested = taxQuestionScope(question);
  if (!requested) return null;
  const metadata = jsonObject(row.authority_meta ?? row._authority_meta);
  const identity = documentIdentityEvidence(row, metadata);
  const taxSurfaces = documentTaxSurface(row);

  const identityMatches = ({ value, exact }) => exact
    ? entityWords(value).join(" ") === requested.entity.join(" ")
    : containsPhrase(value, requested.entity);
  const entityMatched = identity.requireAll
    ? identity.surfaces.every(identityMatches)
    : identity.surfaces.some(identityMatches);
  const explicitTaxYear = metadata?.tax_year ?? metadata?.taxYear ?? null;
  const structuredYearPresent = explicitTaxYear !== null && explicitTaxYear !== undefined && explicitTaxYear !== "";
  const header = projectedDocumentHead(row);
  const yearMatched = structuredYearPresent
    ? String(explicitTaxYear) === requested.year &&
      (!header.present || surfaceMatchesOnlyYear(header.value, requested.year))
    : taxSurfaces.some((surface) => surfaceMatchesOnlyYear(surface, requested.year));
  const documentForm = taxSurfaces
    .map((surface) => detectedForm(surface, DOCUMENT_FORM_PATTERNS))
    .find(Boolean) || null;
  const formMatched = documentForm === requested.form;
  const matched = entityMatched && yearMatched && formMatched;
  // A filename can identify an encrypted/unreadable filing well enough to
  // block a corpus-absence claim, but never well enough to authorize an
  // answer. Keep that weaker signal separate from `matched`.
  const titleWords = String(row?.title || "");
  const titleMatched = containsPhrase(titleWords, requested.entity) &&
    new RegExp(`\\b${requested.year}\\b`).test(titleWords) &&
    detectedForm(titleWords, DOCUMENT_FORM_PATTERNS) === requested.form;

  return {
    applicable: true,
    matched,
    entity_matched: entityMatched,
    year_matched: yearMatched,
    form_matched: formMatched,
    title_candidate_matched: titleMatched,
    requested_year: requested.year,
    requested_form: requested.form,
  };
}
