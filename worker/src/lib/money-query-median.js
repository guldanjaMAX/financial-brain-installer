// SQLite's optional percentile extension is absent from some supported
// runtimes. Rewrite the scalar money form before compilation on every runtime
// so function availability cannot change either its figure or its admission.
export function portableMoneyMedian(sql, tokens) {
  const identifier = t => t && ['word', 'identifier'].includes(t.kind);
  if (tokens[0]?.v !== 'select' || !identifier(tokens[1]) || tokens[1].v !== 'median' || tokens[2]?.v !== '(') return null;
  let i = 3;
  const distinct = tokens[i]?.v === 'distinct';
  if (distinct) i++;
  const start = i;
  if (!identifier(tokens[i])) return null;
  i++;
  if (tokens[i]?.v === '.' && identifier(tokens[i + 1])) i += 2;
  // These are numeric columns in txn and fin_transactions. Do not silently
  // coerce text or reinterpret an arbitrary aggregate/expression as money.
  if (!/^(?:amount|[a-z_]+_minor)$/.test(tokens[i - 1].v) || tokens[i]?.v !== ')') return null;
  const column = sql.slice(tokens[start].start, tokens[i - 1].end);
  let alias = sql.slice(tokens[1].start, tokens[i].end);
  i++;
  if (tokens[i]?.v === 'as') {
    if (!identifier(tokens[++i])) return null;
    alias = tokens[i++].raw;
  } else if (identifier(tokens[i]) && tokens[i].v !== 'from') alias = tokens[i++].raw;
  else alias = '"' + alias.replaceAll('"', '""') + '"';
  if (tokens[i]?.v !== 'from') return null;
  const from = i++;
  if (!identifier(tokens[i]) || !['txn', 'fin_transactions'].includes(tokens[i++].v)) return null;
  if (tokens[i]?.v === 'as') {
    if (!identifier(tokens[++i])) return null;
    i++;
  } else if (identifier(tokens[i]) && tokens[i].v !== 'where') i++;
  if (i < tokens.length && tokens[i]?.v !== 'where') return null;
  let depth = 0;
  for (const t of tokens.slice(i)) {
    if (t.kind === 'punctuation' && t.v === '(') depth++;
    if (t.kind === 'punctuation' && t.v === ')') depth--;
    if (depth === 0 && t.kind === 'word' && ['group', 'having', 'order', 'limit', 'union', 'except', 'intersect', 'window'].includes(t.v)) return null;
  }
  const source = sql.slice(tokens[from].start, tokens.at(-1).end);
  // Rank the complete filtered input before averaging the middle one/two
  // values. NULL is absent evidence; an empty population remains NULL, not $0.
  return `SELECT AVG(money_median_value) AS ${alias} FROM (
    SELECT money_median_value, ROW_NUMBER() OVER (ORDER BY money_median_value) AS money_median_position,
      COUNT(*) OVER () AS money_median_count
    FROM (SELECT ${distinct ? 'DISTINCT ' : ''}${column} AS money_median_value ${source}\n)
    WHERE money_median_value IS NOT NULL
  ) WHERE money_median_position IN ((money_median_count+1)/2,(money_median_count+2)/2)`;
}
