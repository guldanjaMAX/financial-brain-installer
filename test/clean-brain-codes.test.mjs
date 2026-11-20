// Every "Clean my Brain" support code has one help line, and the help page has
// no code the product does not print. The release fails if they drift apart.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CLEAN_CODES, CleanError, formatCleanError, HELP_BASE } from "../operations/clean-brain-codes.mjs";

const help = readFileSync(new URL("../docs/help/clean-my-brain.md", import.meta.url), "utf8");
const sections = new Map([...help.matchAll(/^##+ ([A-Z][A-Z0-9_]+)\n\n([^\n]+)\n/gm)].map((m) => [m[1], m[2]]));

test("every code has a help section carrying its exact help line", () => {
  for (const [code, info] of Object.entries(CLEAN_CODES)) {
    assert.ok(sections.has(code), `${code} has no section in docs/help/clean-my-brain.md`);
    assert.equal(sections.get(code), info.help, `${code}: the help page line differs from the code's help text`);
    assert.ok(info.summary && info.fix && info.help, `${code} needs a summary, a fix and a help line`);
    assert.ok(info.help.length <= 120, `${code}: a help line is one short sentence`);
  }
});

test("the help page names no CLEAN_ code the product does not define", () => {
  const named = new Set(help.match(/\bCLEAN_[A-Z_]+\b/g));
  for (const code of named) assert.ok(code in CLEAN_CODES, `${code} is documented but not defined`);
});

test("every code the Worker routes can return is documented", () => {
  const worker = [
    readFileSync(new URL("../worker/src/lib/owner-removals.js", import.meta.url), "utf8"),
    readFileSync(new URL("../worker/src/lib/ingest-removal-plan.js", import.meta.url), "utf8"),
  ].join("\n");
  const returned = new Set([...worker.matchAll(/"((?:OWNER_REMOVAL_[A-Z_]+|INGEST_REMOVAL_(?:UNAVAILABLE|CAPACITY)))"/g)].map((m) => m[1]));
  assert.ok(returned.size >= 4, "the scan found the Worker's codes");
  for (const code of returned) assert.match(help, new RegExp(`\\b${code}\\b`), `${code} is returned by the Worker but not on the help page`);
});

test("a printed error is code, the system's words, the next step and the link", () => {
  for (const code of Object.keys(CLEAN_CODES)) {
    const lines = formatCleanError(new CleanError(code, { providerMessage: "The provider's own sentence." }));
    assert.match(lines[0], new RegExp(`^${code}: `));
    assert.ok(lines.some((l) => l.includes("The system said: The provider's own sentence.")));
    assert.ok(lines.some((l) => l.startsWith("  Next: ")));
    assert.equal(lines.at(-1), `  More: ${HELP_BASE}/${code}`);
  }
});

test("the CLI's own usage lists the command", () => {
  const cli = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
  assert.match(cli, /brain clean\s+<manifest> --list <ids-file>/);
});
