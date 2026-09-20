/**
 * financial-map-question — the question a client judges this product by, and
 * the honest answer when the owner's financial map is not set up yet.
 *
 * "Which of my entities are still open and which are closed?" is the most
 * fundamental question an owner asks a financial brain. The documents cannot
 * answer it: formation paperwork and state filing forms say an entity once
 * existed, never what its status is today. The evidence gate is right to
 * refuse them, and the refusal is honest — but on its own it is useless,
 * because the product already holds the structure built for exactly this
 * question. The owner financial map knows whether it has been activated, and
 * the ledger inventory beside it knows which entities and accounts the brain
 * has seen at all.
 *
 * So a refusal on this one shape of question gets a second sentence: the map
 * is not set up, here is what the brain HAS seen but has not confirmed, and
 * here is the one step that fixes it. Nothing here answers the question. It
 * says why the question cannot be answered yet and what to do about it.
 *
 * THE RULE THIS MODULE MUST NEVER BREAK: a candidate is never a fact. Every
 * row the map's inventory carries is a `possible_mention` — a name that turned
 * up in the structured ledger, not an entity the owner has confirmed exists,
 * and never a status. A dissolution filing is a hint the owner confirms, not a
 * closed entity. The guidance carries labels and candidate states only: no
 * balance, no mask, no ownership percentage, no tax class, no assertion about
 * whether anything is open or closed.
 *
 * Precision over recall in the detector, deliberately. A false negative costs
 * nothing — the response is exactly what it is today. A false positive puts
 * financial-map copy under an ordinary question, which is the product's worst
 * face. Every rule below is written to stay silent when unsure.
 */

/* The nouns the owner financial map is actually about. "corp" and "inc" are
   deliberately absent: they are name suffixes far more often than subjects. */
const SUBJECT = "(?:entit(?:y|ies)|llcs?|l\\.l\\.c\\.?|pllcs?|corporations?|compan(?:y|ies)|business(?:es)?|accounts?)";

/* The subject has to be the OWNER's, not any company mentioned in passing.
   "my entities", "our two LLCs", "what accounts do I have", "companies I own". */
const OWNER_HELD_SUBJECT = new RegExp(
  [
    `\\b(?:my|our)\\s+(?:[a-z][a-z'-]*\\s+){0,2}?${SUBJECT}\\b`,
    `\\b${SUBJECT}\\b[^?\\n]{0,40}?\\b(?:do|did|does)\\s+(?:i|we)\\s+(?:still\\s+)?(?:have|own|hold)\\b`,
    `\\b${SUBJECT}\\b[^?\\n]{0,20}?\\b(?:i|we)\\s+(?:still\\s+)?(?:own|hold)\\b`,
  ].join("|"),
  "i",
);

/* A status word about that subject. "close" as a bare verb is left out; it
   belongs to "close the books" at least as often as to closing a company. */
const STATUS_TERM =
  /\b(?:open|opened|closed|closing|active|inactive|dissolved|dissolution|dissolving|terminated|shuttered|defunct|status(?:es)?|shut\s+down|wound\s+(?:up|down)|winding\s+(?:up|down)|in\s+good\s+standing|still\s+(?:around|going|operating|running|open|active|alive|in\s+business))\b/i;

/* The inventory half of the same question: "which ... do I have", and the
   same question phrased as a relative clause, "which entities I still own". */
const INVENTORY_ASK =
  /\b(?:which|what|whose|how\s+many|list|name|show\s+me|tell\s+me)\b[^?\n]{0,60}?\b(?:(?:do|did|does)\s+(?:i|we)\s+(?:still\s+)?(?:have|own|hold)|(?:i|we)\s+(?:still\s+(?:have|own|hold)|own|hold))\b/i;

/* Shapes that use the same nouns for something else entirely. Each one of
   these has been the difference between a status question and an ordinary
   one in the wording owners actually use. */
const ORDINARY_QUESTION =
  /\bhow\s+much\b|\bwhen\s+(?:did|do|does|will|should|was|were|can|is|are|am)\b|\bhow\s+do\s+i\b|\bhow\s+should\b|\bshould\s+i\b|\bcan\s+i\b|\bwhat\s+did\s+(?:i|we)\s+pay\b|\bpaid\b|\bpayments?\b|\binvoices?\b|\breceipts?\b|\bbalances?\b|\btransactions?\b|\bdeposits?\b|\bwithdrawals?\b|\bstatements?\b|\brouting\s+number\b|\bpassword\b/i;

/* The subject noun modifying a different noun: "my business address" is not a
   question about the business. */
const SUBJECT_MODIFIES_ANOTHER_NOUN = new RegExp(
  `\\b${SUBJECT}\\s+(?:address(?:es)?|names?|numbers?|cards?|emails?|phones?|websites?|logos?|hours|plans?|models?|managers?|partners?|bankers?|types?|ids?|slugs?)\\b`,
  "i",
);

