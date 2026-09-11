/**
 * store-d1 — retrieval over Cloudflare alone: D1 for text and keywords,
 * Vectorize for vectors, fusion in the Worker.
 *
 * WHY NOT SUPABASE
 *
 * The install model gives every client their own Cloudflare account. A Supabase
 * dependency means a second vendor to create, and its free tier pauses after
 * inactivity, so a brain queried a few times a week is asleep when it is
 * wanted. This keeps the whole brain inside one account the client owns.
 *
 * THE ONE THING POSTGRES GAVE US THAT THIS DOES NOT
 *
 * A single SQL statement returned both result lists, ranked and fused, with
 * consistent reads. Here they are two systems reached over two network calls,
 * with no transaction between them and no read-after-write guarantee. Every
 * awkward part of this file traces back to that.
 *
 * FUSION IS RRF, NOT SCORE BLENDING
 *
 * Vectorize returns cosine similarity (0..1, higher better). D1 returns bm25
 * (negative, more negative is better). Those scales are not comparable, not the
 * same range, not even the same sign direction, and neither is calibrated
 * across corpora. Any alpha * cosine + (1 - alpha) * normalised_bm25 scheme
 * requires normalising two distributions nobody can observe globally. RRF
 * throws cross-system magnitudes away and uses rank position only, which makes
 * the incomparability disappear. FTS magnitude is consulted only within its
 * own result list to recognize a clearly isolated lexical champion; it is never
 * blended with cosine similarity. Same arithmetic the Postgres version used;
 * the only difference is gathering the lists over two calls instead of one
 * query.
 */

import { currentEvidenceCandidates, hasExplicitCurrentIntent } from "./query-intent.js";
import { authorityFor } from "./evidence-authority.js";
import {
  annotateLineageFamilyTokens, attachEvidenceLineage, evidenceLineageFor,
} from "./evidence-lineage.js";
import {
  PUBLIC_INSTALL_SMOKE_CHUNK,
  PUBLIC_INSTALL_SMOKE_DOC_UID,
  PUBLIC_INSTALL_SMOKE_ID,
  PUBLIC_INSTALL_SMOKE_METADATA,
  PUBLIC_INSTALL_SMOKE_SOURCE,
  PUBLIC_INSTALL_SMOKE_TITLE,
  publicInstallSmokeContentHash,
} from "./install-smoke.js";
import { parseStoredSourceFailureEvidence, sourceReceiptOwnerMessage } from "./source-receipt.js";
import { sourceCoverageFromEvidence } from "./source-coverage.js";
import { scopeIsUnrestricted } from "./grants.js";
import { probeStalledVectorFence } from "./vector-fence-probe.js";
import { publicOwnerNoteProvenance } from "./owner-note-contract.js";
import {
  storedProvenanceAssessment,
  storedProvenanceMarkerAssessment,
} from "./provenance-receipt.js";
import {
  currentMemorySql, legacySchemaMayReadWithoutMemorySupersessions,
  memorySupersessionIntegrityFailure,
} from "./memory-supersession.js";
import {
  DEFAULT_DIAGNOSE_CHUNK_PAGE_BUDGET,
  DEFAULT_DIAGNOSE_CHUNK_PAGE_SIZE,
  DEFAULT_DIAGNOSE_STATEMENT_BUDGET,
  DIAGNOSE_MUTATION_MARKER_SQL,
  mutationMarker,
  mutationMarkerChanges,
  publicMutationMarker,
  scanChunkPages,
} from "./diagnose-scan.js";

const RRF_K = 60;
const LEXICAL_CHAMPION_RATIO = 4;
const LEXICAL_CHAMPION_TARGET_RANK = 5;
const CURRENT_INTENT_RRF_WEIGHT = 1.25;
// An owner-confirmed operative value is an explicit decision, not another vote
// in the historical pile. It gets its own bounded lane only after the ordinary
// current-intent and subject-match guard has selected it.
const OPERATIVE_CURRENT_RRF_WEIGHT = 2;
// The answer route reads at most 900 characters from a retrieved snippet. Keep
// both modalities inside that window when their best chunks differ, rather than
// letting either a keyword-heavy header or a semantically similar preamble erase
// the other chunk's evidence.
const COMPOSED_EVIDENCE_PART_MAX_CHARS = 400;
const HISTORICAL_SOURCE_LABELS = Object.freeze({
  drive: "Google Drive",
  gmail: "Gmail",
  imap: "email",
  calendar: "calendar",
  dropbox: "Dropbox",
  microsoft: "Microsoft 365",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  zoom: "Zoom",
  slack: "Slack",
  notion: "Notion",
  hubspot: "HubSpot",
  quickbooks: "QuickBooks Online",
  plaid: "Plaid",
  upload: "uploaded file",
  "iphone-backup": "iPhone backup",
  "owner-notes": "conversational owner notes",
});

// Migration 0020 populated legacy text columns with native/1. Those columns
// are not extraction proof unless the same row carries a valid receipt.
const assessStoredProvenance = (row) => {
  // Real D1 projections always carry one of these metadata aliases, including
  // an explicit null. A few pure ranking tests intentionally pass a reduced
  // row shape; absence of the projection is not the same as a stored row with
  // no receipt. The latter is gated to unknown below.
  const projected = ["authority_meta", "_authority_meta", "meta", "metadata"]
    .some((key) => Object.prototype.hasOwnProperty.call(row || {}, key));
  return projected ? { ...row, ...storedProvenanceAssessment(row) } : row;
};

function historicalSourceLabel(kind) {
  return HISTORICAL_SOURCE_LABELS[String(kind || "")] || "connected";
}

/**
 * Vectorize caps a vector id at 64 BYTES.
 *
 * Chunk ids are derived from the document path, so any realistically-named file
 * blows through it: "Financial/2026/Q3 Statements/Wells Fargo Business Checking
 * Statement 2026-07.pdf#12" is 89 bytes. The upsert then throws, the drain stops
 * on it, and every chunk behind it in the queue is stranded.
 *
 * What made it dangerous rather than merely broken: ingest still reported
 * documents created, /health still returned ok, setup still said the brain was
 * live, and keyword search still answered. The only signal anywhere was a
 * backlog number that stopped going down. A client hitting this concludes the
 * retrieval is mediocre, not that something failed.
 *
 * So the id sent to Vectorize is a hash. It stays stable across runs, always
 * fits, and the readable chunk_uid remains the join key everywhere else.
 */
export const VECTOR_ID_MAX_BYTES = 64;
export const VECTOR_METADATA_MAX_BYTES = 64;

export async function vectorIdFor(chunkUid) {
  const bytes = new TextEncoder().encode(chunkUid);
  if (bytes.length <= VECTOR_ID_MAX_BYTES) return chunkUid;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Prefixed so a stray id in a log is recognisable as ours rather than opaque.
  return `h:${hex.slice(0, 60)}`;
}

/**
 * Encode an exact-match metadata value without relying on Vectorize's silent
 * 64-byte truncation. The same function is used when vectors are written and
 * when a filter is queried, so long values remain exact rather than sharing a
 * prefix with an unrelated value.
 */
export async function metadataTokenFor(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= VECTOR_METADATA_MAX_BYTES) return text;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `h:${hex.slice(0, 60)}`;
}

// Vectorize caps topK at 100 when neither metadata nor values are returned, and
// 50 otherwise. Metadata prefilters and D1 FTS5 keep this from being equivalent
// to a corpus-size cutoff. The full eval set, not a guessed chunk threshold,
// decides whether candidate depth is sufficient.
const VECTOR_TOPK_MAX = 100;
export const D1_QUERY_BIND_LIMIT = 100;
// Keep one transaction reviewable and bounded independently of the documented
// 1,000-query invocation limit. This is our conservative internal slice, not a
// claimed D1 per-batch platform ceiling. Each chunk needs two statements.
export const D1_TRANSACTION_SLICE_STATEMENTS = 100;
// Ranking prefixes must not change because one route asked for 8 results and
// another asked for 12. Both retrieval systems always contribute the same
// bounded candidate depth; `limit` is applied only after fusion.
export const RETRIEVAL_CANDIDATE_DEPTH = VECTOR_TOPK_MAX;

/**
 * Reciprocal rank fusion.
 *
 * score(d) = sum over lists of  weight / (k + rank(d))
 *
 * A document absent from a list contributes nothing rather than a penalty,
 * which is what lets a strong keyword hit with no vector match still surface.
 */
export function fuseRRF(lists, { k = RRF_K, keyOf = (item) => item?.chunk_uid } = {}) {
  const scores = new Map();
  const seen = new Map();
  let sequence = 0;
  for (const { items, weight = 1.0, itemWeight = () => 1.0 } of lists) {
    items.forEach((item, i) => {
      const uid = keyOf(item);
      if (!uid) return;
      const multiplier = Number(itemWeight(item));
      const contribution = Number(weight) * (Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1) / (k + i + 1);
      if (!Number.isFinite(contribution) || contribution <= 0) return;
      scores.set(uid, (scores.get(uid) || 0) + contribution);
      const prior = seen.get(uid);
      if (!prior || contribution > prior.contribution) {
        seen.set(uid, { item, contribution, sequence: prior?.sequence ?? sequence++ });
      }
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || seen.get(a[0]).sequence - seen.get(b[0]).sequence)
    .map(([uid, score]) => ({ ...seen.get(uid).item, rrf_score: score }));
}

/** Public retrieval is document-ranked even though both indexes store chunks. */
export function retrievalDocumentKey(row) {
  return row?.content_hash
    ? `${row.source || ""}|${row.content_hash}|${row.document_date ?? "undated"}`
    : row?.doc_uid || `${row?.source || ""}|${row?.source_id || row?.title || row?.chunk_uid}`;
}

export function collapseRankedDocuments(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = retrievalDocumentKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function exactTermPositions(text, term) {
  const positions = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(term, cursor);
    if (index < 0) break;
    const before = index === 0 ? "" : text[index - 1];
    const afterIndex = index + term.length;
    const after = afterIndex >= text.length ? "" : text[afterIndex];
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) positions.push(index);
    cursor = index + Math.max(1, term.length);
  }
  return positions;
}

function boundedEvidencePart(value, query) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= COMPOSED_EVIDENCE_PART_MAX_CHARS) return text;

  const lower = text.toLowerCase();
  const terms = [...new Set(String(query || "").toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((term) => term.length >= 2 && !FTS_STOPWORDS.has(term))
    .map((term, order) => ({ term, order, positions: exactTermPositions(lower, term) }))
    .filter((entry) => entry.positions.length > 0)
    .sort((a, b) =>
      a.positions.length - b.positions.length || b.term.length - a.term.length || a.order - b.order
    );

  let anchor = 0;
  if (terms.length) {
    // Anchor on the rarest matching query term. For repeated occurrences, use
    // the window containing the most other query terms. This keeps an exact
    // fact near the end of a long chunk instead of returning only its preamble.
    let bestCoverage = -1;
    for (const position of terms[0].positions) {
      const start = Math.max(0, Math.min(
        text.length - COMPOSED_EVIDENCE_PART_MAX_CHARS,
        position - Math.floor(COMPOSED_EVIDENCE_PART_MAX_CHARS / 2),
      ));
      const window = lower.slice(start, start + COMPOSED_EVIDENCE_PART_MAX_CHARS);
      const coverage = terms.reduce((count, entry) => count + (window.includes(entry.term) ? 1 : 0), 0);
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        anchor = position;
      }
    }
  }

  const start = Math.max(0, Math.min(
    text.length - COMPOSED_EVIDENCE_PART_MAX_CHARS,
    anchor - Math.floor(COMPOSED_EVIDENCE_PART_MAX_CHARS / 2),
  ));
  const end = start + COMPOSED_EVIDENCE_PART_MAX_CHARS;
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = `…${excerpt.slice(1)}`;
  if (end < text.length) excerpt = `${excerpt.slice(0, -1).trimEnd()}…`;
  return excerpt;
}

/**
 * One document can match keywords in one chunk and semantics in another. RRF
 * ranks the document, so its public evidence must preserve both independent
 * reasons it ranked. The bounded composition fits in /think's prompt window and
 * remains deterministic; identical chunks are emitted only once.
 */
function composeDocumentEvidence(vectorRow, keywordRow, query) {
  if (!keywordRow) return vectorRow;
  if (!vectorRow) return keywordRow;

  const keywordText = boundedEvidencePart(keywordRow.text, query);
  const vectorText = boundedEvidencePart(vectorRow.text, query);
  if (!keywordText) return { ...keywordRow, text: vectorText };
  if (!vectorText || keywordRow.chunk_uid === vectorRow.chunk_uid || keywordText === vectorText) {
    return { ...keywordRow, text: keywordText };
  }
  return {
    ...keywordRow,
    text: `Keyword-matched excerpt:\n${keywordText}\n\nSemantic excerpt from the same document:\n${vectorText}`,
  };
}

/**
 * Translate the supported filters into a SQL fragment.
 *
 * All public filters have real D1 columns. Dropping a filter is worse than
 * rejecting it: the answer comes back looking narrowed when it never was.
 */
export const D1_FILTERS = ["source", "entity_slug", "client", "category", "top_folder", "platform", "from", "to"];
export const D1_UNSUPPORTED = [];

export function filterSql(filters = {}, alias = "c", nextParam = 3) {
  const parts = [];
  const params = [];
  const add = (frag, val) => { parts.push(frag.replace("?N", "?" + nextParam++)); params.push(val); };
  if (filters.source) add(`${alias}.source = ?N`, filters.source);
  // Business scope lives on documents. Both retrieval paths hydrate chunks
  // through D1, so this exact predicate is the authority even when Vectorize
  // was queried with the equivalent client pre-filter for candidate recall.
  if (filters.entity_slug) {
    add(`EXISTS (SELECT 1 FROM documents scope_d WHERE scope_d.doc_uid = ${alias}.doc_uid AND scope_d.entity_slug = ?N)`, filters.entity_slug);
  }
  if (filters.client) add(`${alias}.client = ?N`, filters.client);
  if (filters.category) add(`${alias}.category = ?N`, filters.category);
  if (filters.top_folder) add(`${alias}.top_folder = ?N`, filters.top_folder);
  if (filters.platform) add(`${alias}.platform = ?N`, filters.platform);
  // A date filter must not swallow undated rows silently, but it must not keep
  // them either: "since June" cannot be answered by a document with no date.
  // They are excluded, and the undated count is what the gap engine reports.
  if (filters.from) { const t = Date.parse(filters.from); if (Number.isFinite(t)) add(`${alias}.document_date >= ?N`, t); }
  if (filters.to)   { const t = Date.parse(filters.to);   if (Number.isFinite(t)) add(`${alias}.document_date <= ?N`, t); }
  return { clause: parts.length ? " AND " + parts.join(" AND ") : "", params, nextParam };
}

/** Exact D1 authority for a scoped principal. */
export function documentAccessSql(access, chunkAlias = "c", documentAlias = "d", nextParam = 3) {
  if (!access || access.kind !== "grant") return { clause: "", params: [], nextParam };
  if (!access.grantId || !access.entitySlug) {
    // An unreadable or empty grant is never interpreted as an unscoped read.
    return { clause: " AND 1 = 0", params: [], nextParam };
  }
  const grantParameter = `?${nextParam++}`;
  const entityParameter = `?${nextParam++}`;
  return {
    clause:
      ` AND ${documentAlias}.entity_slug = ${entityParameter}` +
      ` AND EXISTS (` +
      `SELECT 1 FROM document_access_documents access_doc ` +
      `WHERE access_doc.grant_id = ${grantParameter} ` +
      `AND access_doc.document_id = ${chunkAlias}.doc_uid ` +
      `AND access_doc.entity_slug = ${documentAlias}.entity_slug ` +
      `AND access_doc.revoked_at IS NULL)`,
    params: [access.grantId, access.entitySlug],
    nextParam,
  };
}

/** A coarse capability grant's zone boundary, applied where chunk text is read. */
export function scopeSql(scope, alias = "c", nextParam = 1) {
  if (scopeIsUnrestricted(scope)) return { clause: "", params: [], nextParam };
  const include = Array.isArray(scope.zones) ? scope.zones.filter(Boolean) : [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.filter(Boolean) : [];
  if (scope.all === true) {
    // Reaching this branch with no usable exclusion means the scope was
    // malformed. It must read nothing rather than silently become `all`.
    if (!exclude.length) return { clause: " AND 1 = 0", params: [], nextParam };
    const outList = exclude.map(() => `?${nextParam++}`).join(",");
    return {
      clause:
        ` AND ${alias}.source IN (` +
        `SELECT name FROM sources ` +
        `WHERE zone IS NOT NULL AND trim(zone) != '' AND zone NOT IN (${outList}))`,
      params: exclude,
      nextParam,
    };
  }
  if (!include.length) return { clause: " AND 1 = 0", params: [], nextParam };
  const params = [];
  const inList = include.map(() => `?${nextParam++}`).join(",");
  params.push(...include);
  let clause = ` AND ${alias}.source IN (SELECT name FROM sources WHERE zone IN (${inList}))`;
  if (exclude.length) {
    const outList = exclude.map(() => `?${nextParam++}`).join(",");
    params.push(...exclude);
    clause += ` AND ${alias}.source NOT IN (SELECT name FROM sources WHERE zone IN (${outList}))`;
  }
  return { clause, params, nextParam };
}

/** Which requested filters this backend cannot honour. */
export function unsupportedFilters(filters = {}) {
  return D1_UNSUPPORTED.filter((k) => filters[k]);
}

const VECTOR_STRING_FILTERS = ["source", "client", "category", "top_folder", "platform"];

/** Build the metadata stored with one vector. D1 remains the exact authority. */
export async function vectorMetadataFor(row) {
  const metadata = {};
  for (const key of VECTOR_STRING_FILTERS) {
    const token = await metadataTokenFor(row[key]);
    if (token !== null) metadata[key] = token;
  }
  const date = Number(row.document_date);
  if (row.document_date !== null && row.document_date !== undefined && Number.isFinite(date)) {
    metadata.document_date = date;
  }
  // Not indexed and never used as a public filter. This is the durable receipt
  // that distinguishes an old vector with the same id from the exact outbox
  // generation just accepted by Vectorize's asynchronous mutation API.
  const generation = Number(row.generation);
  if (Number.isSafeInteger(generation) && generation > 0) {
    metadata.outbox_generation = String(generation);
  }
  return metadata;
}

/** Build the pre-filter Vectorize applies before selecting topK candidates. */
export async function vectorFilterFor(filters = {}) {
  const filter = {};
  for (const key of VECTOR_STRING_FILTERS) {
    const token = await metadataTokenFor(filters[key]);
    if (token !== null) filter[key] = { $eq: token };
  }
  // Entity scope is authoritative only in D1 today. `vector_client` is a
  // private candidate hint, never a D1 predicate and never accepted from the
  // public request body. Scoped search remains explicitly degraded until a
  // canonical entity metadata index is built and reprojected.
  if (filters.vector_client && !filters.client) {
    const token = await metadataTokenFor(filters.vector_client);
    if (token !== null) filter.client = { $eq: token };
  }
  const range = {};
  if (filters.from) {
    const t = Date.parse(filters.from);
    if (Number.isFinite(t)) range.$gte = t;
  }
  if (filters.to) {
    const t = Date.parse(filters.to);
    if (Number.isFinite(t)) range.$lte = t;
  }
  if (Object.keys(range).length) filter.document_date = range;
  return filter;
}

/** Keyword search over D1's FTS5 index, ranked by bm25. */
/**
 * Words carrying no retrieval signal, kept deliberately short.
 *
 * This is a PERFORMANCE list, not a linguistic one. Every entry is a word whose
 * posting list is a large fraction of any English corpus, so walking it costs
 * real time and changes the ranking by approximately nothing. Anything a user
 * might actually be searching FOR stays out of this list, however common: "tax",
 * "pay", "cost", "account" and their like are load bearing.
 */
const FTS_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "out", "so", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
  // Question framing. These are how people phrase a question rather than what
  // they are asking about, and they are as common in prose as the words above.
  "about", "any", "can", "could", "get", "got", "just", "know", "like", "said",
  "say", "says", "should", "some", "tell", "than", "very",
]);

export async function searchKeyword(env, query, { limit, filters = {}, access = null, scope = null } = {}) {
  // FTS5 treats bare punctuation as syntax. A user question with an apostrophe
  // or a hyphen is not a query language expression, so it is quoted as a
  // phrase-free bag of terms rather than passed through raw.
  const raw = String(query || "")
    .replace(/["()*:^-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Drop stopwords before they reach FTS5.
  //
  // BM25 already scores a word that appears in every document at near zero, so
  // "what did we say about" contributes no ranking signal. It does contribute
  // the entire cost: each term is a posting list to walk, and a stopword's list
  // is most of the corpus.
  //
  // Measured on a 900,000 chunk corpus with this exact schema:
  //   selective single term                 0.2 ms
  //   the question OR'd as-is            2,034 ms
  //   the same question, stopwords gone  1,046 ms
  // At roughly 1,000 chunks the difference is invisible, which is why this
  // shipped. It grows with the corpus and reads as "retrieval feels slow"
  // rather than as a fault.
  const content = raw.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase()));

  // A query made entirely of stopwords is still a query. Falling back to the
  // raw terms is slow but correct, and returning nothing would not be.
  const use = content.length ? content : raw;
  const terms = use.map((t) => `"${t}"`).join(" OR ");
  if (!terms) return [];

  const f = filterSql(filters, "c", 3);
  const sc = scopeSql(scope, "d", f.nextParam);
  const a = documentAccessSql(access, "c", "d", sc.nextParam);
  const sql = (memoryClause) => `
    SELECT c.chunk_uid, c.doc_uid, c.text, d.source AS source,
           COALESCE(src.kind, 'unregistered') AS source_kind,
           c.title, c.document_date,
           c.client, c.category, c.top_folder, c.platform,
           d.source_id, d.uri, d.entity_slug, d.content_hash, d.date_source, d.date_reliable,
           d.text_source, d.text_reliable, d.meta AS authority_meta,
           (SELECT head.text FROM chunks head
             WHERE head.doc_uid = d.doc_uid AND head.chunk_ix = 0 LIMIT 1) AS authority_document_head,
           CASE WHEN d.date_source = 'calendar:event_start' AND json_valid(d.meta)
                THEN json_extract(d.meta, '$.start') END AS occurred_at,
           bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.doc_uid = c.doc_uid
    LEFT JOIN sources src ON src.name = d.source
    WHERE chunks_fts MATCH ?1${f.clause}${sc.clause}${a.clause}${memoryClause}
    ORDER BY bm25(chunks_fts)
    LIMIT ?2`;

  const run = (memoryClause) => env.DB.prepare(sql(memoryClause)).bind(
    terms, limit, ...f.params, ...sc.params, ...a.params,
  ).all();
  let response;
  try {
    response = await run(currentMemorySql("d"));
  } catch (error) {
    if (!await legacySchemaMayReadWithoutMemorySupersessions(env, error)) throw error;
    response = await run("");
  }
  const { results } = response;
  return results || [];
}

/**
 * Find document rows that cannot participate in chunk search at all.
 *
 * An exact structured entity boundary uses the entity index. An ordinary owner
 * question has no such boundary, so it inspects a bounded page of all
 * zero-chunk rows and returns an explicit truncation state. That fallback is
 * necessary for older encrypted files whose rows have neither entity_slug nor
 * today's empty-content hash. The caller treats truncation as unknown coverage,
 * so this lookup can never license a false corpus-absence claim. Every ordinary
 * retrieval boundary is repeated here because even aggregate gap reporting
 * must not reveal that a document exists outside the principal's grant or
 * zones.
 */
export async function unchunkedTaxDocumentCandidates(env, {
  entitySlug = null,
  limit = 20,
  filters = {},
  access = null,
  scope = null,
} = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const pageLimit = boundedLimit + 1;

  const entityBound = Boolean(entitySlug);
  const f = filterSql(filters, "d", entityBound ? 3 : 2);
  const sc = scopeSql(scope, "d", f.nextParam);
  const a = documentAccessSql(access, "d", "d", sc.nextParam);
  const selectorSql = entityBound ? "AND d.entity_slug = ?1" : "";
  const limitParameter = entityBound ? "?2" : "?1";
  const binds = entityBound ? [entitySlug, pageLimit] : [pageLimit];
  const { results } = await env.DB.prepare(
    `/* unchunked-tax-document-candidates */
     SELECT d.doc_uid, d.source, COALESCE(src.kind, 'unregistered') AS source_kind,
            d.source_id, d.title, d.uri, d.document_date, d.date_source, d.date_reliable,
            d.entity_slug, d.client, d.category, d.top_folder, d.platform,
            d.text_source, d.text_reliable, d.meta AS authority_meta
       FROM documents d
       LEFT JOIN sources src ON src.name = d.source
      WHERE d.deleted_at IS NULL
        ${selectorSql}
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc_uid = d.doc_uid)
        ${f.clause}${sc.clause}${a.clause}
      ORDER BY d.ingested_at DESC
      LIMIT ${limitParameter}`
  ).bind(...binds, ...f.params, ...sc.params, ...a.params).all();
  const page = (results || []).map(assessStoredProvenance);
  return {
    results: page.slice(0, boundedLimit).map((row) => ({ ...row, has_chunks: false })),
    complete: page.length <= boundedLimit,
  };
}

/** Vector search over Vectorize, hydrated and filtered in D1. */
export async function searchVector(env, embedding, { limit, filters = {}, scope = null } = {}) {
  const topK = Math.min(limit, VECTOR_TOPK_MAX);
  const vectorFilter = await vectorFilterFor(filters);
  const hasFilter = Object.keys(vectorFilter).length > 0;

  // Vectorize applies metadata filters BEFORE topK. D1 repeats the same filter
  // during hydration as the exact authority and as protection against index
  // drift. If an upgraded install is missing a metadata index, the fallback
  // widens the candidate pool before D1 narrows it.
  const query = (withFilter) =>
    env.VECTORIZE.query(embedding, {
      topK: !withFilter && hasFilter ? VECTOR_TOPK_MAX : topK,
      returnValues: false,
      // Metadata is deliberately not returned. It halves topK from 100 to 50, and
      // everything needed is in D1 anyway, keyed by the same chunk_uid.
      returnMetadata: "none",
      ...(withFilter && hasFilter ? { filter: vectorFilter } : {}),
    });

  let res;
  try {
    res = await query(true);
  } catch {
    // The metadata index may not exist on this install. Falling back to an
    // unfiltered query keeps search working, because `source` is re-applied in
    // the hydration WHERE below regardless.
    res = await query(false);
  }

  const ids = (res?.matches || []).map((m) => m.id);
  if (!ids.length) return [];

  // A hashed id cannot be looked up in D1 directly, so those are resolved via
  // the mapping column written at upsert time.
  const hashed = ids.filter((i) => i.startsWith("h:"));
  let hashMap = new Map();
  if (hashed.length) {
    const ph = hashed.map((_, i) => "?" + (i + 1)).join(",");
    const { results: mapped } = await env.DB.prepare(
      `SELECT chunk_uid, vector_id FROM chunks WHERE vector_id IN (${ph})`
    ).bind(...hashed).all();
    hashMap = new Map((mapped || []).map((r) => [r.vector_id, r.chunk_uid]));
  }
  const resolved = ids.map((i) => hashMap.get(i) || i);

  // D1 permits 100 bound values per statement. A full Vectorize page already
  // contains 100 ids, so adding even one exact-authority filter used to make
  // hydration fail and search silently degrade to keyword-only. Partition ids
  // after reserving bind slots for every filter, then restore Vectorize order.
  const f0 = filterSql(filters, "c", 1);
  const filterParameterCount = f0.params.length + scopeSql(scope, "d", f0.nextParam).params.length;
  const hydrationBatchSize = Math.max(1, D1_QUERY_BIND_LIMIT - filterParameterCount);
  const results = [];
  for (let start = 0; start < resolved.length; start += hydrationBatchSize) {
    const batch = resolved.slice(start, start + hydrationBatchSize);
    const placeholders = batch.map((_, i) => "?" + (i + 1)).join(",");
    const f = filterSql(filters, "c", batch.length + 1);
    const sc = scopeSql(scope, "d", f.nextParam);
    const sql = (memoryClause) =>
      `SELECT c.chunk_uid, c.doc_uid, c.text, d.source AS source,
              COALESCE(src.kind, 'unregistered') AS source_kind,
              c.title, c.document_date,
              c.client, c.category, c.top_folder, c.platform,
              d.source_id, d.uri, d.entity_slug, d.content_hash, d.date_source, d.date_reliable,
              d.text_source, d.text_reliable, d.meta AS authority_meta,
              (SELECT head.text FROM chunks head
                WHERE head.doc_uid = d.doc_uid AND head.chunk_ix = 0 LIMIT 1) AS authority_document_head,
              CASE WHEN d.date_source = 'calendar:event_start' AND json_valid(d.meta)
                   THEN json_extract(d.meta, '$.start') END AS occurred_at
       FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid
       LEFT JOIN sources src ON src.name = d.source
       WHERE c.chunk_uid IN (${placeholders})${f.clause}${sc.clause}${memoryClause}`;
    const run = (memoryClause) => env.DB.prepare(sql(memoryClause))
      .bind(...batch, ...f.params, ...sc.params)
      .all();
    let response;
    try {
      response = await run(currentMemorySql("d"));
    } catch (error) {
      if (!await legacySchemaMayReadWithoutMemorySupersessions(env, error)) throw error;
      response = await run("");
    }
    const { results: hydrated } = response;
    results.push(...(hydrated || []));
  }

  const byUid = new Map((results || []).map((r) => [r.chunk_uid, r]));
  // A vector whose chunk is missing from D1 means the two systems have drifted.
  // Dropping it silently would hide that, so it is counted by the caller.
  return resolved.map((id) => byUid.get(id)).filter(Boolean);
}

/**
 * Hybrid search: both lists, fused.
 *
 * Pulls a wider candidate pool than the caller asked for, because fusion can
 * only promote a document that appears in one of the lists.
 */
export async function search(env, {
  query, embedding, limit = 10, filters = {}, weights = {}, rrfK = RRF_K, access = null, scope = null,
}) {
  const pool = RETRIEVAL_CANDIDATE_DEPTH;
  const fusionK = Math.min(Math.max(Number(rrfK) || RRF_K, 1), 1e3);

  const settleModality = (promise) => promise.then(
    (results) => ({ results, error: null }),
    (error) => ({ results: [], error }),
  );
  const [keywordAttempt, vectorAttempt, projection] = await Promise.all([
    settleModality(searchKeyword(env, query, { limit: pool, filters, access, scope })),
    embedding && access?.kind !== "grant" && scopeIsUnrestricted(scope)
      ? settleModality(searchVector(env, embedding, { limit: pool, filters, scope }))
      : Promise.resolve({ results: [], error: null }),
    // Vectorize may return some old/current candidates while a newer accepted
    // changeset is still processing. Non-empty semantic results therefore do
    // not prove the complete D1 corpus is query-visible. Reuse the exact
    // readiness contract that gates health and acceptance so every answer
    // advertises partial projection instead of looking fully healthy.
    embedding && access?.kind !== "grant" && scopeIsUnrestricted(scope)
      ? vectorReadiness(env).catch(() => ({ ready: false }))
      : Promise.resolve(null),
  ]);
  // Ordinary FTS or Vectorize failures remain independent degraded modalities.
  // The correction ledger is shared authority for both, so losing it on schema
  // 37 must stop the whole read instead of becoming a clean empty result.
  const integrityFailure = [keywordAttempt.error, vectorAttempt.error]
    .find((error) => memorySupersessionIntegrityFailure(error));
  if (integrityFailure) throw integrityFailure;
  const kw = keywordAttempt.results.map(assessStoredProvenance);
  const vec = vectorAttempt.results.map(assessStoredProvenance);

  // Both empty is a real answer (nothing matched). Only ONE empty when both
  // were attempted means a subsystem is down, and a caller that cannot tell
  // those apart will report a degraded brain as an empty one.
  //
  // The first branch fires on every freshly installed brain while its index is
  // still projecting, which is exactly when the owner asks their first
  // questions, so this is the ordinary state of a new install rather than a
  // rare fault. `degraded_reason` names WHICH of the two it was, because "still
  // building, ask again shortly" and "the vector query failed" call for
  // different sentences downstream. `degraded` keeps its existing values: it is
  // a wire field older clients already read.
  let degraded = null;
  let degradedReason = null;
  if (access?.kind === "grant") {
    degraded = "scoped-vector";
    degradedReason = "document-scope-keyword-only";
  } else if (!scopeIsUnrestricted(scope)) {
    degraded = "scoped-vector";
    degradedReason = "zone-scope-keyword-only";
  } else if (embedding && projection?.ready !== true) {
    degraded = "vector";
    degradedReason = "projection-incomplete";
  } else if (embedding && vec.length === 0 && kw.length > 0) {
    degraded = "vector";
    degradedReason = "vector-query-failed";
  } else if (!embedding) {
    degraded = "no-embedding";
    degradedReason = "embedding-unavailable";
  }
  if (filters.entity_slug && access?.kind !== "grant" && scopeIsUnrestricted(scope)) {
    degraded = "vector";
    degradedReason = "entity-vector-authority-unindexed";
  }

  // Collapse BEFORE assigning rank positions. Otherwise ten chunks from one
  // file consume ten ranks, and keyword evidence in one chunk cannot combine
  // with semantic evidence from another chunk in the same document.
  const kwDocuments = collapseRankedDocuments(kw);
  const vecDocuments = collapseRankedDocuments(vec);

  const boundedWeight = (value, fallback = 1) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, 0), 10) : fallback;
  };
  const sourceWeight = (row) => Object.prototype.hasOwnProperty.call(weights, row?.source)
    ? boundedWeight(weights[row.source])
    : 1;

  // FTS5's score ratio is meaningful inside one query even though its absolute
  // magnitude is not comparable across corpora or with Vectorize similarity.
  // A bounded third rank list can retain a clearly isolated lexical document
  // without blending those incompatible scores.
  const vectorWeight = boundedWeight(weights.vector);
  const lexicalWeight = boundedWeight(weights.keyword);
  const firstKeyword = kwDocuments[0] || null;
  const firstKeywordMagnitude = Math.abs(Number(firstKeyword?.score));
  const firstKeywordKey = firstKeyword ? retrievalDocumentKey(firstKeyword) : null;
  const nextKeywordDocument = firstKeywordKey === null
    ? null
    : kwDocuments.find((row) => retrievalDocumentKey(row) !== firstKeywordKey) || null;
  const nextKeywordMagnitude = Math.abs(Number(nextKeywordDocument?.score));
  const hasSelectiveKeywordChampion =
    limit >= LEXICAL_CHAMPION_TARGET_RANK &&
    lexicalWeight > 0 &&
    sourceWeight(firstKeyword) > 0 &&
    Number.isFinite(firstKeywordMagnitude) &&
    nextKeywordDocument !== null &&
    Number.isFinite(nextKeywordMagnitude) &&
    nextKeywordMagnitude > 0 &&
    firstKeywordMagnitude >= nextKeywordMagnitude * LEXICAL_CHAMPION_RATIO;

  const rankLists = [
    { items: vecDocuments, weight: vectorWeight, itemWeight: sourceWeight },
    { items: kwDocuments, weight: lexicalWeight, itemWeight: sourceWeight },
  ];
  const currentInputs = [
    ...(vectorWeight > 0 ? vecDocuments : []),
    ...(lexicalWeight > 0 ? kwDocuments : []),
  ];
  const currentDocuments = collapseRankedDocuments(
    currentEvidenceCandidates(query, currentInputs, { filters, owner: env.BRAIN_OWNER }),
  );
  if (currentDocuments.length) {
    rankLists.push({ items: currentDocuments, weight: CURRENT_INTENT_RRF_WEIGHT, itemWeight: sourceWeight });
  }
  const operativeCurrentDocuments = currentDocuments.filter((row) => {
    const authority = authorityFor(row, { query, current: true });
    return authority.operative && authority.authoritative;
  });
  if (operativeCurrentDocuments.length) {
    rankLists.push({
      items: operativeCurrentDocuments,
      weight: OPERATIVE_CURRENT_RRF_WEIGHT,
      itemWeight: sourceWeight,
    });
  }
  let fused = fuseRRF(rankLists, { k: fusionK, keyOf: retrievalDocumentKey });
  if (hasSelectiveKeywordChampion) {
    const rankedDocuments = fused;
    const championDocumentRank = rankedDocuments.findIndex(
      (row) => retrievalDocumentKey(row) === firstKeywordKey,
    );
    if (championDocumentRank >= LEXICAL_CHAMPION_TARGET_RANK) {
      const championChunk = fused.find((row) => retrievalDocumentKey(row) === firstKeywordKey);
      const cutoff = rankedDocuments[LEXICAL_CHAMPION_TARGET_RANK - 1];
      const requiredContribution = Number(cutoff?.rrf_score) - Number(championChunk?.rrf_score) + 1e-12;
      const championSourceWeight = sourceWeight(firstKeyword) || 1;
      const championBoostWeight = Math.min(
        lexicalWeight,
        Math.max(0, requiredContribution * (fusionK + 1) / championSourceWeight),
      );
      if (Number.isFinite(championBoostWeight) && championBoostWeight > 0) {
        fused = fuseRRF([
          ...rankLists,
          { items: [firstKeyword], weight: championBoostWeight, itemWeight: sourceWeight },
        ], { k: fusionK, keyOf: retrievalDocumentKey });
      }
    }
  }

  // RRF combines document scores, but an answer still needs concrete evidence.
  // Preserve both best chunks when the modalities found different passages in
  // the same document. Choosing either one unconditionally fixes one failure by
  // creating its mirror: a name-only keyword header can erase the semantic fact,
  // just as a generic vector chunk can erase an exact billing statement.
  const vectorRepresentatives = new Map();
  if (vectorWeight > 0) {
    for (const row of vecDocuments) {
      const key = retrievalDocumentKey(row);
      if (!vectorRepresentatives.has(key)) vectorRepresentatives.set(key, row);
    }
  }
  const keywordRepresentatives = new Map();
  if (lexicalWeight > 0) {
    for (const row of kwDocuments) {
      const key = retrievalDocumentKey(row);
      if (!keywordRepresentatives.has(key)) keywordRepresentatives.set(key, row);
    }
  }
  fused = fused.map((row) => {
    const key = retrievalDocumentKey(row);
    const representative = composeDocumentEvidence(
      vectorRepresentatives.get(key), keywordRepresentatives.get(key), query,
    );
    return representative
      ? { ...row, ...representative, rrf_score: row.rrf_score }
      : row;
  });

  const documents = [];
  for (const row of fused) {
    // content_hash is an internal dedupe key, not part of the authenticated
    // search response contract or a stable source identifier for clients.
    const authority = authorityFor(row, { query, current: hasExplicitCurrentIntent(query) });
    const lineage = evidenceLineageFor(row, { trustedSourceRecord: authority.owner_confirmed === true });
    const {
      content_hash: _internalContentHash,
      authority_meta: _internalAuthorityMeta,
      _authority_meta: _internalLegacyAuthorityMeta,
      authority_document_head: _internalAuthorityDocumentHead,
      _authority_document_head: _internalLegacyAuthorityDocumentHead,
      ...publicRow
    } = row;
    const writeProvenance = publicOwnerNoteProvenance(
      row.source,
      row.authority_meta ?? row._authority_meta,
    );
    documents.push(attachEvidenceLineage({
      ...publicRow,
      authority,
      lineage: lineage.lineage,
      ...(writeProvenance ? { write_provenance: writeProvenance } : {}),
    }, lineage));
  }
  await annotateLineageFamilyTokens(documents);

  return {
    results: documents.slice(0, limit),
    degraded,
    degraded_reason: degradedReason,
    ignored_filters: unsupportedFilters(filters),
    counts: { keyword: kw.length, vector: vec.length },
  };
}

