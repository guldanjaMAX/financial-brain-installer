/**
 * Reject text that will waste an embedding and pollute retrieval.
 *
 * THE CASE THIS IS DESIGNED AGAINST
 *
 * One HTML file in a previous corpus, "Blueprint Image Picker.html", was 75 to
 * 87 percent base64 image data. It produced 18,259 chunks. Every one of them
 * embedded, every one competed for retrieval slots, and not one could answer a
 * question. A whole-corpus survey later found 51.5% of the index was markup or
 * encoded blobs and only 6% was prose.
 *
 * Nothing errored. Search simply got worse, slowly, in a way no health check
 * could see. So the filter runs BEFORE embedding, and every rejection is
 * recorded with its reason rather than silently dropped: a client asking "why
 * isn't my file in there" deserves an answer better than a shrug.
 *
 * The thresholds are deliberately loose. A false accept costs one bad chunk. A
 * false reject silently loses a real document, which is far worse, so anything
 * borderline is kept.
 */

/** Below this there is nothing to retrieve, and it is usually a failed extraction. */
export const MIN_CHARS = 24;

/** Long encoded runs are the signature of an embedded image or attachment. */
const B64_RUN_MIN = 200;
const HEX_RUN_MIN = 300;

const isAsciiDigit = (code) => code >= 48 && code <= 57;
const isAsciiUpper = (code) => code >= 65 && code <= 90;
const isAsciiLower = (code) => code >= 97 && code <= 122;
const isBase64Code = (code) =>
  isAsciiDigit(code) || isAsciiUpper(code) || isAsciiLower(code) ||
  code === 43 || code === 47 || code === 61;
const isHexCode = (code) =>
  isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
const isWordCode = (code) =>
  isAsciiDigit(code) || isAsciiUpper(code) || isAsciiLower(code) || code === 39;

/**
 * Measure the whole-file ratios without materializing one match per run.
 *
 * V8's global match for one multi-megabyte quantified run can overflow its
 * regexp stack. This loop keeps constant scanner state and deliberately adds a
 * hex run twice when it is also base64, matching the historical two-regexp
 * metric exactly.
 */
function scanQualityRuns(text) {
  let encoded = 0;
  let replacement = 0;
  let base64Run = 0;
  let hexRun = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isBase64Code(code)) base64Run++;
    else {
      if (base64Run >= B64_RUN_MIN) encoded += base64Run;
      base64Run = 0;
    }
    if (isHexCode(code)) hexRun++;
    else {
      if (hexRun >= HEX_RUN_MIN) encoded += hexRun;
      hexRun = 0;
    }
    if (code === 0xfffd) replacement++;
  }
  if (base64Run >= B64_RUN_MIN) encoded += base64Run;
  if (hexRun >= HEX_RUN_MIN) encoded += hexRun;
  return { encoded, replacement };
}

/** Count the same ASCII word tokens as /[a-z0-9']{2,}/g without a large match array. */
function wordDiversity(text) {
  const normalized = text.toLowerCase();
  const unique = new Set();
  let words = 0;
  let start = -1;
  for (let index = 0; index <= normalized.length; index++) {
    const code = index < normalized.length ? normalized.charCodeAt(index) : -1;
    if (isWordCode(code)) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0 && index - start >= 2) {
      words++;
      unique.add(normalized.slice(start, index));
    }
    start = -1;
  }
  return { words, unique: unique.size };
}

export const DEFAULT_NONSENSE_POLICY = Object.freeze({
  binary_control_ratio_max: 0.02,
  symbol_ratio_max: 0.58,
  symbol_min_chars: 500,
  min_word_like_ratio: 0.08,
  word_shape_min_tokens: 120,
  repeated_line_ratio_max: 0.70,
  repeated_line_min_lines: 80,
  templated_mail_min_substantive_chars: 48,
});

