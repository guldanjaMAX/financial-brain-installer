/** Aggregate-only load planning. Private paths live only in the optional local detail file. */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fsyncSync,
  linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { refusalReasonCategory } from "./refusal-reasons.mjs";
import { QUALITY_FLAG_REASONS } from "./quality.mjs";

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 300;
const DEFAULT_MEASURED_VECTORS_PER_MINUTE = 60;
const MAX_AGGREGATE_BUCKETS = 128;

const countIn = (object, key, amount = 1) => {
  object[key] = (object[key] || 0) + amount;
};

const boundedBucket = (object, key, create) => {
  if (Object.hasOwn(object, key)) return object[key];
  const names = Object.keys(object).filter((name) => name !== "(other)");
  const bucket = names.length < MAX_AGGREGATE_BUCKETS ? key : "(other)";
  return object[bucket] ||= create();
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
  detailPath = null,
} = {}) {
  const detail = detailPath ? createDetailSpool(detailPath) : null;
  const hashes = new Map();
  const byType = Object.create(null);
  const bySize = Object.create(null);
  const byFolder = Object.create(null);
  const refusalReasons = Object.create(null);
  const qualityFlagReasons = Object.create(null);
  const junkCounts = Object.create(null);
  let files = 0;
  let refusalCount = 0;
  let qualityFlagDocuments = 0;
  let qualityFlagSignals = 0;
  let junkCount = 0;
  let bytes = 0;
  let chunks = 0;
  let alreadyLoaded = 0;
  let occurrence = 0;

  const observeCandidate = (file) => {
    const entry = {
      path: String(file?.rel || file?.path || ""),
      type: typeOf(file),
      folder: folderOf(file),
      bytes: Math.max(0, Number(file?.size || 0)),
      estimated_chunks: 0,
      likely_junk: [],
    };
    files++;
    bytes += entry.bytes;
    const typed = boundedBucket(byType, entry.type, () => ({ count: 0, bytes: 0, estimated_chunks: 0 }));
    typed.count++;
    typed.bytes += entry.bytes;
    countIn(bySize, sizeBand(entry.bytes));
    const folder = boundedBucket(byFolder, entry.folder, () => ({ files: 0, bytes: 0, estimated_chunks: 0 }));
    folder.files++;
    folder.bytes += entry.bytes;
    entry.likely_junk = junkClasses(file);
    detail?.write("files", entry);
    for (const classification of entry.likely_junk) {
      junkCount++;
      countIn(junkCounts, classification);
      detail?.write("likely_junk", { path: entry.path, class: classification });
    }
  };

  const observePrepared = (file, prepared) => {
    const path = String(file?.rel || file?.path || "");
    if (prepared?.skip) {
      const refusal = { path, reason: String(prepared.skip.reason || "refused"), metrics: prepared.skip.metrics || null };
      refusalCount++;
      countIn(refusalReasons, refusalReasonCategory(refusal.reason));
      detail?.write("quality_refusals", refusal);
      return;
    }
    const qualityFlags = Array.isArray(prepared?.quality_flags)
      ? prepared.quality_flags
        .filter((flag) => typeof flag?.code === "string" && Object.hasOwn(QUALITY_FLAG_REASONS, flag.code))
        .map((flag) => ({ code: flag.code, reason: QUALITY_FLAG_REASONS[flag.code] }))
      : [];
    if (qualityFlags.length) {
      qualityFlagDocuments++;
      qualityFlagSignals += qualityFlags.length;
      for (const flag of qualityFlags) countIn(qualityFlagReasons, flag.reason);
      detail?.write("quality_review_flags", { path, flags: qualityFlags });
    }
    const envelopes = prepared?.envelopes || (prepared?.envelope ? [prepared.envelope] : []);
    let fileChunks = 0;
    for (const envelope of envelopes) {
      const content = String(envelope?.content || "");
      const estimated = estimatedChunkCount(content);
      fileChunks += estimated;
      const hash = normalizedTextHash(content);
      hashes.set(hash, (hashes.get(hash) || 0) + 1);
      detail?.write("content_occurrences", { occurrence: ++occurrence, hash, path });
      if (existingContentHashes instanceof Set && existingContentHashes.has(hash)) alreadyLoaded++;
    }
    chunks += fileChunks;
    const type = typeOf(file);
    const folder = folderOf(file);
    boundedBucket(byType, type, () => ({ count: 0, bytes: 0, estimated_chunks: 0 })).estimated_chunks += fileChunks;
    boundedBucket(byFolder, folder, () => ({ files: 0, bytes: 0, estimated_chunks: 0 })).estimated_chunks += fileChunks;
    const initialJunk = new Set(junkClasses(file));
    for (const classification of junkClasses(file, fileChunks)) {
      if (initialJunk.has(classification)) continue;
      junkCount++;
      countIn(junkCounts, classification);
      detail?.write("likely_junk", { path, class: classification });
    }
  };

  const observeWalkSkip = (skip) => {
    let classification = String(skip?.reason_code || "").startsWith("likely_junk_")
      ? String(skip.reason_code).slice("likely_junk_".length)
      : null;
    if (classification === "build_or_cache") classification = "build_or_cache_folder";
    if (classification) {
      junkCount++;
      countIn(junkCounts, classification);
      detail?.write("likely_junk", { path: String(skip?.path || ""), class: classification });
    }
  };

  const finish = () => {
    let duplicateGroups = 0;
    let duplicateExtras = 0;
    for (const count of hashes.values()) {
      if (count < 2) continue;
      duplicateGroups++;
      duplicateExtras += count - 1;
    }
    const rate = Number(vectorsPerMinute);
    const measuredRate = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_MEASURED_VECTORS_PER_MINUTE;
    const topFolders = Object.entries(byFolder)
      .map(([folder, values]) => ({ folder, ...values }))
      .sort((a, b) => b.estimated_chunks - a.estimated_chunks || b.bytes - a.bytes || a.folder.localeCompare(b.folder))
      .slice(0, 10);
    const report = {
      contract_version: 1,
      kind: "load_preview",
      source: String(source || "unknown"),
      summary: {
        files: { total: files, bytes, by_type: byType, by_size: bySize },
        quality_refusals: { total: refusalCount, by_reason: refusalReasons },
        quality_review_flags: {
          documents: qualityFlagDocuments,
          signals: qualityFlagSignals,
          by_reason: qualityFlagReasons,
        },
        exact_duplicates: {
          groups: duplicateGroups,
          extra_locations: duplicateExtras,
        },
        already_in_brain: existingContentHashes instanceof Set
          ? { observable: true, matches: alreadyLoaded }
          : { observable: false, reason: "dry-run does not contact the Brain and legacy checkpoints do not store normalized text hashes" },
        cross_source_duplicates: {
          observable: false,
          reason: "cross-source content hashes are not exposed by the current read-only inventory contract",
        },
        likely_junk: { total: junkCount, by_class: junkCounts },
        estimate: {
          chunks,
          vectors: chunks,
          vectors_per_minute: measuredRate,
          minutes_at_measured_rate: chunks ? +(chunks / measuredRate).toFixed(1) : 0,
          rate_basis: "reference measured drain rate; override with --vectors-per-minute after measuring this Brain",
        },
        top_heaviest_folders: topFolders,
      },
    };
    detail?.finish(report);
    return report;
  };

  return { observeCandidate, observePrepared, observeWalkSkip, finish };
}

