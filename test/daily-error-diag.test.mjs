import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
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

test("daily diagnostics removal approval retains its named stop and safe reason", async () => {
  for (const error of [
    new DriveRemovalReviewRequired("A removal plan is waiting for approval."),
    Object.assign(new Error("A removal plan is waiting for approval."), { name: "DriveRemovalReviewRequired" }),
    Object.assign(new Error("A removal plan is waiting for approval."), { code: "removal_approval_required" }),
  ]) {
    const { source, result } = await observe(error);
    assert.equal(source.issue_code, "SAFETY_REVIEW_REQUIRED");
    assert.equal(source.reason_code, "removal_review_required");
    assert.match(source.detail, /removal plan is waiting for approval/u);
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
  assert.match(source.detail, /Source scope needs a safety review/u);
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
    assert.match(source.detail, /lock is held/u);
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
  assert.match(source.detail, /removal plan is waiting for approval/u);

  const { source: multiple } = await observe(new Error("One source did not load.", {
    cause: new AggregateError([review, new TypeError("fetch failed")], "Source legs failed."),
  }));
  assert.equal(multiple.issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.match(multiple.detail, /2 source failures/u);
});

test("daily diagnostics network wrapper retains the transport reason", async () => {
  const transport = Object.assign(new Error("Connection reset while reading provider response."), { code: "ECONNRESET" });
  const { source } = await observe(new Error("One source did not load.", { cause: transport }));
  assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(source.detail, transport.message);
});

test("daily diagnostics aggregate unknown then network retains the recognized stop", async () => {
  const network = Object.assign(new Error("Connection reset while reading provider response."), { code: "ECONNRESET" });
  const { source } = await observe(new Error("One source did not load.", {
    cause: new AggregateError([new Error("Source stopped unexpectedly."), network], "Source legs failed."),
  }));
  assert.equal(source.issue_code, "NETWORK_UNREACHABLE");
  assert.equal(source.reason_code, "network_unreachable");
  assert.match(source.detail, /^2 source failures;/u);
  assert.equal(source.detail.endsWith(network.message), true);
});

test("daily diagnostics aggregate unknown then lock retains the recognized stop", async () => {
  for (const code of ["source_ingest_already_running", "brain_lifecycle_busy", "LOCK_HELD"]) {
    const lock = Object.assign(new Error("The source lock is held by another refresh."), { code });
    const { source } = await observe(new AggregateError([
      new Error("Source stopped unexpectedly."), lock,
    ], "Source legs failed."));
    assert.equal(source.issue_code, "SCHEDULE_RUN_FAILED");
    assert.equal(source.reason_code, "source_lock_held");
    assert.match(source.detail, /^2 source failures;/u);
    assert.equal(source.detail.endsWith(lock.message), true);
  }
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
      const { source } = await observe(new AggregateError(errors, "Source legs failed."));
      assert.equal(source.issue_code, issueCode);
      assert.equal(source.reason_code, reasonCode);
      assert.equal(source.detail.endsWith(preferred.message), true);
    }
  }
});

test("daily diagnostics aggregate equal-priority control retains the first detail", async () => {
  for (const errors of [
    [new TypeError("fetch failed"), new TypeError("network failure")],
    [new Error("First source stopped unexpectedly."), new Error("Second source stopped unexpectedly.")],
  ]) {
    const { source } = await observe(new AggregateError(errors, "Source legs failed."));
    assert.equal(source.detail.endsWith(errors[0].message), true);
  }
});

test("daily diagnostics safe slash prose control survives in receipt and daily log", async () => {
  for (const message of [
    "The owner can retry and/or inspect the next result.",
    "Read/write access needs review; the provider returned a success/failure result.",
    "Review the provider response / retry later.",
    "The owner can retry and/or read the troubleshooting.md guide.",
  ]) {
    const { source, failures, receiptText } = await observe(new Error(message));
    assert.equal(source.detail, message);
    assert.equal(JSON.parse(receiptText).sources[0].detail, message);
    assert.equal(failures[0].detail, message);
  }
});

