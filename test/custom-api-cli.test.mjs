import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearCustomApiClipboard,
  readCustomApiClipboard,
} from "../operations/custom-api-clipboard.mjs";
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
            fields: ["store", "period", "net_sales"],
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

function withCapturedFailure(operation) {
  const priorLog = console.log;
  const priorError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  return Promise.resolve().then(operation).then(
    () => { throw new Error("expected operation to fail"); },
    (error) => ({ error, output: lines.join("\n") }),
  ).finally(() => {
    console.log = priorLog;
    console.error = priorError;
  });
}

test("the public manifest defaults match the full-snapshot real feed", () => {
  const template = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
  const installGuide = readFileSync(new URL("../onboarding/12-custom-api-source-setup.md", import.meta.url), "utf8");
  const custom = template.corpora.custom_api;
  assert.equal(custom.timeout_ms, 30_000);
  assert.ok(custom.max_response_bytes >= 5 * 1024 * 1024);
  assert.equal(custom.max_rows, 10_000);
  assert.deepEqual(custom.endpoints.map(({ name, path, row_key }) => ({ name, path, row_key })), [
    { name: "sales", path: "/sales", row_key: ["store", "period", "revenue_stream"] },
    { name: "inventory", path: "/inventory", row_key: ["store", "breed"] },
    { name: "costs", path: "/costs", row_key: ["store", "breed"] },
  ]);
  assert.deepEqual(custom.endpoints[0].documents[0].expected_values.revenue_stream, [
    "live_animal", "supplies", "services", "other",
  ]);
  assert.deepEqual(custom.endpoints[0].documents.map(({ name, group_by }) => ({ name, group_by })), [
    { name: "monthly", group_by: ["period"] },
    { name: "store-history", group_by: ["store"] },
  ]);
  assert.match(custom.endpoints[0].documents[0].body_template, /missing\.revenue_stream/);
  assert.deepEqual(custom.endpoints.slice(1).map((endpoint) => endpoint.document.group_by), [["store"], ["store"]]);
  const schemaCustom = schema.properties.corpora.properties.custom_api.properties;
  assert.equal(schemaCustom.timeout_ms.default, 30_000);
  assert.ok(schemaCustom.max_response_bytes.default >= 5 * 1024 * 1024);
  assert.equal(schemaCustom.max_rows.default, 10_000);
  assert.match(installGuide, /clipboard history is already off in Card Q/i);
  assert.match(installGuide, /--from-clipboard/);
  assert.match(installGuide, /--key-set-in-dashboard/);
});

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
  let inventories = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, {}, {
    listWorkerSecretNames: async () => { inventories++; return ["STORE_DASHBOARD_TOKEN"]; },
    putWorkerSecret: async () => { writes++; },
    readSecret: async () => { prompts++; return TOKEN; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(prompts, 0);
  assert.equal(writes, 0);
  assert.equal(inventories, 1, "the existing-name inventory decision point was reached");
  assert.equal(result.value.written, false);
  assert.equal(result.output.includes(TOKEN), false);
});

test("clipboard mode clears exactly once when the initial secret inventory fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-clipboard-inventory-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let inventories = 0;
  let reads = 0;
  let writes = 0;
  let clears = 0;
  const result = await withCapturedFailure(() => cmdConnectCustomApi(path, { "from-clipboard": true }, {
    platform: "darwin",
    listWorkerSecretNames: async () => { inventories++; throw new Error("synthetic inventory failure"); },
    putWorkerSecret: async () => { writes++; },
    readClipboard: async () => { reads++; return TOKEN; },
    clearClipboard: async () => { clears++; },
  }));
  assert.equal(inventories, 1, "the failing inventory decision point was reached");
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(clears, 1, "the copied value was cleared across the pre-read failure");
  assert.equal(result.error.message.includes(TOKEN), false);
  assert.equal(result.output.includes(TOKEN), false);
});

