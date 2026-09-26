/**
 * A small YAML subset parser for the reviewed GitHub workflow files, and the
 * workflow readers the installer-signing and machine-prep policy tests use.
 *
 * WHY THIS EXISTS. Those tests back exact-set security policy: the trigger set,
 * the job set, token scopes, pinned actions, and non-persisting checkouts. Line
 * and regex readers kept missing spellings GitHub accepts (S3-R, S10, S10-R): a
 * step dash followed by several spaces hid a quoted `uses` key, and a
 * mixed-case `Actions/Checkout` escaped the checkout rules. So each workflow is
 * parsed into the objects, arrays and scalars GitHub itself loads, and every
 * policy reads that structure. The package carries no YAML dependency and this
 * helper must not add one, so the parser is local and small, with its own tests
 * in test/workflow-yaml-parser.test.mjs.
 *
 * SUPPORTED SUBSET (block context, one document):
 * - block mappings and block sequences at any consistent indentation, including
 *   a sequence written at the same indentation as its parent key;
 * - a sequence dash followed by any number of spaces (`-   key: v`); the column
 *   where the item's content starts fixes where that item's later keys align;
 * - plain, 'single-quoted' ('' escapes) and "double-quoted" (JSON escapes) keys
 *   and single-line values; a plain value may continue on more-indented lines
 *   and is folded as YAML folds it;
 * - full-line comments, and trailing comments that follow whitespace; a `#`
 *   inside a quoted scalar, or not preceded by whitespace, is content;
 * - single-line flow sequences and mappings of scalars (`[main]`, `{}`,
 *   `{ a: b }`), nested flow collections included;
 * - literal `|` and folded `>` block scalars with the `-` and `+` chomping
 *   indicators;
 * - plain scalars resolved by the YAML 1.2 core schema, as GitHub resolves
 *   them: null (`~`, `null`, empty), booleans (`true`/`True`/`TRUE` and the same
 *   for false), integers (decimal, 0o, 0x), floats, .inf and .nan. `on`, `yes`
 *   and `no` stay strings. Mapping keys are kept as their (unquoted) text.
 *
 * FAILS CLOSED. Anything outside the subset throws WorkflowParseError naming the
 * line, instead of being guessed at: anchors, aliases, tags, `<<` merge keys,
 * directives, document markers (`---`, `...`) and so multiple documents,
 * complex (`?`) keys, flow collections used as keys or spanning lines, quoted
 * scalars spanning lines, comments inside flow collections, block scalar
 * indentation indicators, double-quoted escapes JSON does not define, any tab
 * outside block scalar content, duplicate keys, a document not starting at
 * column 0, unexpected or inconsistent indentation, and a `key: value` nested on
 * one line where YAML forbids it.
 */

export class WorkflowParseError extends Error {}

const INDICATORS = new Set(["-", "?", ":", ",", "[", "]", "{", "}", "#", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`"]);

/** Resolve a plain scalar by the YAML 1.2 core schema. */
export function resolvePlain(text) {
  if (text === "" || text === "~" || /^(?:null|Null|NULL)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

/** Remove a trailing comment: a `#` at the start or after whitespace. Quotes are not special here. */
function stripComment(text) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "#" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trim();
  }
  return text.trim();
}

const isSequenceItem = (content) => content === "-" || /^-\s/.test(content);
const setKey = (map, key, value) => Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });

class Parser {
  constructor(text) {
    if (typeof text !== "string") throw new WorkflowParseError("YAML input must be a string");
    const source = text.replace(/^﻿/, "").replaceAll("\r\n", "\n");
    this.lines = source.split("\n").map((raw, index) => ({ raw, no: index + 1 }));
    if (this.lines.length && this.lines.at(-1).raw === "") this.lines.pop();
    this.pos = 0;
  }

  fail(message, line = this.lines[this.pos]) {
    throw new WorkflowParseError(line ? `line ${line.no}: ${message}` : message);
  }