/**
 * Write a chunk to both systems, D1 first, via the outbox.
 *
 * Order matters and is not arbitrary. D1 is the system of record: a chunk that
 * exists in D1 without a vector is findable by keyword and repairable. A vector
 * with no D1 row is an orphan that returns an id pointing at nothing.
 */
export async function upsertChunks(env, chunks, { expectedContentHash = null } = {}) {
  if (!chunks.length) return { written: 0, queued: 0 };
  const now = Date.now();
  const guarded = typeof expectedContentHash === "string" && expectedContentHash.length > 0;

  const stmts = [];
  for (const c of chunks) {
    // Computed at write time so a search hit can be resolved back to its chunk
    // even when the id had to be hashed to fit Vectorize's 64-byte ceiling.
    c.vector_id = await vectorIdFor(c.chunk_uid);
    const chunkStatement = env.DB.prepare(
      guarded
        ? `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12
           WHERE EXISTS (
             SELECT 1 FROM documents WHERE doc_uid = ?2 AND content_hash = ?13
           )
           ON CONFLICT(chunk_uid) DO UPDATE SET
             text = excluded.text, title = excluded.title,
             document_date = excluded.document_date,
             client = excluded.client, category = excluded.category,
             top_folder = excluded.top_folder, platform = excluded.platform,
             vector_id = excluded.vector_id`
        : `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
           ON CONFLICT(chunk_uid) DO UPDATE SET
             text = excluded.text, title = excluded.title,
             document_date = excluded.document_date,
             client = excluded.client, category = excluded.category,
             top_folder = excluded.top_folder, platform = excluded.platform,
             vector_id = excluded.vector_id`
    ).bind(
      c.chunk_uid, c.doc_uid, c.chunk_ix, c.text, c.source, c.title ?? null,
      c.document_date ?? null, c.client ?? null, c.category ?? null,
      c.top_folder ?? null, c.platform ?? null, c.vector_id,
      ...(guarded ? [expectedContentHash] : [])
    );
    stmts.push(chunkStatement);

    const outboxStatement = env.DB.prepare(
      guarded
        ? `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
           SELECT ?1,?2,'upsert',?3
           WHERE EXISTS (
             SELECT 1 FROM documents WHERE doc_uid = ?4 AND content_hash = ?5
           )
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='upsert', queued_at=?3,
             attempts=0, last_error=NULL`
        : `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
           VALUES (?1,?2,'upsert',?3)
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='upsert', queued_at=?3,
             attempts=0, last_error=NULL`
    ).bind(
      c.chunk_uid, c.vector_id, now,
      ...(guarded ? [c.doc_uid, expectedContentHash] : [])
    );
    stmts.push(outboxStatement);
  }
  // A split document can still contain more than 50 chunks. Keep each internal
  // transaction in a conservative 100-statement slice; the pending marker makes
  // an interrupted later slice recoverable on ordinary retry.
  for (let start = 0; start < stmts.length; start += D1_TRANSACTION_SLICE_STATEMENTS) {
    await env.DB.batch(stmts.slice(start, start + D1_TRANSACTION_SLICE_STATEMENTS));
  }
  return { written: chunks.length, queued: chunks.length };
}

/**
 * A small changed document can stage its complete pending revision in one D1
 * transaction instead of four service-binding round trips. The three fixed
 * statements are the document upsert plus the old-vector queue and chunk
 * delete; every new chunk adds its durable row and outbox row.
 *
 * Larger documents stay on the original resumable path. The 100-statement
 * boundary is our conservative internal transaction slice, distinct from
 * Cloudflare's documented 1,000-query invocation limit. Keeping the fallback
 * means an installer never rejects a valid document merely to gain throughput.
 */
export function canStageDocumentRevision(chunkCount) {
  return Number.isSafeInteger(chunkCount) &&
    chunkCount >= 0 &&
    3 + (chunkCount * 2) <= D1_TRANSACTION_SLICE_STATEMENTS;
}

const hasVerifiedWrite = (result) =>
  Number.isSafeInteger(result?.meta?.changes) && result.meta.changes > 0;

/**
 * Atomically stage one document revision under its unique pending marker.
 *
 * The caller deliberately invokes this once per document. Combining multiple
 * documents into one transaction would save more round trips, but one poison
 * row would then roll back unrelated documents and destroy the batch route's
 * per-document failure-isolation contract.
 */
export async function stageDocumentRevision(env, {
  documentStatement,
  docUid,
  chunks,
  expectedContentHash,
}) {
  if (!documentStatement || typeof docUid !== "string" || !docUid ||
      typeof expectedContentHash !== "string" || !expectedContentHash ||
      !Array.isArray(chunks) || !canStageDocumentRevision(chunks.length)) {
    throw new Error("document revision is not eligible for atomic D1 staging");
  }

  const queuedAt = Date.now();
  const statements = [
    documentStatement,
    env.DB.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
       FROM chunks
       WHERE doc_uid = ?1
         AND EXISTS (
           SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?3
         )
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).bind(docUid, queuedAt, expectedContentHash),
    env.DB.prepare(
      `DELETE FROM chunks WHERE doc_uid = ?1
       AND EXISTS (
         SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?2
       )`
    ).bind(docUid, expectedContentHash),
  ];

  const requiredWriteIndexes = [0];
  for (const chunk of chunks) {
    chunk.vector_id = await vectorIdFor(chunk.chunk_uid);
    requiredWriteIndexes.push(statements.length);
    statements.push(env.DB.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
       SELECT ?1,?2,?3,?4,?5,?6,?7,
              documents.client, documents.category, documents.top_folder, documents.platform, ?8
       FROM documents
       WHERE documents.doc_uid = ?2 AND documents.content_hash = ?9
       ON CONFLICT(chunk_uid) DO UPDATE SET
         text = excluded.text, title = excluded.title,
         document_date = excluded.document_date,
         client = excluded.client, category = excluded.category,
         top_folder = excluded.top_folder, platform = excluded.platform,
         vector_id = excluded.vector_id`
    ).bind(
      chunk.chunk_uid, chunk.doc_uid, chunk.chunk_ix, chunk.text, chunk.source,
      chunk.title ?? null, chunk.document_date ?? null, chunk.vector_id,
      expectedContentHash
    ));

    requiredWriteIndexes.push(statements.length);
    statements.push(env.DB.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
       SELECT ?1,?2,'upsert',?3
       WHERE EXISTS (
         SELECT 1 FROM documents WHERE doc_uid = ?4 AND content_hash = ?5
       )
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='upsert', queued_at=?3,
         attempts=0, last_error=NULL`
    ).bind(chunk.chunk_uid, chunk.vector_id, queuedAt, chunk.doc_uid, expectedContentHash));
  }

  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length) {
    throw new Error("atomic D1 staging returned an incomplete result set");
  }
  if (requiredWriteIndexes.some((index) => !hasVerifiedWrite(results[index]))) {
    // D1 includes trigger effects in meta.changes, so a successful guarded
    // write may report more than one row. Zero or a malformed count still means
    // ownership was not proven and must never receive a successful receipt.
    throw new Error("atomic D1 staging could not verify revision ownership");
  }

  return { written: chunks.length, queued: chunks.length };
}

/**
 * Queue every current vector for a document and remove its D1 chunks in one D1
 * transaction. A following upsert for a retained chunk uid changes that queue
 * row back to `upsert`; chunks removed by a shorter revision remain `delete`.
 */
export async function replaceDocumentChunks(env, docUid, { expectedContentHash = null } = {}) {
  const now = Date.now();
  const guarded = typeof expectedContentHash === "string" && expectedContentHash.length > 0;
  await env.DB.batch([
    env.DB.prepare(
      guarded
        ? `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
           SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
           FROM chunks
           WHERE doc_uid = ?1
             AND EXISTS (
               SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?3
             )
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
             attempts=0, last_error=NULL`
        : `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
           SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
           FROM chunks WHERE doc_uid = ?1
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
             attempts=0, last_error=NULL`
    ).bind(docUid, now, ...(guarded ? [expectedContentHash] : [])),
    env.DB.prepare(
      guarded
        ? `DELETE FROM chunks WHERE doc_uid = ?1
           AND EXISTS (
             SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?2
           )`
        : "DELETE FROM chunks WHERE doc_uid = ?1"
    ).bind(docUid, ...(guarded ? [expectedContentHash] : [])),
  ]);
}

/** Keep Vectorize deletion and its D1 CAS cleanup in conservative 100-row slices. */
const DELETE_BATCH = 100;

// The HTTP drain has a 180-second client deadline and both HTTP and cron paths
// are capped at ten 100-row batches. Twenty minutes is deliberately longer
// than one supported invocation while still making an abruptly terminated
// owner self-heal without operator access. This is a safety lease, not a lock
// that can remain held forever.
export const DRAIN_LEASE_TTL_MS = 20 * 60 * 1000;

// Cloudflare counts every statement submitted through D1, including each
// statement inside DB.batch(), toward the documented 1,000-query Worker
// invocation limit. Keep the drain below a stricter internal budget so its
// compare-and-swap lease release always has reserved headroom.
export const DRAIN_D1_QUERY_BUDGET = 900;
const DRAIN_LEASE_ACQUIRE_QUERIES = 1;
const DRAIN_LEASE_RELEASE_QUERIES = 1;
// Fence read plus either exact-cut update, or probe renewal and receipt write.
const DRAIN_PROJECTION_VERIFY_QUERIES = 3;
const DRAIN_INITIAL_DEPTH_QUERIES = 1;
const DRAIN_RETRY_STATE_QUERIES = 2;
const DRAIN_BATCH_SIZE_MAX = 100;
export const VECTOR_RETRY_MAX_ATTEMPTS = 5;
const VECTOR_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/**
 * Drop retry state whose outbox row is gone. The retry table is keyed by
 * (chunk_uid, generation) and a newer ingest bumps the generation, so without
 * this a re-ingested chunk would inherit the previous generation's attempt
 * count and backoff. Bounded per call so it can never dominate the drain's
 * query budget.
 */
async function cleanupVectorRetryState(env, limit = 500) {
  await env.DB.prepare(
    `DELETE FROM vector_outbox_retry_state
      WHERE rowid IN (
        SELECT s.rowid FROM vector_outbox_retry_state s
         WHERE NOT EXISTS (
           SELECT 1 FROM vector_outbox o
            WHERE o.chunk_uid=s.chunk_uid AND o.generation=s.generation
         )
         LIMIT ?
      )`
  ).bind(limit).run();
}

function vectorRetryDelay(attempt) {
  return VECTOR_RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), VECTOR_RETRY_DELAYS_MS.length - 1)];
}

/**
 * Record one failed attempt per row: bump the attempt count, push the next
 * eligible time out along the backoff ladder, and quarantine the row once it
 * has spent its attempts.
 *
 * This replaced a bare `attempts = attempts + 1` on the outbox row. Counting
 * attempts without also recording WHEN the row may be tried again is what let
 * a single failing row be re-selected as the head of every batch, so the whole
 * queue advanced at that row's failure rate.
 */
async function scheduleVectorFailures(env, rows, {
  failureCode,
  error,
  now = Date.now(),
} = {}) {
  if (!rows.length) return { scheduled: 0, quarantined: 0 };
  const detail = String(error || "vector operation failed").slice(0, 300);
  const statements = [];
  let quarantined = 0;
  for (const row of rows) {
    const attempt = Math.max(0, Number(row.attempts || 0)) + 1;
    // A visibility mismatch is a systemic confirmation artifact, never a
    // property of the row: quarantining on it strands healthy rows behind an
    // operator ceremony after any stall lasting a few cycles. The backoff
    // ladder still applies (capped at its last rung), so these rows retry
    // forever instead of dying.
    const quarantineAt = failureCode !== "visibility_mismatch" &&
      attempt >= VECTOR_RETRY_MAX_ATTEMPTS ? now : null;
    if (quarantineAt !== null) quarantined++;
    const nextAttemptAt = quarantineAt === null ? now + vectorRetryDelay(attempt) : now;
    statements.push(env.DB.prepare(
      `INSERT INTO vector_outbox_retry_state
         (chunk_uid,generation,attempts,next_attempt_at,last_attempt_at,quarantined_at,failure_code,last_error)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(chunk_uid,generation) DO UPDATE SET
         attempts=excluded.attempts,
         next_attempt_at=excluded.next_attempt_at,
         last_attempt_at=excluded.last_attempt_at,
         quarantined_at=excluded.quarantined_at,
         failure_code=excluded.failure_code,
         last_error=excluded.last_error`
    ).bind(
      row.chunk_uid, row.generation, attempt, nextAttemptAt, now,
      quarantineAt, failureCode, detail,
    ));
    statements.push(env.DB.prepare(
      `UPDATE vector_outbox SET attempts=?, last_error=?
       WHERE chunk_uid=? AND generation=?`
    ).bind(attempt, detail, row.chunk_uid, row.generation));
  }
  await env.DB.batch(statements);
  return { scheduled: rows.length - quarantined, quarantined };
}

// One two-phase slice either submits or confirms. The largest path is an upsert
// submission: queue/fence/delete/upsert reads plus the durable fence, final
// depth, one submission receipt per row, and one legacy hashed-id remap per row.
// Confirmation needs only one CAS statement per row. Reserving this bound before
// provider work keeps the lease release inside the invocation budget.
export function drainBatchQueryUpperBound(batchSize = DRAIN_BATCH_SIZE_MAX) {
  const bounded = Number.isInteger(batchSize)
    ? Math.min(DRAIN_BATCH_SIZE_MAX, Math.max(1, batchSize))
    : DRAIN_BATCH_SIZE_MAX;
  // +1 renews and re-proves the owner immediately before the one possible
  // provider mutation in this slice. Five more cover the bounded legacy
  // bootstrap status/page/transaction/depth path when a confirmation empties
  // the current page.
  return 12 + (2 * bounded);
}

const drainLeaseChanges = (result) => Number(
  result?.meta?.changes ?? result?.changes ?? 0
);

/**
 * Atomically claim the one Vectorize-writer lease for this brain.
 *
 * The opaque owner is returned only to the in-memory caller so release can use
 * compare-and-swap. Busy receipts deliberately contain only aggregate timing;
 * neither an API response nor a log ever needs the owner token.
 */
export async function acquireDrainLease(env, {
  ownerToken = crypto.randomUUID(),
  now = Date.now(),
  ttlMs = DRAIN_LEASE_TTL_MS,
} = {}) {
  if (typeof ownerToken !== "string" || !ownerToken || ownerToken.length > 200) {
    throw new Error("vector drain lease owner is invalid");
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 ||
      ttlMs > DRAIN_LEASE_TTL_MS) {
    throw new Error("vector drain lease timing is invalid");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("vector drain lease expiry is invalid");
  }

  let claimed;
  try {
    claimed = await env.DB.prepare(
      `UPDATE install_state
       SET vector_drain_lease_owner = ?1,
           vector_drain_lease_expires_at = ?2
       WHERE id = 1
         AND schema_version >= 12
         AND (vector_drain_lease_owner IS NULL
              OR vector_drain_lease_expires_at IS NULL
              OR vector_drain_lease_expires_at <= ?3)`
    ).bind(ownerToken, expiresAt, now).run();
  } catch {
    throw new Error("vector drain lease could not be acquired");
  }
  if (drainLeaseChanges(claimed) === 1) {
    return { acquired: true, ownerToken, expiresAt };
  }

  // Do not read or return the current owner's token. The aggregate held/expiry
  // state is enough to distinguish a legitimate busy lease from a missing or
  // malformed install row, which must fail closed rather than start a drain.
  let state;
  try {
    state = await env.DB.prepare(
      `SELECT CASE WHEN vector_drain_lease_owner IS NULL THEN 0 ELSE 1 END AS held,
              CASE WHEN schema_version >= 12 THEN 1 ELSE 0 END AS schema_ready,
              vector_drain_lease_expires_at AS expires_at
       FROM install_state WHERE id = 1`
    ).first();
  } catch {
    throw new Error("vector drain lease state could not be verified");
  }
  if (!state || Number(state.schema_ready) !== 1 || Number(state.held) !== 1) {
    throw new Error("vector drain lease state is unavailable");
  }
  const observedExpiry = Number(state.expires_at);
  const retryAfterMs = Number.isSafeInteger(observedExpiry)
    ? Math.max(1_000, Math.min(DRAIN_LEASE_TTL_MS, observedExpiry - now))
    : DRAIN_LEASE_TTL_MS;
  return {
    acquired: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
  };
}

/** Release only the lease still owned by this invocation. */
export async function releaseDrainLease(env, ownerToken) {
  if (typeof ownerToken !== "string" || !ownerToken) return false;
  let released;
  try {
    released = await env.DB.prepare(
      `UPDATE install_state
       SET vector_drain_lease_owner = NULL,
           vector_drain_lease_expires_at = NULL
       WHERE id = 1 AND vector_drain_lease_owner = ?1`
    ).bind(ownerToken).run();
  } catch {
    throw new Error("vector drain lease could not be released; it will expire automatically");
  }
  return drainLeaseChanges(released) === 1;
}

/** Renew and prove the same lease immediately before a Vectorize mutation. */
export async function renewDrainLease(env, ownerToken, {
  now = Date.now(),
  ttlMs = DRAIN_LEASE_TTL_MS,
} = {}) {
  if (typeof ownerToken !== "string" || !ownerToken || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > DRAIN_LEASE_TTL_MS) {
    throw new Error("vector drain lease renewal input is invalid");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("vector drain lease renewal expiry is invalid");
  let renewed;
  try {
    renewed = await env.DB.prepare(
      `UPDATE install_state
          SET vector_drain_lease_expires_at = ?3
        WHERE id = 1 AND schema_version >= 12
          AND vector_drain_lease_owner = ?1
          AND vector_drain_lease_expires_at > ?2`
    ).bind(ownerToken, now, expiresAt).run();
  } catch {
    throw new Error("vector drain lease could not be renewed before provider write");
  }
  if (drainLeaseChanges(renewed) !== 1) {
    throw new Error("vector drain lease ownership or expiry was lost before provider write");
  }
  return { expiresAt };
}

const VECTOR_MUTATION_ID_MAX_CHARS = 200;

function acceptedMutationId(receipt) {
  const id = receipt?.mutationId;
  if (typeof id !== "string" || !id || id.length > VECTOR_MUTATION_ID_MAX_CHARS ||
      /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Vectorize did not return a valid asynchronous mutation receipt");
  }
  return id;
}

/** Store the provider receipt before any affected outbox row can be confirmed. */
async function recordSubmittedMutation(env, rows, op, receipt, submittedAt = Date.now()) {
  const mutationId = acceptedMutationId(receipt);
  if (!Number.isSafeInteger(submittedAt) || submittedAt < 0) {
    throw new Error("the vector mutation submission time is invalid");
  }
  const fence = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_mutation_id = ?1,
            vector_projection_submitted_at = ?2
      WHERE id = 1 AND schema_version >= 12`
  ).bind(mutationId, submittedAt).run();
  if (drainLeaseChanges(fence) !== 1) {
    throw new Error("the vector mutation receipt could not be recorded durably");
  }

  if (rows.length) {
    if (op === "upsert") {
      // Do this for every accepted upsert, including a legacy short id whose
      // chunks.vector_id is NULL. The receipt below is conditional on this
      // exact durable hydration mapping.
      const remaps = rows;
      if (remaps.length) {
        // Persist the actual hashed provider id before the accepted row receipt.
        // If this batch fails, the global fence remains durable and the outbox
        // generation stays unsubmitted/retryable; it can never false-green.
        const remapChanges = await env.DB.batch(remaps.map((row) => env.DB.prepare(
          `UPDATE chunks SET vector_id = ?2
            WHERE chunk_uid = ?1
              AND EXISTS (
                SELECT 1 FROM vector_outbox
                 WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?3
              )`
        ).bind(row.chunk_uid, row.vector_id, row.generation)));
        if (!Array.isArray(remapChanges) || remapChanges.length !== remaps.length) {
          throw new Error("the accepted vector id remap could not be recorded");
        }
      }
    }
    const statements = rows.map((row) => op === "delete"
      ? env.DB.prepare(
        `UPDATE vector_outbox
              SET submitted_mutation_id = ?4, submitted_at = ?5, last_error = NULL
            WHERE chunk_uid = ?1 AND op = 'delete'
              AND COALESCE(vector_id, chunk_uid) = ?2 AND generation = ?3`
      ).bind(row.chunk_uid, row.vector_id || row.chunk_uid, row.generation, mutationId, submittedAt)
      : env.DB.prepare(
          `UPDATE vector_outbox
              SET submitted_mutation_id = ?3, submitted_at = ?4, last_error = NULL
            WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?2
              AND EXISTS (
                SELECT 1 FROM chunks
                 WHERE chunk_uid = ?1 AND vector_id = ?5
              )`
        ).bind(row.chunk_uid, row.generation, mutationId, submittedAt, row.vector_id));
    const changes = await env.DB.batch(statements);
    if (!Array.isArray(changes) || changes.length !== rows.length) {
      throw new Error("the vector mutation row receipts were ambiguous");
    }
    return {
      mutationId,
      submitted: changes.reduce((total, result) =>
        total + Number(drainLeaseChanges(result) === 1), 0),
    };
  }
  return { mutationId, submitted: 0 };
}

async function projectionFenceState(env) {
  const state = await env.DB.prepare(
    `SELECT vector_projection_mutation_id AS mutation_id,
            vector_projection_submitted_at AS submitted_at
       FROM install_state WHERE id = 1 AND schema_version >= 12`
  ).first();
  if (!state) throw new Error("vector visibility receipt state is unavailable");
  if (state.mutation_id === null || state.mutation_id === undefined || state.mutation_id === "") {
    return { mutationId: null, submittedAt: null };
  }
  const mutationId = String(state.mutation_id);
  const submittedAt = Number(state.submitted_at);
  if (!mutationId || mutationId.length > VECTOR_MUTATION_ID_MAX_CHARS ||
      /[\u0000-\u001f\u007f]/.test(mutationId) || !Number.isSafeInteger(submittedAt) || submittedAt < 0) {
    throw new Error("vector visibility receipt state is invalid");
  }
  return { mutationId, submittedAt };
}

const VECTOR_FENCE_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * True when the index has processed at least up to the recorded fence.
 *
 * The watermark id is opaque, so a differing id alone is ambiguous: not yet
 * ours, or already past ours. Requiring exact equality turned that ambiguity
 * into a permanent stall the moment any mutation this fence did not record
 * processed after ours - a crash between the provider accepting a changeset
 * and the fence write landing, or any out-of-band mutation. The watermark can
 * then never equal the recorded id again, so every drain cycle waits forever
 * while ingest keeps queueing behind it. The brain stays up, answers
 * questions, and reports healthy the entire time.
 *
 * The mutation log is totally ordered and FIFO-applied, which is the
 * precondition for a single high-water mark to mean anything at all, so a
 * processed mutation dated a full skew margin after our recorded submission
 * proves ours is behind it. Row-level truth still comes from the getByIds
 * proofs in confirmSubmittedVectors: a delete is only ever confirmed by
 * absence, so an open fence confirms nothing by itself.
 *
 * Returns true (covered), false (not yet), or null when the provider response
 * carries no usable watermark shape - each caller keeps its own contract
 * error for that case.
 */
function fenceWatermarkCovers(fence, info) {
  const processed = info?.processedUpToMutation;
  // A brand-new index legitimately reports no processed watermark while its
  // first accepted changeset is still pending. That is "not yet", not a
  // malformed response. Other shapes still fail closed.
  if (processed === null || processed === undefined || processed === "") return false;
  if (typeof processed !== "string" && typeof processed !== "number") return null;
  if (String(processed) === fence.mutationId) return true;
  const processedAt = Date.parse(String(info?.processedUpToDatetime ?? ""));
  return Number.isFinite(processedAt) &&
    Number.isSafeInteger(fence.submittedAt) &&
    processedAt >= fence.submittedAt + VECTOR_FENCE_CLOCK_SKEW_MS;
}

async function projectionFenceProcessed(env, fence, lease) {
  if (!fence?.mutationId) return true;
  const description = await env.VECTORIZE.describe();
  const covered = fenceWatermarkCovers(fence, description);
  if (covered === null) {
    throw new Error("Vectorize did not expose its processed mutation watermark");
  }
  if (!covered && lease) {
    await probeStalledVectorFence(env, { fence, description, lease, renewLease: renewDrainLease });
    // Probe acceptance is not confirmation. A later invocation observes its
    // processed receipt before any normal write or outbox acknowledgement.
  }
  return covered;
}

/** Mark the full projection verified only across one exact, empty-queue cut. */
async function markProjectionVerifiedIfExact(env, lease) {
  const description = await env.VECTORIZE.describe();
  const vectorCount = Number(
    description?.vectorCount ?? description?.vectorsCount ?? description?.count,
  );
  if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) return false;
  const fence = await projectionFenceState(env);
  const processed = fence.mutationId === null
    ? true
    : fenceWatermarkCovers(fence, description) === true;
  if (!processed) {
    if (lease) {
      await probeStalledVectorFence(env, { fence, description, lease, renewLease: renewDrainLease });
    }
    // Even an empty outbox must wait for its durable global ordering fence.
    // Probe acceptance never certifies the provider's current projection.
    return false;
  }
  const result = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_status = 'verified'
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status = 'pending'
        AND (vector_projection_bootstrap_high_water IS NULL OR
             vector_projection_bootstrap_cursor = vector_projection_bootstrap_high_water)
        AND COALESCE(vector_projection_mutation_id, '') = ?1
        AND NOT EXISTS (SELECT 1 FROM vector_outbox)
        AND (SELECT count(*) FROM chunks) = ?2`
  ).bind(fence.mutationId || "", vectorCount).run();
  return drainLeaseChanges(result) === 1;
}

/**
 * Confirm provider-visible effects for one previously accepted changeset.
 *
 * The processed watermark is an ordering fence for deletes and for generations
 * replaced while an older mutation was in flight. getByIds then proves the
 * exact upsert generation, rather than accepting an old vector with the same id.
 */
const VECTOR_GET_BY_IDS_LIMIT = 20;

async function confirmSubmittedVectors(env, rows, lease) {
  if (!rows.length) return { confirmed: 0, confirmedDeletes: 0, confirmedUpserts: 0, retrying: 0, waiting: 0 };
  const fence = await projectionFenceState(env);
  if (!await projectionFenceProcessed(env, fence, lease)) {
    return { confirmed: 0, confirmedDeletes: 0, confirmedUpserts: 0, retrying: 0, waiting: rows.length };
  }

  // A legacy/bootstrap outbox row may still carry the long chunk_uid even
  // though this Worker deterministically hashed it for Vectorize. Do not trust
  // that stale upsert field for visibility or CAS. Deletes must keep using the
  // exact historical stored id because their chunk row may already be gone.
  rows = await Promise.all(rows.map(async (row) => ({
    ...row,
    provider_vector_id: row.op === "upsert"
      ? await vectorIdFor(row.chunk_uid)
      : row.vector_id || row.chunk_uid,
  })));
  const ids = [...new Set(rows.map((row) => row.provider_vector_id))];
  const visible = [];
  for (let start = 0; start < ids.length; start += VECTOR_GET_BY_IDS_LIMIT) {
    let page;
    try {
      page = await env.VECTORIZE.getByIds(ids.slice(start, start + VECTOR_GET_BY_IDS_LIMIT));
    } catch (error) {
      throw new Error(`the vector index could not verify accepted changes: ${String(error?.message || error).slice(0, 240)}`);
    }
    if (!Array.isArray(page)) {
      // Do not acknowledge an earlier page until every requested id has an
      // unambiguous readback receipt.
      throw new Error("the vector index returned an invalid visibility receipt");
    }
    visible.push(...page);
  }
  const byId = new Map(visible.map((vector) => [vector?.id, vector]));
  let confirmed = [];
  let retrying = [];
  for (const row of rows) {
    const vectorId = row.provider_vector_id;
    const vector = byId.get(vectorId);
    const exactGeneration = String(vector?.metadata?.outbox_generation ?? "") === String(row.generation);
    if ((row.op === "delete" && !vector) || (row.op === "upsert" && exactGeneration)) {
      confirmed.push(row);
    } else {
      retrying.push(row);
    }
  }

  if (confirmed.length) {
    const changes = await env.DB.batch(confirmed.map((row) => row.op === "delete"
      ? env.DB.prepare(
        `DELETE FROM vector_outbox
          WHERE chunk_uid = ?1 AND op = 'delete'
            AND COALESCE(vector_id, chunk_uid) = ?2 AND generation = ?3
            AND submitted_mutation_id = ?4`
      ).bind(row.chunk_uid, row.provider_vector_id, row.generation, row.submitted_mutation_id)
      : env.DB.prepare(
        `DELETE FROM vector_outbox
          WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?2
            AND submitted_mutation_id = ?3`
      ).bind(row.chunk_uid, row.generation, row.submitted_mutation_id)));
    if (!Array.isArray(changes) || changes.length !== confirmed.length) {
      throw new Error("the vector confirmation receipts were ambiguous");
    }
    confirmed = confirmed.filter((_, index) => drainLeaseChanges(changes[index]) === 1);
  }
  if (retrying.length) {
    const detail = "accepted Vectorize mutation was processed but the exact vector state was not query-visible; retrying";
    // Clear the submitted receipt first, then record the failure against only
    // the rows whose compare-and-swap actually won. chunk_uid is the outbox
    // primary key, so (chunk_uid, generation, submitted_mutation_id) already
    // identifies the row exactly and the op/vector_id branches added nothing.
    const changes = await env.DB.batch(retrying.map((row) => env.DB.prepare(
      `UPDATE vector_outbox
          SET submitted_mutation_id = NULL, submitted_at = NULL
        WHERE chunk_uid = ? AND generation = ? AND submitted_mutation_id = ?`
    ).bind(row.chunk_uid, row.generation, row.submitted_mutation_id)));
    if (!Array.isArray(changes) || changes.length !== retrying.length) {
      throw new Error("the vector retry receipts were ambiguous");
    }
    retrying = retrying.filter((_, index) => drainLeaseChanges(changes[index]) === 1);
    await scheduleVectorFailures(env, retrying, {
      failureCode: "visibility_mismatch",
      error: detail,
      now: lease.now(),
    });
  }
  return {
    confirmed: confirmed.length,
    confirmedDeletes: confirmed.filter((row) => row.op === "delete").length,
    confirmedUpserts: confirmed.filter((row) => row.op === "upsert").length,
    retrying: retrying.length,
    waiting: 0,
  };
}

async function submitQueuedDeletes(env, rows, lease) {
  if (!rows.length) return 0;
  try {
    await renewDrainLease(env, lease.ownerToken, { now: lease.now() });
    const receipt = await env.VECTORIZE.deleteByIds(rows.map((row) => row.vector_id || row.chunk_uid));
    return (await recordSubmittedMutation(env, rows, "delete", receipt)).submitted;
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 300);
    await scheduleVectorFailures(env, rows, {
      failureCode: "delete_provider_failure",
      error: detail,
      now: lease.now(),
    }).catch(() => {});
    const wrapped = new Error(`the vector index could not durably accept this delete batch: ${detail}`);
    wrapped.vectorDeleteFailed = true;
    throw wrapped;
  }
}

/**
 * Drain the outbox into Vectorize.
 *
 * Separate from the write on purpose. Vectorize acknowledges a write before the
 * index reflects it (seconds for a small upsert, minutes for a large batch), so
 * pretending the write completed inline would make read-after-write look
 * broken. Draining separately makes the lag a visible queue instead.
 */
// Retry classes that may ride in a full batch. visibility_mismatch means the
// mutation was accepted but its effect was not yet query-visible: a systemic
// condition, never a property of the row - the fence stall that creates these
// rows en masse would otherwise serialize the whole queue to one row per
// cycle behind them. embedding_failure is already isolated per-row inside the
// embed loop below. Every other class (provider batch rejections, and legacy
// rows carrying no recorded class) keeps the exclusive head slice, which is
// how one poison row proves itself alone.
const VECTOR_BATCH_SAFE_RETRY_CODES = new Set(["visibility_mismatch", "embedding_failure"]);
const headRetryNeedsIsolation = (row) =>
  Number(row?.attempts || 0) > 0 &&
  !VECTOR_BATCH_SAFE_RETRY_CODES.has(String(row?.failure_code || ""));

