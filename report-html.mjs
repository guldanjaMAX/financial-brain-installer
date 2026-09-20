/**
 * report-html: the one file we hand a client.
 *
 *   brain test <manifest> --report brain-report.html
 *
 * This is four things at once, which is why it gets the care it gets.
 *
 *   As a CHECK RECORD it reports the automated results without pretending to
 *   replace the separate same-item receipt/evidence proof. Optional saved owner
 *   questions add regression evidence when present; they are not onboarding
 *   homework.
 *
 *   As a KICKOFF it replaces the terminal. The client opens a browser and sees
 *   what was proved, what remains unknown, and any optional questions they
 *   chose to save.
 *
 *   As an ACCEPTANCE DELIVERABLE it is the record of what was true on handoff
 *   day, including what was missing.
 *
 *   As the ANSWER TO "is it installed yet" it is proof they can re-run
 *   themselves, forever, after our token is revoked.
 *
 * Constraints that follow from that last sentence, and are not negotiable:
 *
 *   ONE FILE. No CDN, no webfont, no image host, no script. It has to open
 *   from a thumb drive, on a plane, in five years, on a machine that has never
 *   heard of us. Everything here is inline and static.
 *
 *   EVERY INTERPOLATION IS REDACTED THEN ESCAPED. The content is the client's
 *   own documents, which means it is untrusted input to this renderer. A
 *   document titled with a script tag must render as text, and a document that
 *   somehow carries an API key must not put it in a file that then gets
 *   emailed around. The ingest gate is the first defense and this is the
 *   second, implemented separately on purpose: two independent checks fail
 *   independently, one shared helper fails once for both.
 *
 * The rendering half is pure and synchronous so it can be tested without a
 * live install. Collection is separate and does the network.
 */

import { Acceptance } from "./acceptance.mjs";
import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";
import { renderCliCommands } from "./operations/cli-guidance.mjs";
import {
  collectSourceInventorySnapshot,
  corpusReportCounts,
  sourceReceiptSummary,
} from "./report.mjs";

/* ------------------------------------------------------------- escaping */

/**
 * The single quote matters as much as the double: an attribute written with
 * single quotes is just as breakable, and a renderer that is only safe when
 * you remember which quote style you used is not safe.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Credential shapes, deliberately duplicated rather than imported from the
 * worker's ingest gate. See the header: independent defenses.
 *
 * Only .replace() is used with these. A global regex carries lastIndex between
 * calls, so .test() on one of these would pass every other time, which is the
 * bug that already bit the scanner port once.
 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "openai key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, "api key"],
  [/\bcfut_[A-Za-z0-9_-]{20,}/g, "cloudflare token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "aws key id"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google api key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "slack token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "github token"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "stripe key"],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g, "resend key"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "signed token"],
  [/\b(?:bearer|authorization:)\s+[A-Za-z0-9._-]{20,}/gi, "bearer token"],
  [
    /\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9._+/-]{16,}["']?/gi,
    "secret",
  ],
];

/**
 * Replace anything credential-shaped with a label naming the kind.
 *
 * Naming the kind rather than dropping it silently is the point: the reader
 * needs to know a secret is sitting in that document so they can go remove it
 * from the source, and they cannot act on a blank.
 */
export function redactSecrets(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  for (const [re, label] of SECRET_PATTERNS) text = text.replace(re, `[redacted ${label}]`);
  return text;
}

/** Every piece of data that reaches the page goes through this. No exceptions. */
const h = (value) => escapeHtml(redactSecrets(value));

/* -------------------------------------------------------------- helpers */

const num = (n) => Number(n || 0).toLocaleString("en-US");
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

