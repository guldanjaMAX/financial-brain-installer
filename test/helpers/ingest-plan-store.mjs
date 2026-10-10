import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { previewIngestRemovals, applyIngestRemovals } from "../../worker/src/lib/ingest-removal-plan.js";
import { listSourceFamilies } from "../../worker/src/lib/store-d1.js";

export function ingestPlanStore() {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../../migrations/d1/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(directory, file), "utf8"));
  }
  db.exec("INSERT INTO install_state (id,client_slug,product_version,schema_version,installed_at) VALUES (1,'fixture','0.0.0',52,'2026-10-01T00:00:00Z')");
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...values) => shape(values),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => ({ results: db.prepare(sql).all(...params), success: true }),
      sql, params,
    });
    return shape();
  };
  const calls = { preview: 0, apply: 0, batches: 0, inventory: 0 };
  let beforeBatch = null;
  const env = { STORAGE: "d1", INGEST_VERSION: { id: "fixture-runtime-one" }, DB: {
    prepare,
    batch: async (statements) => {
      calls.batches++;
      beforeBatch?.();
      db.exec("BEGIN");
      try {
        const result = statements.map(({ sql, params }) => {
          const rows = db.prepare(sql).all(...params);
          return { results: rows, success: true, meta: { changes: rows.length } };
        });
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } };
  const put = (uid, meta = {}, revision = "v1") => {
    const colon = uid.indexOf(":");
    db.prepare(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
      VALUES (?,?,?,'Synthetic document',1790812800000,?,?)
      ON CONFLICT(doc_uid) DO UPDATE SET content_hash=excluded.content_hash, meta=excluded.meta`)
      .run(uid, uid.slice(0, colon), uid.slice(colon + 1), revision, JSON.stringify(meta));
  };
  return {
    db, env, put, calls,
    uids: () => db.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all().map((row) => row.doc_uid),
    beforeBatch: (fn) => { beforeBatch = fn; },
    request: async ({ body }) => {
      calls[body.action]++;
      return body.action === "preview" ? previewIngestRemovals(env, body) : applyIngestRemovals(env, body);
    },
    inventory: async ({ source, includeServerObservedAt }) => {
      calls.inventory++;
      const result = await listSourceFamilies(env, { source, limit: 1000 });
      const families = new Set(result.families);
      return includeServerObservedAt ? { families, malformedIdentities: new Set(), serverObservedAt: "2026-10-01T00:00:00Z" } : families;
    },
  };
}