async function drainOutboxBatch(env, {
  embed,
  embedBatch,
  batchSize = 100,
  embedGroup = 50,
  lease,
  skipUpserts = false,
} = {}) {
  // First finish the second phase of accepted asynchronous mutations. A newer
  // enqueue clears its submitted receipt through the generation trigger, so a
  // stale confirmation can never acknowledge the newer operation.
  const { results: submittedRows } = await env.DB.prepare(
    `SELECT o.chunk_uid, COALESCE(o.vector_id, c.vector_id, o.chunk_uid) AS vector_id,
            o.op, o.queued_at, o.generation, o.submitted_mutation_id, o.submitted_at,
            COALESCE(s.attempts, o.attempts, 0) AS attempts
       FROM vector_outbox o LEFT JOIN chunks c ON c.chunk_uid = o.chunk_uid
       LEFT JOIN vector_outbox_retry_state s
         ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
      WHERE o.submitted_mutation_id IS NOT NULL
      ORDER BY o.queued_at LIMIT ?1`
  ).bind(batchSize).all();
  if (submittedRows?.length) {
    const confirmed = await confirmSubmittedVectors(env, submittedRows, lease);
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: confirmed.confirmed,
      deleted: confirmed.confirmedDeletes,
      upserted: confirmed.confirmedUpserts,
      submitted: 0,
      waiting: confirmed.waiting,
      failed: confirmed.retrying,
      remaining: Number(rest?.n || 0),
      errors: confirmed.retrying ? ["accepted vector state was not visible and was re-queued"] : [],
    };
  }

  // An accepted mutation can lose its per-row marker if a newer ingest replaces
  // every affected generation. The global fence must still process before any
  // newer provider write is accepted, or the older result could land last.
  const fence = await projectionFenceState(env);
  if (!await projectionFenceProcessed(env, fence, lease)) {
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    const remaining = Number(rest?.n || 0);
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0,
      waiting: remaining, failed: 0, remaining, errors: [],
    };
  }

  // Delete first. Orphans still consume Vectorize candidate slots even though
  // D1 hydration makes them unreachable, so leaving them behind damages recall.
  const { results: deletePending } = await env.DB.prepare(
    `SELECT o.chunk_uid, COALESCE(o.vector_id, o.chunk_uid) AS vector_id,
            o.queued_at, o.generation, COALESCE(s.attempts,o.attempts,0) AS attempts,
            s.failure_code
       FROM vector_outbox o
       LEFT JOIN vector_outbox_retry_state s
         ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
      WHERE o.op = 'delete' AND o.submitted_mutation_id IS NULL
        AND s.quarantined_at IS NULL
        AND COALESCE(s.next_attempt_at,0) <= ?1
      ORDER BY o.queued_at LIMIT ?2`
  ).bind(lease.now(), batchSize).all();
  if (deletePending?.length) {
    const selected = headRetryNeedsIsolation(deletePending[0])
      ? deletePending.slice(0, 1)
      : deletePending;
    const submitted = await submitQueuedDeletes(env, selected, lease);
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: 0, deleted: 0, upserted: 0, submitted, waiting: submitted,
      failed: 0, remaining: Number(rest?.n || 0), errors: [],
    };
  }

  // A residue-only re-projection owns every queued upsert row; the paused drain
  // only clears what that walk cannot page (deletes, and rows already submitted).
  if (skipUpserts) {
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0,
      failed: 0, remaining: Number(rest?.n || 0), errors: [],
    };
  }
  const { results: pending } = await env.DB.prepare(
    `SELECT o.chunk_uid, o.queued_at, o.generation,
            COALESCE(s.attempts,o.attempts,0) AS attempts,
            s.failure_code,
            c.text, c.source, c.doc_uid, c.document_date,
            c.client, c.category, c.top_folder, c.platform
     FROM vector_outbox o JOIN chunks c ON c.chunk_uid = o.chunk_uid
     LEFT JOIN vector_outbox_retry_state s
       ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
     WHERE o.op = 'upsert' AND o.submitted_mutation_id IS NULL
       AND s.quarantined_at IS NULL
       AND COALESCE(s.next_attempt_at,0) <= ?1
     ORDER BY o.queued_at LIMIT ?2`
  )
    .bind(lease.now(), batchSize)
    .all();

  if (!pending?.length) {
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0,
      failed: 0, remaining: Number(rest?.n || 0), errors: [],
    };
  }

  // Bisection: once the head row is retrying for a reason the provider owns,
  // it takes the slice alone. Sending it back inside a full batch would make
  // its next rejection reject its healthy neighbours too, which is how one bad
  // row stalls a whole queue instead of proving itself.
  const selectedPending = headRetryNeedsIsolation(pending[0])
    ? pending.slice(0, 1)
    : pending;
  const vectors = [];
  const idToChunk = new Map();
  // Capture every selected token before embedding starts. A poison row can
  // fail before it becomes a vector, but its failure receipt still needs the
  // exact generation CAS. Building this map only after a successful embed
  // would silently leave those rows at attempts=0 forever.
  const chunkGeneration = new Map(
    selectedPending.map((row) => [row.chunk_uid, row.generation])
  );
  const poisoned = [];

  // Embed in groups when the caller can. One round trip per group instead of one
  // per chunk is the difference between 1,200 chunks/hour and a number that
  // finishes while the client is still on the call.
  //
  // A failed group falls back to embedding its members one at a time. That keeps
  // the poison-isolation guarantee exactly as it was: a single bad chunk
  // quarantines itself rather than taking the other 49 down with it.
  const embedded = new Array(selectedPending.length).fill(undefined);
  if (embedBatch) {
    for (let i = 0; i < selectedPending.length; i += embedGroup) {
      const group = selectedPending.slice(i, i + embedGroup);
      try {
        const out = await embedBatch(group.map((r) => r.text));
        if (!Array.isArray(out) || out.length !== group.length) {
          throw new Error(`embedBatch returned ${out?.length ?? 0} vectors for ${group.length} texts`);
        }
        out.forEach((v, k) => { embedded[i + k] = v; });
      } catch {
        for (let k = 0; k < group.length; k++) {
          try {
            embedded[i + k] = await embed(group[k].text);
          } catch (e) {
            poisoned.push({ chunk_uid: group[k].chunk_uid, error: String(e.message || e).slice(0, 200) });
          }
        }
      }
    }
  }

  for (let idx = 0; idx < selectedPending.length; idx++) {
    const row = selectedPending[idx];
    let values = embedded[idx];
    if (values === undefined) {
      if (embedBatch && poisoned.some((p) => p.chunk_uid === row.chunk_uid)) continue;
      try {
        values = await embed(row.text);
      } catch (e) {
        // One unembeddable chunk must not strand every chunk behind it. Record the
        // failure against that row and carry on; the queue keeps draining.
        poisoned.push({ chunk_uid: row.chunk_uid, error: String(e.message || e).slice(0, 200) });
        continue;
      }
    }
    const vid = await vectorIdFor(row.chunk_uid);
    idToChunk.set(vid, row.chunk_uid);
    vectors.push({
      id: vid,
      values,
      metadata: await vectorMetadataFor(row),
    });
  }

  let submitted = 0;
  if (vectors.length) {
    try {
      await renewDrainLease(env, lease.ownerToken, { now: lease.now() });
      const receipt = await env.VECTORIZE.upsert(vectors);
      const submittedRows = vectors.map((vector) => ({
        chunk_uid: idToChunk.get(vector.id),
        generation: chunkGeneration.get(idToChunk.get(vector.id)),
        vector_id: vector.id,
      }));
      submitted = (await recordSubmittedMutation(env, submittedRows, "upsert", receipt)).submitted;
    } catch (e) {
      // Acceptance and its D1 receipt are one phase. If either fails, leave the
      // row queued so a later idempotent upsert creates a newer ordering fence.
      const err = String(e.message || e).slice(0, 300);
      await scheduleVectorFailures(env, vectors.map((vector) => ({
        chunk_uid: idToChunk.get(vector.id),
        generation: chunkGeneration.get(idToChunk.get(vector.id)),
        attempts: selectedPending.find((row) => row.chunk_uid === idToChunk.get(vector.id))?.attempts || 0,
      })), {
        failureCode: "upsert_provider_failure",
        error: err,
        now: lease.now(),
      }).catch(() => {});
      const e2 = new Error(`the vector index could not durably accept this batch: ${err}`);
      e2.vectorUpsertFailed = true;
      throw e2;
    }
  }

  // A poisoned row never entered the accepted mutation and stays fresh in the
  // queue. Accepted rows also stay queued, now in submitted state, until a later
  // invocation observes the exact generation through getByIds().
  if (poisoned.length) {
    await Promise.all(poisoned.map((poison) => scheduleVectorFailures(env, [{
      chunk_uid: poison.chunk_uid,
      generation: chunkGeneration.get(poison.chunk_uid),
      attempts: selectedPending.find((row) => row.chunk_uid === poison.chunk_uid)?.attempts || 0,
    }], {
      failureCode: "embedding_failure",
      error: poison.error,
      now: lease.now(),
    }))).catch(() => {});
  }

  const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  return {
    drained: 0,
    deleted: 0,
    upserted: 0,
    submitted,
    waiting: submitted,
    failed: poisoned.length,
    remaining: Number(rest?.n || 0),
    errors: poisoned.slice(0, 3).map((p) => p.error),
  };
}

async function drainOutboxWithLease(env, options, lease) {
  await requireVectorRetryStateTable(env);
  await cleanupVectorRetryState(env);
  const rawMaxBatches = Number(options.maxBatches ?? 1);
  const maxBatches = Number.isInteger(rawMaxBatches)
    ? Math.min(10, Math.max(1, rawMaxBatches))
    : 1;
  const rawBatchSize = Number(options.batchSize ?? DRAIN_BATCH_SIZE_MAX);
  const batchSize = Number.isInteger(rawBatchSize)
    ? Math.min(DRAIN_BATCH_SIZE_MAX, Math.max(1, rawBatchSize))
    : DRAIN_BATCH_SIZE_MAX;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const maxInvocationMs = Number.isSafeInteger(options.maxInvocationMs)
    ? Math.min(DRAIN_LEASE_TTL_MS - 60_000, Math.max(1_000, options.maxInvocationMs))
    : 10 * 60 * 1_000;
  const startedAt = lease.startedAt;

  const initialDepth = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const initialRemaining = Number(initialDepth?.n);
  if (!Number.isSafeInteger(initialRemaining) || initialRemaining < 0) {
    throw new Error("vector drain initial backlog is invalid");
  }
  let result = {
    drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0, failed: 0,
    remaining: initialRemaining, errors: [], busy: false,
  };
  let reservedQueries = DRAIN_LEASE_ACQUIRE_QUERIES + DRAIN_LEASE_RELEASE_QUERIES +
    DRAIN_PROJECTION_VERIFY_QUERIES + DRAIN_INITIAL_DEPTH_QUERIES +
    DRAIN_RETRY_STATE_QUERIES;
  const batchQueryUpperBound = drainBatchQueryUpperBound(batchSize);
  for (let batch = 0; batch < maxBatches; batch++) {
    if (now() - startedAt >= maxInvocationMs) break;
    // Never begin provider work unless every possible D1 receipt/remap for
    // that batch fits alongside the already-reserved lease release. This
    // prevents a Vectorize write from landing only to hit D1's invocation
    // query limit before its durable acknowledgement can be recorded.
    if (reservedQueries + batchQueryUpperBound > DRAIN_D1_QUERY_BUDGET) break;
    reservedQueries += batchQueryUpperBound;
    const part = await drainOutboxBatch(env, {
      ...options,
      batchSize,
      lease: { ownerToken: lease.ownerToken, now },
    });
    result.drained += Number(part.drained || 0);
    result.deleted += Number(part.deleted || 0);
    result.upserted += Number(part.upserted || 0);
    result.submitted += Number(part.submitted || 0);
    result.waiting = Number(part.waiting || 0);
    result.failed += Number(part.failed || 0);
    result.remaining = Number(part.remaining || 0);
    result.errors.push(...(part.errors || []).slice(0, Math.max(0, 3 - result.errors.length)));
    if (result.remaining === 0 && options.disableBootstrapAdvance !== true) {
      const bootstrap = await bootstrapVectorProjectionPage(env, { now: now() });
      result.remaining = bootstrap.pending;
      if (bootstrap.pending > 0) {
        result.waiting = 0;
        continue;
      }
    }
    // One immediate confirmation check is useful when a small changeset has
    // already become visible. Once that check reports waiting, stop rather
    // than spinning inside one Worker invocation. A later manual/cron call
    // confirms it without another embedding bill.
    if (!result.remaining) break;
    if (part.waiting && !part.submitted) break;
    if (!part.drained && !part.submitted) break;
  }

  if (result.remaining === 0) {
    result.projection_verified = await markProjectionVerifiedIfExact(env, lease);
  }
  return result;
}

/**
 * Drain one bounded invocation under an exclusive D1-backed Vectorize lease.
 *
 * HTTP and cron entrypoints may request up to ten batches, but maxBatches is a
 * latency preference only: the internal query budget can stop the invocation
 * sooner. The lease spans every batch actually attempted, so another cron or
 * manual request can neither read nor write Vectorize until this owner releases
 * it. If the owner disappears, the migration's timestamp makes the lease
 * reclaimable without deleting or acknowledging any outbox row.
 */
export async function drainOutbox(env, options = {}) {
  // Upgrade cutovers deploy this exact code in a paused mode before changing
  // the lease schema. Return before even acquiring D1 state so the paused
  // Worker is a provable zero-writer compatibility bridge for old installs.
  if (env?.VECTOR_DRAIN_MODE === "paused-for-upgrade" &&
      options.allowPausedBootstrap !== true) {
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0, failed: 0,
      remaining: 0, errors: [], busy: false, paused: true,
    };
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = now();
  const lease = await acquireDrainLease(env, { now: startedAt });
  if (!lease.acquired) {
    let rest;
    try {
      rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    } catch {
      throw new Error("vector drain is busy and its remaining backlog could not be verified");
    }
    return {
      drained: 0,
      deleted: 0,
      upserted: 0,
      submitted: 0,
      waiting: 0,
      failed: 0,
      remaining: Number(rest?.n || 0),
      errors: [],
      busy: true,
      retry_after_seconds: lease.retryAfterSeconds,
    };
  }

  let result;
  let operationError = null;
  try {
    result = await drainOutboxWithLease(env, options, {
      ownerToken: lease.ownerToken,
      now,
      startedAt,
    });
  } catch (error) {
    operationError = error;
  }

  let released = false;
  let releaseError = null;
  try {
    released = await releaseDrainLease(env, lease.ownerToken);
    if (!released) {
      releaseError = new Error("vector drain lease ownership was lost before release");
    }
  } catch (error) {
    releaseError = error;
  }

  if (operationError) {
    if (releaseError && operationError && typeof operationError === "object") {
      operationError.leaseReleaseFailed = true;
    }
    throw operationError;
  }
  if (releaseError) throw releaseError;
  return result;
}

/** How far the vector index is behind the text. Surfaced by health and report. */
/**
 * Re-queue every chunk for embedding, rebuilding Vectorize from D1.
 *
 * D1 holds the chunk TEXT, so the vector store is fully reconstructible without
 * the original source files. That matters more than it sounds:
 *
 *  - `brain rollback` restores D1 and cannot rewind Vectorize, so the two
 *    stores silently desynchronise. This is the resync.
 *  - Vectorize has no backup, no export and no point-in-time restore. D1 is the
 *    only copy of the text, and this is what turns that into a recovery path.
 *  - A metadata index added after ingest does not apply to vectors already
 *    written. Verified 2026-08-18: re-upserting the SAME vector id after the
 *    index exists DOES make it filterable, so this repairs that too, without
 *    the client needing the original folder in the state it was in.
 *
 * Deliberately reuses the outbox rather than writing vectors directly, so the
 * drain's batching, poison quarantine and vector_id write-back all apply
 * unchanged. INSERT OR IGNORE keeps it safe to run twice.
 */
/** Chunks past this are near the embedding model's 512-token ceiling and risk silent truncation. */
const CHUNK_CHAR_WARN = 1800;
const q1 = async (env, sql, ...bind) => {
  const st = env.DB.prepare(sql);
  return await (bind.length ? st.bind(...bind) : st).first();
};
const qAll = async (env, sql, ...bind) => {
  const st = env.DB.prepare(sql);
  const r = await (bind.length ? st.bind(...bind) : st).all();
  return r?.results || [];
};

/**
 * Post-install diagnostic: what is missing, what is stored wrong, what is stored
 * wastefully.
 *
 * This exists because every failure this product has actually had was SILENT.
 * The vector queue stalled while every health probe passed. A metadata index was
 * absent while search kept answering. Scanned PDFs indexed as empty documents.
 * Each time the brain reported itself well and was quietly wrong, and the
 * client's conclusion was "the retrieval is mediocre" rather than "something
 * broke".
 *
 * The most important check here is chunks-in-D1 versus vectors-in-Vectorize.
 * Nothing compared those two numbers before, and that comparison alone would
 * have caught the field stall on day one.
 *
 * Every finding carries an action. A diagnostic that reports a number without
 * saying what to do about it has only relocated the problem.
 */
/**
 * Never prescribe an action the state that produced the message forbids.
 *
 * A paused brain refuses reindex, drain, and forget with 503, and the pause only
 * lifts when the update completes. Advising one from inside that state is a closed
 * loop: the operator reads a remedy, runs it, is refused, and has learned
 * nothing. Four separate messages did this, and one client followed them across
 * four update attempts over 97 hours.
 *
 * The rule is simple. If the brain is paused, say so and name what can actually
 * be done from here.
 */
export function remedyForState(env, remedy, { pausedRemedy = null } = {}) {
  if (env?.VECTOR_DRAIN_MODE !== "paused-for-upgrade") return remedy;
  const recovery = typeof pausedRemedy === "string" && pausedRemedy
    ? pausedRemedy
    : "Run `brain update <manifest>` to resume the durable paused work.";
  return "This brain is paused for an upgrade, so corpus mutations including ingest, source registration, " +
    "zone assignment, reindex, drain, and forget all return 503 until it finishes. " +
    `${recovery} The update ` +
    "is the only supported projection writer while this barrier holds. If the update " +
    "reports this same finding again without progress, keep the brain paused and report " +
    "that update failure for reviewed repair. Do not clear the pause or run reindex, drain, or forget by hand.";
}

export async function diagnose(env, {
  sampleLimit = 10,
  duplicateChunkScanLimit = 100_000,
  chunkPageSize = DEFAULT_DIAGNOSE_CHUNK_PAGE_SIZE,
  chunkPageBudget = DEFAULT_DIAGNOSE_CHUNK_PAGE_BUDGET,
  statementBudget = DEFAULT_DIAGNOSE_STATEMENT_BUDGET,
} = {}) {
  const findings = [];
  const unavailableChecks = [];
  const skippedChecks = new Set();
  const incompleteReasons = new Set();
  let statements = 0;
  let budgetExhausted = false;
  let reportComplete = true;

  if (!Number.isSafeInteger(statementBudget) || statementBudget < 2) {
    throw new Error("diagnose statementBudget must be a whole number of at least 2");
  }

  class DiagnoseStatementBudgetError extends Error {
    constructor() {
      super("the diagnostic statement budget was exhausted");
      this.name = "DiagnoseStatementBudgetError";
    }
  }

  // One statement is always held back for the closing mutation marker. Without
  // that read, a report that used its whole budget could not tell whether the
  // corpus changed while the earlier pages were being counted.
  const query = async (method, sql, bind, { closingMarker = false } = {}) => {
    const ceiling = closingMarker ? statementBudget : statementBudget - 1;
    if (statements >= ceiling) throw new DiagnoseStatementBudgetError();
    statements++;
    const prepared = env.DB.prepare(sql);
    const bound = bind.length ? prepared.bind(...bind) : prepared;
    if (method === "first") return await bound.first();
    const result = await bound.all();
    return result?.results || [];
  };
  const one = (sql, ...bind) => query("first", sql, bind);
  const all = (sql, ...bind) => query("all", sql, bind);
  const closingMarker = (sql, ...bind) => query("first", sql, bind, { closingMarker: true });
  const add = (f) => findings.push(f);
  const chunkDependentIds = new Set([
    "store_agreement", "zone_projection", "chunk_document_source_mismatch",
    "orphan_chunks", "blank_chunks", "chunk_outliers", "oversized_chunks",
    "duplicate_chunks",
  ]);
  const addChunkDependent = (f) => findings.push({ ...f, chunkScanDependent: true });
  const markIncomplete = (reason) => {
    reportComplete = false;
    incompleteReasons.add(reason);
  };
  const safe = async (id, fn) => {
    if (budgetExhausted) {
      skippedChecks.add(id);
      unavailableChecks.push(id);
      return null;
    }
    try { return await fn(); } catch (e) {
      const exhausted = e instanceof DiagnoseStatementBudgetError;
      if (exhausted) budgetExhausted = true;
      markIncomplete(exhausted ? "statement_budget_exhausted" : `check_failed:${id}`);
      // The opening marker is internal machinery for the eight public chunk
      // checks below. Those logical checks are named unavailable together if
      // the scan cannot be bracketed; do not leak a twentieth pseudo-check.
      if (id !== "chunk_scan_marker") unavailableChecks.push(id);
      add({ id, area: "meta", severity: "warn", title: `check "${id}" could not run`,
        observable: false, incomplete: true,
        detail: String(e.message || e).slice(0, 200),
        action: "This result proves no repair cause. Retry after the database recovers. If it persists, have a technician inspect this exact failed check before changing the corpus or schema." });
      return null;
    }
  };

  const openingRow = await safe("chunk_scan_marker", () => one(DIAGNOSE_MUTATION_MARKER_SQL));
  let mutationStart = null;
  let highWaterId = null;
  if (openingRow) {
    try {
      mutationStart = mutationMarker(openingRow);
      highWaterId = Number(openingRow.high_water_id);
      if (!Number.isSafeInteger(highWaterId) || highWaterId < 0) {
        throw new Error("diagnose returned an invalid chunk high-water id");
      }
    } catch (error) {
      markIncomplete("invalid_opening_marker");
      add({ id: "chunk_scan_marker", area: "meta", severity: "warn",
        observable: false, incomplete: true,
        title: "the opening corpus marker could not be read",
        detail: String(error.message || error).slice(0, 200),
        action: "Run `brain upgrade`, then rerun this diagnostic." });
    }
  }

  const totalRow = await safe("totals", () => one(
    `SELECT (SELECT count(*) FROM documents WHERE deleted_at IS NULL) AS documents,
            (SELECT count(*) FROM sources) AS sources`,
  ));
  const totalValue = (value, name) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`diagnose returned an invalid ${name} total`);
    }
    return number;
  };
  let documents = null;
  let sources = null;
  if (totalRow) {
    try {
      documents = totalValue(totalRow.documents, "document");
      sources = totalValue(totalRow.sources, "source");
    } catch (error) {
      markIncomplete("invalid_totals");
      unavailableChecks.push("totals");
      add({ id: "totals", area: "meta", severity: "warn", observable: false, incomplete: true,
        title: "the document totals could not be verified",
        detail: String(error.message || error).slice(0, 200),
        action: "Run `brain upgrade`, then rerun this diagnostic." });
    }
  }

  let chunkScan = {
    complete: false,
    pageSize: chunkPageSize,
    pages: 0,
    highWaterId,
    coveredThroughId: 0,
    reason: "opening_marker_unavailable",
    counts: null,
  };
  if (mutationStart && highWaterId !== null) {
    chunkScan = await scanChunkPages(one, {
      highWaterId,
      pageSize: chunkPageSize,
      pageBudget: chunkPageBudget,
      chunkCharWarn: CHUNK_CHAR_WARN,
      canReadPage: () => statements < statementBudget - 1,
    });
  }
  if (!chunkScan.complete) {
    if (chunkScan.reason === "statement_budget_exhausted") budgetExhausted = true;
    markIncomplete(chunkScan.reason);
    add({ id: "chunk_scan", area: "meta", severity: "warn", observable: false, incomplete: true,
      title: "the bounded chunk audit did not finish",
      detail: `It covered chunk ids through ${chunkScan.coveredThroughId ?? 0} of the fixed high-water ${chunkScan.highWaterId ?? "unknown"}. Reason: ${chunkScan.reason}. Partial counts were not treated as complete.`,
      action: "Wait for active loading to finish, then rerun `brain diagnose <manifest>`. If this repeats, update the installer before relying on a clean result." });
  }

  const totals = {
    documents,
    chunks: chunkScan.complete ? chunkScan.counts.total : null,
    sources,
  };

  /* ---------------- COVERAGE: what did not make it in ---------------- */

  await safe("empty_documents", async () => {
    const n = Number((await one(
      `SELECT count(*) n FROM documents d LEFT JOIN chunks c ON c.doc_uid = d.doc_uid
       WHERE d.deleted_at IS NULL AND c.chunk_uid IS NULL`))?.n || 0);
    if (!n) return;
    const rows = await all(
      `SELECT d.doc_uid, d.title, d.uri FROM documents d
       LEFT JOIN chunks c ON c.doc_uid = d.doc_uid
       WHERE d.deleted_at IS NULL AND c.chunk_uid IS NULL LIMIT ?1`, sampleLimit);
    add({ id: "empty_documents", area: "coverage", severity: "crit", count: n,
      title: `${n} document(s) were indexed but hold no text`,
      detail: "The brain believes it has these and can never answer from them. Almost always a scanned PDF with no text layer, or a format that extracted nothing.",
      samples: rows.map((r) => r.title || r.uri || r.doc_uid),
      action: remedyForState(env, "If OCR is off, turn it on (safety.ocr.enabled) and re-ingest; these are the documents it exists for. If it is already on, these were refused for a stated reason, so read the ingest report and remove them rather than leaving the document count overstating what the brain knows.") });
  });

  // How much of this corpus was read by a machine off a picture. An owner
  // reading an answer deserves to know the shape of the evidence underneath it,
  // and this is the only place that number is visible in aggregate.
  await safe("ocr_coverage", async () => {
    const row = await one(
      // Aliased ocr_full, not full: FULL is a reserved word in SQLite (FULL
      // OUTER JOIN) and the bare alias is a syntax error.
      `SELECT SUM(CASE WHEN text_source = 'ocr' THEN 1 ELSE 0 END) ocr_full,
              SUM(CASE WHEN text_source = 'ocr_partial' THEN 1 ELSE 0 END) ocr_partial
         FROM documents WHERE deleted_at IS NULL`);
    const full = Number(row?.ocr_full || 0);
    const partial = Number(row?.ocr_partial || 0);
    if (!full && !partial) return;
    add({ id: "ocr_coverage", area: "coverage", severity: "info", count: full + partial,
      title: `${full + partial} document(s) were read by OCR rather than from a text layer`,
      detail: partial
        ? `${partial} of them had pages that could not be read; those pages are marked inline in the text rather than dropped. Answers resting on any of these are marked and score lower.`
        : "Answers resting on these are marked as OCR-sourced and score lower, because a machine read them off a picture.",
      action: "Nothing to fix. Spot-check a few figures against the original paper if the ledger will rely on them." });
  });

  await safe("undated", async () => {
    const n = Number((await one("SELECT count(*) n FROM documents WHERE deleted_at IS NULL AND document_date IS NULL"))?.n || 0);
    if (!n) return;
    const pct = totals.documents ? Math.round((n / totals.documents) * 100) : 0;
    add({ id: "undated", area: "coverage", severity: pct >= 34 ? "warn" : "info", count: n,
      title: `${n} document(s) (${pct}%) carry no date`,
      detail: "Recency cannot be judged for these, so any question about what is most recent silently rests only on the dated remainder.",
      action: pct >= 34
        ? "Worth fixing: over a third of the corpus is invisible to any recency judgement."
        : "Usually fine. The gap engine already says so when it matters." });
  });

  await safe("unregistered_sources", async () => {
    const rows = await all(
      `SELECT d.source, count(*) n FROM documents d
       LEFT JOIN sources s ON s.name = d.source
       WHERE d.deleted_at IS NULL AND s.name IS NULL GROUP BY d.source`);
    for (const r of rows) add({ id: "unregistered_source", area: "coverage", severity: "warn", count: Number(r.n),
      title: `${r.n} document(s) sit under an unregistered source "${r.source}"`,
      detail: "They exist in the brain but no source owns them, so `brain forget` cannot remove them and freshness reporting cannot see them.",
      action: remedyForState(env, `Register it: brain sources <manifest> --add ${r.source}`) });
  });

  await safe("empty_sources", async () => {
    const rows = await all(
      `SELECT s.name FROM sources s
       LEFT JOIN documents d ON d.source = s.name AND d.deleted_at IS NULL
       GROUP BY s.name HAVING count(d.doc_uid) = 0`);
    for (const r of rows) add({ id: "empty_source", area: "coverage", severity: "warn",
      title: `source "${r.name}" is registered but holds nothing`,
      detail: "Either it was never loaded, or a load failed and left no trace.",
      action: remedyForState(env, "Run its ingest, or remove the registration so it stops implying coverage that does not exist.") });
  });

  await safe("zone_assignment", async () => {
    const row = await one(
      `SELECT count(*) AS sources,
              sum(CASE WHEN zone IS NULL OR trim(zone) = '' THEN 1 ELSE 0 END) AS unzoned,
              sum(CASE WHEN zone IS NOT NULL AND trim(zone) != '' THEN 1 ELSE 0 END) AS zoned
         FROM sources`);
    const sources = Number(row?.sources || 0);
    const unzoned = Number(row?.unzoned || 0);
    const zoned = Number(row?.zoned || 0);
    // An owner-only brain does not need zones. Once one source is assigned,
    // however, a partial assignment is an access-readiness gap rather than an
    // implicit decision that the remaining sources belong to the owner only.
    if (!zoned) return;
    if (unzoned) {
      add({ id: "zone_assignment", area: "coverage", severity: "warn", count: unzoned,
        title: `${unzoned} of ${sources} source(s) have no zone assignment`,
        detail: "Unzoned sources remain owner-only and are excluded from every named zone grant. A partially zoned corpus can therefore look complete to the owner while a scoped person cannot search most of it.",
        action: remedyForState(env, "Run `brain sources <manifest>` to review the registered sources, then assign each intended source with `brain zone <manifest> --source NAME --zone ZONE`.") });
      return;
    }
    add({ id: "zone_assignment", area: "coverage", severity: "ok", count: sources,
      title: `all ${sources} registered source(s) have a zone assignment`,
      detail: "Every registered source participates in the coarse grant boundary.", action: null });
  });

  await safe("zone_projection", async () => {
    const row = await one(
      `SELECT
         (SELECT count(*)
            FROM documents d JOIN sources s ON s.name = d.source
           WHERE d.deleted_at IS NULL AND d.zone IS NOT s.zone) AS documents,
         (SELECT count(*) FROM sources
           WHERE zone IS NOT NULL AND trim(zone) != '') AS zoned_sources`);
    if (!Number(row?.zoned_sources || 0)) return;
    if (!chunkScan.complete) {
      skippedChecks.add("zone_projection");
      return;
    }
    const documents = Number(row?.documents || 0);
    const chunks = chunkScan.counts.zoneMismatch;
    if (!documents && !chunks) return;
    addChunkDependent({ id: "zone_projection", area: "integrity", severity: "warn", count: documents + chunks,
      title: `zone projection is behind for ${documents} document(s) and ${chunks} chunk(s)`,
      detail: "Access still follows the registered source's zone, so this drift does not widen a scoped grant. The denormalized document and chunk fields are not ready to become authorization inputs until the legacy rows are repaired.",
      action: remedyForState(env, "Keep retrieval source-authoritative. Rerun `brain zone <manifest> --source NAME --zone ZONE` for each assigned source; every pass repairs at most 1,000 documents and 1,000 chunks. Repeat until the command reports no pending rows, then rerun `brain diagnose <manifest>`.") });
  });

  if (chunkScan.complete && chunkScan.counts.sourceMismatch) {
    const count = chunkScan.counts.sourceMismatch;
    addChunkDependent({ id: "chunk_document_source_mismatch", area: "integrity", severity: "warn", count,
      title: `${count} chunk(s) disagree with their owning document's source`,
      detail: "Authorization follows the document source, so this drift does not widen access. Source filters and provenance can still be misleading until the chunk projection is repaired.",
      action: remedyForState(env, "Reingest the affected registered source. If the mismatch remains, run `brain update <manifest>` before relying on source-filtered results.") });
  } else if (!chunkScan.complete) {
    skippedChecks.add("chunk_document_source_mismatch");
  }

  /* ---------------- INTEGRITY: is it stored correctly ---------------- */

  await safe("store_agreement", async () => {
    if (!chunkScan.complete) {
      skippedChecks.add("store_agreement");
      return;
    }
    const queue = await one(
      `SELECT sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) upserts,
              sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) deletes,
              (SELECT vector_projection_status FROM install_state WHERE id = 1) projection_status
       FROM vector_outbox`);
    const pendingUpserts = totalValue(queue?.upserts ?? 0, "pending vector upsert");
    const pendingDeletes = totalValue(queue?.deletes ?? 0, "pending vector delete");
    const projectionStatus = String(queue?.projection_status || "");

    // Provider acceptance and provider visibility are separate states. While
    // an outbox row or an unverified projection remains, Vectorize can change
    // between describe() and this D1 read without any corpus row changing. A
    // count comparison in that interval can falsely call accepted work an
    // orphan or a missing vector. The backlog and projection receipts already
    // name that unsettled state; compare stores only at a verified empty cut.
    if (pendingUpserts || pendingDeletes || projectionStatus !== "verified") {
      addChunkDependent({ id: "store_agreement", area: "integrity", severity: "warn",
        observable: false,
        title: "the two stores cannot be compared while vector work is unsettled",
        detail: `D1 holds ${totals.chunks} chunk(s), with ${pendingUpserts} upsert(s) and ${pendingDeletes} delete(s) still queued. The projection state is ${projectionStatus || "unavailable"}. A Vectorize count during this interval is not an exact snapshot of either side.`,
        action: remedyForState(env, "Let the current vector work finish, then rerun `brain diagnose <manifest>`.") });
      return;
    }

    let vectors = null;
    try {
      const d = await env.VECTORIZE.describe();
      const v = Number(d?.vectorCount ?? d?.vectorsCount ?? d?.count);
      if (Number.isSafeInteger(v) && v >= 0) vectors = v;
    } catch { /* older binding without describe() */ }
    const expected = totals.chunks;

    if (vectors === null) {
      markIncomplete("vector_count_unavailable");
      skippedChecks.add("store_agreement");
      unavailableChecks.push("store_agreement");
      addChunkDependent({ id: "store_agreement", area: "integrity", severity: "warn",
        observable: false, incomplete: true,
        title: "the vector count could not be read from Vectorize",
        detail: `D1 holds ${totals.chunks} chunk(s) at a verified empty-queue cut. The vector store could not be asked how many it holds, so the two cannot be compared.`,
        action: "Rerun this check. If it repeats, update the installer before relying on a clean result." });
      return;
    }
    const drift = Math.abs(vectors - expected);
    if (drift === 0) {
      addChunkDependent({ id: "store_agreement", area: "integrity", severity: "ok",
        title: `both stores agree: ${vectors} vector(s) for ${expected} embedded chunk(s)`,
        detail: "The text store and the vector store hold the same corpus.", action: null });
      return;
    }
    const missing = vectors < expected;
    addChunkDependent({ id: "store_agreement", area: "integrity", severity: "crit", count: drift,
      title: `the two stores disagree by ${drift} vector(s)`,
      detail: `D1 says ${totals.chunks} chunk(s) at a verified empty-queue cut, and Vectorize holds ${vectors}. ` + (missing
        ? "Vectors are MISSING: those chunks still answer keyword queries and are invisible to meaning-based search, which reads as poor retrieval rather than as a fault."
        : "There are MORE vectors than chunks: deleted documents likely left theirs behind, and they still compete for retrieval slots."),
      action: remedyForState(env, missing
        ? "Run `brain reindex <manifest> --yes`. It rebuilds the index from D1 and needs no source files."
        : "Reindex cannot enumerate unknown provider-only IDs. Use a reviewed recovery to recreate and rebind this brain's Vectorize index with all metadata indexes, then run `brain reindex <manifest> --yes` and verify exact readiness.") });
  });

  await safe("backlog", async () => {
    const row = await one(
      `SELECT count(*) n, min(queued_at) oldest, max(queued_at) newest,
              sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) upserts,
              sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) deletes
       FROM vector_outbox`);
    const n = Number(row?.n || 0);
    if (!n) return;
    const now = Date.now();
    const mins = row?.oldest ? Math.floor((now - Number(row.oldest)) / 60000) : null;

    // Lease release clears its expiry, so a missing lease is not history.
    // The projection fence retains the last accepted mutation timestamp even
    // after release. Report that durable evidence separately from a currently
    // held lease; neither proves exact provider visibility or future progress.
    const state = await one(
      `SELECT CASE WHEN vector_drain_lease_owner IS NULL THEN 0 ELSE 1 END AS held,
              vector_drain_lease_expires_at AS expires,
              vector_projection_submitted_at AS submitted_at
         FROM install_state WHERE id = 1`);
    const active = Number(state?.held) === 1 && Number(state?.expires) > now;
    const submittedAt = state?.submitted_at === null || state?.submitted_at === undefined
      ? null : Number(state.submitted_at);
    const submissionAge = Number.isSafeInteger(submittedAt) && submittedAt >= 0 && submittedAt <= now
      ? Math.floor((now - submittedAt) / 60000) : null;
    const recentSubmission = submissionAge !== null && submissionAge <= 30;
    const arriving = row?.newest ? (now - Number(row.newest)) <= 15 * 60 * 1000 : false;
    const needsAttention = mins !== null && mins > 30 && !active && !recentSubmission;
    const evidence = submissionAge === null
      ? "no vector submission timestamp is available"
      : `last vector submission ${submissionAge} min ago`;
    const activity = active
      ? "An active drain request holds the writer lease"
      : recentSubmission
        ? "Recent vector work was submitted and the writer lease has been released"
        : "No active drain lease was observed in this check";

    add({ id: "backlog", area: "integrity", severity: needsAttention ? "crit" : "warn", count: n,
      title: `${n} vector operation(s) are waiting (${Number(row?.upserts || 0)} upsert, ${Number(row?.deletes || 0)} delete)${mins !== null ? `, oldest ${mins} min ago` : ""}`,
      detail: `${activity}; ${evidence}. ` +
        (arriving ? "Documents are still arriving. " : "") +
        "Pending upserts remain keyword-only and pending deletes may leave stale candidates. " +
        (needsAttention
          ? "The age of this backlog needs attention; this snapshot alone cannot prove the scheduled drain has stopped."
          : "The queue and exact vector visibility still need to converge."),
      action: remedyForState(env, active || arriving
        ? "Let the active work finish, then check again or run `brain drain <manifest>`."
        : "Run `brain drain <manifest>` and check the next receipt. If the backlog stops progressing, check this Worker's scheduled trigger.") });
  });

  await safe("quarantined", async () => {
    const n = Number((await one(
      `SELECT count(*) n FROM vector_outbox o
       JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
       WHERE s.quarantined_at IS NOT NULL`))?.n || 0);
    if (!n) return;
    const rows = await all(
      `SELECT o.chunk_uid, s.attempts, s.last_error FROM vector_outbox o
       JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
       WHERE s.quarantined_at IS NOT NULL ORDER BY s.attempts DESC LIMIT ?1`, sampleLimit);
    add({ id: "quarantined", area: "integrity", severity: "crit", count: n,
      title: `${n} vector operation(s) failed and were set aside`,
      detail: "Upsert failures stay invisible to meaning search; delete failures leave stale vectors consuming candidates. Both remain queued for repair.",
      samples: rows.map((r) => `${r.chunk_uid}: ${String(r.last_error || "").slice(0, 90)}`),
      action: remedyForState(env,
        "Read the errors above. Once the cause is fixed, use the operator vector-retry preview and confirmation to release the affected generations, then run `brain drain <manifest>`.",
        { pausedRemedy: "Read the errors above. Once the cause is fixed, use the operator vector-retry preview and confirmation to release the affected generations, then run `brain update <manifest>` to resume the paused bootstrap." }) });
  });

  await safe("vector_retries", async () => {
    // Attempts record history, not quarantine. Only the current generation's
    // retry state can say whether a row is held or waiting on its backoff.
    const row = await one(
      `SELECT count(*) n,
              sum(CASE WHEN s.next_attempt_at>?1 THEN 1 ELSE 0 END) delayed
         FROM vector_outbox o LEFT JOIN vector_outbox_retry_state s
           ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
        WHERE COALESCE(s.attempts,o.attempts,0)>0 AND s.quarantined_at IS NULL`, Date.now());
    const n = Number(row?.n || 0);
    if (!n) return;
    const delayed = Number(row?.delayed || 0);
    add({ id: "vector_retries", area: "integrity", severity: "info", count: n,
      title: `${n} vector operation(s) are awaiting another attempt`,
      detail: `${delayed} are waiting for their recorded retry delay; ${n - delayed} have no remaining recorded delay. Exact vector visibility is still pending, and a previous attempt alone does not mean the operation needs repair.`,
      action: remedyForState(env, "Let the scheduled drain retry eligible work, then check the next receipt or run `brain drain <manifest>`. If progress stops, inspect the next drain result.") });
  });

  if (chunkScan.complete && chunkScan.counts.orphaned) {
    const n = chunkScan.counts.orphaned;
    addChunkDependent({ id: "orphan_chunks", area: "integrity", severity: "crit", count: n,
      title: `${n} chunk(s) belong to no document`,
      detail: "They can still be retrieved and cited, but the document behind the citation is gone.",
      action: remedyForState(env, "Report this, it should not happen. `brain reindex <manifest> --yes` will not clear it on its own.") });
  } else if (!chunkScan.complete) {
    skippedChecks.add("orphan_chunks");
  }

  if (chunkScan.complete && chunkScan.counts.blank) {
    const n = chunkScan.counts.blank;
    addChunkDependent({ id: "blank_chunks", area: "integrity", severity: "warn", count: n,
      title: `${n} chunk(s) hold no text`,
      detail: "Each occupies a vector and can be returned as a hit while carrying nothing.",
      action: remedyForState(env, "Re-ingest the documents they came from.") });
  } else if (!chunkScan.complete) {
    skippedChecks.add("blank_chunks");
  }

  await safe("duplicate_documents", async () => {
    // Sampling the largest groups made the displayed count look exact while it
    // silently omitted every duplicate group below the sample limit. Aggregate
    // the complete grouped result, and keep private identities out of the
    // finding. This stays cheap because documents stores one content hash per
    // document rather than full chunk bodies.
    const summary = await one(
      `SELECT count(*) groups, COALESCE(sum(n - 1), 0) extra
       FROM (
         SELECT content_hash, count(*) n FROM documents
         WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash != ''
         GROUP BY content_hash HAVING count(*) > 1
       )`);
    const extra = Number(summary?.extra || 0);
    if (extra) add({ id: "duplicate_documents", area: "integrity", severity: "warn", count: extra,
      title: `${extra} duplicate document(s) are stored more than once`,
      detail: `${Number(summary?.groups || 0)} exact-content group(s) contain redundant documents under different identities. Each copy competes for the same retrieval slots, so one can push out a different and better source.`,
      action: "Do not delete them blindly. Review their source and path aliases first. Retrieval collapses safe same-source, same-date copies, but physical cleanup needs to preserve update, deletion, and citation identity." });
  });

  /* ---------------- EFFICIENCY: is it stored well ---------------- */

  await safe("chunk_outliers", async () => {
    if (!chunkScan.complete) {
      skippedChecks.add("chunk_outliers");
      return;
    }
    if (totals.chunks > duplicateChunkScanLimit) {
      addChunkDependent({ id: "chunk_outliers", area: "efficiency", severity: "info",
        observable: false,
        title: "exact per-document chunk outliers are not observable at this scale",
        detail: `The exact grouping check is bounded to ${duplicateChunkScanLimit} chunks, and this corpus has ${totals.chunks}. Running it here would add another whole-corpus pass after the bounded integrity scan.`,
        action: "No fault was inferred. Review unusually large source files during ingest; a future maintained aggregate will make this exact check scale safely." });
      return;
    }
    const rows = await all(
      `SELECT d.title, d.uri, count(*) n FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid
       WHERE d.deleted_at IS NULL GROUP BY c.doc_uid ORDER BY n DESC LIMIT ?1`, sampleLimit);
    if (!rows.length) return;
    const top = Number(rows[0].n);
    const share = totals.chunks ? Math.round((top / totals.chunks) * 100) : 0;
    // A share threshold is meaningless on a small corpus: three documents with
    // one chunk each makes the largest 33% of everything. Firing there would
    // warn on every healthy small install, which is how a client learns to
    // ignore this report entirely.
    if (totals.chunks >= 50 && share >= 20) addChunkDependent({ id: "chunk_outliers", area: "efficiency", severity: "warn", count: top,
      title: `one document produced ${top} chunks, ${share}% of the entire corpus`,
      detail: "Usually a spreadsheet. It crowds out every other document in retrieval and dominates cost, while rarely being what anyone is actually asking about.",
      samples: rows.slice(0, 5).map((r) => `${r.n} chunks: ${(r.title || r.uri || "?").slice(0, 60)}`),
      action: remedyForState(env, "Consider loading a summary instead of the raw sheet, or excluding it.") });
  });

  if (chunkScan.complete && chunkScan.counts.oversized) {
    const n = chunkScan.counts.oversized;
    const pct = totals.chunks ? Math.round((n / totals.chunks) * 100) : 0;
    addChunkDependent({ id: "oversized_chunks", area: "efficiency", severity: pct >= 20 ? "warn" : "info", count: n,
      title: `${n} chunk(s) (${pct}%) are long enough to be truncated before embedding`,
      detail: `The embedding model reads about 512 tokens. Past roughly ${CHUNK_CHAR_WARN} characters the rest is silently cut, so the tail is stored but never searchable by meaning.`,
      action: "Not urgent, and invisible in every other way. Worth knowing before blaming retrieval quality." });
  } else if (!chunkScan.complete) {
    skippedChecks.add("oversized_chunks");
  }

  await safe("duplicate_chunks", async () => {
    if (!chunkScan.complete) {
      skippedChecks.add("duplicate_chunks");
      return;
    }
    // Exact GROUP BY over every full chunk body exceeds D1's query budget on a
    // large corpus. A timed-out diagnostic used to become a generic warning,
    // which made a healthy large install look broken while proving nothing
    // about duplicates. Stay explicit about the unavailable measurement until
    // chunk text hashes make the check bounded and indexable.
    if (totals.chunks > duplicateChunkScanLimit) {
      addChunkDependent({ id: "duplicate_chunks", area: "efficiency", severity: "info",
        observable: false,
        title: "exact duplicate chunk measurement is not observable at this scale",
        detail: `The exact full-text grouping check is bounded to ${duplicateChunkScanLimit} chunks, and this corpus has ${totals.chunks}. Running it here could exhaust D1's query budget without returning evidence.`,
        action: "Use the duplicate-document result today. A future chunk text-hash migration will make this exact check scale safely." });
      return;
    }
    const rows = await all(
      "SELECT count(*) n FROM (SELECT text FROM chunks GROUP BY text HAVING count(*) > 1 LIMIT 5000)");
    const groups = Number(rows?.[0]?.n || 0);
    if (groups > 10) addChunkDependent({ id: "duplicate_chunks", area: "efficiency", severity: "info", count: groups,
      title: `${groups}+ groups of identical chunk text`,
      detail: "Repeated headers, footers or boilerplate. Each copy is embedded and stored separately and can occupy a retrieval slot.",
      action: remedyForState(env, "Harmless at small scale. Worth trimming on a large corpus.") });
  });

  let mutationEnd = null;
  try {
    mutationEnd = mutationMarker(await closingMarker(DIAGNOSE_MUTATION_MARKER_SQL));
  } catch (error) {
    const reason = error instanceof DiagnoseStatementBudgetError
      ? "statement_budget_exhausted"
      : "closing_marker_unavailable";
    markIncomplete(reason);
    chunkScan.complete = false;
    chunkScan.reason = reason;
    add({ id: "chunk_scan_marker", area: "meta", severity: "warn",
      observable: false, incomplete: true,
      title: "the closing corpus marker could not be read",
      detail: "The diagnostic cannot prove that its pages describe one stable corpus. No partial count was treated as a clean result.",
      action: "Wait for active loading to finish, then rerun `brain diagnose <manifest>`." });
  }

  const changedMarkers = mutationStart && mutationEnd
    ? mutationMarkerChanges(mutationStart, mutationEnd)
    : [];
  if (changedMarkers.length) {
    markIncomplete("corpus_changed_during_diagnosis");
    chunkScan.complete = false;
    chunkScan.reason = "corpus_changed_during_diagnosis";
    add({ id: "chunk_scan", area: "meta", severity: "warn",
      observable: false, incomplete: true,
      title: "the corpus changed while it was being checked",
      detail: "The opening and closing mutation markers differ. Counts from different moments were not combined into a clean result.",
      action: "Let the current load, update, or deletion finish, then rerun `brain diagnose <manifest>`." });
  }

  if (!chunkScan.complete) {
    for (const id of chunkDependentIds) {
      skippedChecks.add(id);
      unavailableChecks.push(id);
    }
    // A page-derived count may have been valid when it was read, but it is not
    // an exact report of one corpus after a concurrent mutation was observed.
    for (let index = findings.length - 1; index >= 0; index--) {
      if (findings[index].chunkScanDependent) findings.splice(index, 1);
    }
    totals.chunks = null;
  }
  const stableMarkerBracket = Boolean(mutationStart && mutationEnd && changedMarkers.length === 0);
  if (!stableMarkerBracket) {
    // These totals came from separate statements inside the same bracket. If
    // either marker is missing or changed, none is a current count receipt.
    totals.documents = null;
    totals.sources = null;
    unavailableChecks.push("totals");
  }

  const publicFindings = findings.map(({ chunkScanDependent: _internal, ...finding }) => finding);
  const count = (s) => publicFindings.filter((f) => f.severity === s).length;
  const unavailable = [...new Set(unavailableChecks)].sort();
  const scan = {
    complete: reportComplete && chunkScan.complete,
    pageSize: chunkScan.pageSize,
    pages: chunkScan.pages,
    statements,
    highWaterId: chunkScan.highWaterId,
    coveredThroughId: chunkScan.coveredThroughId,
    mutationStart: publicMutationMarker(mutationStart),
    mutationEnd: publicMutationMarker(mutationEnd),
    changedMarkers,
    reason: reportComplete && chunkScan.complete ? null : [...incompleteReasons][0] || chunkScan.reason,
  };
  const complete = scan.complete && unavailable.length === 0;
  return {
    complete,
    scan: { ...scan, complete },
    totals,
    findings: publicFindings,
    skippedChecks: [...skippedChecks].sort(),
    unavailable_checks: unavailable,
    summary: {
      crit: count("crit"), warn: count("warn"), info: count("info"), ok: count("ok"),
      unavailable: unavailable.length,
    },
    verdict: !complete
      ? "incomplete"
      : count("crit")
        ? "problems"
        : count("warn")
          ? "usable_with_gaps"
          : "healthy",
  };
}

