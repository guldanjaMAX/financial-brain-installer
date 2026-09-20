import assert from "node:assert/strict";
import { chromium } from "playwright";
import { visualFixtureServer } from "../visual-server.mjs";

await new Promise((resolveListen, rejectListen) => {
  visualFixtureServer.once("error", rejectListen);
  visualFixtureServer.listen(0, "127.0.0.1", resolveListen);
});
const address = visualFixtureServer.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browserEnvironment = {};
for (const name of [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
]) {
  if (process.env[name] !== undefined) browserEnvironment[name] = process.env[name];
}

let browser;
try {
  browser = await chromium.launch({ headless: true, env: browserEnvironment });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(process.env.CI ? 45_000 : 10_000);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });

  await page.goto(`${origin}/app?state=zero-entities`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add my first financial entity", exact: true }).waitFor();
  const zeroEntityHome = await page.locator("body").innerText();
  assert.doesNotMatch(zeroEntityHome, /No financial record is loaded for No financial entity selected/i);
  assert.doesNotMatch(zeroEntityHome, /What changed|Shared External reviewer document access|Monthly revenue target/i);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/app?state=populated`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Whole Brain", exact: true }).waitFor();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Whole Brain", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Whole Brain", exact: true }).count(), 1);

  console.log(JSON.stringify({
    local_only: true,
    synthetic_only: true,
    passed: 5,
    total: 5,
  }));
} finally {
  await browser?.close();
  visualFixtureServer.closeAllConnections?.();
  await new Promise((resolveClose) => visualFixtureServer.close(resolveClose));
}
