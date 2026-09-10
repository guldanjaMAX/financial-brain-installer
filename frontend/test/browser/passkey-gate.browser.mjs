import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSettled, startBrowserHarness } from "./browser-harness.mjs";

const requestedOutput = process.env.BRAIN_BROWSER_OUTPUT_DIR?.trim();
const output = requestedOutput
  ? path.join(path.resolve(requestedOutput), "passkey-gate")
  : fs.mkdtempSync(path.join(os.tmpdir(), "brain-passkey-gate-"));
fs.mkdirSync(output, { recursive: true });

const harness = await startBrowserHarness();
const checks = [];
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });

try {
  const page = await harness.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    window.__passkeyPromptCalls = 0;
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: function SyntheticPublicKeyCredential() {},
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => {
          window.__passkeyPromptCalls += 1;
          return null;
        },
      },
    });
  });
  await page.route("**/auth/register/options", route => route.fulfill({
    json: {
      challenge: "c3ludGhldGljLWNoYWxsZW5nZQ",
      rp: { id: "127.0.0.1", name: "Synthetic Brain" },
      user_name: "Morgan Example",
    },
  }));

  await page.goto(new URL("/test/browser/fixtures/passkey-gate.html", harness.origin).href);
  await page.getByRole("heading", { name: "Morgan, your brain is ready", exact: true }).waitFor();

  check("the owner sees what happens before the secure prompt",
    await page.getByRole("heading", { name: "Here is what happens next", exact: true }).isVisible()
    && await page.getByText(/Your device will open its secure passkey window/).isVisible());
  check("the owner sees why the passkey is needed",
    await page.getByText(/verifies that you are the owner and protects your private owner area/).isVisible());
  check("the owner sees the private device boundary",
    await page.getByText(/cannot see or store your passkey, Face ID, fingerprint, or device PIN/).isVisible());
  check("cancel is explained before the secure prompt",
    await page.getByText(/choose Cancel\. Nothing is enrolled/).isVisible());
  check("the old biometric-only and universal-device promises are gone",
    !(await page.locator("body").innerText()).includes("Set up with Face ID")
    && !(await page.locator("body").innerText()).includes("Works on every device you own"));
  check("opening the page does not invoke WebAuthn",
    await page.evaluate(() => window.__passkeyPromptCalls) === 0);

  await page.screenshot({ path: path.join(output, "passkey-gate-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await renderSettled(page);
  await page.screenshot({ path: path.join(output, "passkey-gate-mobile.png"), fullPage: true });
  check("the mobile pre-prompt page has no horizontal overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.getByRole("button", { name: "Create my owner passkey", exact: true }).click();
  await page.waitForFunction(() => window.__passkeyPromptCalls === 1);
  check("the device prompt starts only after the explicit owner click",
    await page.evaluate(() => window.__passkeyPromptCalls) === 1);
  await page.getByText("no passkey was created", { exact: true }).waitFor();
  check("the mobile post-prompt page has no horizontal overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.close();
  console.log(JSON.stringify({ local_only: true, synthetic_only: true, passed: checks.filter(item => item.passed).length, total: checks.length, checks }));
  assert.ok(checks.every(item => item.passed), "one or more passkey welcome checks failed");
} finally {
  await harness.close();
}
