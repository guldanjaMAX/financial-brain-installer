/**
 * --dry-run must still evaluate the missing-scanner-file gate.
 *
 * WHY THIS EXISTS. When the credential scanner's policy changes, every file
 * this source loaded before has to be reread so the new scanner can judge
 * it -- and a file the resume state still lists that is no longer under the
 * folder cannot be rechecked at all. A real run refuses outright rather than
 * guess (brain.mjs, cmdIngestLocalRun: `missingScannerKeys`). That refusal
 * used to be wrapped in `if (!dry && ...)`, so a dry run walked straight
 * past it and reported nothing unusual -- the one command an owner runs to
 * preview what a real run will do said nothing about the abort the real run
 * would hit. This proves both directions: a dry run now warns, names the
 * count, gives the same remedy, and still finishes without touching
 * anything or asking for a credential; a real run still refuses exactly as
 * before.
 *
 * Every identifier here is a fictional fixture; none names a real source.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdIngestLocal } from "../brain.mjs";
import { canonicalSourceIngestStatePath } from "../operations/source-ingest-lock.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

async function captureLogs(run) {
  const lines = [];
  const prior = console.log;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    const value = await run();
    return { value, error: null, lines };
  } catch (error) {
    return { value: undefined, error, lines };
  } finally {
    console.log = prior;
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "brain-folder-dry-run-gate-"));
try {
  const manifestDir = join(sandbox, "client");
  const watched = join(sandbox, "watched folder");
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(watched, { recursive: true });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const manifest = {
    client: { slug: "fixture-client" },
    brain: { domain: "fixture-brain.invalid" },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // The folder is empty on disk right now, but the resume state remembers a
  // file this source loaded before -- and carries no credential-scanner
  // fingerprint at all, so `scannerPolicyChanged` is true the same way an
  // upgrade from a pre-0.4.0 state file is (undefined !== <hash>). Together
  // that is exactly "a previously-indexed file the current scanner cannot
  // recheck safely".
  const statePath = canonicalSourceIngestStatePath({ manifestPath, sourceName: "upload" });
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    done: { "missing-file.txt": "fixture-hash-not-a-real-document" },
    skipped: {},
  }, null, 2));

  /* --------------------------------------------------------- dry run */
  {
    const flags = { path: watched, "dry-run": true };
    const { value, error, lines } = await captureLogs(() => cmdIngestLocal(manifest, manifestPath, flags, {}));
    const joined = lines.join("\n");

    check("a dry run does not die on the missing-file gate", error === null, String(error?.message || error));
    check("the dry run still returns/completes normally", value !== undefined || error === null);
    check("the dry run prints a WARNING naming the exact missing-file count",
      /WARNING: 1 previously-indexed file\(s\) are not present under this folder/.test(joined), joined);
    check("the dry run states a real run would stop here",
      /a real run \(without --dry-run\) would stop here/i.test(joined), joined);
    check("the dry run keeps the same remedy text as the real refusal",
      /forget this source explicitly before replacing it/.test(joined), joined);
    check("the dry run is explicit that nothing was removed BY THIS dry run",
      /nothing was removed by this dry run/i.test(joined), joined);
  }

  /* -------------------------------------------------------- real run */
  {
    const flags = { path: watched };
    const lockCalls = [];
    const options = {
      resolveAdminKey: () => "fixture-admin-key-0000000000000000",
      withSourceIngestLock: async (lockOptions, task) => {
        lockCalls.push(lockOptions);
        return task({ assertOwned: () => true });
      },
    };
    const { error, lines } = await captureLogs(() => cmdIngestLocal(manifest, manifestPath, flags, options));
    const joined = lines.join("\n");

    check("a real run still dies on the missing-file gate", error !== null, "expected cmdIngestLocal to reject");
    check("the real refusal names the exact missing-file count",
      /1 previously-indexed file\(s\) are not present under this folder, so the current scanner cannot recheck them safely/
        .test(String(error?.message || "")), String(error?.message || ""));
    check("the real refusal is not phrased as the dry run's WARNING",
      !/^WARNING:/m.test(String(error?.message || "")) && !/a real run \(without --dry-run\)/i.test(String(error?.message || "")),
      String(error?.message || ""));
    check("the real run actually took the source ingest lock (it is not accidentally treated as a dry run)",
      lockCalls.length > 0, JSON.stringify(lockCalls));
    check("no stray WARNING about the missing file leaked into the real run's own log",
      !/WARNING: 1 previously-indexed file\(s\)/.test(joined), joined);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