const DETAIL_SECTIONS = [
  "files", "quality_refusals", "quality_review_flags", "content_occurrences", "likely_junk",
];

function createDetailSpool(destination) {
  const path = String(destination || "");
  const parent = dirname(path);
  const parentIdentity = lstatSync(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    throw new Error("the preview detail directory must be a real directory, not a link");
  }
  if (existsSync(path)) throw new Error(`the preview detail file already exists: ${path}`);
  const nonce = randomBytes(12).toString("hex");
  const spools = new Map();
  let finished = false;
  for (const section of DETAIL_SECTIONS) {
    const spoolPath = join(parent, `.${basename(path)}.${nonce}.${section}.tmp`);
    const fd = openSync(spoolPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600);
    spools.set(section, { path: spoolPath, fd, entries: 0 });
  }

  const cleanup = () => {
    for (const spool of spools.values()) {
      if (spool.fd !== null) {
        try { closeSync(spool.fd); } catch { /* cleanup continues */ }
        spool.fd = null;
      }
      try { unlinkSync(spool.path); } catch { /* cleanup continues */ }
    }
  };
  const appendFile = (targetFd, sourcePath) => {
    const sourceFd = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      for (;;) {
        const bytes = readSync(sourceFd, buffer, 0, buffer.length, null);
        if (!bytes) break;
        writeSync(targetFd, buffer, 0, bytes);
      }
    } finally {
      closeSync(sourceFd);
    }
  };

  return {
    write(section, value) {
      if (finished) throw new Error("the preview detail stream is already finalized");
      const spool = spools.get(section);
      if (!spool) throw new Error("unknown preview detail section");
      writeSync(spool.fd, `${spool.entries++ ? "," : ""}${JSON.stringify(value)}`);
    },
    finish(report) {
      if (finished) throw new Error("the preview detail stream is already finalized");
      finished = true;
      for (const spool of spools.values()) {
        fsyncSync(spool.fd);
        closeSync(spool.fd);
        spool.fd = null;
      }
      const finalTemp = join(parent, `.${basename(path)}.${nonce}.final.tmp`);
      let finalFd = null;
      try {
        finalFd = openSync(finalTemp,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
          0o600);
        const header = {
          contract_version: report.contract_version,
          kind: report.kind,
          source: report.source,
          summary: report.summary,
        };
        writeSync(finalFd, `${JSON.stringify(header).slice(0, -1)},"detail":{`);
        DETAIL_SECTIONS.forEach((section, index) => {
          writeSync(finalFd, `${index ? "," : ""}${JSON.stringify(section)}:[`);
          appendFile(finalFd, spools.get(section).path);
          writeSync(finalFd, "]");
        });
        writeSync(finalFd, "}}\n");
        fsyncSync(finalFd);
        closeSync(finalFd);
        finalFd = null;
        chmodSync(finalTemp, 0o600);
        try {
          linkSync(finalTemp, path);
        } catch (error) {
          if (error?.code === "EEXIST") throw new Error(`the preview detail file already exists: ${path}`);
          throw error;
        }
      } finally {
        if (finalFd !== null) {
          try { closeSync(finalFd); } catch { /* cleanup continues */ }
        }
        try { unlinkSync(finalTemp); } catch { /* cleanup continues */ }
        cleanup();
      }
      return path;
    },
  };
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
  const qualityFlags = Object.entries(summary.quality_review_flags?.by_reason || {})
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
    `  Quality review flags: ${summary.quality_review_flags?.documents || 0} document(s), ` +
      `${summary.quality_review_flags?.signals || 0} signal(s); reasons: ${qualityFlags}`,
    `  Exact duplicate groups: ${summary.exact_duplicates.groups}; extra locations: ${summary.exact_duplicates.extra_locations}`,
    `  Likely junk: ${junk}`,
    `  Heaviest folders: ${folders}`,
    `  Estimated chunks/vectors: ${summary.estimate.chunks}; about ${summary.estimate.minutes_at_measured_rate} minute(s) at ${summary.estimate.vectors_per_minute}/min`,
    `  Already in this Brain: ${summary.already_in_brain.observable ? summary.already_in_brain.matches : "not observable without a read-only hash comparison"}`,
    `  Cross-source duplicates: ${summary.cross_source_duplicates.observable ? "reported" : "not observable from current inventory"}`,
  ].join("\n");
}

export function writeLoadPreviewDetail(path, report) {
  if (!report?.detail) {
    throw new Error("preview detail must be requested before scanning so file-level data can be streamed safely");
  }
  try {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`the preview detail file already exists: ${path}`);
    throw error;
  }
  return path;
}
