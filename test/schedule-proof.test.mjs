import assert from "node:assert/strict";
import { freshnessReport } from "../worker/src/lib/store-d1.js";
import { installedScheduleMessage, scheduledSourceReceiptPoster } from "../brain.mjs";

let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const NOW = Date.parse("2026-09-24T18:00:00.000Z");
const sourceRows = [{
  name: "mail", kind: "gmail", status: "ready", registered: 1,
  document_count: 2, last_ingest_at: "2026-09-24T17:05:00.000Z",
  expected_refresh_seconds: 3_600,
}];

function fixture(scheduleRows) {
  let scheduleReads = 0;
  return {
    get scheduleReads() { return scheduleReads; },
    env: {
      DB: {
        prepare(sql) {
          if (/SELECT inventory\.\*/.test(sql)) return { all: async () => ({ results: sourceRows }) };
          if (/FROM sync_runs sr/.test(sql)) return { all: async () => ({ results: [] }) };
          if (/schedule_install/.test(sql) && /schedule_run/.test(sql)) {
            scheduleReads++;
            return { all: async () => ({ results: scheduleRows }) };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      },
    },
  };
}

{
  const receipts = [];
  const post = scheduledSourceReceiptPoster((_base, _key, receipt) => receipts.push(receipt), {
    "scheduled-run": true,
  });
  post("https://fixture.invalid", "fixture-key", { source: "mail", status: "indexing" });
  post("https://fixture.invalid", "fixture-key", { source: "mail", status: "error", run_id: "run-1" });
  post("https://fixture.invalid", "fixture-key", { source: "mail", status: "ready", run_id: "run-1" });
  check("the scheduled CLI path labels only its terminal ready receipt as unattended",
    receipts.length === 3 && receipts[0].scheduled_run === undefined &&
      receipts[1].scheduled_run === undefined && receipts[2].scheduled_run === true);
}

{
  const local = { installed: true };
  const first = installedScheduleMessage("Gmail", local, { state: "waiting_first" });
  const second = installedScheduleMessage("Gmail", local, { state: "waiting_second" });
  const proven = installedScheduleMessage("Gmail", local, { state: "proven" });
  check("owner wording never calls an unproven install scheduled",
    first.level === "warning" && /waiting for its first/.test(first.text) &&
      second.level === "warning" && /waiting for its second/.test(second.text) &&
      !/scheduled/.test(first.text + second.text));
  check("only two durable unattended successes produce green scheduled wording",
    proven.level === "ok" && /scheduled and proven by two unattended runs/.test(proven.text));
}

{
  const waiting = fixture([{
    source: "mail", installed_at: "2026-09-24T16:00:00.000Z",
    successful_runs: 0, first_run_at: null, last_run_at: null,
    schedule_detail: JSON.stringify({
      expected_refresh_seconds: 3_600,
      schedule_cron: "5 * * * *",
      schedule_timezone: "UTC",
    }),
  }]);
  const report = await freshnessReport(waiting.env, { now: NOW });
  check("an installed schedule is not green before an unattended run",
    report.sources[0]?.schedule?.state === "waiting_first" &&
      report.sources[0]?.state !== "scheduled", JSON.stringify(report));
  check("the schedule decision reached the durable proof read", waiting.scheduleReads === 1);
  check("an installed schedule exposes its next cron firing before the first run",
    report.sources[0]?.schedule?.next_run_at === "2026-09-24T18:05:00.000Z",
    JSON.stringify(report));
}

{
  const once = fixture([{
    source: "mail", installed_at: "2026-09-24T16:00:00.000Z",
    successful_runs: 1, first_run_at: "2026-09-24T17:05:00.000Z",
    last_run_at: "2026-09-24T17:05:00.000Z",
  }]);
  const report = await freshnessReport(once.env, { now: NOW });
  check("one unattended success is still waiting for the second run",
    report.sources[0]?.schedule?.state === "waiting_second" &&
      report.sources[0]?.schedule?.first_run_at === "2026-09-24T17:05:00.000Z",
    JSON.stringify(report));
}

{
  const twice = fixture([{
    source: "mail", installed_at: "2026-09-24T15:00:00.000Z",
    successful_runs: 2, first_run_at: "2026-09-24T16:05:00.000Z",
    last_run_at: "2026-09-24T17:05:00.000Z",
    schedule_detail: JSON.stringify({
      expected_refresh_seconds: 3_600,
      schedule_cron: "5 * * * *",
      schedule_timezone: "UTC",
    }),
  }]);
  const report = await freshnessReport(twice.env, { now: NOW });
  check("the second durable unattended success proves the schedule",
    report.sources[0]?.schedule?.state === "proven" &&
      report.sources[0]?.schedule?.second_run_observed === true &&
      report.sources[0]?.schedule?.successful_runs === 2,
    JSON.stringify(report));
  check("next run is derived from the actual next cron firing",
    report.sources[0]?.schedule?.next_run_at === "2026-09-24T18:05:00.000Z",
    JSON.stringify(report));
}

for (const scenario of [
  {
    name: "hourly",
    cron: "5 * * * *",
    timeZone: "UTC",
    now: "2026-09-24T18:06:00.000Z",
    next: "2026-09-24T19:05:00.000Z",
  },
  {
    name: "every-N-hours",
    cron: "15 */4 * * *",
    timeZone: "UTC",
    now: "2026-09-24T18:06:00.000Z",
    next: "2026-09-24T20:15:00.000Z",
  },
  {
    name: "daily in the scheduler machine timezone",
    cron: "30 7 * * *",
    timeZone: "America/Phoenix",
    now: "2026-09-24T15:00:00.000Z",
    next: "2026-09-25T14:30:00.000Z",
  },
  {
    name: "weekday across the weekend",
    cron: "0 9 * * 1-5",
    timeZone: "UTC",
    now: "2026-09-25T10:00:00.000Z",
    next: "2026-09-28T09:00:00.000Z",
  },
]) {
  const schedule = fixture([{
    source: "mail", installed_at: "2026-09-24T15:00:00.000Z",
    successful_runs: 1, first_run_at: "2026-09-24T17:05:00.000Z",
    last_run_at: "2026-09-24T17:05:00.000Z",
    schedule_detail: JSON.stringify({
      expected_refresh_seconds: 3_600,
      schedule_cron: scenario.cron,
      schedule_timezone: scenario.timeZone,
    }),
  }]);
  const report = await freshnessReport(schedule.env, { now: Date.parse(scenario.now) });
  check(`${scenario.name} reports the next declared cron firing`,
    report.sources[0]?.schedule?.next_run_at === scenario.next,
    JSON.stringify(report.sources[0]?.schedule));
}

console.log(`\nschedule proof: all ${ran} checks passed`);