  /** Structural view of a line: its indent and content. Refuses tabs and document syntax. */
  view(line) {
    if (line.virtual) return line;
    const { raw } = line;
    if (raw.includes("\t")) this.fail("tabs are outside the supported YAML subset", line);
    const content = raw.trimStart();
    const indent = raw.length - content.length;
    if (indent === 0 && /^(?:---|\.\.\.)(?:\s|$)/.test(content)) this.fail("document markers and multiple documents are not supported", line);
    if (indent === 0 && content.startsWith("%")) this.fail("directives are not supported", line);
    return { indent, content, no: line.no };
  }

  isSkippable(line) {
    if (line.virtual) return false;
    const trimmed = line.raw.trim();
    return trimmed === "" || trimmed.startsWith("#");
  }

  /** The next line with content, or null, skipping blank and comment lines. */
  peek() {
    while (this.pos < this.lines.length && this.isSkippable(this.lines[this.pos])) {
      if (this.lines[this.pos].raw.includes("\t")) this.fail("tabs are outside the supported YAML subset");
      this.pos++;
    }
    return this.pos < this.lines.length ? this.view(this.lines[this.pos]) : null;
  }

  parseDocument() {
    const first = this.peek();
    if (!first) return null;
    if (first.indent !== 0) this.fail("the document must start at column 0");
    const node = this.parseBlockNode(0);
    if (this.peek()) this.fail("content after the end of the document's top-level node");
    return node;
  }

  /** A block node whose first line is indented at least `min`; null when there is none. */
  parseBlockNode(min) {
    const line = this.peek();
    if (!line || line.indent < min) return null;
    if (isSequenceItem(line.content)) return this.parseSequence(line.indent);
    if (this.keyOf(line) !== null) return this.parseMapping(line.indent);
    // A scalar written on the line below its key or dash.
    this.pos++;
    return this.parseInlineValue(line.content, min - 1, line);
  }

