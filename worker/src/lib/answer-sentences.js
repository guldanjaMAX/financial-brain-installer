/**
 * Split a generated answer into sentences without breaking at the dot inside
 * a figure, a URL or a file name.
 *
 * A full stop ends a sentence only when whitespace, a closing quote or
 * bracket, or the end of the text follows it. "$1,234.73", "$1.2 million",
 * "report.pdf" and "https://a.example/x.y" therefore stay inside their
 * sentence. A citation written after the full stop ("done. [2]") still
 * belongs to the sentence before it.
 *
 * Every step that keeps, drops or checks answer sentences must split with
 * this. Splitting on every "." turned a supported "$1,234.73 [1]" into
 * "73 [1]" and a "[1] ... $1,234.73." into a clean, wrong "$1,234.".
 */
export function answerSentences(text) {
  return (String(text || "").match(
    /(?:[^.!?\n]|[.!?](?![\s"'”’)\][]|$))+(?:[.!?]+["'”’)\]]*)?(?:\s*\[\d+\])*/g,
  ) || [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