const privateCases = [
  ["email", "owner+mail@fixture.invalid", "[REDACTED:email]"],
  ["query URL", "https://provider.invalid/mail?cursor=private-cursor&account=private-account", "[REDACTED:url]"],
  ["query URL with punctuation", "https://provider.invalid/mail?state=a,b;c&cursor=private-cursor", "[REDACTED:url]"],
  ["forward slash Windows path", "C:/private/mail archive/message.txt", "[REDACTED:path]"],
  ["backslash Windows path", String.raw`C:\private\mail archive\message.txt`, "[REDACTED:path]"],
  ["POSIX path", "/private/mail archive/message.txt", "[REDACTED:path]"],
  ["relative path", "../mail archive/message.txt", "[REDACTED:path]"],
  ["bare relative path", "records/mail archive/message.txt", "[REDACTED:path]"],
  ["bare relative path with sentence punctuation", "records/mail archive/message.txt.", "[REDACTED:path]"],
  ["bare relative path with dotted directory", "records/mail.archive private-folder-marker folder/message.txt", "[REDACTED:path]"],
  ["bare relative backslash path", String.raw`records\mail archive\message.txt`, "[REDACTED:path]"],
  ["home path", "~/mail archive/message.txt", "[REDACTED:path]"],
  ["file URL", "file:///private/mail%20archive/message.txt", "[REDACTED:path]"],
  ["file host URL", "file://host.invalid/share/mail%20archive/message.txt", "[REDACTED:path]"],
  ["quoted path with punctuation", String.raw`'C:\private\mail,archive\message.txt'`, "[REDACTED:path]"],
  ["double quoted path with apostrophe", `"/private/mail's archive/message.txt"`, "[REDACTED:path]"],
  ["credential", ["sk", "a".repeat(32)].join("-"), "[REDACTED:openai_legacy_key]"],
  ["short bearer credential", "Authorization: Bearer short-secret", "[REDACTED:credential]"],
  ["short token assignment", "access_token=short-secret", "[REDACTED:credential]"],
  ["quoted token assignment", '"refresh_token":"short-secret"', "[REDACTED:credential]"],
  ["basic authorization", "Authorization: Basic c3ludGhldGljOg==", "[REDACTED:credential]"],
];
for (const [label, value, marker] of privateCases) {
  test(`daily diagnostics redaction removes ${label} from receipt and daily log`, async () => {
    const { source, receiptText, logText } = await observe(new Error(`Provider stopped at ${value}; retry later.`));
    for (const text of [receiptText, logText]) {
      // Boolean assertions prevent synthetic private strings entering failure output.
      assert.equal(text.includes(value), false, `${label} must be removed`);
      assert.equal(text.includes("message.txt"), false, "path tail must be removed");
      assert.equal(text.includes("mail.archive"), false, "dotted path directory must be removed");
      assert.equal(text.includes("private-folder-marker"), false, "spaced path directory must be removed");
      assert.equal(text.includes("private-cursor"), false, "query tail must be removed");
      assert.equal(text.includes("short-secret"), false, "the entire credential must be removed");
      assert.equal(text.includes(marker), true, "the redaction marker must be retained");
    }
    assert.match(source.detail, /^Provider stopped at /u, "safe explanatory prose survives");
    assert.match(source.detail, /retry later\.$/u);
  });
}

test("daily diagnostics redaction occurs before bounding and after format normalization", async () => {
  const email = "owner@fixture.invalid";
  const { source, receiptText, logText } = await observe(new Error(
    `Provider stopped: ${email.slice(0, 3)}\u200b${email.slice(3)}; ` + "retry ".repeat(100),
  ));
  assert.equal(source.detail.length, 200);
  for (const text of [receiptText, logText]) {
    assert.equal(text.includes(email), false, "normalization cannot recreate a private email");
    assert.equal(text.includes("[REDACTED:email]"), true);
  }
});

test("daily diagnostics explicit credentials cannot leave a split value behind", async () => {
  for (const message of [
    "Provider stopped: Authorization: Bearer prefix\u200bcredential-tail; retry later.",
    "Provider stopped: access_token=prefix\ncredential-tail; retry later.",
  ]) {
    const { receiptText, logText } = await observe(new Error(message));
    for (const text of [receiptText, logText]) {
      assert.equal(text.includes("credential-tail"), false, "no credential fragment may survive normalization");
    }
  }
});
