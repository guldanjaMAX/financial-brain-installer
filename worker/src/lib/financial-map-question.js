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
    // The perfect-tense form owners reach for when asking about the past:
    // "which businesses have I dissolved", "what companies had we closed".
    `\\b${SUBJECT}\\b[^?\\n]{0,30}?\\b(?:have|had)\\s+(?:i|we)\\b`,
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
  /\bhow\s+much\b|\bwhen\s+(?:did|do|does|will|should|was|were|can|is|are|am)\b|\bhow\s+do\s+i\b|\bhow\s+should\b|\bshould\s+i\b|\bcan\s+i\b|\bwhat\s+did\s+(?:i|we)\s+pay\b|\bpaid\b|\bpayments?\b|\binvoices?\b|\breceipts?\b|\bbalances?\b|\btransactions?\b|\bdeposits?\b|\bwithdrawals?\b|\bstatements?\b|\brouting\s+number\b|\bpassword\b|\bwhat\s+(?:do|should)\s+(?:i|we)\s+do\b|\bwhat\s+happens\s+(?:now|next)\b/i;

/* The subject noun modifying a different noun: "my business address" is not a
   question about the business. */
const SUBJECT_MODIFIES_ANOTHER_NOUN = new RegExp(
  `\\b${SUBJECT}\\s+(?:address(?:es)?|names?|numbers?|cards?|emails?|phones?|websites?|logos?|hours|plans?|models?|managers?|partners?|bankers?|types?|ids?|slugs?)\\b`,
  "i",
);

/* "Account" is the one genuinely overloaded noun in SUBJECT. The map's
   accounts are an entity's FINANCIAL accounts — the ledger's account kinds are
   checking, savings, CD, HSA, card, loan, line of credit, investment,
   retirement, merchant, point of sale and escrow. Every other sense of the word belongs to
   a different question: the accounting senses (accounts payable, accounts
   receivable, a chart of accounts, expense and revenue accounts), the
   relationship senses (a vendor or customer account), and the login senses (a
   user, email or software account). Asked any of those, an owner wants their
   books or their logins, and financial-map copy above the answer would be the
   product's worst face. A qualifier on either side settles it. */
const ACCOUNT_IN_ANOTHER_SENSE =
  /\baccounts?\s+(?:payable|receivable|payables?|receivables?)\b|\bchart\s+of\s+accounts\b|\b(?:expense|revenue|income|asset|liability|equity|ledger|gl|general\s+ledger|contra|suspense|clearing|login|log-?in|sign-?in|user|admin|email|e-?mail|software|app|saas|cloud|portal|subscription|streaming|service|utility|utilities|vendor|supplier|customer|client|social(?:\s+media)?|online|advertising|ad)\s+accounts?\b/i;

/* A status question has to ASK. "my company closed last year" and "my LLC is
   dissolved" are the owner TELLING the brain a status they already know, and
   answering them with "your financial map isn't set up, so your Brain can't
   say which entities are open or closed" is both useless and faintly insulting.
   A question mark, a wh-word, an imperative, or a leading auxiliary is what
   separates the two; every genuine phrasing of the flagship question has one. */
const ASKS_SOMETHING =
  /\?|\b(?:which|what|whose|who|how\s+many|list|name|show|tell|give)\b|^\s*(?:is|are|was|were|do|does|did|am|can|has|have|any)\b/i;

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
  if (!ASKS_SOMETHING.test(q)) return false;
  if (ORDINARY_QUESTION.test(q)) return false;
  if (ACCOUNT_IN_ANOTHER_SENSE.test(q)) return false;
  if (SUBJECT_MODIFIES_ANOTHER_NOUN.test(q)) return false;
  if (!OWNER_HELD_SUBJECT.test(q)) return false;
  return STATUS_TERM.test(q) || INVENTORY_ASK.test(q);
}

/** The map states this guidance is for. `current` is answered from the map
    itself and is deliberately not handled here. */
const GUIDED_STATES = new Set(["not_established", "stale"]);

