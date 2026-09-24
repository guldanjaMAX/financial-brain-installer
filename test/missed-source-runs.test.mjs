import assert from "node:assert/strict";
import {
  markMissedSourceRuns,
  notifyMissedSources,
  scheduleGraceSeconds,
} from "../worker/src/lib/missed-source-runs.js";

let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const NOW = Date.parse("2026-09-24T18:00:00.000Z");

function fixture(rows) {
  const seen = { reads: 0, sql: [], binds: [], batches: 0 };
  const env = {
    DB: {
      prepare(sql) {
        seen.sql.push(sql);
        return {
          bind(...values) {
            seen.binds.push(values);
            return this;
          },
          all: async () => {
            seen.reads++;
            return { results: rows };
          },
        };
      },
      async batch(statements) {
        seen.batches++;
        return statements.map((_statement, index) => ({ success: true, meta: { changes: index % 2 === 0 ? 1 : 1 } }));
      },
    },
  };
  return { env, seen };
}

{
  const grace = scheduleGraceSeconds(3_600);
  check("hourly schedules receive a bounded grace window", grace >= 300 && grace <= 3_600);
}

{
  const due = fixture([
    {
      name: "mail", kind: "gmail", status: "ready", stale_reason: null,
      expected_refresh_seconds: 3_600,
      schedule_installed_at: "2026-09-24T14:00:00.000Z",
      last_successful_run_at: "2026-09-24T15:00:00.000Z",
    },
    {
      name: "calendar", kind: "calendar", status: "ready", stale_reason: null,
      expected_refresh_seconds: 3_600,
      schedule_installed_at: "2026-09-24T16:30:00.000Z",
      last_successful_run_at: "2026-09-24T17:30:00.000Z",
    },
    {
      name: "mailbox", kind: "imap", status: "error", stale_reason: "AUTH_EXPIRED",
      expected_refresh_seconds: 3_600,
      schedule_installed_at: "2026-09-24T12:00:00.000Z",
      last_successful_run_at: "2026-09-24T13:00:00.000Z",
    },
  ]);
  const result = await markMissedSourceRuns(due.env, { now: NOW });
  check("the watchdog makes one bounded source-registry read", due.seen.reads === 1 && result.checked === 3);
  check("the read uses the source-name index and indexed event lookups, never a corpus count",
    /FROM sources s[\s\S]*ORDER BY s\.name/.test(due.seen.sql[0]) &&
      /source_events[\s\S]*source_name=s\.name/.test(due.seen.sql[0]) &&
      !/documents|COUNT\s*\(/i.test(due.seen.sql[0]), due.seen.sql[0]);
  check("only the overdue healthy source is marked missed",
    result.overdue === 2 && result.newly_missed === 1 && due.seen.batches === 1,
    JSON.stringify(result));
  check("an existing connector error is never overwritten by missed-run detection",
    due.seen.binds.every((values) => !values.includes("mailbox")), JSON.stringify(due.seen.binds));
}

{
  const current = fixture([{
    name: "mail", kind: "gmail", status: "ready", stale_reason: null,
    expected_refresh_seconds: 3_600,
    schedule_installed_at: "2026-09-24T17:30:00.000Z",
    last_successful_run_at: null,
  }]);
  const result = await markMissedSourceRuns(current.env, { now: NOW });
  check("a source still inside its first-run window reaches the decision and writes nothing",
    current.seen.reads === 1 && result.checked === 1 && result.overdue === 0 && current.seen.batches === 0);
}

{
  const reinstalled = fixture([{
    name: "mail", kind: "gmail", status: "ready", stale_reason: null,
    expected_refresh_seconds: 3_600,
    schedule_installed_at: "2026-09-24T17:30:00.000Z",
    last_successful_run_at: "2026-09-20T12:00:00.000Z",
  }]);
  const result = await markMissedSourceRuns(reinstalled.env, { now: NOW });
  check("a pre-reinstall success cannot make a recent reinstall immediately missed",
    reinstalled.seen.reads === 1 && result.checked === 1 && result.overdue === 0 &&
      result.newly_missed === 0 && reinstalled.seen.batches === 0 &&
      /schedule_run'[\s\S]*e\.at\s*>=\s*\(SELECT MAX\(i\.at\)[\s\S]*schedule_install'/.test(reinstalled.seen.sql[0]),
    JSON.stringify({ result, sql: reinstalled.seen.sql }));
}

{
  let fetches = 0;
  const quiet = await notifyMissedSources({}, { newly_missed: 2 }, {
    fetchImpl: async () => { fetches++; },
  });
  check("the owner alert hook is off unless configured", quiet.configured === false && fetches === 0);

  let request = null;
  const sent = await notifyMissedSources(
    { SOURCE_ALERT_WEBHOOK_URL: "https://alerts.example.invalid/source" },
    { newly_missed: 2 },
    { fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 204 };
    } },
  );
  const payload = JSON.parse(request.init.body);
  check("a configured hook sends one aggregate notification with no source identity",
    sent.delivered === true && payload.event === "source_schedule_missed" && payload.count === 2 &&
      !request.init.body.includes("mail") && !request.init.body.includes("calendar"),
    request?.init?.body);
}

console.log(`\nmissed source runs: all ${ran} checks passed`);
