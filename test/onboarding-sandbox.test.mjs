import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DOCUMENT_JOURNEY_OUTCOMES,
  DOCUMENT_JOURNEY_STAGES,
  SANDBOX_SCENARIOS,
  assertNoFrontendEnvironmentFiles,
  documentJourneyHtml,
  documentJourneyStatuses,
  injectRehearsalBanner,
  launchOnboardingFixture,
  onboardingGuideHtml,
  onboardingSandboxEnvironment,
  openBrowser,
  prepareFrontend,
  runOnboardingSmoke,
  sandboxScenarioFromReferer,
  verifyOnboardingSmoke,
} from "../scripts/onboarding-sandbox.mjs";
import { ownerThinkResponse } from "../frontend/test/rehearsal-responses.mjs";
import { visualFixtureServer } from "../frontend/test/visual-server.mjs";

const SENTINEL = "must-not-reach-rehearsal-child";

function plantedEnvironment() {
  return {
    PATH: "/safe/bin",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\safe-temp",
    TMP: "C:\\safe-temp",
    HOME: "/safe/home",
    USERPROFILE: "C:\\Users\\Safe",
    APPDATA: "C:\\Users\\Safe\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Safe\\AppData\\Local",
    LANG: "en_US.UTF-8",
    ADMIN_KEY: SENTINEL,
    CLOUDFLARE_API_TOKEN: SENTINEL,
    GOOGLE_CLIENT_SECRET: SENTINEL,
    ANTHROPIC_API_KEY: SENTINEL,
    NODE_AUTH_TOKEN: SENTINEL,
    NPM_TOKEN: SENTINEL,
    npm_config__authToken: SENTINEL,
    npm_config_registry: SENTINEL,
    VITE_PRIVATE_TOKEN: SENTINEL,
    VITE_ADMIN_KEY: SENTINEL,
    BRAIN_VISUAL_PORT: SENTINEL,
  };
}

function assertCredentialFree(environment, { fixturePort = null, npm = false } = {}) {
  assert.equal(JSON.stringify(environment).includes(SENTINEL), false);
  for (const name of [
    "ADMIN_KEY", "CLOUDFLARE_API_TOKEN", "GOOGLE_CLIENT_SECRET", "ANTHROPIC_API_KEY",
    "NODE_AUTH_TOKEN", "NPM_TOKEN", "npm_config__authToken", "npm_config_registry",
    "VITE_PRIVATE_TOKEN", "VITE_ADMIN_KEY",
  ]) assert.equal(environment[name], undefined, `${name} reached a child`);
  assert.equal(environment.PATH, "/safe/bin");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.TEMP, "C:\\safe-temp");
  assert.equal(environment.HOME, "/safe/home");
  assert.equal(environment.LOCALAPPDATA, "C:\\Users\\Safe\\AppData\\Local");
  if (fixturePort !== null) assert.equal(environment.BRAIN_VISUAL_PORT, String(fixturePort));
  else assert.equal(environment.BRAIN_VISUAL_PORT, undefined);
  if (npm) {
    assert.equal(environment.NPM_CONFIG_USERCONFIG, "NUL");
    assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, "\\\\.\\NUL");
  } else {
    assert.equal(environment.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, undefined);
  }
}

