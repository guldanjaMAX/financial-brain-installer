/**
 * Deterministic scope checks for exact tax-form questions.
 *
 * Retrieval is allowed to return near neighbors. An answer is not. A tax line
 * with the same label can mean something different on a partnership return,
 * a partner's Schedule K-1, and another entity's filing. This module therefore
 * requires a named single-entity, single-year, single-form question to bind to
 * the same three facts on the document before the record is answer-eligible.
 */

// Variants precede their base forms. Every base has an explicit suffix guard,
// so 1040-X cannot become 1040 and one 1099 subtype cannot stand in for
// another. Question patterns require the word "Form" for bare numeric forms;
// common names such as W-2, 1099-INT, and Schedule K-1 remain natural to ask.
const QUESTION_FORM_PATTERNS = Object.freeze([
  ["schedule-k-1", /\b(?:schedule\s+)?k[\s-]?1\b(?!-[a-z0-9])/i],
  ["1099-misc", /\b(?:form\s+)?1099[\s-]*misc\b(?!-[a-z0-9])/i],
  ["1099-int", /\b(?:form\s+)?1099[\s-]*int\b(?!-[a-z0-9])/i],
  ["1099-nec", /\b(?:form\s+)?1099[\s-]*nec\b(?!-[a-z0-9])/i],
  ["1099-div", /\b(?:form\s+)?1099[\s-]*div\b(?!-[a-z0-9])/i],
  ["1040-x", /\bform\s+1040[\s-]*x\b(?!-[a-z0-9])/i],
  ["1120-s", /\bform\s+1120[\s-]*s\b(?!-[a-z0-9])/i],
  ["1120-h", /\bform\s+1120[\s-]*h\b(?!-[a-z0-9])/i],
  ["1099-k", /\b(?:form\s+)?1099[\s-]*k\b(?!-[a-z0-9])/i],
  ["1099-r", /\b(?:form\s+)?1099[\s-]*r\b(?!-[a-z0-9])/i],
  ["1099-b", /\b(?:form\s+)?1099[\s-]*b\b(?!-[a-z0-9])/i],
  ["1099-s", /\b(?:form\s+)?1099[\s-]*s\b(?!-[a-z0-9])/i],
  ["w-2", /\b(?:form\s+)?w[\s-]?2\b(?!-[a-z0-9])/i],
  ["1040", /\bform\s+1040\b(?!\s*-\s*[a-z0-9])(?!\s+x\b)/i],
  ["1065", /\bform\s+1065\b(?!\s*-\s*[a-z0-9])/i],
  ["1120", /\bform\s+1120\b(?!\s*-\s*[a-z0-9])(?!\s+[sh]\b)/i],
  ["941", /\bform\s+941\b(?!\s*-\s*[a-z0-9])/i],
  ["940", /\bform\s+940\b(?!\s*-\s*[a-z0-9])/i],
]);

