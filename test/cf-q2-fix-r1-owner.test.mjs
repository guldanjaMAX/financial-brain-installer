import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "brain.mjs");
const version = JSON.parse(readFileSync(join(root, "package.json"))).version;
const accountId = "a".repeat(32);
const profile = `financial-brain-${"b".repeat(24)}`;
const help = code => `https://financialbrain.ai/help/${code}`;

// Run the actual dispatcher and final owner renderer. Only provider transport
// and OAuth credential acquisition are fixtures; native/network escapes die
// through the shared tripwire, including credential and scheduler helpers.
function ownerRun(arm) {
  const home = mkdtempSync(join(tmpdir(), "q2-owner-"));
  const manifestPath = join(home, "fixture.manifest.json");
  const manifest = {
    client: { slug: "fixture", display_name: "Owner" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: { cloudflare: {
      account_id: accountId, storage: "d1", d1_database_id: "fixture-db",
      vectorize_index: "fixture-brain", drain_cron: "* * * * *",
      ...(arm.startsWith("oauth") ? { auth_profile: profile } : {}),
    } },
    operations: { admin_key_file: join(home, ".brain-admin-key") },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(home, ".brain-admin-key"), ["fixture", "admin", "value"].join("-"), { mode: 0o600 });
  const preload = join(home, "provider.mjs");
  const trace = join(home, "trace.json");
  const oauth = new URL("../operations/cloudflare-oauth-session.mjs", import.meta.url).href;
  writeFileSync(preload, `
    import { writeFileSync } from "node:fs";
    import { registerHooks } from "node:module";
    const arm = ${JSON.stringify(arm)};
    const accountId = ${JSON.stringify(accountId)};
    const calls = [];
    let label = "existing-label";
    let registered = false;
    const credential = ["fixture", "opaque", "credential", "value"].join("-");
    if (!arm.startsWith("oauth")) process.env.CLOUDFLARE_API_TOKEN = credential;
    const response = (result, status = 200, code = 0, message = "") => new Response(JSON.stringify({
      success: status === 200, result, errors: status === 200 ? [] : [{ code, message }],
    }), { status });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init.method || "GET";
      calls.push({ path, method });
      writeFileSync(${JSON.stringify(trace)}, JSON.stringify(calls));
      if (path === "/health") {
        if (url.hostname !== "fixture-brain." + label + ".workers.dev") throw new Error("unexpected health host");
        return new Response(JSON.stringify({ brain: "fixture", version: ${JSON.stringify(version)} }));
      }
      if (path.endsWith("/workers/subdomain")) {
        if (method === "PUT") {
          label = JSON.parse(init.body).subdomain;
          registered = true;
          return response({});
        }
        if (arm === "token-500") return response(null, 500, 10001, "Internal error " + credential);
        if (arm.endsWith("403")) return response(null, 403, 10000, "Account policy blocks this operation " + credential);
        if ((arm === "token-missing" && !registered) || arm === "oauth-missing") return response(null, 404, 10007, "No subdomain registered");
        return response({ subdomain: label });
      }
      if (path === "/client/v4/accounts") return response([{ id: accountId, name: "Owner account" }]);
      if (path === "/client/v4/accounts/" + accountId) return response({ id: accountId, name: "Owner account" });
      if (path.endsWith("/workers/scripts/fixture-brain") && method === "PUT") return response({});
      if (path.endsWith("/workers/scripts/fixture-brain/subdomain") && method === "POST") return response({ enabled: true });
      if (path.endsWith("/workers/scripts/fixture-brain/schedules") && method === "GET") return response([{ cron: "* * * * *" }]);
      if (arm.startsWith("oauth") && method === "GET" && ["/workers/scripts", "/d1/database", "/vectorize/v2/indexes", "/ai/models/search"].some(suffix => path.endsWith(suffix))) return response([]);
      throw new Error("unexpected fixture request");
    };
    if (arm.startsWith("oauth")) {
      const original = ${JSON.stringify(`${oauth}?q2-original`)};
      registerHooks({ load(url, context, nextLoad) {
        if (url !== ${JSON.stringify(oauth)}) return nextLoad(url, context);
        return { format: "module", shortCircuit: true, source:
          'export * from ' + JSON.stringify(original) + ';' +
          'import { preflightCloudflareOAuthAccount } from ' + JSON.stringify(original) + ';' +
          'export async function withCloudflareOAuthSession(options) {' +
          'const token = Buffer.from(["fixture", "opaque", "credential", "value"].join("-"));' +
          'try { const account = { id: ' + JSON.stringify(accountId) + ', name: "Owner account" };' +
          'const preflight = await preflightCloudflareOAuthAccount(token, account, { fetchImpl: globalThis.fetch });' +
          'return await options.action({ token, account, profile: options.profile, preflight });' +
          '} finally { token.fill(0); } }'
        };
      } });
    }
  `);
  try {
    const imports = ["cli-side-effect-tripwire.mjs", "support-journal-acl-preload.mjs"].flatMap(name => [
      "--import", new URL(`./fixtures/${name}`, import.meta.url).href,
    ]);
    const run = spawnSync(process.execPath, [...imports, "--import", pathToFileURL(preload).href, cli, "deploy", manifestPath], {
      cwd: home, encoding: "utf8", timeout: 30_000,
      env: cliTestEnvironment(home, {
        BRAIN_TEST_CHAIN: "1",
        BRAIN_TEST_LAUNCHCTL: process.env.BRAIN_TEST_LAUNCHCTL,
      }),
    });
    const output = `${run.stdout || ""}${run.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(run.error, undefined, "child must complete within its bound");
    assert.notEqual(run.status, 86, "host-action tripwire must stay quiet");
    assert.doesNotMatch(output, /TEST_SIDE_EFFECT_BLOCKED|unexpected fixture request|unexpected health host/);
    assert.ok(!output.includes(["fixture", "opaque", "credential", "value"].join("-")), "provider echo must be masked in final output");
    return {
      status: run.status, output,
      calls: JSON.parse(readFileSync(trace, "utf8")),
      saved: JSON.parse(readFileSync(manifestPath, "utf8")),
    };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function subdomainMethods(run) {
  return run.calls.filter(call => call.path.endsWith("/workers/subdomain")).map(call => call.method);
}
function reachedDeployedRoute(run) {
  assert.ok(run.calls.some(call => call.method === "PUT" && call.path.endsWith("/workers/scripts/fixture-brain")), "Worker upload must be reached");
  assert.ok(run.calls.some(call => call.method === "POST" && call.path.endsWith("/workers/scripts/fixture-brain/subdomain")), "route enablement must be reached");
}

test("owner GET 500 reports masked provider reason, stable read code and help without a PUT", () => {
  const run = ownerRun("token-500");
  reachedDeployedRoute(run);
  assert.deepEqual(subdomainMethods(run), ["GET"]);
  assert.equal(run.status, 1);
  assert.equal(run.saved.brain.domain, undefined);
  assert.match(run.output, /Internal error/);
  assert.match(run.output, /Issue: REMOTE_UNAVAILABLE/);
  assert.ok(run.output.includes(help("REMOTE_UNAVAILABLE")));
  assert.doesNotMatch(run.output, /Issue: CLOUDFLARE_WORKERS_SUBDOMAIN_REGISTER_FAILED/);
});

test("owner existing-label control verifies identity and persists address without a PUT", () => {
  const run = ownerRun("token-existing");
  reachedDeployedRoute(run);
  assert.deepEqual(subdomainMethods(run), ["GET"]);
  assert.equal(run.status, 0, run.output);
  assert.ok(run.calls.some(call => call.path === "/health"));
  assert.equal(run.saved.brain.domain, "fixture-brain.existing-label.workers.dev");
  assert.match(run.output, /confirmed .* is this brain and saved it/);
});

test("owner 404/10007 control still reserves, reads back, verifies and persists", () => {
  const run = ownerRun("token-missing");
  reachedDeployedRoute(run);
  assert.deepEqual(subdomainMethods(run), ["GET", "PUT", "GET"]);
  assert.equal(run.status, 0, run.output);
  assert.ok(run.calls.some(call => call.path === "/health"));
  assert.match(run.saved.brain.domain, /^fixture-brain\.[a-z]+-[a-z]+-\d{4}\.workers\.dev$/);
  assert.equal((run.output.match(/Web address reserved/g) || []).length, 1);
});

for (const arm of ["token-403", "oauth-403"]) test(`owner ${arm} keeps the masked provider reason and help`, () => {
  const run = ownerRun(arm);
  assert.deepEqual(subdomainMethods(run), ["GET"]);
  if (arm === "token-403") reachedDeployedRoute(run);
  assert.equal(run.status, 1);
  assert.equal(run.saved.brain.domain, undefined);
  assert.match(run.output, /Account policy blocks this operation/);
  assert.ok(run.output.includes(help("REMOTE_PERMISSION_DENIED")));
});

test("owner routine OAuth 404/10007 points to installer recovery and help without a PUT", () => {
  const run = ownerRun("oauth-missing");
  assert.deepEqual(subdomainMethods(run), ["GET"]);
  assert.equal(run.status, 1);
  assert.equal(run.saved.brain.domain, undefined);
  assert.match(run.output, /installer.*resume address setup/i);
  assert.ok(run.output.includes(help("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED")));
  assert.doesNotMatch(run.output, /In the Cloudflare dashboard, open Workers & Pages/);
});

test("owner OAuth successful-read control reaches the deploy action and address persistence", () => {
  const run = ownerRun("oauth-existing");
  reachedDeployedRoute(run);
  assert.deepEqual(subdomainMethods(run), ["GET"]);
  assert.equal(run.status, 0, run.output);
  assert.ok(run.calls.some(call => call.path === "/health"));
  assert.equal(run.saved.brain.domain, "fixture-brain.existing-label.workers.dev");
});
