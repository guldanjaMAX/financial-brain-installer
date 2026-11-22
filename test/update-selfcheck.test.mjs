import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dispatchUpdateCli } from "../brain.mjs";

test("update dry-run previews the five reads without dispatching an update", async () => {
  const lines = [];
  const result = await dispatchUpdateCli(["--dry-run"], { write: line => lines.push(line) });
  assert.equal(result.dry_run, true);
  assert.match(lines.join("\n"), /bank.*secret.*source.*daily.*Claude/is);
  assert.throws(() => dispatchUpdateCli(["--skip-selfcheck"]), /doesn't take --skip-selfcheck/);
  assert.throws(() => dispatchUpdateCli(["--dry-run", "--skip-selfcheck"]), /--dry-run by itself/);
});

const readContract = () => import("../operations/update-selfcheck.mjs");
const fixture = {
  bank: [{ ref: "link-a", ok: true }, { ref: "link-b", ok: false }],
  secrets: ["ADMIN_KEY", "BANK_FEED_WRAPPING_KEY_V2"],
  sources: [{ ref: "source-a", ok: true }],
  daily: { present: true, enabled: true, schedule: ["09:00", 1, true] },
  claude: { present: true, points_here: true },
};
const capture = (fn, data, refused) => fn(Object.fromEntries(Object.entries(data)
  .map(([key, value]) => [key, async () => {
    if (key === refused) throw new Error("private-account-id 749.51");
    return value;
  }])));

test("healthy snapshots pass across version and schema differences", async () => {
  const { captureUpdateSelfcheck, compareUpdateSelfcheck } = await readContract();
  const before = await capture(captureUpdateSelfcheck, { ...fixture, version: "old", schema: 1 });
  const after = await capture(captureUpdateSelfcheck, { ...fixture, version: "new", schema: 2 });
  const report = compareUpdateSelfcheck(before, after);
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 5);
});

for (const [category, value, code] of [
  ["bank", [{ ref: "link-a", ok: false }, { ref: "link-b", ok: true }], "BANK_CHANGED"],
  ["secrets", ["ADMIN_KEY", "ANOTHER_NAME"], "SECRETS_CHANGED"],
  ["sources", [{ ref: "source-a", ok: false }], "SOURCES_CHANGED"],
  ["daily", { present: false }, "DAILY_CHANGED"],
  ["claude", { present: true, points_here: false }, "CLAUDE_CHANGED"],
]) {
  test(category + " regression stops completion despite equal inventory counts where applicable", async () => {
    const { captureUpdateSelfcheck, compareUpdateSelfcheck } = await readContract();
    const before = await capture(captureUpdateSelfcheck, fixture);
    const after = await capture(captureUpdateSelfcheck, { ...fixture, [category]: value });
    const report = compareUpdateSelfcheck(before, after);
    assert.equal(report.status, "changed");
    assert.equal(report.checks.find(check => check.category === category).code, "UPDATE_SELFCHECK_" + code);
    assert.doesNotMatch(JSON.stringify(report), /link-[ab]|source-a/);
  });
}

test("an unavailable read is reported without exposing its raw failure", async () => {
  const { captureUpdateSelfcheck, compareUpdateSelfcheck, updateSelfcheckMessage } = await readContract();
  const before = await capture(captureUpdateSelfcheck, fixture);
  const after = await capture(captureUpdateSelfcheck, fixture, "bank");
  const report = compareUpdateSelfcheck(before, after);
  assert.equal(report.status, "not_checked");
  assert.match(updateSelfcheckMessage(report), /Updated, but this check could not run.*bank connections/is);
  assert.doesNotMatch(JSON.stringify(report), /private-account-id|749\.51/);
});