/**
 * The owner-facing copy, set by leadership. Literals per map state.
 *
 * `one_step` is deliberately NOT the map read's `next_step`. That field
 * ("Offer a guided owner interview, one short question at a time, then create
 * a complete preview") is an instruction to a technician about what to do for
 * the owner; it reads as nonsense to the owner themselves. It stays on the
 * `brain_financial_map` read for the technician surface and must never reach
 * `map_guidance`.
 *
 * Two messages per state. A refusal can say the map is not set up as the
 * reason there is no answer. Beside an answer the documents DID support,
 * the same sentence would contradict what the owner is reading, so the
 * supported variant understates instead: the answer stands, and the map is
 * named as the thing that would make it authoritative.
 */
const MESSAGES = Object.freeze({
  not_established: Object.freeze({
    unsupported:
      "Your financial map isn't set up yet, so your Brain can't say which entities are open or closed.",
    supported:
      "This comes from your documents, not from a financial map you confirmed — your map isn't set up yet.",
    one_step:
      "Open Financial Map in your private owner app and answer its short questions, one at a time — which businesses you own or have owned, and whether each one is still open — then save the map it builds. From then on your Financial Map shows every entity with its status.",
    // Appended ONLY when at least one candidate is listed below it, so the
    // sentence never points at a list that is not there. Set under the
    // not-established wording deliberately: it says the QUESTIONS start from
    // what the Brain has seen, and only the not-established one_step has
    // questions in it. A stale map's one step is "review what changed".
    candidates_follow:
      " The questions start from what your Brain has already seen, listed below as possible mentions.",
  }),
  // A stale map was activated once and its inventory has changed since. Reading
  // the old snapshot as current fact is the exact error the map's own
  // currentness check exists to prevent, so a stale map gets guidance too.
  stale: Object.freeze({
    unsupported:
      "Your financial map is out of date: an entity or account was added or changed after you set it up, so your Brain won't answer this from the old map.",
    supported:
      "This comes from your documents, not from a financial map you confirmed — your map is out of date.",
    one_step:
      "Open Financial Map in your private owner app, review what changed, and save the updated map. Then your Financial Map shows every entity with its current status.",
  }),
});

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
    // The literal, never the row's own value. This is THIS module's invariant,
    // not a field to relay: a row arriving with candidate_state "confirmed"
    // would render as "(confirmed)" directly underneath a notice saying nothing
    // here is confirmed. The map's inventory hardcodes "possible_mention" today
    // (owner-financial-map.js publicInventory), and if that ever changes, this
    // surface must not inherit the change silently.
    candidate_state: "possible_mention",
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
 *
 * `answerSupported` is the evidence gate's verdict. When the documents DID
 * support an answer, the guidance carries no candidate list at all: the answer
 * beside it already cites real documents, and a list of unconfirmed names in
 * the same block invites reading the two together as one finding.
 */
export function financialMapGuidance(state, { answerSupported = false } = {}) {
  const status = String(state?.map_status || "");
  if (!GUIDED_STATES.has(status)) return null;
  const copy = MESSAGES[status];
  if (answerSupported) {
    return { map_status: status, message: copy.supported, one_step: copy.one_step };
  }
  const inventory = state?.current_inventory || {};
  const entities = candidateList(inventory.entities);
  const accounts = candidateList(inventory.accounts);
  const anyListed = entities.length > 0 || accounts.length > 0;
  return {
    map_status: status,
    message: copy.unsupported,
    one_step: anyListed && copy.candidates_follow
      ? `${copy.one_step}${copy.candidates_follow}`
      : copy.one_step,
    what_the_brain_sees: {
      candidate_notice: CANDIDATE_NOTICE,
      entities,
      accounts,
      entities_not_listed: omittedCount(inventory.entities),
      accounts_not_listed: omittedCount(inventory.accounts),
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
  const lines = [String(guidance.message || "")];
  if (guidance.one_step) lines.push(`One step: ${guidance.one_step}`);
  // Absent beside a supported answer, on purpose. Nothing to say about
  // candidates there, and no empty-list sentence either.
  const seen = guidance.what_the_brain_sees;
  if (!seen || typeof seen !== "object") return lines;

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
