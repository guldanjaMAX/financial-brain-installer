// Every branch that brings a Vectorize index under this manifest's control must
// record that ownership in the manifest immediately.
//
// The adoption guard refuses an index this manifest has never named. The
// metadata-index wait that follows creation is deliberately patient, minutes
// long across several properties, and any exit inside it leaves the index
// created in the account. If ownership was not written first, the retry finds an
// index it cannot prove is its own and refuses forever.
//
// This was closed on the API branch and left open on the wrangler branch, which
// is the branch that matters more: wrangler is the ordinary browser sign-in
// lane and the API token is the recovery-only one. A field proof run with a
// token exercised the API path and never touched the path most owners take,
// which is why a source-level check exists at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../brain.mjs", import.meta.url));
const lines = readFileSync(file, "utf8").split("\n");

// Anchor on the OUTCOMES, not on the writes. Checking only the writes that
// already exist cannot notice a branch that never writes at all, which is
// exactly the branch that was broken.
const OUTCOMES = [
  ["adopt", /already exists and this manifest names it, adopting it/],
  ["create via api", /created \(768-dim, cosine\)/],
  ["create via wrangler", /created via wrangler \(768-dim, cosine\)/],
];

const missing = [];
for (const [name, pattern] of OUTCOMES) {
  const at = lines.findIndex((line) => pattern.test(line));
  assert.ok(at >= 0, `could not find the "${name}" vectorize outcome in brain.mjs`);
  // Ownership must be recorded within a short window of the outcome, before the
  // metadata-index wait that follows.
  const window = lines.slice(Math.max(0, at - 3), at + 12).join("\n");
  const claims = /cfg\.vectorize_index = idxName;/.test(window);
  const persists = /saveManifest\(path, m\)/.test(window);
  if (!claims || !persists) missing.push(`${name} (brain.mjs:${at + 1})`);
}

assert.deepEqual(
  missing,
  [],
  `Vectorize ownership is not recorded on: ${missing.join(", ")}. ` +
    "An install interrupted during the metadata-index wait would leave that index unadoptable, " +
    "and the adoption guard would refuse the owner's own retry."
);

console.log(`PASS  all ${OUTCOMES.length} vectorize outcomes record ownership before the metadata wait`);