test("source identity siblings stop at the registry projection with healthy controls", async t => {
  const { captureUpdateSelfcheck, compareUpdateSelfcheck, sourceSelfcheckRows } = await readContract();
  const source = {
    name: "source-private-name", source_id: "source-private-id", kind: "google_drive",
    connector: { provider: "google" }, registered: true,
    receipt: { registered_at: "2026-11-17T12:00:00Z", latest_run: { outcome: "completed" } },
  };
  const changes = [
    ["provider kind", { kind: "local" }],
    ["provider identity", { connector: { provider: "other" } }],
    ["stable registry ID", { source_id: "replacement-private-id" }],
    ["new registration", { receipt: { ...source.receipt, registered_at: "2026-11-17T12:01:00Z" } }],
  ];
  let seed = 0x30c01117;
  const snapshot = row => capture(captureUpdateSelfcheck, {
    ...fixture, sources: sourceSelfcheckRows({ sources: [row] }, () => null),
  });
  const before = await snapshot(source);
  const legacy = await snapshot({ name: source.name, kind: source.kind, receipt: { latest_run: source.receipt.latest_run } });
  assert.equal(compareUpdateSelfcheck(legacy, before).status, "passed", "new identity evidence is compatible with legacy");
  assert.deepEqual(sourceSelfcheckRows({ sources: [
    { name: "stored-only", kind: "unregistered", freshness: { state: "unregistered" }, receipt: {} },
    { name: "stored-only", kind: "unregistered", registered: false, receipt: null },
  ] }, () => null), []);
  while (changes.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const [[label, patch]] = changes.splice(seed % changes.length, 1);
    await t.test(label, async () => {
      assert.equal(compareUpdateSelfcheck(before, await snapshot(structuredClone(source))).status, "passed");
      const after = await snapshot({ ...source, ...patch });
      assert.equal(after.sources.value[0]?.ok, true, "the healthy replacement reached the identity decision");
      const report = compareUpdateSelfcheck(before, after);
      assert.equal(report.checks.find(row => row.category === "sources").code, "UPDATE_SELFCHECK_SOURCES_CHANGED");
      assert.doesNotMatch(JSON.stringify(report), /private-id|private-name/);
    });
  }
});

