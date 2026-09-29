/**
 * Regression probe for split-document cleanup on a large corpus.
 *
 * Every accepted remote batch reconciles its document families. A lookup that
 * scans the whole documents table therefore turns a linear Gmail sweep into
 * repeated whole-corpus work and eventually reaches D1's CPU limit. Exercise
 * the real store function against SQLite and inspect the exact read plan it
 * issued. The target assertions prove the decision point was reached, so the
 * no-scan assertion cannot pass because cleanup found nothing.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { forgetFamilies } from "../worker/src/lib/store-d1.js";

const db = new DatabaseSync(":memory:");
const migrations = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
  db.exec(readFileSync(join(migrations, file), "utf8"));
}
db.prepare(
  `INSERT INTO install_state
     (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
   VALUES (1, 'fixture', '0.0.0', 48, 0, '2026-01-01T00:00:00Z', 'test')`,
).run();

const insert = db.prepare(
  `INSERT INTO documents
     (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
   VALUES (?, ?, ?, ?, 1, ?, ?)`,
);
const store = (docUid, source, sourceId, metadata = {}) => insert.run(
  docUid,
  source,
  sourceId,
  "Synthetic document",
  `hash:${docUid}`,
  JSON.stringify(metadata),
);

// Noise makes a full-table plan observable without using private corpus data.
for (let index = 0; index < 2_000; index++) {
  const id = `noise-${String(index).padStart(4, "0")}`;
  store(`fixture:${id}`, "fixture", id);
}

const structuralBase = `gmail:${"a".repeat(80)}`;
store(structuralBase, "gmail", "a".repeat(80));
store(`${structuralBase}#part1of2`, "gmail", `${"a".repeat(80)}#part1of2`);
store(`${structuralBase}#part2of2`, "gmail", `${"a".repeat(80)}#part2of2`);
store(`${structuralBase}#paru-neighbor`, "gmail", `${"a".repeat(80)}#paru-neighbor`);

const declaredBase = "upload:synthetic-export.txt";
store("message:session-current", "message", "session-current", { family_of: declaredBase });
store("message:session-stale", "message", "session-stale", { family_of: declaredBase });

const reads = [];
const prepare = (sql) => {
  const shape = (params = []) => ({
    bind: (...next) => shape(next),
    all: async () => {
      if (/NULL AS family_of|json_extract\(meta,'\$\.family_of'\) AS family_of/i.test(sql)) {
        reads.push({ sql, params });
      }
      return { results: db.prepare(sql).all(...params) };
    },
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
    },
    _sql: sql,
    _params: params,
  });
  return shape();
};
const env = {
  STORAGE: "d1",
  DB: {
    prepare,
    batch: async () => {
      throw new Error("dry-run cleanup must not mutate");
    },
  },
};

const structuralReceipt = await forgetFamilies(env, {
  families: [{
    base_doc_uid: structuralBase,
    keep_doc_uids: [structuralBase, `${structuralBase}#part1of2`],
    family_kind: "structural",
  }],
  dryRun: true,
});

assert.equal(reads.length, 1, "the cleanup decision point must execute one bounded family lookup");
assert.deepEqual(
  structuralReceipt.targets,
  [`${structuralBase}#part2of2`],
  "the cleanup control must find the stale structural family member",
);

const plan = db.prepare(`EXPLAIN QUERY PLAN ${reads[0].sql}`).all(...reads[0].params);
const detail = plan.map((row) => String(row.detail || "")).join("\n");
assert.doesNotMatch(detail, /\bSCAN documents\b/i, `family lookup must not scan the corpus:\n${detail}`);
assert.match(
  detail,
  /sqlite_autoindex_documents_1/i,
  `structural family lookup must use the document identity index:\n${detail}`,
);

const declaredReceipt = await forgetFamilies(env, {
  families: [{
    base_doc_uid: declaredBase,
    keep_doc_uids: ["message:session-current"],
    family_kind: "declared",
  }],
  dryRun: true,
});
assert.equal(reads.length, 2, "the declared-family control must execute its own lookup");
assert.deepEqual(
  declaredReceipt.targets,
  ["message:session-stale"],
  "declared message-export cleanup must keep its prior semantics",
);

console.log("family cleanup query: structural families are indexed and declared families keep their scope");
