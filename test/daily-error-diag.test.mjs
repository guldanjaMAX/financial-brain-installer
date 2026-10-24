import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dailyErrorContext, runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { DAILY_ISSUE_MESSAGES } from "../operations/daily-refresh-messages.mjs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";
import { dailyObservationStatus } from "../operations/daily-refresh-observation.mjs";
import { DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";
import { SourceIngestLockError } from "../operations/source-ingest-lock.mjs";

// Each failing source is paired with a later clean leg. Real receipt/log writers
// run only in this synthetic home; scheduler, credentials and providers are absent.
async function observe(error) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-error-diag-")));
  try {
    const manifestPath = join(home, "brain.manifest.json");
    writeFileSync(manifestPath, "{}\n");
    const plan = {
      ready: true, enabled: true, identity: { id: "v1-diag" }, manifest_path: manifestPath,
      sources: ["mail", "control"].map(key => ({
        key, run_key: key, source_names: [key], class: "machine-pull", owner: "daily-task", status: "ready",
      })),
    };
    const calls = [];
    let reads = 0;
    let releases = 0;
    const result = await runDailyRefreshCli(manifestPath, {
      brainModule: {}, buildPlan: async () => plan,
      acquireLock: () => ({ assertOwned() {}, release() { releases++; } }),
      runSource: async source => {
        calls.push(source.key);
        if (source.key === "mail" && error) throw error;
        return { status: "complete" };
      },
      readFreshness: async () => {
        const at = reads++ === 0 ? "2026-10-22T12:00:00.000Z" : "2026-10-23T12:00:00.000Z";
        return Object.fromEntries(["mail", "control"].map(key => [key, { last_successful_run_at: at }]));
      },
      now: () => new Date("2026-10-23T12:01:00.000Z"),
      readUpdateTransaction: () => null, home, platform: "darwin", silent: true,
    });
    assert.deepEqual(calls, ["mail", "control"], "both the failure boundary and clean control ran");
    assert.equal(releases, 1);
    assert.equal(result.sources[1].status, "complete", "a later clean source still completes");
    assert.equal(result.sources[1].freshness_advanced, true);
    const receiptText = readFileSync(join(home, ".brain", "daily-receipts", "v1-diag.json"), "utf8");
    assert.deepEqual(JSON.parse(receiptText), result);
    const logText = readFileSync(join(home, ".brain", "logs", "v1-diag", "daily.log"), "utf8");
    const failures = logText.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.kind === "source_failure");
    const status = dailyObservationStatus(plan, {}, {}, true, { home, platform: "darwin" });
    if (error) {
      assert.equal(result.status, "failed");
      assert.equal(result.sources[0].status, "failed");
      assert.equal(result.sources[0].freshness_advanced, false);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].issue_code, result.sources[0].issue_code);
      assert.equal(failures[0].detail, result.sources[0].detail);
      assert.equal(status.source_issues[0].detail, result.sources[0].detail);
      assert.ok(failures[0].detail.length > 0 && failures[0].detail.length <= 200);
      assert.equal(/[\r\n\u0000-\u001f\u007f]/u.test(failures[0].detail), false);
    }
    return { result, source: result.sources[0], failures, receiptText, logText };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("daily diagnostics clean source control remains complete without an issue", async () => {
  const { result, source, failures } = await observe(null);
  assert.equal(result.status, "complete");
  assert.equal(source.status, "complete");
  assert.equal(source.issue_code, undefined);
  assert.equal(source.detail, undefined);
  assert.equal(failures.length, 0);
});

test("daily diagnostics fixed message replaces harmless provider prose control", async () => {
  const { source, failures } = await observe(Object.assign(new Error("The connection closed while reading."), {
    code: "NETWORK_UNREACHABLE",
  }));
  const message = "The source could not be reached; it will retry on the next run.";
  assert.equal(source.detail === message, true, "receipt uses the fixed network message");
  assert.equal(failures[0].detail === message, true, "log uses the fixed network message");
});