/**
 * Coverage staleness: what the brain has not LOOKED at recently.
 *
 * The gap engine already reports the age of what a query retrieved. That is
 * content staleness, and it is the easier half. This is the other half: a source
 * that is never re-read looks exactly like a source with nothing new in it, so
 * the brain cannot tell "nothing has changed" from "I stopped checking in July".
 * Every signal we had was blind to it.
 *
 * Two deliberate refusals to overclaim:
 *
 *  - A source with no expected_refresh_seconds makes NO staleness claim. A
 *    one-off folder upload is not stale, it is finished, and warning about it
 *    every day would train the client to ignore the warning that matters.
 *  - A source we cannot reach on our own (a folder on a laptop) is reported as
 *    manual rather than broken. Calling it stale would be blaming the client for
 *    a limit of the architecture.
 */
const INDEXING_STUCK_MS = 6 * 60 * 60 * 1000;
const SOURCE_REVIEW_ISSUE_CODE = "SAFETY_REVIEW_REQUIRED";
const AUTOMATABLE_SOURCE_KINDS = new Set(["drive", "gmail", "calendar"]);
const REFRESHABLE_SOURCE_KINDS = new Set([
  "drive", "gmail", "imap", "calendar", "imessage", "whatsapp", "zoom",
  "quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot", "plaid",
]);

function sourceOwnerRemedy(source, concern = "refresh") {
  const kind = String(source?.kind || "").toLowerCase();
  const full = {
    drive: "Reconnect Google if access has expired, then run a full Drive sync with no --limit.",
    gmail: "Reconnect Google if access has expired, then run a full Gmail sync with no --limit.",
    calendar: "Reconnect Google if access has expired, then run Calendar with --reset and no --limit for the configured historical scope.",
    imap: "Check the mailbox connection, then run a full IMAP sync with --reset and no --limit.",
    imessage: "On the owner Mac, confirm Full Disk Access, then run iMessage with --reset and no --limit. That proves only the selected local Messages database; load a reviewed iPhone backup or export when older, deleted, or attachment-only history matters.",
    whatsapp: "Keep the phone linked for new messages and load an owner-provided export for any history from before the link date.",
    microsoft: "Reconnect Microsoft 365 if access has expired, then run a full Microsoft sync with no --limit.",
    dropbox: "Reconnect Dropbox if access has expired, then run a full Dropbox sync with no --limit.",
    slack: "Reconnect Slack if access has expired, then traverse every accessible channel without bounded thread limits. Removed or inaccessible conversations remain an explicit connector limitation.",
    notion: "Reconnect Notion if access has expired, share the intended pages with the integration, then traverse those pages without block limits. Pages removed from integration access remain an explicit limitation.",
    hubspot: "Reconnect HubSpot if access has expired, then capture every intended object type. Permanently deleted objects remain an explicit connector limitation.",
    quickbooks: "Reconnect the intended QuickBooks company if access has expired, then capture every intended entity type. Deleted records remain an explicit connector limitation.",
    zoom: "Reconnect Zoom if access has expired, then run a full Zoom sync with no --limit.",
    plaid: "Reconnect the intended financial institutions, resolve any account that needs attention, then run the bank sync again.",
    upload: `Re-run the whole folder for source "${source?.name}" with no --limit, then resolve every unreadable or unsupported file it reports.`,
    "iphone-backup": "Create a current, readable iPhone backup and load that whole snapshot again with no --limit. Load important attachment-only content separately when a message row has no searchable text.",
  }[kind];
  if (full) return full;
  return concern === "refresh"
    ? "Check this source's connection and schedule, then run its normal refresh again."
    : "Run a complete source load with no item or date limit, then resolve every reported skip or failure.";
}

function gapWithRemedy(source, concern, gap) {
  const remedy = sourceOwnerRemedy(source, concern);
  return { ...gap, remedy, detail: `${gap.detail} Next: ${remedy}` };
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function missingCoverageRunColumns(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "docs_refused", "docs_failed", "metrics_version",
    "confirmed_from", "confirmed_through", "target_from", "target_through",
  ].some((column) => new RegExp(
    `(?:no such column|unknown column)\\s*:?\\s*(?:[a-z0-9_]+\\.)?[\"'\\x60]?${column}[\"'\\x60]?\\b`,
    "i",
  ).test(message));
}

function missingFailureEvidenceColumn(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /(?:no such column|unknown column)\s*:?\s*(?:[a-z0-9_]+\.)?["'\x60]?failure_evidence["'\x60]?\b/i
    .test(message);
}

function missingSyncRunsTable(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /no such table|does not exist/.test(message) && message.includes("sync_runs");
}

/**
 * The source row says what the connector last reported; sync_runs says whether
 * an `indexing` report still belongs to a live attempt. Keeping this separate
 * from schedule staleness matters: a failed hourly sync is broken immediately,
 * not only after its freshness window expires, while a healthy six-minute run
 * must not flash red just because it is currently in progress.
 */
function operationalFreshness(s, now) {
  const status = String(s.status || "").toLowerCase();
  const started = timestampMs(s.indexing_started_at);
  const indexingMs = Number.isFinite(started) ? Math.max(0, now - started) : null;

  if (String(s.stale_reason || "").trim().toUpperCase() === SOURCE_REVIEW_ISSUE_CODE) {
    return {
      state: "review",
      reason: sourceReceiptOwnerMessage(SOURCE_REVIEW_ISSUE_CODE),
      indexingMs,
    };
  }
  if (s.stale_reason) {
    return { state: "broken", reason: sourceReceiptOwnerMessage(s.stale_reason), indexingMs };
  }
  if (status === "error") {
    return { state: "broken", reason: "the last sync reported an error", indexingMs };
  }
  if (status !== "indexing") return { state: null, reason: null, indexingMs };

  // New connector runs always open sync_runs through source-receipt. An
  // indexing row without one is therefore an interrupted legacy/control-plane
  // run, not evidence that work is still alive.
  if (!Number.isFinite(started)) {
    return {
      state: "broken",
      reason: "indexing is marked active but has no open sync run",
      indexingMs: null,
    };
  }
  if (indexingMs > INDEXING_STUCK_MS) {
    const hours = Math.floor(indexingMs / 3600000);
    return {
      state: "broken",
      reason: `indexing has not completed for ${hours} hour(s)`,
      indexingMs,
    };
  }
  return { state: "indexing", reason: null, indexingMs };
}

const sourceFreshnessSql = ({ ordered = false, includeUnregisteredCounts = false } = {}) => `
  SELECT inventory.*
    FROM (
      SELECT s.name, s.kind, s.zone, s.status, s.last_ingest_at, s.last_complete_sweep_at,
             s.expected_refresh_seconds, s.stale_reason, s.document_count,
             (SELECT MIN(sr.started_at)
                FROM sync_runs sr
               WHERE sr.source = s.name AND sr.finished_at IS NULL) AS indexing_started_at,
             1 AS registered
        FROM sources s
      UNION ALL
      SELECT source_inventory.source AS name,
             'unregistered' AS kind, NULL AS zone, 'unregistered' AS status,
             NULL AS last_ingest_at, NULL AS last_complete_sweep_at,
             NULL AS expected_refresh_seconds, NULL AS stale_reason,
             ${includeUnregisteredCounts
               ? `(SELECT COUNT(*) FROM documents live_documents
                    WHERE live_documents.source = source_inventory.source
                      AND live_documents.deleted_at IS NULL)`
               : "NULL"} AS document_count,
             NULL AS indexing_started_at,
             0 AS registered
        FROM document_source_inventory source_inventory
        LEFT JOIN sources registered_source
          ON registered_source.name = source_inventory.source
       WHERE registered_source.name IS NULL
    ) inventory${ordered ? " ORDER BY inventory.name" : ""}`;

export async function coverageGapReport(env, { now = Date.now(), allowedSources = null } = {}) {
  let rows;
  try {
    const r = await env.DB.prepare(sourceFreshnessSql()).all();
    rows = r?.results || [];
  } catch {
    return { gaps: [], unavailable: true };
  }

  const allowed = allowedSources === null
    ? null
    : new Set((Array.isArray(allowedSources) ? allowedSources : []).map((source) => String(source)));
  const gaps = [];
  for (const s of rows) {
    if (allowed && !allowed.has(String(s.name))) continue;
    if (s.registered === 0 || s.registered === false || String(s.registered) === "0") {
      gaps.push(gapWithRemedy(s, "history", {
        type: "source_unregistered",
        source: s.name,
        detail: `Records stored under "${s.name}" have no source-registry entry. Their connector, complete-history status, and access zone are unproven, so a missing result cannot be treated as proof that those records contain no answer.`,
      }));
      continue;
    }
    const last = s.last_ingest_at ? Date.parse(s.last_ingest_at) : NaN;
    const ageSec = Number.isFinite(last) ? Math.floor((now - last) / 1000) : null;
    const days = ageSec === null ? null : Math.floor(ageSec / 86400);
    const operational = operationalFreshness(s, now);

    if (operational.state === "broken") {
      gaps.push(gapWithRemedy(s, "refresh", {
        type: "sync_broken",
        source: s.name,
        days_since_ingest: days,
        detail: `The "${s.name}" source stopped updating${days === null ? "" : ` ${days} day(s) ago`}: ${operational.reason}. Anything added since is not in the brain.`,
      }));
    }
    if (operational.state === "review") {
      gaps.push(gapWithRemedy(s, "refresh", {
        type: "sync_review",
        source: s.name,
        days_since_ingest: days,
        detail: `The ${historicalSourceLabel(s.kind)} source is paused for safety review: ${operational.reason}. Its coverage is not complete until the owner resolves that review.`,
      }));
    }

    const syncInProgress = operational.state === "indexing";
    if (syncInProgress) {
      gaps.push(gapWithRemedy(s, "refresh", {
        type: "sync_in_progress",
        source: s.name,
        days_since_ingest: days,
        detail: `The ${historicalSourceLabel(s.kind)} source is currently updating. Records accepted before this run remain usable, but material still being discovered may be absent from results, so a missing result is provisional.`,
      }));
    }

    const expected = Number(s.expected_refresh_seconds) || null;
    if (!expected) {
      if (!s.last_complete_sweep_at) {
        const hasRecords = Number(s.document_count || 0) > 0;
        gaps.push(gapWithRemedy(s, "history", {
          type: "history_unproven",
          source: s.name,
          detail: hasRecords
            ? `The ${historicalSourceLabel(s.kind)} source has usable records, but its declared history is not yet proven complete. A missing result may still be outside confirmed coverage.`
            : `The ${historicalSourceLabel(s.kind)} source is registered, but no complete history sweep has been confirmed. A missing result cannot be treated as proof that its declared records contain no answer.`,
        }));
      } else if (!operational.state && REFRESHABLE_SOURCE_KINDS.has(String(s.kind || "").toLowerCase())) {
        gaps.push(gapWithRemedy(s, "refresh", {
          type: "refresh_unscheduled",
          source: s.name,
          days_since_ingest: days,
          detail: `The ${historicalSourceLabel(s.kind)} source has a complete point-in-time sweep, but no refresh schedule is recorded. Material added after${Number.isFinite(last) ? ` ${new Date(last).toISOString().slice(0, 10)}` : " that sweep"} may be missing from the brain.`,
        }));
      }
      continue; // no refresh expectation, so no staleness claim made
    }

    if (ageSec === null) {
      gaps.push(gapWithRemedy(s, "refresh", {
        type: "never_synced",
        source: s.name,
        detail: `The "${s.name}" source is expected to refresh but has never completed one, so its contents may be missing entirely.`,
      }));
    }

    // 1.5x before complaining: a cron that runs daily and is six hours late is
    // working. Warning at the first minute past due is how alerts get ignored.
    if (ageSec !== null && ageSec > expected * 1.5) {
      gaps.push(gapWithRemedy(s, "refresh", {
        type: "coverage_stale",
        source: s.name,
        days_since_ingest: days,
        expected_every_days: Math.round(expected / 86400) || null,
        detail: `The "${s.name}" source was last read ${days} day(s) ago and is expected to refresh about every ${Math.max(1, Math.round(expected / 86400))} day(s). Material added since then is not in the brain, and would not show up as a missing answer.`,
      }));
    }

    if (!s.last_complete_sweep_at) {
      const hasRecords = Number(s.document_count || 0) > 0;
      gaps.push(gapWithRemedy(s, "history", {
        type: "history_unproven",
        source: s.name,
        detail: hasRecords
          ? `The ${historicalSourceLabel(s.kind)} source has usable records, but its declared history is not yet proven complete. A missing result may still be outside confirmed coverage.`
          : `The ${historicalSourceLabel(s.kind)} source is registered, but no complete history sweep has been confirmed. A missing result cannot be treated as proof that its declared records contain no answer.`,
      }));
    }
  }
  return { gaps, unavailable: false };
}

/** Compatibility helper for callers that only need known gaps. */
export async function coverageGaps(env, options = {}) {
  return (await coverageGapReport(env, options)).gaps;
}

/** Per-source freshness for `brain health` and `brain sources`, not for answers. */
export async function freshnessReport(env, { now = Date.now() } = {}) {
  let rows;
  try {
    const r = await env.DB.prepare(sourceFreshnessSql({
      ordered: true,
      includeUnregisteredCounts: true,
    })).all();
    rows = r?.results || [];
  } catch {
    return { sources: [], unavailable: true };
  }
  const latestRuns = new Map();
  try {
    let result;
    const currentRunSql =
      `SELECT source,lane,started_at,finished_at,walk_complete,files_seen,
              docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
              confirmed_from,confirmed_through,target_from,target_through,refusal_reason,error,
              failure_evidence
         FROM (
           SELECT sr.*,
                  ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC, run_id DESC) AS source_rank
             FROM sync_runs sr
         )
        WHERE source_rank=1`;
    const coverageRunSql =
      `SELECT source,lane,started_at,finished_at,walk_complete,files_seen,
              docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
              confirmed_from,confirmed_through,target_from,target_through,refusal_reason,error
         FROM (
           SELECT sr.*,
                  ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC, run_id DESC) AS source_rank
             FROM sync_runs sr
         )
        WHERE source_rank=1`;
    const legacyRunSql =
      `SELECT source,lane,started_at,finished_at,walk_complete,files_seen,
              docs_added,docs_updated,docs_unchanged,refusal_reason,error
         FROM (
           SELECT sr.*,
                  ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC, run_id DESC) AS source_rank
             FROM sync_runs sr
         )
        WHERE source_rank=1`;
    try {
      result = await env.DB.prepare(currentRunSql).all();
    } catch (error) {
      if (missingFailureEvidenceColumn(error)) {
        try {
          // Schema 38 remains readable while migration 0040 is pending. The
          // missing evidence is unknown; all existing coverage counters and
          // ranges keep their exact same-run meaning.
          result = await env.DB.prepare(coverageRunSql).all();
        } catch (coverageError) {
          if (!missingCoverageRunColumns(coverageError)) throw coverageError;
          result = await env.DB.prepare(legacyRunSql).all();
        }
      } else if (missingCoverageRunColumns(error)) {
        result = await env.DB.prepare(legacyRunSql).all();
      } else {
        throw error;
      }
    }
    for (const run of result?.results || []) {
      if (typeof run?.source === "string" && run.source) latestRuns.set(run.source, run);
    }
  } catch (error) {
    // Legacy or partially migrated installs still receive the older freshness
    // view. Coverage falls back to unknown instead of breaking the whole read.
    if (!missingSyncRunsTable(error)) throw error;
  }
  // Kinds we can refresh without the client's machine being on.
  return {
    sources: rows.map((s) => {
      const unregistered = s.registered === 0 || s.registered === false || String(s.registered) === "0";
      const last = s.last_ingest_at ? Date.parse(s.last_ingest_at) : NaN;
      const days = Number.isFinite(last) ? Math.floor((now - last) / 86400000) : null;
      const expected = Number(s.expected_refresh_seconds) || null;
      const automatable = AUTOMATABLE_SOURCE_KINDS.has(String(s.kind));
      const operational = operationalFreshness(s, now);
      let state = unregistered ? "unregistered" : "ok";
      let reason = unregistered ? "the source registry entry is missing" : operational.reason;
      if (!unregistered && operational.state) state = operational.state;
      else if (!unregistered && !expected) state = automatable ? "unscheduled" : "manual";
      else if (!unregistered && !Number.isFinite(last)) state = "never_synced";
      else if (!unregistered && (now - last) / 1000 > expected * 1.5) state = "stale";
      const report = {
        name: s.name, kind: s.kind, state,
        // Null is a real, owner-only unassigned state for registered sources.
        // Unregistered is distinguished by `state`; ownerSystemStatus converts
        // both into explicit public states without exposing this raw slug.
        zone: typeof s.zone === "string" && s.zone.trim() ? s.zone.trim() : null,
        source_status: String(s.status || "") || null,
        documents: Number(s.document_count || 0),
        days_since_ingest: days,
        expected_every_days: expected ? Math.max(1, Math.round(expected / 86400)) : null,
        last_complete_sweep_at: s.last_complete_sweep_at || null,
        indexing_started_at: Number.isFinite(timestampMs(s.indexing_started_at))
          ? new Date(timestampMs(s.indexing_started_at)).toISOString()
          : null,
        hours_indexing: operational.indexingMs === null
          ? null
          : Math.floor(operational.indexingMs / 3600000),
        reason,
        automatable,
      };
      const latestRun = latestRuns.get(s.name) || null;
      return {
        ...report,
        last_failure: latestRun?.error
          ? parseStoredSourceFailureEvidence(latestRun.failure_evidence, {
              status: "error",
              kind: String(s.kind || "").trim().toLowerCase(),
              metricsVersion: Number(latestRun.metrics_version) === 1 ? 1 : 0,
              measuredDocsFailed: Number(latestRun.metrics_version) === 1
                ? latestRun.docs_failed
                : null,
            })
          : null,
        coverage: sourceCoverageFromEvidence({
          ...report,
          last_ingest_at: s.last_ingest_at || null,
          expected_every_days: expected ? Math.max(1, Math.round(expected / 86400)) : null,
        }, {
          latestRun,
          // Per-source outbox counts would scan a large derived queue on every
          // owner read. Keep this unknown until priority lanes materialize a
          // cheap aggregate; ownerSystemStatus settles it conservatively from
          // the exact whole-brain visibility check.
          projectionPending: null,
        }),
      };
    }),
  };
}

/**
 * A bounded, owner-only inventory of the source evidence D1 actually holds.
 *
 * One SELECT produces the complete snapshot so paging never combines the
 * registry from one moment with document counts from another. This query is
 * intentionally read-only: callers can safely run it during Optimize without
 * changing a source receipt, sync cursor, corpus row, or credential record.
 *
 * The inventory reports only fields the current schema can prove. It does not
 * infer people, entities, tax years, or financial coverage from a source name.
 */
export const SOURCE_INVENTORY_MAX_ROWS = 10_000;

export const SOURCE_RECOVERY_MAX_PAGE_SIZE = 250;

const SOURCE_PROVIDER_BY_KIND = Object.freeze({
  calendar: "google",
  drive: "google",
  dropbox: "dropbox",
  gmail: "google",
  hubspot: "hubspot",
  imessage: "apple",
  microsoft: "microsoft",
  notion: "notion",
  "owner-notes": "local",
  plaid: "plaid",
  qbo: "intuit",
  quickbooks: "intuit",
  slack: "slack",
  upload: "local",
  whatsapp: "meta",
  zoom: "zoom",
  "iphone-backup": "apple",
});

const SAFE_SCOPE_FIELDS = Object.freeze([
  "calendar_ids",
  "channel_ids",
  "drive_ids",
  "exclude",
  "folder_ids",
  "include",
  "label_ids",
  "root_folder_ids",
  "roots",
  "since",
  "site_ids",
  "team_ids",
]);
const ROOT_SCOPE_FIELDS = Object.freeze(["root_folder_ids", "folder_ids", "roots"]);

function maskedSourceScope(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {
      status: "unavailable",
      masked: true,
      format: null,
      recorded_fields: [],
      configured_root_count: null,
    };
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch {
    return {
      status: "partial",
      masked: true,
      format: "opaque",
      recorded_fields: [],
      configured_root_count: null,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "partial",
      masked: true,
      format: "json_non_object",
      recorded_fields: [],
      configured_root_count: null,
    };
  }
  const recordedFields = SAFE_SCOPE_FIELDS.filter((field) => Object.hasOwn(parsed, field));
  const rootFields = ROOT_SCOPE_FIELDS.filter((field) => Object.hasOwn(parsed, field));
  const rootArrays = rootFields.map((field) => parsed[field]);
  const rootsAreCountable = rootArrays.length > 0 && rootArrays.every(Array.isArray);
  return {
    status: recordedFields.length ? (rootsAreCountable || rootFields.length === 0 ? "supported" : "partial") : "partial",
    masked: true,
    format: "json_object",
    recorded_fields: recordedFields,
    configured_root_count: rootsAreCountable
      ? rootArrays.reduce((count, roots) => count + roots.length, 0)
      : null,
  };
}

function coverageStatus(total, covered) {
  if (!total || !covered) return "unavailable";
  return covered === total ? "complete" : "partial";
}

function earliestInventoryTimestamp(entries) {
  const recorded = entries
    .map(([field, value]) => [field, timestampMs(value)])
    .filter(([, millis]) => Number.isFinite(millis))
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  if (!recorded.length) return { at: null, evidence: [] };
  const at = recorded[0][1];
  return {
    at: new Date(at).toISOString(),
    evidence: recorded.filter(([, millis]) => millis === at).map(([field]) => field),
  };
}

const PROVENANCE_MARKER_SQL = `CASE WHEN
  d.provenance_receipt_version = 1
  AND d.provenance_receipt_status IN ('complete','partial','unavailable')
  AND (
    (d.provenance_receipt_status = 'complete' AND d.provenance_receipt_reason = 'lineage_and_text_recorded')
    OR (d.provenance_receipt_status = 'partial' AND d.provenance_receipt_reason IN ('text_provenance_unavailable','lineage_unavailable'))
    OR (d.provenance_receipt_status = 'unavailable' AND d.provenance_receipt_reason = 'provenance_unavailable')
  )
  AND length(COALESCE(d.provenance_receipt_digest,'')) = 64
  AND d.provenance_receipt_digest = lower(d.provenance_receipt_digest)
  AND lower(d.provenance_receipt_digest) NOT GLOB '*[^0-9a-f]*'
  AND json_valid(d.meta)
  AND json_type(d.meta,'$.provenance_receipt') = 'object'
  AND json_extract(d.meta,'$.provenance_receipt.version') = d.provenance_receipt_version
  AND json_extract(d.meta,'$.provenance_receipt.status') = d.provenance_receipt_status
  AND json_extract(d.meta,'$.provenance_receipt.reason') = d.provenance_receipt_reason
THEN 1 ELSE 0 END`;

const FAMILY_UID_SQL = `CASE
  WHEN (${PROVENANCE_MARKER_SQL}) = 1
   AND json_valid(d.meta)
   AND json_type(d.meta,'$.family_of') = 'text'
   AND length(json_extract(d.meta,'$.family_of')) > 0
    THEN json_extract(d.meta,'$.family_of')
  WHEN (${PROVENANCE_MARKER_SQL}) = 1
   AND json_valid(d.meta)
   AND json_type(d.meta,'$.part_of') = 'text'
   AND length(json_extract(d.meta,'$.part_of')) > 0
    THEN CASE
      WHEN substr(json_extract(d.meta,'$.part_of'), 1, length(d.source) + 1) = d.source || ':'
        THEN json_extract(d.meta,'$.part_of')
      ELSE d.source || ':' || json_extract(d.meta,'$.part_of')
    END
  ELSE d.doc_uid
END`;

const LINEAGE_SHAPE_SQL = `CASE WHEN
  json_valid(meta)
  AND json_type(meta,'$.evidence_lineage') = 'object'
  AND json_type(meta,'$.evidence_lineage.version') = 'integer'
  AND json_extract(meta,'$.evidence_lineage.version') = 1
  AND json_type(meta,'$.evidence_lineage.kind') = 'text'
  AND json_extract(meta,'$.evidence_lineage.kind') IN ('source_record','derived_record','agent_derived')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(meta,'$.evidence_lineage')) lineage_field
     WHERE lineage_field.key NOT IN ('version','kind','root_ids')
  )
  AND (
    json_type(meta,'$.evidence_lineage.root_ids') IS NULL
    OR (
      json_type(meta,'$.evidence_lineage.root_ids') = 'array'
      AND json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) <= 16
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(meta,'$.evidence_lineage.root_ids')) lineage_root
         WHERE lineage_root.type != 'text'
            OR length(trim(lineage_root.value)) = 0
            OR length(lineage_root.value) > 512
      )
    )
  )
  AND (
    json_extract(meta,'$.evidence_lineage.kind') != 'derived_record'
    OR (
      json_type(meta,'$.evidence_lineage.root_ids') = 'array'
      AND json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) > 0
    )
  )
  AND (
    json_extract(meta,'$.evidence_lineage.kind') != 'source_record'
    OR json_type(meta,'$.evidence_lineage.root_ids') IS NULL
    OR json_array_length(json_extract(meta,'$.evidence_lineage.root_ids')) <= 1
  )
THEN 1 ELSE 0 END`;

const sourceInventorySql = ({ includeFailureEvidence = true } = {}) => `
  WITH live_documents AS MATERIALIZED (
    SELECT d.rowid AS document_rowid,
           d.doc_uid,
           d.source AS physical_source,
           d.source_id,
           d.ingested_at,
           d.meta,
           d.text_source,
           d.text_reliable,
           d.provenance_receipt_version,
           d.provenance_receipt_status,
           d.provenance_receipt_reason,
           d.provenance_receipt_digest,
           ${PROVENANCE_MARKER_SQL} AS provenance_marker_valid,
           ${FAMILY_UID_SQL} AS family_doc_uid
      FROM documents d
     WHERE d.deleted_at IS NULL
  ),
  attributed_documents AS MATERIALIZED (
    SELECT live_documents.*,
           CASE
             WHEN instr(family_doc_uid, ':') BETWEEN 2 AND 65
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) GLOB '[a-z0-9]*'
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) NOT GLOB '*[^a-z0-9_-]*'
               THEN substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1)
             ELSE physical_source
           END AS inventory_source
      FROM live_documents
  ),
  chunk_per_document AS (
    SELECT a.doc_uid,
           COUNT(c.chunk_uid) AS chunk_count,
           COALESCE(SUM(CASE WHEN trim(c.text) != '' THEN 1 ELSE 0 END),0) AS nonblank_chunk_count
      FROM attributed_documents a
      LEFT JOIN chunks c ON c.doc_uid=a.doc_uid
     GROUP BY a.doc_uid
  ),
  document_flags AS MATERIALIZED (
    SELECT a.*,
           COALESCE(c.chunk_count,0) AS chunk_count,
           COALESCE(c.nonblank_chunk_count,0) AS nonblank_chunk_count,
           CASE WHEN a.provenance_marker_valid=1 AND trim(COALESCE(a.source_id,'')) != '' THEN 1 ELSE 0 END AS has_source_identity,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial') THEN 1 ELSE 0 END AS has_extraction_method,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial')
                     AND a.text_reliable IN (0,1) THEN 1 ELSE 0 END AS has_text_reliability,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta)
                     AND json_type(a.meta,'$.evidence_lineage')='object' THEN 1 ELSE 0 END AS declared_lineage,
           CASE WHEN a.provenance_marker_valid=1 THEN ${LINEAGE_SHAPE_SQL} ELSE 0 END AS recognized_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta) AND (
             (json_type(a.meta,'$.family_of')='text' AND length(trim(json_extract(a.meta,'$.family_of'))) > 0)
             OR (json_type(a.meta,'$.part_of')='text' AND length(trim(json_extract(a.meta,'$.part_of'))) > 0)
           ) THEN 1 ELSE 0 END AS family_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND (
             a.provenance_receipt_status='complete'
             OR a.provenance_receipt_reason='text_provenance_unavailable'
           ) THEN 1 ELSE 0 END AS has_lineage
      FROM attributed_documents a
      LEFT JOIN chunk_per_document c ON c.doc_uid=a.doc_uid
  ),
  source_names AS (
    SELECT name FROM sources
    UNION
    SELECT inventory_source AS name FROM attributed_documents
  ),
  document_rollup AS (
    SELECT inventory_source AS source,
           COUNT(*) AS physical_documents,
           COUNT(DISTINCT family_doc_uid) AS logical_documents,
           MIN(ingested_at) AS first_stored_ingest_at,
           MAX(ingested_at) AS last_stored_ingest_at,
           SUM(chunk_count) AS chunks,
           SUM(CASE WHEN nonblank_chunk_count > 0 THEN 1 ELSE 0 END) AS readable_documents,
           SUM(CASE WHEN nonblank_chunk_count = 0 THEN 1 ELSE 0 END) AS unreadable_documents,
           SUM(CASE WHEN chunk_count = 0 THEN 1 ELSE 0 END) AS empty_documents,
           SUM(CASE WHEN chunk_count > 0 AND nonblank_chunk_count = 0 THEN 1 ELSE 0 END) AS blank_only_documents,
           SUM(CASE WHEN has_text_reliability=1 AND text_reliable=1 THEN 1 ELSE 0 END) AS text_reliable_documents,
           SUM(CASE WHEN has_text_reliability=1 AND text_reliable=0 THEN 1 ELSE 0 END) AS text_unreliable_documents,
           SUM(CASE WHEN has_text_reliability=0 THEN 1 ELSE 0 END) AS text_reliability_unknown_documents,
           SUM(CASE WHEN has_extraction_method=1 AND lower(COALESCE(text_source,''))='native' THEN 1 ELSE 0 END) AS native_text_documents,
           SUM(CASE WHEN has_extraction_method=1 AND lower(COALESCE(text_source,''))='ocr' THEN 1 ELSE 0 END) AS ocr_documents,
           SUM(CASE WHEN has_extraction_method=1 AND lower(COALESCE(text_source,''))='ocr_partial' THEN 1 ELSE 0 END) AS ocr_partial_documents,
           SUM(CASE WHEN has_extraction_method=0 THEN 1 ELSE 0 END) AS unknown_text_source_documents,
           SUM(CASE WHEN nonblank_chunk_count=0 AND (has_extraction_method=0
                     OR lower(COALESCE(text_source,'')) NOT IN ('ocr','ocr_partial')) THEN 1 ELSE 0 END) AS likely_ocr_candidates,
           SUM(CASE WHEN nonblank_chunk_count=0 AND has_extraction_method=1
                     AND lower(COALESCE(text_source,'')) IN ('ocr','ocr_partial') THEN 1 ELSE 0 END) AS ocr_retry_candidates,
           SUM(has_source_identity) AS source_identity_documents,
           SUM(CASE WHEN provenance_marker_valid=0 THEN 1 ELSE 0 END) AS unassessed_provenance_documents,
           SUM(declared_lineage) AS declared_lineage_documents,
           SUM(recognized_lineage) AS recognized_lineage_documents,
           SUM(CASE WHEN declared_lineage=1 AND recognized_lineage=0 THEN 1 ELSE 0 END) AS unrecognized_lineage_documents,
           SUM(family_lineage) AS family_lineage_documents,
           SUM(has_lineage) AS recorded_lineage_documents,
           SUM(CASE WHEN provenance_marker_valid=1 AND provenance_receipt_status='complete'
                    THEN 1 ELSE 0 END) AS complete_provenance_documents,
           SUM(CASE WHEN nonblank_chunk_count=0
                     OR (has_extraction_method=1 AND lower(COALESCE(text_source,''))='ocr_partial')
                     OR provenance_marker_valid=0
                     OR has_source_identity=0 OR has_extraction_method=0 OR has_text_reliability=0
                     OR has_lineage=0
                     OR (declared_lineage=1 AND recognized_lineage=0)
                    THEN 1 ELSE 0 END) AS recovery_candidate_documents
      FROM document_flags
     GROUP BY inventory_source
  ),
  source_events_rollup AS (
    SELECT source_name AS source,
           MIN(CASE WHEN event='ingest' THEN at END) AS first_ingest_event_at,
           MAX(CASE WHEN event='ingest' THEN at END) AS last_ingest_event_at
      FROM source_events
     GROUP BY source_name
  ),
  run_rollup AS (
    SELECT source,
           MIN(started_at) AS first_run_started_at,
           MAX(CASE WHEN finished_at IS NOT NULL AND error IS NULL AND refusal_reason IS NULL
                    THEN finished_at END) AS last_successful_run_at
      FROM sync_runs
     GROUP BY source
  ),
  latest_runs AS (
    SELECT source,lane,started_at,finished_at,walk_complete,files_seen,
           docs_added,docs_updated,docs_unchanged,docs_refused,docs_failed,metrics_version,
           confirmed_from,confirmed_through,target_from,target_through,proposed_deletes,
           delete_action,refusal_reason,error,
           ${includeFailureEvidence ? "failure_evidence" : "NULL AS failure_evidence"}
      FROM (
        SELECT sr.*,
               ROW_NUMBER() OVER (
                 PARTITION BY source ORDER BY started_at DESC, run_id DESC
               ) AS source_rank
          FROM sync_runs sr
      )
     WHERE source_rank=1
  )
  SELECT n.name,
         COALESCE(s.kind,'unregistered') AS kind,
         s.zone,
         s.status,
         s.created_at,
         s.last_ingest_at,
         s.last_complete_sweep_at,
         s.scope,
         s.sync_cursor,
         s.cursor_updated_at,
         s.expected_refresh_seconds,
         s.stale_reason,
         s.document_count AS reported_logical_documents,
         CASE WHEN s.name IS NULL THEN 0 ELSE 1 END AS registered,
         COALESCE(d.physical_documents,0) AS physical_documents,
         COALESCE(d.logical_documents,0) AS logical_documents,
         d.first_stored_ingest_at,
         d.last_stored_ingest_at,
         COALESCE(d.readable_documents,0) AS readable_documents,
         COALESCE(d.unreadable_documents,0) AS unreadable_documents,
         COALESCE(d.empty_documents,0) AS empty_documents,
         COALESCE(d.blank_only_documents,0) AS blank_only_documents,
         COALESCE(d.text_reliable_documents,0) AS text_reliable_documents,
         COALESCE(d.text_unreliable_documents,0) AS text_unreliable_documents,
         COALESCE(d.text_reliability_unknown_documents,0) AS text_reliability_unknown_documents,
         COALESCE(d.native_text_documents,0) AS native_text_documents,
         COALESCE(d.ocr_documents,0) AS ocr_documents,
         COALESCE(d.ocr_partial_documents,0) AS ocr_partial_documents,
         COALESCE(d.unknown_text_source_documents,0) AS unknown_text_source_documents,
         COALESCE(d.likely_ocr_candidates,0) AS likely_ocr_candidates,
         COALESCE(d.ocr_retry_candidates,0) AS ocr_retry_candidates,
         COALESCE(d.source_identity_documents,0) AS source_identity_documents,
         COALESCE(d.unassessed_provenance_documents,0) AS unassessed_provenance_documents,
         COALESCE(d.declared_lineage_documents,0) AS declared_lineage_documents,
         COALESCE(d.recognized_lineage_documents,0) AS recognized_lineage_documents,
         COALESCE(d.unrecognized_lineage_documents,0) AS unrecognized_lineage_documents,
         COALESCE(d.family_lineage_documents,0) AS family_lineage_documents,
         COALESCE(d.recorded_lineage_documents,0) AS recorded_lineage_documents,
         COALESCE(d.complete_provenance_documents,0) AS complete_provenance_documents,
         COALESCE(d.recovery_candidate_documents,0) AS recovery_candidate_documents,
         COALESCE(d.chunks,0) AS chunks,
         e.first_ingest_event_at,
         e.last_ingest_event_at,
         rr.first_run_started_at,
         rr.last_successful_run_at,
         r.lane AS run_lane,
         r.started_at AS run_started_at,
         r.finished_at AS run_finished_at,
         r.walk_complete AS run_walk_complete,
         r.files_seen AS run_files_seen,
         r.docs_added AS run_docs_added,
         r.docs_updated AS run_docs_updated,
         r.docs_unchanged AS run_docs_unchanged,
         r.docs_refused AS run_docs_refused,
         r.docs_failed AS run_docs_failed,
         r.metrics_version AS run_metrics_version,
         r.confirmed_from AS run_confirmed_from,
         r.confirmed_through AS run_confirmed_through,
         r.target_from AS run_target_from,
         r.target_through AS run_target_through,
         r.proposed_deletes AS run_proposed_deletes,
         r.delete_action AS run_delete_action,
         r.failure_evidence AS run_failure_evidence,
         CASE
           WHEN r.source IS NULL THEN NULL
           WHEN r.finished_at IS NULL THEN 'in_progress'
           WHEN r.error IS NOT NULL THEN 'failed'
           WHEN r.refusal_reason IS NOT NULL THEN 'refused'
           ELSE 'completed'
         END AS run_outcome,
         CASE WHEN r.error IS NULL THEN 0 ELSE 1 END AS run_had_error,
         CASE WHEN r.refusal_reason IS NULL THEN 0 ELSE 1 END AS run_was_refused,
         COUNT(*) OVER () AS inventory_total
    FROM source_names n
    LEFT JOIN sources s ON s.name=n.name
    LEFT JOIN document_rollup d ON d.source=n.name
    LEFT JOIN source_events_rollup e ON e.source=n.name
    LEFT JOIN run_rollup rr ON rr.source=n.name
    LEFT JOIN latest_runs r ON r.source=n.name
   ORDER BY n.name ASC
   LIMIT ?1`;

function inventoryTimestamp(value) {
  const millis = timestampMs(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

const inventoryCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
};

const inventoryNullableCount = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
};

/** Return every source row for one bounded D1 snapshot, in stable id order. */
export async function sourceInventory(env, {
  now = Date.now(),
  maxRows = SOURCE_INVENTORY_MAX_ROWS,
} = {}) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError("source inventory time is invalid");
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > SOURCE_INVENTORY_MAX_ROWS) {
    throw new TypeError("source inventory row limit is invalid");
  }

  let result;
  try {
    result = await env.DB.prepare(sourceInventorySql()).bind(maxRows + 1).all();
  } catch (error) {
    if (!missingFailureEvidenceColumn(error)) throw error;
    // Schema 39 remains readable while migration 0040 is pending. Missing
    // failure evidence is unknown; every older receipt and coverage field
    // keeps its exact meaning, and malformed/non-schema errors never retry.
    result = await env.DB.prepare(sourceInventorySql({ includeFailureEvidence: false }))
      .bind(maxRows + 1)
      .all();
  }
  const rawRows = Array.isArray(result?.results) ? result.results : [];
  const total = rawRows.length ? inventoryCount(rawRows[0].inventory_total) : 0;
  if (total > maxRows || rawRows.length > maxRows) {
    const error = new Error("source inventory exceeds the safe row limit");
    error.code = "source_inventory_too_large";
    throw error;
  }

  const rows = rawRows.map((row) => {
    const registered = row.registered === 1 || row.registered === true || String(row.registered) === "1";
    const sourceId = String(row.name || "");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId)) {
      const error = new Error("source inventory contains an invalid source identity");
      error.code = "source_inventory_invalid_source";
      throw error;
    }
    const physicalDocuments = inventoryCount(row.physical_documents);
    const logicalDocuments = inventoryCount(row.logical_documents);
    const last = timestampMs(row.last_ingest_at);
    const days = Number.isFinite(last) ? Math.floor((now - last) / 86400000) : null;
    const expectedSeconds = Number(row.expected_refresh_seconds) > 0
      ? Math.floor(Number(row.expected_refresh_seconds))
      : null;
    const operational = operationalFreshness({
      ...row,
      indexing_started_at: row.run_finished_at === null ? row.run_started_at : null,
    }, now);
    const automatable = AUTOMATABLE_SOURCE_KINDS.has(String(row.kind || "").toLowerCase());
    let state = registered ? "ok" : "unregistered";
    let reason = registered ? operational.reason : "the source registry entry is missing";
    if (registered && operational.state) state = operational.state;
    else if (registered && !expectedSeconds) state = automatable ? "unscheduled" : "manual";
    else if (registered && !Number.isFinite(last)) state = "never_synced";
    else if (registered && (now - last) / 1000 > expectedSeconds * 1.5) state = "stale";

    const latestRun = row.run_lane === null || row.run_lane === undefined
      ? null
      : {
          lane: String(row.run_lane),
          started_at: inventoryTimestamp(row.run_started_at),
          finished_at: inventoryTimestamp(row.run_finished_at),
          walk_complete: row.run_walk_complete === 1 || row.run_walk_complete === true,
          files_seen: inventoryCount(row.run_files_seen),
          docs_added: inventoryCount(row.run_docs_added),
          docs_updated: inventoryCount(row.run_docs_updated),
          docs_unchanged: inventoryCount(row.run_docs_unchanged),
          docs_refused: inventoryNullableCount(row.run_docs_refused),
          docs_failed: inventoryNullableCount(row.run_docs_failed),
          metrics_version: inventoryNullableCount(row.run_metrics_version),
          confirmed_from: inventoryTimestamp(row.run_confirmed_from),
          confirmed_through: inventoryTimestamp(row.run_confirmed_through),
          target_from: inventoryTimestamp(row.run_target_from),
          target_through: inventoryTimestamp(row.run_target_through),
          proposed_deletes: inventoryCount(row.run_proposed_deletes),
          delete_action: typeof row.run_delete_action === "string" && row.run_delete_action
            ? row.run_delete_action
            : null,
          outcome: row.run_outcome || null,
        };
    const lastFailure = latestRun?.outcome === "failed"
      ? parseStoredSourceFailureEvidence(row.run_failure_evidence, {
          status: "error",
          kind: String(row.kind || "").trim().toLowerCase(),
          metricsVersion: latestRun.metrics_version,
          measuredDocsFailed: latestRun.metrics_version === 1 ? latestRun.docs_failed : null,
        })
      : null;
    const freshness = {
      state,
      reason,
      days_since_ingest: days,
      expected_refresh_seconds: expectedSeconds,
      expected_every_days: expectedSeconds ? Math.max(1, Math.round(expectedSeconds / 86400)) : null,
      last_ingest_at: inventoryTimestamp(row.last_ingest_at),
      last_complete_sweep_at: inventoryTimestamp(row.last_complete_sweep_at),
      indexing_started_at: row.run_finished_at === null ? inventoryTimestamp(row.run_started_at) : null,
      hours_indexing: operational.indexingMs === null
        ? null
        : Math.floor(operational.indexingMs / 3600000),
      automatable,
    };
    freshness.coverage = sourceCoverageFromEvidence({
      kind: String(row.kind || "unregistered"),
      state,
      documents: logicalDocuments,
      last_ingest_at: freshness.last_ingest_at,
      last_complete_sweep_at: freshness.last_complete_sweep_at,
      expected_every_days: freshness.expected_every_days,
      indexing_started_at: freshness.indexing_started_at,
    }, {
      latestRun: latestRun
        ? {
            ...latestRun,
            error: row.run_had_error === 1 || String(row.run_had_error) === "1" ? "present" : null,
            refusal_reason: row.run_was_refused === 1 || String(row.run_was_refused) === "1" ? "present" : null,
          }
        : null,
      projectionPending: null,
    });

    const kind = String(row.kind || "unregistered");
    const provider = SOURCE_PROVIDER_BY_KIND[kind.toLowerCase()] || null;
    const scopeReceipt = maskedSourceScope(row.scope);
    const cursorPresent = registered && typeof row.sync_cursor === "string" && row.sync_cursor.length > 0;
    const firstIngest = earliestInventoryTimestamp([
      ["stored_document", row.first_stored_ingest_at],
      ["source_event", row.first_ingest_event_at],
      ["sync_run", row.first_run_started_at],
    ]);
    const sourceIdentityDocuments = inventoryCount(row.source_identity_documents);
    const extractionMethodDocuments = physicalDocuments - inventoryCount(row.unknown_text_source_documents);
    const extractionReliabilityDocuments = physicalDocuments - inventoryCount(row.text_reliability_unknown_documents);
    const recordedLineageDocuments = inventoryCount(row.recorded_lineage_documents);
    const completeProvenanceDocuments = inventoryCount(row.complete_provenance_documents);
    const unassessedProvenanceDocuments = inventoryCount(row.unassessed_provenance_documents);
    const provenanceEvidenceDocuments = Math.max(
      sourceIdentityDocuments,
      extractionMethodDocuments,
      extractionReliabilityDocuments,
      recordedLineageDocuments,
    );
    const provenanceMissing = [];
    if (unassessedProvenanceDocuments > 0) provenanceMissing.push("validated_provenance_receipt");
    if (sourceIdentityDocuments < physicalDocuments) provenanceMissing.push("source_record_id");
    if (extractionMethodDocuments < physicalDocuments) provenanceMissing.push("extraction_method");
    if (extractionReliabilityDocuments < physicalDocuments) provenanceMissing.push("text_reliability");
    if (recordedLineageDocuments < physicalDocuments) provenanceMissing.push("derivation_lineage");
    if (inventoryCount(row.unrecognized_lineage_documents) > 0) {
      provenanceMissing.push("recognized_lineage_contract");
    }
    const configurationMissing = [];
    if (scopeReceipt.status !== "supported") configurationMissing.push("scope_receipt");
    if (registered && !cursorPresent) configurationMissing.push("sync_cursor_receipt");

    return {
      source_id: sourceId,
      name: sourceId,
      kind,
      registered,
      zone: typeof row.zone === "string" && row.zone.trim() ? row.zone.trim() : null,
      connector: {
        kind,
        provider,
        provider_identity_status: provider ? "supported" : "unavailable",
      },
      configuration: {
        scope: scopeReceipt,
        cursor: {
          status: registered ? (cursorPresent ? "present" : "absent") : "unavailable",
          masked: true,
          updated_at: inventoryTimestamp(row.cursor_updated_at),
        },
        status: !registered || configurationMissing.length
          ? (registered ? "partial" : "unavailable")
          : "complete",
        missing_subfields: configurationMissing,
      },
      storage: {
        physical_documents: physicalDocuments,
        logical_documents: logicalDocuments,
        chunks: inventoryCount(row.chunks),
        readable_documents: inventoryCount(row.readable_documents),
        unreadable_documents: inventoryCount(row.unreadable_documents),
        basis: "document rows are attributed by a validated family_of or part_of receipt when present, otherwise by doc_uid; readable means at least one nonblank stored chunk",
      },
      readability: {
        status: coverageStatus(physicalDocuments, physicalDocuments - inventoryCount(row.unreadable_documents)),
        readable_documents: inventoryCount(row.readable_documents),
        unreadable_documents: inventoryCount(row.unreadable_documents),
        empty_documents: inventoryCount(row.empty_documents),
        blank_only_documents: inventoryCount(row.blank_only_documents),
        text_reliable_documents: inventoryCount(row.text_reliable_documents),
        text_unreliable_documents: inventoryCount(row.text_unreliable_documents),
        text_reliability_unknown_documents: inventoryCount(row.text_reliability_unknown_documents),
        native_text_documents: inventoryCount(row.native_text_documents),
        ocr_documents: inventoryCount(row.ocr_documents),
        ocr_partial_documents: inventoryCount(row.ocr_partial_documents),
        unknown_text_source_documents: inventoryCount(row.unknown_text_source_documents),
        scan_only_documents: null,
        scan_only_status: "unavailable",
        likely_ocr_candidates: inventoryCount(row.likely_ocr_candidates),
        ocr_retry_candidates: inventoryCount(row.ocr_retry_candidates),
        basis: "scan-only is not recorded; OCR candidates are selected only from stored text and extraction receipts",
      },
      provenance: {
        status: physicalDocuments === 0 || provenanceEvidenceDocuments === 0
          ? "unavailable"
          : completeProvenanceDocuments === physicalDocuments
            ? "complete"
            : "partial",
        complete_documents: completeProvenanceDocuments,
        partial_or_unavailable_documents: Math.max(0, physicalDocuments - completeProvenanceDocuments),
        source_identity: {
          status: coverageStatus(physicalDocuments, sourceIdentityDocuments),
          recorded_documents: sourceIdentityDocuments,
          missing_documents: Math.max(0, physicalDocuments - sourceIdentityDocuments),
        },
        extraction: {
          status: coverageStatus(physicalDocuments, Math.min(extractionMethodDocuments, extractionReliabilityDocuments)),
          method_recorded_documents: extractionMethodDocuments,
          method_missing_documents: Math.max(0, physicalDocuments - extractionMethodDocuments),
          reliability_recorded_documents: extractionReliabilityDocuments,
          reliability_missing_documents: Math.max(0, physicalDocuments - extractionReliabilityDocuments),
        },
        lineage: {
          status: coverageStatus(physicalDocuments, recordedLineageDocuments),
          recorded_documents: recordedLineageDocuments,
          missing_documents: Math.max(0, physicalDocuments - recordedLineageDocuments),
          declared_contract_documents: inventoryCount(row.declared_lineage_documents),
          recognized_contract_documents: inventoryCount(row.recognized_lineage_documents),
          family_marker_documents: inventoryCount(row.family_lineage_documents),
        },
        missing_subfields: provenanceMissing,
      },
      recovery_plan: {
        status: inventoryCount(row.recovery_candidate_documents) ? "review_needed" : "no_candidates",
        candidate_documents: inventoryCount(row.recovery_candidate_documents),
        reason_counts: {
          no_stored_chunks: inventoryCount(row.empty_documents),
          blank_only_chunks: inventoryCount(row.blank_only_documents),
          ocr_partial_review: inventoryCount(row.ocr_partial_documents),
          extraction_method_missing: inventoryCount(row.unknown_text_source_documents),
          text_reliability_missing: inventoryCount(row.text_reliability_unknown_documents),
          source_record_id_missing: Math.max(0, physicalDocuments - sourceIdentityDocuments),
          derivation_lineage_missing: Math.max(0, physicalDocuments - recordedLineageDocuments),
          lineage_contract_unrecognized: inventoryCount(row.unrecognized_lineage_documents),
          provenance_receipt_unassessed: unassessedProvenanceDocuments,
        },
        blocking_signals: [
          ...(inventoryCount(row.unreadable_documents) ? ["records_without_readable_text"] : []),
          ...(inventoryCount(row.ocr_partial_documents) ? ["partial_ocr_receipts"] : []),
          ...(provenanceMissing.length ? ["incomplete_provenance_receipts"] : []),
        ],
        priority: inventoryCount(row.unreadable_documents)
          ? "high"
          : inventoryCount(row.recovery_candidate_documents)
            ? "review"
            : "none",
        priority_basis: inventoryCount(row.unreadable_documents)
          ? "stored records without nonblank searchable text"
          : inventoryCount(row.recovery_candidate_documents)
            ? "stored OCR or provenance receipts require review"
            : "no stored recovery condition was found",
        read_only: true,
      },
      receipt: registered
        ? {
            status: typeof row.status === "string" && row.status ? row.status : null,
            registered_at: inventoryTimestamp(row.created_at),
            first_ingest_observed_at: firstIngest.at,
            first_ingest_evidence: firstIngest.evidence,
            first_stored_ingest_at: inventoryTimestamp(row.first_stored_ingest_at),
            last_stored_ingest_at: inventoryTimestamp(row.last_stored_ingest_at),
            last_ingest_receipt_at: inventoryTimestamp(row.last_ingest_at),
            last_successful_run_at: inventoryTimestamp(row.last_successful_run_at),
            complete_history_through: inventoryTimestamp(row.last_complete_sweep_at),
            reported_logical_documents: inventoryCount(row.reported_logical_documents),
            logical_matches_reported: inventoryCount(row.reported_logical_documents) === logicalDocuments,
            latest_run: latestRun,
          }
        : null,
      last_failure: lastFailure,
      freshness,
    };
  });

  if (rows.length !== total) {
    throw new Error("source inventory did not return the complete bounded snapshot");
  }
  return { total, rows };
}

