// Two defects a client found by running the product on 2026-09-08.
//
// 1. One symbolic link or junction anywhere under the corpus root refused the
//    ENTIRE ingest, not the link. Same tree, same minute: 0.3.5 sent 3,119
//    documents, 0.4.0 returned INGEST_FAILED. The symlink test runs before the
//    directory test, so node_modules is silently skipped as a real folder and
//    fatal as a junction, and pnpm builds node_modules entirely out of links.
//
// 2. `brain ingest --path` ignored the source this manifest declares for that
//    folder and filed under "upload", while `brain load` honoured it. The same
//    manifest and folder produced two sources, indexing 2,249 documents a second
//    time alongside the 1,537 already there, both live and queryable.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredUploadSourceFor } from "../brain.mjs";

/* ---------------- 1. a link must not refuse the whole walk ---------------- */

const { walk } = await import("../ingest/run.mjs");
const root = mkdtempSync(join(tmpdir(), "ingest-link-"));
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "docs", "statement.txt"), "a real document");
writeFileSync(join(root, "notes.txt"), "another real document");
mkdirSync(join(root, "elsewhere"));
let linked = true;
try {
  symlinkSync(join(root, "elsewhere"), join(root, "node_modules"), "junction");
} catch {
  linked = false; // unprivileged Windows cannot create one; the rest still holds
}

const result = walk(root, { privatePrefixes: [] });
assert.equal(
  result.complete,
  true,
  "a skipped link must not set the walk incomplete: an incomplete walk refuses every " +
    "document, so one junction anywhere under the corpus root blocked the entire ingest"
);
assert.ok(
  result.files.length >= 2,
  `the documents that WERE enumerated must still be sendable, found ${result.files.length}`
);
if (linked) {
  const linkSkip = result.skipped.find((s) => /symbolic links and junctions/.test(s.reason || ""));
  assert.ok(linkSkip, "the link must still be skipped and reported");
  assert.equal(
    linkSkip.subtree,
    true,
    "and marked as a subtree skip, because its children were never enumerated and " +
      "must be shielded from counting as removals"
  );
}
console.log("PASS  a junction is skipped without refusing the documents beside it");

/* ---------------- 2. the declared source wins over "upload" ---------------- */

const manifest = {
  corpora: {
    upload: {
      enabled: true,
      folders: [{ path: "C:\\Users\\evtra\\Brain", source: "financial-brain-archive" }],
    },
  },
};

assert.equal(
  declaredUploadSourceFor(manifest, "C:\\Users\\evtra\\Brain"),
  "financial-brain-archive",
  "a folder declared with a source must resolve to it, or --path files a second copy under 'upload'"
);
assert.equal(
  declaredUploadSourceFor(manifest, "C:\\Users\\evtra\\Brain\\"),
  "financial-brain-archive",
  "a trailing separator is the same folder"
);
assert.equal(
  declaredUploadSourceFor(manifest, "C:\\Users\\evtra\\Other"),
  null,
  "an undeclared folder has no declared source and keeps the default"
);
assert.equal(
  declaredUploadSourceFor({ corpora: { upload: { folders: ["C:\\plain\\path"] } } }, "C:\\plain\\path"),
  null,
  "a bare string folder declares no source"
);
assert.equal(declaredUploadSourceFor({}, "C:\\anything"), null, "no corpus declares nothing");
assert.equal(declaredUploadSourceFor(manifest, ""), null, "an empty path resolves nothing");

console.log("PASS  a folder's declared source is what --path files it under");
