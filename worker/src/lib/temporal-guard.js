/** Last-word temporal veto. It can remove an upstream approval, never grant
 * one, select a new fact, extrapolate recurrence or rewrite a date. Candidates
 * are the authorized retrieval results, including those the draft ignored.
 */
import { answerSentences } from "./answer-sentences.js";
import { hasExplicitCurrentIntent, parseCanonicalEvidenceDate, queryEntityAnchors, reliableDocumentTime } from "./query-intent.js";
import { isMoneyQuestion } from "./money-veto.js";

const FUTURE = /\b(?:next|upcoming|coming up)\b|\bwhen (?:do|will) (?:i|we) see\b|\bwhen is (?:my|our|the)\b[^?\n]*\b(?:appointment|meeting|call|visit|session|event)\b/i;
const EVENT_NOUN = /\b(?:appointments?|visits?|meetings?|calls?|sessions?|flights?|trips?|deadlines?|due dates?|events?)\b/i;
const PROCEDURAL_STEP = /\bnext\s+(?:steps?|actions?|phases?|stages?|moves?)\b/gi;
const HISTORICAL_SEQUENCE = /\b(?:what|when|which)\s+(?:was|were|did)\b|\b(?:back then|at that time)\b/i;
const EVENT = /\b(?:appointments?|meetings?|calls?|visits?|sessions?|flights?|trips?|deadlines?|events?|see|seeing|scheduled|when|starts?)\b/i;
const HISTORICAL = /\b(?:last (?:recorded|appointment|meeting|visit)|previous|past|has passed|had passed|historical|was on|took place|started|began|since)\b/i;
const UNCERTAIN = /\b(?:cannot|can't|unknown|unconfirmed|not confirmed|not recorded|no upcoming|no future|not enough)\b/i;
const STOPPED = /\b(?:stopped|discontinued|ended|no longer|ceased|terminated)\b/i;
const RESTARTED = /\b(?:restarted|resumed|back on)\b/i;
const CANCELED = /\b(?:cancelled|canceled)\b|\b(?:calendar )?owner declined\b/i;
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE = new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2}))?|${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|today|tomorrow)\\b`, "gi");
const WORDS_TO_IGNORE = new Set(("a an and are as at be been by care current currently days discontinued dr doctor ended for from has have her him i in is it its last medication medications medicine medicines my next no not now of on or our owner patient record recorded records right see she still stopped takes take taking the their these they this to today upcoming use uses using was we were when which who will with you your appointment appointments meeting meetings call calls visit visits session sessions event events date dates restarted resumed back them again").split(" "));
const tokens = value => String(value || "").toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
const words = value => tokens(value).filter(word => word.length > 2 && !WORDS_TO_IGNORE.has(word) && !MONTH_NAMES.includes(word));
const eligible = doc => doc.authority?.eligible !== false && doc.authority?.tier !== "T4" &&
  doc.lineage?.kind !== "agent_derived" && doc.text_reliable === true;
const citedNumbers = text => [...text.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));

// Protect honorifics locally. Changing the shared sentence splitter would
// change non-temporal and money prose, whose byte contract belongs elsewhere.
const sentences = text => answerSentences(String(text || "").replace(/\b(Dr|Mr|Ms|Mrs)\./g, "$1\u0000"))
  .map(sentence => sentence.replaceAll("\u0000", "."));

function ownerDay(now, timeZone) {
  if (!Number.isFinite(now) || typeof timeZone !== "string" || !timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(now));
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch { return null; }
}

function literalDay(raw, { today, timeZone, referenceDays = [] } = {}) {
  if (/^\d{4}-/.test(raw)) {
    const time = parseCanonicalEvidenceDate(raw);
    return time === null ? null : raw.includes("T") ? ownerDay(time, timeZone) : raw;
  }
  if (/^(?:today|tomorrow)$/i.test(raw)) return today
    ? new Date(Date.parse(today) + (/tomorrow/i.test(raw) ? 86400000 : 0)).toISOString().slice(0, 10) : null;
  // Numeric locale dates are ambiguous. Refuse instead of choosing US or EU.
  if (/^\d+[/-]/.test(raw)) return null;
  const parts = raw.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/[.,]/g, "").split(/\s+/);
  const monthIndex = parts.findIndex(part => MONTH_NAMES.includes(part.slice(0, 3).toLowerCase()));
  const month = MONTH_NAMES.indexOf(parts[monthIndex]?.slice(0, 3).toLowerCase()) + 1;
  const day = parts[monthIndex === 0 ? 1 : 0];
  const suffix = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const year = parts.find(part => /^\d{4}$/.test(part));
  // A missing year may only come from a unique, cited event occurrence. Never
  // roll an old recurring appointment into the next year to make it future.
  const matches = [...new Set(referenceDays.filter(value => value?.endsWith(`-${suffix}`)))];
  const value = year ? `${year}-${suffix}` : matches.length === 1 ? matches[0] : null;
  return parseCanonicalEvidenceDate(value) === null ? null : value;
}

function eventOccurrences(doc, context, anchors = []) {
  if (!eligible(doc)) return [];
  const text = `${doc.title || ""}\n${doc.snippet || ""}`;
  const calendar = /^calendar:(?:event_start|all_day_start)$/.test(doc.date_source || "");
  if (calendar && reliableDocumentTime(doc) !== null) {
    if (CANCELED.test(text)) return [];
    // occurred_at carries the real instant when available; ts alone is the
    // citation day, not an email's future appointment or a fabricated instant.
    const occurrence = doc.occurred_at || String(doc.ts || "").slice(0, 10);
    const raw = doc.date_source === "calendar:all_day_start" ? occurrence.slice(0, 10) : occurrence;
    const day = literalDay(raw, context);
    const instant = raw.includes("T") ? parseCanonicalEvidenceDate(raw) : null;
    return day ? [{ day, instant, minute: localMinute(instant, context.timeZone) }] : [];
  }
  // Relative wording in mail belongs to its reliably dated observation, never
  // to the day a later question happens to retrieve it. The storage title
  // prefix is metadata, not an event assertion in the message body.
  const recordTime = reliableDocumentTime(doc);
  const recordContext = { ...context, today: recordTime === null ? null : ownerDay(recordTime, context.timeZone) };
  const body = String(doc.snippet || "").replace(/^\[[^\]\r\n]*\]\s*/, "");
  return sentences(body).filter(sentence => EVENT.test(sentence) && !HISTORICAL.test(sentence) && !CANCELED.test(sentence) &&
    (!anchors.length || anchors.some(anchor => containsPhrase(sentence, anchor))))
    .flatMap(sentence => [...sentence.matchAll(DATE)].filter(match => !observationDate(sentence, match))
      .map(match => {
        const instant = match[0].includes("T") ? parseCanonicalEvidenceDate(match[0]) : null;
        return { day: literalDay(match[0], recordContext), instant,
          minute: instant === null ? clockMinute(sentence) : localMinute(instant, context.timeZone) };
      }))
    .filter(event => event.day);
}

const observationDate = (text, match) => /\b(?:as of|recorded on|updated on|sent on)\s*$/i.test(text.slice(0, match.index));
function localMinute(instant, timeZone) {
  if (instant === null) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(instant);
    return Number(parts.find(part => part.type === "hour").value) * 60 + Number(parts.find(part => part.type === "minute").value);
  } catch { return null; }
}
function clockMinute(text) {
  const match = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2] || 0) > 59) return null;
  return Number(match[1]) % 12 * 60 + Number(match[2] || 0) + (/pm/i.test(match[3]) ? 720 : 0);
}
const before = (a, b) => a.day < b.day || a.day === b.day &&
  (a.instant !== null && b.instant !== null ? a.instant < b.instant :
    a.minute !== null && b.minute !== null && a.minute < b.minute);
const upcoming = (event, { today, timeZone, now }) => event.instant !== null ? event.instant >= now :
  event.day > today || event.day === today && (event.minute === null ||
    event.minute >= localMinute(now, timeZone) + (now % 60000) / 60000);
const clauses = text => sentences(text).flatMap(sentence => sentence.split(/;|\bbut\b|\bhowever\b|\band\s+(?=(?:(?:owner|you|they|she|he)\s+)?(?:stopped|discontinued|ended|no longer|restarted|resumed|(?:is )?back on)\b)/i));
// Purpose and symptom words cannot identify the item a status verb describes.
// Keep this local to the veto rather than changing retrieval tokenization.
const itemWords = text => words(String(text).replace(/\b(?:for|because|to (?:help|treat)|due to)\b[^,;]*/gi, phrase => {
  // A fronted purpose can contain the main clause when punctuation is absent.
  // Keep that clause from its explicit actor/status predicate, not its purpose.
  const main = /\b(?:[a-z][a-z0-9-]*\s+(?:(?:is|are|was|were|has|have|had|been)\s+)*)?(?:stopped|discontinued|ended|no longer|ceased|terminated|restarted|resumed|back on)\b/i.exec(phrase);
  return main ? phrase.slice(main.index) : "";
}))
  .filter(word => !["sleep", "anxiety", "blood", "pressure", "medication", "medicine"].includes(word));
const stoppedSubject = (text, subject) => clauses(text).some(clause => itemWords(clause).includes(subject) &&
  STOPPED.test(clause) && !/\b(?:not|never)\s+(?:stopped|discontinued|ended|terminated)\b/i.test(clause));
const restartedSubject = (text, subject) => {
  // A dated record of a plan is not a dated occurrence. Quoted, conditional
  // or prospective language cannot clear a stop, even with a permissive model.
  if (/["“”]|(?:^|\s)['‘].*['’]/.test(text) || /\b(?:will|would|could|should|may|might|can|if|unless|when|once|until|next|tomorrow|soon|later|plan\w*|intend\w*|expect\w*|hope\w*|hypothetical|example)\b/i.test(text)) return false;
  return clauses(text).some(clause => itemWords(clause).includes(subject) &&
    RESTARTED.test(clause) && /\b(?:restarted|resumed|(?:is|are|am) back on)\b/i.test(clause) &&
    !/\b(?:not|never|\w+n['’]t)\b/i.test(clause) && !STOPPED.test(clause));
};

function entityAnchors(question, sentence, cited, owner) {
  const ownerWords = new Set(tokens(owner));
  const clean = anchor => words(anchor).filter(word => !ownerWords.has(word)).join(" ");
  const seen = [...String(question).matchAll(/\bsee(?:ing)?\s+([a-z][a-z'’.-]*(?:\s+[a-z][a-z'’.-]*){0,3}?)(?=\s+(?:next|again|on|at|for)\b|[?!,;]|$)/gi)]
    .map(match => clean(match[1])).filter(Boolean);
  if (seen.length) return seen;
  const explicit = queryEntityAnchors(question).map(clean).filter(Boolean);
  if (explicit.length) return explicit;
  // Unnamed "see her next" questions can bind through the named answer or its
  // cited event. A generic appointment word or owner name is not an entity.
  const proposed = queryEntityAnchors(sentence).map(clean).filter(Boolean);
  const matched = proposed.filter(anchor => cited.some(doc => containsPhrase(`${doc.title} ${doc.snippet}`, anchor)));
  const inferred = matched.length ? matched : cited.flatMap(doc => queryEntityAnchors(doc.snippet).map(clean).filter(Boolean));
  // An unnamed next-appointment request still compares all appointments. If
  // even the event type is unknown, the caller must refuse the next assertion.
  return inferred.length ? inferred : [EVENT_NOUN.exec(question)?.[0]?.replace(/s$/i, "")].filter(Boolean);
}

function containsPhrase(text, phrase) {
  return ` ${tokens(text).join(" ")} `.includes(` ${tokens(phrase).join(" ")} `);
}

export function applyTemporalVeto({ question, answer, evidenceGate, docs = [], candidates = docs,
  now = Date.now(), timeZone, owner } = {}) {
  const unchanged = { answer, evidenceGate };
  if (!answer || evidenceGate?.supported !== true || isMoneyQuestion(question)) return unchanged;
  const when = /\bwhen (?:do|does|will|is|are|can|should)\b/i.test(question || "");
  // Remove only procedural next-step phrases. A second event request, a
  // possessive week modifier or "who do I see next" retains event intent.
  const eventQuestion = String(question || "").replace(PROCEDURAL_STEP, "");
  const future = !HISTORICAL_SEQUENCE.test(question || "") &&
    (EVENT_NOUN.test(eventQuestion) && (FUTURE.test(eventQuestion) || when) ||
      /\bsee(?:ing)?\b/i.test(eventQuestion) && (FUTURE.test(eventQuestion) || when) ||
      when && FUTURE.test(eventQuestion));
  // Keep ranking and specialized money/status behavior unchanged. Normalize
  // this additional phrase only inside this veto, retaining historical bounds.
  const current = hasExplicitCurrentIntent(String(question || "").replace(/\bthese days\b/gi, "right now"));
  if (!future && !current) return unchanged;
  const veto = reason => ({ answer: null, evidenceGate: {
    ...evidenceGate, supported: false, complete: false, evidence: [], reason,
  }, gap: { type: "temporal_conflict", detail: reason } });
  const today = future ? ownerDay(now, timeZone) : null;
  const context = { today, timeZone, now };
  const mentioned = new Map();
  for (const sentence of sentences(answer)) {
    const cited = docs.filter(doc => citedNumbers(sentence).includes(doc.n) && evidenceGate.evidence?.includes(doc.n));
    if (future) {
      // Historical or uncertain clauses are safe only on their own. A later
      // affirmative clause in the same sentence still has to pass the guard.
      for (const clause of sentence.split(/;|\bbut\b|\bhowever\b/i)) {
        const literalMatches = [...clause.matchAll(DATE)].filter(match => !observationDate(clause, match));
        if (HISTORICAL.test(clause) && !/\b(?:next|upcoming|coming up)\b/i.test(clause)) continue;
        if (!literalMatches.length && UNCERTAIN.test(clause)) continue;
        if (!literalMatches.length && !EVENT.test(clause) && !FUTURE.test(clause)) continue;
        if (!today) return veto("The owner's timezone is missing or invalid; an upcoming event date cannot be checked against today.");
        const anchors = entityAnchors(question, sentence, cited, owner)
          .filter(anchor => cited.some(doc => containsPhrase(`${doc.title} ${doc.snippet}`, anchor)));
        if (!anchors.length) return veto("The upcoming event subject is ambiguous; the retrieved dates cannot establish which occurrence is next.");
        const citedEvents = cited.flatMap(doc => eventOccurrences(doc, context, anchors));
        const referenceDays = citedEvents.map(event => event.day);
        const picked = literalMatches.map(match => literalDay(match[0], { ...context, referenceDays }));
        if (!picked.length || picked.some(day => !day)) return veto("No unambiguous dated upcoming occurrence is established; recurring wording or an ambiguous date cannot prove the next event.");
        if (picked.some(day => day < today)) return veto("The answer presents a past appointment or event as upcoming. An upcoming occurrence has not been established by that date.");
        if (picked.some(day => !referenceDays.includes(day))) return veto("The cited evidence does not establish that dated upcoming occurrence; an old series or a document date cannot supply the next event.");
        const minute = clockMinute(clause);
        const instances = citedEvents.filter(event => event.day === picked[0] && (minute === null || event.minute === minute));
        if (!instances.length || instances.some(event => !upcoming(event, context))) return veto("The cited appointment or event start has passed, or its time is not established as upcoming.");
        const selected = instances.length === 1 ? instances[0] : { day: picked[0], minute, instant: null };
        const earlier = candidates.filter(doc => anchors.some(anchor => containsPhrase(`${doc.title} ${doc.snippet}`, anchor)))
          .flatMap(doc => eventOccurrences(doc, context, anchors)).filter(event => upcoming(event, context) && before(event, selected) &&
            !anchors.some(anchor => mentioned.has(anchor) && !before(event, mentioned.get(anchor).first)));
        if (earlier.length) return veto("An earlier upcoming event for the same named subject appears in the retrieved records; review the dates in order before calling this the next event.");
        if (picked.some((day, index) => index > 0 && day < picked[index - 1])) return veto("Upcoming events are not listed in date order; the soonest occurrence must come first.");
        if (anchors.some(anchor => mentioned.has(anchor) && before(selected, mentioned.get(anchor).last))) return veto("Upcoming events are not listed in date order; the soonest occurrence must come first.");
        for (const anchor of anchors) mentioned.set(anchor, { first: mentioned.get(anchor)?.first || selected,
          last: { ...selected, day: picked.at(-1) } });
      }
    }
    if (current && cited.length) {
      const ownerWords = new Set(tokens(owner));
      const subjects = clauses(sentence).flatMap(itemWords).filter(word => !ownerWords.has(word));
      for (const old of cited) {
        const oldTime = reliableDocumentTime(old);
        if (oldTime === null) continue;
        const shared = subjects.filter(word => clauses(old.snippet).some(clause => itemWords(clause).includes(word)));
        if (!shared.length) continue;
        const newer = candidates.filter(doc => eligible(doc) && reliableDocumentTime(doc) !== null &&
          reliableDocumentTime(doc) <= now && reliableDocumentTime(doc) > oldTime &&
          clauses(doc.snippet).some(span => shared.some(word => itemWords(span).includes(word))));
        if (!newer.length) continue;
        // Co-citing a newer stopped record cannot rescue a positive claim
        // borrowed from the old one. The model's empty conflict list is not
        // evidence that the deterministic newer contradiction disappeared.
        const stopped = shared.some(subject => {
          if (stoppedSubject(sentence, subject)) return false;
          const stops = newer.filter(doc => stoppedSubject(doc.snippet, subject));
          if (!stops.length) return false;
          const latestStop = Math.max(...stops.map(reliableDocumentTime));
          // Only an explicit, later, cited restart for this item resolves the
          // stop. A mention, unrelated restart or future record cannot do so.
          return !cited.some(doc => eligible(doc) && reliableDocumentTime(doc) > latestStop &&
            reliableDocumentTime(doc) <= now && restartedSubject(doc.snippet, subject));
        });
        if (stopped) return veto("A newer record says the cited item stopped, was discontinued or ended; older evidence may be superseded and cannot establish current use.");
        // Preserve the existing owner-confirmed operative-value contract when
        // every newer mention repeats its exact value. Agreement is not a
        // supersession, and this does not bypass a newer stopped-item check.
        const operative = old.authority?.owner_confirmed && old.authority?.operative_section?.value;
        if (operative && newer.every(doc => containsPhrase(doc.snippet, operative))) continue;
        if (!newer.some(doc => cited.some(item => item.n === doc.n))) return veto("A newer record about the same subject may supersede the older cited status; current status requires review of that newer evidence.");
      }
    }
  }
  return unchanged;
}