/* A question longer than this is not a crisp status question, and an unbounded
   input is not worth the backtracking. Staying silent here costs nothing. */
const MAX_QUESTION_CHARS = 500;

/**
 * Does this question ask which of the owner's entities or accounts exist, and
 * which are open or closed?
 *
 * Deterministic and offline: no model, no retrieval, no database. It decides
 * only whether the map state is worth reading beside the ordinary answer.
 */
export function hasFinancialMapStatusIntent(query) {
  const q = String(query || "").trim();
  if (!q || q.length > MAX_QUESTION_CHARS) return false;
  if (ORDINARY_QUESTION.test(q)) return false;
  if (SUBJECT_MODIFIES_ANOTHER_NOUN.test(q)) return false;
  if (!OWNER_HELD_SUBJECT.test(q)) return false;
  return STATUS_TERM.test(q) || INVENTORY_ASK.test(q);
}

/** The map states this guidance is for. `current` is answered from the map
    itself and is deliberately not handled here. */
const GUIDED_STATES = new Set(["not_established", "stale"]);

const MESSAGE = Object.freeze({
  not_established:
    "Your financial map isn't set up yet, so your Brain can't say which entities are open or closed.",
  // A stale map was activated once and its inventory has changed since. Reading
  // the old snapshot as current fact is the exact error the map's own
  // currentness check exists to prevent, so a stale map gets guidance too.
  stale:
    "Your financial map was set up, but your entity or account inventory changed afterwards, so your Brain can't read it as a current answer about which entities are open or closed.",
});

const WHERE = "Financial Map in your private owner app is where that happens.";

/* The words that keep a candidate a candidate wherever this is rendered. */
export const CANDIDATE_NOTICE =
  "These are possible mentions your Brain has seen — not confirmed facts, and not a list of your entities until you confirm each one.";

/* Enough to show the owner what the brain sees without turning a refusal into
   a wall of names. The map's own read is the complete list. */
const MAX_LISTED = 25;

/**
 * Labels and candidate states only.
 *
 * The inventory rows carry a `fields` object holding kind, status, ownership
 * basis points, tax class and account assignment. None of that belongs in an
 * answer surface: it is ledger content, and printing a row's `status` field
 * beside a question about status is exactly how an unconfirmed candidate
 * becomes a stated fact.
 */
function candidateList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_LISTED).map((row) => ({
    label: String(row?.label ?? "").slice(0, 160),
    candidate_state: String(row?.candidate_state ?? "possible_mention"),
  }));
}

function omittedCount(rows) {
  return Array.isArray(rows) && rows.length > MAX_LISTED ? rows.length - MAX_LISTED : 0;
}

/**
 * Build the `map_guidance` field from an owner financial map read body.
 *
 * Returns null for a `current` map and for anything unrecognisable, so the
 * caller's response is unchanged whenever this cannot speak with certainty.
 */
export function financialMapGuidance(state) {
  const status = String(state?.map_status || "");
  if (!GUIDED_STATES.has(status)) return null;
  const inventory = state?.current_inventory || {};
  const entities = inventory.entities;
  const accounts = inventory.accounts;
  const nextStep = String(state?.next_step || "").trim();
  return {
    map_status: status,
    message: MESSAGE[status],
    one_step: nextStep ? `${nextStep} ${WHERE}` : WHERE,
    what_the_brain_sees: {
      candidate_notice: CANDIDATE_NOTICE,
      entities: candidateList(entities),
      accounts: candidateList(accounts),
      entities_not_listed: omittedCount(entities),
      accounts_not_listed: omittedCount(accounts),
      unconfirmed: true,
    },
  };
}

/**
 * The same guidance as the sentences a person reads.
 *
 * Shared by every answer surface so the "unconfirmed" flag cannot be dropped
 * by one renderer and kept by another.
 */
export function financialMapGuidanceLines(guidance) {
  if (!guidance || typeof guidance !== "object") return [];
  const seen = guidance.what_the_brain_sees || {};
  const lines = [String(guidance.message || "")];
  if (guidance.one_step) lines.push(`One step: ${guidance.one_step}`);

  const render = (rows, noun) => {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    return `${noun}: ${list.map((row) => `${row.label} (${row.candidate_state})`).join(", ")}`;
  };
  const entities = render(seen.entities, "Entities");
  const accounts = render(seen.accounts, "Accounts");
  if (entities || accounts) {
    lines.push("", String(seen.candidate_notice || CANDIDATE_NOTICE));
    if (entities) lines.push(entities);
    if (accounts) lines.push(accounts);
    const omitted = Number(seen.entities_not_listed || 0) + Number(seen.accounts_not_listed || 0);
    if (omitted > 0) lines.push(`${omitted} more possible mentions are not listed here.`);
  } else {
    lines.push("", "Your Brain has no confirmed entities or accounts on file, and none to propose yet.");
  }
  return lines;
}
