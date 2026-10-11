import assert from "node:assert/strict";
import { test } from "node:test";
import * as intent from "../src/lib/query-intent.js";

const NOW = Date.parse("2026-03-31T12:30:00Z");
// Windows use UTC calendar days, inclusive start and exclusive end. A month
// shift clamps its day at month-end; it never rolls February into March.
for (const [query, start, end] of [
  ["last 60 days", "2026-01-30", "2026-04-01"],
  ["past 1 day", "2026-03-30", "2026-04-01"],
  ["last 2 weeks", "2026-03-17", "2026-04-01"],
  ["past 1 week", "2026-03-24", "2026-04-01"],
  ["last 1 month", "2026-02-28", "2026-04-01"],
  ["past 2 months", "2026-01-31", "2026-04-01"],
  ["next 5 days", "2026-03-31", "2026-04-06"],
  ["so far this year", "2026-01-01", "2026-04-01"],
  ["so far this month", "2026-03-01", "2026-04-01"],
  ["year to date", "2026-01-01", "2026-04-01"],
  ["this quarter", "2026-01-01", "2026-04-01"],
  ["Q1 2024", "2024-01-01", "2024-04-01"],
  ["Q2 2025", "2025-04-01", "2025-07-01"],
  ["Q3 2025", "2025-07-01", "2025-10-01"],
  ["Q4 2025", "2025-10-01", "2026-01-01"],
  ["every 2025 statement", "2025-01-01", "2026-01-01"],
]) {
  test(`explicit window: ${query}`, () => {
    assert.equal(typeof intent.queryTimeWindow, "function", "window decision point exists");
    const window = intent.queryTimeWindow(query, { now: NOW });
    assert.equal(window.start, Date.parse(start));
    assert.equal(window.end, Date.parse(end));
  });
}

test("window calendar edges and non-period controls", () => {
  assert.equal(typeof intent.queryTimeWindow, "function");
  assert.equal(intent.queryTimeWindow("last 1 month", { now: Date.parse("2024-03-31") }).start, Date.parse("2024-02-29"));
  assert.equal(intent.queryTimeWindow("last 1 day", { now: Date.parse("2026-01-01") }).start, Date.parse("2025-12-31"));
  assert.equal(intent.queryTimeWindow("this quarter", { now: Date.parse("2026-04-01") }).start, Date.parse("2026-04-01"));
  assert.equal(intent.queryTimeWindow("so far this month", { now: Date.parse("2024-02-29") }).end, Date.parse("2024-03-01"));
  for (const query of ["How many chairs?", "last 0 days", "past -2 days", "next 2 months", "last 1.5 days", "Q5 2025"]) {
    assert.equal(intent.queryTimeWindow(query, { now: NOW }), null, query);
  }
});
