/**
 * The YAML subset parser behind the workflow policy tests (S10-R). It must read
 * every spelling GitHub accepts inside its subset exactly as GitHub does, and
 * throw on everything outside it, so a policy check can never pass by misreading.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  WorkflowParseError, actionName, callsAction, canonicalText, isCheckout, jobPermissions, jobSteps, parseYaml,
  topLevelPermissions, triggerNames, usesOf, workflowJobs, workflowUses,
} from "./helpers/workflow-yaml.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const yaml = (...lines) => `${lines.join("\n")}\n`;
const refuses = (text, pattern) => assert.throws(() => parseYaml(text), (error) =>
  error instanceof WorkflowParseError && pattern.test(error.message), `expected a refusal matching ${pattern}`);

test("block mappings and sequences at any consistent indentation", () => {
  assert.deepEqual(parseYaml(yaml("a:", "   b:", "      - x", "      - y", "   c: z", "d: e")),
    { a: { b: ["x", "y"], c: "z" }, d: "e" });
  // A sequence written flush with its parent key.
  assert.deepEqual(parseYaml(yaml("steps:", "- run: a", "- run: b", "after: 1")), { steps: [{ run: "a" }, { run: "b" }], after: 1 });
  assert.deepEqual(parseYaml(yaml("- - a", "  - b", "- c")), [["a", "b"], "c"]);
  assert.deepEqual(parseYaml(yaml("a:", "b:")), { a: null, b: null });
  assert.deepEqual(parseYaml(yaml("list:", "  -", "    k: v", "  -")), { list: [{ k: "v" }, null] });
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# only a comment\n"), null);
});

test("a sequence dash followed by any number of spaces", () => {
  const expected = { steps: [{ name: "x", uses: "o/r@v", with: { k: "v" } }, { run: "echo" }] };
  for (const spaces of [1, 2, 3, 5]) {
    const column = " ".repeat(2 + 1 + spaces);
    assert.deepEqual(parseYaml(yaml("steps:", `  -${" ".repeat(spaces)}name: x`, `${column}"uses": o/r@v`, `${column}with:`,
      `${column}  k: v`, `  -${" ".repeat(spaces)}run: echo`)), expected, `${spaces} space(s) after the dash`);
  }
  // A later key that does not align with the item's first key is not guessed at.
  refuses(yaml("steps:", "  -   name: x", "    uses: o/r@v"), /line 3: not a mapping key|unexpected indentation|sequence/);
  refuses(yaml("steps:", "  -   name: x", "        uses: o/r@v"), /line 3: a nested mapping inside a plain scalar/);
});

test("quoted keys and values, with their escapes", () => {
  assert.deepEqual(parseYaml(yaml(`"uses": 'o/r@v'`, `'with':`, `  "persist-credentials": "false"`, `  'it''s': 'a ''q'' b'`,
    `esc: "tab\\tquote\\" slash\\\\ unicode\\u00e9"`)),
  { uses: "o/r@v", with: { "persist-credentials": "false", "it's": "a 'q' b" }, esc: 'tab\tquote" slash\\ unicode\u00e9' });
  assert.deepEqual(parseYaml(yaml('"a b" : c')), { "a b": "c" });
  refuses(yaml('a: "\\e"'), /double-quoted escape outside the supported subset/);
  refuses(yaml('a: "open'), /must close on the same line/);
  refuses(yaml("a: 'open", "  more'"), /must close on the same line/);
  refuses(yaml('a: "x" y'), /unexpected text after a quoted scalar/);
  refuses(yaml('a: "x"', '  "y"'), /must fit on one line/);
});

test("comments: full-line, trailing, between keys, and # as content", () => {
  assert.deepEqual(parseYaml(yaml("# head", "a: b # trailing", "  # indented comment between keys", "# column 0 comment",
    "c: 'd # not a comment'  # but this is", 'e: "f # g"', "h: i#j", "k:  # nothing here", "l: m")),
  { a: "b", c: "d # not a comment", e: "f # g", h: "i#j", k: null, l: "m" });
  // A ` #` ends a plain scalar even after a quote character inside it, as YAML reads it.
  assert.deepEqual(parseYaml(yaml(`run: echo "a # b"`)), { run: 'echo "a' });
  assert.deepEqual(parseYaml(yaml("- a # one", "# between items", "- b")), ["a", "b"]);
});

test("flow sequences and mappings on one line", () => {
  assert.deepEqual(parseYaml(yaml("a: [main, 'x y', \"z\", 1, true]", "b: {}", "c: []", "d: { k: v, n: [x, {m: null}] }  # note", "e: [a, ]")),
    { a: ["main", "x y", "z", 1, true], b: {}, c: [], d: { k: "v", n: ["x", { m: null }] }, e: ["a"] });
  refuses(yaml("a: [x,", "  y]"), /must close on the same line/);
  refuses(yaml("a: {k: v"), /flow mapping must close on the same line/);
  refuses(yaml("a: [x, # c", "]"), /comment inside a flow collection/);
  refuses(yaml("a: {k: 1, k: 2}"), /duplicate key "k"/);
  refuses(yaml("a: [k: v]"), /mapping inside a flow sequence/);
  refuses(yaml("a: [x] y"), /unexpected text after a flow collection/);
  refuses(yaml("[a]: b"), /flow collections as keys/);
  refuses(yaml("a: {[x]: y}"), /flow collections as keys/);
});

test("literal and folded block scalars with chomping", () => {
  const doc = parseYaml(yaml(
    "keep: |+", "  a", "", "strip: |-", "  a", "  b", "", "clip: |", "  line 1", "", "    indented # not a comment", "  line 3", "", "",
    "folded: >", "  one", "  two", "", "  three", "    more", "  four", "foldstrip: >-", "  x", "  y", "empty: |", "next: done",
    "commented: |  # header comment", "  body", "seq:", "  - |", "    item", "  - >-", "    f", "    g"));
  assert.deepEqual(doc, {
    keep: "a\n\n",
    strip: "a\nb",
    clip: "line 1\n\n  indented # not a comment\nline 3\n",
    folded: "one two\nthree\n  more\nfour\n",
    foldstrip: "x y",
    empty: "",
    next: "done",
    commented: "body\n",
    seq: ["item\n", "f g"],
  });
  // A step's run block ends at the first line indented at or below its key.
  assert.deepEqual(parseYaml(yaml("steps:", "  - run: |", "      echo a", "      # shell comment", "    # yaml comment", "    id: x")),
    { steps: [{ run: "echo a\n# shell comment\n", id: "x" }] });
  refuses(yaml("a: |2", "   x"), /indentation indicators are not supported/);
  refuses(yaml("a: |-1", "  x"), /indentation indicators are not supported/);
  refuses(yaml("a: |x"), /unexpected text after a block scalar header/);
  refuses(yaml("a: |", "      ", "  x"), /leading blank line is indented more/);
});

test("plain scalars resolve by the YAML 1.2 core schema, as GitHub reads them", () => {
  const doc = parseYaml(yaml("t1: true", "t2: True", "t3: TRUE", "f1: false", "f2: False", "f3: FALSE", "n1: null", "n2: ~", "n3:",
    "i1: 14", "i2: -3", "i3: 0o17", "i4: 0x1F", "fl: 1.5", "exp: 1e3", "inf: .inf", "on: on", "yes: yes", "no: no", "ver: 24.13.1",
    "qt: 'true'", "qn: \"14\"", "expr: ${{ !inputs.flag }}", "hex: 3d3c42e5aac5ba805825da76410c181273ba90b1"));
  assert.deepEqual({ ...doc, nan: undefined }, {
    t1: true, t2: true, t3: true, f1: false, f2: false, f3: false, n1: null, n2: null, n3: null,
    i1: 14, i2: -3, i3: 15, i4: 31, fl: 1.5, exp: 1000, inf: Infinity, on: "on", yes: "yes", no: "no", ver: "24.13.1",
    qt: "true", qn: "14", expr: "${{ !inputs.flag }}", hex: "3d3c42e5aac5ba805825da76410c181273ba90b1", nan: undefined,
  });
  assert.ok(Number.isNaN(parseYaml("a: .nan\n").a));
});

test("a plain scalar may continue on more-indented lines and is folded", () => {
  assert.deepEqual(parseYaml(yaml("uses:", "  actions/upload-artifact@v7", "next: 1")), { uses: "actions/upload-artifact@v7", next: 1 });
  assert.deepEqual(parseYaml(yaml("a: one", "  two", "", "  three", "b: c")), { a: "one two\nthree", b: "c" });
  refuses(yaml("a: one # c", "  two"), /may not continue after a comment/);
  refuses(yaml("a: one", "  b: two"), /nested mapping inside a plain scalar/);
});

test("everything outside the subset throws instead of being guessed at", () => {
  refuses(yaml("a: &anchor x"), /anchors and aliases/);
  refuses(yaml("a: *alias"), /anchors and aliases/);
  refuses(yaml("&a key: x"), /anchors and aliases/);
  refuses(yaml("a: !!str x"), /tags are not supported/);
  refuses(yaml("!t key: x"), /tags are not supported/);
  refuses(yaml("<<: {a: b}"), /merge keys/);
  refuses(yaml("---", "a: b"), /document markers/);
  refuses(yaml("a: b", "---", "c: d"), /document markers/);
  refuses(yaml("a: b", "..."), /document markers/);
  refuses(yaml("%YAML 1.2", "a: b"), /directives/);
  refuses(yaml("? complex", ": value"), /complex keys/);
  refuses(yaml("a:", "\tb: c"), /tabs/);
  refuses(yaml("a:\tb"), /tabs/);
  refuses(yaml("a: b", "\t# tabbed comment"), /tabs/);
  refuses(yaml("a: 1", "a: 2"), /duplicate key "a"/);
  refuses(yaml("uses: x", '"uses": y'), /duplicate key "uses"/);
  refuses(yaml("jobs:", "  one:", "    x: 1", "  'one':", "    x: 2"), /duplicate key "one"/);
  refuses(yaml("a: b: c"), /nested mapping on one line/);
  refuses(yaml("a: - b"), /indicator cannot start this value/);
  refuses(yaml("  a: b"), /must start at column 0/);
  refuses(yaml("a:", "    b: 1", "  c: 2"), /unexpected indentation|content after the end/);
  refuses(yaml("a: 1", "  b: 2"), /nested mapping inside a plain scalar/);
  refuses(yaml("a:", "  - x", "  b: y"), /sequence|not a mapping key|unexpected indentation/);
  refuses(yaml("- a", "b: c"), /content after the end/);
  refuses(yaml("a: @x"), /reserved indicator/);
  // `k:v` is one plain scalar, not a key, so it cannot sit among a mapping's keys.
  assert.equal(parseYaml("a:b\n"), "a:b");
  refuses(yaml("x: 1", "a:b"), /line 2: not a mapping key/);
  assert.throws(() => parseYaml(42), WorkflowParseError);
});

test("action names match case-insensitively, as GitHub resolves owner and repository", () => {
  for (const reference of ["actions/checkout@abc", "Actions/Checkout@abc", "ACTIONS/CHECKOUT@abc", "actions/CHECKOUT@abc"]) {
    assert.equal(isCheckout(reference), true, reference);
    assert.equal(actionName(reference), "actions/checkout");
  }
  assert.equal(isCheckout("actions/checkout-extra@abc"), false);
  assert.equal(isCheckout("other/checkout@abc"), false);
  assert.equal(isCheckout("./actions/checkout"), false);
  assert.equal(callsAction("Actions/Upload-Artifact@abc", "actions/upload-artifact"), true);
});

test("workflow readers read the parsed structure and refuse unexpected shapes", () => {
  const workflow = yaml(
    "on: [push, workflow_dispatch]", "permissions: {}", "jobs:", "  build:", "    permissions: write-all", "    steps:",
    "      -   name: a", "          'uses': Actions/Checkout@abc", "      - run: echo", "  call:", "    uses: o/r/.github/workflows/w.yml@abc");
  assert.deepEqual(triggerNames(workflow), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggerNames(yaml("on: push")), ["push"]);
  assert.deepEqual(triggerNames(yaml("on:", "  push:", "  'pull_request':")), ["push", "pull_request"]);
  // A key a YAML 1.1 reader would load as `on` still counts.
  assert.deepEqual(triggerNames(yaml("on: workflow_dispatch", "true: [push]")), ["workflow_dispatch", "push"]);
  assert.deepEqual(topLevelPermissions(workflow), {});
  const jobs = workflowJobs(workflow);
  assert.deepEqual([...jobs.keys()], ["build", "call"]);
  assert.equal(jobPermissions(jobs.get("build")), "write-all");
  assert.equal(jobPermissions(jobs.get("call")), null);
  assert.equal(usesOf(jobSteps(jobs.get("build"))[0]), "Actions/Checkout@abc");
  assert.deepEqual(workflowUses(workflow), ["Actions/Checkout@abc", "o/r/.github/workflows/w.yml@abc"]);
  assert.throws(() => topLevelPermissions(yaml("permissions:", "  contents: 1")), WorkflowParseError);
  assert.throws(() => topLevelPermissions(yaml("permissions: [read]")), WorkflowParseError);
  assert.throws(() => workflowUses(yaml("jobs:", "  a:", "    steps:", "      - uses:", "          k: v")), WorkflowParseError);
  assert.throws(() => workflowUses(yaml("jobs:", "  a:", "    steps: run")), WorkflowParseError);
  assert.throws(() => workflowUses(yaml("jobs:", "  a:", "    steps:", "      - run")), WorkflowParseError);
  assert.throws(() => workflowJobs(yaml("jobs: [a]")), WorkflowParseError);
  assert.throws(() => triggerNames(yaml("on: [1]")), WorkflowParseError);
  assert.throws(() => triggerNames(yaml("- on")), WorkflowParseError);
});

test("canonical text renders parsed data one key per line for content searches", () => {
  const doc = parseYaml(yaml("'id': provenance", "env:", "  A: '1'", "run: |", "  one", "  two", "with: {}", "list: [a]"));
  assert.equal(canonicalText(doc), "id: provenance\nenv:\n  A: 1\nrun: |\n  one\n  two\nwith: {}\nlist:\n  - a");
});

test("every workflow in the repository is inside the supported subset", () => {
  const directory = join(ROOT, ".github", "workflows");
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const doc = parseYaml(readFileSync(join(directory, name), "utf8"));
    assert.equal(typeof doc, "object", name);
    assert.ok(workflowJobs(doc).size > 0, `${name} has jobs`);
    for (const reference of workflowUses(doc)) assert.equal(typeof reference, "string");
  }
});
