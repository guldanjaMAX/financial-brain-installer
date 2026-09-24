/**
 * Bounded, resumable cleanup analysis and owner-approved removal previews.
 *
 * This module deliberately does not add a second delete implementation. It
 * identifies exact targets and proves the existing forget dry-run. Confirmed
 * removal is fail-closed until the store has one atomic guarded mutation that
 * can preserve locations and delete only unchanged exact targets.
 */
import { textQuality } from "../../../ingest/quality.mjs";
import { forget } from "./store-d1.js";
import {
  MAX_CLEANUP_LOCATION_REFERENCES,
  cleanupLocationReference,
  cleanupLocationReferences,
} from "./cleanup-location-references.js";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 200;
const HEAVY_VECTOR_THRESHOLD = 500;

export const CLEANUP_CONTENT_PAGE_SQL = `
  /* optimize-cleanup: content page */
  SELECT d.rowid AS document_rowid, d.doc_uid, d.source, d.source_id, d.title, d.uri,
         d.document_date, d.top_folder, d.client, d.category, d.platform,
         d.entity_slug, d.content_hash, d.meta,
         EXISTS(SELECT 1 FROM document_access_documents access_doc
                 WHERE access_doc.document_id=d.doc_uid) AS access_grant_count,
         CASE WHEN EXISTS(SELECT 1 FROM chunks present WHERE present.doc_uid=d.doc_uid)
                    AND NOT EXISTS(
                      SELECT 1 FROM chunks boundary_chunk
                       WHERE boundary_chunk.doc_uid=d.doc_uid
                         AND (boundary_chunk.source IS NOT d.source
                           OR boundary_chunk.document_date IS NOT d.document_date
                           OR boundary_chunk.client IS NOT d.client
                           OR boundary_chunk.category IS NOT d.category
                           OR boundary_chunk.top_folder IS NOT d.top_folder
                           OR boundary_chunk.platform IS NOT d.platform))
              THEN 1 ELSE 0 END AS retrieval_boundaries_proved
    FROM documents d INDEXED BY idx_documents_live_content_hash
   WHERE d.deleted_at IS NULL
     AND d.content_hash IS NOT NULL AND d.content_hash != ''
     AND (d.content_hash > ?1 OR (d.content_hash = ?1 AND d.rowid > CAST(?2 AS INTEGER)))
   ORDER BY d.content_hash, d.rowid
   LIMIT ?3`;

export const CLEANUP_DOCUMENT_PAGE_SQL = `
  /* optimize-cleanup: document page */
  SELECT d.doc_uid, d.source, d.source_id, d.title, d.uri, d.document_date,
         d.top_folder, d.client, d.category, d.content_hash, d.meta,
         (SELECT COUNT(*) FROM chunks c INDEXED BY idx_chunks_doc
           WHERE c.doc_uid=d.doc_uid) AS chunk_count,
         (SELECT COALESCE(SUM(length(c.text)), 0) FROM chunks c INDEXED BY idx_chunks_doc
           WHERE c.doc_uid=d.doc_uid) AS text_characters
    FROM documents d INDEXED BY sqlite_autoindex_documents_1
   WHERE d.doc_uid > ?1 AND d.deleted_at IS NULL
   ORDER BY d.doc_uid
   LIMIT ?2`;

export const CLEANUP_CHUNK_PAGE_SQL = `
  /* optimize-cleanup: quality page */
  SELECT c.doc_uid, c.chunk_ix, c.text
    FROM chunks c INDEXED BY sqlite_autoindex_chunks_2
   WHERE c.doc_uid > ?1 OR (c.doc_uid = ?1 AND c.chunk_ix > ?2)
   ORDER BY c.doc_uid, c.chunk_ix
   LIMIT ?3`;

const boundedPage = (value) => Math.min(Math.max(Number(value) || DEFAULT_PAGE, 1), MAX_PAGE);

const rowsOf = (result) => Array.isArray(result?.results) ? result.results : [];