  parseMapping(indent) {
    const map = {};
    const seen = new Set();
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) this.fail("unexpected indentation inside a mapping");
      if (isSequenceItem(line.content)) this.fail("a sequence item where a mapping key belongs");
      const parsed = this.keyOf(line);
      if (parsed === null) this.fail(`not a mapping key: ${line.content}`);
      const { key, rest } = parsed;
      if (key === "<<") this.fail("merge keys (<<) are not supported");
      if (seen.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      seen.add(key);
      this.pos++;
      setKey(map, key, this.parseValueAfterKey(rest, indent, line));
    }
    return map;
  }

  parseValueAfterKey(rest, indent, line) {
    if (stripComment(rest) === "") {
      const next = this.peek();
      if (!next) return null;
      if (next.indent > indent) return this.parseBlockNode(indent + 1);
      if (next.indent === indent && isSequenceItem(next.content)) return this.parseSequence(indent);
      return null;
    }
    return this.parseInlineValue(rest, indent, line);
  }

  parseSequence(indent) {
    const list = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) this.fail("unexpected indentation inside a sequence");
      // A non-item line at this indent ends a sequence written flush with its parent key.
      if (!isSequenceItem(line.content)) break;
      const afterDash = line.content.slice(1);
      const rest = afterDash.trimStart();
      const column = indent + 1 + (afterDash.length - rest.length);
      if (rest === "" || rest.startsWith("#")) {
        this.pos++;
        const next = this.peek();
        list.push(next && next.indent > indent ? this.parseBlockNode(indent + 1) : null);
        continue;
      }
      // Re-read the item's content as its own line at the column where it starts, so
      // the item's later keys must align with its first key however many spaces
      // follow the dash. A misaligned key then fails instead of vanishing.
      const virtual = { virtual: true, indent: column, content: rest, no: line.no };
      if (isSequenceItem(rest)) {
        this.lines[this.pos] = virtual;
        list.push(this.parseSequence(column));
      } else if (this.keyOf(virtual) !== null) {
        this.lines[this.pos] = virtual;
        list.push(this.parseMapping(column));
      } else {
        this.pos++;
        list.push(this.parseInlineValue(rest, indent, line));
      }
    }
    return list;
  }

  /**
   * A value written on one line after `key:` or `- `. `parent` is the indent of
   * the owning key or dash; any continuation line must be indented past it.
   */
  parseInlineValue(text, parent, line) {
    const first = text[0];
    if (first === "&" || first === "*") this.fail("anchors and aliases are not supported", line);
    if (first === "!") this.fail("tags are not supported", line);
    if (first === "%" || first === "@" || first === "`") this.fail(`a value may not start with the reserved indicator ${first}`, line);
    if (first === "?" && /^\?(?:\s|$)/.test(text)) this.fail("complex keys are not supported", line);
    if (first === "|" || first === ">") return this.parseBlockScalar(text, parent, line);
    let value;
    if (first === '"' || first === "'") {
      const { value: scalar, end } = readQuoted(text, 0, this, line);
      const after = text.slice(end);
      if (after !== "" && (!/^\s/.test(after) || stripComment(after) !== "")) this.fail("unexpected text after a quoted scalar", line);
      value = scalar;
    } else if (first === "[" || first === "{") {
      const flow = new FlowReader(text, this, line);
      value = flow.readNode();
      const after = text.slice(flow.index);
      if (after !== "" && (!/^\s/.test(after) || stripComment(after) !== "")) this.fail("unexpected text after a flow collection", line);
    } else {
      return this.parsePlain(text, parent, line);
    }
    const next = this.peek();
    if (next && next.indent > parent) this.fail("a quoted scalar or flow collection must fit on one line in this subset", next);
    return value;
  }

  parsePlain(text, parent, line) {
    const first = stripComment(text);
    if (/^[-?:](?:\s|$)/.test(first)) this.fail(`a ${first[0]} indicator cannot start this value`, line);
    if (/:(?:\s|$)/.test(first)) this.fail("a nested mapping on one line is not valid YAML", line);
    let commented = first !== text.trim();
    const parts = [first];
    // Continuation lines of a multi-line plain scalar, folded the YAML way: one
    // line break becomes a space, and each blank line becomes a newline.
    for (;;) {
      let blanks = 0;
      let probe = this.pos;
      while (probe < this.lines.length && !this.lines[probe].virtual && this.lines[probe].raw.trim() === "") { blanks++; probe++; }
      if (probe >= this.lines.length || this.lines[probe].virtual) break;
      const raw = this.lines[probe].raw;
      const content = raw.trimStart();
      if (raw.length - content.length <= parent || content.startsWith("#")) break;
      if (commented) this.fail("a plain scalar may not continue after a comment", this.lines[probe]);
      const view = this.view(this.lines[probe]);
      const piece = stripComment(view.content);
      if (/:(?:\s|$)/.test(piece)) this.fail("a nested mapping inside a plain scalar is not valid YAML", view);
      commented = piece !== view.content.trim();
      parts.push(blanks ? "\n".repeat(blanks) : " ", piece);
      this.pos = probe + 1;
    }
    return parts.length === 1 ? resolvePlain(first) : parts.join("");
  }

  parseBlockScalar(header, parent, line) {
    const match = /^([|>])([-+]?)([0-9]?)([-+]?)(.*)$/.exec(header);
    if (match[3] || (match[2] && match[4])) this.fail("block scalar indentation indicators are not supported", line);
    const tail = match[5];
    if (tail !== "" && (!/^\s/.test(tail) || stripComment(tail) !== "")) this.fail(`unexpected text after a block scalar header: ${header}`, line);
    const folded = match[1] === ">";
    const chomping = match[2] || match[4];
    const body = [];
    let contentIndent = null;
    while (this.pos < this.lines.length && !this.lines[this.pos].virtual) {
      const current = this.lines[this.pos];
      const raw = current.raw;
      if (raw.trim() === "") {
        body.push(raw);
        this.pos++;
        continue;
      }
      const indent = raw.length - raw.trimStart().length;
      if (contentIndent === null) {
        if (indent <= parent) break;
        contentIndent = indent;
        if (body.some((blank) => blank.length > contentIndent)) this.fail("a leading blank line is indented more than the block scalar", current);
      }
      if (indent < contentIndent) break;
      if (raw.slice(0, contentIndent).includes("\t")) this.fail("tabs are outside the supported YAML subset", current);
      body.push(raw);
      this.pos++;
    }
    const texts = body.map((raw) => (contentIndent === null || raw.length <= contentIndent ? "" : raw.slice(contentIndent)));
    let result = "";
    let empty = 0;
    let started = false;
    let moreIndented = false;
    for (const text of texts) {
      if (text === "") { empty++; continue; }
      if (!folded) {
        result += "\n".repeat(started ? 1 + empty : empty);
      } else if (text[0] === " " || text[0] === "\t") {
        // More-indented lines keep their line breaks in a folded scalar.
        moreIndented = true;
        result += "\n".repeat(started ? 1 + empty : empty);
      } else if (moreIndented) {
        moreIndented = false;
        result += "\n".repeat(empty + 1);
      } else if (empty === 0) {
        if (started) result += " ";
      } else {
        result += "\n".repeat(empty);
      }
      result += text;
      started = true;
      empty = 0;
    }
    if (chomping === "+") result += "\n".repeat(started ? 1 + empty : empty);
    else if (chomping === "" && started) result += "\n";
    return result;
  }

  /** { key, rest } when the line is `key: ...`, otherwise null. */
  keyOf(line) {
    const { content } = line;
    const first = content[0];
    if (first === '"' || first === "'") {
      const { value, end } = readQuoted(content, 0, this, line);
      const colon = /^ *:(?=\s|$)/.exec(content.slice(end));
      if (!colon) return null;
      return { key: value, rest: content.slice(end + colon[0].length).trim() };
    }
    if (first === "?" && /^\?(?:\s|$)/.test(content)) this.fail("complex keys are not supported", line);
    if (first === "#") return null;
    let index = 0;
    for (; index < content.length; index++) {
      if (content[index] === "#" && index > 0 && /\s/.test(content[index - 1])) return null;
      if (content[index] === ":" && (index + 1 === content.length || /\s/.test(content[index + 1]))) break;
    }
    if (index >= content.length) return null;
    const key = content.slice(0, index).trimEnd();
    if (key === "") this.fail("an empty mapping key is not supported", line);
    if (INDICATORS.has(key[0]) && !/^[-?:]\S/.test(key)) {
      if (key[0] === "[" || key[0] === "{") this.fail("flow collections as keys are not supported", line);
      if (key[0] === "&" || key[0] === "*") this.fail("anchors and aliases are not supported", line);
      if (key[0] === "!") this.fail("tags are not supported", line);
      if (key[0] === "|" || key[0] === ">" || key[0] === "-") return null;
      this.fail(`a key may not start with ${key[0]}`, line);
    }
    return { key, rest: content.slice(index + 1).trim() };
  }
}