test("each category reopens its original checkpoint from disk on retry", async t => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { captureUpdateSelfcheck, openUpdateSelfcheck } = await readContract();
  const mutations = [
    ["bank", [{ ref: "another-link", ok: true }, fixture.bank[1]]],
    ["secrets", ["ADMIN_KEY"]],
    ["sources", [{ ref: "another-source", ok: true }]],
    ["daily", { present: true, enabled: false, schedule: fixture.daily.schedule }],
    ["claude", { present: true, points_here: false }],
  ];
  let seed = 0x6e781117;
  const original = await capture(captureUpdateSelfcheck, fixture);
  while (mutations.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const [[category, value]] = mutations.splice(seed % mutations.length, 1);
    await t.test(category, async () => {
      const directory = mkdtempSync(join(tmpdir(), "selfcheck-checkpoint-"));
      const settings = { directory, windowsAcl() {}, macAcl() {} };
      try {
        const reopen = () => openUpdateSelfcheck("fixture-account", "fixture-database", settings);
        const fresh = reopen();
        assert.equal(fresh.before, undefined);
        assert.deepEqual(readdirSync(directory), [], "reading the absent checkpoint creates nothing");
        fresh.claim(original);
        const [file] = readdirSync(directory);
        assert.doesNotMatch(readFileSync(join(directory, file), "utf8"), /link-[ab]|source-a|fixture-account|fixture-database/);
        const retry = reopen();
        const changed = await capture(captureUpdateSelfcheck, { ...fixture, [category]: value });
        const result = retry.compare(retry.before, changed);
        assert.equal(result.checks.find(row => row.category === category).status, "changed");
        assert.equal(retry.compare(retry.before, original).status, "passed");
        retry.clear();
        assert.deepEqual(readdirSync(directory), []);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
});

test("malformed bank proof cannot look like a successful read", async () => {
  const { bankSelfcheckRows } = await readContract();
  assert.throws(() => bankSelfcheckRows({
    update_selfcheck: [{ connection_ref: "fixture", opens: true, code: "unknown" }],
  }), /proof is unavailable/);
});

test("bank opening proofs normalize and contradictory forms stop", async t => {
  const { bankSelfcheckRows, captureUpdateSelfcheck, compareUpdateSelfcheck } = await readContract();
  const current = { connection_ref: "fixture-private-link", state: "connected", opens: true, code: "BANK_ACCESS_READABLE" };
  const legacy = { connection_ref: current.connection_ref, opens: true, code: "BANK_ACCESS_READABLE" };
  const cases = [
    ["opening", { opens: false, code: "BANK_ACCESS_REFERENCE_UNREADABLE" }],
    ["identity", { connection_ref: "fixture-other-link" }],
    ["state", { state: "reauth_required" }],
    ["missing sibling", null],
  ];
  const captureBody = body => capture(captureUpdateSelfcheck, {
    ...fixture, bank: bankSelfcheckRows(body, { legacy: true }),
  });
  let seed = 0xa679e411;
  const before = await captureBody({ read_only: true, connections: [{ ...legacy, state: current.state }] });
  const retired = { connection_ref: "fixture-retired-link", state: "removed", opens: false, code: "BANK_ACCESS_NOT_APPLICABLE" };
  const withRetired = await captureBody({ read_only: true, update_selfcheck: [current, retired], connections: [legacy] });
  assert.equal(withRetired.bank.value[1]?.mismatch, false, "a retired page entry has no duplicate opening proof");
  while (cases.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const [[label, patch]] = cases.splice(seed % cases.length, 1);
    await t.test(label, async () => {
      const body = { read_only: true, update_selfcheck: [current], connections: [legacy] };
      const good = await captureBody(body);
      assert.equal(good.bank.value.length, 1, "duplicate proof is counted once");
      assert.equal(compareUpdateSelfcheck(before, good).status, "passed");
      const after = await captureBody({ ...body, connections: patch ? [{ ...legacy, ...patch }] : [] });
      assert.equal(after.bank.value[0].mismatch, true, "the proof reconciliation was reached");
      const result = compareUpdateSelfcheck(before, after);
      assert.equal(result.checks[0].code, "UPDATE_SELFCHECK_BANK_CHANGED");
      assert.doesNotMatch(JSON.stringify(result), /fixture-(private|other)-link/);
    });
  }
});

test("an internally inconsistent bank baseline stops even when after evidence is unavailable", async () => {
  const { bankSelfcheckRows, captureUpdateSelfcheck, compareUpdateSelfcheck } = await readContract();
  const row = { connection_ref: "fixture-link", state: null, opens: false, code: "BANK_PAGE_CUSTODY_MISMATCH" };
  const bank = bankSelfcheckRows({ update_selfcheck: [row] });
  const before = await capture(captureUpdateSelfcheck, { ...fixture, bank });
  assert.equal(before.bank.value[0].mismatch, true);
  const result = compareUpdateSelfcheck(before, await capture(captureUpdateSelfcheck, fixture, "bank"));
  assert.equal(result.checks[0].code, "UPDATE_SELFCHECK_BANK_CHANGED");
});

test("daily verification compares permanent source scope as well as trigger", async t => {
  const { captureUpdateSelfcheck, compareUpdateSelfcheck } = await readContract();
  const snapshot = keys => capture(captureUpdateSelfcheck, { ...fixture, daily: { ...fixture.daily, keys } });
  const before = await snapshot(["drive", "mail"]);
  const cases = [["same-count replacement", ["drive", "other"]], ["partial loss", ["mail"]], ["all scope lost", []]];
  let seed = 0xc3256da9;
  while (cases.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const [[label, keys]] = cases.splice(seed % cases.length, 1);
    await t.test(label, async () => {
      assert.equal(compareUpdateSelfcheck(before, await snapshot(["mail", "drive", "extra"])).status, "passed");
      const after = await snapshot(keys);
      assert.deepEqual(after.daily.value.keys, [...keys].sort(), "verified scope reached the comparison");
      assert.equal(compareUpdateSelfcheck(before, after).checks.find(row => row.category === "daily").code,
        "UPDATE_SELFCHECK_DAILY_CHANGED");
    });
  }
});

test("an unverified bank link cannot hide a verified failure on another link", async () => {
  const { bankSelfcheckRows, captureUpdateSelfcheck, compareUpdateSelfcheck } = await readContract();
  const before = await capture(captureUpdateSelfcheck, fixture);
  const check = async (code, opens) => {
    const bank = bankSelfcheckRows({ update_selfcheck: [
      { connection_ref: "link-a", state: "connected", opens, code },
      { connection_ref: "link-b", state: "connected", opens: false, code: "BANK_ACCESS_CHECK_UNAVAILABLE" },
    ] });
    return compareUpdateSelfcheck(before, await capture(captureUpdateSelfcheck, { ...fixture, bank }));
  };
  assert.equal((await check("BANK_ACCESS_READABLE", true)).status, "not_checked");
  assert.equal((await check("BANK_ACCESS_REFERENCE_UNREADABLE", false)).status, "changed");
});

test("update completion uses one authenticated bank JSON read per phase and preserves private evidence", async t => {
  const { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cmdUpdate, reportAnticipatedCliFailure } = await import("../brain.mjs");
  const { previewSupportJournal, recordSupportEvent } = await import("../support-journal.mjs");
  const { saveUpgradeBookmark } = await import("../operations/upgrade-bookmark.mjs");
  for (const category of ["healthy", "bank", "secrets", "sources", "source-kind", "daily", "claude",
    "unavailable", "legacy-healthy", "legacy-broken"]) {
    await t.test(category, async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-selfcheck-")));
      try {
        const manifestPath = join(root, "brain.manifest.json");
        const legacy = category.startsWith("legacy-");
        const manifest = {
          client: { slug: "fixture" },
          brain: { version: legacy ? "0.4.29" : "0.4.1", domain: "brain.example.invalid" },
          infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
          retrieval: { answer_model: "@cf/fixture" },
        };
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const canary = "synthetic-private-account-749.51";
        const issue = [];
        const lines = [];
        const receipts = [];
        const calls = [];
        let after = false;
        let bankFault = "missing";
        const writers = { windowsAcl: () => {}, macAcl: () => {}, directory: join(root, "receipts") };
        const bookmark = {
          account_id: "fixture-account", database_id: "fixture-db", bookmark: "fixture-restore-point",
          from_version: "0.4.1", to_version: "0.4.29",
        };
        function save(fields) {
          receipts.push(saveUpgradeBookmark({ ...bookmark, ...fields }, writers));
        }
        const recordIssue = input => {
          const event = recordSupportEvent(input, { root });
          issue.push(event);
          return event;
        };
        const value = (key, changed) => async () => after && category === key ? changed : fixture[key];
        const update = () => cmdUpdate(manifestPath, {
          lifecycleLockHeld: true, interactive: false, answerSetupNeedsRecovery: () => false,
          discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
          adoptCloudflareAuthProfile: async () => {},
          withCloudflareControl: async action => action(),
          cmdVerify: async () => {},
          dailyRefreshOptions: { platform: "linux" },
          reconcileExistingOwnerAgents: null,
          installTechnicianSkills: () => { throw new Error("fixture skill unavailable"); },
          reportUpdateFinish: line => lines.push(line),
          reportSkillRefreshWarning: () => {},
          recordSelfcheckIssue: recordIssue,
          selfcheckCheckpointOptions: writers,
          selfcheckReaders: {
            secrets: value("secrets", ["ADMIN_KEY", "OTHER_NAME"]),
            daily: value("daily", { present: false }),
            claude: value("claude", { present: true, points_here: false }),
          },
          selfcheckOptions: {
            readSourceFreshness: async () => ({ sources: [{
              name: "source-a",
              kind: after && category === "source-kind" ? "local" : "google_drive",
              receipt: { latest_run: { outcome: after && category === "sources" ? "failed" : "completed" } },
            }] }),
            resolveKey: () => ["simulated", "credential"].join("-"),
            request: async (url, init) => {
              const address = new URL(url);
              calls.push(address.pathname + address.search);
              assert.equal(init.method, "GET");
              assert.equal(new Headers(init.headers).get("accept"), "application/json");
              assert.equal(new Headers(init.headers).get("content-type"), "application/json");
              assert.equal(new Headers(init.headers).get("x-admin-key"), ["simulated", "credential"].join("-"));
              if (after && (category === "unavailable" || (category === "bank" && bankFault === "unavailable"))) {
                return Response.json({ detail: canary }, { status: 502 });
              }
              const missing = after && category === "bank" && bankFault === "missing";
              const unreadable = after && category === "legacy-broken";
              const connections = missing ? [] : [{
                connection_ref: after && category === "bank" && bankFault === "replacement" ? canary + "-other" : canary,
                state: "connected",
                opens: !unreadable,
                code: unreadable ? "BANK_ACCESS_REFERENCE_UNREADABLE" : "BANK_ACCESS_READABLE",
                detail: canary, balance: 749.51,
              }];
              if (address.pathname === "/api/bank-feed/custody") {
                return Response.json({ read_only: true, connections: connections.map(({ state, ...row }) => row) });
              }
              return Response.json({ update_selfcheck: connections });
            },
          },
          cmdUpgrade: async (_target, options) => {
            assert.ok(calls.length >= 1);
            save({ selfcheck_before: options.selfcheckBefore });
            options.onSelfcheckReceipt(report => save({ selfcheck: report }));
            options.beforeRemoteMutation();
            writeFileSync(manifestPath, JSON.stringify({ ...manifest, brain: { ...manifest.brain, version: "0.4.29" }, schema_version: 99 }));
            after = true;
          },
        });
        if (["healthy", "unavailable", "legacy-healthy"].includes(category)) {
          await update();
          assert.equal(lines.length, 1);
          if (category === "legacy-healthy") {
            assert.match(lines[0], /Bank access needs attention/);
            assert.doesNotMatch(lines[0], /UPDATE_SELFCHECK|older Worker/);
          } else if (category !== "unavailable") assert.match(lines[0], /^✔ Version /u);
          else {
            assert.match(lines[0], /Bank access needs attention/);
            assert.doesNotMatch(lines[0], /UPDATE_SELFCHECK|HTTP 502/);
            assert.equal(issue[0].error_code, "UPDATE_SELFCHECK_NOT_CHECKED");
          }
        } else {
          const code = "UPDATE_SELFCHECK_" + (category === "source-kind" ? "SOURCES" :
            legacy ? "BANK" : category.toUpperCase()) + "_CHANGED";
          const failureLines = [];
          await assert.rejects(update().catch(error => {
            assert.equal(reportAnticipatedCliFailure(error, {
              write: line => failureLines.push(line), support: { command: "update", record: recordIssue },
            }), true);
            throw error;
          }), { supportCode: code });
          assert.equal(issue[0]?.error_code, code);
          assert.ok(failureLines.every(line => /needs attention\. Ask your installer to check it\.$/.test(line)));
          assert.doesNotMatch(failureLines.join("\n"), /synthetic-private-account|749\.51|simulated-credential/);
          assert.doesNotMatch(lines.join("\n"), /Done\./);
          if (category === "bank") {
            await assert.rejects(update(), { supportCode: "UPDATE_SELFCHECK_BANK_CHANGED" });
            bankFault = "unavailable";
            await assert.rejects(update(), { supportCode: "UPDATE_SELFCHECK_NOT_CHECKED" });
            bankFault = "replacement";
            await assert.rejects(update(), { supportCode: "UPDATE_SELFCHECK_BANK_CHANGED" });
            assert.equal(lines.length, 0, "no retry reported completion while the original was missing");
            bankFault = null;
            await update();
            assert.match(lines[0], /^✔ Version /u);
            assert.equal(calls.length, 6, "each retry reads the bank only for its after observation");
          }
        }
        const statusPath = "/api/bank-feed/status?update_selfcheck=1";
        assert.deepEqual(calls, legacy ? ["/api/bank-feed/custody", statusPath] :
          Array(category === "bank" ? 6 : 2).fill(statusPath));
        assert.equal(receipts.length, category === "bank" ? 10 : 2);
        const receiptText = receipts.map(path => readFileSync(path, "utf8")).join("\n");
        const journalText = previewSupportJournal({ root });
        if (issue.length) assert.ok(journalText.includes(issue[0].error_code));
        assert.doesNotMatch(receiptText + lines.join("\n") + journalText,
          /synthetic-private-account|749\.51|simulated-credential/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("the 0.4.31 owner notes describe the update self-check report and its codes", () => {
  // brain whatsnew prints this section to the owner.
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const section = changelog.split(/^## 0\.4\.31\b.*$/m)[1]?.split(/^## /m)[0] ?? "";
  assert.ok(section.trim(), "the 0.4.31 section exists");
  const bullet = section.split(/\n(?=- )/).map(item => item.replace(/\s+/g, " "))
    .find(item => /self-check|check themselves/i.test(item));
  assert.ok(bullet, "an owner bullet describes the update self-check");
  assert.match(bullet, /`brain update`/);
  assert.match(bullet, /bank connections/);
  assert.match(bullet, /`UPDATE_SELFCHECK_/);
});
