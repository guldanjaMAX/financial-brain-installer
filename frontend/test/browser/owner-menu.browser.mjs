import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCliCommands } from "../../../operations/cli-guidance.mjs";
import { startBrowserHarness } from "./browser-harness.mjs";

const items = ["Home", "This Year", "Financial Map", "Documents", "Explore", "Add & Review", "Banks", "Settings", "Help", "Sign out"];
const contact = "https://support.invalid/contact";
const fixture = await readFile(new URL("./fixtures/owner-menu.html", import.meta.url), "utf8");
// Help is static web copy; pin its fixture context independently of the test host.
const installerStep = renderCliCommands(
  "Ask the person who set up your Brain. On their computer, brain support --preview shows a safe note to send.",
  {
    platform: "linux", nodePath: "/fixture/node", scriptPath: "/fixture/brain.mjs",
    env: { PATH: "" }, existsSync: () => false,
  },
);
const screenshots = process.env.BRAIN_OWNER_MENU_SCREENSHOTS;
const harness = await startBrowserHarness();
let passed = 0;
let total = 0;

async function check(label, run) {
  total++;
  try {
    await run();
    passed++;
    console.log("PASS " + label);
  } catch (error) {
    console.error("FAIL " + label, error);
  }
}

async function session(width, height, { grant = false, support, configured = true } = {}) {
  const page = await harness.newPage({ viewport: { width, height } });
  const requests = [];
  const network = [];
  page.on("request", (request) => {
    if (["fetch", "xhr"].includes(request.resourceType())) network.push(request);
  });
  await page.route("**/app?**", (route) => {
    if (new URL(route.request().url()).pathname === "/app") {
      return route.fulfill({ contentType: "text/html", body: fixture });
    }
    return route.fallback();
  });
  await page.route("**/app", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.route("**/app/connect/bank", (route) => route.fulfill({ body: "Bank connection fixture" }));
  let signedIn = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/api/app/me") {
      return route.fulfill({ json: {
        signed_in: signedIn, brain: "Fixture Brain",
        principal: grant
          ? { kind: "grant", grant_id: "dg_fixture", entity_slug: "fixture-entity", capabilities: ["documents:read", "ask"] }
          : { kind: "owner", grant_id: null },
        ...(grant ? { workspace: {
          home: false, documents: true, ask: true, add_review: false, access: false,
          bank: false, targets: false, preferences: false,
        } } : {}),
        bank_configured: configured,
        ...(support ? { support: { contact_url: support } } : {}),
      } });
    }
    if (path === "/api/app/signout") {
      assert.equal(route.request().method(), "POST");
      signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/bank-feed/status") return route.fulfill({ json: { configured, connections: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(harness.origin + "/app");
  const header = page.locator("header").first();
  const nav = header.getByRole("navigation");
  await harness.waitForBrowserBoot(page, header, "owner menu");
  const button = (name) => header.getByRole("button", { name, exact: true });
  const open = async () => {
    await header.waitFor();
    if (width < 1024 && await button("Menu").isVisible()) await button("Menu").click();
  };
  return { page, header, nav, requests, network, button, open };
}

try {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const f = await session(width, height, { support: width === 1280 ? contact : undefined });
    try {
      await check(width === 1280 ? "T1 desktop menu" : "T2 phone menu", async () => {
        await f.open();
        assert.deepEqual(await f.nav.locator("a:visible,button:visible").allTextContents(), items);
        for (const name of items) {
          const role = name === "Banks" ? "link" : "button";
          assert.equal(await f.nav.getByRole(role, { name, exact: true }).isVisible(), true, name);
        }
        assert.equal(await f.nav.getByRole("link", { name: "Banks" }).getAttribute("href"), "/app/connect/bank");
        assert.equal(await f.header.getByRole("button", { name: /settings/i }).count(), 1);
        assert.doesNotMatch(await f.header.innerText(), /\bAccess\b/);
        assert.equal(await f.header.locator('[class*="hidden lg:block"]').count(), 0);
        if (screenshots) {
          await mkdir(screenshots, { recursive: true });
          await f.page.screenshot({ path: join(screenshots, "owner-menu-" + width + "x" + height + ".png") });
        }
      });

      await check("T6 Settings deep link at " + width, async () => {
        await f.page.goto(harness.origin + "/app?view=access");
        await f.open();
        assert.equal(await f.button("Settings").getAttribute("aria-current"), "page");
        await f.page.getByRole("heading", { name: "Your passkeys" }).waitFor();
      });

      await check("T4 Help at " + width, async () => {
        await f.page.waitForLoadState("networkidle");
        const before = f.network.length;
        await f.button("Help").click();
        const panel = f.header.getByRole("region", { name: "Help" });
        if (width === 1280) assert.equal(await panel.getByRole("link", { name: "Contact support" }).getAttribute("href"), contact);
        else assert.equal(await panel.innerText(), installerStep);
        await f.page.waitForLoadState("networkidle");
        assert.equal(f.network.length, before);
        await f.button("Help").click();
      });

      await check("T3 menu sign-out at " + width, async () => {
        const calls = () => f.requests.filter((path) => path === "/api/app/signout").length;
        await f.button("Sign out").click();
        await f.header.getByText("Sign out here?", { exact: true }).waitFor();
        assert.equal(calls(), 0);
        await f.button("Cancel").click();
        assert.equal(calls(), 0);
        await f.button("Sign out").click();
        await Promise.all([f.page.waitForEvent("framenavigated", (frame) => frame === f.page.mainFrame()), f.button("Yes").click()]);
        assert.equal(calls(), 1);
      });
    } finally {
      await f.page.close();
    }
  }

  await check("T5 grant menu", async () => {
    const f = await session(390, 844, { grant: true, support: contact });
    try {
      assert.deepEqual(await f.nav.locator("a,button").allTextContents(), ["Documents", "Explore"]);
    } finally { await f.page.close(); }
  });

  await check("T7 keyboard order and navigation", async () => {
    const f = await session(390, 844);
    try {
      async function tabTo(target) {
        await f.button("Menu").focus();
        await f.page.keyboard.press("Enter");
        for (const name of items) {
          await f.page.keyboard.press("Tab");
          assert.equal(await f.page.locator(":focus").innerText(), name);
          if (name === target) break;
        }
      }
      for (const name of items.filter((item) => !["Banks", "Help", "Sign out"].includes(item))) {
        await tabTo(name);
        await f.page.keyboard.press("Enter");
        assert.equal(await f.nav.isVisible(), false);
        assert.equal(await f.button("Menu").getAttribute("aria-expanded"), "false");
      }
      await tabTo("Help");
      await f.page.keyboard.press("Enter");
      assert.equal(await f.header.getByRole("region", { name: "Help" }).isVisible(), true);
      await f.page.keyboard.press("Enter");
      await f.button("Close").click();
      await tabTo("Sign out");
      await f.page.keyboard.press("Enter");
      await f.header.getByText("Sign out here?", { exact: true }).waitFor();
      await f.button("Cancel").click();
      await f.button("Close").click();
      await tabTo("Banks");
      await f.page.keyboard.press("Enter");
      await f.page.waitForURL("**/app/connect/bank");
    } finally { await f.page.close(); }
  });

  await check("T8 narrow phone and unconfigured bank fallback", async () => {
    const f = await session(320, 844, { configured: false });
    try {
      await f.open();
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await f.nav.getByRole("link", { name: "Banks" }).getAttribute("href"), "/app?view=access#banks");
      await f.nav.getByRole("link", { name: "Banks" }).click();
      await f.page.waitForURL("**/app?view=access#banks");
      await f.page.getByText("Bank connections aren't set up for this Brain yet.", { exact: false }).waitFor();
      const anchor = f.page.locator("#banks");
      assert.equal(await anchor.getByRole("heading", { name: "Banks", exact: true }).isVisible(), true);
      await f.open();
      await f.button("Home").click();
      await anchor.waitFor({ state: "detached" });
      await f.open();
      await f.nav.getByRole("link", { name: "Banks" }).click();
      await anchor.waitFor();
    } finally { await f.page.close(); }
  });
} finally {
  await harness.close();
  console.log(JSON.stringify({ passed, total }));
  if (passed !== total) process.exitCode = 1;
}
