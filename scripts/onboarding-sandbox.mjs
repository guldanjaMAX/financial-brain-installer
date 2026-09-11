#!/usr/bin/env node
/**
 * Launch the real owner-workspace bundle against synthetic local responses.
 *
 * This is deliberately a source-checkout QA tool, not a pretend Cloudflare
 * install. It makes no network request after optional frontend dependency
 * installation, reads no manifest or OS credential store, and cannot connect a
 * customer account. The browser is proxied through a safety page that labels
 * every app screen as a local rehearsal.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const CHILD_TIMEOUT_MS = 120_000;

// A rehearsal never needs provider, deployment, model, Vite, or npm credentials.
// Keep this list intentionally small: these values are only the operating-system
// paths and locale needed to start Node, npm, Vite, and the user's browser.
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "Path",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL",
]);

export const SANDBOX_SCENARIOS = Object.freeze([
  { id: "populated", label: "Normal owner workspace", proof: "Real UI with synthetic populated records" },
  { id: "financial-map", label: "Owner Financial Map review", proof: "Complete synthetic map, prior changes, unresolved items, and passkey context" },
  { id: "document-journey", label: "Document processing journey", proof: "Teaching view of accepted, stored, projected, and query-visible states" },
  { id: "signin", label: "First passkey screen", proof: "Visual rehearsal only, no physical ceremony" },
  { id: "empty", label: "Healthy empty Brain", proof: "Shows the difference between empty and unavailable" },
  { id: "partial", label: "Partial financial evidence", proof: "One section unavailable while the rest remains usable" },
  { id: "degraded", label: "Degraded services", proof: "Unavailable data stays explicit and never becomes zero" },
  { id: "conflict", label: "Conflicting owner action", proof: "A stale decision or reused request ID refuses safely" },
  { id: "idempotent", label: "Lost-response retry", proof: "The same action receipt replays without a second change" },
  { id: "grant", label: "Exact-document guest", proof: "Guest navigation exposes only Documents and Explore" },
  { id: "grant-unavailable", label: "Guest search degraded", proof: "No unauthorized result and no false healthy-empty answer" },
]);

export const DOCUMENT_JOURNEY_STAGES = Object.freeze([
  {
    id: "accepted",
    label: "Accepted",
    description: "The source handed the document to the Brain and the Brain accepted it for processing. This alone does not prove durable storage.",
  },
  {
    id: "stored",
    label: "Stored",
    description: "The same approved item is represented as the expected logical D1 family with chunks and source and extraction provenance. This does not mean the original file or binary was copied or backed up, and it does not prove projection or query visibility.",
  },
  {
    id: "projected",
    label: "Projected",
    description: "Readable pieces of text have been prepared for search. This alone does not prove that an independent query can find them.",
  },
  {
    id: "query-visible",
    label: "Query-visible",
    description: "An independent search can retrieve the expected text. This is the stage that proves the document is visible to search.",
  },
]);

export const DOCUMENT_JOURNEY_OUTCOMES = Object.freeze(["ready", "pending", "unavailable"]);

function journeyParams(value) {
  if (value instanceof URLSearchParams) return value;
  if (typeof value === "string") return new URLSearchParams(value);
  if (value && typeof value === "object") return new URLSearchParams(Object.entries(value));
  return new URLSearchParams();
}

export function documentJourneyStatuses(value) {
  const params = journeyParams(value);
  return Object.fromEntries(DOCUMENT_JOURNEY_STAGES.map(({ id }) => {
    const requested = params.get(id);
    return [id, DOCUMENT_JOURNEY_OUTCOMES.includes(requested) ? requested : "ready"];
  }));
}

function journeyHref(statuses, stageId, outcome) {
  const params = new URLSearchParams(statuses);
  params.set(stageId, outcome);
  return `/document-journey?${params.toString()}`;
}

export function documentJourneyHtml({ searchParams } = {}) {
  const statuses = documentJourneyStatuses(searchParams);
  const cards = DOCUMENT_JOURNEY_STAGES.map((stage, index) => {
    const outcome = statuses[stage.id];
    const choices = DOCUMENT_JOURNEY_OUTCOMES.map((choice) => {
      const active = choice === outcome;
      return `<a class="choice${active ? " active" : ""}" href="${esc(journeyHref(statuses, stage.id, choice))}"${active ? ' aria-current="true"' : ""}>${esc(choice)}</a>`;
    }).join("");
    return `<article class="stage" data-stage="${esc(stage.id)}" data-outcome="${esc(outcome)}"><div class="step">${index + 1}</div><div class="stage-copy"><div class="stage-top"><h2>${esc(stage.label)}</h2><span class="status ${esc(outcome)}">${esc(outcome)}</span></div><p>${esc(stage.description)}</p><div class="choices" aria-label="Choose a teaching state for ${esc(stage.label)}">${choices}</div></div></article>`;
  }).join('<div class="arrow" aria-hidden="true">↓</div>');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic document journey</title>
  <style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171a24;background:#f4f5f8}*{box-sizing:border-box}body{margin:0}.wrap{max-width:880px;margin:0 auto;padding:40px 20px 72px}.flag{display:inline-flex;padding:8px 12px;border-radius:999px;background:#fff0d9;color:#784000;font-size:12px;font-weight:850;letter-spacing:.07em}.hero{margin:18px 0 24px;background:#12141a;color:#fff;border-radius:24px;padding:30px;box-shadow:0 20px 60px #17204a20}.hero h1{font-size:clamp(30px,6vw,48px);letter-spacing:-.035em;margin:0 0 12px}.hero p{color:#c8cedc;line-height:1.6;margin:0;max-width:710px}.boundary{margin:0 0 24px;padding:16px 18px;border:1px solid #efc474;background:#fff9ec;border-radius:16px;line-height:1.5}.stage{display:flex;gap:16px;background:#fff;border:1px solid #dfe2ea;border-radius:18px;padding:20px}.step{display:grid;place-items:center;flex:0 0 34px;height:34px;border-radius:10px;background:#ebefff;color:#334fc0;font-weight:850}.stage-copy{min-width:0;flex:1}.stage-top{display:flex;align-items:center;justify-content:space-between;gap:12px}.stage h2{font-size:21px;margin:2px 0 8px}.stage p{color:#5f6675;line-height:1.55;margin:0}.status{border-radius:999px;padding:5px 9px;font-size:12px;font-weight:800;text-transform:capitalize}.status.ready{background:#dff6e8;color:#17663a}.status.pending{background:#fff0d9;color:#7a4300}.status.unavailable{background:#fee5e5;color:#8b2626}.choices{display:flex;flex-wrap:wrap;gap:7px;margin-top:15px}.choice{padding:7px 10px;border:1px solid #d8dce7;border-radius:9px;color:#464e60;text-decoration:none;font-size:13px;text-transform:capitalize}.choice:hover,.choice:focus-visible{border-color:#6680ed;outline:none}.choice.active{border-color:#6680ed;background:#eef1ff;color:#263f9e;font-weight:750}.arrow{text-align:center;color:#99a0af;font-size:20px;height:28px;line-height:28px}.foot{margin-top:24px;color:#62697a;font-size:14px;line-height:1.55}.home{color:#334fc0}@media(max-width:520px){.wrap{padding:24px 14px 48px}.hero{padding:24px 20px;border-radius:20px}.stage{padding:17px 15px}.stage-top{align-items:flex-start}.choices{gap:6px}}
  </style><body><main class="wrap"><span class="flag">TEACHING ONLY · SYNTHETIC DATA · NO LIVE SYSTEM CHECKED</span><section class="hero"><h1>How one document becomes searchable</h1><p>These are four separate checkpoints. Accepted is not the same as stored, stored is not the same as projected, and projected is not the same as query-visible.</p></section><div class="boundary"><strong>Proof boundary:</strong> every status on this page is invented for rehearsal. None of these cards proves that a provider, a Brain, or a document is live. Use the controls to rehearse each checkpoint as ready, pending, or unavailable.</div><section aria-label="Synthetic document processing stages">${cards}</section><p class="foot"><a class="home" href="/">Back to all rehearsal scenarios</a>. Changing a teaching state makes no request to a provider or Brain, stores nothing, and never opens a passkey prompt.</p></main></body></html>`;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function onboardingGuideHtml({ appOrigin }) {
  const cards = SANDBOX_SCENARIOS.map((scenario, index) => {
    const fragment = scenario.id === "signin" ? "#enroll=local-rehearsal-only" : "";
    const view = scenario.id === "financial-map" ? "&view=financial-map" : "";
    const href = scenario.id === "document-journey"
      ? `${appOrigin}/document-journey`
      : `${appOrigin}/app?state=${encodeURIComponent(scenario.id)}${view}${fragment}`;
    return `<a class="card" href="${esc(href)}"><span>${index + 1}</span><div><strong>${esc(scenario.label)}</strong><p>${esc(scenario.proof)}</p></div></a>`;
  }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Financial Brain local rehearsal</title>
  <style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#161923;background:#f4f5f8}*{box-sizing:border-box}body{margin:0}.wrap{max-width:920px;margin:0 auto;padding:48px 20px 72px}.flag{display:inline-flex;padding:7px 11px;border-radius:999px;background:#fff0d9;color:#7d4300;font-size:12px;font-weight:800;letter-spacing:.08em}.hero{background:#12141a;color:white;border-radius:24px;padding:32px;margin:18px 0 24px;box-shadow:0 20px 60px #17204a20}.hero h1{font-size:clamp(30px,6vw,52px);letter-spacing:-.04em;margin:0 0 12px}.hero p{color:#c2c8d8;line-height:1.6;max-width:700px;margin:0}.notice{border:1px solid #f0c67e;background:#fff9ec;border-radius:16px;padding:16px 18px;line-height:1.5;margin-bottom:24px}.grid{display:grid;gap:12px}.card{display:flex;gap:14px;align-items:flex-start;text-decoration:none;color:inherit;background:white;border:1px solid #dfe2ea;border-radius:16px;padding:18px;transition:.15s}.card:hover{transform:translateY(-1px);border-color:#6680ed;box-shadow:0 10px 30px #17204a12}.card span{display:grid;place-items:center;min-width:30px;height:30px;border-radius:9px;background:#ebefff;color:#334fc0;font-weight:800}.card strong{display:block;margin:2px 0 5px}.card p{margin:0;color:#62697a;line-height:1.45}.foot{color:#62697a;font-size:14px;line-height:1.5;margin-top:24px}
  </style><body><main class="wrap"><span class="flag">LOCAL REHEARSAL · SYNTHETIC DATA</span><section class="hero"><h1>See the Brain before connecting anything.</h1><p>This launches the actual owner-workspace bundle with invented records. Click through every important state safely. Nothing is deployed, no account is contacted, and no credential is requested.</p></section><div class="notice"><strong>Proof boundary:</strong> this proves layout, navigation, response contracts, and error handling. It does not prove Cloudflare, OAuth consent, a real mailbox, Zoom delivery, or a physical passkey.</div><section class="grid">${cards}</section><p class="foot">Close this terminal or press Control-C when finished. The sandbox keeps no user data and stops with the terminal.</p></main></body></html>`;
}

export function injectRehearsalBanner(html) {
  const banner = '<div role="status" style="position:sticky;top:0;z-index:9999;padding:9px 16px;background:#fff0d9;color:#6f3c00;border-bottom:1px solid #e9be73;text-align:center;font:700 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.06em">LOCAL REHEARSAL · SYNTHETIC DATA · NO ACCOUNTS CONNECTED</div>';
  return String(html).replace("<body>", `<body>${banner}`);
}

export function sandboxScenarioFromReferer(referer, base) {
  try { return new URL(referer || base, base).searchParams.get("state") || "populated"; }
  catch { return "populated"; }
}

export function onboardingSandboxEnvironment(environment = process.env, {
  fixturePort = null,
  npm = false,
  platform = process.platform,
} = {}) {
  const clean = {};
  for (const name of CHILD_ENVIRONMENT_KEYS) {
    if (typeof environment?.[name] === "string" && environment[name]) clean[name] = environment[name];
  }
  if (npm) {
    // Public rehearsal dependencies need no registry identity. Point npm's user
    // and global config reads at distinct names for the platform null device.
    // npm rejects loading the exact same path twice, so the second name resolves
    // to fd 0 on POSIX (which is always ignored for this child) or Windows NUL.
    clean.NPM_CONFIG_USERCONFIG = platform === "win32" ? "NUL" : "/dev/null";
    clean.NPM_CONFIG_GLOBALCONFIG = platform === "win32"
      ? "\\\\.\\NUL"
      : platform === "darwin" ? "/dev/fd/0" : "/proc/self/fd/0";
  }
  if (fixturePort !== null) clean.BRAIN_VISUAL_PORT = String(fixturePort);
  return clean;
}

export function assertNoFrontendEnvironmentFiles(frontend) {
  let entries;
  try { entries = readdirSync(frontend, { withFileTypes: true }); }
  catch { throw new Error("the local rehearsal frontend could not be inspected"); }
  if (entries.some((entry) => entry.name.startsWith(".env"))) {
    // Keep the name and contents private. Smoke mode reduces this again to its
    // stable start_failed receipt.
    throw new Error("the local rehearsal refuses frontend environment files");
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    timeout: CHILD_TIMEOUT_MS,
    ...options,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error("the local rehearsal build timed out");
  if (result.error) throw new Error("the local rehearsal build could not start");
  if (result.status !== 0) throw new Error("the local rehearsal dependency or build step failed");
}

export function prepareFrontend({
  root = ROOT,
  run = runChecked,
  npmExecPath = process.env.npm_execpath,
  environment = process.env,
  platform = process.platform,
  stdio = "inherit",
} = {}) {
  const frontend = join(root, "frontend");
  const vite = join(frontend, "node_modules", "vite", "bin", "vite.js");
  assertNoFrontendEnvironmentFiles(frontend);
  if (!existsSync(vite)) {
    console.log("Installing the local UI test dependencies. No account credential is used.");
    const npmEnvironment = onboardingSandboxEnvironment(environment, { npm: true, platform });
    if (npmExecPath && existsSync(npmExecPath)) {
      run(process.execPath, [npmExecPath, "ci", "--ignore-scripts"], {
        cwd: frontend,
        env: npmEnvironment,
        stdio: stdio === "inherit" ? ["ignore", "inherit", "inherit"] : stdio,
      });
    } else {
      run(platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], {
        cwd: frontend,
        env: npmEnvironment,
        stdio: stdio === "inherit" ? ["ignore", "inherit", "inherit"] : stdio,
      });
    }
  }
  // Run Vite directly. `npm run build` also folds the result into the committed
  // Worker asset module, which a local rehearsal must not rewrite.
  assertNoFrontendEnvironmentFiles(frontend);
  run(process.execPath, [vite, "build"], {
    cwd: frontend,
    env: onboardingSandboxEnvironment(environment, { platform }),
    stdio,
  });
}

async function waitForFixture(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("the synthetic UI fixture exited before it became ready");
    try {
      const response = await fetch(`${origin}/app`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* fixture still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("the synthetic UI fixture did not become ready within 20 seconds");
}

async function proxyToFixture(request, response, fixtureOrigin, publicOrigin) {
  const incomingUrl = new URL(request.url || "/", publicOrigin);
  const scenario = sandboxScenarioFromReferer(request.headers.referer, publicOrigin);
  if (incomingUrl.pathname === "/api/app/me" && scenario === "signin") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ signed_in: false, owner: "Owner", brain: "Financial Brain rehearsal" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = { ...request.headers, host: new URL(fixtureOrigin).host };
  delete headers["content-length"];
  const upstream = await fetch(`${fixtureOrigin}${incomingUrl.pathname}${incomingUrl.search}`, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method || "GET") ? undefined : Buffer.concat(chunks),
    redirect: "manual",
  });
  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  let bytes = Buffer.from(await upstream.arrayBuffer());
  if (incomingUrl.pathname === "/app" && (upstream.headers.get("content-type") || "").includes("text/html")) {
    bytes = Buffer.from(injectRehearsalBanner(bytes.toString("utf8")), "utf8");
    delete responseHeaders["content-length"];
  }
  response.writeHead(upstream.status, responseHeaders);
  response.end(bytes);
}

export function openBrowser(url, {
  platform = process.platform,
  environment = process.env,
  spawnChild = spawn,
} = {}) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawnChild(command, args, {
    detached: true,
    stdio: "ignore",
    env: onboardingSandboxEnvironment(environment, { platform }),
  });
  child.unref();
}

export function launchOnboardingFixture({
  root = ROOT,
  frontend = FRONTEND,
  fixturePort,
  environment = process.env,
  platform = process.platform,
  spawnChild = spawn,
  quiet = false,
} = {}) {
  return spawnChild(process.execPath, [join(frontend, "test", "visual-server.mjs")], {
    cwd: root,
    env: onboardingSandboxEnvironment(environment, { fixturePort, platform }),
    stdio: quiet ? "ignore" : ["ignore", "pipe", "inherit"],
  });
}

export async function startOnboardingSandbox({
  host = "127.0.0.1",
  port = Number(process.env.BRAIN_ONBOARDING_PORT || 4176),
  fixturePort = Number(process.env.BRAIN_VISUAL_PORT || 4177),
  open = true,
  prepare = true,
  environment = process.env,
  platform = process.platform,
  spawnChild = spawn,
  quiet = false,
} = {}) {
  if (prepare) prepareFrontend({ environment, platform, stdio: quiet ? "ignore" : "inherit" });
  const fixture = launchOnboardingFixture({
    fixturePort,
    environment,
    platform,
    spawnChild,
    quiet,
  });
  fixture.stdout?.on("data", () => {});
  const fixtureOrigin = `http://${host}:${fixturePort}`;
  try {
    await waitForFixture(fixtureOrigin, fixture);
  } catch (error) {
    if (fixture.exitCode === null) fixture.kill("SIGTERM");
    throw error;
  }

  const publicOrigin = `http://${host}:${port}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", publicOrigin);
      if (url.pathname === "/" || url.pathname === "/rehearsal") {
        const html = onboardingGuideHtml({ appOrigin: publicOrigin });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html);
        return;
      }
      if (url.pathname === "/document-journey") {
        const html = documentJourneyHtml({ searchParams: url.searchParams });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html);
        return;
      }
      await proxyToFixture(request, response, fixtureOrigin, publicOrigin);
    } catch (error) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`Local rehearsal unavailable: ${error.message}`);
    }
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, resolveListen);
    });
  } catch (error) {
    if (fixture.exitCode === null) fixture.kill("SIGTERM");
    throw error;
  }
  if (!quiet) {
    console.log("");
    console.log("Financial Brain local onboarding rehearsal is ready:");
    console.log(`  ${publicOrigin}/`);
    console.log("");
    console.log("LOCAL REHEARSAL ONLY: synthetic data, no deployment, no accounts, no real passkey proof.");
    console.log("Press Control-C when finished.");
  }
  if (open) openBrowser(`${publicOrigin}/`, { platform, environment, spawnChild });

  const close = async () => {
    if (fixture.exitCode === null) fixture.kill("SIGTERM");
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  };
  return { server, fixture, origin: publicOrigin, close };
}

function smokeFailure(code) {
  const error = new Error(code);
  error.smokeCode = code;
  return error;
}

async function smokeFetch(fetchRequest, url, options = {}) {
  const { smokeCode = "request_unavailable", ...requestOptions } = options;
  try {
    return await fetchRequest(url, { ...requestOptions, signal: AbortSignal.timeout(5_000) });
  } catch {
    throw smokeFailure(smokeCode);
  }
}

export async function verifyOnboardingSmoke(origin, { fetchRequest = fetch } = {}) {
  const guideResponse = await smokeFetch(fetchRequest, `${origin}/`, { smokeCode: "guide_unavailable" });
  if (!guideResponse.ok) throw smokeFailure("guide_unavailable");
  const guide = await guideResponse.text();
  if (!guide.includes("LOCAL REHEARSAL") || !guide.includes("SYNTHETIC DATA") || !guide.includes("state=populated")) {
    throw smokeFailure("guide_contract_failed");
  }

  const appResponse = await smokeFetch(fetchRequest, `${origin}/app?state=populated`, { smokeCode: "app_unavailable" });
  if (!appResponse.ok) throw smokeFailure("app_unavailable");
  const app = await appResponse.text();
  if (!app.includes("LOCAL REHEARSAL · SYNTHETIC DATA · NO ACCOUNTS CONNECTED") || !app.includes('id="root"')) {
    throw smokeFailure("app_contract_failed");
  }

  const apiResponse = await smokeFetch(fetchRequest, `${origin}/api/app/me`, {
    smokeCode: "synthetic_api_unavailable",
    headers: { referer: `${origin}/app?state=populated` },
  });
  if (!apiResponse.ok) throw smokeFailure("synthetic_api_unavailable");
  let body;
  try { body = await apiResponse.json(); }
  catch { throw smokeFailure("synthetic_api_contract_failed"); }
  if (body?.signed_in !== true || body?.principal?.kind !== "owner") {
    throw smokeFailure("synthetic_api_contract_failed");
  }
  return Object.freeze({ ok: true, checks: Object.freeze(["guide", "app", "synthetic_api"]) });
}

export async function runOnboardingSmoke({
  start = startOnboardingSandbox,
  verify = verifyOnboardingSmoke,
} = {}) {
  let sandbox;
  let receipt;
  let failure = null;
  try {
    sandbox = await start({ open: false, quiet: true });
  } catch {
    failure = smokeFailure("start_failed");
  }
  if (sandbox) {
    try {
      receipt = await verify(sandbox.origin);
    } catch (error) {
      failure = smokeFailure(typeof error?.smokeCode === "string" ? error.smokeCode : "verification_failed");
    }
    try {
      await sandbox.close();
    } catch {
      if (!failure) failure = smokeFailure("shutdown_failed");
    }
  }
  if (failure) throw failure;
  return receipt;
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  const noOpen = process.argv.includes("--no-open");
  const smoke = process.argv.includes("--smoke");
  if (smoke) {
    if (!noOpen) {
      console.error("ONBOARDING_SMOKE_FAILED code=no_open_required");
      process.exit(1);
    }
    runOnboardingSmoke().then((receipt) => {
      console.log(`ONBOARDING_SMOKE_OK checks=${receipt.checks.join(",")}`);
    }).catch((error) => {
      const code = typeof error?.smokeCode === "string" ? error.smokeCode : "unexpected_failure";
      console.error(`ONBOARDING_SMOKE_FAILED code=${code}`);
      process.exitCode = 1;
    });
  } else {
    startOnboardingSandbox({ open: !noOpen }).then(({ close }) => {
      const stop = async () => { await close(); process.exit(0); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }).catch((error) => {
      console.error(`Financial Brain local rehearsal could not start: ${error.message}`);
      process.exit(1);
    });
  }
}