function isoDay(value) {
  if (!value) return "";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return String(value).slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

function longDate(value) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const arr = (v) => (Array.isArray(v) ? v : []);

/** Our words for a corpus are not the client's words for their own files. */
const FRIENDLY = {
  drive_file: "Documents and files",
  drive_chunk: "Documents and files",
  message: "Messages and email",
  meeting: "Meeting transcripts",
  curated: "Notes and lessons",
  lead: "Contacts",
  email_track: "Tracked emails",
  calendar_event: "Calendar events",
  custom: "Other documents",
};

const CORPUS_LABEL = {
  google_drive: "Google Drive",
  gmail: "Gmail",
  calendar: "Google Calendar",
  slack: "Slack",
  notion: "Notion",
  upload: "Manual uploads",
};

const TIER_NAMES = {
  1: "Reachable and access controlled",
  2: "Data present and current",
  3: "Optional owner-question checks",
  4: "Credential protection active",
  5: "Version and configuration",
};

/** Why a business owner should care that this tier is green. */
const TIER_WHY = {
  1: "If this fails the brain is either down or, worse, answering without a key, which would make your records public.",
  2: "An empty or stale brain does not warn you. It answers from old information and sounds just as sure.",
  3: "Saved owner questions run here when present. Before handoff, one real item is proved separately through receipts, provenance, projection, and cited retrieval.",
  4: "Anything shaped like a password or an API key is refused at the door instead of being stored and later quoted back.",
  5: "The install is on the version we shipped, and a daily ceiling means a runaway process cannot become a surprise bill.",
};

/**
 * A refusal is the brain saying it does not know. That is the product working,
 * not failing, and the report has to tell the two apart or the honest answer
 * gets counted as a miss.
 */
// The adverb slot is the part that was missing. Every refusal sampled from the
// live brain used "the documents do not contain ...", which the original
// pattern caught, but the model also writes "do not ACTUALLY answer" and "do
// not DIRECTLY address", and an adverb between the negation and the verb made
// those read as confident answers. One optional word closes it.
//
// Widened only as far as observed output justifies. Every phrasing here was
// either sampled from this brain or seen in this session; none was invented,
// because a refusal detector tuned to imagined language mislabels real language.
// Anchored to the SUBJECT, because the verb alone is ambiguous. "Alex Rivera
// does not answer the phone on weekends [4]" is a real cited answer, and the
// earlier unanchored pattern read it as the brain refusing. A refusal is
// always ABOUT the sources, so the sources have to be the thing doing the
// not-containing.
const REFUSAL_SUBJECTED =
  /\b(documents?|sources?|records?|files?|notes?|transcripts?|materials?|brain|context)\b[^.!?]{0,40}?\bdo(es)? not (?:\w+ly )?(contain|answer|address|specify|mention|state|say|indicate)\b/i;

// Phrasings that need no subject because nothing else says them.
const REFUSAL_STANDALONE =
  /\b(there (?:is|are) no (?:information|record|mention|details?|evidence)|nothing (?:recorded|found|on this)|cannot be answered|not (?:enough|sufficient) (?:information|detail)|i (?:do not|don't) have (?:enough )?(?:information|any record))\b/i;

/**
 * A refusal cites nothing, because it makes no claim to support. So an answer
 * carrying [n] markers is an answer even when it contains hedging language,
 * which is the cheapest and most reliable discriminator available.
 */
const REFUSAL = {
  test(s) {
    const text = String(s || "");
    if (/\[\d+\]/.test(text)) return false;
    return REFUSAL_SUBJECTED.test(text) || REFUSAL_STANDALONE.test(text);
  },
};

const SEARCH_UNAVAILABLE_STATES = new Set([
  "search_unavailable", "unavailable", "failed", "failure", "error", "degraded",
]);
const COVERAGE_INCOMPLETE_STATES = new Set([
  "coverage_incomplete", "incomplete", "partial", "unknown", "unavailable",
]);
const COVERAGE_GAP_TYPES = new Set([
  "coverage_unavailable", "coverage_incomplete", "coverage_stale",
  "history_unproven", "source_unregistered", "sync_broken", "sync_review",
  "sync_in_progress", "never_synced", "tax_evidence_unreadable",
  "tax_document_inventory_unverified", "tax_question_scope_unresolved",
]);

const statusToken = (value) => String(value ?? "").trim().toLowerCase();

function carriesIncompleteCoverage(a) {
  if (arr(a?.gaps).some((gap) => COVERAGE_GAP_TYPES.has(statusToken(gap?.type)))) return true;
  const direct = statusToken(
    a?.coverage_state ?? a?.coverage?.state ?? a?.source_coverage?.state ??
    a?.coverage?.status ?? a?.source_coverage?.status
  );
  return Boolean(direct) && COVERAGE_INCOMPLETE_STATES.has(direct);
}

/** Normalize version-skewed search truth before looking at result counts. */
export function normalizedSearchStatus(a) {
  const raw = statusToken(a?.search_status ?? a?.status);
  if (raw === "coverage_incomplete") return "coverage_incomplete";
  if (SEARCH_UNAVAILABLE_STATES.has(raw)) return "search_unavailable";
  if (carriesIncompleteCoverage(a)) return "coverage_incomplete";
  if (a?.degraded !== null && a?.degraded !== undefined && a?.degraded !== false &&
      String(a.degraded).trim()) {
    return "degraded";
  }
  if (raw === "no_results" || raw === "no_match" || raw === "complete" || raw === "ok") {
    return raw === "no_match" ? "no_results" : raw;
  }
  return raw || null;
}

export function classifyAnswer(a) {
  if (!a || typeof a !== "object") return "error";
  if (a.error) return "error";
  const searchStatus = normalizedSearchStatus(a);
  if (searchStatus === "search_unavailable") return "search_unavailable";
  if (searchStatus === "coverage_incomplete") return "coverage_incomplete";
  const count = Number(
    a.resultCount ?? a.results_count ?? (Array.isArray(a.results) ? a.results.length : 0)
  );
  const cites = arr(a.citations).length;
  if (!count && !cites) {
    // A successful response with no failure, degradation, or coverage warning
    // is a result only about the indexed material that search actually read.
    // It is never a world-level or intended-corpus absence claim.
    if (searchStatus === "degraded") return "search_unavailable";
    return searchStatus && searchStatus !== "no_results" ? "unknown" : "no_match";
  }
  if (!a.answer) return "unavailable";
  if (REFUSAL.test(String(a.answer))) return "refused";
  if (searchStatus === "degraded") return "answered_degraded";
  return "answered";
}

const STATUS_COPY = {
  answered: ["pass", "Answered from your own documents"],
  answered_degraded: ["warn", "Answered from a partial search"],
  refused: ["warn", "The brain said it does not know"],
  no_match: ["warn", "No indexed match in the searched material"],
  search_unavailable: ["fail", "Search could not be completed"],
  coverage_incomplete: ["warn", "Coverage remains unproven"],
  unavailable: ["warn", "Sources found, answer could not be generated"],
  unknown: ["warn", "Search result remains unproven"],
  error: ["fail", "This check could not run"],
};

/* -------------------------------------------------------------- verdict */

export function computeVerdict({ acceptance, acceptanceError, seeds }) {
  const counts = acceptance?.counts || null;
  const kinds = seeds.map((seed) => classifyAnswer(seed));
  const answered = kinds.filter((kind) => ["answered", "answered_degraded"].includes(kind)).length;
  const fullyAnswered = kinds.filter((kind) => kind === "answered").length;

  const parts = [];
  if (counts) {
    const total = counts.pass + counts.fail + counts.warn + counts.skip;
    parts.push(`${counts.pass} of ${total} checks passed.`);
  }
  if (seeds.length) {
    parts.push(
      `${answered} of ${seeds.length} of your questions ${plural(seeds.length, "was", "were")} answered from your own documents.`
    );
  }

  // An incomplete run can never read as green, whatever the tiers that did
  // finish happened to say.
  if (acceptanceError) {
    return {
      state: counts && counts.fail > 0 ? "blocked" : "attention",
      line: "The verification run did not finish, so this report cannot confirm the install is working.",
      detail: `It stopped with: ${acceptanceError}. ${parts.join(" ")}`.trim(),
    };
  }
  if (!acceptance) {
    return {
      state: "unknown",
      line: "The verification checks were not run, so this report cannot tell you whether the brain is working.",
      detail: parts.join(" "),
    };
  }
  if (acceptance.stoppedAtTier === 1) {
    // Down and wide open are both tier 1 failures and they could not be more
    // different to the person reading this. One is an outage. The other is
    // their private records being served to anyone who asks.
    const broken = arr(acceptance.results).filter((r) => r.tier === 1 && r.status === "fail");
    const unreachable = broken.some((r) => /health/i.test(r.name));
    const openDoor = broken.some((r) => /unauthenticated|wrong key/i.test(r.name));
    return {
      state: "blocked",
      line: unreachable
        ? "Not ready. The brain did not respond at all."
        : openDoor
          ? "Not ready. The brain is answering without a key, so anyone who finds the address can read it."
          : "Not ready. The install failed the first checks.",
      detail: "Everything after this was skipped on purpose. Until it is fixed, the later results would be noise rather than signal.",
    };
  }
  if (counts.fail > 0) {
    return {
      state: "blocked",
      line: `Not ready. ${counts.fail} ${plural(counts.fail, "check", "checks")} failed.`,
      detail: parts.join(" "),
    };
  }
  if (seeds.length && answered === 0) {
    return {
      state: "attention",
      line: "The checks pass, but none of your questions came back with an answer from your documents yet.",
      detail: parts.join(" "),
    };
  }
  // Preserve the honesty of older summaries that used "retrieval" to mean an
  // entire unproven capability. Current runs use "optional_owner_questions"
  // for an empty saved-question list, which is not a handoff blocker.
  if (Array.isArray(acceptance.untested) && acceptance.untested.includes("retrieval")) {
    return {
      state: "attention",
      line: "The automated checks passed, but this older result has no query-visible retrieval proof.",
      detail:
        `${parts.join(" ")} Prove one approved low-sensitivity item as accepted, stored with provenance, ` +
        "projected, and query-visible with a citation before handoff.".trim(),
    };
  }
  if (counts.warn > 0 || fullyAnswered < seeds.length) {
    const n = counts.warn + (seeds.length - fullyAnswered);
    return {
      state: "attention",
      line: `Working, with ${n} ${plural(n, "thing", "things")} worth knowing about.`,
      detail: parts.join(" "),
    };
  }
  return {
    state: "ready",
    line: "Ready for adaptive acceptance. The automated checks passed.",
    detail: parts.join(" "),
  };
}

const VERDICT_WORD = {
  ready: "READY",
  attention: "WORKING",
  blocked: "NOT READY",
  unknown: "NOT VERIFIED",
};

/* ------------------------------------------------------- answer rendering */

const withCitationMarkers = (escaped) =>
  escaped.replace(/\[(\d{1,2})\]/g, '<sup class="cite">$1</sup>');

/**
 * The answer arrives as loose text from an LLM. Escape first, then add the
 * only markup we introduce, so nothing in the source text can become a tag.
 */
function renderAnswerBody(raw) {
  const text = redactSecrets(raw).replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const BULLET = /^([-*•]|\d+[.)])\s+/;
  const out = [];

  for (const block of text.split(/\n{2,}/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    // A model answering "what did we promise" usually writes a lead-in line
    // and then bullets, in one block. Treating the block as all-or-nothing
    // printed the dashes as literal text, so runs are grouped instead.
    let prose = [];
    let bullets = [];

    const flushProse = () => {
      if (!prose.length) return;
      const body = withCitationMarkers(escapeHtml(prose.join("\n")).replace(/\n/g, "<br>"));
      // The worker asks for a trailing "Heads up:" line only when a real gap
      // affects trust in the answer above it. That earns its own styling.
      out.push(/^heads up:/i.test(prose[0]) ? `<p class="headsup">${body}</p>` : `<p>${body}</p>`);
      prose = [];
    };
    const flushBullets = () => {
      if (!bullets.length) return;
      const ordered = bullets.every((l) => /^\d+[.)]\s+/.test(l));
      const items = bullets
        .map((l) => `<li>${withCitationMarkers(escapeHtml(l.replace(BULLET, "")))}</li>`)
        .join("");
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} class="answer-list">${items}</${tag}>`);
      bullets = [];
    };

    for (const line of lines) {
      if (BULLET.test(line)) {
        flushProse();
        bullets.push(line);
      } else {
        flushBullets();
        prose.push(line);
      }
    }
    flushProse();
    flushBullets();
  }
  return out.join("");
}

function renderCitations(citations) {
  const list = arr(citations);
  if (!list.length) return "";
  const items = list
    .map((c) => {
      const day = isoDay(c.ts);
      const date = day
        ? c.date_reliable === true ? day : `possible date ${day}`
        : null;
      const text = c.text_source === "ocr_partial"
        ? "OCR text may be incomplete"
        : c.text_source === "ocr"
          ? "OCR text, verify key details"
          : c.text_reliable === false
            ? "text may be incomplete"
            : null;
      const meta = [c.source, date, text].filter(Boolean).join(", ");
      const ref = c.ref ? `<span class="cite-ref">${h(c.ref)}</span>` : "";
      return (
        `<li><span class="cite-n">${h(c.n)}</span>` +
        `<span class="cite-body"><span class="cite-title">${h(c.title || "untitled")}</span>` +
        (meta ? `<span class="cite-meta">${h(meta)}</span>` : "") +
        ref +
        `</span></li>`
      );
    })
    .join("");
  return `<div class="cites"><p class="cites-head">Sources</p><ol class="cite-list">${items}</ol></div>`;
}

function renderQuestionCard(seed, index) {
  const kind = classifyAnswer(seed);
  const [tone, label] = STATUS_COPY[kind];
  const question = seed?.question ?? seed?.q ?? "";

  let body;
  if (kind === "error") {
    body = `<p class="muted">${h(seed.error || "the request did not complete")}</p>`;
  } else if (kind === "search_unavailable") {
    body = `<p class="muted">${h(seed.notice || "The search did not complete, so this result says nothing about whether the Brain holds an answer.")}</p>`;
  } else if (kind === "coverage_incomplete") {
    body = `<p class="muted">${h(seed.notice || "The search ran, but source coverage is incomplete or unknown. Treat this result as provisional.")}</p>`;
  } else if (kind === "no_match") {
    body = `<p class="muted">The completed search found no indexed match in the material it searched. This does not prove the information does not exist elsewhere or that every intended source is complete.</p>`;
  } else if (kind === "unavailable") {
    body =
      `<p class="muted">Sources were found, but no written answer was produced` +
      (seed.answer_error ? `: ${h(seed.answer_error)}` : ".") +
      `</p>`;
  } else if (kind === "unknown") {
    body = `<p class="muted">The response did not carry enough search-status evidence to classify this as a completed no-match.</p>`;
  } else {
    body = renderAnswerBody(seed.answer) +
      (kind === "answered_degraded"
        ? `<p class="headsup">${h(seed.notice || "Part of search was degraded. Read the cited answer as partial, not complete coverage.")}</p>`
        : "");
  }

  return (
    `<article class="qa">` +
    `<div class="qa-head"><span class="qa-n">${index + 1}</span>` +
    `<h3 class="qa-q">${h(question)}</h3></div>` +
    `<span class="pill pill-${tone}">${h(label)}</span>` +
    `<div class="qa-a">${body}</div>` +
    renderCitations(seed?.citations) +
    `</article>`
  );
}

/* ------------------------------------------------------------- gap list */

function buildGaps({ seeds, manifest, sourceInventory, sourceInventoryError }) {
  const items = [];

  for (const s of seeds) {
    const kind = classifyAnswer(s);
    const q = s?.question ?? s?.q ?? "";
    if (kind === "no_match") {
      items.push({
        tone: "warn",
        title: "No indexed match in the searched material",
        detail: `The completed search for "${q}" returned no indexed match in the material it searched. This does not establish nonexistence outside that searched material or prove every intended source is complete.`,
      });
    } else if (kind === "search_unavailable") {
      items.push({
        tone: "fail",
        title: "The search could not be completed",
        detail: s?.notice || `The search for "${q}" was unavailable or degraded. No absence conclusion can be drawn from it.`,
      });
    } else if (kind === "coverage_incomplete") {
      items.push({
        tone: "warn",
        title: "Source coverage remains unproven",
        detail: s?.notice || `The search for "${q}" ran, but its source coverage was incomplete or unknown. Treat the result as provisional.`,
      });
    } else if (kind === "answered_degraded") {
      items.push({
        tone: "warn",
        title: "Answer came from a partial search",
        detail: s?.notice || `The cited answer for "${q}" used available results while part of search was degraded. It is not complete-coverage proof.`,
      });
    } else if (kind === "unknown" || kind === "error") {
      items.push({
        tone: kind === "error" ? "fail" : "warn",
        title: kind === "error" ? "The question check did not complete" : "Search result remains unproven",
        detail: s?.error || s?.notice || `The check for "${q}" did not carry enough evidence for a no-match conclusion.`,
      });
    } else if (kind === "refused") {
      items.push({
        tone: "warn",
        title: "Answered with an honest no",
        detail: `Documents matched "${q}", but the brain would not claim an answer from them. That is the intended behaviour: it refuses rather than guessing.`,
      });
    }
  }

  // The computed gaps travel with each answer. The same one usually fires on
  // several questions, and repeating it five times reads as five problems.
  const seen = new Set();
  for (const s of seeds) {
    for (const g of arr(s?.gaps)) {
      const detail = String(g?.detail || "").trim();
      if (!detail || seen.has(detail)) continue;
      seen.add(detail);
      // A search that could not run outranks every housekeeping note in this
      // list. It is the one gap that means an answer on this page may be
      // absent rather than merely thin.
      const tone = g?.type === "search_unavailable" ? "fail" : "warn";
      items.push({ tone, title: gapTitle(g?.type), detail });
    }
  }

  const corpora = manifest?.corpora || {};
  const off = Object.keys(corpora)
    .filter((k) => !k.startsWith("_") && corpora[k] && corpora[k].enabled === false)
    .map((k) => CORPUS_LABEL[k] || k);
  if (off.length) {
    items.push({
      tone: "info",
      title: "Disabled in this local configuration",
      detail: `${off.join(", ")} ${plural(off.length, "is", "are")} disabled in this local manifest. That is intended configuration only, not proof of current connection state, historical absence, or completeness.`,
    });
  }

  const excluded = [
    ...arr(manifest?.safety?.private_path_prefixes),
    ...arr(manifest?.corpora?.google_drive?.exclude_paths),
    ...arr(manifest?.corpora?.google_drive?.exclude_name_parts),
  ];
  if (excluded.length) {
    items.push({
      tone: "info",
      title: "Local exclusion rules are configured",
      detail: `The local manifest asks supported loaders to exclude: ${excluded.join(", ")}. This report does not prove whether those items existed historically or whether every prior loader applied the rule.`,
    });
  }

  if (sourceInventory?.complete === true && sourceInventory.truncated === false) {
    for (const source of arr(sourceInventory.sources)) {
      const summary = sourceReceiptSummary(source);
      const state = statusToken(source?.freshness?.state);
      const history = statusToken(source?.freshness?.coverage?.history?.state);
      const latestRun = statusToken(source?.receipt?.latest_run?.outcome);
      if (["stale", "broken", "review", "never_synced", "unregistered"].includes(state) ||
          (latestRun && latestRun !== "completed")) {
        items.push({
          tone: ["broken", "review", "unregistered"].includes(state) ||
            ["failed", "refused"].includes(latestRun) ? "fail" : "warn",
          title: `${summary.label} needs attention`,
          detail: [summary.currency, summary.ingest, summary.run, summary.reason]
            .filter(Boolean).join("; "),
        });
      }
      if (history !== "complete") {
        items.push({
          tone: "warn",
          title: `${summary.label} history remains unproven`,
          detail: `${summary.history}; ${summary.ingest}.`,
        });
      }
    }
  } else {
    items.push({
      tone: "warn",
      title: "Authenticated source status is unknown",
      detail: `The source-registry and receipt check was unavailable or incomplete${sourceInventoryError ? `: ${sourceInventoryError}` : "."} Local manifest settings do not replace that proof.`,
    });
  }

  // Severity first. A question that returned nothing at all is a different
  // order of problem than a source nobody asked us to connect, and burying it
  // under the housekeeping is how a real gap gets skimmed past.
  const rank = { fail: 0, warn: 1, info: 2 };
  return items.sort((a, b) => (rank[a.tone] ?? 3) - (rank[b.tone] ?? 3));
}

const GAP_TITLES = {
  stale: "Newest source is old",
  undated: "No dates on the sources",
  partially_undated: "Some sources carry no date",
  thin_coverage: "Very few matching sources",
  single_corpus: "Everything came from one place",
  no_results: "Nothing matched",
  // Not the same thing as "nothing matched", and the report must not let a
  // reader collapse the two.
  search_unavailable: "The search could not be completed",
};
const gapTitle = (type) => GAP_TITLES[type] || "Worth knowing";

function renderGapList(items) {
  if (!items.length) {
    return `<p class="empty">No gaps were detected on this run. That is a statement about these questions on this day, not a promise that the brain knows everything.</p>`;
  }
  return (
    `<ul class="gaps">` +
    items
      .map(
        (g) =>
          `<li class="gap gap-${g.tone}"><span class="gap-title">${h(g.title)}</span>` +
          `<span class="gap-detail">${h(g.detail)}</span></li>`
      )
      .join("") +
    `</ul>`
  );
}

function renderExpectedToFail(expected) {
  if (!expected.length) return "";
  const rows = expected
    .map((e) => {
      const q = typeof e === "string" ? e : (e?.question ?? e?.q ?? "");
      const kind = typeof e === "string" ? null : classifyAnswer(e);
      let outcome;
      let tone;
      if (kind === null || kind === "error") {
        outcome = "Not re-run for this report.";
        tone = "info";
      } else if (kind === "answered") {
        outcome = "It answered anyway, with sources. Read that answer carefully before trusting it: you expected this one to be beyond the material.";
        tone = "pass";
      } else if (kind === "answered_degraded") {
        outcome = "It produced a cited answer while part of search was degraded. Treat it as partial, not as proof of complete coverage.";
        tone = "warn";
      } else if (kind === "refused") {
        outcome = "It said it does not know, exactly as you predicted.";
        tone = "warn";
      } else if (kind === "search_unavailable") {
        outcome = "The search did not complete. That is not a confirmed miss and supports no absence conclusion.";
        tone = "fail";
      } else if (kind === "coverage_incomplete") {
        outcome = "The search ran, but source coverage remains incomplete or unknown. This is not a confirmed miss.";
        tone = "warn";
      } else if (kind === "unavailable") {
        outcome = "Sources matched, but no written answer was produced.";
        tone = "warn";
      } else if (kind === "unknown") {
        outcome = "The response did not carry enough status evidence to confirm a completed miss.";
        tone = "warn";
      } else {
        outcome = "The completed search found no indexed match in the material it searched, as predicted. This does not prove nonexistence outside that searched material.";
        tone = "warn";
      }
      return (
        `<li class="predict predict-${tone}">` +
        `<span class="predict-q">${h(q)}</span>` +
        `<span class="predict-o">${h(outcome)}</span>` +
        (["answered", "answered_degraded"].includes(kind) && !(typeof e === "string") && e.answer
          ? `<div class="predict-a">${renderAnswerBody(e.answer)}</div>`
          : "") +
        `</li>`
      );
    })
    .join("");

  return (
    `<div class="subsection">` +
    `<h3>The ones you predicted it would miss</h3>` +
    `<p class="lede">You named these at intake, before anything was indexed. Calling the misses in advance is what turns this list into a calibration rather than a failure report.</p>` +
    `<ul class="predicts">${rows}</ul></div>`
  );
}

/* ------------------------------------------------------------- coverage */

const displayCount = (value) => {
  if (value === null || value === undefined || value === "") return "not reported";
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? num(Math.floor(count)) : "not reported";
};

function renderSourceReceipts(sourceInventory, sourceInventoryError) {
  if (sourceInventory?.complete !== true || sourceInventory.truncated === true) {
    return (
      `<div class="empty"><p><b>Authenticated source status is unknown.</b></p>` +
      `<p>The source-registry and receipt check was unavailable or incomplete` +
      (sourceInventoryError ? `: ${h(sourceInventoryError)}` : ".") +
      ` Local manifest settings do not replace that proof.</p></div>`
    );
  }
  const sources = arr(sourceInventory.sources);
  if (!sources.length) {
    return `<p class="empty">The authenticated source registry contains no source rows. Source completeness remains unproven.</p>`;
  }
  const body = sources.map((source) => {
    const summary = sourceReceiptSummary(source);
    const registered = source?.registered === true ? "registered" : "not registered";
    return (
      `<tr><td>${h(summary.label)}</td><td>${h(registered)}</td>` +
      `<td>${h(summary.currency)}</td><td>${h(summary.history)}</td>` +
      `<td>${h(summary.ingest)}` +
      (summary.run ? `<br>${h(summary.run)}` : "") +
      (summary.reason ? `<br>${h(summary.reason)}` : "") +
      `</td></tr>`
    );
  }).join("");
  return (
    `<h3>Authenticated source receipts</h3>` +
    `<p class="lede">Only the Brain's live source registry and completed receipts can establish connection status, a refresh expectation, a failure, or a complete sweep.</p>` +
    `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Registry</th><th>Freshness</th><th>History</th><th>Latest receipt</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

function renderManifestIntent(manifest) {
  const configured = Object.entries(manifest?.corpora || {})
    .filter(([key, value]) => !key.startsWith("_") && value && typeof value === "object");
  if (!configured.length) {
    return `<p class="note">This local manifest lists no source intentions. That omission provides no evidence about live or historical source state.</p>`;
  }
  const items = configured.map(([key, value]) => {
    const label = CORPUS_LABEL[key] || key;
    const state = value.enabled === true ? "enabled" : value.enabled === false ? "disabled" : "not specified";
    return `<li><b>${h(label)}:</b> ${h(state)} in this local manifest</li>`;
  }).join("");
  return (
    `<h3>Intended local configuration</h3>` +
    `<p class="lede">These settings describe what this local manifest intends. They do not prove an authenticated connection, a successful refresh, currentness, historical completeness, or that a source never held records.</p>` +
    `<ul>${items}</ul>`
  );
}

function renderCoverage(corpus, manifest, sourceInventory, sourceInventoryError) {
  const knownCorpus = corpus && Array.isArray(corpus.rows);
  const counts = corpusReportCounts(corpus);
  const rows = counts.rows.slice().sort((a, b) =>
    Number(b.chunks ?? b.total ?? 0) - Number(a.chunks ?? a.total ?? 0));

  let corpusHtml;
  if (!knownCorpus) {
    corpusHtml = `<p class="empty">The authenticated corpus summary was unavailable, so logical document, extracted chunk, and semantic-visibility counts are unknown.</p>`;
  } else if (!rows.length) {
    corpusHtml = `<p class="empty">The authenticated corpus summary returned zero source rows for this snapshot. Source history and intended coverage still depend on the source receipts below.</p>`;
  } else {
    const body = rows.map((row) => {
      const label = FRIENDLY[row.source_type] || row.source_type;
      const logical = row.logical_documents ?? row.documents;
      const chunks = row.chunks ?? row.total;
      const visible = row.embedded;
      return (
        `<tr><td>${h(label)}</td>` +
        `<td class="n">${h(displayCount(logical === null || logical === undefined ? null : Number(logical)))}</td>` +
        `<td class="n">${h(displayCount(chunks === null || chunks === undefined ? null : Number(chunks)))}</td>` +
        `<td class="n">${h(displayCount(visible === null || visible === undefined ? null : Number(visible)))}</td>` +
        `<td>${h(isoDay(row.last_ingested) || "not reported")}</td></tr>`
      );
    }).join("");
    const pending = counts.extractedChunks !== null && counts.semanticVisibleChunks !== null
      ? Math.max(0, counts.extractedChunks - counts.semanticVisibleChunks)
      : null;
    corpusHtml = (
      `<div class="stats">` +
      `<div class="stat"><b>${h(displayCount(counts.logicalDocuments))}</b><span>logical documents</span></div>` +
      `<div class="stat"><b>${h(displayCount(counts.extractedChunks))}</b><span>extracted chunks</span></div>` +
      `<div class="stat"><b>${h(displayCount(counts.semanticVisibleChunks))}</b><span>meaning-search visible</span></div>` +
      `</div>` +
      `<p class="note">Extracted chunks are stored for keyword search. Meaning-search visibility is a separate, confirmed projection state.</p>` +
      `<div class="table-wrap"><table><thead><tr><th>Kind</th><th class="n">Logical documents</th><th class="n">Extracted chunks</th><th class="n">Meaning-search visible</th><th>Last stored ingest receipt</th></tr></thead>` +
      `<tbody>${body}</tbody></table></div>` +
      (pending && pending > 0
        ? `<p class="note">${h(num(pending))} extracted ${plural(pending, "chunk is", "chunks are")} not yet visibility-confirmed for meaning search. ${plural(pending, "It", "They")} may still be available to keyword search; this report does not call ${plural(pending, "it", "them")} absent.</p>`
        : "")
    );
  }

  return corpusHtml +
    renderSourceReceipts(sourceInventory, sourceInventoryError) +
    renderManifestIntent(manifest);
}

/* ------------------------------------------------------------ the checks */

function renderChecks(acceptance, acceptanceError) {
  const notice = acceptanceError
    ? `<div class="empty"><p><b>The run stopped before it finished.</b></p>` +
      `<p>It ended with: ${h(acceptanceError)}</p>` +
      `<p>Any tier missing below was never reached, so treat its absence as unknown rather than as passing.</p></div>`
    : "";
  if (!acceptance) {
    return notice || `<p class="empty">The verification suite did not run for this report.</p>`;
  }
  const results = arr(acceptance.results);
  if (!results.length) return notice || `<p class="empty">The verification suite produced no results.</p>`;

  const tiers = [];
  let current = null;
  for (const r of results) {
    if (!current || current.tier !== r.tier) {
      current = { tier: r.tier, rows: [] };
      tiers.push(current);
    }
    current.rows.push(r);
  }

  return notice + tiers
    .map((t) => {
      const worst = t.rows.some((r) => r.status === "fail")
        ? "fail"
        : t.rows.some((r) => r.status === "warn")
          ? "warn"
          : t.rows.every((r) => r.status === "skip")
            ? "skip"
            : "pass";
      const rows = t.rows
        .map(
          (r) =>
            `<li class="check check-${h(r.status)}">` +
            `<span class="pill pill-${h(r.status)}">${h(String(r.status).toUpperCase())}</span>` +
            `<span class="check-body"><span class="check-name">${h(r.name)}</span>` +
            (r.detail ? `<span class="check-detail">${h(r.detail)}</span>` : "") +
            `</span></li>`
        )
        .join("");
      return (
        `<div class="tier tier-${worst}">` +
        `<h3><span class="tier-n">Tier ${h(t.tier)}</span>${h(TIER_NAMES[t.tier] || "Checks")}</h3>` +
        (TIER_WHY[t.tier] ? `<p class="tier-why">${h(TIER_WHY[t.tier])}</p>` : "") +
        `<ul class="checks">${rows}</ul></div>`
      );
    })
    .join("");
}

/* ------------------------------------------------------------------ css */

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:light dark;
  --bg:#faf9f7;--panel:#fff;--panel2:#f4f2ee;--ink:#1b1a18;--muted:#5f5b55;--line:#e2ddd4;
  --accent:#8a4b22;
  --pass-fg:#14572f;--pass-bg:#e6f2ea;--pass-line:#b4d6c1;
  --fail-fg:#8a1c1c;--fail-bg:#fbe9e9;--fail-line:#e6b9b9;
  --warn-fg:#7a5210;--warn-bg:#fdf2df;--warn-line:#e7d1a4;
  --skip-fg:#54514c;--skip-bg:#efedea;--skip-line:#dad5cd;
  --info-fg:#1f4a63;--info-bg:#e7f0f5;--info-line:#b9d2e0;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#131417;--panel:#1b1d21;--panel2:#212429;--ink:#e9e6e1;--muted:#a5a099;--line:#31343a;
    --accent:#e0965d;
    --pass-fg:#8fe0ae;--pass-bg:#16281d;--pass-line:#2c4a37;
    --fail-fg:#ffa5a5;--fail-bg:#2b1717;--fail-line:#563030;
    --warn-fg:#f2ce8a;--warn-bg:#2a2214;--warn-line:#544628;
    --skip-fg:#adaaa4;--skip-bg:#232528;--skip-line:#3b3e43;
    --info-fg:#9dcbe6;--info-bg:#16242c;--info-line:#2c4453;
  }
}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:54rem;margin:0 auto;padding:2.5rem 1.15rem 5rem}
h1,h2,h3{line-height:1.25;letter-spacing:-0.01em}
h1{font-size:2rem;margin:.2rem 0 .35rem}
h2{font-size:1.3rem;margin:0 0 .35rem}
h3{font-size:1.02rem;margin:0 0 .4rem}
p{margin:0 0 .8rem}
.eyebrow{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0}
.sub{color:var(--muted);font-size:.92rem}
.lede{color:var(--muted);margin-bottom:1.1rem}
.muted{color:var(--muted)}
.empty{color:var(--muted);background:var(--panel2);border:1px solid var(--line);
  border-radius:10px;padding:.9rem 1rem;margin:0}
.note{color:var(--muted);font-size:.9rem}

.verdict{border:1px solid var(--line);border-left-width:6px;border-radius:12px;
  background:var(--panel);padding:1.1rem 1.2rem;margin:1.3rem 0 1.6rem}
.verdict-word{font-size:.72rem;letter-spacing:.16em;font-weight:700;text-transform:uppercase;display:block;margin-bottom:.3rem}
.verdict-line{font-size:1.22rem;font-weight:650;margin:0 0 .35rem}
.verdict-detail{margin:0;color:var(--muted);font-size:.93rem}
.v-ready{border-left-color:var(--pass-line);background:var(--pass-bg)}
.v-ready .verdict-word{color:var(--pass-fg)}
.v-attention{border-left-color:var(--warn-line);background:var(--warn-bg)}
.v-attention .verdict-word{color:var(--warn-fg)}
.v-blocked{border-left-color:var(--fail-line);background:var(--fail-bg)}
.v-blocked .verdict-word{color:var(--fail-fg)}
.v-unknown{border-left-color:var(--skip-line);background:var(--skip-bg)}
.v-unknown .verdict-word{color:var(--skip-fg)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.6rem;margin:0 0 2.2rem}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.75rem .85rem}
.stat b{display:block;font-size:1.45rem;line-height:1.2;font-weight:650}
.stat span{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}

section{margin:0 0 2.6rem}
.section-head{border-top:1px solid var(--line);padding-top:1.4rem;margin-bottom:1.1rem}
.subsection{margin-top:2rem}

.qa{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:1.05rem 1.15rem;margin:0 0 .85rem}
.qa-head{display:flex;gap:.6rem;align-items:baseline}
.qa-n{color:var(--accent);font-weight:700;font-size:.9rem;flex:0 0 auto}
.qa-q{font-size:1.05rem;font-weight:650;margin:0}
.qa-a{margin-top:.6rem}
.qa-a p{margin:0 0 .65rem}
.qa-a p:last-child{margin-bottom:0}
.answer-list{margin:.2rem 0 .65rem;padding-left:1.1rem}
.answer-list li{margin-bottom:.25rem}
.headsup{border-left:3px solid var(--warn-line);background:var(--warn-bg);color:var(--warn-fg);
  padding:.5rem .7rem;border-radius:0 8px 8px 0;font-size:.92rem}
.cite{color:var(--accent);font-weight:700;font-size:.7em;padding:0 .08em}

.pill{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.07em;
  text-transform:uppercase;padding:.16rem .5rem;border-radius:999px;border:1px solid;margin-top:.5rem}
.pill-pass{color:var(--pass-fg);background:var(--pass-bg);border-color:var(--pass-line)}
.pill-fail{color:var(--fail-fg);background:var(--fail-bg);border-color:var(--fail-line)}
.pill-warn{color:var(--warn-fg);background:var(--warn-bg);border-color:var(--warn-line)}
.pill-skip{color:var(--skip-fg);background:var(--skip-bg);border-color:var(--skip-line)}

.cites{margin-top:.85rem;border-top:1px dashed var(--line);padding-top:.65rem}
.cites-head{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 .4rem}
.cite-list{list-style:none;margin:0;padding:0}
.cite-list li{display:flex;gap:.55rem;margin-bottom:.4rem;font-size:.88rem}
.cite-n{flex:0 0 1.35rem;height:1.35rem;border-radius:50%;background:var(--panel2);border:1px solid var(--line);
  color:var(--accent);font-weight:700;font-size:.72rem;display:flex;align-items:center;justify-content:center}
.cite-body{display:flex;flex-direction:column;min-width:0}
.cite-title{font-weight:550;overflow-wrap:anywhere}
.cite-meta{color:var(--muted);font-size:.8rem}
.cite-ref{color:var(--muted);font-size:.74rem;overflow-wrap:anywhere;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

.gaps{list-style:none;margin:0;padding:0}
.gap{background:var(--panel);border:1px solid var(--line);border-left-width:5px;border-radius:10px;
  padding:.75rem .9rem;margin-bottom:.55rem;display:flex;flex-direction:column;gap:.15rem}
.gap-title{font-weight:650;font-size:.95rem}
.gap-detail{color:var(--muted);font-size:.92rem}
.gap-fail{border-left-color:var(--fail-line)}
.gap-fail .gap-title{color:var(--fail-fg)}
.gap-warn{border-left-color:var(--warn-line)}
.gap-warn .gap-title{color:var(--warn-fg)}
.gap-info{border-left-color:var(--info-line)}
.gap-info .gap-title{color:var(--info-fg)}

.predicts{list-style:none;margin:0;padding:0}
.predict{background:var(--panel2);border:1px solid var(--line);border-radius:10px;
  padding:.8rem .95rem;margin-bottom:.55rem;display:flex;flex-direction:column;gap:.3rem}
.predict-q{font-weight:650}
.predict-o{color:var(--muted);font-size:.92rem}
.predict-a{border-top:1px dashed var(--line);padding-top:.5rem;font-size:.93rem}
.predict-pass{border-left:5px solid var(--pass-line)}
.predict-warn{border-left:5px solid var(--warn-line)}
.predict-info{border-left:5px solid var(--skip-line)}

.big-number{font-size:1.9rem;font-weight:650;margin:0 0 .5rem}
.big-number span{font-size:1rem;font-weight:400;color:var(--muted)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid var(--line)}
th{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:none}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.fresh-ok{color:var(--pass-fg)}
.fresh-warn{color:var(--warn-fg)}
.fresh-bad{color:var(--fail-fg);font-weight:600}

.tier{background:var(--panel);border:1px solid var(--line);border-left-width:5px;
  border-radius:12px;padding:.95rem 1.05rem;margin-bottom:.75rem}
.tier-pass{border-left-color:var(--pass-line)}
.tier-warn{border-left-color:var(--warn-line)}
.tier-fail{border-left-color:var(--fail-line)}
.tier-skip{border-left-color:var(--skip-line)}
.tier-n{display:block;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700}
.tier-why{color:var(--muted);font-size:.88rem;margin:0 0 .7rem}
.checks{list-style:none;margin:0;padding:0}
.check{display:flex;gap:.6rem;align-items:flex-start;padding:.4rem 0;border-top:1px solid var(--line)}
.check .pill{margin-top:.1rem;flex:0 0 auto;min-width:3.4rem;text-align:center}
.check-body{display:flex;flex-direction:column;min-width:0}
.check-name{font-size:.95rem}
.check-detail{color:var(--muted);font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere}

footer{border-top:1px solid var(--line);padding-top:1.2rem;color:var(--muted);font-size:.88rem}
footer b{color:var(--ink)}
.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;
  background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:.1rem .4rem;overflow-wrap:anywhere}

@media (max-width:34rem){
  main{padding:1.6rem .85rem 3.5rem}
  h1{font-size:1.55rem}
  .verdict-line{font-size:1.08rem}
  .big-number{font-size:1.5rem}
  .check{flex-direction:column;gap:.2rem}
}
@media print{
  :root{--bg:#fff;--panel:#fff;--panel2:#fff;--ink:#000;--muted:#333;--line:#bbb}
  body{font-size:11pt}
  main{max-width:none;padding:0}
  .qa,.tier,.gap,.predict,.stat,.verdict{break-inside:avoid;page-break-inside:avoid}
  section{break-inside:auto}
  h2{break-after:avoid}
}
`;

/* ---------------------------------------------------------------- render */

/**
 * Pure. No network, no clock beyond generatedAt, no filesystem. That is what
 * makes the whole document testable from a fixture.
 */
export function renderReportHtml(data) {
  const d = data && typeof data === "object" ? data : {};
  const manifest = d.manifest && typeof d.manifest === "object" ? d.manifest : {};
  const acceptance = d.acceptance || null;
  const acceptanceError = d.acceptanceError || null;
  const seeds = arr(d.seedAnswers);
  const expected = arr(d.expectedToFail);
  const corpus = d.corpus || null;
  const sourceInventory = d.sourceInventory || null;
  const sourceInventoryError = d.sourceInventoryError || null;
  const installState = d.installState || null;
  const generatedAt = d.generatedAt || new Date();

  const clientName = manifest.client?.display_name || manifest.client?.slug || "";
  const title = clientName ? `${clientName} brain: verification report` : "Brain verification report";

  const verdict = computeVerdict({ acceptance, acceptanceError, seeds });
  const gaps = buildGaps({ seeds, manifest, sourceInventory, sourceInventoryError });

  const counts = acceptance?.counts || { pass: 0, fail: 0, warn: 0, skip: 0 };
  const checkTotal = counts.pass + counts.fail + counts.warn + counts.skip;
  const answered = seeds.filter((s) =>
    ["answered", "answered_degraded"].includes(classifyAnswer(s))).length;
  const corpusCounts = corpusReportCounts(corpus);

  const stats =
    `<div class="stats">` +
    `<div class="stat"><b>${h(counts.pass)}/${h(checkTotal)}</b><span>checks passed</span></div>` +
    (seeds.length
      ? `<div class="stat"><b>${h(answered)}/${h(seeds.length)}</b><span>questions answered</span></div>`
      : `<div class="stat"><b>none</b><span>optional questions saved</span></div>`) +
    `<div class="stat"><b>${h(displayCount(corpusCounts.logicalDocuments))}</b><span>logical documents</span></div>` +
    `<div class="stat"><b>${h(displayCount(corpusCounts.extractedChunks))}</b><span>extracted chunks</span></div>` +
    `<div class="stat"><b>${h(displayCount(corpusCounts.semanticVisibleChunks))}</b><span>meaning-search visible</span></div>` +
    `</div>`;

  /* section 2: optional owner-authored regression questions. */
  const questions = seeds.length
    ? seeds.map((s, i) => renderQuestionCard(s, i)).join("")
    : `<div class="empty"><p><b>No optional owner-authored questions were saved for this report.</b></p>` +
      `<p>That is normal. Zero prepared questions are required for setup, adaptive acceptance, or handoff.</p>` +
      `<p>Owner handoff uses actual source receipts and one approved low-sensitivity item proved as accepted, ` +
      `stored with provenance, projected, and query-visible with a citation. An assistant can offer one ` +
      `evidence-derived question at a time. Save owner-authored questions later only if repeatable regression checks would be useful.</p></div>`;

  const versionBits = [];
  if (installState?.product_version) versionBits.push(`Running version <b>${h(installState.product_version)}</b>.`);
  if (installState?.schema_version) versionBits.push(`Database schema ${h(installState.schema_version)}.`);
  if (manifest.safety?.daily_llm_spend_cap_usd) {
    versionBits.push(
      `A daily ceiling of $${h(manifest.safety.daily_llm_spend_cap_usd)} on answer generation is in force, so a runaway process cannot turn into a surprise bill.`
    );
  }

  const generatedLabel = longDate(generatedAt);
  const baseLabel = d.base ? String(d.base) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${h(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">Verification report</p>
<h1>${h(clientName ? clientName + " brain" : "Your brain")}</h1>
<p class="sub">${h(generatedLabel ? "Generated " + generatedLabel + "." : "")} This report combines completed live checks against your own installation${baseLabel ? ", at " + h(baseLabel) : ""}, intended local configuration, and explanatory guidance. Incomplete or unavailable checks are marked unknown.</p>
<div class="verdict v-${h(verdict.state)}">
<span class="verdict-word">${h(VERDICT_WORD[verdict.state])}</span>
<p class="verdict-line">${h(verdict.line)}</p>
<p class="verdict-detail">${h(verdict.detail)}</p>
</div>
${stats}
</header>

<section id="questions">
<div class="section-head"><h2>Optional owner questions</h2>
<p class="lede">When the owner chooses to save questions, each result below is produced from their own material and names the supporting document. A saved question list is not required for setup, adaptive acceptance, or handoff.</p></div>
${questions}
</section>

<section id="gaps">
<div class="section-head"><h2>What needs attention or remains unproven</h2>
<p class="lede">This list separates a completed no-match from an unavailable search, incomplete source coverage, local configuration, and authenticated source receipts.</p></div>
${renderGapList(gaps)}
${renderExpectedToFail(expected)}
</section>

<section id="coverage">
<div class="section-head"><h2>What is stored and searchable</h2>
<p class="lede">Logical documents, extracted keyword-searchable chunks, and visibility-confirmed semantic chunks are different counts. Source currentness and completeness appear only when authenticated receipts prove them.</p></div>
${renderCoverage(corpus, manifest, sourceInventory, sourceInventoryError)}
</section>

<section id="checks">
<div class="section-head"><h2>Verification checks</h2>
<p class="lede">Five tiers, run in order. An early failure stops the run because later results would be noise rather than signal.</p></div>
${renderChecks(acceptance, acceptanceError)}
</section>

<footer>
${versionBits.length ? `<p>${versionBits.join(" ")}</p>` : ""}
<p><b>You can run this yourself, at any time.</b> It is one command against your own infrastructure: <span class="cmd">${escapeHtml(renderCliCommands("brain test <manifest> --report"))}</span>. The report combines completed live checks, intended local configuration, and explanatory guidance; incomplete checks are marked unknown. Nothing in this report was collected by us and no copy of your material leaves the accounts you own.</p>
<p>This file is self contained. It has no links, no fonts and no code to load, so it will open in any browser, on any machine, with no internet connection, for as long as you keep it.</p>
</footer>
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------ collection */

/**
 * Ask the live install everything the report needs.
 *
 * Each seed question costs one answer generation on the CLIENT's own API key,
 * which is exactly why this is an explicit command rather than a cron. A
 * report that silently spends their money every night is a report they turn
 * off.
 */
export async function collectReportData({
  base,
  adminKey,
  manifest = {},
  installState = null,
  fetchImpl = fetch,
  answerLimit = 8,
}) {
  const root = String(base || "").replace(/\/+$/, "");
  const probes = arr(manifest?.testing?.probe_questions)
    .filter((question) => String(question || "").trim());
  const predicted = arr(manifest?.testing?.expected_to_fail);

  const suite = new Acceptance({ base: root, adminKey, manifest, fetchImpl });
  let acceptance = null;
  let acceptanceError = null;
  try {
    acceptance = await suite.run({ probes, installState });
  } catch (e) {
    // Only tier 1 catches its own transport errors, so one unreachable
    // endpoint anywhere after it throws out of the whole run. Losing the
    // entire document to that is the wrong trade: the tiers that did complete
    // are still true, and "the run stopped here, with this error" is itself a
    // finding worth handing over.
    acceptanceError = e.message;
    acceptance = suite.results?.length ? suite.summary() : null;
  }

  let corpus = null;
  try {
    const res = await fetchBrainWithAdminKey(
      fetchImpl,
      `${root}/api/admin/brain/documents`,
      {},
      () => adminKey,
    );
    if (res.ok) corpus = await res.json();
  } catch {
    // A missing corpus summary is reported as a blank section, never as a
    // crash. The rest of the document is still worth handing over.
  }

  let sourceInventory = null;
  let sourceInventoryError = null;
  try {
    sourceInventory = await collectSourceInventorySnapshot({
      base: root,
      adminKey,
      fetchImpl,
    });
  } catch (error) {
    sourceInventoryError = String(
      error?.message || error || "authenticated source inventory was unavailable"
    );
  }

  const askOne = async (question) => {
    try {
      const res = await fetchBrainWithAdminKey(fetchImpl, `${root}/api/rag/think`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: question, limit: answerLimit }),
      }, () => adminKey);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        return {
          question,
          search_status: "search_unavailable",
          error: `the brain returned a non-JSON response (HTTP ${res.status})`,
        };
      }
      if (!res.ok) {
        return {
          question,
          search_status: "search_unavailable",
          error: json?.error || `HTTP ${res.status}`,
        };
      }
      return {
        question,
        answer: json.answer || null,
        answer_error: json.answer_error || null,
        citations: json.citations || [],
        gaps: json.gaps || [],
        resultCount: Array.isArray(json.results) ? json.results.length : 0,
        // Keep the Worker's explicit retrieval truth. Version-skewed Workers
        // used `status`; current clients expose the same value as
        // `search_status`, so the report stores both without discarding either.
        search_status: json.search_status ?? json.status ?? null,
        status: json.status ?? json.search_status ?? null,
        degraded: json.degraded ?? null,
        degraded_reason: json.degraded_reason ?? null,
        notice: json.notice ?? null,
        coverage_state: json.coverage_state ?? null,
        coverage: json.coverage ?? null,
        source_coverage: json.source_coverage ?? null,
        retrieval_scope: json.retrieval_scope ?? null,
        evidence_gate: json.evidence_gate ?? null,
      };
    } catch (e) {
      // One unreachable question must not cost the client the other nine.
      return { question, search_status: "search_unavailable", error: e.message };
    }
  };

  const seedAnswers = [];
  for (const q of probes) seedAnswers.push(await askOne(q));
  const expectedToFail = [];
  for (const q of predicted) expectedToFail.push(await askOne(q));

  return {
    manifest,
    acceptance,
    acceptanceError,
    seedAnswers,
    expectedToFail,
    corpus,
    sourceInventory,
    sourceInventoryError,
    installState,
    base: root,
    generatedAt: new Date(),
  };
}

/** Collect then render. The one call the CLI needs. */
export async function buildHtmlReport(options) {
  const data = await collectReportData(options);
  return { html: renderReportHtml(data), data };
}

export default renderReportHtml;