const threshold = (policy, name) => {
  const value = Number(policy?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_NONSENSE_POLICY[name];
};

const isAsciiLetter = (code) => isAsciiUpper(code) || isAsciiLower(code);
const isAsciiVowel = (code) => [65, 69, 73, 79, 85, 97, 101, 105, 111, 117].includes(code);
const isWhitespaceCode = (code) => code === 32 || (code >= 9 && code <= 13);

/** One bounded linear pass for extracted-text signals that are not byte-level. */
function nonsenseMetrics(text) {
  let controls = 0;
  let visible = 0;
  let symbols = 0;
  let tokenCount = 0;
  let wordLike = 0;
  let tokenLetters = 0;
  let tokenDigits = 0;
  let tokenVowels = 0;
  const finishToken = () => {
    if (tokenLetters + tokenDigits < 2) return;
    tokenCount++;
    // Numbers, dates and dollar amounts are useful evidence. Alphabetic OCR
    // fragments need one vowel to look like a word. This is deliberately a
    // word-shape check, not an English dictionary.
    if ((tokenDigits > 0 && tokenLetters === 0) || tokenVowels > 0) wordLike++;
  };
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 32;
    const alphaNumeric = isAsciiLetter(code) || isAsciiDigit(code) || code > 127;
    if (index < text.length && (code === 0 || code < 9 || (code > 13 && code < 32))) controls++;
    if (index < text.length && !isWhitespaceCode(code)) {
      visible++;
      if (!alphaNumeric) symbols++;
    }
    if (alphaNumeric) {
      if (isAsciiDigit(code)) tokenDigits++;
      else {
        tokenLetters++;
        if (code > 127 || isAsciiVowel(code)) tokenVowels++;
      }
      continue;
    }
    finishToken();
    tokenLetters = 0;
    tokenDigits = 0;
    tokenVowels = 0;
  }
  return { controls, visible, symbols, tokenCount, wordLike };
}

/** Detect one line consuming most of a long extraction without unbounded regexes. */
function repeatedLineRatio(text) {
  const counts = new Map();
  let lines = 0;
  let repeated = 0;
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text.charCodeAt(index) !== 10) continue;
    const line = text.slice(start, index).trim().replace(/[ \t]+/g, " ").toLowerCase();
    start = index + 1;
    if (line.length < 12) continue;
    lines++;
    if (counts.size >= 20_000 && !counts.has(line)) continue;
    const count = (counts.get(line) || 0) + 1;
    counts.set(line, count);
    if (count > repeated) repeated = count;
  }
  return { lines, ratio: lines ? repeated / lines : 0 };
}

const MAIL_TEMPLATE_MARKERS = [
  /view (?:this )?(?:email )?in (?:your )?browser/i,
  /manage (?:email )?preferences/i,
  /privacy policy/i,
  /unsubscribe/i,
  /copyright\s+(?:19|20)\d{2}/i,
  /click here/i,
];

