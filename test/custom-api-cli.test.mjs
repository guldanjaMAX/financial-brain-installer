import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cmdConnectCustomApi,
  cmdCustomApi,
  planLoad,
  workerBindings,
} from "../brain.mjs";

const TOKEN = ["fixture", "hidden", "value", "42"].join("-");

function manifest() {
  return {
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Fixture Owner" },
    brain: { version: "0.4.8", worker_name: "fixture-brain", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "a".repeat(32), d1_database_id: "db", vectorize_index: "index" } },
    corpora: {
      custom_api: {
        enabled: true,
        display_name: "store dashboard",
        source: "store-dashboard",
        base_url: "https://dashboard.invalid/api/",
        token_secret: "STORE_DASHBOARD_TOKEN",
        cadence_seconds: 86400,
        endpoints: [{
          name: "sales", path: "/sales", row_key: ["store", "period"],
          document: {
            group_by: ["store", "period"],
            title_template: "{{store}} {{period}} sales",
            body_template: "{{rows_table}}",
          },
        }],
      },
    },
  };
}

function withCapturedOutput(operation) {
  const priorLog = console.log;
  const priorError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  return Promise.resolve().then(operation).then(
    (value) => ({ value, output: lines.join("\n") }),
    (error) => { throw error; },
  ).finally(() => {
    console.log = priorLog;
    console.error = priorError;
  });
}

test("deploy binding contains declarative config and only the secret name", () => {
  const m = manifest();
  const bindings = workerBindings(m, m.infrastructure.cloudflare);
  const binding = bindings.find((item) => item.name === "CUSTOM_API_CONFIG");
  assert.ok(binding);
  assert.equal(binding.type, "plain_text");
  assert.equal(JSON.parse(binding.text).token_secret, "STORE_DASHBOARD_TOKEN");
  assert.equal(JSON.stringify(bindings).includes(TOKEN), false);
});

test("connect prompts hidden, writes the one declared Worker secret, verifies its name, and registers freshness", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  const names = new Set();
  const writes = [];
  const expectations = [];
  let prompts = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, {}, {
    listWorkerSecretNames: async () => [...names],
    putWorkerSecret: async (name, value) => { writes.push({ name, matches: value === TOKEN }); names.add(name); },
    readSecret: async () => { prompts++; return TOKEN; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async (_base, _key, body) => expectations.push(body),
  }));
  assert.equal(prompts, 1);
  assert.deepEqual(writes, [{ name: "STORE_DASHBOARD_TOKEN", matches: true }]);
  assert.deepEqual(expectations, [{ source: "store-dashboard", kind: "custom_api", expected_refresh_seconds: 86400 }]);
  assert.equal(result.value.written, true);
  assert.equal(result.output.includes(TOKEN), false);
});

test("connect does not prompt or rewrite an existing secret", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-existing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let prompts = 0;
  let writes = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, {}, {
    listWorkerSecretNames: async () => ["STORE_DASHBOARD_TOKEN"],
    putWorkerSecret: async () => { writes++; },
    readSecret: async () => { prompts++; return TOKEN; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(prompts, 0);
  assert.equal(writes, 0);
  assert.equal(result.value.written, false);
  assert.equal(result.output.includes(TOKEN), false);
});

test("manual dry run calls only the authenticated Brain route and renders aggregate output", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-run-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  const calls = [];
  const result = await withCapturedOutput(() => cmdCustomApi(path, { "dry-run": true }, {
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), method: init.method, body: JSON.parse(init.body), admin: new Headers(init.headers).get("X-Admin-Key") === "fixture-admin-key" });
      return new Response(JSON.stringify({
        status: "completed", dry_run: true, endpoints: 3,
        rows: { created: 2, updated: 1, unchanged: 4 }, documents: 2, retained_missing_rows: 1,
      }), { headers: { "content-type": "application/json" } });
    },
  }));
  assert.deepEqual(calls, [{
    url: "https://fixture.invalid/api/admin/brain/custom-api",
    method: "POST", body: { dry_run: true }, admin: true,
  }]);
  assert.equal(result.value.dry_run, true);
  assert.match(result.output, /2 new row\(s\), 1 corrected, 4 unchanged/);
  assert.match(result.output, /retained, not deleted/);
  assert.equal(result.output.includes(TOKEN), false);
});

test("brain load names the server-managed source without claiming it has no loader", async () => {
  const entries = await planLoad({
    m: manifest(),
    manifestPath: "/synthetic/brain.manifest.json",
    flags: {},
    platform: "linux",
  });
  const custom = entries.find((entry) => entry.key === "custom_api");
  assert.equal(custom.status, "skipped");
  assert.match(custom.reason, /Worker.*cron/i);
  assert.doesNotMatch(custom.reason, /no loader/i);
});