const sourceRecoveryMarkerSql = `
  SELECT i.schema_version AS schema_version,
         i.session_generation AS session_generation,
         i.outbox_generation AS outbox_generation,
         COALESCE((SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL),0) AS live_documents,
         COALESCE((SELECT MAX(rowid) FROM documents),0) AS document_high_water,
         COALESCE((SELECT SUM(rowid) FROM documents WHERE deleted_at IS NULL),0) AS document_rowid_sum,
         COALESCE((SELECT MAX(ingested_at) FROM documents WHERE deleted_at IS NULL),0) AS latest_document_ingest,
         COALESCE((SELECT SUM((rowid * (ingested_at % 1000003)) % 2147483629)
                    FROM documents WHERE deleted_at IS NULL),0) AS ingest_position_marker,
         COALESCE((SELECT SUM(CASE lower(COALESCE(text_source,''))
                           WHEN 'native' THEN 1 WHEN 'ocr' THEN 3 WHEN 'ocr_partial' THEN 7 ELSE 13 END)
                    FROM documents WHERE deleted_at IS NULL),0) AS extraction_marker,
         COALESCE((SELECT SUM(rowid * CASE lower(COALESCE(text_source,''))
                           WHEN 'native' THEN 1 WHEN 'ocr' THEN 3 WHEN 'ocr_partial' THEN 7 ELSE 13 END)
                    FROM documents WHERE deleted_at IS NULL),0) AS extraction_position_marker,
         COALESCE((SELECT SUM(CASE WHEN text_reliable=1 THEN 1 WHEN text_reliable=0 THEN 3 ELSE 7 END)
                    FROM documents WHERE deleted_at IS NULL),0) AS reliability_marker,
         COALESCE((SELECT SUM(rowid * CASE WHEN text_reliable=1 THEN 1 WHEN text_reliable=0 THEN 3 ELSE 7 END)
                    FROM documents WHERE deleted_at IS NULL),0) AS reliability_position_marker,
         COALESCE((SELECT SUM(length(COALESCE(meta,'')) + length(source) + length(source_id))
                    FROM documents WHERE deleted_at IS NULL),0) AS provenance_shape_marker,
         COALESCE((SELECT SUM(rowid * (
                           CASE WHEN trim(COALESCE(source_id,'')) != '' THEN 1 ELSE 3 END
                           + CASE WHEN json_valid(meta) AND json_type(meta,'$.evidence_lineage')='object' THEN 5 ELSE 11 END
                           + CASE WHEN json_valid(meta) AND (
                               (json_type(meta,'$.family_of')='text' AND length(trim(json_extract(meta,'$.family_of'))) > 0)
                               OR (json_type(meta,'$.part_of')='text' AND length(trim(json_extract(meta,'$.part_of'))) > 0)
                             ) THEN 17 ELSE 23 END
                           + CASE WHEN ${LINEAGE_SHAPE_SQL}=1 THEN 29 ELSE 31 END
                         )) FROM documents WHERE deleted_at IS NULL),0) AS provenance_position_marker,
         COALESCE((SELECT SUM(
                           COALESCE(provenance_receipt_version,0) * 3
                           + length(COALESCE(provenance_receipt_status,'')) * 5
                           + length(COALESCE(provenance_receipt_reason,'')) * 7
                           + length(COALESCE(provenance_receipt_digest,'')) * 11
                         ) FROM documents WHERE deleted_at IS NULL),0) AS provenance_assessment_marker,
         COALESCE((SELECT SUM(rowid * (
                           COALESCE(provenance_receipt_version,0) * 3
                           + length(COALESCE(provenance_receipt_status,'')) * 5
                           + length(COALESCE(provenance_receipt_reason,'')) * 7
                           + length(COALESCE(provenance_receipt_digest,'')) * 11
                         )) FROM documents WHERE deleted_at IS NULL),0) AS provenance_assessment_position_marker,
         COALESCE((SELECT COUNT(*) FROM chunks),0) AS chunks,
         COALESCE((SELECT MAX(id) FROM chunks),0) AS chunk_high_water,
         COALESCE((SELECT SUM(id) FROM chunks),0) AS chunk_id_sum,
         COALESCE((SELECT COUNT(*) FROM chunks WHERE trim(text) != ''),0) AS nonblank_chunks,
         COALESCE((SELECT SUM(id) FROM chunks WHERE trim(text) != ''),0) AS nonblank_chunk_id_sum,
         COALESCE((SELECT COUNT(*) FROM sources),0) AS sources,
         COALESCE((SELECT SUM(rowid * (
                           length(name) * 3 + length(kind) * 5 + length(COALESCE(zone,'')) * 7
                           + length(status) * 11 + length(COALESCE(sync_cursor,'')) * 13
                         )) FROM sources),0) AS source_position_marker,
         COALESCE((SELECT MAX(id) FROM source_events),0) AS source_event_high_water
    FROM install_state i
   WHERE i.id=1`;

const sourceRecoverySql = `
  WITH live_documents AS MATERIALIZED (
    SELECT d.rowid AS document_rowid,
           d.doc_uid,
           d.source AS physical_source,
           d.source_id,
           d.ingested_at,
           d.meta,
           d.text_source,
           d.text_reliable,
           d.provenance_receipt_version,
           d.provenance_receipt_status,
           d.provenance_receipt_reason,
           d.provenance_receipt_digest,
           ${PROVENANCE_MARKER_SQL} AS provenance_marker_valid,
           ${FAMILY_UID_SQL} AS family_doc_uid
      FROM documents d
     WHERE d.deleted_at IS NULL
  ),
  attributed_documents AS MATERIALIZED (
    SELECT live_documents.*,
           CASE
             WHEN instr(family_doc_uid, ':') BETWEEN 2 AND 65
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) GLOB '[a-z0-9]*'
              AND substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1) NOT GLOB '*[^a-z0-9_-]*'
               THEN substr(family_doc_uid, 1, instr(family_doc_uid, ':') - 1)
             ELSE physical_source
           END AS inventory_source
      FROM live_documents
  ),
  chunk_per_document AS (
    SELECT a.doc_uid,
           COUNT(c.chunk_uid) AS chunk_count,
           COALESCE(SUM(CASE WHEN trim(c.text) != '' THEN 1 ELSE 0 END),0) AS nonblank_chunk_count
      FROM attributed_documents a
      LEFT JOIN chunks c ON c.doc_uid=a.doc_uid
     GROUP BY a.doc_uid
  ),
  document_flags AS MATERIALIZED (
    SELECT a.*,
           COALESCE(c.chunk_count,0) AS chunk_count,
           COALESCE(c.nonblank_chunk_count,0) AS nonblank_chunk_count,
           CASE WHEN a.provenance_marker_valid=1 AND trim(COALESCE(a.source_id,'')) != '' THEN 1 ELSE 0 END AS has_source_identity,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial') THEN 1 ELSE 0 END AS has_extraction_method,
           CASE WHEN a.provenance_marker_valid=1
                     AND lower(COALESCE(a.text_source,'')) IN ('native','ocr','ocr_partial')
                     AND a.text_reliable IN (0,1) THEN 1 ELSE 0 END AS has_text_reliability,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta)
                     AND json_type(a.meta,'$.evidence_lineage')='object' THEN 1 ELSE 0 END AS declared_lineage,
           CASE WHEN a.provenance_marker_valid=1 THEN ${LINEAGE_SHAPE_SQL} ELSE 0 END AS recognized_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND json_valid(a.meta) AND (
             (json_type(a.meta,'$.family_of')='text' AND length(trim(json_extract(a.meta,'$.family_of'))) > 0)
             OR (json_type(a.meta,'$.part_of')='text' AND length(trim(json_extract(a.meta,'$.part_of'))) > 0)
           ) THEN 1 ELSE 0 END AS family_lineage,
           CASE WHEN a.provenance_marker_valid=1 AND (
             a.provenance_receipt_status='complete'
             OR a.provenance_receipt_reason='text_provenance_unavailable'
           ) THEN 1 ELSE 0 END AS has_lineage
      FROM attributed_documents a
      LEFT JOIN chunk_per_document c ON c.doc_uid=a.doc_uid
  ),
  candidate_rows AS MATERIALIZED (
    SELECT f.*,
           COALESCE(s.kind,'unregistered') AS source_kind,
           s.zone AS source_zone,
           CASE WHEN s.name IS NULL THEN 0 ELSE 1 END AS registered,
           CASE WHEN f.chunk_count=0 THEN 1 ELSE 0 END AS reason_no_stored_chunks,
           CASE WHEN f.chunk_count>0 AND f.nonblank_chunk_count=0 THEN 1 ELSE 0 END AS reason_blank_only_chunks,
           CASE WHEN f.has_extraction_method=1 AND lower(COALESCE(f.text_source,''))='ocr_partial' THEN 1 ELSE 0 END AS reason_ocr_partial_review,
           CASE WHEN f.provenance_marker_valid=0 THEN 1 ELSE 0 END AS reason_provenance_receipt_unassessed,
           CASE WHEN f.has_extraction_method=0 THEN 1 ELSE 0 END AS reason_extraction_method_missing,
           CASE WHEN f.has_text_reliability=0 THEN 1 ELSE 0 END AS reason_text_reliability_missing,
           CASE WHEN f.has_source_identity=0 THEN 1 ELSE 0 END AS reason_source_record_id_missing,
           CASE WHEN f.has_lineage=0 THEN 1 ELSE 0 END AS reason_derivation_lineage_missing,
           CASE WHEN f.declared_lineage=1 AND f.recognized_lineage=0 THEN 1 ELSE 0 END AS reason_lineage_contract_unrecognized
      FROM document_flags f
      LEFT JOIN sources s ON s.name=f.inventory_source
     WHERE (?1 IS NULL OR f.inventory_source=?1)
       AND (
         f.nonblank_chunk_count=0
         OR (f.has_extraction_method=1 AND lower(COALESCE(f.text_source,''))='ocr_partial')
         OR f.provenance_marker_valid=0
         OR f.has_source_identity=0
         OR f.has_extraction_method=0
         OR f.has_text_reliability=0
         OR f.has_lineage=0
         OR (f.declared_lineage=1 AND f.recognized_lineage=0)
       )
  ),
  source_groups AS MATERIALIZED (
    SELECT inventory_source AS source_id,
           source_kind,
           source_zone AS zone,
           COUNT(*) AS candidate_documents,
           SUM(reason_no_stored_chunks) AS no_stored_chunks,
           SUM(reason_blank_only_chunks) AS blank_only_chunks,
           SUM(reason_ocr_partial_review) AS ocr_partial_review,
           SUM(reason_provenance_receipt_unassessed) AS provenance_receipt_unassessed,
           SUM(reason_extraction_method_missing) AS extraction_method_missing,
           SUM(reason_text_reliability_missing) AS text_reliability_missing,
           SUM(reason_source_record_id_missing) AS source_record_id_missing,
           SUM(reason_derivation_lineage_missing) AS derivation_lineage_missing,
           SUM(reason_lineage_contract_unrecognized) AS lineage_contract_unrecognized
      FROM candidate_rows
     GROUP BY inventory_source,source_kind,source_zone
  ),
  global_summary AS (
    SELECT COUNT(*) AS recovery_total,
           (SELECT COUNT(*) FROM source_groups) AS recovery_source_group_total,
           COALESCE(SUM(reason_no_stored_chunks),0) AS total_no_stored_chunks,
           COALESCE(SUM(reason_blank_only_chunks),0) AS total_blank_only_chunks,
           COALESCE(SUM(reason_ocr_partial_review),0) AS total_ocr_partial_review,
           COALESCE(SUM(reason_provenance_receipt_unassessed),0) AS total_provenance_receipt_unassessed,
           COALESCE(SUM(reason_extraction_method_missing),0) AS total_extraction_method_missing,
           COALESCE(SUM(reason_text_reliability_missing),0) AS total_text_reliability_missing,
           COALESCE(SUM(reason_source_record_id_missing),0) AS total_source_record_id_missing,
           COALESCE(SUM(reason_derivation_lineage_missing),0) AS total_derivation_lineage_missing,
           COALESCE(SUM(reason_lineage_contract_unrecognized),0) AS total_lineage_contract_unrecognized
      FROM candidate_rows
  )
  SELECT candidate_rows.*,
         global_summary.*,
         CASE WHEN candidate_rows.document_rowid=(
           SELECT MIN(next_candidate.document_rowid)
             FROM candidate_rows next_candidate
            WHERE next_candidate.document_rowid>?2
         ) THEN (SELECT json_group_array(json_object(
            'source_id',ordered.source_id,
            'source_kind',ordered.source_kind,
            'zone',ordered.zone,
            'candidate_documents',ordered.candidate_documents,
            'no_stored_chunks',ordered.no_stored_chunks,
            'blank_only_chunks',ordered.blank_only_chunks,
            'ocr_partial_review',ordered.ocr_partial_review,
            'provenance_receipt_unassessed',ordered.provenance_receipt_unassessed,
            'extraction_method_missing',ordered.extraction_method_missing,
            'text_reliability_missing',ordered.text_reliability_missing,
            'source_record_id_missing',ordered.source_record_id_missing,
            'derivation_lineage_missing',ordered.derivation_lineage_missing,
            'lineage_contract_unrecognized',ordered.lineage_contract_unrecognized
          )) FROM (SELECT * FROM source_groups ORDER BY source_id LIMIT 250) ordered)
         ELSE NULL END AS recovery_source_groups
    FROM candidate_rows
    CROSS JOIN global_summary
   WHERE document_rowid>?2
   ORDER BY document_rowid ASC
   LIMIT ?3`;

function normalizedRecoveryMarker(row) {
  if (!row || typeof row !== "object") throw new Error("source recovery marker is unavailable");
  const marker = {};
  for (const field of [
    "schema_version", "session_generation", "outbox_generation", "live_documents", "document_high_water", "document_rowid_sum",
    "latest_document_ingest", "ingest_position_marker", "extraction_marker", "extraction_position_marker",
    "reliability_marker", "reliability_position_marker", "provenance_shape_marker", "provenance_position_marker",
    "provenance_assessment_marker", "provenance_assessment_position_marker",
    "chunks", "chunk_high_water", "chunk_id_sum", "nonblank_chunks", "nonblank_chunk_id_sum",
    "sources", "source_position_marker", "source_event_high_water",
  ]) {
    const value = Number(row[field]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`source recovery marker has an invalid ${field}`);
    }
    marker[field] = value;
  }
  return marker;
}