/** Read a quoted scalar starting at text[start]; it must close on the same line. */
function readQuoted(text, start, parser, line) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char !== "'") continue;
      if (text[index + 1] === "'") { index++; continue; }
      return { value: text.slice(start + 1, index).replaceAll("''", "'"), end: index + 1 };
    }
    if (char === "\\") { index++; continue; }
    if (char === '"') {
      const body = text.slice(start, index + 1);
      try {
        return { value: JSON.parse(body), end: index + 1 };
      } catch {
        parser.fail(`a double-quoted escape outside the supported subset: ${body}`, line);
      }
    }
  }
  parser.fail("a quoted scalar must close on the same line in this subset", line);
}

/** Single-line flow collections of scalars: [a, 'b'], {}, { k: v, n: [x] }. */
class FlowReader {
  constructor(text, parser, line) {
    this.text = text;
    this.index = 0;
    this.parser = parser;
    this.line = line;
  }

  fail(message) { this.parser.fail(message, this.line); }

  skipSpaces() {
    while (this.text[this.index] === " ") this.index++;
    if (this.text[this.index] === "#") this.fail("a comment inside a flow collection is not supported");
  }

  /** A plain scalar's text up to the next flow indicator or `: `. */
  readPlainText() {
    let end = this.index;
    while (end < this.text.length && !",[]{}".includes(this.text[end]) &&
      !(this.text[end] === ":" && /[\s,\]}]/.test(this.text[end + 1] ?? " ")) &&
      !(this.text[end] === "#" && /\s/.test(this.text[end - 1] ?? ""))) end++;
    const plain = this.text.slice(this.index, end).trim();
    this.index = end;
    return plain;
  }

  readNode() {
    this.skipSpaces();
    const char = this.text[this.index];
    if (char === "[") return this.readSequence();
    if (char === "{") return this.readMapping();
    if (char === '"' || char === "'") {
      const { value, end } = readQuoted(this.text, this.index, this.parser, this.line);
      this.index = end;
      return value;
    }
    if (char === "&" || char === "*") this.fail("anchors and aliases are not supported");
    if (char === "!") this.fail("tags are not supported");
    if (char === "?") this.fail("complex keys are not supported");
    if (char === undefined) this.fail("a flow collection must close on the same line in this subset");
    return resolvePlain(this.readPlainText());
  }

  /** After an entry: `,` continues, `close` ends; returns true when the collection closed. */
  afterEntry(close, kind) {
    this.skipSpaces();
    const char = this.text[this.index];
    if (char === close) { this.index++; return true; }
    if (char !== ",") this.fail(`a flow ${kind} must close on the same line in this subset`);
    this.index++;
    this.skipSpaces();
    if (this.text[this.index] === close) { this.index++; return true; }
    return false;
  }

  readSequence() {
    this.index++;
    const list = [];
    this.skipSpaces();
    if (this.text[this.index] === "]") { this.index++; return list; }
    for (;;) {
      list.push(this.readNode());
      this.skipSpaces();
      if (this.text[this.index] === ":") this.fail("a mapping inside a flow sequence is not supported");
      if (this.afterEntry("]", "sequence")) return list;
    }
  }

  readMapping() {
    this.index++;
    const map = {};
    this.skipSpaces();
    if (this.text[this.index] === "}") { this.index++; return map; }
    for (;;) {
      this.skipSpaces();
      const first = this.text[this.index];
      if (first === "[" || first === "{") this.fail("flow collections as keys are not supported");
      if (first === "?" || first === "&" || first === "*" || first === "!") this.fail(`a flow mapping key may not start with ${first}`);
      let key;
      if (first === '"' || first === "'") {
        const quoted = readQuoted(this.text, this.index, this.parser, this.line);
        key = quoted.value;
        this.index = quoted.end;
      } else {
        key = this.readPlainText();
      }
      this.skipSpaces();
      if (this.text[this.index] !== ":") this.fail("a flow mapping entry needs key: value in this subset");
      this.index++;
      if (Object.hasOwn(map, key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      setKey(map, key, this.readNode());
      if (this.afterEntry("}", "mapping")) return map;
    }
  }
}

/** Parse YAML text in the supported subset into plain objects, arrays and scalars. */
export function parseYaml(text) {
  return new Parser(text).parseDocument();
}

// ---------------------------------------------------------------------------
// Workflow readers. Each accepts workflow text or an already-parsed workflow.

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new WorkflowParseError(message); };