test("the rehearsal starts with an unmistakable local-only safety screen", () => {
  const html = onboardingGuideHtml({ appOrigin: "http://127.0.0.1:4176" });
  for (const phrase of [
    "LOCAL REHEARSAL",
    "SYNTHETIC DATA",
    "Nothing is deployed",
    "does not prove Cloudflare",
    "Close this terminal",
  ]) assert.match(html, new RegExp(phrase, "i"));
  assert.equal((html.match(/class="card"/g) || []).length, SANDBOX_SCENARIOS.length);
  assert.match(html, /state=signin#enroll=local-rehearsal-only/);
  assert.match(html, /state=document-enrollment#document-enroll=doc_local-rehearsal-only/);
  assert.match(html, /state=financial-map&amp;view=financial-map/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4176\/document-journey"/);
  assert.doesNotMatch(html, /api[_-]?key|client[_-]?secret|app[_-]?password/i);
});

test("every actual workspace screen receives the persistent rehearsal banner", () => {
  for (const scenario of SANDBOX_SCENARIOS) {
    const result = injectRehearsalBanner("<!doctype html><body><div id=\"root\"></div></body>", scenario.id);
    assert.match(result, /LOCAL REHEARSAL · SYNTHETIC DATA/);
    assert.match(result, new RegExp(`SCENARIO: ${scenario.label}`));
    assert.match(result, /NO ACCOUNTS CONNECTED/);
    assert.equal((result.match(/LOCAL REHEARSAL/g) || []).length, 1);
    assert.match(result, /<div id="root"><\/div>/);
  }
  assert.doesNotMatch(injectRehearsalBanner("<body></body>", "<script>unsafe</script>"), /unsafe/);
});

test("the mock scenario follows the app page that initiated the API call", () => {
  const base = "http://127.0.0.1:4176";
  assert.equal(sandboxScenarioFromReferer(`${base}/app?state=degraded`, base), "degraded");
  assert.equal(sandboxScenarioFromReferer(`${base}/app?state=grant-unavailable`, base), "grant-unavailable");
  assert.equal(sandboxScenarioFromReferer("not a url", base), "populated");
});

test("healthy-empty stays empty when the owner moves from Home to Explore", () => {
  const empty = ownerThinkResponse("empty", "mesa-coffee");
  assert.equal(empty.answer, null);
  assert.equal(empty.status, "no_results");
  assert.deepEqual(empty.citations, []);
  assert.deepEqual(empty.results, []);
  assert.equal(empty.confidence, undefined);

  const populated = ownerThinkResponse("populated", "mesa-coffee");
  assert.match(populated.answer, /confirmed cash figure/);
  assert.equal(populated.confidence.percent, 86);
  assert.equal(populated.citations.length, 1);
});

test("the scenario menu covers happy, empty, unavailable, retry, conflict, and scoped-access states", () => {
  const ids = new Set(SANDBOX_SCENARIOS.map((scenario) => scenario.id));
  for (const id of ["populated", "financial-map", "document-journey", "empty", "zero-entities", "partial", "degraded", "conflict", "idempotent", "owner-access", "grant", "grant-unavailable", "signin", "document-enrollment"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test("owner-created guest access is directly discoverable from the rehearsal menu", () => {
  const html = onboardingGuideHtml({ appOrigin: "http://127.0.0.1:4176" });
  assert.match(html, /Owner creates guest access/);
  assert.match(html, /state=owner-access&amp;view=access/);
  assert.match(html, /every real-install requirement explained/);
});

test("the rehearsal child environment is a credential-free allowlist", () => {
  const safe = onboardingSandboxEnvironment(plantedEnvironment(), { platform: "win32" });
  assertCredentialFree(safe);
  assert.deepEqual(Object.keys(safe).sort(), [
    "APPDATA", "HOME", "LANG", "LOCALAPPDATA", "PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE",
  ].sort());
});

test("npm uses distinct null-device paths for both user and global configuration", () => {
  const mac = onboardingSandboxEnvironment(plantedEnvironment(), { npm: true, platform: "darwin" });
  assert.equal(mac.NPM_CONFIG_USERCONFIG, "/dev/null");
  assert.equal(mac.NPM_CONFIG_GLOBALCONFIG, "/dev/fd/0");
  assert.notEqual(mac.NPM_CONFIG_USERCONFIG, mac.NPM_CONFIG_GLOBALCONFIG);
  assert.equal(JSON.stringify(mac).includes(SENTINEL), false);

  const linux = onboardingSandboxEnvironment(plantedEnvironment(), { npm: true, platform: "linux" });
  assert.equal(linux.NPM_CONFIG_USERCONFIG, "/dev/null");
  assert.equal(linux.NPM_CONFIG_GLOBALCONFIG, "/proc/self/fd/0");
  assert.notEqual(linux.NPM_CONFIG_USERCONFIG, linux.NPM_CONFIG_GLOBALCONFIG);
  assert.equal(JSON.stringify(linux).includes(SENTINEL), false);
});

test("the rehearsal refuses any frontend .env file before a child can start", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-onboarding-sandbox-env-file-"));
  const frontend = join(root, "frontend");
  const privateName = ".env.local";
  mkdirSync(frontend, { recursive: true });
  writeFileSync(join(frontend, privateName), SENTINEL);
  let calls = 0;
  try {
    assert.throws(
      () => prepareFrontend({
        root,
        npmExecPath: null,
        environment: plantedEnvironment(),
        run: () => { calls += 1; },
      }),
      (error) => /refuses frontend environment files/.test(error.message) &&
        !error.message.includes(privateName) && !error.message.includes(SENTINEL),
    );
    assert.equal(calls, 0);
    assert.throws(() => assertNoFrontendEnvironmentFiles(frontend), /refuses frontend environment files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rehearsal launches Vite through Node instead of a platform shell shim", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-onboarding-sandbox-"));
  const vite = join(root, "frontend", "node_modules", "vite", "bin", "vite.js");
  mkdirSync(join(root, "frontend", "node_modules", "vite", "bin"), { recursive: true });
  writeFileSync(vite, "// synthetic vite entrypoint\n");
  const calls = [];
  try {
    prepareFrontend({
      root,
      npmExecPath: null,
      environment: plantedEnvironment(),
      platform: "win32",
      run: (...args) => calls.push(args),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], process.execPath);
    assert.deepEqual(calls[0][1], [vite, "build"]);
    assert.equal(calls[0][2].cwd, join(root, "frontend"));
    assertCredentialFree(calls[0][2].env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm, the fixture, and browser launch each receive only their explicit safe environment", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-onboarding-sandbox-env-"));
  const npmCli = join(root, "npm-cli.js");
  mkdirSync(join(root, "frontend"), { recursive: true });
  writeFileSync(npmCli, "// synthetic npm entrypoint\n");
  const buildCalls = [];
  try {
    prepareFrontend({
      root,
      npmExecPath: npmCli,
      resolveNpmCli: () => npmCli,
      environment: plantedEnvironment(),
      platform: "win32",
      run: (...args) => buildCalls.push(args),
    });
    assert.equal(buildCalls.length, 2);
    assert.equal(buildCalls[0][0], process.execPath);
    assert.deepEqual(buildCalls[0][1], [npmCli, "ci", "--ignore-scripts"]);
    assertCredentialFree(buildCalls[0][2].env, { npm: true });
    assert.deepEqual(buildCalls[0][2].stdio, ["ignore", "inherit", "inherit"]);
    assertCredentialFree(buildCalls[1][2].env);

    let fixtureCall;
    launchOnboardingFixture({
      root,
      frontend: join(root, "frontend"),
      fixturePort: 43117,
      environment: plantedEnvironment(),
      platform: "win32",
      spawnChild: (command, args, options) => {
        fixtureCall = { command, args, options };
        return { stdout: null };
      },
    });
    assert.equal(fixtureCall.command, process.execPath);
    assertCredentialFree(fixtureCall.options.env, { fixturePort: 43117 });

    let browserCall;
    openBrowser("http://127.0.0.1:43116/", {
      environment: plantedEnvironment(),
      platform: "win32",
      spawnChild: (command, args, options) => {
        browserCall = { command, args, options };
        return { unref() {} };
      },
    });
    assert.equal(browserCall.command, "cmd");
    assert.deepEqual(browserCall.args, ["/c", "start", "", "http://127.0.0.1:43116/"]);
    assertCredentialFree(browserCall.options.env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend preparation explains its separate download and quiet wait before npm starts", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-onboarding-sandbox-notice-"));
  const npmCli = join(root, "npm-cli.js");
  const messages = [];
  mkdirSync(join(root, "frontend"), { recursive: true });
  writeFileSync(npmCli, "// synthetic npm entrypoint\n");
  try {
    prepareFrontend({
      root,
      npmExecPath: npmCli,
      resolveNpmCli: () => npmCli,
      environment: plantedEnvironment(),
      platform: "win32",
      log: (message) => messages.push(message),
      run: () => {},
    });
    assert.equal(messages.length, 3);
    const notice = messages.join(" ");
    assert.match(notice, /additional small set of public UI packages/i);
    assert.match(notice, /No account credential is used/i);
    assert.match(notice, /quiet for several minutes/i);
    assert.match(notice, /leave this window open/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bounded smoke verifier checks the guide, app banner, and synthetic owner API", async () => {
  const origin = "http://127.0.0.1:43116";
  const requests = [];
  const receipt = await verifyOnboardingSmoke(origin, {
    fetchRequest: async (url, options) => {
      requests.push({ url, options });
      const path = new URL(url).pathname;
      if (path === "/") return new Response("LOCAL REHEARSAL SYNTHETIC DATA state=populated", { status: 200 });
      if (path === "/app") return new Response('<body>LOCAL REHEARSAL · SYNTHETIC DATA · SCENARIO: Normal owner workspace · NO ACCOUNTS CONNECTED<div id="root"></div></body>', { status: 200 });
      return new Response(JSON.stringify({ signed_in: true, principal: { kind: "owner" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(receipt, { ok: true, checks: ["guide", "app", "synthetic_api"] });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.headers.referer, `${origin}/app?state=populated`);
});

test("smoke always closes its sandbox and replaces raw failures with a stable code", async () => {
  let closed = 0;
  await assert.rejects(
    runOnboardingSmoke({
      start: async (options) => {
        assert.equal(options.open, false);
        assert.equal(options.quiet, true);
        return { origin: "http://127.0.0.1:43116", close: async () => { closed += 1; } };
      },
      verify: async () => { throw new Error(SENTINEL); },
    }),
    (error) => error.smokeCode === "verification_failed" && !error.message.includes(SENTINEL),
  );
  assert.equal(closed, 1);
});

test("Windows CI runs the exact npm.cmd no-browser smoke on Node 22 and 24", () => {
  const root = join(import.meta.dirname, "..");
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /os: \[windows-latest, macos-latest, ubuntu-latest\]/);
  assert.match(workflow, /node: \['22', '24'\]/);
  assert.match(workflow, /if:.*runner\.os == 'Windows'/);
  assert.match(workflow, /npm\.cmd run rehearse:onboarding -- --smoke --no-open/);
});

test("the Windows owner guide requires a fresh clean checkout and exact SHA equality", () => {
  const root = join(import.meta.dirname, "..");
  const guide = readFileSync(join(root, "onboarding", "11-windows-onboarding-rehearsal.md"), "utf8");
  const launcher = readFileSync(join(root, "onboarding", "start-windows-rehearsal.ps1"), "utf8");
  assert.equal((guide.match(/^````text$/gm) || []).length, 1);
  assert.equal((guide.match(/^````$/gm) || []).length, 1);
  assert.equal((guide.match(/^```powershell$/gm) || []).length, 2);
  assert.match(guide, /new empty folder/i);
  assert.match(guide, /start-windows-rehearsal\.ps1/);
  assert.match(guide, /one command/i);
  assert.match(guide, /can be quiet for several minutes/i);
  assert.match(guide, /Do not run `npm ci`/i);
  assert.match(guide, /Terminate batch job \(Y\/N\)\?/);
  assert.match(guide, /npm\.cmd run rehearse:onboarding/);

  for (const renderedGuide of [guide, guide.replace(/\r?\n/g, "\r\n")]) {
    const powerShellBlocks = [...renderedGuide.matchAll(/```powershell\r?\n([\s\S]*?)```/g)];
    assert.equal(powerShellBlocks[0][1].trim().split(/\r?\n/).length, 1,
      "the owner launcher must remain one copy-safe command with LF or CRLF");
    assert.match(powerShellBlocks[0][1], /-ExpectedSha "<EXACT 40-CHARACTER LOWERCASE SHA FROM THE TECHNICIAN>"/);
  }

  assert.match(launcher, /WindowsBuiltInRole\]::Administrator/);
  assert.match(launcher, /OrdinalIgnoreCase/);
  assert.match(launcher, /rev-parse HEAD/);
  assert.match(launcher, /status --porcelain=v1 --untracked-files=all/);
  assert.match(launcher, /nodeVersion\.Major -lt 22/);
  assert.match(launcher, /scripts\\onboarding-sandbox\.mjs/);
  assert.match(launcher, /quiet for several minutes/i);
  assert.match(launcher, /Do not run npm ci or any npm command yourself/i);
  assert.match(launcher, /Local-only synthetic data: confirmed/i);
  for (const nextAction of [
    /Install Git for Windows.*open a new normal PowerShell window/is,
    /Ask your technician to resend the exact SHA/is,
    /ask the technician to confirm the repository link and exact SHA/is,
    /Install Node\.js 22 or newer.*open a new normal PowerShell window/is,
    /ask the technician for a fresh reviewed repository link and exact SHA/is,
  ]) assert.match(launcher, nextAction);
  assert.doesNotMatch(launcher, /npm(?:\.cmd)?\s+run\s+rehearse:onboarding/i);
  assert.doesNotMatch(launcher, /Set-Location|\bcd\b/i,
    "the launcher must refuse a wrong current directory instead of changing it");
});

test("synthetic owner actions have intentional receipts and the entity-add rehearsal completes", async () => {
  await new Promise((resolveListen, rejectListen) => {
    visualFixtureServer.once("error", rejectListen);
    visualFixtureServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = visualFixtureServer.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (path, body, state) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      referer: `${origin}/app?state=${state}`,
    },
    body: JSON.stringify(body),
  });
  try {
    const initialMe = await fetch(`${origin}/api/app/me`, { headers: { referer: `${origin}/app?state=owner-access` } });
    assert.equal(initialMe.status, 200);
    const initialOwner = await initialMe.json();
    assert.equal(initialOwner.connections[0].name, "Claude remote connector (Librarian)");
    assert.equal(initialOwner.connections[0].can_write, false);

    const bankBoundary = await fetch(`${origin}/app/connect/bank?mode=reauthorise&item_ref=must-not-be-echoed`);
    assert.equal(bankBoundary.status, 200);
    const bankBoundaryHtml = await bankBoundary.text();
    assert.match(bankBoundaryHtml, /Bank controls are unavailable in this rehearsal/i);
    assert.match(bankBoundaryHtml, /No bank is connected, no provider was contacted/i);
    assert.match(bankBoundaryHtml, /Bank feeds remain outside ordinary onboarding/i);
    assert.match(bankBoundaryHtml, /Back to the synthetic Access screen/i);
    assert.doesNotMatch(bankBoundaryHtml, /must-not-be-echoed|HTTP 404|not found/i);

    const entityRequest = {
      request_id: "entity-fixture-request",
      entity_slug: "fixture-advisory",
      legal_name: "Fixture Advisory LLC",
      kind: "business",
    };
    const created = await post("/api/owner/entities/create", entityRequest, "zero-entities");
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      request_id: entityRequest.request_id,
      entity_scope: { entity_slug: entityRequest.entity_slug },
      entity: {
        entity_slug: entityRequest.entity_slug,
        legal_name: entityRequest.legal_name,
        kind: entityRequest.kind,
      },
      changed: true,
      replayed: false,
    });
    const replay = await post("/api/owner/entities/create", entityRequest, "zero-entities");
    assert.equal(replay.status, 200);
    const replayReceipt = await replay.json();
    assert.equal(replayReceipt.changed, false);
    assert.equal(replayReceipt.replayed, true);

    const refreshed = await post("/api/fin/snapshot", {
      sections: ["entities", "accounts", "obligations", "cash"],
      entity_slug: entityRequest.entity_slug,
    }, "zero-entities");
    assert.equal(refreshed.status, 200);
    const snapshot = await refreshed.json();
    assert.equal(snapshot.entities.length, 1);
    assert.equal(snapshot.entities[0].entity_slug, entityRequest.entity_slug);
    assert.deepEqual(snapshot.accounts, []);
    assert.deepEqual(snapshot.obligations, []);
    assert.equal(snapshot.obligation_exposure.obligations_total, 0);
    assert.equal(snapshot.obligation_exposure.balance_minor, null);
    assert.equal(snapshot.cash.total_minor, null);
    assert.equal(snapshot.cash.complete, false);

    const renamed = await post("/api/app/devices/rename", { credential_id: "device", nickname: "Office PC" }, "owner-access");
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).renamed, true);

    const kept = await post("/api/app/devices/revoke", { credential_id: "device" }, "owner-access");
    assert.equal(kept.status, 200);
    assert.match((await kept.json()).reason, /add and verify another owner passkey/i);

    const disconnected = await post("/api/app/connections/revoke", { client_id: "app" }, "owner-access");
    assert.equal(disconnected.status, 200);
    assert.deepEqual(await disconnected.json(), { revoked: true, client_id: "app", changed: true });

    for (const [path, body, expected] of [
      ["/api/bank-feed/disconnect", { item_ref: "bank" }, /Nothing was disconnected.*real Brain/is],
      ["/api/app/signout", {}, /Nothing was signed out.*press Control-C once/is],
      ["/api/app/signout-all", {}, /Nothing was signed out or disconnected.*real Brain/is],
    ]) {
      const stopped = await post(path, body, "owner-access");
      assert.equal(stopped.status, 409);
      const stoppedBody = await stopped.json();
      assert.equal(stoppedBody.code, "rehearsal_stop");
      assert.match(stoppedBody.error, expected);
      assert.doesNotMatch(stoppedBody.error, /HTTP 404|not found/i);
    }

    const me = await fetch(`${origin}/api/app/me`, { headers: { referer: `${origin}/app?state=owner-access` } });
    assert.equal(me.status, 200);
    const owner = await me.json();
    assert.equal(owner.devices[0].nickname, "Office PC");
    assert.deepEqual(owner.connections, []);
  } finally {
    await new Promise((resolveClose) => visualFixtureServer.close(resolveClose));
  }
});

test("the document journey names all four separate proof checkpoints", () => {
  assert.deepEqual(DOCUMENT_JOURNEY_STAGES.map(({ label }) => label), [
    "Accepted", "Stored", "Projected", "Query-visible",
  ]);
  const html = documentJourneyHtml();
  for (const label of DOCUMENT_JOURNEY_STAGES.map(({ label }) => label)) {
    assert.match(html, new RegExp(`<h2>${label}</h2>`));
  }
  for (const phrase of [
    "TEACHING ONLY", "SYNTHETIC DATA", "NO LIVE SYSTEM CHECKED",
    "SCENARIO: Document processing journey", "NO ACCOUNTS CONNECTED",
    "None of these cards proves", "pieces of text", "never opens a passkey prompt",
    "same approved item", "expected logical D1 family", "chunks",
    "source and extraction provenance", "original file or binary",
    "copied or backed up", "does not prove projection or query visibility",
  ]) assert.match(html, new RegExp(phrase, "i"));
  assert.doesNotMatch(html, /navigator\.credentials|PublicKeyCredential|webauthn/i);
});

test("every document checkpoint can independently rehearse pending and unavailable", () => {
  for (const { id } of DOCUMENT_JOURNEY_STAGES) {
    for (const outcome of DOCUMENT_JOURNEY_OUTCOMES.filter((value) => value !== "ready")) {
      const statuses = documentJourneyStatuses(`${id}=${outcome}`);
      assert.equal(statuses[id], outcome, `${id} did not retain ${outcome}`);
      for (const { id: otherId } of DOCUMENT_JOURNEY_STAGES) {
        if (otherId !== id) assert.equal(statuses[otherId], "ready", `${otherId} was coupled to ${id}`);
      }
      const html = documentJourneyHtml({ searchParams: `${id}=${outcome}` });
      assert.match(html, new RegExp(`data-stage="${id}" data-outcome="${outcome}"`));
    }
  }
  assert.deepEqual(documentJourneyStatuses("accepted=unknown&stored=maybe"), {
    accepted: "ready", stored: "ready", projected: "ready", "query-visible": "ready",
  });
});
