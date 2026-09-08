import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";

// Build the real source components in a browser, with no DOM emulation, shell
// subprocess, fixed port or dependency on a locally installed Chrome channel.

// How long one assertion may wait for the UI. A shared CI runner is slower than
// a developer machine by more than a constant factor: two cores are running
// Chromium, the Vite dev server and esbuild at once, and on Windows every
// temp-directory write is scanned. A real defect fails at any ceiling, so
// raising this on CI loses no coverage; leaving it at a desktop value cost a
// green release run on 2026-09-08, where the same commit passed on push and
// failed on pull_request.
const assertionTimeoutMs = Number(process.env.BRAIN_BROWSER_TIMEOUT_MS)
  || (process.env.CI ? 45_000 : 10_000);

export async function startBrowserHarness() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cacheDir = await mkdtemp(join(tmpdir(), "brain-owner-browser-"));
  let server;
  let browser;
  try {
    server = await createServer({
      root, configFile: false, cacheDir, logLevel: "error",
      plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
      throw new Error("The browser fixture did not bind an ephemeral loopback listener");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const browserEnv = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) {
      if (process.env[name] !== undefined) browserEnv[name] = process.env[name];
    }
    browser = await chromium.launch({ headless: true, env: browserEnv });
    const harness = {
      origin,
      async newPage(options = {}) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...options });
        page.setDefaultTimeout(assertionTimeoutMs);
        // Nothing in this fixture needs a provider, analytics, external fonts
        // or the owner's browser session. API routes are mocked by each test.
        await page.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin || url.pathname.startsWith("/api/")) return route.abort();
          return route.continue();
        });
        return page;
      },
      async close() {
        try { await browser.close(); }
        finally {
          try { await server.close(); }
          finally { await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        }
      },
    };
    // Load every fixture once before the caller starts asserting. The dev
    // server compiles modules on demand and re-runs the dependency optimizer
    // the first time it meets an import it has not bundled, which reloads the
    // page and stalls module requests while it works. Paying that cost here,
    // untimed, keeps it out of the middle of a test.
    await warmUp(harness, root);
    return harness;
  } catch (error) {
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

// Compile each fixture once, off the clock, so no assertion pays for it.
async function warmUp(harness, root) {
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
  let pages;
  try {
    pages = (await readdir(fixtures)).filter(name => name.endsWith(".html")).sort();
  } catch { return; }
  const page = await harness.newPage();
  page.setDefaultTimeout(120_000);
  try {
    for (const name of pages) {
      const href = new URL(`/${relativeUrl(root, fixtures)}${name}`, harness.origin).href;
      await page.goto(href, { waitUntil: "networkidle", timeout: 120_000 });
    }
  } finally {
    await page.close();
  }
}

function relativeUrl(root, directory) {
  return directory.slice(root.length).split(sep).filter(Boolean).join("/") + "/";
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function bounded(promise, label, milliseconds = 10_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(label)), milliseconds); }),
    ]);
  } finally { clearTimeout(timeout); }
}

export async function renderSettled(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}