/** The parsed workflow; its top level must be a mapping. */
export function parseWorkflow(workflow) {
  const doc = typeof workflow === "string" ? parseYaml(workflow) : workflow;
  if (!isMapping(doc)) fail("a workflow must be a mapping at the top level");
  return doc;
}

/**
 * Every event that can start the workflow: mapping, list, or single-name form.
 * A YAML 1.1 reader would load a bare `on` key as `true`, so a `true` key's
 * events count too rather than being ignored.
 */
export function triggerNames(workflow) {
  const doc = parseWorkflow(workflow);
  const names = [];
  for (const key of ["on", "true"]) {
    if (!Object.hasOwn(doc, key) || doc[key] === null) continue;
    const on = doc[key];
    if (typeof on === "string") names.push(on);
    else if (Array.isArray(on)) {
      for (const name of on) {
        if (typeof name !== "string") fail(`a trigger list entry is not an event name: ${JSON.stringify(name)}`);
        names.push(name);
      }
    } else if (isMapping(on)) names.push(...Object.keys(on));
    else fail(`the ${key} value is not an event name, list, or mapping`);
  }
  return names;
}

/** Each job id mapped to its parsed job mapping, in order. */
export function workflowJobs(workflow) {
  const doc = parseWorkflow(workflow);
  const map = new Map();
  if (!Object.hasOwn(doc, "jobs") || doc.jobs === null) return map;
  if (!isMapping(doc.jobs)) fail("jobs is not a mapping");
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isMapping(job)) fail(`job ${id} is not a mapping`);
    map.set(id, job);
  }
  return map;
}

