#!/usr/bin/env node
// Local reproduction of the 11-16 slow removal (50 Gmail docs, ~35 s, then 503).
// Builds a synthetic SQLite with the real D1 migrations, loads a Gmail-sized
// corpus, then times the exact statements forget() runs in one D1 batch
// (worker/src/lib/store-d1.js forget, the per-group env.DB.batch).
// Local fixture only. Never touches a live Brain.
//
//   nice -n 19 node test/bench/bench-forget-recount.mjs <db-path> [--docs 144161] [--chunks 766859]
//        [--other-docs 94221] [--text-bytes 1200] [--fts-sample 60000] [--rebuild]
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const dbPath = argv.find((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : Number(argv[i + 1]); };
const DOCS = opt("docs", 144161), CHUNKS = opt("chunks", 766859), OTHER = opt("other-docs", 94221);
const TEXT = opt("text-bytes", 1200), FTS_SAMPLE = opt("fts-sample", 60000);
if (!dbPath) { console.error("usage: bench-forget-recount.mjs <db-path> [...]"); process.exit(2); }
const ms = (t) => `${(performance.now() - t).toFixed(0)} ms`;
const words = "invoice moderate please comment review security alert login account update receipt meeting notes payment order shipping newsletter".split(" ");
const text = (i) => { let s = ""; let k = i; while (s.length < TEXT) { s += words[k % words.length] + " " + (k * 2654435761 % 1e9).toString(36) + " "; k += 7; } return s.slice(0, TEXT); };

if (argv.includes("--rebuild") && existsSync(dbPath)) rmSync(dbPath);
const fresh = !existsSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
if (fresh) {
  const dir = resolve(ROOT, "migrations/d1");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(resolve(dir, f), "utf8"));
  db.exec(`INSERT OR IGNORE INTO install_state (id, client_slug, product_version, installed_at) VALUES (1,'bench','0.4.29',datetime('now'))`);
  // Bulk load without per-row triggers, then restore them (same schema as a migrated Brain).
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('documents','chunks')").all();
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  const t0 = performance.now();
  const insDoc = db.prepare(`INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta) VALUES (?,?,?,?,?,?,NULL)`);
  const insChunk = db.prepare(`INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, vector_id) VALUES (?,?,?,?,?,?,?)`);
  const insFam = db.prepare(`INSERT INTO document_family_index (doc_uid, family_doc_uid, declared_family_uid, live) VALUES (?,?,NULL,1)`);
  const perDoc = CHUNKS / DOCS;
  let chunkSeq = 0;
  db.exec("BEGIN");
  const load = (source, n, chunkTotal) => {
    let made = 0;
    for (let i = 0; i < n; i++) {
      const id = (0x19000000000 + i).toString(16);
      const uid = `${source}:${id}`;
      insDoc.run(uid, source, id, `Please moderate ${i}`, 1, `h${i}`);
      insFam.run(uid, uid);
      const want = Math.round((i + 1) * (chunkTotal / n)) - made;
      for (let c = 0; c < want; c++, made++, chunkSeq++) insChunk.run(`${uid}#${c}`, uid, c, text(chunkSeq), source, `Please moderate ${i}`, null);
      if (i % 20000 === 19999) { db.exec("COMMIT; BEGIN"); process.stdout.write(`  ${source} ${i + 1}/${n} ${ms(t0)}\n`); }
    }
    return made;
  };
  const gmailChunks = load("gmail", DOCS, CHUNKS);
  const otherChunks = load("gdrive", OTHER, Math.round(OTHER * 3));
  db.exec("COMMIT");
  for (const t of triggers) db.exec(t.sql);
  db.exec(`INSERT INTO corpus_stats (source, documents, chunks) VALUES ('gmail', ${DOCS}, ${gmailChunks}), ('gdrive', ${OTHER}, ${otherChunks})
           ON CONFLICT(source) DO UPDATE SET documents=excluded.documents, chunks=excluded.chunks`);
  db.exec(`INSERT OR IGNORE INTO document_source_inventory (source) VALUES ('gmail'), ('gdrive')`);
  // FTS: index a sample that includes every bench target (first docs), so the FTS 'delete' trigger is exercised on real postings.
  const tf = performance.now();
  db.exec(`INSERT INTO chunks_fts(rowid, text, title) SELECT id, text, title FROM chunks WHERE id <= ${FTS_SAMPLE}`);
  console.log(`loaded gmail ${DOCS} docs / ${gmailChunks} chunks, gdrive ${OTHER} / ${otherChunks}; load ${ms(t0)}; fts sample ${ms(tf)}`);
}
db.exec("PRAGMA cache_size=-8000"); // 8 MB page cache, like a small DO cache; the OS cache is still warm, so these are lower bounds.

