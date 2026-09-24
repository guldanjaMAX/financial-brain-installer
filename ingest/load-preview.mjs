/** Aggregate-only load planning. Private paths live only in the optional local detail file. */

import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { refusalReasonCategory } from "./refusal-reasons.mjs";

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 300;
const DEFAULT_MEASURED_VECTORS_PER_MINUTE = 60;

const countIn = (object, key, amount = 1) => {
  object[key] = (object[key] || 0) + amount;
};

const typeOf = (file) => String(file?.type || "").trim() ||
  extname(String(file?.name || file?.rel || "")).toLowerCase() || "(no extension)";
const folderOf = (file) => {
  if (String(file?.folder || "").trim()) return String(file.folder).trim();
  const path = String(file?.rel || "").replace(/\\/g, "/");
  const parent = dirname(path).replace(/\\/g, "/");
  return parent === "." ? "(root)" : parent.split("/")[0];
};
const sizeBand = (bytes) => bytes < 100_000 ? "under 100 KB"
  : bytes < 1_000_000 ? "100 KB to 1 MB"
    : bytes < 8_000_000 ? "1 MB to 8 MB"
      : "8 MB or more";

export function normalizeTextForDedupe(text) {
  return String(text || "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

export function normalizedTextHash(text) {
  return createHash("sha256").update(normalizeTextForDedupe(text)).digest("hex");
}

export function estimatedChunkCount(text) {
  const length = String(text || "").length;
  if (!length) return 0;
  if (length <= CHUNK_SIZE) return 1;
  return 1 + Math.ceil((length - CHUNK_SIZE) / (CHUNK_SIZE - CHUNK_OVERLAP));
}

function junkClasses(file, chunks = 0) {
  const rel = String(file?.rel || file?.path || "").replace(/\\/g, "/").toLowerCase();
  const name = basename(rel);
  const ext = extname(name);
  const size = Number(file?.size || 0);
  const found = new Set();
  if (/(^|\/)(?:node_modules|dist|build|\.next|\.cache|__pycache__|venv)(\/|$)/.test(rel)) {
    found.add("build_or_cache_folder");
  }
  if (ext === ".log") found.add("log_file");
  if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|gemfile\.lock)$/.test(name)) {
    found.add("lockfile");
  }
  if (/^(?:thumbs\.db|desktop\.ini|\.ds_store)$/.test(name) || /(?:^|[-_.])thumb(?:nail)?s?[-_.]/.test(name)) {
    found.add("thumbnail_or_bookkeeping");
  }
  if (/(?:^|[-_.])(?:export|generated|dump|backup)(?:[-_.]|$)/.test(name)) found.add("generated_export");
  if ([".csv", ".tsv", ".json", ".jsonl", ".log"].includes(ext) && (size >= 1_000_000 || chunks >= 500)) {
    found.add("huge_structured_dump");
  }
  return [...found].sort();
}