/**
 * A `permissions` value normalized: null when undeclared, a string (read-all,
 * write-all), {} for `{}`, or a map of scope to access string. Any other shape
 * throws, so an unusual spelling fails a policy rather than passing it.
 */
export function permissionsOf(owner) {
  if (!Object.hasOwn(owner, "permissions")) return null;
  const permissions = owner.permissions;
  if (typeof permissions === "string") return permissions;
  if (!isMapping(permissions)) fail(`permissions is neither a string nor a mapping: ${JSON.stringify(permissions)}`);
  const map = {};
  for (const [scope, access] of Object.entries(permissions)) {
    if (typeof access !== "string") fail(`permissions scope ${scope} is not a string: ${JSON.stringify(access)}`);
    map[scope] = access;
  }
  return map;
}

/** Top-level permissions of a workflow. */
export const topLevelPermissions = (workflow) => permissionsOf(parseWorkflow(workflow));

/** Permissions of one parsed job. */
export const jobPermissions = (job) => permissionsOf(job);

/** The steps of one parsed job, each a mapping. */
export function jobSteps(job) {
  if (!Object.hasOwn(job, "steps") || job.steps === null) return [];
  if (!Array.isArray(job.steps)) fail("steps is not a sequence");
  for (const step of job.steps) if (!isMapping(step)) fail(`a step is not a mapping: ${JSON.stringify(step)}`);
  return job.steps;
}

/** The `uses` reference of one step or job, or null when it has none. */
export function usesOf(owner) {
  if (!Object.hasOwn(owner, "uses")) return null;
  if (typeof owner.uses !== "string") fail(`a uses reference is not a string: ${JSON.stringify(owner.uses)}`);
  return owner.uses;
}

/**
 * The action a reference names, in lower case: GitHub resolves owner and
 * repository names without regard to case, so `Actions/Checkout@sha` and
 * `actions/checkout@sha` are the same action and must meet the same rules.
 */
export function actionName(reference) {
  const at = reference.indexOf("@");
  return (at < 0 ? reference : reference.slice(0, at)).toLowerCase();
}

/** Whether a reference calls the action `name` (owner/repo), in any letter case. */
export const callsAction = (reference, name) => reference.includes("@") && actionName(reference) === name.toLowerCase();

/** Whether a reference is actions/checkout in any letter case. */
export const isCheckout = (reference) => callsAction(reference, "actions/checkout");

/** Every action or reusable workflow a workflow calls: each job-level and step uses, in order. */
export function workflowUses(workflow) {
  const references = [];
  for (const job of workflowJobs(workflow).values()) {
    const jobUses = usesOf(job);
    if (jobUses !== null) references.push(jobUses);
    for (const step of jobSteps(job)) {
      const uses = usesOf(step);
      if (uses !== null) references.push(uses);
    }
  }
  return references;
}

/**
 * Canonical YAML-like text of a parsed node: one plain key per line, two-space
 * indentation, strings unquoted, multi-line strings as indented `|` blocks. It
 * lets content checks search parsed data in any source spelling. It is for
 * searching only and is never parsed again.
 */
export function canonicalText(node, indent = 0) {
  const pad = " ".repeat(indent);
  const scalar = (value) => (value === null ? "null" : String(value));
  const isEmpty = (value) => (Array.isArray(value) ? value.length === 0 : isMapping(value) && Object.keys(value).length === 0);
  const lines = [];
  const render = (prefix, value) => {
    if (isEmpty(value)) lines.push(`${prefix} ${Array.isArray(value) ? "[]" : "{}"}`);
    else if (Array.isArray(value) || isMapping(value)) lines.push(prefix, canonicalText(value, indent + 2));
    else if (typeof value === "string" && value.includes("\n")) {
      lines.push(`${prefix} |`);
      for (const text of value.replace(/\n$/, "").split("\n")) lines.push(text ? `${pad}  ${text}` : "");
    } else lines.push(`${prefix} ${scalar(value)}`);
  };
  if (Array.isArray(node)) for (const item of node) render(`${pad}-`, item);
  else if (isMapping(node)) for (const [key, value] of Object.entries(node)) render(`${pad}${key}:`, value);
  else lines.push(`${pad}${scalar(node)}`);
  return lines.join("\n");
}