async function sourceRecoveryMarker(env) {
  return normalizedRecoveryMarker(await env.DB.prepare(sourceRecoveryMarkerSql).first());
}

async function sourceRecoveryPrivacyKey(env) {
  const secret = String(env?.SESSION_SIGNING_KEY || "");
  if (!secret) throw new Error("source recovery privacy key is unavailable");
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

async function opaqueInventoryRecordId(key, docUid) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.sign(
    "HMAC", key, encoder.encode(`financial-brain-source-record-v1\u0000${String(docUid)}`),
  );
  return `hmac-sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Return one bounded page of records that need provenance or OCR review.
 *
 * No title, URI, provider id, source-local path, content, metadata, or raw
 * document uid crosses this boundary. The opaque digest is a stable way to
 * compare a later approved repair receipt with this preview, not a write
 * capability. The opening and closing markers refuse a page that overlaps a
 * corpus change.
 */
export async function sourceRecoveryCandidates(env, {
  source = null,
  afterRowId = 0,
  limit = 100,
} = {}) {
  const normalizedSource = source === null ? null : String(source);
  if (normalizedSource !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedSource)) {
    throw new TypeError("source recovery filter needs a normalized source name");
  }
  if (!Number.isSafeInteger(afterRowId) || afterRowId < 0) {
    throw new TypeError("source recovery cursor is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_RECOVERY_MAX_PAGE_SIZE) {
    throw new TypeError("source recovery page size is invalid");
  }

  const openingMarker = await sourceRecoveryMarker(env);
  const result = await env.DB.prepare(sourceRecoverySql)
    .bind(normalizedSource, afterRowId, limit + 1)
    .all();
  const closingMarker = await sourceRecoveryMarker(env);
  if (JSON.stringify(openingMarker) !== JSON.stringify(closingMarker)) {
    const error = new Error("source recovery inventory changed during the read");
    error.code = "source_recovery_changed";
    throw error;
  }

  const rawRows = Array.isArray(result?.results) ? result.results : [];
  const pageRows = rawRows.slice(0, limit);
  const total = rawRows.length ? inventoryCount(rawRows[0].recovery_total) : 0;
  const reasonFieldMap = Object.freeze({
    no_stored_chunks: "total_no_stored_chunks",
    blank_only_chunks: "total_blank_only_chunks",
    ocr_partial_review: "total_ocr_partial_review",
    provenance_receipt_unassessed: "total_provenance_receipt_unassessed",
    extraction_method_missing: "total_extraction_method_missing",
    text_reliability_missing: "total_text_reliability_missing",
    source_record_id_missing: "total_source_record_id_missing",
    derivation_lineage_missing: "total_derivation_lineage_missing",
    lineage_contract_unrecognized: "total_lineage_contract_unrecognized",
  });
  const reasonCounts = Object.fromEntries(Object.entries(reasonFieldMap).map(([reason, field]) => [
    reason,
    rawRows.length ? inventoryCount(rawRows[0][field]) : 0,
  ]));
  let rawGroups = [];
  if (rawRows.length) {
    try { rawGroups = JSON.parse(String(rawRows[0].recovery_source_groups || "[]")); } catch {
      throw new Error("source recovery source summary is invalid");
    }
  }
  if (!Array.isArray(rawGroups)) throw new Error("source recovery source summary is invalid");
  const sourceGroups = rawGroups.map((group) => {
    const sourceId = String(group?.source_id || "");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId)) {
      throw new Error("source recovery source summary contains an invalid source identity");
    }
    const reasons = Object.fromEntries(Object.keys(reasonFieldMap).map((reason) => [
      reason,
      inventoryCount(group[reason]),
    ]));
    const blockingSignals = [
      ...(reasons.no_stored_chunks || reasons.blank_only_chunks ? ["records_without_readable_text"] : []),
      ...(reasons.ocr_partial_review ? ["partial_ocr_receipts"] : []),
      ...(reasons.provenance_receipt_unassessed || reasons.extraction_method_missing || reasons.text_reliability_missing ||
          reasons.source_record_id_missing || reasons.derivation_lineage_missing ||
          reasons.lineage_contract_unrecognized ? ["incomplete_provenance_receipts"] : []),
    ];
    return {
      source_id: sourceId,
      source_kind: String(group.source_kind || "unregistered"),
      zone: typeof group.zone === "string" && group.zone.trim() ? group.zone.trim() : null,
      candidate_documents: inventoryCount(group.candidate_documents),
      reason_counts: reasons,
      blocking_signals: blockingSignals,
      priority: blockingSignals.includes("records_without_readable_text") ? "high" : "review",
      priority_basis: blockingSignals.includes("records_without_readable_text")
        ? "stored records without nonblank searchable text"
        : "stored OCR or provenance receipts require review",
    };
  });
  const sourceGroupTotal = rawRows.length
    ? inventoryCount(rawRows[0].recovery_source_group_total)
    : 0;
  if (sourceGroups.length > sourceGroupTotal || sourceGroups.length > SOURCE_RECOVERY_MAX_PAGE_SIZE) {
    throw new Error("source recovery source summary exceeds its declared bound");
  }
  const privacyKey = pageRows.length ? await sourceRecoveryPrivacyKey(env) : null;
  const candidates = await Promise.all(pageRows.map(async (row) => {
    const sourceId = String(row.inventory_source || "");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId)) {
      const error = new Error("source recovery inventory contains an invalid source identity");
      error.code = "source_inventory_invalid_source";
      throw error;
    }
    const chunkCount = inventoryCount(row.chunk_count);
    const nonblankChunks = inventoryCount(row.nonblank_chunk_count);
    const storedAssessment = await storedProvenanceMarkerAssessment({
      ...row,
      source: row.physical_source,
    });
    const provenanceAssessed = storedAssessment.provenance_assessed === true &&
      storedAssessment.provenance_marker_valid === true;
    const extractionMethod = provenanceAssessed &&
      ["native", "ocr", "ocr_partial"].includes(storedAssessment.text_source)
      ? storedAssessment.text_source
      : "unknown";
    const hasSourceIdentity = provenanceAssessed &&
      (row.has_source_identity === 1 || String(row.has_source_identity) === "1");
    const hasExtractionMethod = provenanceAssessed &&
      (row.has_extraction_method === 1 || String(row.has_extraction_method) === "1");
    const hasTextReliability = provenanceAssessed &&
      (row.has_text_reliability === 1 || String(row.has_text_reliability) === "1");
    const declaredLineage = provenanceAssessed &&
      (row.declared_lineage === 1 || String(row.declared_lineage) === "1");
    const recognizedLineage = provenanceAssessed &&
      (row.recognized_lineage === 1 || String(row.recognized_lineage) === "1");
    const familyLineage = provenanceAssessed &&
      (row.family_lineage === 1 || String(row.family_lineage) === "1");
    const hasLineage = provenanceAssessed &&
      (row.has_lineage === 1 || String(row.has_lineage) === "1");
    const missingFields = [];
    if (!provenanceAssessed) missingFields.push("validated_provenance_receipt");
    if (!hasSourceIdentity) missingFields.push("source_record_id");
    if (!hasExtractionMethod) missingFields.push("extraction_method");
    if (!hasTextReliability) missingFields.push("text_reliability");
    if (!hasLineage) missingFields.push("derivation_lineage");
    if (declaredLineage && !recognizedLineage) missingFields.push("recognized_lineage_contract");
    const reasons = [];
    if (chunkCount === 0) reasons.push("no_stored_chunks");
    else if (nonblankChunks === 0) reasons.push("blank_only_chunks");
    if (extractionMethod === "ocr_partial") reasons.push("ocr_partial_review");
    if (!provenanceAssessed) reasons.push("provenance_receipt_unassessed");
    if (!hasExtractionMethod) reasons.push("extraction_method_missing");
    if (!hasTextReliability) reasons.push("text_reliability_missing");
    if (!hasSourceIdentity) reasons.push("source_record_id_missing");
    if (!hasLineage) reasons.push("derivation_lineage_missing");
    if (declaredLineage && !recognizedLineage) reasons.push("lineage_contract_unrecognized");
    const recordId = await opaqueInventoryRecordId(privacyKey, row.doc_uid);
    const likelyOcrCandidate = nonblankChunks === 0 && !["ocr", "ocr_partial"].includes(extractionMethod);
    const ocrRetryCandidate = nonblankChunks === 0 && ["ocr", "ocr_partial"].includes(extractionMethod);
    return {
      record_id: recordId,
      locator: { kind: "opaque_document_digest", value: recordId, reversible: false },
      source_id: sourceId,
      source_kind: String(row.source_kind || "unregistered"),
      registered: row.registered === 1 || String(row.registered) === "1",
      zone: typeof row.source_zone === "string" && row.source_zone.trim() ? row.source_zone.trim() : null,
      ingested_at: inventoryTimestamp(row.ingested_at),
      text: {
        extraction_method: extractionMethod,
        text_reliable: hasTextReliability ? storedAssessment.text_reliable : null,
        chunks: chunkCount,
        nonblank_chunks: nonblankChunks,
        content_state: nonblankChunks > 0 ? "readable" : (chunkCount > 0 ? "blank_only" : "empty"),
        scan_only_status: "unavailable",
      },
      ocr: {
        likely_candidate: likelyOcrCandidate,
        retry_candidate: ocrRetryCandidate,
        partial_review: extractionMethod === "ocr_partial",
        basis: likelyOcrCandidate
          ? "no nonblank stored text and no recorded prior OCR"
          : ocrRetryCandidate
            ? "no nonblank stored text after recorded OCR"
            : extractionMethod === "ocr_partial"
              ? "the ingestion receipt records partial OCR"
              : null,
      },
      provenance: {
        status: provenanceAssessed
          ? storedAssessment.provenance_status
          : "unavailable",
        receipt_validation_status: provenanceAssessed ? "validated" : "unassessed",
        source_identity_status: hasSourceIdentity ? "complete" : "unavailable",
        extraction_status: hasExtractionMethod && hasTextReliability
          ? "complete"
          : (hasExtractionMethod || hasTextReliability ? "partial" : "unavailable"),
        lineage_status: hasLineage ? "complete" : "unavailable",
        lineage_basis: recognizedLineage
          ? "recognized_contract"
          : familyLineage
            ? "recorded_family_marker"
            : declaredLineage
              ? "unrecognized_contract"
              : "not_recorded",
        missing_subfields: missingFields,
      },
      reasons,
      plan: {
        mode: "preview_only",
        suggested_next_step: likelyOcrCandidate
          ? "review_original_for_ocr"
          : ocrRetryCandidate
            ? "review_empty_ocr_result"
            : extractionMethod === "ocr_partial"
              ? "review_partial_ocr_result"
              : "recover_provenance_receipt",
      },
    };
  }));

  return {
    total,
    rows: candidates,
    truncated: rawRows.length > limit,
    nextAfterRowId: rawRows.length > limit && pageRows.length
      ? inventoryCount(pageRows[pageRows.length - 1].document_rowid)
      : null,
    marker: openingMarker,
    summary: {
      status: total ? "review_needed" : "no_candidates",
      read_only: true,
      candidate_documents: total,
      candidate_source_groups: sourceGroupTotal,
      source_groups_returned: sourceGroups.length,
      source_groups_truncated: sourceGroups.length < sourceGroupTotal,
      source_group_details: sourceGroups.length < sourceGroupTotal
        ? "rerun_with_source_filter_or_read_source_inventory_pages"
        : "complete",
      candidate_pages_at_max_size: Math.ceil(total / SOURCE_RECOVERY_MAX_PAGE_SIZE),
      maximum_page_size: SOURCE_RECOVERY_MAX_PAGE_SIZE,
      priority: sourceGroups.some((group) => group.priority === "high")
        ? "high"
        : total
          ? "review"
          : "none",
      blocking_signals: [
        "records_without_readable_text",
        "partial_ocr_receipts",
        "incomplete_provenance_receipts",
      ].filter((signal) => sourceGroups.some((group) => group.blocking_signals.includes(signal))),
      reason_counts: reasonCounts,
      source_groups: sourceGroups,
    },
  };
}

// Ninety-nine ids plus the queued_at value exactly fit the installer's shared
// 100-bind D1 ceiling. Keep this independent from the drain's 100-row batch.
export const VECTOR_BOOTSTRAP_PAGE_SIZE = 99;

/**
 * Advance one crash-resumable legacy projection page.
 *
 * The migration only records a high-water mark. Each call enqueues at most 99
 * rows in one INSERT..SELECT and advances the epoch-bound cursor in the same
 * D1 transaction. Callers must drain the current page to exact visibility
 * before asking for another, which caps bootstrap queue growth and makes a
 * 736k-chunk upgrade resumable without one trigger-amplified migration.
 */
export async function bootstrapVectorProjectionPage(env, {
  pageSize = VECTOR_BOOTSTRAP_PAGE_SIZE,
  now = Date.now(),
} = {}) {
  const limit = Number.isInteger(pageSize)
    ? Math.min(VECTOR_BOOTSTRAP_PAGE_SIZE, Math.max(1, pageSize))
    : VECTOR_BOOTSTRAP_PAGE_SIZE;
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("vector bootstrap time is invalid");

  const state = await env.DB.prepare(
    `SELECT vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_cursor AS cursor,
            vector_projection_bootstrap_high_water AS high_water,
            (SELECT count(*) FROM chunks) AS chunks,
            (SELECT count(*) FROM vector_outbox) AS pending
       FROM install_state WHERE id = 1 AND schema_version >= 12`
  ).first();
  if (!state || !["verified", "pending", "bootstrap_required"].includes(String(state.status))) {
    throw new Error("vector bootstrap state is unavailable");
  }
  const epoch = Number(state.epoch);
  const chunks = Number(state.chunks);
  const pending = Number(state.pending);
  if (![epoch, chunks, pending].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("vector bootstrap counts are invalid");
  }
  if (state.status !== "bootstrap_required") {
    return {
      bootstrap: true,
      complete: true,
      chunks,
      page_chunks: 0,
      queued: 0,
      already_queued: pending,
      pending,
      epoch,
    };
  }
  if (pending > 0) {
    return {
      bootstrap: true,
      complete: false,
      blocked_on_drain: true,
      chunks,
      page_chunks: 0,
      queued: 0,
      already_queued: pending,
      pending,
      epoch,
    };
  }

  const cursor = state.cursor === null || state.cursor === undefined ? "" : String(state.cursor);
  const highWater = state.high_water === null || state.high_water === undefined
    ? ""
    : String(state.high_water);
  if (chunks > 0 && !highWater) {
    throw new Error("vector bootstrap cursor is invalid");
  }
  const { results: candidates } = await env.DB.prepare(
    `SELECT chunk_uid FROM chunks
      WHERE chunk_uid > ?1 AND chunk_uid <= ?2
      ORDER BY chunk_uid LIMIT ?3`
  ).bind(cursor, highWater, limit + 1).all();
  if (!Array.isArray(candidates)) throw new Error("vector bootstrap page is invalid");
  const page = candidates.slice(0, limit);
  const hasMore = candidates.length > limit;
  const nextCursor = hasMore ? String(page.at(-1)?.chunk_uid || "") : highWater;
  if (page.length && !nextCursor) throw new Error("vector bootstrap page cursor is invalid");
  const nextStatus = hasMore ? "bootstrap_required" : "pending";

  const statements = [];
  if (page.length) {
    const pageIds = page.map((row) => String(row?.chunk_uid || ""));
    if (pageIds.some((id) => !id)) {
      throw new Error("vector bootstrap page identity is invalid");
    }
    const placeholders = pageIds.map((_, index) => `?${index + 1}`).join(",");
    statements.push(env.DB.prepare(
      `INSERT INTO vector_outbox
         (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       SELECT c.chunk_uid, COALESCE(c.vector_id, c.chunk_uid), 'upsert', ?${pageIds.length + 1}, 0, NULL
         FROM chunks c
        WHERE c.chunk_uid IN (${placeholders})
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='upsert', queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).bind(...pageIds, now));
  }
  statements.push(env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_status = ?5,
            vector_projection_bootstrap_cursor = ?4
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status = 'bootstrap_required'
        AND vector_projection_bootstrap_epoch = ?1
        AND COALESCE(vector_projection_bootstrap_cursor, '') = ?2
        AND COALESCE(vector_projection_bootstrap_high_water, '') = ?3`
  ).bind(epoch, cursor, highWater, nextCursor, nextStatus));
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      drainLeaseChanges(results.at(-1)) !== 1) {
    throw new Error("vector bootstrap epoch changed; retry from durable state");
  }
  const after = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const afterPending = Number(after?.n);
  if (!Number.isSafeInteger(afterPending) || afterPending < 0) {
    throw new Error("vector bootstrap outbox receipt is invalid");
  }
  return {
    bootstrap: true,
    complete: !hasMore,
    blocked_on_drain: false,
    chunks,
    page_chunks: page.length,
    queued: afterPending,
    already_queued: 0,
    pending: afterPending,
    epoch,
  };
}

export const ACCELERATED_BOOTSTRAP_PAGE_SIZE = 1000;
export const ACCELERATED_BOOTSTRAP_WINDOW = 3;
const ACCELERATED_BOOTSTRAP_CONCURRENCY = 6;
const ACCELERATED_BOOTSTRAP_PROTOCOL = "bootstrap-v2";
// A residue-only re-projection epoch walks only chunks that still hold a queued
// upsert row instead of the whole corpus. Its marker is
// install_state.vector_projection_residue_epoch (migration 0036), set to the
// epoch it opened and left in place afterwards as the durable record that that
// epoch WAS a residue epoch (the anti-reopen guard reads it).
//
// THE INVARIANT THE DESIGN RESTS ON. Openness is a CONJUNCTION: the column
// equals vector_projection_bootstrap_epoch AND the status is
// bootstrap_required. That pair must never coincide by accident, because a
// brain that wrongly reads as an open residue walk would page its OUTBOX
// instead of its corpus, silently omitting every chunk with no queued row and
// never verifying. It holds because only two paths write bootstrap_required
// onto an existing brain: resetVectorProjectionBootstrap, which advances the
// epoch in the same statement so a stale column cannot match, and the open
// itself, which sets the column, the epoch and the status together in one
// fenced batch. (cmdMigrate's install_state upsert also names that status, but
// only in its INSERT arm; its ON CONFLICT clause updates just the slug and the
// schema and gate versions, so it cannot move an existing brain's epoch.)
//
// It is deliberately NOT the protocol column: every shipped Worker branches on that column, and the
// legacy branch deletes queued upserts before it refuses, so an interrupted
// residue epoch re-run from an older kit would have lost the queue. An older
// Worker never reads the residue column. Meeting an OPEN residue epoch it sees
// an ordinary v2 walk: it drains the queued rows through its paused drain, then
// walks the whole range and re-embeds them (wasteful, never lossy; measured
// against main: every vector present, nothing deleted), and its final receipt
// fails its own base-count invariant once, after which a re-run completes.
export const RESIDUE_REPROJECTION_SCHEMA = 36;
// Residue behaviour applies only while the residue walk is actually OPEN: the
// column names this epoch and the status is bootstrap_required. Once the walk
// has ended, every queued row drains the ordinary way, so a later small queue
// can never be skipped.
function residueWalkOpen(state) {
  return state.status === "bootstrap_required" &&
    state.residue_epoch !== null && state.residue_epoch !== undefined &&
    Number.isSafeInteger(Number(state.residue_epoch)) && Number(state.residue_epoch) === state.epoch;
}

async function mapBounded(values, limit, operation) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function bootstrapStateV2(env) {
  const state = await env.DB.prepare(
    `SELECT schema_version, vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_cursor AS cursor,
            vector_projection_bootstrap_high_water AS high_water,
            vector_projection_bootstrap_protocol AS protocol,
            vector_projection_bootstrap_base_count AS base_count
       FROM install_state WHERE id = 1`
  ).first();
  if (!state || Number(state.schema_version) < 13) {
    throw new Error("the accelerated vector bootstrap schema is not active");
  }
  const epoch = Number(state.epoch);
  const baseCount = Number(state.base_count);
  if (!Number.isSafeInteger(epoch) || epoch < 0 ||
      !Number.isSafeInteger(baseCount) || baseCount < 0) {
    throw new Error("the accelerated vector bootstrap state is invalid");
  }
  // The residue column arrives in migration 0036; older fixtures and brains
  // simply have no residue epoch.
  let residueEpoch = null;
  if (Number(state.schema_version) >= RESIDUE_REPROJECTION_SCHEMA) {
    const residue = await env.DB.prepare(
      "SELECT vector_projection_residue_epoch AS residue_epoch FROM install_state WHERE id = 1"
    ).first();
    residueEpoch = residue?.residue_epoch === null || residue?.residue_epoch === undefined
      ? null
      : Number(residue.residue_epoch);
  }
  return {
    ...state,
    epoch,
    baseCount,
    residue_epoch: residueEpoch,
    cursor: state.cursor === null || state.cursor === undefined ? "" : String(state.cursor),
    highWater: state.high_water === null || state.high_water === undefined ? "" : String(state.high_water),
  };
}

async function acceleratedBootstrapReceipt(env, phase, blocked = null, options = null) {
  const state = await bootstrapStateV2(env);
  const [counts, queue, batches, readiness] = await Promise.all([
    env.DB.prepare("SELECT count(*) AS n FROM chunks").first(),
    // `remaining` (below) is a CHUNK count: total chunks minus the base plus
    // confirmed batches, and the base/confirmed math treats every live-chunk
    // upsert row as "pending" regardless of quarantine (RESIDUE_UNPROJECTED_
    // FROM_SQL does not filter on it), so a quarantined upsert is already
    // correctly reflected in `remaining` and belongs in `queued` too. A DELETE
    // row or an ORPHAN upsert (chunk already gone) is neither, and outside
    // legacy_drain phase that now matters: residue mode never blocks the walk
    // on such a row (it is surfaced instead via blocked_on/blocked_rows), so
    // one left in the outbox while phase is waiting/building would otherwise
    // inflate queued+submitted past remaining and the CLI's own reconcile
    // check would die with no name and no remedy. During legacy_drain the
    // opposite is deliberate: a zero-chunk corpus can still have many deletes
    // to drain, and the CLI exempts that phase from the check for exactly
    // that reason, so this exclusion must not apply there.
    env.DB.prepare(
      `SELECT count(*) AS n,
              sum(CASE WHEN o.submitted_mutation_id IS NULL AND (?1=0 OR (o.op='upsert' AND c.chunk_uid IS NOT NULL))
                      THEN 1 ELSE 0 END) AS queued,
              sum(CASE WHEN o.submitted_mutation_id IS NOT NULL AND (?1=0 OR (o.op='upsert' AND c.chunk_uid IS NOT NULL))
                      THEN 1 ELSE 0 END) AS submitted,
              sum(CASE WHEN o.op='upsert' AND c.chunk_uid IS NOT NULL THEN 1 ELSE 0 END) AS pending_upserts,
              sum(CASE WHEN s.quarantined_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
              sum(CASE WHEN s.quarantined_at IS NULL AND COALESCE(s.attempts,o.attempts,0)>0 THEN 1 ELSE 0 END) AS retrying
         FROM vector_outbox o
         LEFT JOIN chunks c ON c.chunk_uid=o.chunk_uid
         LEFT JOIN vector_outbox_retry_state s
           ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation`
    ).bind(phase === "legacy_drain" ? 0 : 1).first(),
    env.DB.prepare(
      `SELECT COALESCE(sum(CASE WHEN status='confirmed' THEN row_count ELSE 0 END),0) AS confirmed,
              sum(CASE WHEN status IN ('queued','submitted') THEN 1 ELSE 0 END) AS in_flight
         FROM vector_bootstrap_batches WHERE epoch=?1`
    ).bind(state.epoch).first(),
    vectorReadiness(env),
  ]);
  const total = Number(counts?.n);
  const historicalConfirmed = state.baseCount + Number(batches?.confirmed || 0);
  const pendingUpserts = Number(queue?.pending_upserts || 0);
  const queued = Number(queue?.queued || 0);
  const submitted = Number(queue?.submitted || 0);
  const failed = Number(queue?.failed || 0);
  const retrying = Number(queue?.retrying || 0);
  const inFlight = Number(batches?.in_flight || 0);
  if (![total, historicalConfirmed, pendingUpserts, queued, submitted, failed, retrying, inFlight].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) || pendingUpserts > total || inFlight > ACCELERATED_BOOTSTRAP_WINDOW) {
    throw new Error("the accelerated vector bootstrap receipt is invalid");
  }
  // Confirmed batch rows describe the earlier corpus cut. Ordinary writes can
  // replace or delete those chunks before the next upgrade pause, so that old
  // count must not certify a current chunk whose upsert is still outstanding.
  // Deletes are separate cleanup work: a zero-chunk corpus can still have many
  // vectors waiting to be deleted. Keep their queued/submitted counts explicit.
  // A pending projection stays in this phase even after its queue clears while
  // the provider count catches up. No history, cursor, or epoch is rewritten.
  const currentCorpusReceipt = phase === "legacy_drain" || state.status === "pending";
  const confirmed = currentCorpusReceipt
    ? Math.min(historicalConfirmed, total - pendingUpserts)
    : historicalConfirmed;
  if (confirmed > total) {
    throw new Error("the accelerated vector bootstrap receipt is invalid");
  }
  const complete = state.status === "verified" && confirmed === total &&
    queued === 0 && submitted === 0 && inFlight === 0 && failed === 0 &&
    readiness.ready === true && readiness.expected_vectors === total &&
    readiness.actual_vectors === total;
  return {
    protocol: ACCELERATED_BOOTSTRAP_PROTOCOL,
    // A queue-empty bulk bootstrap may await the provider count while pending.
    // Clamp to the current corpus without inventing a return to legacy work.
    phase: complete ? "complete" : phase,
    epoch: state.epoch,
    total,
    confirmed,
    queued,
    submitted,
    remaining: total - confirmed,
    in_flight_batches: inFlight,
    failed,
    // Kept distinct from current-generation quarantine: provider visibility
    // retries remain eligible after backoff and do not require operator repair.
    retrying,
    complete,
    vector_ready: readiness.ready === true,
    expected_vectors: readiness.expected_vectors,
    actual_vectors: readiness.actual_vectors,
    // The fields below exist only for a CLI that declared receipt contract 2.
    // A 0.4.1-kit CLI validates receipts against an exact field list, so a new
    // Worker must answer it in the old shape.
    ...(Number(options?.contract) >= 2 && residueWalkOpen(state)
      ? { reprojected_residue: await residueReprojectedRows(env, state) }
      : {}),
    ...(Number(options?.contract) >= 2 && blocked && ["quarantine", "fence", "cleanup"].includes(blocked.blocked_on)
      ? { blocked_on: blocked.blocked_on, blocked_rows: Number(blocked.blocked_rows) || 0 }
      : {}),
  };
}

/** The queued chunks this residue epoch re-embeds: the count its receipt row recorded at the open. */
async function residueReprojectedRows(env, state) {
  const row = await env.DB.prepare(
    "SELECT rows FROM vector_projection_events WHERE kind=?1 AND epoch_after=?2 ORDER BY id DESC LIMIT 1"
  ).bind(RESIDUE_REPROJECTION_EVENT, state.epoch).first();
  const rows = Number(row?.rows);
  return Number.isSafeInteger(rows) && rows >= 0 ? rows : 0;
}

async function activateAcceleratedBootstrap(env, state) {
  if (state.protocol === ACCELERATED_BOOTSTRAP_PROTOCOL) return state;
  if (state.protocol !== null && state.protocol !== undefined && state.protocol !== "") {
    throw new Error("the vector bootstrap protocol is not supported by this Worker");
  }
  const pending = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  if (Number(pending?.n || 0) !== 0) return null;
  const result = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_bootstrap_protocol=?2,
            vector_projection_bootstrap_base_count=(
              SELECT count(*) FROM chunks
               WHERE chunk_uid <= COALESCE(vector_projection_bootstrap_cursor,'')
            ),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks)
      WHERE id=1 AND schema_version>=13
        AND vector_projection_bootstrap_epoch=?1
        AND vector_projection_status='bootstrap_required'
        AND vector_projection_bootstrap_protocol IS NULL
        AND NOT EXISTS (SELECT 1 FROM vector_outbox)`
  ).bind(state.epoch, ACCELERATED_BOOTSTRAP_PROTOCOL).run();
  if (drainLeaseChanges(result) !== 1) {
    throw new Error("the accelerated vector bootstrap could not establish its durable boundary");
  }
  return bootstrapStateV2(env);
}

async function queueAcceleratedBootstrapBatch(env, state, now, lease = null) {
  if (residueWalkOpen(state)) return queueResidueBatch(env, state, lease);
  const { results: candidates } = await env.DB.prepare(
    `SELECT chunk_uid FROM chunks
      WHERE chunk_uid>?1 AND chunk_uid<=?2
      ORDER BY chunk_uid LIMIT ?3`
  ).bind(state.cursor, state.highWater, ACCELERATED_BOOTSTRAP_PAGE_SIZE + 1).all();
  if (!Array.isArray(candidates)) throw new Error("the accelerated bootstrap page is invalid");
  const page = candidates.slice(0, ACCELERATED_BOOTSTRAP_PAGE_SIZE);
  if (!page.length) return false;
  const endCursor = String(page.at(-1)?.chunk_uid || "");
  if (!endCursor) throw new Error("the accelerated bootstrap cursor is invalid");
  const sequence = await env.DB.prepare(
    "SELECT COALESCE(max(batch_no),0)+1 AS n FROM vector_bootstrap_batches WHERE epoch=?1"
  ).bind(state.epoch).first();
  const batchNo = Number(sequence?.n);
  if (!Number.isSafeInteger(batchNo) || batchNo < 1) {
    throw new Error("the accelerated bootstrap batch identity is invalid");
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vector_bootstrap_batches
         (epoch,batch_no,start_cursor,end_cursor,row_count,status)
       VALUES (?1,?2,?3,?4,?5,'queued')`
    ).bind(state.epoch, batchNo, state.cursor, endCursor, page.length),
    env.DB.prepare(
      `INSERT INTO vector_outbox
         (chunk_uid,vector_id,op,queued_at,attempts,last_error)
       SELECT chunk_uid,COALESCE(vector_id,chunk_uid),'upsert',?3,0,NULL
         FROM chunks WHERE chunk_uid>?1 AND chunk_uid<=?2
         ORDER BY chunk_uid`
    ).bind(state.cursor, endCursor, now),
    // Generation assignment clears old bootstrap tags. Attach the exact fresh
    // generations only after every insert trigger has run.
    env.DB.prepare(
      `UPDATE vector_outbox SET bootstrap_epoch=?3,bootstrap_batch=?4
        WHERE chunk_uid>?1 AND chunk_uid<=?2 AND submitted_mutation_id IS NULL`
    ).bind(state.cursor, endCursor, state.epoch, batchNo),
    env.DB.prepare(
      `UPDATE install_state SET vector_projection_bootstrap_cursor=?3
        WHERE id=1 AND schema_version>=13
          AND vector_projection_status='bootstrap_required'
          AND vector_projection_bootstrap_epoch=?1
          AND COALESCE(vector_projection_bootstrap_cursor,'')=?2`
    ).bind(state.epoch, state.cursor, endCursor),
  ]);
  if (!Array.isArray(results) || results.length !== 4 ||
      drainLeaseChanges(results[0]) !== 1 ||
      drainLeaseChanges(results[2]) !== page.length ||
      drainLeaseChanges(results[3]) !== 1) {
    throw new Error("the accelerated bootstrap batch receipt was ambiguous");
  }
  return true;
}

/**
 * Residue mode: claim the next page of the residue, tag exactly those rows, and
 * write one ledger row for them, in a single fenced transaction.
 *
 * Progress is the ledger's last end_cursor, not install_state's cursor, which
 * stays parked at the high water so an older Worker never pages. Each request
 * therefore does bounded work (one SELECT of at most RESIDUE_PAGE_SIZE rows,
 * one tag UPDATE of the same rows, one INSERT) no matter how large the residue.
 */
async function queueResidueBatch(env, state, lease) {
  if (!lease || typeof lease.ownerToken !== "string" || typeof lease.now !== "function") {
    throw new Error("the residue re-projection walk requires the drain lease");
  }
  const ledger = await env.DB.prepare(
    `SELECT COALESCE(MAX(end_cursor),'') AS cursor, COALESCE(MAX(batch_no),0) AS batch_no
       FROM vector_bootstrap_batches WHERE epoch=?1`
  ).bind(state.epoch).first();
  const from = String(ledger?.cursor ?? "");
  const batchNo = Number(ledger?.batch_no) + 1;
  if (!Number.isSafeInteger(batchNo) || batchNo < 1) {
    throw new Error("the residue re-projection batch identity is invalid");
  }
  const { results: page } = await env.DB.prepare(
    `SELECT o.chunk_uid ${RESIDUE_PAGEABLE_FROM_SQL}
        AND o.chunk_uid>?1
      ORDER BY o.chunk_uid LIMIT ?2`
  ).bind(from, RESIDUE_PAGE_SIZE).all();
  if (!Array.isArray(page)) throw new Error("the residue re-projection page is invalid");
  if (!page.length) return false;
  const to = String(page.at(-1)?.chunk_uid || "");
  if (!to) throw new Error("the residue re-projection cursor is invalid");
  const uids = page.map((row) => row.chunk_uid);
  const uidsJson = JSON.stringify(uids);
  if (new TextEncoder().encode(uidsJson).length > 1_800_000) {
    throw new Error("the residue re-projection page identity is too large");
  }
  const fenceNow = lease.now();
  const fence = `EXISTS (SELECT 1 FROM install_state i WHERE i.id=1
                          AND i.vector_projection_bootstrap_epoch=?epoch
                          AND i.vector_projection_residue_epoch=?epoch
                          AND i.vector_drain_lease_owner=?owner
                          AND i.vector_drain_lease_expires_at>?at)`;
  // vector-retry is deliberately NOT fenced by the drain lease (it must be
  // runnable while a paused update is looping, since that is the remedy the
  // update's own quarantine refusal names), so it can release a row between
  // this page's SELECT above and this batch committing below. Binding the tag
  // UPDATE to the exact chunk_uid set this page selected (not a range) caps
  // what it can ever match to those rows, and deriving row_count from what the
  // tag ACTUALLY matched (read back in the same transaction, not the
  // pre-batch page.length) means the two numbers the confirm path relies on
  // can never disagree, however that race resolves.
  const results = await env.DB.batch([
    // The tag touches neither vector_id, op nor queued_at, so no generation
    // trigger fires and the queued generation the provider will prove is intact.
    env.DB.prepare(
      `UPDATE vector_outbox SET bootstrap_epoch=?1,bootstrap_batch=?2
        WHERE chunk_uid IN (SELECT value FROM json_each(?3))
          AND op='upsert' AND submitted_mutation_id IS NULL
          AND EXISTS (SELECT 1 FROM chunks c WHERE c.chunk_uid=vector_outbox.chunk_uid)
          AND NOT EXISTS (SELECT 1 FROM vector_outbox_retry_state q
                           WHERE q.chunk_uid=vector_outbox.chunk_uid AND q.generation=vector_outbox.generation
                             AND q.quarantined_at IS NOT NULL)
          AND ${fence.replaceAll("?epoch", "?1").replaceAll("?owner", "?4").replaceAll("?at", "?5")}`
    ).bind(state.epoch, batchNo, uidsJson, lease.ownerToken, fenceNow),
    env.DB.prepare(
      `INSERT INTO vector_bootstrap_batches
         (epoch,batch_no,start_cursor,end_cursor,row_count,status)
       SELECT ?1,?2,?3,?4,
              (SELECT count(*) FROM vector_outbox WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2),
              'queued'
        WHERE ${fence.replaceAll("?epoch", "?1").replaceAll("?owner", "?5").replaceAll("?at", "?6")}
          AND (SELECT count(*) FROM vector_outbox WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2) > 0`
    ).bind(state.epoch, batchNo, from, to, lease.ownerToken, fenceNow),
  ]);
  if (!Array.isArray(results) || results.length !== 2 || drainLeaseChanges(results[1]) !== 1) {
    throw new Error("the residue re-projection lost its drain lease before queueing a page; nothing was queued");
  }
  return true;
}

async function embedAcceleratedBatch(rows, { embed, embedBatch, embedGroup = 50 }) {
  if (!Number.isInteger(embedGroup) || embedGroup < 1 || embedGroup > 100) {
    throw new Error("the accelerated bootstrap embedding group is invalid");
  }
  const groups = [];
  for (let start = 0; start < rows.length; start += embedGroup) {
    groups.push({ start, rows: rows.slice(start, start + embedGroup) });
  }
  const embeddedGroups = await mapBounded(
    groups,
    ACCELERATED_BOOTSTRAP_CONCURRENCY,
    async (group) => {
      try {
        const output = await embedBatch(group.rows.map((row) => row.text));
        if (!Array.isArray(output) || output.length !== group.rows.length) {
          throw new Error("Workers AI returned an incomplete embedding batch");
        }
        return output;
      } catch {
        const output = [];
        for (const row of group.rows) output.push(await embed(row.text));
        return output;
      }
    },
  );
  return embeddedGroups.flat();
}

async function submitAcceleratedBootstrapBatch(env, batch, lease, options) {
  const { results: rows } = await env.DB.prepare(
    `SELECT o.chunk_uid,o.generation,c.text,c.source,c.doc_uid,c.document_date,
            c.client,c.category,c.top_folder,c.platform
       FROM vector_outbox o JOIN chunks c ON c.chunk_uid=o.chunk_uid
      WHERE o.bootstrap_epoch=?1 AND o.bootstrap_batch=?2
        AND o.op='upsert' AND o.submitted_mutation_id IS NULL
      ORDER BY o.chunk_uid`
  ).bind(batch.epoch, batch.batch_no).all();
  if (!Array.isArray(rows) || rows.length !== Number(batch.row_count)) {
    throw new Error("the accelerated bootstrap queued batch is incomplete");
  }
  const values = await embedAcceleratedBatch(rows, options);
  if (values.length !== rows.length) throw new Error("the accelerated bootstrap embeddings are incomplete");
  const vectors = [];
  const mapping = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const vectorId = await vectorIdFor(row.chunk_uid);
    mapping.push({ u: row.chunk_uid, v: vectorId, g: row.generation });
    vectors.push({ id: vectorId, values: values[index], metadata: await vectorMetadataFor(row) });
  }
  if (new Set(mapping.map((row) => row.v)).size !== mapping.length) {
    throw new Error("the accelerated bootstrap vector identities are not unique");
  }
  const mappingJson = JSON.stringify(mapping);
  if (new TextEncoder().encode(mappingJson).length > 1_800_000) {
    throw new Error("the accelerated bootstrap identity receipt is too large");
  }
  await renewDrainLease(env, lease.ownerToken, { now: lease.now() });
  const providerReceipt = await env.VECTORIZE.upsert(vectors);
  const mutationId = acceptedMutationId(providerReceipt);
  const submittedAt = lease.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE install_state
          SET vector_projection_mutation_id=?1,vector_projection_submitted_at=?2
        WHERE id=1 AND schema_version>=13`
    ).bind(mutationId, submittedAt),
    env.DB.prepare(
      `UPDATE chunks AS c SET vector_id=(
         SELECT json_extract(value,'$.v') FROM json_each(?1)
          WHERE json_extract(value,'$.u')=c.chunk_uid
       ) WHERE EXISTS (
         SELECT 1 FROM json_each(?1) m JOIN vector_outbox o
           ON o.chunk_uid=json_extract(m.value,'$.u')
          AND o.generation=json_extract(m.value,'$.g')
          AND o.bootstrap_epoch=?2 AND o.bootstrap_batch=?3
          WHERE o.chunk_uid=c.chunk_uid
       )`
    ).bind(mappingJson, batch.epoch, batch.batch_no),
    env.DB.prepare(
      `UPDATE vector_outbox
          SET submitted_mutation_id=?3,submitted_at=?4,last_error=NULL
        WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2
          AND op='upsert' AND submitted_mutation_id IS NULL`
    ).bind(batch.epoch, batch.batch_no, mutationId, submittedAt),
    env.DB.prepare(
      `UPDATE vector_bootstrap_batches
          SET status='submitted',mutation_id=?3,submitted_at=?4
        WHERE epoch=?1 AND batch_no=?2 AND status='queued'
          AND (SELECT count(*) FROM vector_outbox
                WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2
                  AND submitted_mutation_id=?3)=row_count`
    ).bind(batch.epoch, batch.batch_no, mutationId, submittedAt),
  ]);
  if (!Array.isArray(results) || results.length !== 4 ||
      drainLeaseChanges(results[0]) !== 1 ||
      drainLeaseChanges(results[2]) !== rows.length ||
      drainLeaseChanges(results[3]) !== 1) {
    throw new Error("the accelerated bootstrap mutation receipt was ambiguous");
  }
  // D1 derives its rough meta.changes indication from sqlite3_total_changes(),
  // and chunks_au also rewrites the external FTS row for every chunks UPDATE.
  // It therefore cannot prove how many vector_id values reached desired state.
  // Read back the complete mapping instead. The install fence, outbox
  // transition, and batch transition remain exact ownership receipts above
  // because each changes one guarded row set with no triggers.
  const mappingReceipt = await env.DB.prepare(
    `SELECT count(*) AS n
       FROM json_each(?1) m JOIN chunks c
         ON c.chunk_uid=json_extract(m.value,'$.u')
      WHERE c.vector_id=json_extract(m.value,'$.v')`
  ).bind(mappingJson).first();
  const mapped = Number(mappingReceipt?.n);
  if (!Number.isSafeInteger(mapped) || mapped !== rows.length) {
    throw new Error("the accelerated bootstrap mutation receipt was ambiguous");
  }
  return rows.length;
}

