import assert from "node:assert/strict";
import { buildLoadQualityReport, renderLoadQualityReport } from "../ingest/load-report.mjs";
import { cmdLoadReport } from "../brain.mjs";

const report = buildLoadQualityReport({
  inventory: {
    as_of: "2026-09-24T20:00:00.000Z",
    sources: [
      {
        name: "drive",
        receipt: {
          latest_run: {
            outcome: "complete",
            metrics_version: 1,
            files_seen: 20,
            docs_added: 12,
            docs_updated: 2,
            docs_unchanged: 4,
            docs_refused: 1,
            docs_failed: 1,
          },
        },
      },
    ],
  },
  diagnosis: {
    complete: true,
    findings: [
      { id: "duplicate_documents", count: 7, detail: "three exact-content groups" },
      { id: "chunk_outliers", observable: false, detail: "bounded at this scale" },
    ],
  },
  checkpointSkips: {
    drive: {
      "opaque-1": "the extraction is mostly symbols with too little readable text",
      "opaque-2": "file is 9.0MB, over the 8MB limit",
      "opaque-3": "failed: private-folder/private-file.txt could not be opened",
    },
  },
});

assert.equal(report.contract_version, 1);
assert.equal(report.sources[0].accepted, 18);
assert.equal(report.sources[0].refused, 1);
assert.equal(report.sources[0].failed, 1);
assert.equal(report.duplicates.extra_documents, 7);
assert.equal(report.too_large, 1);
assert.equal(report.refusal_reasons["mostly symbols with too little readable text"], 1);
assert.equal(report.refusal_reasons["ingest failed"], 1);
assert.equal(report.chunk_outliers.observable, false);

const rendered = renderLoadQualityReport(report);
assert.match(rendered, /AFTER-LOAD QUALITY REPORT/);
assert.match(rendered, /drive.*18 accepted.*1 refused.*1 failed/i);
assert.match(rendered, /7 duplicate document/i);
assert.match(rendered, /1 too large/i);
assert.doesNotMatch(rendered, /opaque-1|opaque-2/);
assert.doesNotMatch(rendered, /private-folder|private-file/);

const lines = [];
const originalLog = console.log;
console.log = (...args) => lines.push(args.map(String).join(" "));
try {
  const commandReport = await cmdLoadReport("fixture.manifest.json", {
    flags: {},
    inventory: {
      complete: true,
      as_of: "2026-09-24T20:00:00.000Z",
      sources: [{ name: "upload", receipt: { latest_run: {
        outcome: "complete", metrics_version: 1, files_seen: 4,
        docs_added: 3, docs_updated: 0, docs_unchanged: 0, docs_refused: 1, docs_failed: 0,
      } } }],
    },
    diagnosis: { complete: true, findings: [] },
    checkpointSkips: { upload: { "private-file-id": "file is 9.0MB, over the 8MB limit" } },
  });
  assert.equal(commandReport.sources[0].accepted, 3);
  assert.match(lines.join("\n"), /AFTER-LOAD QUALITY REPORT/);
  assert.doesNotMatch(lines.join("\n"), /private-file-id/);
} finally {
  console.log = originalLog;
}

console.log("load-report: all 18 assertions passed");