const DOCUMENT_FORM_PATTERNS = Object.freeze([
  ["schedule-k-1", /\b(?:schedule\s+)?k[\s-]?1\b(?!-[a-z0-9])/i],
  ["1099-misc", /\b(?:form\s+)?1099[\s-]*misc\b(?!-[a-z0-9])/i],
  ["1099-int", /\b(?:form\s+)?1099[\s-]*int\b(?!-[a-z0-9])/i],
  ["1099-nec", /\b(?:form\s+)?1099[\s-]*nec\b(?!-[a-z0-9])/i],
  ["1099-div", /\b(?:form\s+)?1099[\s-]*div\b(?!-[a-z0-9])/i],
  ["1040-x", /\b(?:form\s+)?1040[\s-]*x\b(?!-[a-z0-9])/i],
  ["1120-s", /\b(?:form\s+)?1120[\s-]*s\b(?!-[a-z0-9])/i],
  ["1120-h", /\b(?:form\s+)?1120[\s-]*h\b(?!-[a-z0-9])/i],
  ["1099-k", /\b(?:form\s+)?1099[\s-]*k\b(?!-[a-z0-9])/i],
  ["1099-r", /\b(?:form\s+)?1099[\s-]*r\b(?!-[a-z0-9])/i],
  ["1099-b", /\b(?:form\s+)?1099[\s-]*b\b(?!-[a-z0-9])/i],
  ["1099-s", /\b(?:form\s+)?1099[\s-]*s\b(?!-[a-z0-9])/i],
  ["w-2", /\b(?:form\s+)?w[\s-]?2\b(?!-[a-z0-9])/i],
  ["1040", /\b(?:form\s+)?1040\b(?!\s*-\s*[a-z0-9])(?!\s+x\b)/i],
  ["1065", /\b(?:form\s+)?1065\b(?!\s*-\s*[a-z0-9])/i],
  ["1120", /\b(?:form\s+)?1120\b(?!\s*-\s*[a-z0-9])(?!\s+[sh]\b)/i],
  ["941", /\b(?:form\s+)?941\b(?!\s*-\s*[a-z0-9])/i],
  ["940", /\b(?:form\s+)?940\b(?!\s*-\s*[a-z0-9])/i],
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

function detectedFormMatch(value, patterns) {
  const text = String(value || "");
  let detected = null;
  for (let priority = 0; priority < patterns.length; priority++) {
    const [form, pattern] = patterns[priority];
    const match = pattern.exec(text);
    if (match && (!detected || match.index < detected.index ||
      (match.index === detected.index && priority < detected.priority))) {
      detected = { form, index: match.index, length: match[0].length, priority };
    }
  }
  return detected;
}

const detectedForm = (value, patterns) => detectedFormMatch(value, patterns)?.form || null;

function exactQuestionFormMatch(value) {
  const text = String(value || "");
  const matches = [];
  for (const [form, pattern] of QUESTION_FORM_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      matches.push({ form, index: match.index, length: match[0].length });
    }
  }
  if (new Set(matches.map((match) => match.form)).size !== 1) return null;
  return matches;
}

const ENTITY_PARSE_STOPWORDS = new Set([
  "a", "about", "accountant", "an", "at", "charge", "charged", "charges", "cost", "costs",
  "could", "did", "do", "does", "fee", "fees", "file", "filed", "filing", "for", "from", "he",
  "her", "hers", "his", "how", "in", "invoice", "is", "it", "its", "many", "much", "my", "of",
  "on", "our", "owe", "owed", "owes", "owing", "paid", "pay", "payment", "payments", "pays",
  "preparation", "prepare", "prepared", "receive", "received",
  "receives", "report", "reported", "reports", "return", "returns", "she", "should", "spend", "spent",
  "the", "their", "theirs", "they", "to", "us", "was", "we", "were", "what", "when", "where",
  "which", "who", "whom", "whose", "why", "will", "with", "would", "you", "your", "yours",
]);
const GENERIC_ENTITY_WORDS = new Set([
  "business", "co", "company", "corp", "corporation", "entity", "inc", "llc", "lp", "llp",
  "partnership", "taxpayer",
]);
const TAX_PREPARATION_ACTIVITY = /\bprepar(?:ation|e|ed|er|ers|es|ing)\b/i;
const TAX_SERVICE_ROLE = /\b(?:accountants?|bookkeep(?:er|ers|ing)|return\s+preparers?|tax\s+preparers?)\b/i;
const SERVICE_PRICE_CONTEXT = /\b(?:charg(?:e|ed|es|ing)|costs?|fees?|invoices?|spend|spent)\b/i;
const PAYMENT_CONTEXT = /\b(?:paid|pay|payments?|pays)\b/i;
const DIRECT_SERVICE_PAYMENT = /\b(?:paid|pay|pays)\s+(?:(?:an?|my|our|the|their|your)\s+)?(?:accountants?|bookkeepers?|return\s+preparers?|tax\s+preparers?)\b/i;
const STRONG_TAX_LINE_FACT = /\bordinary\s+business\s+(?:income|loss)\b/i;

function conservativeEntityWords(value) {
  const withoutLeadingArticle = String(value || "").trim().replace(/^the\s+/i, "");
  const candidate = entityWords(withoutLeadingArticle);
  if (candidate.length < 1 || candidate.length > 8) return [];
  if (candidate.some((word) => ENTITY_PARSE_STOPWORDS.has(word))) return [];
  if (candidate.every((word) => GENERIC_ENTITY_WORDS.has(word))) return [];
  return candidate;
}

function isTaxPreparationServiceQuestion(value) {
  const text = String(value || "");
  const preparationActivity = TAX_PREPARATION_ACTIVITY.test(text);
  const serviceRole = TAX_SERVICE_ROLE.test(text);
  const servicePrice = SERVICE_PRICE_CONTEXT.test(text);
  const payment = PAYMENT_CONTEXT.test(text);
  return (preparationActivity && (servicePrice || payment)) ||
    (serviceRole && servicePrice) || DIRECT_SERVICE_PAYMENT.test(text);
}

function hasNamedTaxLineFactQuestion(value) {
  const text = String(value || "");
  if (!STRONG_TAX_LINE_FACT.test(text)) return false;
  const subject = /\b(?:did|does)\s+(.{1,120}?)\s+(?:report|show|list|state|record)\b/i
    .exec(text)?.[1] || null;
  return Boolean(subject && conservativeEntityWords(subject).length);
}

function queryEntity(question, yearIndex) {
  const prefix = String(question || "").slice(0, yearIndex)
    .replace(/[’']s\s*$/i, "")
    .trim();
  if (!prefix) return [];

  // Natural owner wording often places the requested field before the entity:
  // "What ordinary business income did Ocotillo Desert report on its 2023
  // Form 1065?" Capture only the grammatical subject before a bounded return
  // verb and the possessive/prepositional bridge into the year.
  const reportingSubject = /\b(?:did|does)\s+(.{1,120}?)\s+(?:report|show|list|state|record|pay|owe)\b.{0,100}\b(?:on|in)\s+(?:its|the)\s*$/i
    .exec(prefix)?.[1] || null;
  if (reportingSubject) return conservativeEntityWords(reportingSubject);

  const prepositionalSubject = /\b(?:for|of|from)\s+(.{1,120}?)(?:,?\s+(?:its|the))\s*$/i
    .exec(prefix)?.[1] || null;
  if (prepositionalSubject) return conservativeEntityWords(prepositionalSubject);

  // This covers the ordinary owner phrasing: "what ... did Example Entity
  // 2023 Form 1065 report?" It also accepts lower-case names because the
  // grammar, rather than capitalization, identifies the subject slot.
  const grammatical = /\b(?:did|does|for|of|from)\s+(.{1,120}?)\s*$/i.exec(prefix)?.[1] || null;
  if (grammatical) {
    // If a grammatical subject slot is present but contains predicate words,
    // stop. Falling through to a capitalized substring would turn a tax-prep
    // invoice question into a tax-return question.
    return conservativeEntityWords(grammatical);
  }

  // Fallback for "What is Example Entity's 2023 Form 1065 ...". Choose the
  // last proper-name-shaped phrase before the year so question words cannot
  // become the entity.
  const properName = /(?:^|[^A-Za-z0-9&.'’\-])([A-Z][A-Za-z0-9&.'’\-]*(?:\s+[A-Z][A-Za-z0-9&.'’\-]*){0,7})$/
    .exec(prefix)?.[1] || null;
  return properName ? conservativeEntityWords(properName) : [];
}

function parseTaxQuestionScope(question = "") {
  const text = String(question || "");
  if (isTaxPreparationServiceQuestion(text)) return null;

  const years = [...text.matchAll(/\b(?:19|20)\d{2}\b/g)];
  if (years.length !== 1) return null;
  const yearMatch = years[0];
  const formMatches = exactQuestionFormMatch(text);
  if (!formMatches) return null;
  // This narrow contract covers `Entity's 2023 Form 1065` and its direct
  // non-possessive equivalent. A form mentioned elsewhere in a sentence, such
  // as the object of a preparation invoice, is left to the general verifier.
  const yearEnd = yearMatch.index + yearMatch[0].length;
  const formMatch = formMatches.find((match) =>
    match.index >= yearEnd && /^\s*$/.test(text.slice(yearEnd, match.index)));
  if (!formMatch) return null;
  const entity = queryEntity(text, yearMatch.index);
  if (!entity.length) return null;
  return Object.freeze({ form: formMatch.form, year: yearMatch[0], entity });
}

/** Parse only an unambiguous named-entity, tax-year, exact-form question. */
export function taxQuestionScope(question = "") {
  return parseTaxQuestionScope(question);
}

/**
 * Keep tax intent separate from exact scope resolution. A partial tax request
 * must fail closed rather than silently dropping the entity/year/form guard.
 */
export function taxQuestionScopeAssessment(question = "") {
  const text = String(question || "");
  if (isTaxPreparationServiceQuestion(text)) {
    return Object.freeze({ applicable: false, resolved: false, scope: null });
  }
  const scope = parseTaxQuestionScope(text);
  if (scope) return Object.freeze({ applicable: true, resolved: true, scope });
  const formIntent = QUESTION_FORM_PATTERNS.some(([, pattern]) => pattern.test(text));
  const bareFormIntent = /\b(?:1040(?:-x)?|1065|1120(?:-s|-h)?|1099-(?:int|nec|misc|div|k|r|b|s)|941|940)\b/i.test(text);
  const adjacentYearBareFormIntent = /\b(?:19|20)\d{2}\s+(?:1040(?:[\s-]*x)?|1065|1120(?:[\s-]*[sh])?|941|940)\b/i.test(text);
  const taxContext = /\b(?:tax|return|filing|irs|schedule|form|partnership|corporate)\b/i.test(text);
  const returnIntent = /\b(?:tax\s+(?:return|filing)|income\s+tax\s+return|partnership\s+return|corporate\s+return)\b/i.test(text);
  const returnFactIntent = /\b(?:amount|balance|basis|credit|deduction|distribution|expense|income|liabilit(?:y|ies)|line\s+\d+|loss|ordinary\s+business|owe(?:d|s)?|owing|paid|pay(?:ment|ments|s)?|refund|report(?:ed|s|ing)?|revenue|show(?:ed|n|s|ing)?|state(?:d|s|ing)?|tax(?:es)?\s+(?:due|withheld)|wages?)\b/i.test(text);
  const namedTaxLineFactIntent = hasNamedTaxLineFactQuestion(text);
  return Object.freeze({
    applicable: returnFactIntent && (
      formIntent || adjacentYearBareFormIntent || (bareFormIntent && taxContext) ||
      returnIntent || namedTaxLineFactIntent
    ),
    resolved: false,
    scope: null,
  });
}

function projectedDocumentHead(row) {
  const present = Object.hasOwn(row || {}, "authority_document_head") ||
    Object.hasOwn(row || {}, "_authority_document_head");
  const projected = Object.hasOwn(row || {}, "authority_document_head")
    ? row.authority_document_head
    : row?._authority_document_head;
  if (!present || typeof projected !== "string") return { present, value: projected };

  // D1 chunking prepends this exact product-generated header to every chunk:
  // `[title]\n\n`. It is useful retrieval context, but it is still a filename,
  // not the tax return's native header. Strip only the exact prefix generated
  // from this row's exact title. Never strip a merely bracket-shaped first line
  // from owner content, and never guess when the stored title differs.
  const title = typeof row?.title === "string" ? row.title : "";
  const injectedPrefix = title ? `[${title}]\n\n` : "";
  const value = injectedPrefix && projected.startsWith(injectedPrefix)
    ? projected.slice(injectedPrefix.length)
    : projected;
  return { present, value };
}

function nativeHeaderMatchesEntity(value, requestedEntity) {
  const text = String(value || "");
  if (!text.trim()) return false;

  // Prefer explicit primary-filer labels. Stop at punctuation so a secondary
  // party named later in the same extracted line cannot satisfy the taxpayer
  // field merely by appearing somewhere in the first chunk.
  const labeled = [...text.matchAll(
    /(?:^|\n)\s*(?:taxpayer(?:\s+name)?|filer(?:\s+name)?|partnership\s+name|corporation\s+name|employer\s+name|name\s+of\s+(?:taxpayer|partnership|corporation|organization))\s*[:#-]\s*([^\n.;]{1,200})/gi,
  )].map((match) => entityWords(match[1]));
  if (labeled.length) {
    return labeled.some((candidate) => candidate.join(" ") === requestedEntity.join(" "));
  }

  // Some native extracts begin directly with the legal name. Accept only the
  // first clause before the tax year/form, never an arbitrary later mention.
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const firstClause = firstLine.split(/[.;|]/, 1)[0];
  const boundary = /\b(?:19|20)\d{2}\b|\bform\b/i.exec(firstClause);
  const leadingIdentity = boundary ? firstClause.slice(0, boundary.index) : firstClause;
  return entityWords(leadingIdentity).join(" ") === requestedEntity.join(" ");
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
  if (head.present) authoritative.push({ value: head.value || "", exact: false, nativeHeader: true });

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
    : nativeHeaderMatchesEntity(value, requested.entity);
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
