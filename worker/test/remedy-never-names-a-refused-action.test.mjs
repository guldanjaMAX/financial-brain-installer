// Never prescribe an action the state that produced the message forbids.
//
// A paused brain refuses reindex and drain with 503, and the pause only lifts
// when the update completes. Advising either from inside that state is a closed
// loop: the operator reads a remedy, runs it, is refused, and has learned
// nothing. One client followed exactly that across four update attempts over 97
// hours on 2026-09-08.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remedyForState } from "../src/lib/store-d1.js";

const activeRemedy = "Run `brain reindex <manifest> --yes`.";
assert.equal(
  remedyForState({ VECTOR_DRAIN_MODE: "active" }, activeRemedy),
  activeRemedy,
  "active brains must retain their ordinary recovery command"
);

const pausedRemedy = remedyForState({ VECTOR_DRAIN_MODE: "paused-for-upgrade" }, activeRemedy);
assert.match(pausedRemedy, /paused for an upgrade.*brain update <manifest>/s);
assert.match(pausedRemedy, /only supported projection writer while this barrier holds/s);
assert.doesNotMatch(
  pausedRemedy,
  /Run `brain reindex <manifest>/,
  "paused behavior must not forward the active-only remedy"
);
assert.doesNotMatch(
  pausedRemedy,
  /Once it is running again, the remedy is/,
  "a paused finding must be re-diagnosed after update instead of prescribing a future command now"
);

const pausedQuarantineRemedy = remedyForState(
  { VECTOR_DRAIN_MODE: "paused-for-upgrade" },
  "Use vector-retry, then run `brain drain <manifest>`.",
  { pausedRemedy: "Use the operator vector-retry preview and confirmation, then run `brain update <manifest>`." },
);
assert.match(pausedQuarantineRemedy, /vector-retry.*brain update <manifest>/s);
assert.doesNotMatch(pausedQuarantineRemedy, /brain drain <manifest>/);
assert.doesNotMatch(pausedQuarantineRemedy, /brain reindex <manifest>/);

const source = readFileSync(fileURLToPath(new URL("../src/lib/store-d1.js", import.meta.url)), "utf8")
  .replace(/\r\n/g, "\n");

// Every remedy that names a command the pause refuses must be routed through the
// state-aware wrapper. Anchor on the commands, so a NEW message that advises one
// without the wrapper fails here rather than in a client's terminal.
const REFUSED_WHILE_PAUSED = [/brain reindex <manifest>/g, /brain drain <manifest>/g];

const offenders = [];
for (const pattern of REFUSED_WHILE_PAUSED) {
  for (const match of source.matchAll(pattern)) {
    // Look back far enough to see whether this remedy is wrapped, but not so far
    // that a neighbouring wrapped remedy vouches for an unwrapped one.
    const window = source.slice(Math.max(0, match.index - 420), match.index);
    const isRemedy = /action[:=]|action = /.test(window);
    if (!isRemedy) continue;                       // prose and comments are fine
    if (/remedyForState\(env/.test(window)) continue;
    offenders.push(`${match[0]} at index ${match.index}`);
  }
}

assert.deepEqual(
  offenders,
  [],
  "these remedies name a command a paused brain refuses, without saying so first:\n  " +
    offenders.join("\n  ") +
    "\nRoute them through remedyForState(env, ...) so the advice matches the state."
);

assert.match(
  source,
  /export function remedyForState\(env, remedy, \{ pausedRemedy = null \} = \{\}\)/,
  "the state-aware remedy wrapper must exist"
);
assert.match(
  source,
  /paused for an upgrade, so reindex and drain both return 503/,
  "and it must name the refusal the operator would otherwise walk into"
);

console.log("PASS  no remedy prescribes an action the paused state refuses");