export function createLoadPreview({
  source,
  vectorsPerMinute = DEFAULT_MEASURED_VECTORS_PER_MINUTE,
  existingContentHashes = null,
} = {}) {
  const files = [];
  const filesByPath = new Map();
  const refusals = [];
  const junk = [];
  const hashes = new Map();
  const byType = {};
  const bySize = {};
  const byFolder = {};
  let bytes = 0;
  let chunks = 0;
  let alreadyLoaded = 0;

  const observeCandidate = (file) => {
    const entry = {
      path: String(file?.rel || file?.path || ""),
      type: typeOf(file),
      folder: folderOf(file),
      bytes: Math.max(0, Number(file?.size || 0)),
      estimated_chunks: 0,
      likely_junk: [],
    };
    files.push(entry);
    const entries = filesByPath.get(entry.path) || [];
    entries.push(entry);
    filesByPath.set(entry.path, entries);
    bytes += entry.bytes;
    const typed = byType[entry.type] ||= { count: 0, bytes: 0, estimated_chunks: 0 };
    typed.count++;
    typed.bytes += entry.bytes;
    countIn(bySize, sizeBand(entry.bytes));
    const folder = byFolder[entry.folder] ||= { files: 0, bytes: 0, estimated_chunks: 0 };
    folder.files++;
    folder.bytes += entry.bytes;
    entry.likely_junk = junkClasses(file);
    for (const classification of entry.likely_junk) junk.push({ path: entry.path, class: classification });
  };

  const observePrepared = (file, prepared) => {
    const path = String(file?.rel || file?.path || "");
    // A provider can expose the same display path more than once. Consume its
    // candidate entries in observation order without rescanning the corpus.
    const pathEntries = filesByPath.get(path) || [];
    const entry = pathEntries.shift() || null;
    if (prepared?.skip) {
      refusals.push({ path, reason: String(prepared.skip.reason || "refused"), metrics: prepared.skip.metrics || null });
      return;
    }
    const envelopes = prepared?.envelopes || (prepared?.envelope ? [prepared.envelope] : []);
    let fileChunks = 0;
    for (const envelope of envelopes) {
      const content = String(envelope?.content || "");
      const estimated = estimatedChunkCount(content);
      fileChunks += estimated;
      const hash = normalizedTextHash(content);
      const locations = hashes.get(hash) || [];
      locations.push(path);
      hashes.set(hash, locations);
      if (existingContentHashes instanceof Set && existingContentHashes.has(hash)) alreadyLoaded++;
    }
    chunks += fileChunks;
    if (entry) {
      entry.estimated_chunks = fileChunks;
      byType[entry.type].estimated_chunks += fileChunks;
      byFolder[entry.folder].estimated_chunks += fileChunks;
      const addedJunk = junkClasses(file, fileChunks).filter((classification) => !entry.likely_junk.includes(classification));
      entry.likely_junk.push(...addedJunk);
      for (const classification of addedJunk) junk.push({ path: entry.path, class: classification });
    }
  };

  const observeWalkSkip = (skip) => {
    let classification = String(skip?.reason_code || "").startsWith("likely_junk_")
      ? String(skip.reason_code).slice("likely_junk_".length)
      : null;
    if (classification === "build_or_cache") classification = "build_or_cache_folder";
    if (classification) junk.push({ path: String(skip?.path || ""), class: classification });
  };

  const finish = () => {
    const duplicateGroups = [...hashes]
      .filter(([, locations]) => new Set(locations).size > 1)
      .map(([hash, locations]) => ({ hash, locations: [...new Set(locations)].sort() }))
      .sort((left, right) => right.locations.length - left.locations.length || left.hash.localeCompare(right.hash));
    const refusalReasons = {};
    for (const refusal of refusals) countIn(refusalReasons, refusalReasonCategory(refusal.reason));
    const junkCounts = {};
    for (const item of junk) countIn(junkCounts, item.class);
    const rate = Number(vectorsPerMinute);
    const measuredRate = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_MEASURED_VECTORS_PER_MINUTE;
    const topFolders = Object.entries(byFolder)
      .map(([folder, values]) => ({ folder, ...values }))
      .sort((a, b) => b.estimated_chunks - a.estimated_chunks || b.bytes - a.bytes || a.folder.localeCompare(b.folder))
      .slice(0, 10);
    return {
      contract_version: 1,
      kind: "load_preview",
      source: String(source || "unknown"),
      summary: {
        files: { total: files.length, bytes, by_type: byType, by_size: bySize },
        quality_refusals: { total: refusals.length, by_reason: refusalReasons },
        exact_duplicates: {
          groups: duplicateGroups.length,
          extra_locations: duplicateGroups.reduce((sum, group) => sum + group.locations.length - 1, 0),
        },
        already_in_brain: existingContentHashes instanceof Set
          ? { observable: true, matches: alreadyLoaded }
          : { observable: false, reason: "dry-run does not contact the Brain and legacy checkpoints do not store normalized text hashes" },
        cross_source_duplicates: {
          observable: false,
          reason: "cross-source content hashes are not exposed by the current read-only inventory contract",
        },
        likely_junk: { total: junk.length, by_class: junkCounts },
        estimate: {
          chunks,
          vectors: chunks,
          vectors_per_minute: measuredRate,
          minutes_at_measured_rate: chunks ? +(chunks / measuredRate).toFixed(1) : 0,
          rate_basis: "reference measured drain rate; override with --vectors-per-minute after measuring this Brain",
        },
        top_heaviest_folders: topFolders,
      },
      detail: {
        files: files.map((entry) => ({ ...entry, likely_junk: [...entry.likely_junk].sort() })),
        quality_refusals: refusals,
        duplicate_groups: duplicateGroups,
        likely_junk: junk,
      },
    };
  };

  return { observeCandidate, observePrepared, observeWalkSkip, finish };
}

export function renderLoadPreviewSummary(summary) {
  const types = Object.entries(summary.files.by_type)
    .sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([type, value]) => `${type}: ${value.count}`)
    .join(", ") || "none";
  const junk = Object.entries(summary.likely_junk.by_class)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind.replaceAll("_", " ")}: ${count}`)
    .join(", ") || "none";
  const sizes = Object.entries(summary.files.by_size)
    .map(([band, count]) => `${band}: ${count}`)
    .join(", ") || "none";
  const refusals = Object.entries(summary.quality_refusals.by_reason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ") || "none";
  const folders = summary.top_heaviest_folders
    .map((folder) => `${folder.folder}: ${folder.files} file(s), ${folder.bytes} bytes, ${folder.estimated_chunks} chunk(s)`)
    .join("; ") || "none";
  return [
    "  LOAD PREVIEW, nothing was sent",
    `  Files: ${summary.files.total}; bytes: ${summary.files.bytes}; types: ${types}`,
    `  Size bands: ${sizes}`,
    `  Quality refusals: ${summary.quality_refusals.total}; reasons: ${refusals}`,
    `  Exact duplicate groups: ${summary.exact_duplicates.groups}; extra locations: ${summary.exact_duplicates.extra_locations}`,
    `  Likely junk: ${junk}`,
    `  Heaviest folders: ${folders}`,
    `  Estimated chunks/vectors: ${summary.estimate.chunks}; about ${summary.estimate.minutes_at_measured_rate} minute(s) at ${summary.estimate.vectors_per_minute}/min`,
    `  Already in this Brain: ${summary.already_in_brain.observable ? summary.already_in_brain.matches : "not observable without a read-only hash comparison"}`,
    `  Cross-source duplicates: ${summary.cross_source_duplicates.observable ? "reported" : "not observable from current inventory"}`,
  ].join("\n");
}

export function writeLoadPreviewDetail(path, report) {
  try {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`the preview detail file already exists: ${path}`);
    throw error;
  }
  return path;
}