function cleanupContentCursor(value) {
  if (value == null) return { content_hash: "", document_rowid: "" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw cleanupError("cleanup_cursor_invalid", "The cleanup cursor is invalid.");
  }
  const contentHash = String(value.content_hash || "");
  const documentRowid = String(value.document_rowid || "");
  if (contentHash.length > 256 || documentRowid.length > 32 ||
      (documentRowid && !/^\d+$/.test(documentRowid))) {
    throw cleanupError("cleanup_cursor_invalid", "The cleanup cursor is invalid.");
  }
  return { content_hash: contentHash, document_rowid: documentRowid };
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(copy|final|revised|revision|notes?|summary|transcript)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function publicRule(kind, count, vectors, characters, loss, rule, extra = {}) {
  return {
    kind,
    count,
    estimated_projected_vectors_saved: vectors,
    estimated_text_characters_saved: characters,
    what_owner_would_lose: loss,
    rule,
    ...extra,
  };
}

function duplicateSafetyKey(row) {
  // Physical collapse is safe only inside every retrieval boundary that the
  // duplicate row can affect. Other identical rows stay findings, not targets.
  return [
    row.source,
    row.entity_slug ?? "",
    row.document_date ?? "",
    row.top_folder ?? "",
    row.client ?? "",
    row.category ?? "",
    row.platform ?? "",
    row.content_hash,
  ].join("\u001f");
}

function locationReference(row) {
  return cleanupLocationReference({
    source: String(row.source || ""),
    source_id: String(row.source_id || ""),
    title: row.title == null ? null : String(row.title),
    uri: row.uri == null ? null : String(row.uri),
  });
}

function exactGroupAnalysis(rows, { includeSampleTitles = false } = {}) {
  const eligible = [];
  let refusedUnprovedBoundaryRows = 0;
  let refusedAccessBoundRows = 0;
  let refusedLocationRows = 0;
  for (const row of rows) {
    if (Number(row.access_grant_count || 0) !== 0) {
      refusedAccessBoundRows += 1;
      continue;
    }
    if (Number(row.retrieval_boundaries_proved || 0) !== 1) {
      refusedUnprovedBoundaryRows += 1;
      continue;
    }
    const current = locationReference(row);
    const rawPrior = parseObject(row.meta).cleanup_location_references;
    const prior = rawPrior === undefined ? [] : cleanupLocationReferences(row.meta);
    if (!current || (rawPrior !== undefined && (!Array.isArray(rawPrior) ||
        rawPrior.length > MAX_CLEANUP_LOCATION_REFERENCES || prior.length !== rawPrior.length))) {
      refusedLocationRows += 1;
      continue;
    }
    eligible.push({ row, current, prior });
  }
  const groups = new Map();
  for (const item of eligible) {
    const { row } = item;
    const key = duplicateSafetyKey(row);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const exact = [...groups.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => {
      const ordered = [...group].sort((a, b) =>
        String(a.row.doc_uid).localeCompare(String(b.row.doc_uid)));
      const referenceCount = ordered.reduce((sum, item) => sum + 1 + item.prior.length, 0);
      if (referenceCount > MAX_CLEANUP_LOCATION_REFERENCES) {
        refusedLocationRows += ordered.length;
        return [];
      }
      const canonical = ordered[0];
      const aliases = ordered.slice(1);
      return [{
        canonical_doc_uid: canonical.row.doc_uid,
        canonical_content_hash: canonical.row.content_hash,
        remove_doc_uids: aliases.map((item) => item.row.doc_uid),
        references: ordered.flatMap((item) => {
          const references = [item.current, ...item.prior];
          return references.map((reference) => ({
            ...reference,
            ...(!includeSampleTitles ? { title: null } : {}),
          }));
        }),
        ...(includeSampleTitles
          ? { sample_titles: ordered.slice(0, 3).map((item) => item.row.title).filter(Boolean) }
          : {}),
      }];
    });
  return {
    groups: exact,
    refusedUnprovedBoundaryRows,
    refusedAccessBoundRows,
    refusedLocationRows,
  };
}

function visibleContentRows(rows, page) {
  const visible = rows.slice(0, page);
  const next = rows[page];
  const boundaryHash = visible.at(-1)?.content_hash;
  if (next && boundaryHash === next.content_hash &&
      visible.filter((row) => row.content_hash === boundaryHash).length === 1) {
    visible.push(next);
  }
  return visible;
}

function crossBoundaryDuplicateCount(rows) {
  const byHash = new Map();
  for (const row of rows) {
    const keys = byHash.get(row.content_hash) || new Set();
    keys.add(duplicateSafetyKey(row));
    byHash.set(row.content_hash, keys);
  }
  return [...byHash.values()].filter((keys) => keys.size > 1).length;
}

function nearDuplicateCount(rows) {
  const families = new Map();
  for (const row of rows) {
    const title = normalizedTitle(row.title);
    if (!title) continue;
    const key = `${row.source}\u001f${row.document_date ?? ""}\u001f${title}`;
    const hashes = families.get(key) || new Set();
    hashes.add(row.content_hash);
    families.set(key, hashes);
  }
  return [...families.values()].filter((hashes) => hashes.size > 1).length;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanupError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function assertCleanupIdle(env, now) {
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    throw cleanupError("cleanup_update_active", "Cleanup is unavailable while an update holds the Brain.");
  }
  const state = await env.DB.prepare(
    `/* optimize-cleanup: activity guard */
     SELECT EXISTS(SELECT 1 FROM sources WHERE status='indexing') AS ingest_active,
            CASE WHEN vector_drain_lease_owner IS NOT NULL
                       AND COALESCE(vector_drain_lease_expires_at, 0) > ?1
                 THEN 1 ELSE 0 END AS drain_active
       FROM install_state WHERE id=1`,
  ).bind(now).first();
  if (!state) {
    throw cleanupError("cleanup_activity_unavailable", "Cleanup could not prove that the Brain is idle.");
  }
  if (Number(state?.ingest_active) === 1) {
    throw cleanupError("cleanup_ingest_active", "Cleanup is unavailable while a source load is active.");
  }
  if (Number(state?.drain_active) === 1) {
    throw cleanupError("cleanup_drain_active", "Cleanup is unavailable while the vector drain is active.");
  }
}

async function d1Bytes(env) {
  try {
    const [pages, size] = await Promise.all([
      env.DB.prepare("PRAGMA page_count").first(),
      env.DB.prepare("PRAGMA page_size").first(),
    ]);
    const pageCount = Number(pages?.page_count);
    const pageSize = Number(size?.page_size);
    return Number.isFinite(pageCount) && Number.isFinite(pageSize) ? pageCount * pageSize : null;
  } catch {
    return null;
  }
}

async function cleanupTotals(env) {
  const [registered, size] = await Promise.all([
    env.DB.prepare(
      `/* optimize-cleanup: registry totals */
       SELECT COALESCE(SUM(documents), 0) AS documents,
              COALESCE(SUM(chunks), 0) AS chunks
         FROM corpus_stats`,
    ).first(),
    d1Bytes(env),
  ]);
  return {
    documents: Number(registered?.documents || 0),
    chunks: Number(registered?.chunks || 0),
    expected_vectors: Number(registered?.chunks || 0),
    actual_vectors: null,
    vector_count_observed: false,
    d1_bytes: size,
    count_source: "corpus_stats",
  };
}

async function targetStorageEstimate(env, docUids) {
  const ids = [...new Set((docUids || []).map(String))];
  let vectors = 0;
  let characters = 0;
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    const marks = batch.map((_, index) => `?${index + 1}`).join(",");
    const result = await env.DB.prepare(
      `/* optimize-cleanup: bounded savings estimate */
       SELECT COUNT(*) AS chunks, COALESCE(SUM(length(text)), 0) AS text_characters
         FROM chunks WHERE doc_uid IN (${marks})`,
    ).bind(...batch).first();
    vectors += Number(result?.chunks || 0);
    characters += Number(result?.text_characters || 0);
  }
  return { vectors, characters };
}

/** One bounded audit slice. The opaque cursors can be handed back unchanged. */
export async function cleanupAuditPage(env, {
  cursor = {}, limit = DEFAULT_PAGE, includeSampleTitles = false,
  declaredScopes = {}, now = Date.now(),
} = {}) {
  await assertCleanupIdle(env, now);
  const page = boundedPage(limit);
  const pageLimit = page + 1;
  const contentPageLimit = page + 2;
  const [contentResult, documentResult, chunkResult, sourceResult, supersededResult, before] = await Promise.all([
    env.DB.prepare(CLEANUP_CONTENT_PAGE_SQL).bind(
      String(cursor.content_hash || ""), String(cursor.document_rowid || ""), contentPageLimit,
    ).all(),
    env.DB.prepare(CLEANUP_DOCUMENT_PAGE_SQL).bind(String(cursor.doc_uid || ""), pageLimit).all(),
    env.DB.prepare(CLEANUP_CHUNK_PAGE_SQL).bind(
      String(cursor.chunk_doc_uid || ""), Number(cursor.chunk_ix ?? -1), pageLimit,
    ).all(),
    env.DB.prepare(
      `/* optimize-cleanup: source scopes */
       SELECT name, kind, scope FROM sources WHERE name > ?1 ORDER BY name LIMIT ?2`,
    ).bind(String(cursor.source_name || ""), pageLimit).all(),
    env.DB.prepare(
      `/* optimize-cleanup: superseded page */
       SELECT predecessor_doc_uid, successor_doc_uid
         FROM memory_supersessions
        WHERE predecessor_doc_uid > ?1
        ORDER BY predecessor_doc_uid LIMIT ?2`,
    ).bind(String(cursor.superseded_doc_uid || ""), pageLimit).all(),
    cleanupTotals(env),
  ]);

  const contentRows = rowsOf(contentResult);
  const documentRows = rowsOf(documentResult);
  const chunkRows = rowsOf(chunkResult);
  const sourceRows = rowsOf(sourceResult);
  const supersededRows = rowsOf(supersededResult);
  const visibleContent = visibleContentRows(contentRows, page);
  const visibleDocuments = documentRows.slice(0, page);
  const visibleChunks = chunkRows.slice(0, page);
  const visibleSuperseded = supersededRows.slice(0, page);
  const duplicateAnalysis = exactGroupAnalysis(visibleContent, { includeSampleTitles });
  const groups = duplicateAnalysis.groups;
  const removable = groups.reduce((sum, group) => sum + group.remove_doc_uids.length, 0);
  const removedUids = groups.flatMap((group) => group.remove_doc_uids);

  const badDocs = new Map();
  for (const row of visibleChunks) {
    const quality = textQuality(row.text);
    if (!quality.ok && !badDocs.has(row.doc_uid)) badDocs.set(row.doc_uid, quality.reason);
  }
  const scopes = new Map(Object.entries(declaredScopes || {}).map(([name, scope]) => [
    name, parseObject(scope),
  ]));
  for (const row of sourceRows.slice(0, page)) {
    if (!scopes.has(row.name)) scopes.set(row.name, parseObject(row.scope));
  }
  const outside = visibleDocuments.filter((row) => {
    const declared = scopes.get(row.source);
    const metadata = parseObject(row.meta);
    const allowedRootIds = Array.isArray(declared?.root_folder_ids)
      ? declared.root_folder_ids.map(String)
      : [];
    const observedRootIds = Array.isArray(metadata.root_folder_ids)
      ? metadata.root_folder_ids.map(String)
      : [];
    if (allowedRootIds.length && observedRootIds.length) {
      return !observedRootIds.some((id) => allowedRootIds.includes(id));
    }
    const allowedFolders = Array.isArray(declared?.top_folders)
      ? declared.top_folders.map(String)
      : Array.isArray(declared?.roots) ? declared.roots.map(String) : [];
    return allowedFolders.length > 0 && row.top_folder && !allowedFolders.includes(String(row.top_folder));
  });
  const heavy = visibleDocuments.filter((row) => Number(row.chunk_count || 0) >= HEAVY_VECTOR_THRESHOLD);
  const crossBoundary = crossBoundaryDuplicateCount(visibleContent);
  const nearFamilies = new Map();
  for (const row of visibleContent) {
    const title = normalizedTitle(row.title);
    if (!title) continue;
    const key = `${row.source}\u001f${row.document_date ?? ""}\u001f${title}`;
    const family = nearFamilies.get(key) || [];
    family.push(row);
    nearFamilies.set(key, family);
  }
  const nearCandidates = [...nearFamilies.values()]
    .filter((family) => new Set(family.map((row) => row.content_hash)).size > 1)
    .flat();
  const [duplicateEstimate, junkEstimate, supersededEstimate] = await Promise.all([
    targetStorageEstimate(env, removedUids),
    targetStorageEstimate(env, [...badDocs.keys()]),
    targetStorageEstimate(env, visibleSuperseded.map((row) => row.predecessor_doc_uid)),
  ]);

  const findings = [
    publicRule(
      "exact_duplicates", removable, duplicateEstimate.vectors, duplicateEstimate.characters,
      "No copy is removed while guarded duplicate removal is unavailable.",
      "Review exact duplicate groups. Removal remains fail-closed.",
      {
        groups: groups.length,
        cross_boundary_candidate_families: crossBoundary,
        refused_unproved_boundary_rows: duplicateAnalysis.refusedUnprovedBoundaryRows,
        refused_access_bound_rows: duplicateAnalysis.refusedAccessBoundRows,
        refused_location_rows: duplicateAnalysis.refusedLocationRows,
      },
    ),
    publicRule(
      "near_duplicate_candidates", nearDuplicateCount(visibleContent), 0, 0,
      "Nothing. These are candidates only and cannot become a removal plan automatically.",
      "Review transcript, notes, and summary families before choosing any removal.",
      { candidate_doc_uids: nearCandidates.map((row) => row.doc_uid) },
    ),
    publicRule(
      "retroactive_junk", badDocs.size, junkEstimate.vectors, junkEstimate.characters,
      "The stored extraction for each selected item, after a title-level review.",
      "Remove items that fail the same readable-text check used by new loads.",
      { candidate_doc_uids: [...badDocs.keys()] },
    ),
    publicRule(
      "outside_declared_scope", outside.length,
      outside.reduce((sum, row) => sum + Number(row.chunk_count || 0), 0),
      outside.reduce((sum, row) => sum + Number(row.text_characters || 0), 0),
      "Content outside an explicitly recorded source scope.",
      "Remove Drive items outside the reviewed roots and exclude that path from future loads.",
      { candidate_doc_uids: outside.map((row) => row.doc_uid) },
    ),
    publicRule(
      "heavy_low_value_candidates", heavy.length,
      heavy.reduce((sum, row) => sum + Number(row.chunk_count || 0), 0),
      heavy.reduce((sum, row) => sum + Number(row.text_characters || 0), 0),
      "Potentially large documents. Size alone never authorizes removal.",
      "Review unusually heavy items, then remove only the ones the owner identifies as low value.",
      { candidate_doc_uids: heavy.map((row) => row.doc_uid) },
    ),
    publicRule(
      "stale_or_superseded", visibleSuperseded.length, supersededEstimate.vectors,
      supersededEstimate.characters,
      "Predecessor records whose exact successor is already recorded.",
      "Remove a superseded copy only after reviewing its recorded successor.",
      { candidate_doc_uids: visibleSuperseded.map((row) => row.predecessor_doc_uid) },
    ),
  ];

  const lastContent = visibleContent.at(-1);
  const lastDocument = visibleDocuments.at(-1);
  const lastChunk = visibleChunks.at(-1);
  const lastSuperseded = visibleSuperseded.at(-1);
  return {
    read_only: true,
    findings,
    before,
    reads: [
      { lane: "content", rows: contentRows.length, limit: contentPageLimit },
      { lane: "documents", rows: documentRows.length, limit: pageLimit },
      { lane: "chunks", rows: chunkRows.length, limit: pageLimit },
      { lane: "sources", rows: sourceRows.length, limit: pageLimit },
      { lane: "superseded", rows: supersededRows.length, limit: pageLimit },
    ],
    resume: {
      complete: contentRows.length <= page + 1 && documentRows.length <= page &&
        chunkRows.length <= page && supersededRows.length <= page && sourceRows.length <= page,
      cursor: {
        content_hash: lastContent?.content_hash || cursor.content_hash || "",
        document_rowid: lastContent?.document_rowid || cursor.document_rowid || "",
        doc_uid: lastDocument?.doc_uid || cursor.doc_uid || "",
        chunk_doc_uid: lastChunk?.doc_uid || cursor.chunk_doc_uid || "",
        chunk_ix: lastChunk?.chunk_ix ?? cursor.chunk_ix ?? -1,
        superseded_doc_uid: lastSuperseded?.predecessor_doc_uid || cursor.superseded_doc_uid || "",
        source_name: sourceRows.slice(0, page).at(-1)?.name || cursor.source_name || "",
      },
      rate_limit_hint_ms: 250,
    },
  };
}

async function currentDuplicateWindow(env, maxRows, cursor = {}) {
  const safeCursor = cleanupContentCursor(cursor);
  const result = await env.DB.prepare(CLEANUP_CONTENT_PAGE_SQL).bind(
    safeCursor.content_hash, safeCursor.document_rowid, maxRows + 2,
  ).all();
  const fetched = rowsOf(result);
  const rows = visibleContentRows(fetched, maxRows);
  const last = rows.at(-1);
  return {
    rows,
    resume: {
      complete: fetched.length <= maxRows + 1,
      cursor: {
        content_hash: last?.content_hash || safeCursor.content_hash,
        document_rowid: last?.document_rowid || safeCursor.document_rowid,
      },
    },
  };
}

/** Build exactly one owner-reviewable rule plan. */
export async function prepareCleanupPlan(env, {
  rule, cursor = {}, includeSampleTitles = false, limit = MAX_PAGE, now = Date.now(),
} = {}) {
  await assertCleanupIdle(env, now);
  if (!["exact_duplicates", "selected_documents"].includes(rule?.kind)) {
    throw cleanupError("cleanup_rule_not_plannable", "Choose exact duplicates or a reviewed set of candidate documents.");
  }
  let groups = [];
  let targets = [];
  let snapshots = [];
  let duplicateAnalysis = null;
  let resume = { complete: true, cursor: {} };
  const boundedLimit = boundedPage(limit);
  const safeCursor = cleanupContentCursor(cursor);
  if (rule.kind === "exact_duplicates") {
    const window = await currentDuplicateWindow(env, boundedLimit, safeCursor);
    duplicateAnalysis = exactGroupAnalysis(window.rows, { includeSampleTitles });
    groups = duplicateAnalysis.groups;
    targets = groups.flatMap((group) => group.remove_doc_uids);
    resume = window.resume;
  } else {
    const selected = Array.isArray(rule.doc_uids) ? [...new Set(rule.doc_uids.map(String))] : [];
    if (!selected.length || selected.length > 50) {
      throw cleanupError("cleanup_rule_not_plannable", "A selected-document rule needs 1 to 50 exact candidate ids.");
    }
    for (let start = 0; start < selected.length; start += 50) {
      const batch = selected.slice(start, start + 50);
      const marks = batch.map((_, index) => `?${index + 1}`).join(",");
      const result = await env.DB.prepare(
        `/* optimize-cleanup: selected target readback */
         SELECT d.doc_uid, d.content_hash, d.title, d.source, d.entity_slug,
                d.client, d.category, d.top_folder, d.platform, d.document_date,
                (SELECT COUNT(*) FROM chunks c INDEXED BY idx_chunks_doc
                  WHERE c.doc_uid=d.doc_uid) AS chunks,
                (SELECT COALESCE(SUM(length(c.text)), 0) FROM chunks c INDEXED BY idx_chunks_doc
                  WHERE c.doc_uid=d.doc_uid) AS text_characters
           FROM documents d WHERE d.deleted_at IS NULL AND d.doc_uid IN (${marks})`,
      ).bind(...batch).all();
      snapshots.push(...rowsOf(result));
    }
    if (snapshots.length !== selected.length) {
      throw cleanupError("cleanup_plan_changed", "At least one selected cleanup candidate no longer exists.");
    }
    targets = selected.sort();
  }
  const chunkRows = [];
  for (let start = 0; start < targets.length; start += 50) {
    const batch = targets.slice(start, start + 50);
    const marks = batch.map((_, index) => `?${index + 1}`).join(",");
    const result = await env.DB.prepare(
      `/* optimize-cleanup: plan target counts */
       SELECT doc_uid, COUNT(*) AS chunks, COALESCE(SUM(length(text)), 0) AS text_characters
         FROM chunks WHERE doc_uid IN (${marks}) GROUP BY doc_uid`,
    ).bind(...batch).all();
    chunkRows.push(...rowsOf(result));
  }
  const safeRule = rule.kind === "exact_duplicates"
    ? { kind: "exact_duplicates" }
    : {
      kind: "selected_documents",
      finding_kind: String(rule.finding_kind || "reviewed_candidates"),
      doc_uids: targets,
    };
  const payload = {
    version: 1,
    rule: safeRule,
    scan: rule.kind === "exact_duplicates"
      ? { cursor: safeCursor, limit: boundedLimit }
      : null,
    groups,
    targets,
    target_snapshots: snapshots.map((row) => ({
      doc_uid: row.doc_uid,
      content_hash: row.content_hash,
      source: row.source,
      entity_slug: row.entity_slug,
      client: row.client,
      category: row.category,
      top_folder: row.top_folder,
      platform: row.platform,
      document_date: row.document_date,
      chunks: Number(row.chunks || 0),
      text_characters: Number(row.text_characters || 0),
      ...(includeSampleTitles && row.title ? { title: row.title } : {}),
    })).sort((a, b) => a.doc_uid.localeCompare(b.doc_uid)),
    counts: {
      documents: targets.length,
      chunks: chunkRows.reduce((sum, row) => sum + Number(row.chunks || 0), 0),
      expected_vector_deletes: chunkRows.reduce((sum, row) => sum + Number(row.chunks || 0), 0),
      text_characters: chunkRows.reduce((sum, row) => sum + Number(row.text_characters || 0), 0),
    },
    resume,
    more_cleanup_possible: rule.kind === "exact_duplicates" ? !resume.complete : false,
    refused_unproved_boundary_rows: duplicateAnalysis?.refusedUnprovedBoundaryRows || 0,
    refused_access_bound_rows: duplicateAnalysis?.refusedAccessBoundRows || 0,
    refused_location_rows: duplicateAnalysis?.refusedLocationRows || 0,
    apply_available: false,
    apply_unavailable_reason: "atomic_guarded_removal_not_implemented",
    undo: {
      supported: false,
      command: null,
      explanation: "Removal is unavailable. No stored document is changed by this plan.",
    },
  };
  return { ...payload, fingerprint: await sha256(stable(payload)) };
}

/** Dry-run always happens. Confirmed mutation remains fail-closed. */
export async function applyCleanupPlan(env, {
  plan, approvalFingerprint = null, confirm = false, now = Date.now(),
} = {}) {
  await assertCleanupIdle(env, now);
  if (!plan || !["exact_duplicates", "selected_documents"].includes(plan.rule?.kind)) {
    throw cleanupError("cleanup_plan_invalid", "An exact cleanup plan is required.");
  }
  const current = await prepareCleanupPlan(env, {
    rule: plan.rule,
    cursor: plan.scan?.cursor,
    includeSampleTitles: Object.hasOwn(plan.groups?.[0] || {}, "sample_titles"),
    limit: plan.scan?.limit ?? MAX_PAGE,
    now,
  });
  if (current.fingerprint !== plan.fingerprint) {
    throw cleanupError("cleanup_plan_changed", "The cleanup plan changed. Review the new fingerprint before approving it.", {
      current_fingerprint: current.fingerprint,
    });
  }
  const dryRun = await forget(env, { docUids: current.targets, dryRun: true });
  const safeDryRun = {
    documents: dryRun.documents,
    chunks: dryRun.chunks,
    expected_vector_deletes: dryRun.vectors,
    dry_run: true,
    targets: dryRun.targets,
  };
  if (!confirm) {
    return {
      applied: false,
      approval_required: true,
      fingerprint: current.fingerprint,
      dry_run: safeDryRun,
      before: await cleanupTotals(env),
    };
  }
  if (!approvalFingerprint || approvalFingerprint !== current.fingerprint) {
    throw cleanupError("cleanup_fingerprint_not_approved", "Approve the exact current cleanup fingerprint before applying it.");
  }
  throw cleanupError(
    "cleanup_apply_unavailable",
    "Cleanup removal is unavailable until exact boundary checks, location preservation, and deletion are one atomic guarded mutation.",
  );
}

/** Return a new manifest object; persistence remains an explicit local CLI step. */
export { cleanupLocationReferences } from "./cleanup-location-references.js";
