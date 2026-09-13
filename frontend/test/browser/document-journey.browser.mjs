import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DOCUMENT_JOURNEY_OUTCOMES,
  DOCUMENT_JOURNEY_STAGES,
  documentJourneyHtml,
} from "../../../scripts/onboarding-sandbox.mjs";
import { renderSettled, startBrowserHarness } from "./browser-harness.mjs";

const requestedOutput = process.env.BRAIN_BROWSER_OUTPUT_DIR?.trim();
const output = requestedOutput
  ? path.join(path.resolve(requestedOutput), "document-journey")
  : fs.mkdtempSync(path.join(os.tmpdir(), "brain-document-journey-"));
fs.mkdirSync(output, { recursive: true });

const paths = [
  { label: "all ready", search: "" },
  ...DOCUMENT_JOURNEY_STAGES.flatMap(({ id }) =>
    DOCUMENT_JOURNEY_OUTCOMES
      .filter((outcome) => outcome !== "ready")
      .map((outcome) => ({ label: `${id} ${outcome}`, search: `${id}=${outcome}`, stage: id, outcome }))),
];

const checks = [];
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
const harness = await startBrowserHarness();

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
        get: async () => { window.__passkeyPromptCalls += 1; return null; },
        create: async () => { window.__passkeyPromptCalls += 1; return null; },
      },
    });
  });
  await page.route("**/document-journey**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: documentJourneyHtml({ searchParams: url.searchParams }),
    });
  });

  for (const rehearsal of paths) {
    const href = new URL(`/document-journey${rehearsal.search ? `?${rehearsal.search}` : ""}`, harness.origin).href;
    await page.goto(href);
    await harness.waitForBrowserBoot(
      page,
      page.getByRole("heading", { name: "How one document becomes searchable", exact: true }),
      "document journey fixture",
    );
    const body = await page.locator("body").innerText();
    check(`${rehearsal.label}: all four proof labels remain visible`,
      DOCUMENT_JOURNEY_STAGES.every(({ label }) => body.includes(label)));
    check(`${rehearsal.label}: the page says the evidence is teaching-only and not live proof`,
      body.includes("TEACHING ONLY") && body.includes("NO LIVE SYSTEM CHECKED")
      && body.includes("None of these cards proves"));
    if (rehearsal.stage) {
      check(`${rehearsal.label}: the selected checkpoint has its independent state`,
        await page.locator(`[data-stage="${rehearsal.stage}"][data-outcome="${rehearsal.outcome}"]`).count() === 1);
    }
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await renderSettled(page);
    check(`${rehearsal.label}: load and guided scrolling make zero WebAuthn calls`,
      await page.evaluate(() => window.__passkeyPromptCalls) === 0);
  }

  await page.goto(new URL("/document-journey", harness.origin).href);
  await harness.waitForBrowserBoot(
    page,
    page.getByRole("heading", { name: "How one document becomes searchable", exact: true }),
    "document journey screenshot fixture",
  );
  await page.screenshot({ path: path.join(output, "document-journey-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await renderSettled(page);
  await page.screenshot({ path: path.join(output, "document-journey-mobile.png"), fullPage: true });
  check("the mobile teaching journey has no horizontal overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("the screenshot path still makes zero WebAuthn calls",
    await page.evaluate(() => window.__passkeyPromptCalls) === 0);

  await page.close();
  console.log(JSON.stringify({
    local_only: true,
    synthetic_only: true,
    live_proof: false,
    output,
    paths: paths.length,
    passed: checks.filter((item) => item.passed).length,
    total: checks.length,
    checks,
  }));
  assert.ok(checks.every((item) => item.passed), "one or more document journey browser checks failed");
} finally {
  await harness.close();
}