test("clipboard mode clears exactly once when the declared secret already exists", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-clipboard-existing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let inventories = 0;
  let reads = 0;
  let writes = 0;
  let clears = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, { "from-clipboard": true }, {
    platform: "darwin",
    listWorkerSecretNames: async () => { inventories++; return ["STORE_DASHBOARD_TOKEN"]; },
    putWorkerSecret: async () => { writes++; },
    readClipboard: async () => { reads++; return TOKEN; },
    clearClipboard: async () => { clears++; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(inventories, 1, "the already-present decision point was reached");
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(clears, 1, "the copied value was cleared even though no write was needed");
  assert.equal(result.output.includes(TOKEN), false);
});

test("Windows defaults to clipboard entry, writes only the declared secret, clears, and verifies its name", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-windows-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  const calls = [];
  let prompts = 0;
  let inventories = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, {}, {
    platform: "win32",
    listWorkerSecretNames: async () => {
      inventories++;
      return inventories >= 2 ? ["STORE_DASHBOARD_TOKEN"] : [];
    },
    putWorkerSecret: async (name, value) => calls.push({ kind: "write", name, matches: value === TOKEN }),
    readClipboard: async () => { calls.push({ kind: "read" }); return `\r\n  ${TOKEN}  \r\n`; },
    clearClipboard: async () => { calls.push({ kind: "clear" }); },
    readSecret: async () => { prompts++; return TOKEN; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(prompts, 0, "the Windows branch never attempted a terminal prompt");
  assert.deepEqual(calls, [
    { kind: "read" },
    { kind: "write", name: "STORE_DASHBOARD_TOKEN", matches: true },
    { kind: "clear" },
  ]);
  assert.equal(inventories, 2, "the declared name was re-read after the clipboard write");
  assert.match(result.output, /^Store key saved in your Brain and cleared from the clipboard\.$/m);
  assert.equal(result.output.includes(TOKEN), false);
});

test("macOS supports explicit clipboard entry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-macos-clipboard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  const names = new Set();
  let reads = 0;
  let clears = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, { "from-clipboard": true }, {
    platform: "darwin",
    listWorkerSecretNames: async () => [...names],
    putWorkerSecret: async (name, value) => {
      assert.equal(value, TOKEN);
      names.add(name);
    },
    readClipboard: async () => { reads++; return TOKEN; },
    clearClipboard: async () => { clears++; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(reads, 1);
  assert.equal(clears, 1);
  assert.equal(result.value.written, true);
  assert.match(result.output, /^Store key saved in your Brain and cleared from the clipboard\.$/m);
  assert.equal(result.output.includes(TOKEN), false);
});

test("native clipboard commands use captured no-shell processes and scrub the child environment", () => {
  const windowsCalls = [];
  const windowsSpawn = (command, args, options) => {
    windowsCalls.push({ command, args, options });
    return { status: 0, signal: null, stdout: args.at(-1).startsWith("Get-") ? TOKEN : "", stderr: "" };
  };
  const environment = { PATH: "fixture-path", HOME: "/fixture-home", PRIVATE_FIXTURE: TOKEN };
  assert.equal(readCustomApiClipboard({ platform: "win32", spawn: windowsSpawn, environment }), TOKEN);
  clearCustomApiClipboard({ platform: "win32", spawn: windowsSpawn, environment });
  assert.deepEqual(windowsCalls.map(({ command, args }) => ({ command, args })), [
    {
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
    },
    {
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $null"],
    },
  ]);
  for (const { options } of windowsCalls) {
    assert.equal(options.shell, false);
    assert.equal(options.env.PRIVATE_FIXTURE, undefined);
    assert.equal(JSON.stringify(options).includes(TOKEN), false);
  }

  const macCalls = [];
  const macSpawn = (command, args, options) => {
    macCalls.push({ command, args, options });
    return { status: 0, signal: null, stdout: command === "pbpaste" ? TOKEN : "", stderr: "" };
  };
  assert.equal(readCustomApiClipboard({ platform: "darwin", spawn: macSpawn, environment }), TOKEN);
  clearCustomApiClipboard({ platform: "darwin", spawn: macSpawn, environment });
  assert.deepEqual(macCalls.map(({ command, args }) => ({ command, args })), [
    { command: "pbpaste", args: [] },
    { command: "pbcopy", args: [] },
  ]);
  assert.equal(macCalls[0].options.shell, false);
  assert.equal(macCalls[1].options.shell, false);
  assert.equal(macCalls[1].options.input, "");
  assert.deepEqual(macCalls[1].options.stdio, ["pipe", "ignore", "pipe"]);
  assert.equal(JSON.stringify(macCalls.map(({ options }) => options)).includes(TOKEN), false);
});

test("a clipboard read failure gives copy-and-retry guidance plus the dashboard fallback", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-clipboard-read-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let inventories = 0;
  let reads = 0;
  let writes = 0;
  let clears = 0;
  const result = await withCapturedFailure(() => cmdConnectCustomApi(path, { "from-clipboard": true }, {
    platform: "darwin",
    listWorkerSecretNames: async () => { inventories++; return []; },
    putWorkerSecret: async () => { writes++; },
    readClipboard: async () => { reads++; throw new Error("synthetic clipboard failure"); },
    clearClipboard: async () => { clears++; throw new Error("synthetic clear failure"); },
  }));
  assert.equal(inventories, 1, "the absent-name decision point was reached");
  assert.equal(reads, 1, "the clipboard-read decision point was reached");
  assert.equal(writes, 0);
  assert.equal(clears, 1, "clipboard clearing was attempted after the read failure");
  assert.match(result.error.message, /copy the key from the email.*same command again.*--key-set-in-dashboard/is);
  assert.match(result.error.message, /clipboard.*could not be cleared.*clear it manually/is);
  assert.equal(result.error.message.includes(TOKEN), false);
  assert.equal(result.output.includes(TOKEN), false);
});

test("clipboard is cleared when the Worker secret write fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-clipboard-write-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let inventories = 0;
  let writes = 0;
  let clears = 0;
  const result = await withCapturedFailure(() => cmdConnectCustomApi(path, { "from-clipboard": true }, {
    platform: "darwin",
    listWorkerSecretNames: async () => { inventories++; return []; },
    putWorkerSecret: async (_name, value) => { writes++; assert.equal(value, TOKEN); throw new Error("synthetic write failure"); },
    readClipboard: async () => TOKEN,
    clearClipboard: async () => { clears++; },
  }));
  assert.equal(inventories, 1, "the absent-name decision point was reached");
  assert.equal(writes, 1, "the Worker secret write decision point was reached");
  assert.equal(clears, 1, "the clipboard was cleared in the write-failure path");
  assert.match(result.error.message, /could not be written.*value was not printed or saved locally/i);
  assert.equal(result.error.message.includes(TOKEN), false);
  assert.equal(result.output.includes(TOKEN), false);
});

for (const [label, clipboard, expected] of [
  ["empty", " \r\n ", /copy the key from the email.*same command again.*--key-set-in-dashboard/is],
  ["multiple lines", `${TOKEN}\nsecond-line`, /more than one line.*nothing was stored/i],
  ["prose", "this is a sentence, not a key", /looks like prose.*nothing was stored/i],
  ["more than 2,048 bytes", "x".repeat(2_049), /1 to 2,048 printable ASCII bytes.*nothing was stored/i],
  ["non-ASCII text", "fixture-é", /1 to 2,048 printable ASCII bytes.*nothing was stored/i],
]) {
  test(`clipboard entry refuses ${label} input without writing`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `brain-custom-api-clipboard-${label.replaceAll(" ", "-")}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "brain.manifest.json");
    writeFileSync(path, JSON.stringify(manifest()));
    let inventories = 0;
    let reads = 0;
    let writes = 0;
    let clears = 0;
    const result = await withCapturedFailure(() => cmdConnectCustomApi(path, { "from-clipboard": true }, {
      platform: "darwin",
      listWorkerSecretNames: async () => { inventories++; return []; },
      putWorkerSecret: async () => { writes++; },
      readClipboard: async () => { reads++; return clipboard; },
      clearClipboard: async () => { clears++; },
    }));
    assert.equal(inventories, 1, "the absent-name decision point was reached");
    assert.equal(reads, 1, "the clipboard-read decision point was reached");
    assert.equal(writes, 0);
    assert.equal(clears, 1, "rejected clipboard content was cleared");
    assert.match(result.error.message, expected);
    assert.equal(result.error.message.includes(TOKEN), false);
    assert.equal(result.output.includes(TOKEN), false);
  });
}

test("the dashboard flag remains an explicit fallback on Windows", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-windows-dashboard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let reads = 0;
  let writes = 0;
  let inventories = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, { "key-set-in-dashboard": true }, {
    platform: "win32",
    listWorkerSecretNames: async () => {
      inventories++;
      return inventories >= 2 ? ["STORE_DASHBOARD_TOKEN"] : [];
    },
    putWorkerSecret: async () => { writes++; },
    readClipboard: async () => { reads++; return TOKEN; },
    sleep: async () => {},
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(inventories, 2, "the declared name was re-read after dashboard entry");
  assert.match(result.output, /Workers & Pages.*fixture-brain.*Settings.*Variables and Secrets.*Add.*Secret/s);
  assert.match(result.output, /STORE_DASHBOARD_TOKEN/);
});

test("dashboard replacement requires a positive post-paste confirmation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-dashboard-replacement-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let inventories = 0;
  let confirmations = 0;
  let writes = 0;
  const result = await withCapturedOutput(() => cmdConnectCustomApi(path, {
    "replace-key": true,
    "key-set-in-dashboard": true,
  }, {
    platform: "win32",
    listWorkerSecretNames: async () => { inventories++; return ["STORE_DASHBOARD_TOKEN"]; },
    confirmDashboardReplacement: async () => { confirmations++; return "REPLACED"; },
    putWorkerSecret: async () => { writes++; },
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    postSourceExpectation: async () => {},
  }));
  assert.equal(confirmations, 1, "the replacement confirmation decision point was reached");
  assert.equal(inventories, 2, "the confirmed replacement name was read back after the ceremony");
  assert.equal(writes, 0);
  assert.match(result.output, /replacement.*confirmed/i);
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
        refused_rows: 1,
        next_pull_at: "2026-09-25T15:30:00.000Z",
        endpoint_results: [
          { name: "sales", rows_received: 5, rows_refused: 1, documents: 2, body_unchanged: false },
          { name: "inventory", rows_received: 1, rows_refused: 0, documents: 0, body_unchanged: true },
          { name: "costs", rows_received: 1, rows_refused: 0, documents: 0, body_unchanged: true },
        ],
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
  assert.match(result.output, /sales: 5 row\(s\), 2 readable document\(s\) would be written, 1 refused/);
  assert.match(result.output, /inventory: 1 row\(s\), 0 readable document\(s\) would be written, 0 refused/);
  assert.match(result.output, /If run now, the next daily pull will run at 2026-09-25T15:30:00.000Z/);
  assert.equal(result.output.includes(TOKEN), false);
});

test("manual pull resumes bounded calls to terminal saved proof and reports meaning readiness separately", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "brain-custom-api-resume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  let calls = 0;
  const result = await withCapturedOutput(() => cmdCustomApi(path, {}, {
    resolveAdminKey: () => "fixture-admin-key",
    resolveBaseUrl: async () => "https://fixture.invalid",
    fetchImpl: async () => {
      calls++;
      const body = calls < 3
        ? { status: "in_progress", job_phase: calls === 1 ? "staged" : "applying", slice_completed: calls - 1, slices_total: 2 }
        : {
          status: "completed", dry_run: false, endpoints: 1,
          rows: { created: 1, updated: 0, unchanged: 0 }, documents: 1,
          retained_missing_rows: 0, refused_rows: 0, saved: true, meaning_search_ready: false,
          job_id: "job-fixture", next_pull_at: "2026-09-25T15:30:00.000Z",
          endpoint_results: [{ name: "sales", rows_received: 1, rows_refused: 0, documents: 1 }],
        };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  }));
  assert.equal(calls, 3, "the CLI kept calling one bounded Worker slice at a time");
  assert.equal(result.value.saved, true);
  assert.match(result.output, /1 of 2 slice\(s\) verified/);
  assert.match(result.output, /saved snapshot verified/);
  assert.match(result.output, /meaning search is still indexing/i);
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