function templatedMailEvidence(text) {
  if (text.length > 800) return null;
  const matched = MAIL_TEMPLATE_MARKERS.filter((pattern) => pattern.test(text));
  if (matched.length < 4) return null;
  let substantive = text;
  for (const pattern of matched) substantive = substantive.replace(pattern, " ");
  substantive = substantive.replace(/\b(?:subject|from|to|date|sent):[^\n]*/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return { markers: matched.length, substantiveChars: substantive.length };
}

/**
 * Does this look like a binary file rather than text?
 *
 * Checked on the RAW BYTES, before any decode, because decoding binary as UTF-8
 * produces replacement characters that then look like ordinary text.
 */
/**
 * UTF-16 detection, because on Windows it is not an edge case.
 *
 * PowerShell redirection and Notepad both write UTF-16LE by default, so a
 * client's own notes are full of NUL bytes by design. Treating any NUL as
 * binary rejected those files with the flatly untrue reason "the file is binary,
 * not text", and the client never learns their notes are missing.
 */
export function utf16Encoding(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  // No BOM: infer from the NUL pattern of ASCII-range text, where every other
  // byte is zero. Sample rather than scan the whole file.
  const n = Math.min(buf.length - (buf.length % 2), 512);
  if (n < 16) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenNul++;
    if (buf[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  if (oddNul / pairs > 0.6 && evenNul / pairs < 0.1) return "utf-16le";
  if (evenNul / pairs > 0.6 && oddNul / pairs < 0.1) return "utf-16be";
  return null;
}

export function isLikelyBinary(buf) {
  if (!buf || !buf.length) return false;
  // UTF-16 is text. Checking this first is what stops a Windows client's own
  // notes being discarded as binary.
  if (utf16Encoding(buf)) return false;
  const n = Math.min(buf.length, 8192);
  let nul = 0;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) nul++;
    // Control characters excluding tab, newline, carriage return, form feed.
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  // A single NUL byte is the classic binary tell and almost never appears in
  // real text; a scattering of other control bytes can, so that gets a ratio.
  return nul > 0 || ctrl / n > 0.02;
}

/**
 * Judge extracted text.
 *
 * Returns { ok, reason, metrics }. `reason` is written to be shown to a client
 * verbatim, so it says what happened rather than naming a rule.
 */
export function textQuality(text, { sourceKind = "", policy = {} } = {}) {
  const s = typeof text === "string" ? text : "";
  const len = s.length;
  const metrics = { chars: len };

  if (!s.trim()) {
    return { ok: false, reason: "no text could be extracted (the file produced an empty result)", metrics };
  }
  if (len < MIN_CHARS) {
    return { ok: false, reason: `only ${len} characters of text, too little to answer anything`, metrics };
  }

  // Encoded blobs. Measured as a share of total length, so a document that
  // merely MENTIONS a token is unaffected while one built from them is caught.
  const scanned = scanQualityRuns(s);
  const encoded = scanned.encoded;
  metrics.encoded_ratio = +(encoded / len).toFixed(3);
  if (metrics.encoded_ratio > 0.35) {
    return {
      ok: false,
      reason: `${Math.round(metrics.encoded_ratio * 100)}% of this file is encoded data (base64 or hex), not readable text`,
      metrics,
    };
  }

  // Replacement characters mean a decode went wrong. A few are survivable;
  // a document made of them is a mis-detected encoding.
  const repl = scanned.replacement;
  metrics.replacement_ratio = +(repl / len).toFixed(3);
  if (metrics.replacement_ratio > 0.05) {
    return { ok: false, reason: "the text decoded into mostly unreadable characters (wrong or unsupported encoding)", metrics };
  }

  const nonsense = nonsenseMetrics(s);
  metrics.control_ratio = +(nonsense.controls / len).toFixed(3);
  if (metrics.control_ratio > threshold(policy, "binary_control_ratio_max")) {
    return { ok: false, reason: "the extraction contains binary data decoded as text, not a readable document", metrics };
  }

  metrics.symbol_ratio = +(nonsense.symbols / Math.max(1, nonsense.visible)).toFixed(3);
  if (len >= threshold(policy, "symbol_min_chars") &&
      metrics.symbol_ratio > threshold(policy, "symbol_ratio_max")) {
    return { ok: false, reason: "the extraction is mostly symbols with too little readable text", metrics };
  }

  if (nonsense.tokenCount >= threshold(policy, "word_shape_min_tokens")) {
    metrics.word_like_ratio = +(nonsense.wordLike / nonsense.tokenCount).toFixed(3);
    if (metrics.word_like_ratio < threshold(policy, "min_word_like_ratio")) {
      return { ok: false, reason: "the extraction has OCR-like unreadable word shapes rather than usable text", metrics };
    }
  }

  if (len > 4000) {
    const repeatedLines = repeatedLineRatio(s);
    metrics.repeated_line_ratio = +repeatedLines.ratio.toFixed(3);
    if (repeatedLines.lines >= threshold(policy, "repeated_line_min_lines") &&
        repeatedLines.ratio > threshold(policy, "repeated_line_ratio_max")) {
      return { ok: false, reason: "the extraction is mostly the same boilerplate line repeated over and over", metrics };
    }
  }

  if (["gmail", "imap", "mail"].includes(String(sourceKind).toLowerCase())) {
    const template = templatedMailEvidence(s);
    if (template) {
      metrics.mail_template_markers = template.markers;
      metrics.mail_substantive_chars = template.substantiveChars;
      if (template.substantiveChars < threshold(policy, "templated_mail_min_substantive_chars")) {
        return { ok: false, reason: "the message is a mail template with almost no message beyond subscription links", metrics };
      }
    }
  }

  // Repetition. A 2MB file of one repeated row embeds as well as one copy of it
  // and crowds out everything else. Only applied to long text, because short
  // documents are legitimately repetitive.
  if (len > 4000) {
    const words = wordDiversity(s);
    if (words.words >= 200) {
      metrics.unique_word_ratio = +(words.unique / words.words).toFixed(3);
      if (metrics.unique_word_ratio < 0.02) {
        return { ok: false, reason: "the file is almost entirely repeated content, with too little distinct text to be worth indexing", metrics };
      }
    }
  }

  return { ok: true, reason: null, metrics };
}

/**
 * Strip markup to its text.
 *
 * Not a parser and not trying to be. Scripts, styles and comments go first
 * (their contents are never answers), then tags, then entities. Anything more
 * faithful needs a real dependency, and the retrieval quality difference does
 * not justify one.
 */
export function stripMarkup(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