async function confirmAcceleratedBootstrapBatch(env, batch, now) {
  const { results: rows } = await env.DB.prepare(
    `SELECT o.chunk_uid,o.generation,o.submitted_mutation_id,
            c.vector_id AS stored_vector_id
       FROM vector_outbox o JOIN chunks c ON c.chunk_uid=o.chunk_uid
      WHERE o.bootstrap_epoch=?1 AND o.bootstrap_batch=?2
      ORDER BY o.chunk_uid`
  ).bind(batch.epoch, batch.batch_no).all();
  if (!Array.isArray(rows) || rows.length !== Number(batch.row_count) ||
      rows.some((row) => row.submitted_mutation_id !== batch.mutation_id)) {
    throw new Error("the accelerated bootstrap submitted batch is incomplete");
  }
  const expected = await Promise.all(rows.map(async (row) => ({
    ...row,
    vector_id: await vectorIdFor(row.chunk_uid),
  })));
  // A request can be interrupted after the transactional submission but before
  // its mapping readback. Re-prove the D1 mapping on every resume so provider
  // visibility can never acknowledge an unresolvable hashed vector identity.
  if (expected.some((row) => row.stored_vector_id !== row.vector_id)) {
    throw new Error("the accelerated bootstrap submitted batch is incomplete");
  }
  const pages = [];
  for (let start = 0; start < expected.length; start += VECTOR_GET_BY_IDS_LIMIT) {
    pages.push(expected.slice(start, start + VECTOR_GET_BY_IDS_LIMIT));
  }
  const exactPages = await mapBounded(
    pages,
    ACCELERATED_BOOTSTRAP_CONCURRENCY,
    async (page) => {
      const visible = await env.VECTORIZE.getByIds(page.map((row) => row.vector_id));
      if (!Array.isArray(visible)) throw new Error("the vector index returned an invalid bootstrap visibility receipt");
      const byId = new Map(visible.map((vector) => [vector?.id, vector]));
      return page.every((row) =>
        String(byId.get(row.vector_id)?.metadata?.outbox_generation ?? "") === String(row.generation));
    },
  );
  // Retain only one boolean per page. getByIds includes full vector values, so
  // retaining 1,000 responses at once would spend most of a Worker's memory on
  // data whose only purpose is this metadata equality check.
  if (!exactPages.every(Boolean)) return false;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM vector_outbox
        WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2
          AND submitted_mutation_id=?3`
    ).bind(batch.epoch, batch.batch_no, batch.mutation_id),
    env.DB.prepare(
      `UPDATE vector_bootstrap_batches SET status='confirmed',confirmed_at=?4
        WHERE epoch=?1 AND batch_no=?2 AND status='submitted' AND mutation_id=?3`
    ).bind(batch.epoch, batch.batch_no, batch.mutation_id, now),
  ]);
  if (!Array.isArray(results) || results.length !== 2 ||
      drainLeaseChanges(results[0]) !== rows.length || drainLeaseChanges(results[1]) !== 1) {
    throw new Error("the accelerated bootstrap confirmation receipt was ambiguous");
  }
  return true;
}

/**
 * Re-project legacy vectors in provider-sized, disjoint batches while every
 * ordinary corpus writer remains blocked by the upgrade compatibility Worker.
 */
/**
 * The brain's own schema version, for /health.
 *
 * Whether a brain may take a published update is decided by this integer, not
 * by its version string: a brain built from a working branch records a LOWER
 * version while running a HIGHER schema. Until 2026-09-03 the only way to read
 * it was to be at the owner's machine running `brain status`, so the guard
 * depended on a person remembering to look. An unauthenticated integer saying
 * which migrations ran leaks nothing the version string does not, and makes
 * every brain in the field checkable with one request.
 *
 * Fail-soft: any error returns null, because /health must answer even when D1
 * cannot.
 */
export async function installedSchemaVersion(env) {
  try {
    const row = await env.DB.prepare("SELECT schema_version FROM install_state WHERE id = 1").first();
    const version = Number(row?.schema_version);
    return Number.isSafeInteger(version) && version > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Clear vector-outbox residue that no bootstrap batch owns, while paused.
 *
 * The legacy branch of acceleratedVectorBootstrap already drains its residue
 * under allowPausedBootstrap. The bootstrap-v2 branch did not, and on
 * 2026-09-04 that asymmetry stranded a live 926,323-chunk brain: ONE chunk
 * queued by ordinary ingest in the moment before the pause could never be
 * projected, so the outbox never emptied, markProjectionVerifiedIfExact could
 * never take its exact cut, the status never reached 'verified', the
 * base-count escape hatch below never fired, and convergence compared a stale
 * base from an earlier epoch against a grown chunk count for the rest of time.
 *
 * Draining the outbox is projection work, not a corpus write. VECTOR_DRAIN_MODE
 * is untouched and every ordinary corpus writer stays blocked, exactly as in
 * the legacy branch.
 *
 * Only residue is eligible. While any batch of the current epoch is queued or
 * submitted, its outbox rows belong to submitAcceleratedBootstrapBatch and
 * confirmAcceleratedBootstrapBatch, whose exact per-batch receipts a general
 * drain would invalidate by deleting rows they still count.
 */
// One paused drain call clears at most this many outbox rows. A stale pending
// residue above it is re-walked at bulk speed instead of drained at 100 per
// provider confirmation. See the caller for the live incident this encodes.
// Rows a residue-only walk cannot page: DELETE rows, rows the paused drain had
// already submitted, upsert rows whose chunk is gone, and QUARANTINED upserts.
// Everything else in the outbox is a queued upsert for a live chunk, which the
// walk re-projects. Quarantine stays a blocker on purpose: the provider has
// already refused that row repeatedly, so folding it into a 1,000-row batch
// would fail the whole batch on every request without naming the cause. The
// existing loud refusal, with its vector-retry remedy, is the better outcome,
// and it keeps the recomputed base count from ever calling such a row projected.
const RESIDUE_PAGEABLE_SQL = `o.op='upsert' AND o.submitted_mutation_id IS NULL
          AND c.chunk_uid IS NOT NULL AND s.quarantined_at IS NULL`;
// Rows the drain can never clear on its own: quarantined rows of ANY op and
// upsert rows whose chunk is gone. They neither block the open nor join the
// walk; the walk works around them and the update ends by name once only they
// remain (and vector-retry releases the quarantined ones).
const RESIDUE_UNDRAINABLE_SQL = `(s.quarantined_at IS NOT NULL OR (o.op='upsert' AND c.chunk_uid IS NULL))`;
// Rows the residue walk must not run beside and that the drain CAN clear:
// unquarantined DELETE rows and rows already submitted. They drain first.
const RESIDUE_BLOCKER_SQL = `FROM vector_outbox o
       LEFT JOIN chunks c ON c.chunk_uid=o.chunk_uid
       LEFT JOIN vector_outbox_retry_state s
         ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
      WHERE NOT (${RESIDUE_PAGEABLE_SQL}) AND NOT ${RESIDUE_UNDRAINABLE_SQL}`;
// Every queued upsert for a live chunk, quarantined or not: the rows the base
// count must treat as unprojected so the receipt reconciles while they wait.
const RESIDUE_UNPROJECTED_FROM_SQL = `FROM vector_outbox o
       JOIN chunks c ON c.chunk_uid=o.chunk_uid
      WHERE o.op='upsert' AND o.submitted_mutation_id IS NULL`;
const RESIDUE_PAGEABLE_FROM_SQL = `FROM vector_outbox o
       JOIN chunks c ON c.chunk_uid=o.chunk_uid
       LEFT JOIN vector_outbox_retry_state s
         ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
      WHERE ${RESIDUE_PAGEABLE_SQL}`;
// One page of residue per request, tagged when that page is queued. Tagging the
// whole residue at the open would be unbounded work in one request: measured on
// local in-memory SQLite, 20,000 rows took 4.7 s and the cost is quadratic, so
// a production-size residue could never fit inside D1's query limits.
const RESIDUE_PAGE_SIZE = 1000;

async function residueBlockerLedger(env) {
  const row = await env.DB.prepare(`SELECT count(*) AS total ${RESIDUE_BLOCKER_SQL}`).first();
  const total = Number(row?.total);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("the paused bootstrap residue receipt is invalid");
  return { total, drainable: total };
}

/**
 * What stands in the way. Scope "walk" (before or during a residue walk) names
 * only the ordering fence, and only when every remaining blocker is a submitted
 * row the index has not processed; cleanup still moving is not a cause. Scope
 * "outbox" (the ordinary paused drain) refuses only when NOTHING can move:
 * quarantine (any op) first, then the fence. Counts are of the named cause.
 */
async function residueBlockedCause(env, { scope = "outbox" } = {}) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM vector_outbox o LEFT JOIN chunks c ON c.chunk_uid=o.chunk_uid
          LEFT JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
         WHERE s.quarantined_at IS NOT NULL) AS quarantined,
       (SELECT count(*) FROM vector_outbox o LEFT JOIN chunks c ON c.chunk_uid=o.chunk_uid
          LEFT JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation
         WHERE o.op='upsert' AND c.chunk_uid IS NULL AND s.quarantined_at IS NULL) AS orphans,
       (SELECT count(*) FROM vector_outbox WHERE submitted_mutation_id IS NOT NULL) AS submitted,
       (SELECT count(*) ${RESIDUE_BLOCKER_SQL}) AS blockers,
       (SELECT count(*) FROM vector_outbox) AS outbox`
  ).first();
  const quarantined = Number(row?.quarantined);
  const orphans = Number(row?.orphans);
  const submitted = Number(row?.submitted);
  const blockers = Number(row?.blockers);
  const outbox = Number(row?.outbox);
  if (![quarantined, orphans, submitted, blockers, outbox].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("the paused bootstrap residue receipt is invalid");
  }
  if (scope === "walk") {
    // Every blocked open must carry a cause: the CLI's stall handler already
    // knows how to answer "cleanup" (informational, no reindex) and "fence"
    // (time-bounded, names the fence); returning null here left a stuck,
    // never-quarantined delete unnamed, which fell through to the generic
    // vector-count-mismatch text and recommended `brain reindex --yes` for a
    // fault reindex cannot see or fix.
    if (blockers === 0) return null;
    if (submitted === blockers) return { blocked_on: "fence", blocked_rows: submitted };
    return { blocked_on: "cleanup", blocked_rows: blockers };
  }
  const drainable = Math.max(0, outbox - quarantined - orphans - submitted);
  if (outbox === 0 || drainable > 0) return null;
  if (quarantined > 0) return { blocked_on: "quarantine", blocked_rows: quarantined };
  if (submitted > 0 && submitted === outbox - orphans) return { blocked_on: "fence", blocked_rows: submitted };
  return null;
}

/**
 * Whether this epoch was opened as a residue-only re-projection and has queued
 * at least one batch. The receipt row outlives the residue column (which the
 * walk clears when its range is exhausted), so a cleanup pass that follows the
 * walk can still be reported as "waiting" rather than as a return to legacy
 * cleanup, which the CLI treats as a regression once bulk work has begun.
 */
async function residueEpochBegan(env, state) {
  if (Number(state.schema_version) < RESIDUE_REPROJECTION_SCHEMA) return false;
  const row = await env.DB.prepare(
    `SELECT (EXISTS (SELECT 1 FROM vector_projection_events WHERE kind=?2 AND epoch_after=?1)
             AND EXISTS (SELECT 1 FROM vector_bootstrap_batches WHERE epoch=?1)) AS began`
  ).bind(state.epoch, RESIDUE_REPROJECTION_EVENT).first();
  return Number(row?.began) === 1;
}

// Below this many queued upserts the paused drain clears them in a handful of
// confirmations, and re-embedding them by the bulk walk would gain nothing.
export const RESIDUE_REPROJECTION_MIN_ROWS = 10 * DRAIN_BATCH_SIZE_MAX;
export const RESIDUE_REPROJECTION_EVENT = "residue-reprojection";

/**
 * Open a residue-only re-projection epoch for a PENDING projection whose queued
 * upserts outnumber what the paused drain can clear in a few confirmations.
 *
 * A completed bootstrap leaves the projection 'pending' with its base count
 * frozen at that epoch's corpus. Ordinary ingest after it puts every new chunk
 * in the outbox, and once paused for an upgrade the only path for those rows
 * was the drain, one provider confirmation per hundred rows. On one brain that
 * was days, and the update's safety deadline ended it first.
 *
 * The residue is exactly the work the drain would do, so this does that work at
 * bulk speed and nothing more: the base count becomes the number of chunks with
 * no queued upsert row (the outbox is the transactional ledger of unprojected
 * work, so every such chunk was confirmed by the bootstrap or the drain), a
 * fresh epoch walks only the queued rows through the ordinary batch ledger, and
 * the exact verification cut is unchanged. Nothing is deleted here: an epoch
 * that fires on a modest queue simply finishes the drain sooner. Rows the walk
 * cannot page drain first, so bulk work never has to fall back to cleanup.
 *
 * The state transition and its receipt row commit together, fenced on the
 * lease owner, its expiry, the epoch and the status, so a lost lease or a
 * changed ledger leaves nothing half-opened.
 */
export async function openResidueReprojection(env, state, options, lease) {
  if (state.status !== "pending" || Number(state.schema_version) < RESIDUE_REPROJECTION_SCHEMA) {
    return { opened: false, blocked: false };
  }
  const ledger = await env.DB.prepare(
    `SELECT (SELECT count(*) ${RESIDUE_PAGEABLE_FROM_SQL}) AS pageable,
            (SELECT count(*) ${RESIDUE_UNPROJECTED_FROM_SQL}) AS unprojected,
            (SELECT count(*) FROM chunks) AS chunks,
            (SELECT count(*) FROM vector_bootstrap_batches
              WHERE epoch=?1 AND status<>'confirmed') AS unfinished`
  ).bind(state.epoch).first();
  const pageable = Number(ledger?.pageable);
  const unprojected = Number(ledger?.unprojected);
  const chunks = Number(ledger?.chunks);
  const unfinished = Number(ledger?.unfinished);
  if (![pageable, unprojected, chunks, unfinished].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      pageable > unprojected || unprojected > chunks) {
    throw new Error("the residue re-projection ledger is invalid");
  }
  if (unfinished > 0 || pageable <= RESIDUE_REPROJECTION_MIN_ROWS) return { opened: false, blocked: false };
  // TERMINATION. A closed walk leaves the projection pending, which is also the
  // condition that opens one, so a walk that confirms nothing must not be able
  // to reopen itself: rows that return to the queue below the ledger cursor let
  // the walk close with them still queued, and without this the brain would
  // burn an epoch per attempt. The fact that THIS epoch was a residue epoch
  // lives in install_state (the column outlives the walk and is only replaced
  // when a new epoch opens), so a lost or truncated receipt row cannot defeat
  // the guard; the receipt row stays a receipt.
  //
  // The bound is on the UNPRODUCTIVE case, not the barely-productive one: an
  // epoch that confirms a single row may open another. That terminates rather
  // than looping, and treating slow progress as failure would refuse the very
  // brains this path exists for.
  if (state.residue_epoch !== null && state.residue_epoch !== undefined &&
      Number(state.residue_epoch) === state.epoch) {
    const previous = await env.DB.prepare(
      `SELECT COALESCE(sum(row_count),0) AS confirmed,
              COALESCE(count(*),0)        AS batches
         FROM vector_bootstrap_batches WHERE epoch=?1 AND status='confirmed'`
    ).bind(state.epoch).first();
    const confirmedRows = Number(previous?.confirmed);
    const batches = Number(previous?.batches);
    if (!Number.isSafeInteger(confirmedRows) || confirmedRows < 0 ||
        !Number.isSafeInteger(batches) || batches < 0) {
      throw new Error("the residue re-projection ledger is invalid");
    }
    // Refuse only an epoch that ACTUALLY RAN and confirmed nothing. An epoch
    // with no batch rows at all never began: the lease was lost before the
    // first page. Treating that as a spent attempt is what strands a brain on
    // the slow drain permanently, and this file already knows it — the
    // zero-batch rebase clears vector_projection_residue_epoch for exactly
    // this reason, saying a refusal here "would refuse every future residue on
    // this brain, silently reverting it to the ~100-rows-per-confirmation
    // drain". An OLDER Worker crossing an open residue epoch performs no such
    // clear, so it leaves residue_epoch === epoch with zero batches forever,
    // and every later update on this brain silently takes the slow path with
    // no message. The guard and the clear contradicted each other; only the new
    // Worker's clear was hiding it.
    //
    // This cannot spin: the open is gated on `pageable > RESIDUE_REPROJECTION_MIN_ROWS`
    // above, so an epoch with nothing left to page never opens in the first place.
    if (batches > 0 && confirmedRows === 0) return { opened: false, blocked: false };
  }

  // Unquarantined deletes and rows already submitted must clear before the
  // open; quarantined rows and orphans never block it. Cleanup that is still
  // moving carries no cause on the receipt; only a fence is named.
  let blockers = await residueBlockerLedger(env);
  if (blockers.total > 0) {
    await drainOutboxWithLease(env, {
      ...options,
      allowPausedBootstrap: true,
      disableBootstrapAdvance: true,
      maxBatches: 10,
      skipUpserts: true,
    }, lease);
    blockers = await residueBlockerLedger(env);
    if (blockers.total > 0) {
      const cause = await residueBlockedCause(env, { scope: "walk" });
      return { opened: false, blocked: true, cause: cause?.blocked_on ?? null, rows: cause?.blocked_rows ?? blockers.total };
    }
  }
  if (state.epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("the accelerated vector bootstrap epoch is exhausted");
  }
  const openedAt = lease.now();
  const nextEpoch = state.epoch + 1;
  const results = await env.DB.batch([
    // The cursor is parked AT the high water from the start. That single fact is
    // what makes the epoch safe for an OLDER Worker: its paging loop breaks on
    // cursor === high_water, so it never runs the plain outbox INSERT that would
    // collide with the queued residue. It submits and confirms whatever ledger
    // rows exist and drains the rest, which is exactly the intended work. This
    // build tracks its own progress by the ledger's last end_cursor instead.
    //
    // "high water" here is the RESIDUE's own maximum pageable chunk_uid, not
    // the corpus's global maximum: chunk_uid order does not track ingest order,
    // so an already-projected chunk (no outbox row) can legitimately sort above
    // it. That is harmless -- the protection this design relies on is the
    // EQUALITY cursor === high_water, both set from the same subquery in this
    // one statement, not "nothing in the corpus sorts above the cursor".
    env.DB.prepare(
      `UPDATE install_state
          SET vector_projection_status='bootstrap_required',
              vector_projection_bootstrap_epoch=?2,
              vector_projection_residue_epoch=?2,
              vector_projection_bootstrap_cursor=(SELECT MAX(o.chunk_uid) ${RESIDUE_PAGEABLE_FROM_SQL}),
              vector_projection_bootstrap_high_water=(SELECT MAX(o.chunk_uid) ${RESIDUE_PAGEABLE_FROM_SQL}),
              vector_projection_bootstrap_protocol=?3,
              vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)-(
                SELECT count(*) ${RESIDUE_UNPROJECTED_FROM_SQL})
        WHERE id=1 AND schema_version>=?6
          AND vector_projection_status='pending'
          AND vector_projection_bootstrap_epoch=?1
          AND vector_drain_lease_owner=?4
          AND vector_drain_lease_expires_at>?5
          AND NOT EXISTS (SELECT 1 FROM vector_bootstrap_batches WHERE epoch=?1 AND status<>'confirmed')
          AND NOT EXISTS (SELECT 1 ${RESIDUE_BLOCKER_SQL})`
    ).bind(state.epoch, nextEpoch, ACCELERATED_BOOTSTRAP_PROTOCOL, lease.ownerToken, openedAt, RESIDUE_REPROJECTION_SCHEMA),
    env.DB.prepare(
      `INSERT INTO vector_projection_events
         (at, kind, epoch_before, epoch_after, base_before, base_after, rows, chunks)
       SELECT ?1, ?2, ?3, ?4, ?5,
              vector_projection_bootstrap_base_count,
              (SELECT count(*) FROM chunks) - vector_projection_bootstrap_base_count,
              (SELECT count(*) FROM chunks)
         FROM install_state
        WHERE id=1 AND vector_projection_bootstrap_epoch=?4
          AND vector_projection_residue_epoch=?4
          AND vector_drain_lease_owner=?6
          AND vector_drain_lease_expires_at>?7`
    ).bind(openedAt, RESIDUE_REPROJECTION_EVENT, state.epoch, nextEpoch, state.baseCount, lease.ownerToken, openedAt),
  ]);
  if (!Array.isArray(results) || results.length !== 2 ||
      drainLeaseChanges(results[0]) !== 1 || drainLeaseChanges(results[1]) !== 1) {
    const counts = Array.isArray(results) ? results.map((r) => drainLeaseChanges(r)).join("/") : "none";
    throw new Error(`the residue re-projection could not be opened durably (state/receipt changes ${counts}); the projection is unchanged`);
  }
  return { opened: true, blocked: false, rows: pageable, baseBefore: state.baseCount, baseAfter: chunks - unprojected };
}

async function drainPausedBootstrapResidue(env, state, options, lease) {
  // In a residue-only epoch the walk owns every queued upsert row, so this
  // drain only handles what the walk cannot page. Without that split it would
  // clear the walk's own rows a hundred at a time before the first page queued.
  const residueOnly = residueWalkOpen(state);
  const ledger = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM vector_outbox) AS residue,
            (SELECT count(*) FROM vector_bootstrap_batches
              WHERE epoch=?1 AND status IN ('queued','submitted')) AS owned`
  ).bind(state.epoch).first();
  const residue = Number(ledger?.residue);
  const owned = Number(ledger?.owned);
  if (![residue, owned].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("the paused bootstrap residue receipt is invalid");
  }
  // Only a residue epoch (schema 36+) consults the blocker ledger; older
  // schemas without vector_outbox_retry_state must keep their exact refusal.
  const blockers = residueOnly ? (await residueBlockerLedger(env)).total : residue;
  if (blockers > residue) throw new Error("the paused bootstrap residue receipt is invalid");
  const target = residueOnly ? blockers : residue;
  if (target === 0 || owned > 0) return { attempted: false, remaining: target };

  // Bounded exactly like the legacy branch. One request drains what it can and
  // reports; the caller polls. An unbounded drain would hold a single Worker
  // invocation open for a whole backlog and time out with nothing durable.
  const drained = await drainOutboxWithLease(env, {
    ...options,
    allowPausedBootstrap: true,
    disableBootstrapAdvance: true,
    maxBatches: 10,
    skipUpserts: residueOnly,
  }, lease);

  const after = residueOnly
    ? await residueBlockerLedger(env)
    : await (async () => {
      const row = await env.DB.prepare(
        `SELECT count(*) AS total,
                COALESCE(sum(CASE WHEN s.quarantined_at IS NULL THEN 1 ELSE 0 END),0) AS drainable
           FROM vector_outbox o
           LEFT JOIN vector_outbox_retry_state s
             ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation`
      ).first();
      const total = Number(row?.total);
      const drainable = Number(row?.drainable);
      if (![total, drainable].every((value) => Number.isSafeInteger(value) && value >= 0) ||
          drainable > total) {
        throw new Error("the paused bootstrap residue receipt is invalid");
      }
      return { total, drainable };
    })();
  // Every drain candidate query excludes quarantined rows, so residue that is
  // entirely quarantined can never be projected by any amount of waiting. Say
  // so once, loudly, rather than hanging again under a new name.
  //
  // The busy conjunct is a fence, not a live case, and it cannot fire on this
  // path today. This function runs under the lease acceleratedVectorBootstrap
  // already acquired, so contention is decided at that single acquisition and
  // answered with a busy receipt and retry_after_seconds before any residue
  // work begins; drainOutboxWithLease never sets busy at all, unlike the
  // self-leasing drainOutbox wrapper. It stays only so that switching this call
  // to that wrapper cannot silently report contention as quarantine.
  if (drained.busy !== true && after.total > 0) {
    // Name what is in the way on the receipt rather than throwing: a thrown
    // error reaches the operator as an unnamed HTTP 500, and the CLI knows how
    // to refuse quarantine by name and to wait on the fence by name. Work this
    // request already drained is durable, so naming quarantine now loses none.
    const blocked = await residueBlockedCause(env, { scope: residueOnly ? "walk" : "outbox" });
    return { attempted: true, remaining: after.total, blocked };
  }
  return { attempted: true, remaining: after.total, blocked: null };
}

async function rebaseVerifiedAcceleratedBootstrap(env, state) {
  const ledger = await env.DB.prepare(
    `SELECT count(*) AS batches,
            sum(CASE WHEN status<>'confirmed' THEN 1 ELSE 0 END) AS unfinished
       FROM vector_bootstrap_batches WHERE epoch=?1`,
  ).bind(state.epoch).first();
  const batches = Number(ledger?.batches || 0);
  const unfinished = Number(ledger?.unfinished || 0);
  if (![batches, unfinished].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      unfinished > batches) {
    throw new Error("the accelerated vector bootstrap history is invalid");
  }
  if (unfinished > 0) {
    throw new Error("a verified vector projection retained unfinished bootstrap batches");
  }
  if (batches > 0 && state.epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("the accelerated vector bootstrap epoch is exhausted");
  }
  const result = batches > 0
    ? await env.DB.prepare(
      `UPDATE install_state
          SET vector_projection_bootstrap_epoch=vector_projection_bootstrap_epoch+1,
              vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
              vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
              vector_projection_bootstrap_protocol=?2,
              vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
        WHERE id=1 AND schema_version>=13
          AND vector_projection_status='verified'
          AND vector_projection_bootstrap_epoch=?1
          AND NOT EXISTS (SELECT 1 FROM vector_outbox)
          AND NOT EXISTS (
            SELECT 1 FROM vector_bootstrap_batches
             WHERE epoch=?1 AND status<>'confirmed'
          )`,
    ).bind(state.epoch, ACCELERATED_BOOTSTRAP_PROTOCOL).run()
    // Zero batches means this epoch never even queued a page: a lease lost
    // between an open and its first page, or a residue epoch abandoned before
    // any work began. The batches>0 branch above advances the epoch, which
    // naturally breaks the residue_epoch===epoch conjunction the termination
    // guard reads. This branch does not advance the epoch (nothing happened,
    // no reason to burn one), so it must clear the column itself, or a residue
    // epoch that never got a fair try would be read forever afterward as "one
    // unproductive attempt already spent" and openResidueReprojection would
    // refuse every future residue on this brain, silently reverting it to the
    // ~100-rows-per-confirmation drain. Harmless when already NULL.
    : await env.DB.prepare(
      `UPDATE install_state
          SET vector_projection_bootstrap_protocol=?2,
              vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks),
              vector_projection_residue_epoch=NULL
        WHERE id=1 AND schema_version>=13
          AND vector_projection_status='verified'
          AND vector_projection_bootstrap_epoch=?1
          AND NOT EXISTS (SELECT 1 FROM vector_outbox)`,
    ).bind(state.epoch, ACCELERATED_BOOTSTRAP_PROTOCOL).run();
  if (drainLeaseChanges(result) !== 1) {
    throw new Error("the accelerated vector bootstrap verified cut changed before it was rebased");
  }
  return bootstrapStateV2(env);
}

async function acceleratedVectorBootstrapWithLease(env, state, options, lease) {
  // Finish at most one schema-12 residue page before establishing the bulk-v2
  // boundary. This handles a 0.1.14 update interrupted after queue or submit.
  if (state.protocol !== ACCELERATED_BOOTSTRAP_PROTOCOL) {
    // Queued UPSERT rows are superseded by the bulk projection, which re-embeds
    // every chunk from D1 in provider-sized batches with per-batch receipts.
    // Draining them here instead means one 100-row confirmation at a time:
    // about a day on a brain that loaded 205,791 rows before updating
    // (2026-09-03), with the brain refusing new material the whole time. Drop
    // them and walk the corpus. DELETE rows still have to reach the provider
    // and nothing else will send them, so they drain first, serially.
    const superseded = await env.DB.prepare(
      "DELETE FROM vector_outbox WHERE op='upsert'"
    ).run();
    if (drainLeaseChanges(superseded) > 0) {
      await resetVectorProjectionBootstrap(env);
      state = await bootstrapStateV2(env);
    }
    const residue = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    if (Number(residue?.n || 0) > 0) {
      await drainOutboxWithLease(env, {
        ...options,
        allowPausedBootstrap: true,
        disableBootstrapAdvance: true,
        maxBatches: 10,
      }, lease);
      // A pending schema-12 last page can become fully verified in that drain.
      // Adopt it only when no v2 batch exists, or its rows would be counted
      // once as the base and again by their durable batch receipts.
      await env.DB.prepare(
        `UPDATE install_state
            SET vector_projection_bootstrap_protocol=?1,
                vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
          WHERE id=1 AND schema_version>=13
            AND vector_projection_status='verified'
            AND NOT EXISTS (SELECT 1 FROM vector_outbox)
            AND NOT EXISTS (
              SELECT 1 FROM vector_bootstrap_batches
               WHERE epoch=vector_projection_bootstrap_epoch
            )`
      ).bind(ACCELERATED_BOOTSTRAP_PROTOCOL).run();
      return acceleratedBootstrapReceipt(env, "legacy_drain", null, options);
    }
  }

  // A PENDING projection with a large queued residue takes the slow path by
  // mistake: the paused drain, one provider confirmation per hundred rows. Open
  // a residue-only epoch instead and let the batch ledger re-project exactly
  // those rows at bulk speed. Rows that epoch cannot page drain first.
  const reprojection = await openResidueReprojection(env, state, options, lease);
  if (reprojection.blocked) {
    return acceleratedBootstrapReceipt(env, "legacy_drain", {
      blocked_on: reprojection.cause,
      blocked_rows: reprojection.rows,
    }, options);
  }
  if (reprojection.opened) state = await bootstrapStateV2(env);

  const residue = await drainPausedBootstrapResidue(env, state, options, lease);
  if (residue.attempted) {
    // Once a residue epoch's bulk work has begun the phase stays "waiting": the
    // CLI treats a return to legacy_drain after building as a regression. An
    // ordinary v2 epoch with old batch history keeps legacy_drain, which the
    // CLI exempts from count reconciliation for exactly this cleanup case.
    if (residue.remaining > 0) {
      const waiting = residueWalkOpen(state) || await residueEpochBegan(env, state);
      return acceleratedBootstrapReceipt(env, waiting ? "waiting" : "legacy_drain", residue.blocked, options);
    }
    state = await bootstrapStateV2(env);
  }

  if (state.status === "pending") {
    await markProjectionVerifiedIfExact(env, lease);
    state = await bootstrapStateV2(env);
  }
  // A projection that is SHORT with nothing queued has to be rebuilt, and until
  // 0.4.4 there was no way for it to say so. `pending` means "not proven exact".
  // markProjectionVerifiedIfExact leaves it pending when the counts disagree,
  // and the two tests below then fall through to a well-formed receipt of zeros
  // with HTTP 200. Nothing else ever moves the status, so the run repeats that
  // receipt until its deadline and the next run does the same.
  //
  // Observed on a client brain 2026-09-08: 62,439 vectors against 1,151,274
  // chunks, outbox empty, epoch 0, base_count 0, high_water NULL, four update
  // attempts across two releases producing byte-identical output over 97 hours.
  // The only writer of `bootstrap_required` is reachable from `reindex`, which
  // the pause refuses, and the bootstrap requires the pause, so no supported
  // sequence of commands could reach it. It was closed, not flaky.
  //
  // Requiring an empty outbox is what makes this safe: queued work is somebody
  // else's in flight, and resetting under it would abandon rows the provider
  // may still confirm. With nothing queued there is nothing to lose, and the
  // reset is the only thing that sets the high-water mark the sweep needs.
  // Still `pending` AFTER markProjectionVerifiedIfExact means the counts did not
  // agree; that call is the only thing that promotes an exact projection.
  if (state.status === "pending") {
    const queued = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    const chunked = Number((await env.DB.prepare("SELECT count(*) AS n FROM chunks").first())?.n || 0);
    // SHORT only. An index holding MORE vectors than the database has chunks is
    // a different fault, and one this release cannot clear: the completion check
    // compares the two counts for exact equality with no tolerance, so a rebuild
    // can never satisfy it however long it runs. That case must keep its
    // existing behaviour and its own message rather than being sent into a
    // rebuild that cannot end.
    let projected = null;
    try {
      const description = await env.VECTORIZE.describe();
      const count = Number(description?.vectorCount ?? description?.vectorsCount ?? description?.count);
      if (Number.isSafeInteger(count) && count >= 0) projected = count;
    } catch { /* unreadable provider count is not proof of a short projection */ }
    // NEVER BOOTSTRAPPED, not merely short.
    //
    // A finished rebuild lands right back here: the completion block below sets
    // the status to 'pending' and calls markProjectionVerifiedIfExact, which
    // returns false while the provider's aggregate count is still catching up
    // with mutations it has already accepted. Three seconds later the CLI polls
    // again, and without this guard the reset would fire on a projection that
    // had just finished, discard it, and start over. The run would then abort
    // on the CLI's epoch-change guard with the Worker left paused, so the fix
    // would have prevented the very rebuild it exists to enable.
    //
    // Batch history is the discriminator. A brain that has never activated has
    // none, which is the shape the stuck client showed: epoch 0, base_count 0,
    // high_water NULL, no batches, across four attempts on two releases. A
    // brain that has just rebuilt has confirmed batches for this epoch.
    //
    // Deliberately conservative: a brain that bootstrapped once and later goes
    // short will not self-heal here. `brain reindex` remains the path for that,
    // and refusing to guess is better than restarting a corpus rebuild on a
    // provider count that may simply be behind.
    const history = await env.DB.prepare(
      "SELECT count(*) AS n FROM vector_bootstrap_batches WHERE epoch=?1"
    ).bind(state.epoch).first();
    const neverBootstrapped = Number(history?.n || 0) === 0;
    if (neverBootstrapped && Number(queued?.n || 0) === 0 && chunked > 0 &&
        projected !== null && projected < chunked) {
      await resetVectorProjectionBootstrap(env);
      state = await bootstrapStateV2(env);
    }
  }
  if (state.status === "verified") {
    state = await rebaseVerifiedAcceleratedBootstrap(env, state);
    return acceleratedBootstrapReceipt(env, "waiting", null, options);
  }
  if (state.status !== "bootstrap_required") {
    return acceleratedBootstrapReceipt(env, "waiting", null, options);
  }

  const now = lease.now;
  let phase = "waiting";
  state = await activateAcceleratedBootstrap(env, state);
  if (!state) throw new Error("the accelerated bootstrap boundary changed; retry from durable state");

  const submitted = await env.DB.prepare(
    `SELECT * FROM vector_bootstrap_batches
      WHERE epoch=?1 AND status='submitted' ORDER BY batch_no`
  ).bind(state.epoch).all();
  for (const batch of submitted?.results || []) {
    if (await confirmAcceleratedBootstrapBatch(env, batch, now())) phase = "building";
  }

  let inFlight = await env.DB.prepare(
    `SELECT count(*) AS n FROM vector_bootstrap_batches
      WHERE epoch=?1 AND status IN ('queued','submitted')`
  ).bind(state.epoch).first();
  const durableInFlight = Number(inFlight?.n || 0);
  if (!Number.isSafeInteger(durableInFlight) || durableInFlight < 0 ||
      durableInFlight > ACCELERATED_BOOTSTRAP_WINDOW) {
    throw new Error("the accelerated bootstrap in-flight window is invalid");
  }
  while (Number(inFlight?.n || 0) < ACCELERATED_BOOTSTRAP_WINDOW) {
    state = await bootstrapStateV2(env);
    if (!residueWalkOpen(state) && (!state.highWater || state.cursor === state.highWater)) break;
    if (!await queueAcceleratedBootstrapBatch(env, state, now(), lease)) break;
    phase = "building";
    inFlight = { n: Number(inFlight?.n || 0) + 1 };
  }

  const queued = await env.DB.prepare(
    `SELECT * FROM vector_bootstrap_batches
      WHERE epoch=?1 AND status='queued' ORDER BY batch_no`
  ).bind(state.epoch).all();
  for (const batch of queued?.results || []) {
    await submitAcceleratedBootstrapBatch(
      env,
      batch,
      { ownerToken: lease.ownerToken, now },
      {
        embed: options.embed,
        embedBatch: options.embedBatch,
        embedGroup: options.embedGroup || 50,
      },
    );
    phase = "building";
  }

  state = await bootstrapStateV2(env);
  const unfinished = await env.DB.prepare(
    `SELECT count(*) AS n FROM vector_bootstrap_batches
      WHERE epoch=?1 AND status<>'confirmed'`
  ).bind(state.epoch).first();
  if (residueWalkOpen(state) && Number(unfinished?.n || 0) === 0) {
    const left = await env.DB.prepare(
      `SELECT count(*) AS n ${RESIDUE_PAGEABLE_FROM_SQL}
         AND o.chunk_uid > COALESCE((SELECT MAX(end_cursor) FROM vector_bootstrap_batches WHERE epoch=?1), '')`
    ).bind(state.epoch).first();
    if (Number(left?.n || 0) === 0) {
      await closeResidueWalk(env, state, lease);
      state = await bootstrapStateV2(env);
    }
  }
  const outbox = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  if ((state.status === "pending" || state.cursor === state.highWater) &&
      Number(unfinished?.n || 0) === 0 && Number(outbox?.n || 0) === 0) {
    await env.DB.prepare(
      `UPDATE install_state SET vector_projection_status='pending'
        WHERE id=1 AND schema_version>=13
          AND vector_projection_status='bootstrap_required'
          AND COALESCE(vector_projection_bootstrap_cursor,'')=
              COALESCE(vector_projection_bootstrap_high_water,'')`
    ).run();
    phase = await markProjectionVerifiedIfExact(env, lease) ? "complete" : "waiting";
    // A residue epoch's base count never counts rows the ordinary drain
    // projected after the walk closed (rows released by vector-retry), so its
    // ledger cannot certify the corpus on its own. Rebase in the verifying
    // request; the CLI accepts a complete receipt whose epoch advanced by one.
    if (phase === "complete") {
      state = await bootstrapStateV2(env);
      if (state.status === "verified" && await residueEpochBegan(env, state)) {
        await rebaseVerifiedAcceleratedBootstrap(env, state);
      }
    }
  }
  return acceleratedBootstrapReceipt(env, phase, null, options);
}

/**
 * A residue walk whose pages are all confirmed is an ordinary v2 state from
 * here on: whatever remains in the outbox (rows quarantined at the open, rows
 * released since, rows an older Worker had submitted) belongs to the paused
 * drain, which names quarantine by itself. Clearing the column here rather than
 * at verification is what lets a `vector-retry` release be picked up. Fenced
 * like every other write in the walk.
 */
async function closeResidueWalk(env, state, lease) {
  if (!residueWalkOpen(state)) return false;
  const result = await env.DB.prepare(
    // Leave the projection PENDING, the ordinary state for a finished walk, and
    // KEEP the column naming the epoch. Three things depend on that pairing:
    //
    // 1. Openness is status + column, so pending alone ends the walk and the
    //    ordinary drain takes whatever is left.
    // 2. The cursor stays parked at the high water, so a state left at
    //    bootstrap_required would look like an ordinary walk with nothing to do,
    //    and rows released later by vector-retry could only drain a hundred at a
    //    time. Pending is also what markProjectionVerifiedIfExact needs for its
    //    exact cut, and (non-obvious, now load-bearing) pending is NOT
    //    bootstrap_required, so resetVectorProjectionBootstrap can still fire on
    //    a later full rebuild; its WHERE excludes bootstrap_required entirely.
    // 3. The column is the durable record that THIS epoch was a residue epoch,
    //    which is what the anti-reopen guard reads. Keeping it in install_state
    //    means the guard cannot be defeated by a lost or truncated receipt row.
    `UPDATE install_state SET vector_projection_status='pending'
      WHERE id=1 AND schema_version>=?2
        AND vector_projection_status='bootstrap_required'
        AND vector_projection_bootstrap_epoch=?1
        AND vector_projection_residue_epoch=?1
        AND NOT EXISTS (SELECT 1 FROM vector_bootstrap_batches WHERE epoch=?1 AND status<>'confirmed')
        AND vector_drain_lease_owner=?3
        AND vector_drain_lease_expires_at>?4`
  ).bind(state.epoch, RESIDUE_REPROJECTION_SCHEMA, lease.ownerToken, lease.now()).run();
  if (drainLeaseChanges(result) !== 1) {
    throw new Error("the finished residue walk could not be closed; the projection is unchanged");
  }
  return true;
}

export async function acceleratedVectorBootstrap(env, options = {}) {
  if (env?.VECTOR_DRAIN_MODE !== "paused-for-upgrade") {
    throw new Error("the accelerated vector bootstrap requires the verified upgrade pause");
  }
  let state = await bootstrapStateV2(env);
  if (!["bootstrap_required", "pending", "verified"].includes(String(state.status))) {
    throw new Error("the accelerated vector bootstrap state is unavailable");
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = now();
  const lease = await acquireDrainLease(env, { now: startedAt });
  if (!lease.acquired) {
    const receipt = await acceleratedBootstrapReceipt(env, "waiting", null, options);
    return { ...receipt, busy: true, retry_after_seconds: lease.retryAfterSeconds };
  }

  let receipt;
  let operationError = null;
  try {
    // A caller may have observed the legacy protocol before the current lease
    // holder established v2. Re-read only after ownership, before any delete,
    // reset, batch insert, or Vectorize mutation.
    state = await bootstrapStateV2(env);
    if (!["bootstrap_required", "pending", "verified"].includes(String(state.status))) {
      throw new Error("the accelerated vector bootstrap state is unavailable");
    }
    receipt = await acceleratedVectorBootstrapWithLease(env, state, options, {
      ownerToken: lease.ownerToken,
      now,
      startedAt,
    });
  } catch (error) {
    operationError = error;
  }

  let releaseError = null;
  try {
    if (!await releaseDrainLease(env, lease.ownerToken)) {
      releaseError = new Error("accelerated vector bootstrap lease ownership was lost before release");
    }
  } catch (error) {
    releaseError = error;
  }
  if (operationError) {
    if (releaseError && operationError && typeof operationError === "object") {
      operationError.leaseReleaseFailed = true;
    }
    throw operationError;
  }
  if (releaseError) throw releaseError;
  return receipt;
}

/** Start a whole-corpus bootstrap, or resume the current durable epoch. */
export async function resetVectorProjectionBootstrap(env) {
  const installed = await env.DB.prepare(
    "SELECT schema_version FROM install_state WHERE id=1"
  ).first();
  const schemaVersion = Number(installed?.schema_version);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 12) {
    throw new Error("the vector bootstrap reset schema is unavailable");
  }
  const resetSql = schemaVersion >= 13
    ? `UPDATE install_state
        SET vector_projection_status = CASE
              WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
            vector_projection_bootstrap_epoch = vector_projection_bootstrap_epoch + 1,
            vector_projection_bootstrap_cursor = NULL,
            vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol = NULL,
            vector_projection_bootstrap_base_count = 0
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status <> 'bootstrap_required'`
    : `UPDATE install_state
        SET vector_projection_status = CASE
              WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
            vector_projection_bootstrap_epoch = vector_projection_bootstrap_epoch + 1,
            vector_projection_bootstrap_cursor = NULL,
            vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks)
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status <> 'bootstrap_required'`;
  const result = await env.DB.prepare(resetSql).run();
  const reset = drainLeaseChanges(result);
  if (![0, 1].includes(reset)) {
    throw new Error("the vector bootstrap could not be reset durably");
  }
  const state = await env.DB.prepare(
    `SELECT vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_cursor AS cursor,
            vector_projection_bootstrap_high_water AS high_water,
            (SELECT count(*) FROM chunks) AS chunks,
            (SELECT count(*) FROM vector_outbox) AS pending
       FROM install_state WHERE id = 1`
  ).first();
  const chunks = Number(state?.chunks);
  const pending = Number(state?.pending);
  const epoch = Number(state?.epoch);
  if (![chunks, pending, epoch].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !["verified", "bootstrap_required"].includes(String(state?.status)) ||
      (chunks > 0 && state?.status === "bootstrap_required" && state?.high_water === null)) {
    throw new Error("the vector bootstrap reset receipt is invalid");
  }
  return {
    chunks,
    pending,
    epoch,
    bootstrapRequired: state.status === "bootstrap_required",
    resumed: reset === 0,
  };
}

export async function reindex(env, { source = null, dryRun = true, bootstrap = false } = {}) {
  if (bootstrap) {
    if (source || dryRun) throw new Error("vector bootstrap requires a confirmed whole-corpus request");
    return bootstrapVectorProjectionPage(env);
  }
  const where = source ? "WHERE d.source = ?1" : "";
  const bind = source ? [source] : [];

  const countRow = await env.DB.prepare(
    `SELECT count(*) AS n FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid ${where}`
  ).bind(...bind).first();
  const chunks = Number(countRow?.n || 0);

  if (!chunks) return { chunks: 0, queued: 0, already_queued: 0, dry_run: dryRun, source };

  const beforeRow = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const before = Number(beforeRow?.n || 0);

  if (dryRun) return { chunks, queued: 0, already_queued: before, dry_run: true, source };

  if (!source) {
    const reset = await resetVectorProjectionBootstrap(env);
    return {
      chunks,
      queued: 0,
      already_queued: before,
      pending: reset.pending,
      bootstrap_required: reset.bootstrapRequired,
      bootstrap_epoch: reset.epoch,
      bootstrap_resumed: reset.resumed,
      dry_run: false,
      source,
    };
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
     SELECT c.chunk_uid, COALESCE(c.vector_id, c.chunk_uid), 'upsert', ?${source ? "2" : "1"}, 0, NULL
     FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid ${where}`
  ).bind(...bind, Date.now()).run();

  const afterRow = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const after = Number(afterRow?.n || 0);

  return { chunks, queued: after - before, already_queued: before, pending: after, dry_run: false, source };
}