test("daily diagnostics fixed message excludes mixed private provider text", async () => {
  const marker = randomUUID();
  const path = `reports/quarterly ${marker}.xlsx`;
  const credential = ["access", "token"].join("_") + "=" + marker;
  const url = `https://provider.invalid/${marker}?cursor=private`;
  for (const suffix of [": access denied", " during import"]) {
    const error = Object.assign(new Error(`${path}${suffix}; ${credential}; ${url}`), { code: "NETWORK_UNREACHABLE" });
    const { source, receiptText, logText } = await observe(error);
    assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
    for (const text of [receiptText, logText]) {
      for (const value of [marker, path, credential, url, "quarterly", "during import", "access denied"]) {
        assert.equal(text.includes(value), false, "provider text must never be persisted");
      }
    }
    assert.equal(source.detail === "The source could not be reached; it will retry on the next run.", true);
  }
});

test("daily diagnostics message table covers every classifier code exactly once", () => {
  const codes = [...SUPPORT_ERROR_CODES, "UNKNOWN"].sort();
  assert.deepEqual(Object.keys(DAILY_ISSUE_MESSAGES).sort(), codes);
  const tableSource = readFileSync(new URL("../operations/daily-refresh-messages.mjs", import.meta.url), "utf8");
  const declaredKeys = [...tableSource.matchAll(/^  ([A-Z][A-Z0-9_]*):/gmu)].map(match => match[1]);
  assert.deepEqual(declaredKeys.sort(), codes, "duplicate object keys must not silently replace a message");
  const runnerSource = readFileSync(new URL("../operations/daily-refresh-run.mjs", import.meta.url), "utf8")
    .replace(/\r\n/gu, "\n");
  const classifier = runnerSource.match(/function dailyIssueCode\(error\) \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(classifier, "the classifier contract must be inspected when it changes");
  for (const [, code] of classifier.matchAll(/return "([A-Z][A-Z0-9_]*)"/gu)) {
    assert.equal(Object.hasOwn(DAILY_ISSUE_MESSAGES, code), true, "every literal classifier return needs a message");
  }
  assert.equal(Object.isFrozen(DAILY_ISSUE_MESSAGES), true);
  for (const message of Object.values(DAILY_ISSUE_MESSAGES)) {
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0 && message.length <= 200);
    assert.equal(/[\u0000-\u001f\u007f\u2014]/u.test(message), false);
  }
});

for (const code of [...SUPPORT_ERROR_CODES, "UNKNOWN"]) {
  test(`daily diagnostics fixed mapping persists ${code}`, async () => {
    const error = Object.assign(new Error("The provider stopped with private prose."), { supportCode: code });
    const { source, failures } = await observe(error);
    assert.equal(source.issue_code, code);
    assert.equal(source.detail === DAILY_ISSUE_MESSAGES[code], true, "receipt stores only the fixed message");
    assert.equal(failures[0].detail === DAILY_ISSUE_MESSAGES[code], true, "log stores only the fixed message");
  });
}

test("daily diagnostics removal approval retains its named stop and safe reason", async () => {
  for (const error of [
    new DriveRemovalReviewRequired("A removal plan is waiting for approval."),
    Object.assign(new Error("A removal plan is waiting for approval."), { name: "DriveRemovalReviewRequired" }),
    Object.assign(new Error("A removal plan is waiting for approval."), { code: "removal_approval_required" }),
  ]) {
    const { source, result } = await observe(error);
    assert.equal(source.issue_code, "SAFETY_REVIEW_REQUIRED");
    assert.equal(source.reason_code, "removal_review_required");
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES.SAFETY_REVIEW_REQUIRED);
    assert.match(result.schedule_attention[0], /removal review/u);
  }
});

test("daily diagnostics safety review is distinct from a removal approval", async () => {
  const { source, result } = await observe(Object.assign(new Error("Source scope needs a safety review."), {
    code: "SAFETY_REVIEW_REQUIRED",
  }));
  assert.equal(source.issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(source.reason_code, "safety_review_required");
  assert.match(source.reason, /safety review/u);
  assert.equal(result.schedule_attention.some(text => /removal/u.test(text)), false);
  assert.equal(source.detail, DAILY_ISSUE_MESSAGES.SAFETY_REVIEW_REQUIRED);
});

test("daily diagnostics lock held uses a safe schedule issue and explicit stop reason", async () => {
  for (const error of [
    new SourceIngestLockError("The source lock is held by another refresh.", { code: "source_ingest_already_running" }),
    Object.assign(new Error("The lifecycle lock is held."), { code: "brain_lifecycle_busy" }),
  ]) {
    const { source } = await observe(error);
    assert.equal(source.issue_code, "SCHEDULE_RUN_FAILED");
    assert.equal(source.reason_code, "source_lock_held");
    assert.match(source.reason, /lock/u);
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES.SCHEDULE_RUN_FAILED);
  }
});

