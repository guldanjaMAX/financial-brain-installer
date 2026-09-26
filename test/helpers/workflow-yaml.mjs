/**
 * Line-based readers for the reviewed GitHub workflow files, shared by the
 * installer-signing and machine-prep tests.
 *
 * These back exact-set policy checks (the job set, the trigger set), so a key
 * the reader cannot see is a policy hole. They therefore accept every block
 * mapping key spelling YAML allows at a key position: plain keys of any case
 * with underscores or digits, single- or double-quoted keys, and a trailing
 * comment after the colon. Anything at a key position that is not a key
 * (a flow mapping, a sequence item, a duplicate, an under-indented line) throws
 * rather than being skipped, so an unusual spelling fails the check closed.
 */

export class WorkflowParseError extends Error {}

const fail = (message) => { throw new WorkflowParseError(message); };
const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === "" || line.trimStart().startsWith("#");

/** Remove a trailing ` # comment` that is outside quotes. */
export function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        // '' is an escaped quote inside a single-quoted scalar.
        if (quote === "'" && text[index + 1] === "'") index++;
        else quote = null;
      } else if (quote === '"' && char === "\\") {
        index++;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Unquote a scalar written plain, 'single' or "double" quoted. */
export function unquote(text) {
  const value = text.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

const KEY_LINE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#"'{}[\],&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?))\s*:(?:\s(.*))?$/;

/** Parse one `key: value  # comment` line (already known to sit at a key position). */
export function parseKeyLine(line) {
  const match = KEY_LINE.exec(line.trim());
  if (!match) fail(`not a mapping key: ${line.trim()}`);
  const key = match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2] !== undefined ? match[2].replaceAll("''", "'") : match[3];
  return { key, value: stripComment(match[4] ?? "").trim() };
}

/**
 * The children of a block mapping whose lines are `lines`: an ordered list of
 * { key, value, lines } where `lines` is the child's own body.
 */
export function mappingEntries(lines) {
  const content = lines.filter((line) => !isSkippable(line));
  if (content.length === 0) return [];
  const indent = indentOf(content[0]);
  const entries = [];
  for (const line of lines) {
    if (isSkippable(line)) {
      if (entries.length) entries.at(-1).lines.push(line);
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent < indent) fail(`line is indented less than its mapping: ${line.trim()}`);
    if (lineIndent > indent) {
      entries.at(-1).lines.push(line);
      continue;
    }
    if (line.trimStart().startsWith("- ")) fail(`a sequence item where a mapping key belongs: ${line.trim()}`);
    const { key, value } = parseKeyLine(line);
    if (entries.some((entry) => entry.key === key)) fail(`duplicate key ${key}`);
    entries.push({ key, value, lines: [] });
  }
  return entries;
}

/** Top-level keys of a workflow, each with its inline value and body lines. */
export function topLevelEntries(workflow) {
  return mappingEntries(workflow.replaceAll("\r\n", "\n").split("\n"));
}

function topLevel(workflow, ...keys) {
  return topLevelEntries(workflow).find((entry) => keys.includes(entry.key)) ?? null;
}

/**
 * Every event that can start the workflow: block, inline list, or scalar form.
 * YAML 1.1 readers may load a bare `on` key as `true`, so that key counts too.
 */
export function triggerNames(workflow) {
  const on = topLevel(workflow, "on", "true");
  if (!on) return [];
  if (on.value) {
    if (/^\[.*\]$/.test(on.value)) return on.value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    if (/^[{]/.test(on.value)) fail(`flow-mapping triggers are not parsed: ${on.value}`);
    return [unquote(on.value)];
  }
  return mappingEntries(on.lines).map((entry) => entry.key);
}

/** Each job key under `jobs:`, unquoted, mapped to its body text. */
export function workflowJobs(workflow) {
  const jobs = topLevel(workflow, "jobs");
  const map = new Map();
  if (!jobs) return map;
  if (jobs.value) fail(`inline jobs value is not parsed: ${jobs.value}`);
  for (const entry of mappingEntries(jobs.lines)) {
    if (entry.value) fail(`job ${entry.key} has an inline value`);
    map.set(entry.key, `${entry.lines.join("\n")}\n`);
  }
  return map;
}

/**
 * The `permissions` value among the mapping `lines`: null when undeclared, a
 * string (read-all, write-all), {} for `{}`, or a map of scope to access. The
 * key and each scope are read through mappingEntries, so a quoted or commented
 * spelling is seen, and a duplicate key or a flow mapping throws.
 */
export function permissionsIn(lines) {
  const entry = mappingEntries(lines).find((candidate) => candidate.key === "permissions");
  if (!entry) return null;
  if (entry.value === "{}") return {};
  if (entry.value) {
    if (/^[{[]/.test(entry.value)) fail(`flow-style permissions are not parsed: ${entry.value}`);
    return unquote(entry.value);
  }
  const map = {};
  for (const scope of mappingEntries(entry.lines)) {
    if (!scope.value || scope.lines.some((line) => !isSkippable(line))) fail(`unparsed permissions scope ${scope.key}`);
    map[scope.key] = unquote(scope.value);
  }
  return map;
}

/** Top-level permissions of a workflow. */
export const topLevelPermissions = (workflow) => permissionsIn(workflow.replaceAll("\r\n", "\n").split("\n"));

/** Permissions of one job, given its body text from workflowJobs. */
export const jobPermissions = (job) => permissionsIn(job.split("\n"));

/**
 * The steps of one job, given its body text from workflowJobs: each step is its
 * own list of mapping entries, read through mappingEntries so a quoted or
 * commented key (`"uses":`, `'uses':  # note`) is seen exactly like a plain one.
 * A flow-style step, a nested sequence, or a line at the sequence's indent that
 * is not an item throws.
 */
export function jobSteps(job) {
  const entry = mappingEntries(job.split("\n")).find((candidate) => candidate.key === "steps");
  if (!entry) return [];
  if (entry.value === "[]") return [];
  if (entry.value) fail(`inline steps value is not parsed: ${entry.value}`);
  const content = entry.lines.filter((line) => !isSkippable(line));
  if (content.length === 0) return [];
  const indent = indentOf(content[0]);
  const items = [];
  for (const line of entry.lines) {
    if (isSkippable(line)) {
      if (items.length) items.at(-1).push(line);
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent < indent) fail(`line is indented less than its steps: ${line.trim()}`);
    if (lineIndent > indent) {
      if (!items.length) fail(`step content before the first item: ${line.trim()}`);
      items.at(-1).push(line);
      continue;
    }
    const item = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (!item) fail(`not a step item: ${line.trim()}`);
    const rest = item[2] ?? "";
    if (/^[{[]/.test(rest)) fail(`flow-style step is not parsed: ${rest}`);
    // `- key: value` opens the step mapping two columns in; the dash is spacing.
    items.push(rest && !rest.startsWith("#") ? [`${" ".repeat(indent + 2)}${rest}`] : []);
  }
  return items.map((lines) => mappingEntries(lines));
}

/** The `uses` reference of one step (or job) from its entries, or null when it has none. */
export function usesOf(entries) {
  const entry = entries.find((candidate) => candidate.key === "uses");
  if (!entry) return null;
  if (!entry.value || /^[|>]/.test(entry.value) || entry.lines.some((line) => !isSkippable(line))) {
    fail("a uses reference that is not a single-line scalar is not parsed");
  }
  return unquote(entry.value);
}

/**
 * Every action or reusable workflow a workflow calls, in order: each step's
 * `uses` and each job-level `uses`, in any key spelling.
 */
export function workflowUses(workflow) {
  const references = [];
  for (const job of workflowJobs(workflow).values()) {
    const jobUses = usesOf(mappingEntries(job.split("\n")));
    if (jobUses !== null) references.push(jobUses);
    for (const step of jobSteps(job)) {
      const uses = usesOf(step);
      if (uses !== null) references.push(uses);
    }
  }
  return references;
}