export async function outboxDepth(env) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n, min(queued_at) AS oldest,
            sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) AS upserts,
            sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) AS deletes,
            sum(CASE WHEN submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END) AS submitted
     FROM vector_outbox`
  ).first();
  return {
    pending: Number(row?.n || 0),
    upserts: Number(row?.upserts || 0),
    deletes: Number(row?.deletes || 0),
    submitted: Number(row?.submitted || 0),
    oldest_queued_at: row?.oldest ?? null,
  };
}

/**
 * Exact semantic-projection readiness, not provider reachability.
 *
 * Read Vectorize first and D1 second. If ingest or a drain advances D1 between
 * those observations, the newer queue/fence makes this fail closed. A write
 * that starts after the D1 read simply starts after this point-in-time check.
 */
export async function vectorReadiness(env) {
  let description;
  try {
    description = await env.VECTORIZE.describe();
  } catch (error) {
    throw new Error(`the vector index could not report readiness: ${String(error?.message || error).slice(0, 240)}`);
  }
  const vectorCount = Number(
    description?.vectorCount ?? description?.vectorsCount ?? description?.count,
  );
  if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) {
    throw new Error("the vector index returned an invalid vector count");
  }

  const state = await env.DB.prepare(
    `SELECT schema_version,
            vector_projection_mutation_id AS mutation_id,
            vector_projection_submitted_at AS mutation_submitted_at,
            vector_projection_status AS projection_status,
            vector_projection_bootstrap_epoch AS bootstrap_epoch,
            vector_projection_bootstrap_cursor AS bootstrap_cursor,
            vector_projection_bootstrap_high_water AS bootstrap_high_water,
            (SELECT count(*) FROM chunks) AS expected_vectors,
            (SELECT count(*) FROM vector_outbox) AS pending,
            (SELECT count(*) FROM vector_outbox
              WHERE submitted_mutation_id IS NOT NULL) AS submitted,
            (SELECT min(queued_at) FROM vector_outbox) AS oldest_queued_at
       FROM install_state WHERE id = 1`
  ).first();
  if (!state || Number(state.schema_version) < 12) {
    throw new Error("the vector visibility receipt schema is not active");
  }
  const expected = Number(state.expected_vectors);
  const pending = Number(state.pending);
  const submitted = Number(state.submitted);
  if (![expected, pending, submitted].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      submitted > pending) {
    throw new Error("the vector readiness counts are invalid");
  }

  const mutationId = state.mutation_id === null || state.mutation_id === undefined || state.mutation_id === ""
    ? null
    : String(state.mutation_id);
  let mutationProcessed = mutationId === null;
  if (mutationId !== null) {
    const processed = description?.processedUpToMutation;
    if (processed === null || processed === undefined || processed === "") {
      mutationProcessed = false;
    } else if (typeof processed !== "string" && typeof processed !== "number") {
      throw new Error("the vector index did not expose its processed mutation watermark");
    } else {
      mutationProcessed = fenceWatermarkCovers(
        { mutationId, submittedAt: Number(state.mutation_submitted_at) },
        description,
      ) === true;
    }
  }

  const countsMatch = vectorCount === expected;
  const status = String(state.projection_status || "");
  const bootstrapEpoch = Number(state.bootstrap_epoch);
  if (!["verified", "pending", "bootstrap_required"].includes(status) ||
      !Number.isSafeInteger(bootstrapEpoch) || bootstrapEpoch < 0) {
    throw new Error("the vector projection verification state is invalid");
  }
  const ready = pending === 0 && mutationProcessed && countsMatch &&
    (expected === 0 || status === "verified");
  let reason = null;
  let action = null;
  if (!ready) {
    if (status === "bootstrap_required") {
      reason = "projection_bootstrap_required";
      action = "Run `brain update <manifest>` to resume the bounded legacy vector bootstrap.";
    } else if (pending > 0) {
      reason = submitted > 0 && !mutationProcessed
        ? "accepted_mutation_processing"
        : submitted > 0
          ? "accepted_mutation_needs_confirmation"
          : "vector_work_queued";
      action = remedyForState(env, "Run `brain drain <manifest>`; it confirms provider visibility without re-embedding accepted rows.");
    } else if (!mutationProcessed) {
      reason = "accepted_mutation_processing";
      action = remedyForState(env, "Wait for Vectorize processing, then run `brain drain <manifest>` again.");
    } else if (!countsMatch) {
      reason = "vector_count_mismatch";
      action = remedyForState(env, vectorCount < expected
        ? "Run `brain diagnose <manifest>`, then `brain reindex <manifest> --yes` to rebuild missing vectors."
        : "Vectorize has provider-only vectors that reindex cannot enumerate. Use a reviewed recovery to recreate/rebind the index and metadata indexes, then reindex and verify exact readiness.");
    } else {
      reason = "projection_unverified";
      action = remedyForState(env, "Run `brain drain <manifest>` to finish the exact vector verification receipt.");
    }
  }
  return {
    ready,
    reason,
    expected_vectors: expected,
    actual_vectors: vectorCount,
    pending,
    submitted,
    oldest_queued_at: state.oldest_queued_at ?? null,
    mutation_submitted_at: state.mutation_submitted_at ?? null,
    projection_status: status,
    bootstrap_epoch: bootstrapEpoch,
    action,
  };
}

/**
 * Remove documents from D1 and durably queue their Vectorize cleanup.
 *
 * ORDER MATTERS, AND IT IS THE OPPOSITE OF THE INSERT ORDER.
 *
 * On insert, D1 goes first because a chunk with no vector is findable and
 * repairable while a vector with no chunk is an orphan pointing at nothing.
 *
 * On delete, the dangerous state is inverted: it is data that should be gone and
 * is not. So D1 rows go FIRST. Once they are gone the document is invisible to
 * keyword search, and any vector still in Vectorize returns an id that hydration
 * cannot resolve, which searchVector already drops. A crash between the two
 * therefore leaves the document unreachable by BOTH paths, which is the safe
 * way to fail. The exclusive leased drain later removes the vectors to reclaim
 * the space.
 */
export async function forget(env, { docUids = [], source = null, dryRun = true } = {}) {
  let targets = docUids;
  if (source) {
    const { results } = await env.DB.prepare("SELECT doc_uid FROM documents WHERE source = ?1").bind(source).all();
    targets = [...new Set([...targets, ...(results || []).map((r) => r.doc_uid)])];
  }
  if (!targets.length) return { documents: 0, chunks: 0, vectors: 0, dry_run: dryRun, targets: [] };

  // D1 accepts at most 100 bound variables in one statement. Source-level
  // forget routinely targets hundreds or thousands of documents, so every
  // read and mutation is partitioned below that separate bind-parameter limit.
  const TARGET_BATCH = 50;
  const groups = [];
  for (let i = 0; i < targets.length; i += TARGET_BATCH) groups.push(targets.slice(i, i + TARGET_BATCH));
  const chunkRows = [];
  const documentRows = [];
  for (const group of groups) {
    const marks = group.map((_, i) => "?" + (i + 1)).join(",");
    const [{ results }, { results: documents }] = await Promise.all([
      env.DB.prepare(
      `SELECT chunk_uid, vector_id FROM chunks WHERE doc_uid IN (${marks})`
      ).bind(...group).all(),
      env.DB.prepare(
        `SELECT doc_uid, source FROM documents WHERE doc_uid IN (${marks})`
      ).bind(...group).all(),
    ]);
    chunkRows.push(...(results || []));
    documentRows.push(...(documents || []));
  }
  const chunkUids = (chunkRows || []).map((r) => r.chunk_uid);
  // Delete by the id the vector was actually STORED under, which is the hash
  // when the readable id was too long. Deleting by chunk_uid alone would leave
  // those vectors orphaned and still competing for retrieval slots.
  if (dryRun) {
    return { documents: targets.length, chunks: chunkUids.length, vectors: chunkUids.length, dry_run: true, targets };
  }

  // D1 first. The FTS index follows via the delete trigger, and ON DELETE
  // CASCADE removes the chunks with their document.
  const queuedAt = Date.now();
  for (const group of groups) {
    const marks = group.map((_, i) => "?" + (i + 1)).join(",");
    const groupSet = new Set(group);
    const groupSources = [...new Set(documentRows
      .filter((row) => groupSet.has(row.doc_uid))
      .map((row) => row.source))];
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
         SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?${group.length + 1}, 0, NULL
         FROM chunks WHERE doc_uid IN (${marks})
         ON CONFLICT(chunk_uid) DO UPDATE SET
           vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
           attempts=0, last_error=NULL`
      ).bind(...group, queuedAt),
      env.DB.prepare(`DELETE FROM chunks WHERE doc_uid IN (${marks})`).bind(...group),
      env.DB.prepare(`DELETE FROM documents WHERE doc_uid IN (${marks})`).bind(...group),
      ...groupSources.map((src) => env.DB.prepare(
        `INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
         SELECT ?1, COUNT(DISTINCT documents.doc_uid), COUNT(chunks.chunk_uid),
                (SELECT last_ingest_at FROM corpus_stats WHERE source=?1)
           FROM documents
           LEFT JOIN chunks ON chunks.doc_uid=documents.doc_uid
          WHERE documents.source=?1 AND documents.deleted_at IS NULL
         ON CONFLICT(source) DO UPDATE SET
           documents=excluded.documents, chunks=excluded.chunks`
      ).bind(src)),
    ]);
  }

  // Physical vector deletion is deliberately enqueue-only here. `drainOutbox`
  // is the sole Vectorize writer and owns the exclusive D1 lease; letting
  // forget write Vectorize directly would let a stale in-flight upsert land
  // after this delete. D1 hydration already makes the removed content
  // unreachable, while the durable delete rows make space reclamation
  // retryable after crashes or a busy drain.
  const vectors = 0;

  return {
    documents: targets.length, chunks: chunkUids.length, vectors,
    vector_cleanup_queued: chunkUids.length,
    dry_run: false, vector_error: null, targets,
  };
}

/** Count live physical rows and logical families in one derived source namespace. */
export async function sourceFamilyCounts(env, { source } = {}) {
  const normalizedSource = String(source || "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedSource)) {
    throw new TypeError("source family counts need a normalized source name");
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS stored_documents,
            COUNT(DISTINCT family_doc_uid) AS logical_documents
       FROM (
         SELECT CASE
           WHEN json_valid(meta)
            AND json_type(meta,'$.family_of') = 'text'
            AND length(json_extract(meta,'$.family_of')) > 0
             THEN json_extract(meta,'$.family_of')
           WHEN json_valid(meta)
            AND json_type(meta,'$.part_of') = 'text'
            AND length(json_extract(meta,'$.part_of')) > 0
             THEN CASE
               WHEN substr(json_extract(meta,'$.part_of'), 1, length(source) + 1) = source || ':'
                 THEN json_extract(meta,'$.part_of')
               ELSE source || ':' || json_extract(meta,'$.part_of')
             END
           ELSE doc_uid
         END AS family_doc_uid
           FROM documents
          WHERE deleted_at IS NULL
       )
      WHERE substr(family_doc_uid, 1, length(?1) + 1) = ?1 || ':'`
  ).bind(normalizedSource).first();
  return {
    stored_documents: Number(row?.stored_documents || 0),
    logical_documents: Number(row?.logical_documents || 0),
  };
}

/**
 * Return one uid per live logical source family in stable lexical pages.
 * Large connector documents use `meta.part_of`; multi-document exports use a
 * fully qualified `meta.family_of`. The latter can deliberately cross the
 * stored row's source namespace, for example `message:*` rows belonging to an
 * `upload:*` file. Source filtering therefore applies to the derived family
 * uid rather than to the physical row. DISTINCT happens before the cursor and
 * LIMIT so either representation occupies exactly one reconciliation slot.
 */
export async function listSourceFamilies(env, { source = null, cursor = "", limit = 500 } = {}) {
  // With no source filter this query derives the complete source set from live
  // document rows themselves. `corpus_stats` is useful operational metadata,
  // but it is denormalized and therefore cannot be the discovery boundary for
  // a completeness proof. A missing stats row must not hide an indexed family.
  const statement = source
    ? env.DB.prepare(
      `SELECT family_doc_uid
         FROM (
           SELECT DISTINCT CASE
             WHEN json_valid(meta)
              AND json_type(meta,'$.family_of') = 'text'
              AND length(json_extract(meta,'$.family_of')) > 0
               THEN json_extract(meta,'$.family_of')
             WHEN json_valid(meta)
              AND json_type(meta,'$.part_of') = 'text'
              AND length(json_extract(meta,'$.part_of')) > 0
               THEN CASE
                 WHEN substr(json_extract(meta,'$.part_of'), 1, length(source) + 1) = source || ':'
                   THEN json_extract(meta,'$.part_of')
                 ELSE source || ':' || json_extract(meta,'$.part_of')
               END
             ELSE doc_uid
           END AS family_doc_uid
             FROM documents
            WHERE deleted_at IS NULL
         )
        WHERE substr(family_doc_uid, 1, length(?1) + 1) = ?1 || ':'
          AND family_doc_uid > ?2
        ORDER BY family_doc_uid ASC
        LIMIT ?3`
    ).bind(source, cursor, limit + 1)
    : env.DB.prepare(
      `SELECT family_doc_uid
         FROM (
           SELECT DISTINCT CASE
             WHEN json_valid(meta)
              AND json_type(meta,'$.family_of') = 'text'
              AND length(json_extract(meta,'$.family_of')) > 0
               THEN json_extract(meta,'$.family_of')
             WHEN json_valid(meta)
              AND json_type(meta,'$.part_of') = 'text'
              AND length(json_extract(meta,'$.part_of')) > 0
               THEN CASE
                 WHEN substr(json_extract(meta,'$.part_of'), 1, length(source) + 1) = source || ':'
                   THEN json_extract(meta,'$.part_of')
                 ELSE source || ':' || json_extract(meta,'$.part_of')
               END
             ELSE doc_uid
           END AS family_doc_uid
             FROM documents
            WHERE deleted_at IS NULL
         )
        WHERE family_doc_uid > ?1
        ORDER BY family_doc_uid ASC
        LIMIT ?2`
    ).bind(cursor, limit + 1);
  const { results } = await statement.all();

  const page = (results || []).slice(0, limit).map((row) => String(row.family_doc_uid));
  return {
    source,
    families: page,
    next_cursor: (results || []).length > limit ? page[page.length - 1] : null,
  };
}

/** True when `uid` is the base itself or one of its oversized `#part` slices. */
const isStructuralFamilyMember = (uid, base) => uid === base || uid.startsWith(`${base}#part`);

/**
 * Remove stale members of a document family after every replacement part has
 * landed. This covers all three transitions: one-to-many, many-to-one and a
 * changed part count.
 *
 * WHAT A FAMILY IS. Two different producers put many documents under one base:
 *
 *   STRUCTURAL. splitOversized slices one oversized document into
 *   `<base>#part1of3`. The base is a literal prefix of every member, so
 *   membership is readable from the name alone.
 *
 *   DECLARED. A message export (WhatsApp .txt, SMS Backup & Restore .xml,
 *   Google Voice Takeout) is one file that becomes many conversation-session
 *   documents. Those keep their own `message:<first message id>` identity so a
 *   citation still points at the conversation, which means NOTHING in their
 *   names points back at the file. They say so instead: each row carries
 *   `meta.family_of` holding the fully qualified uid of the file it came from.
 *   Fully qualified deliberately, so no source-prefixing rule has to be
 *   re-derived here and mis-derived (`listSourceFamilies` has to guess at that
 *   for the older bare `part_of` values, and this format removes the guess).
 *
 * THE INVARIANT THIS ENFORCES, and why it is at least as strong as the exact
 * `#part` prefix test it replaces:
 *
 *   Every keep_doc_uid must belong to the family named by base_doc_uid, proven
 *   either structurally OR by the stored row's own declaration.
 *
 * The delete set is (everything in the family) minus (the keep list). A keep
 * uid that is not in the family protects nothing, so a caller whose family
 * model is wrong does not merely no-op: its keep list is inert while the scope
 * is real, and cleanup deletes the very revision it was called to reconcile.
 * The old prefix test was a syntactic PROXY for "inside the scope", correct
 * only while every family was structural. It now measures the real thing:
 * anything the old test rejected is still rejected unless the stored document
 * itself declares membership, which is stronger evidence than a matching name.
 *
 * Refusing is also the only honest option, because a wrong family key cannot be
 * repaired here: the scope is derived from the base alone, so an accepted-but
 * wrong base silently reaches no member at all.
 */
export async function forgetFamilies(env, { families = [], dryRun = true } = {}) {
  const normalized = [];
  for (const family of families || []) {
    const base = String(family?.base_doc_uid || "");
    const keep = [...new Set((family?.keep_doc_uids || []).map(String))];
    if (!base) {
      throw new Error("each document family needs a base_doc_uid and any keep_doc_uids must belong to it");
    }
    normalized.push({ base, keep });
  }
  if (!normalized.length) return { documents: 0, chunks: 0, vectors: 0, dry_run: dryRun, targets: [] };

  const stale = [];
  for (let i = 0; i < normalized.length; i += 25) {
    const group = normalized.slice(i, i + 25);
    const clauses = [];
    const binds = [];
    for (const family of group) {
      const n = binds.length;
      // D1 rejects LIKE/GLOB patterns longer than 50 bytes. Drive ids routinely
      // exceed that before the literal "#part" suffix is added, so a pattern
      // query cannot be used here. Comparing the exact leading substring keeps
      // %, _ and \\ literal and cannot include a similarly prefixed base id.
      // The declared arm is a plain equality on a fully qualified uid, so it
      // has neither problem. Neither arm adds a scan the substr did not already
      // force, and json_valid() guards a row whose meta is not JSON.
      clauses.push(
        `(doc_uid = ?${n + 1}` +
        ` OR substr(doc_uid, 1, length(?${n + 1} || '#part')) = ?${n + 1} || '#part'` +
        ` OR (json_valid(meta) AND json_type(meta,'$.family_of') = 'text'` +
        `     AND json_extract(meta,'$.family_of') = ?${n + 1}))`
      );
      binds.push(family.base);
    }
    const { results } = await env.DB.prepare(
      `SELECT doc_uid,
              CASE WHEN json_valid(meta) AND json_type(meta,'$.family_of') = 'text'
                   THEN json_extract(meta,'$.family_of') END AS family_of
         FROM documents WHERE ${clauses.join(" OR ")}`
    ).bind(...binds).all();
    const rows = (results || []).map((row) => ({
      uid: String(row.doc_uid),
      declaredFamily: row.family_of == null ? null : String(row.family_of),
    }));

    // Validate against what the family actually contains, one family at a
    // time, BEFORE anything is deleted. forget() below is the only mutation in
    // this function, so a refusal here leaves every group untouched.
    for (const family of group) {
      const members = new Set(
        rows.filter((row) => row.declaredFamily === family.base).map((row) => row.uid)
      );
      const stray = family.keep.filter(
        (uid) => !isStructuralFamilyMember(uid, family.base) && !members.has(uid)
      );
      if (stray.length) {
        // Deliberately no uid in the message: this reaches an HTTP response,
        // and a doc_uid carries a file path.
        throw new Error("each document family needs a base_doc_uid and any keep_doc_uids must belong to it");
      }
    }

    const keep = new Set(group.flatMap((family) => family.keep));
    stale.push(...rows.map((row) => row.uid).filter((uid) => !keep.has(uid)));
  }
  return forget(env, { docUids: [...new Set(stale)], dryRun });
}

async function requireVectorRetryStateTable(env) {
  try {
    await env.DB.prepare("SELECT 1 FROM vector_outbox_retry_state LIMIT 1").first();
  } catch {
    throw new Error(
      "vector retry state schema is unavailable; run `brain migrate <manifest>` before vector operations",
    );
  }
}

/** Privacy-safe retry state for owner alerts and operator receipts. */
export async function vectorRetrySummary(env, now = Date.now()) {
  await requireVectorRetryStateTable(env);
  const row = await env.DB.prepare(
    `SELECT count(*) AS tracked,
            sum(CASE WHEN quarantined_at IS NOT NULL THEN 1 ELSE 0 END) AS quarantined,
            sum(CASE WHEN quarantined_at IS NULL AND next_attempt_at > ? THEN 1 ELSE 0 END) AS delayed,
            min(CASE WHEN quarantined_at IS NULL THEN next_attempt_at END) AS next_attempt_at
       FROM vector_outbox_retry_state s
      WHERE EXISTS (
        SELECT 1 FROM vector_outbox o
         WHERE o.chunk_uid=s.chunk_uid AND o.generation=s.generation
      )`
  ).bind(now).first();
  return {
    tracked: Number(row?.tracked || 0),
    quarantined: Number(row?.quarantined || 0),
    delayed: Number(row?.delayed || 0),
    next_attempt_at: row?.next_attempt_at ?? null,
  };
}

/** Explicit operator preview/confirm for quarantined vector generations. */
export async function retryQuarantinedVectorOps(env, { confirm = false, limit = 100 } = {}) {
  await requireVectorRetryStateTable(env);
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const total = await env.DB.prepare(
    `SELECT count(*) AS n FROM vector_outbox_retry_state s
      WHERE s.quarantined_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM vector_outbox o
          WHERE o.chunk_uid=s.chunk_uid AND o.generation=s.generation)`
  ).first();
  const quarantined = Number(total?.n || 0);
  if (!confirm || quarantined === 0) {
    return { quarantined, selected: Math.min(quarantined, bounded), retried: 0, dry_run: true };
  }
  const { results: rows } = await env.DB.prepare(
    `SELECT s.chunk_uid, s.generation
       FROM vector_outbox_retry_state s
       JOIN vector_outbox o ON o.chunk_uid=s.chunk_uid AND o.generation=s.generation
      WHERE s.quarantined_at IS NOT NULL
      ORDER BY s.quarantined_at, s.chunk_uid LIMIT ?`
  ).bind(bounded).all();
  const statements = [];
  for (const row of rows || []) {
    statements.push(env.DB.prepare(
      "DELETE FROM vector_outbox_retry_state WHERE chunk_uid=? AND generation=? AND quarantined_at IS NOT NULL"
    ).bind(row.chunk_uid, row.generation));
    statements.push(env.DB.prepare(
      "UPDATE vector_outbox SET attempts=0,last_error=NULL WHERE chunk_uid=? AND generation=?"
    ).bind(row.chunk_uid, row.generation));
  }
  if (statements.length) await env.DB.batch(statements);
  return {
    quarantined,
    selected: (rows || []).length,
    retried: (rows || []).length,
    dry_run: false,
    remaining_quarantined: Math.max(0, quarantined - (rows || []).length),
  };
}

/** Prove the one exact live fixed public document without returning its contents. */
export async function fixedPublicSmokeState(env) {
  const expectedContentHash = await publicInstallSmokeContentHash(env);
  const row = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM documents
         WHERE source=?1 AND deleted_at IS NULL) live_document_count,
       d.doc_uid,d.source,d.source_id,d.title,d.content_hash,d.meta,
       d.text_source,d.text_reliable,
       (SELECT count(*) FROM chunks c
         WHERE c.doc_uid=?2) chunk_count,
       (SELECT count(*) FROM chunks c
         WHERE c.doc_uid=?2 AND c.chunk_uid=?3 AND c.chunk_ix=0
           AND c.text=?4 AND c.source=?1 AND c.title=?5) exact_chunk_count
       FROM (SELECT 1) seed
       LEFT JOIN documents d ON d.doc_uid=?2 AND d.deleted_at IS NULL`
  ).bind(
    PUBLIC_INSTALL_SMOKE_SOURCE,
    PUBLIC_INSTALL_SMOKE_DOC_UID,
    `${PUBLIC_INSTALL_SMOKE_DOC_UID}#0`,
    PUBLIC_INSTALL_SMOKE_CHUNK,
    PUBLIC_INSTALL_SMOKE_TITLE,
  ).first();
  const documents = Number(row?.live_document_count || 0);
  const identityExact = documents === 1 && row?.doc_uid === PUBLIC_INSTALL_SMOKE_DOC_UID &&
    row?.source === PUBLIC_INSTALL_SMOKE_SOURCE && row?.source_id === PUBLIC_INSTALL_SMOKE_ID &&
    row?.title === PUBLIC_INSTALL_SMOKE_TITLE && Number(row?.chunk_count) === 1 &&
    Number(row?.exact_chunk_count) === 1 && row?.content_hash === expectedContentHash &&
    row?.text_source === "native" && Number(row?.text_reliable) === 1;
  let metadata;
  try { metadata = JSON.parse(String(row?.meta || "{}")); } catch { metadata = null; }
  const metadataKeys = metadata && !Array.isArray(metadata)
    ? Object.keys(metadata).sort()
    : [];
  const metadataExact = metadataKeys.length === 5 &&
    metadataKeys.join("|") ===
      "contains_customer_data|evidence_lineage|proof_kind|provenance_receipt|schema_version" &&
    metadata.proof_kind === PUBLIC_INSTALL_SMOKE_METADATA.proof_kind &&
    metadata.contains_customer_data === PUBLIC_INSTALL_SMOKE_METADATA.contains_customer_data &&
    metadata.schema_version === PUBLIC_INSTALL_SMOKE_METADATA.schema_version &&
    JSON.stringify(metadata.evidence_lineage) ===
      JSON.stringify(PUBLIC_INSTALL_SMOKE_METADATA.evidence_lineage) &&
    JSON.stringify(metadata.provenance_receipt) ===
      JSON.stringify(PUBLIC_INSTALL_SMOKE_METADATA.provenance_receipt);
  return { proven: Boolean(identityExact && metadataExact), documents };
}

export async function fixedPublicSmokeProof(env) {
  return (await fixedPublicSmokeState(env)).proven;
}