test("daily diagnostics network failure recognizes fetch messages and nested transport codes", async () => {
  for (const error of [
    new TypeError("fetch failed"),
    new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }) }),
    Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  ]) {
    const { source } = await observe(error);
    assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
    assert.equal(source.reason_code, "network_unreachable");
    assert.match(source.reason, /network/u);
  }
});

test("daily diagnostics wrapper preserves the original stop and bounded multi-leg context", async () => {
  const review = new DriveRemovalReviewRequired("A removal plan is waiting for approval.");
  const { source } = await observe(new Error("One source did not load.", { cause: review }));
  assert.equal(source.issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(source.reason_code, "removal_review_required");
  assert.equal(source.detail, DAILY_ISSUE_MESSAGES.SAFETY_REVIEW_REQUIRED);

  const { source: multiple } = await observe(new Error("One source did not load.", {
    cause: new AggregateError([review, new TypeError("fetch failed")], "Source legs failed."),
  }));
  assert.equal(multiple.issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(multiple.detail, DAILY_ISSUE_MESSAGES.SAFETY_REVIEW_REQUIRED);
});

test("daily diagnostics network wrapper retains the transport reason", async () => {
  const transport = Object.assign(new Error("Connection reset while reading provider response."), { code: "ECONNRESET" });
  const { source } = await observe(new Error("One source did not load.", { cause: transport }));
  assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(source.detail, DAILY_ISSUE_MESSAGES.NETWORK_UNREACHABLE);
});

test("daily diagnostics aggregate unknown then network retains the recognized stop", async () => {
  const network = Object.assign(new Error("Connection reset while reading provider response."), { code: "ECONNRESET" });
  const { source } = await observe(new Error("One source did not load.", {
    cause: new AggregateError([new Error("Source stopped unexpectedly."), network], "Source legs failed."),
  }));
  assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(source.reason_code, "network_unreachable");
  assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
});

test("daily diagnostics aggregate unknown then lock retains the recognized stop", async () => {
  for (const code of ["source_ingest_already_running", "brain_lifecycle_busy", "LOCK_HELD"]) {
    const lock = Object.assign(new Error("The source lock is held by another refresh."), { code });
    const { source } = await observe(new AggregateError([
      new Error("Source stopped unexpectedly."), lock,
    ], "Source legs failed."));
    assert.equal(source.issue_code, "SCHEDULE_RUN_FAILED");
    assert.equal(source.reason_code, "source_lock_held");
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
  }
});

test("daily diagnostics nested aggregate unknown then network retains the leaf stop", async () => {
  const network = Object.assign(new Error("Connection reset while reading provider response."), { code: "ECONNRESET" });
  const { source } = await observe(new AggregateError([
    new Error("Source stopped unexpectedly."),
    new AggregateError([new Error("The provider stopped.", { cause: network })], "Source legs failed."),
  ], "Source legs failed."));
  assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(source.reason_code, "network_unreachable");
  assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
});

test("daily diagnostics nested aggregate unknown then lock retains the leaf stop", async () => {
  for (const code of ["source_ingest_already_running", "brain_lifecycle_busy", "LOCK_HELD"]) {
    const lock = Object.assign(new Error("The source lock is held by another refresh."), { code });
    const { source } = await observe(new AggregateError([
      new Error("Source stopped unexpectedly."),
      new AggregateError([new Error("The provider stopped.", { cause: lock })], "Source legs failed."),
    ], "Source legs failed."));
    assert.equal(source.issue_code, "SCHEDULE_RUN_FAILED");
    assert.equal(source.reason_code, "source_lock_held");
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
  }
});

test("daily diagnostics error graph handles cycles and aggregate causes", async () => {
  const network = Object.assign(new Error("Connection reset."), { code: "ECONNRESET" });
  const cycle = new Error("Source stopped unexpectedly.");
  cycle.cause = cycle;
  for (const error of [
    new AggregateError([cycle, new AggregateError([network], "Source legs failed.")], "Source legs failed."),
    new AggregateError([cycle], "Source legs failed.", { cause: network }),
  ]) {
    const { source } = await observe(error);
    assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
  }
});

test("daily diagnostics error graph retains typed safety wrappers and deeper transport detail", async () => {
  const network = Object.assign(new Error("Connection reset."), { code: "ECONNRESET" });
  const review = new DriveRemovalReviewRequired("A removal plan is waiting for approval.");
  review.cause = network;
  const { source: safety } = await observe(review);
  assert.equal(safety.reason_code, "removal_review_required");
  assert.equal(safety.detail, DAILY_ISSUE_MESSAGES.SAFETY_REVIEW_REQUIRED);
  assert.equal(dailyErrorContext(review).error, review);
  const { source: transport } = await observe(new TypeError("fetch failed", { cause: network }));
  assert.equal(transport.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(transport.detail, DAILY_ISSUE_MESSAGES.NETWORK_UNREACHABLE);
  assert.equal(dailyErrorContext(new TypeError("fetch failed", { cause: network })).error, network);
});

test("daily diagnostics error graph depth boundary has an in-bound control", async () => {
  for (const depth of [8, 9]) {
    let error = Object.assign(new Error("Connection reset."), { code: "ECONNRESET" });
    for (let index = 0; index < depth; index++) error = new Error("Source stopped unexpectedly.", { cause: error });
    const { source } = await observe(error);
    assert.equal(source.issue_code, depth === 8 ? "NETWORK_UNREACHABLE" : "UNKNOWN");
    assert.equal(dailyErrorContext(error).truncated, depth === 9);
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
  }
});

test("daily diagnostics error graph size boundary counts repeated references", async () => {
  const unknown = new Error("Source stopped unexpectedly.");
  for (const repeated of [false, true]) {
    for (const preceding of [62, 63]) {
      let causeReads = 0;
      const network = Object.assign(new Error("Connection reset."), { code: "ECONNRESET" });
      Object.defineProperty(network, "cause", { get() { causeReads++; return undefined; } });
      const entries = Array.from({ length: preceding }, () => repeated ? unknown : new Error(unknown.message));
      const { source } = await observe(new AggregateError([...entries, network], "Source legs failed."));
      assert.equal(source.issue_code, preceding === 62 ? "NETWORK_UNREACHABLE" : "UNKNOWN");
      assert.equal(causeReads > 0, preceding === 62, "out-of-budget entries must not be inspected");
      assert.equal(dailyErrorContext(new AggregateError([...entries, network])).truncated, preceding === 63);
      assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
    }
  }
});

test("daily diagnostics error graph shared leaf keeps the failed leg count", async () => {
  const network = Object.assign(new Error("Connection reset."), { code: "ECONNRESET" });
  const { source: single } = await observe(network);
  assert.equal(single.detail, DAILY_ISSUE_MESSAGES.NETWORK_UNREACHABLE);
  assert.equal(dailyErrorContext(network).failures, 1);
  const { source: multiple } = await observe(new AggregateError([network, network], "Source legs failed."));
  assert.equal(multiple.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(dailyErrorContext(new AggregateError([network, network])).failures, 2);
  assert.equal(multiple.detail, DAILY_ISSUE_MESSAGES.NETWORK_UNREACHABLE);
});

test("daily diagnostics aggregate priority is fixed regardless of leg order", async () => {
  const ordered = [
    [new DriveRemovalReviewRequired("A removal plan is waiting for approval."), "SAFETY_REVIEW_REQUIRED", "removal_review_required"],
    [Object.assign(new Error("Source scope needs a safety review."), { code: "SAFETY_REVIEW_REQUIRED" }), "SAFETY_REVIEW_REQUIRED", "safety_review_required"],
    [Object.assign(new Error("The source lock is held."), { code: "LOCK_HELD" }), "SCHEDULE_RUN_FAILED", "source_lock_held"],
    [new TypeError("fetch failed"), "NETWORK_UNREACHABLE", "network_unreachable"],
    [Object.assign(new Error("The provider request limit was reached."), { code: "RATE_LIMITED" }), "RATE_LIMITED", "source_execution_failed"],
    [new Error("Source stopped unexpectedly."), "UNKNOWN", "source_execution_failed"],
  ];
  for (let index = 0; index < ordered.length - 1; index++) {
    const [preferred, issueCode, reasonCode] = ordered[index];
    const [other] = ordered[index + 1];
    for (const errors of [[other, preferred], [preferred, other]]) {
      for (const entries of [errors, errors.map(error => new AggregateError([error], "Source legs failed."))]) {
        const { source } = await observe(new AggregateError(entries, "Source legs failed."));
        assert.equal(source.issue_code, issueCode);
        assert.equal(source.reason_code, reasonCode);
        assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
      }
    }
  }
});

test("daily diagnostics aggregate equal-priority control retains the first stop", async () => {
  for (const errors of [
    [new TypeError("fetch failed"), new TypeError("network failure")],
    [Object.assign(new Error("Source stopped."), { code: "RATE_LIMITED" }),
      Object.assign(new Error("Source stopped."), { code: "REMOTE_UNAVAILABLE" })],
  ]) {
    for (const entries of [errors, errors.map(error => new AggregateError([error], "Source legs failed."))]) {
      const { source } = await observe(new AggregateError(entries, "Source legs failed."));
      assert.equal(dailyErrorContext(new AggregateError(entries)).error, errors[0]);
      assert.equal(source.issue_code, errors[0].code || "NETWORK_UNREACHABLE");
      assert.equal(source.detail, DAILY_ISSUE_MESSAGES[source.issue_code]);
    }
  }
});

test("daily diagnostics harmless slash prose control is replaced in receipt and daily log", async () => {
  for (const message of [
    "The owner can retry and/or inspect the next result.",
    "Read/write access needs review; the provider returned a success/failure result.",
    "Review the provider response / retry later.",
    "The owner can retry and/or read the troubleshooting.md guide.",
  ]) {
    const { source, failures, receiptText } = await observe(new Error(message));
    assert.equal(source.detail, DAILY_ISSUE_MESSAGES.UNKNOWN);
    assert.equal(JSON.parse(receiptText).sources[0].detail, DAILY_ISSUE_MESSAGES.UNKNOWN);
    assert.equal(failures[0].detail, DAILY_ISSUE_MESSAGES.UNKNOWN);
  }
});

const authorizationLabel = ["Author", "ization"].join("");
const accessLabel = ["access", "token"].join("_");
const refreshLabel = ["refresh", "token"].join("_");
const bearerScheme = ["Bear", "er"].join("");
const basicScheme = ["Bas", "ic"].join("");
const shortValue = ["short", "secret"].join("-");
const basicValue = ["c3ludGhl", "dGljOg=="].join("");
const privateCases = [
  ["email", "owner+mail@fixture.invalid"],
  ["query URL", "https://provider.invalid/mail?cursor=private-cursor&account=private-account"],
  ["query URL with punctuation", "https://provider.invalid/mail?state=a,b;c&cursor=private-cursor"],
  ["forward slash Windows path", "C:/private/mail archive/message.txt"],
  ["backslash Windows path", String.raw`C:\private\mail archive\message.txt`],
  ["POSIX path", "/private/mail archive/message.txt"],
  ["relative path", "../mail archive/message.txt"],
  ["bare relative path", "records/mail archive/message.txt"],
  ["bare relative path with sentence punctuation", "records/mail archive/message.txt."],
  ["bare relative path with dotted directory", "records/mail.archive private-folder-marker folder/message.txt"],
  ["bare relative path with spaced filename", "records/reports/quarterly report.xlsx"],
  ["bare relative backslash path with spaced filename", String.raw`records\reports\quarterly report.xlsx`],
  ["bare relative path with spaced filename and punctuation", "records/reports/quarterly report.xlsx."],
  ["bare relative path with spaced directory and filename", "records/private archive/quarterly report.xlsx"],
  ["one-separator path with spaced filename", "reports/quarterly report.xlsx"],
  ["one-separator backslash path with spaced filename", String.raw`reports\quarterly report.xlsx`],
  ["one-separator path with spaced filename and punctuation", "reports/quarterly report.xlsx."],
  ["bare relative backslash path", String.raw`records\mail archive\message.txt`],
  ["home path", "~/mail archive/message.txt"],
  ["file URL", "file:///private/mail%20archive/message.txt"],
  ["file host URL", "file://host.invalid/share/mail%20archive/message.txt"],
  ["quoted path with punctuation", String.raw`'C:\private\mail,archive\message.txt'`],
  ["double quoted path with apostrophe", `"/private/mail's archive/message.txt"`],
  ["credential", ["sk", "a".repeat(32)].join("-")],
  ["short bearer credential", `${authorizationLabel}: ${bearerScheme} ${shortValue}`],
  ["short token assignment", `${accessLabel}=${shortValue}`],
  ["quoted token assignment", `"${refreshLabel}":"${shortValue}"`],
  ["basic authorization", `${authorizationLabel}: ${basicScheme} ${basicValue}`],
];
for (const [label, value] of privateCases) {
  test(`daily diagnostics fixed text excludes ${label} from receipt and daily log`, async () => {
    const { source, receiptText, logText } = await observe(new Error(`Provider stopped at ${value}; retry later.`));
    for (const text of [receiptText, logText]) {
      // Boolean assertions prevent synthetic private strings entering failure output.
      assert.equal(text.includes(value), false, `${label} must be removed`);
      assert.equal(text.includes("message.txt"), false, "path tail must be removed");
      assert.equal(text.includes("quarterly"), false, "spaced filename start must be removed");
      assert.equal(text.includes("report.xlsx"), false, "spaced filename tail must be removed");
      assert.equal(text.includes("mail.archive"), false, "dotted path directory must be removed");
      assert.equal(text.includes("private-folder-marker"), false, "spaced path directory must be removed");
      assert.equal(text.includes("private-cursor"), false, "query tail must be removed");
      assert.equal(text.includes("short-secret"), false, "the entire credential must be removed");
    }
    assert.equal(source.detail === DAILY_ISSUE_MESSAGES[source.issue_code], true);
  });
}

test("daily diagnostics one-separator spaced filename at end of text is removed", async () => {
  const value = "reports/quarterly report.xlsx";
  const { source, receiptText, logText } = await observe(new Error(`Provider stopped at ${value}`));
  for (const text of [receiptText, logText]) {
    assert.equal(text.includes(value), false, "the complete path must be removed");
    assert.equal(text.includes("quarterly"), false, "spaced filename start must be removed");
    assert.equal(text.includes("report.xlsx"), false, "spaced filename tail must be removed");
  }
  assert.equal(source.detail, DAILY_ISSUE_MESSAGES.UNKNOWN);
});

test("daily diagnostics fixed text ignores long and format-split provider messages", async () => {
  const email = "owner@fixture.invalid";
  const { source, receiptText, logText } = await observe(new Error(
    `Provider stopped: ${email.slice(0, 3)}\u200b${email.slice(3)}; ` + "retry ".repeat(100),
  ));
  assert.equal(source.detail === DAILY_ISSUE_MESSAGES[source.issue_code], true);
  for (const text of [receiptText, logText]) {
    assert.equal(text.includes(email), false, "normalization cannot recreate a private email");
    assert.equal(text.includes("retry retry"), false);
  }
});

test("daily diagnostics credential fixture source avoids literal credential positions", () => {
  const label = ["author", "ization"].join("");
  const tokenLabel = ["access", "token"].join("_");
  const shape = new RegExp(`${label}\\s*:|(?:access|refresh)_${["to", "ken"].join("")}["']?\\s*[:=]`, "iu");
  assert.equal(shape.test([label, ": ", ["Bear", "er"].join(""), " ", ["short", "secret"].join("-")].join("")), true);
  assert.equal(shape.test([tokenLabel, "=", ["short", "secret"].join("-")].join("")), true);
  const lines = readFileSync(new URL(import.meta.url), "utf8").split(/\r?\n/u);
  assert.equal(lines.some(line => shape.test(line)), false, "fixture source must assemble labels and values at runtime");
});

test("daily diagnostics explicit credentials cannot leave a split value behind", async () => {
  const prefix = ["pre", "fix"].join("");
  const tail = ["credential", "tail"].join("-");
  for (const message of [
    `Provider stopped: ${authorizationLabel}: ${bearerScheme} ${prefix}\u200b${tail}; retry later.`,
    `Provider stopped: ${accessLabel}=${prefix}\n${tail}; retry later.`,
  ]) {
    const { receiptText, logText } = await observe(new Error(message));
    for (const text of [receiptText, logText]) {
      assert.equal(text.includes("credential-tail"), false, "no credential fragment may survive normalization");
    }
  }
});
