import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLoadPreview,
  renderLoadPreviewSummary,
  writeLoadPreviewDetail,
} from "../ingest/load-preview.mjs";
import { cmdIngestLocal } from "../brain.mjs";

const preview = createLoadPreview({ source: "upload", vectorsPerMinute: 60 });
const candidates = [
  { rel: "records/current/report.txt", name: "report.txt", size: 1800 },
  { rel: "records/archive/copy.txt", name: "copy.txt", size: 1800 },
  { rel: "exports/system-export.json", name: "system-export.json", size: 2_000_000 },
  { rel: "logs/service.log", name: "service.log", size: 900_000 },
];
for (const file of candidates) preview.observeCandidate(file);

const useful = "A reviewed record with useful facts, dates, decisions, and enough detail for retrieval. ".repeat(40);
preview.observePrepared(candidates[0], { envelope: { content: useful } });
preview.observePrepared(candidates[1], { envelope: { content: useful.replace(/\n/g, "\r\n") } });
preview.observePrepared(candidates[2], { envelope: { content: "field,value\n".repeat(40_000) } });
preview.observePrepared(candidates[3], {
  skip: { reason: "the extraction is mostly symbols with too little readable text", metrics: { symbol_ratio: 0.91 } },
});
preview.observeWalkSkip({
  path: "build",
  scope: "subtree",
  reason_code: "likely_junk_build_or_cache",
  reason: "build or cache folder is excluded",
});

const report = preview.finish();
assert.equal(report.summary.files.total, 4);
assert.equal(report.summary.files.by_type[".txt"].count, 2);
assert.equal(report.summary.quality_refusals.total, 1);
assert.equal(report.summary.exact_duplicates.groups, 1);
assert.equal(report.summary.exact_duplicates.extra_locations, 1);
assert.ok(report.summary.estimate.chunks > 100);
assert.equal(report.summary.estimate.vectors, report.summary.estimate.chunks);
assert.ok(report.summary.estimate.minutes_at_measured_rate > 0);
assert.ok(report.summary.likely_junk.by_class.log_file >= 1);
assert.ok(report.summary.likely_junk.by_class.huge_structured_dump >= 1);
assert.ok(report.summary.likely_junk.by_class.build_or_cache_folder >= 1);
assert.equal(report.summary.already_in_brain.observable, false);

const rendered = renderLoadPreviewSummary(report.summary);
assert.match(rendered, /LOAD PREVIEW/);
assert.match(rendered, /exact duplicate/i);
assert.match(rendered, /quality refusal/i);
assert.match(rendered, /mostly symbols with too little readable text: 1/i);
assert.match(rendered, /size bands/i);
assert.match(rendered, /heaviest folders:.*records:/i);
assert.doesNotMatch(rendered, /records\/current|system-export|service\.log/);

const sandbox = mkdtempSync(join(tmpdir(), "brain-load-preview-"));
try {
  const output = join(sandbox, "preview.json");
  writeLoadPreviewDetail(output, report);
  const saved = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(saved.contract_version, 1);
  assert.equal(saved.detail.files.length, 4);
  assert.ok(saved.detail.duplicate_groups[0].locations.includes("records/current/report.txt"));
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => writeLoadPreviewDetail(output, report), /already exists/);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const cliSandbox = mkdtempSync(join(tmpdir(), "brain-load-preview-cli-"));
try {
  const root = join(cliSandbox, "source");
  const manifestDir = join(cliSandbox, "install");
  mkdirSync(root, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const detailPath = join(cliSandbox, "private-preview.json");
  const manifest = {
    client: { slug: "fixture-client" },
    brain: { domain: "fixture.invalid" },
    safety: { text_quality: { sources: { upload: { min_word_like_ratio: 0.08 } } } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(root, "first-record.txt"), useful);
  writeFileSync(join(root, "second-record.txt"), useful);
  writeFileSync(join(root, "symbol-input.txt"), Array.from({ length: 240 }, (_, i) => `${i % 10} @@@ ### %%% ||| <>`).join(" "));

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  let result;
  try {
    result = await cmdIngestLocal(manifest, manifestPath, {
      path: root,
      "dry-run": true,
      "preview-report": detailPath,
      "vectors-per-minute": "75",
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.dry_run, true);
  assert.equal(result.load_preview.exact_duplicates.groups, 1);
  assert.equal(result.load_preview.quality_refusals.total, 1);
  assert.equal(result.load_preview.estimate.vectors_per_minute, 75);
  assert.doesNotMatch(lines.join("\n"), /first-record|second-record|symbol-input/);
  const cliDetail = JSON.parse(readFileSync(detailPath, "utf8"));
  assert.equal(cliDetail.detail.files.length, 3);
} finally {
  rmSync(cliSandbox, { recursive: true, force: true });
}

console.log("load-preview: all 34 assertions passed");
