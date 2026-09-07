/**
 * An empty outbox is not a populated index.
 *
 * Field run A drained a 13,869-chunk corpus and printed
 * "vector index is query-ready (0 confirmed)" between the second deploy and the
 * final probe: the queue was empty, so the only assertion in the way passed,
 * and the install declared success on an index holding nothing. Zero vectors
 * may only be ready when D1 requires zero.
 *
 * This file doubles as its own `--import` fixture so no network or credential
 * is needed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO = String(process.env.BRAIN_DRAIN_READY_SCENARIO || "");
const FIXTURE_ADMIN = "fixture-admin-label";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

const RECEIPTS = {
  // The run A shape: nothing queued, provider claims readiness, index is empty.
  "drain-empty-index": {
    drained: 0, submitted: 0, waiting: 0, remaining: 0, vector_ready: true,
    expected_vectors: 13869, actual_vectors: 0,
  },
  // A genuine completion: every chunk D1 requires is query-visible.
  "drain-complete": {
    drained: 5, submitted: 5, waiting: 0, remaining: 0, vector_ready: true,
    expected_vectors: 5, actual_vectors: 5,
  },
  // A brain with no corpus yet is legitimately ready at zero.
  "drain-empty-corpus": {
    drained: 0, submitted: 0, waiting: 0, remaining: 0, vector_ready: true,
    expected_vectors: 0, actual_vectors: 0,
  },
};

if (SCENARIO) {
  const userRoot = String(process.env.BRAIN_DRAIN_READY_USER_ROOT || "");
  if (!userRoot) throw new Error("BRAIN_DRAIN_READY_USER_ROOT is required");
  os.homedir = () => userRoot;
  syncBuiltinESMExports();

  globalThis.fetch = async (input, options = {}) => {
    const url = requestUrl(input);
    if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/drain") {
      if (new Headers(options.headers).get("X-Admin-Key") !== FIXTURE_ADMIN) {
        return json({ error: "fixture unauthorized" }, 401);
      }
      const receipt = RECEIPTS[SCENARIO];
      if (!receipt) throw new Error(`unknown fixture scenario: ${SCENARIO}`);
      return json(receipt);
    }
    if (url.hostname === "fixture.invalid" && url.pathname === "/health") {
      return json({ ok: true, version: "0.4.0" });
    }
    throw new Error(`unexpected fixture request: ${url.origin}${url.pathname}`);
  };
} else {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CLI = join(HERE, "..", "brain.mjs");
  const THIS_FILE = import.meta.url;
  let fail = 0;
  let ran = 0;
  const check = (name, condition, detail = "") => {
    ran++;
    console.log((condition ? "PASS  " : "FAIL  ") + name +
      (condition ? "" : "  " + String(detail).slice(0, 400)));
    if (!condition) fail++;
  };
  const strip = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

  function safeChildEnvironment() {
    const environment = {};
    for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

  function runScenario(scenario) {
    const directory = mkdtempSync(join(tmpdir(), "brain-drain-ready-gate-"));
    const userRoot = join(directory, "isolated-user-root");
    const manifestPath = join(directory, "fixture.manifest.json");
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture-brain" },
      brain: { domain: "fixture.invalid", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    }));
    const environment = {
      ...safeChildEnvironment(),
      BRAIN_DRAIN_READY_SCENARIO: scenario,
      BRAIN_DRAIN_READY_USER_ROOT: userRoot,
      ADMIN_KEY: FIXTURE_ADMIN,
    };
    const result = spawnSync(process.execPath, ["--import", THIS_FILE, CLI, "drain", manifestPath], {
      encoding: "utf-8",
      env: environment,
      timeout: 60_000,
    });
    const output = strip(`${result.stdout || ""}${result.stderr || ""}`);
    rmSync(directory, { recursive: true, force: true });
    return { code: result.status, output, error: result.error };
  }

  const emptyIndex = runScenario("drain-empty-index");
  check("an empty outbox over an empty index exits nonzero",
    emptyIndex.code === 1, `code=${emptyIndex.code} ${emptyIndex.output}`);
  check("the failure names both the 0 vectors held and the 13869 D1 requires",
    /Vectorize holds 0 vector\(s\)/.test(emptyIndex.output) &&
      /13869/.test(emptyIndex.output), emptyIndex.output);
  check("and says the index is empty rather than ready",
    /empty/i.test(emptyIndex.output) &&
      !/query-ready/.test(emptyIndex.output), emptyIndex.output);

  const complete = runScenario("drain-complete");
  check("a drain whose vectors match D1 still declares query readiness",
    complete.code === 0 && /vector index is query-ready/.test(complete.output),
    `code=${complete.code} ${complete.output}`);

  const emptyCorpus = runScenario("drain-empty-corpus");
  check("a brain with nothing to embed is still allowed to be ready",
    emptyCorpus.code === 0 && /vector index is query-ready/.test(emptyCorpus.output),
    `code=${emptyCorpus.code} ${emptyCorpus.output}`);

  console.log(`${ran - fail}/${ran} drain query-ready gate checks passed`);
  if (fail) process.exit(1);
}
