import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectHandoffCheck,
  configuredHandoffSources,
  renderHandoffCheck,
} from "../operations/handoff-check.mjs";
import { cmdHandoffCheck } from "../brain.mjs";

let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const manifest = {
  corpora: {
    gmail: { enabled: true, source: "mail" },
    calendar: { enabled: true, source: "calendar" },
    imap: { enabled: false, source: "imap" },
  },
  operations: { handoff_out_of_scope_sources: ["calendar"] },
};

{
  const configured = configuredHandoffSources(manifest);
  check("the manifest is the only source of handoff scope",
    configured.in_scope.length === 1 && configured.in_scope[0].name === "mail" &&
      configured.out_of_scope.length === 1 && configured.out_of_scope[0].name === "calendar",
    JSON.stringify(configured));
}

{
  const root = mkdtempSync(join(tmpdir(), "brain-handoff-check-"));
  try {
    const manifestPath = join(root, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let output = "";
    let exitCode = null;
    const result = await cmdHandoffCheck(manifestPath, {
      flags: { json: true },
      readFreshness: async () => ({ sources: [{
        name: "mail", kind: "gmail", source_status: "ready", state: "ok", reason: null,
        schedule: {
          state: "waiting_second", installed: true, first_run_at: "2026-09-24T17:05:00.000Z",
          second_run_observed: false, next_run_at: "2026-09-24T18:05:00.000Z",
        },
      }] }),
      scheduleStatus: async () => ({ installed: true, last_error: null }),
      write: (value) => { output += value; },
      setExitCode: (value) => { exitCode = value; },
    });
    check("the public handoff-check command is read-only, machine-readable, and nonzero until complete",
      result.complete === false && JSON.parse(output).complete === false && exitCode === 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  let remoteReads = 0;
  let scheduleReads = 0;
  const result = await collectHandoffCheck("/fixture/brain.manifest.json", {
    manifest,
    readFreshness: async () => {
      remoteReads++;
      return { sources: [{
        name: "mail", kind: "gmail", source_status: "ready", state: "ok", reason: null,
        schedule: {
          state: "waiting_second", installed: true, first_run_at: "2026-09-24T17:05:00.000Z",
          second_run_observed: false, next_run_at: "2026-09-24T18:05:00.000Z",
        },
      }] };
    },
    scheduleStatus: async () => { scheduleReads++; return { installed: true, last_error: null }; },
  });
  const row = result.sources[0];
  check("handoff lists every required fact for an in-scope source",
    row.connected === true && row.schedule_installed === true && row.first_run === true &&
      row.second_run_observed === false && row.next_run === "2026-09-24T18:05:00.000Z" &&
      row.last_error === null,
    JSON.stringify(row));
  check("one observed run fails only after both read-only decisions were reached",
    result.complete === false && remoteReads === 1 && scheduleReads === 1);
  check("owner text says exactly what remains instead of calling install day done",
    /waiting for second run/i.test(renderHandoffCheck(result)) && /not ready/i.test(renderHandoffCheck(result)));
}

{
  let scheduleReads = 0;
  const result = await collectHandoffCheck("/fixture/brain.manifest.json", {
    manifest,
    readFreshness: async () => ({ sources: [{
      name: "mail", kind: "gmail", source_status: "ready", state: "ok", reason: null,
      schedule: {
        state: "proven", installed: true, first_run_at: "2026-09-24T16:05:00.000Z",
        second_run_observed: true, next_run_at: "2026-09-24T18:05:00.000Z",
      },
    }] }),
    scheduleStatus: async () => { scheduleReads++; return { installed: false, last_error: null }; },
  });
  check("server proof cannot hide a missing local schedule",
    result.complete === false && result.sources[0].green === false && scheduleReads === 1,
    JSON.stringify(result));
}

{
  const result = await collectHandoffCheck("/fixture/brain.manifest.json", {
    manifest,
    readFreshness: async () => ({ sources: [{
      name: "mail", kind: "gmail", source_status: "ready", state: "ok", reason: null,
      schedule: {
        state: "proven", installed: true, first_run_at: "2026-09-24T16:05:00.000Z",
        second_run_observed: true, next_run_at: "2026-09-24T18:05:00.000Z",
      },
    }] }),
    scheduleStatus: async () => ({ installed: true, last_error: null }),
  });
  check("install day becomes complete only when every in-scope source is green",
    result.complete === true && result.sources.every((source) => source.green), JSON.stringify(result));
}

console.log(`\nhandoff check: all ${ran} checks passed`);
