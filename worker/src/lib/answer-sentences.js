/**
 * Split a generated answer into sentences without breaking at the dot inside
 * a figure, a URL or a file name.
 *
 * A sentence mark ends a sentence before whitespace, a closing quote or
 * bracket, the end of the text, or an uppercase sentence start. A run of
 * Markdown closing marks (*, _, ` or ~) also closes the sentence when one of
 * those boundaries follows that run. Otherwise a following digit, lowercase
 * letter, slash, hyphen or underscore keeps a full stop inside a figure, URL
 * or file name. A citation written after the full stop
 * ("done. [2]") still belongs to the sentence before it.
 *
 * Every step that keeps, drops or checks answer sentences must split with
 * this. Splitting on every "." turned a supported "$1,234.73 [1]" into
 * "73 [1]" and a "[1] ... $1,234.73." into a clean, wrong "$1,234.".
 *
 * Known limitation, deferred past 0.4.9: an abbreviation followed by a space
 * still ends a sentence, so "Example Co. recorded ... [1]." splits after
 * "Co.", and the partial-answer path then drops the uncited "Example Co."
 * fragment. worker/test/routes.test.mjs records that output as a known
 * limitation, not a pass. Changing this rule needs its own failing-first case
 * and control.
 */
export function answerSentences(text) {
  const value = String(text || "");
  const sentences = [];
  let start = 0;

  const skipWhitespace = (index) => {
    while (index < value.length && /\s/u.test(value[index])) index += 1;
    return index;
  };
  const sentenceBoundaryAt = (index) => {
    const mark = value[index];
    let next = index + 1;
    if (next >= value.length) return true;
    if (mark === "." && /\s/u.test(value[next])) {
      const following = skipWhitespace(next);
      const compactInitialism = /(?:^|[^A-Za-z])(?:[A-Z]\.){2,}$/u.test(value.slice(0, index + 1));
      if (compactInitialism && /[a-z]/u.test(value[following] || "")) return false;
    }
    if (/[\s"'”’)\]]/u.test(value[next])) return true;
    if (/[A-Z]/u.test(value[next])) {
      // Keep compact initialisms such as U.S. whole. The next full stop is
      // still judged normally, so this exception cannot swallow a sentence.
      if (mark === "." && /[A-Z]/u.test(value[index - 1] || "") && value[next + 1] === ".") return false;
      return true;
    }
    if (/[*_`~]/u.test(value[next])) {
      while (next < value.length && /[*_`~]/u.test(value[next])) next += 1;
      return next >= value.length || /[\s"'”’)\]A-Z]/u.test(value[next]);
    }
    return false;
  };

  const pushSentence = (end) => {
    const sentence = value.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  };

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      pushSentence(index);
      start = index + 1;
      continue;
    }
    if (!/[.!?]/u.test(value[index]) || !sentenceBoundaryAt(index)) continue;

    let end = index + 1;
    while (end < value.length && /[.!?]/u.test(value[end])) end += 1;
    while (end < value.length && /["'”’)\]*_`~]/u.test(value[end])) end += 1;
    let citationEnd = end;
    while (true) {
      const citationStart = skipWhitespace(citationEnd);
      const citation = /^\[\d+\]/u.exec(value.slice(citationStart));
      if (!citation) break;
      citationEnd = citationStart + citation[0].length;
    }
    pushSentence(citationEnd);
    start = skipWhitespace(start);
    index = start - 1;
  }
  pushSentence(value.length);
  return sentences;
}