const targetsAt = (offset) => db.prepare(`SELECT doc_uid FROM documents WHERE source='gmail' ORDER BY rowid LIMIT 50 OFFSET ?`).all(offset).map((r) => r.doc_uid);
const marks = Array.from({ length: 50 }, (_, i) => "?" + (i + 1)).join(",");
const recountSql = `INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
  SELECT ?1, COUNT(DISTINCT documents.doc_uid), COUNT(chunks.chunk_uid), (SELECT last_ingest_at FROM corpus_stats WHERE source=?1)
    FROM documents LEFT JOIN chunks ON chunks.doc_uid=documents.doc_uid
   WHERE documents.source=?1 AND documents.deleted_at IS NULL
  ON CONFLICT(source) DO UPDATE SET documents=excluded.documents, chunks=excluded.chunks`;
const stats = () => db.prepare("SELECT documents, chunks FROM corpus_stats WHERE source='gmail'").get();

function run(label, offset, { recount }) {
  const group = targetsAt(offset);
  const m = db.prepare("SELECT instance, nonce, generation FROM ingest_removal_generation WHERE id=1").get();
  const times = {};
  const step = (name, fn) => { const t = performance.now(); const r = fn(); times[name] = Math.round(performance.now() - t); return r; };
  db.exec("BEGIN");
  step("fence", () => db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ingest_removal_generation WHERE id=1 AND instance=?1 AND generation=?2 AND nonce=?3) THEN 1 ELSE json('x') END`).get(m.instance, m.generation, m.nonce));
  step("outbox", () => db.prepare(`INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
     SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?51, 0, NULL FROM chunks WHERE doc_uid IN (${marks})
     ON CONFLICT(chunk_uid) DO UPDATE SET vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at, attempts=0, last_error=NULL`).run(...group, Date.now()));
  const ch = step("delete_chunks", () => db.prepare(`DELETE FROM chunks WHERE doc_uid IN (${marks}) RETURNING chunk_uid`).all(...group).length);
  const dc = step("delete_documents", () => db.prepare(`DELETE FROM documents WHERE doc_uid IN (${marks}) RETURNING doc_uid`).all(...group).length);
  const triggerStats = stats();
  if (recount) step("recount", () => db.prepare(recountSql).run("gmail"));
  step("marker", () => db.prepare("SELECT instance, nonce, generation FROM ingest_removal_generation WHERE id=1").get());
  const t = performance.now(); db.exec("COMMIT"); times.commit = Math.round(performance.now() - t);
  const after = stats();
  const total = Object.values(times).reduce((a, b) => a + b, 0);
  console.log(`${label}: ${dc} docs, ${ch} chunks, total ${total} ms ${JSON.stringify(times)}; trigger counters ${JSON.stringify(triggerStats)} after ${JSON.stringify(after)}`);
  return { total, times, triggerStats, after };
}

console.log("plan(recount):", db.prepare(`EXPLAIN QUERY PLAN ${recountSql.replace(/^INSERT[\s\S]*?SELECT/, "SELECT").replace(/ON CONFLICT[\s\S]*$/, "")}`).all("gmail").map((r) => r.detail).join(" | "));
const truth = () => db.prepare(`SELECT (SELECT COUNT(*) FROM documents WHERE source='gmail' AND deleted_at IS NULL) d, (SELECT COUNT(*) FROM chunks WHERE source='gmail') c`).get();
run("A as-shipped (with recount), batch 1", 0, { recount: true });
run("A as-shipped (with recount), batch 2", 50, { recount: true });
run("B no recount (triggers only), batch 3", 100, { recount: false });
run("B no recount (triggers only), batch 4", 150, { recount: false });
console.log("exact truth after 4 batches:", JSON.stringify(truth()), "counters:", JSON.stringify(stats()));
const t = performance.now();
db.prepare(`SELECT COUNT(*) FROM documents d LEFT JOIN chunks c ON c.doc_uid=d.doc_uid WHERE d.source='gmail' AND d.deleted_at IS NULL`).get();
console.log(`index-only variant COUNT(*) over the same join: ${ms(t)}`);
