import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSettled, startBrowserHarness } from "./browser-harness.mjs";

const requestedOutput = process.env.BRAIN_BROWSER_OUTPUT_DIR?.trim();
const output = requestedOutput
  ? path.join(path.resolve(requestedOutput), "financial-map")
  : fs.mkdtempSync(path.join(os.tmpdir(), "brain-financial-map-"));
fs.mkdirSync(output, { recursive: true });

const reviewId = `ofmp_${"b".repeat(64)}`;
const mapHash = "a".repeat(64);
const denominatorHash = "c".repeat(64);
// A valid, deliberately low-entropy base64url fixture keeps secret scanners useful.
const syntheticCredentialId = "AQIDBA";
assert.match(syntheticCredentialId, /^[A-Za-z0-9_-]+$/);
assert.ok(syntheticCredentialId.length <= 16);
const counts = { entities: 1, accounts: 1, entity_years: 1, filing_units: 1, obligation_items: 4 };
const completePreview = {
  population_state: "known_partial",
  tax_year_horizon: { start: 2025, end: 2025 },
  filing_units: [{ label: "Example household", assessment: "confirmed" }],
  entities: [{
    label: "Exact Family Business", disposition: "included",
    evidence_state: "linked_current_record",
    fields: {
      kind: { assessment: "confirmed", owner_value: "business", current_value: "business", comparison: "matches_current" },
      status: { assessment: "confirmed", owner_value: "active", current_value: "active", comparison: "matches_current" },
      holds: { assessment: "confirmed", owner_value: "Operating company", current_value: "Operating company", comparison: "matches_current" },
      ownership: { assessment: "confirmed", owner_value: 10000, current_value: 10000, comparison: "matches_current" },
      tax_class: { assessment: "confirmed", owner_value: "S corporation", current_value: "S corporation", comparison: "matches_current" },
      relationship: { assessment: "confirmed", owner_value: "owned", current_value: "owned", comparison: "matches_current" },
      parent: { assessment: "not_applicable", owner_value: null, current_value: null, comparison: "not_compared" },
    },
    tax_years: [{
      tax_year: 2025, state: "included",
      filing_units: { assessment: "confirmed", labels: ["Example household"] },
      required_returns: { assessment: "confirmed", items: [{ label: "Form 1120-S", assessment: "confirmed" }] },
      required_forms: { assessment: "confirmed", items: [{ label: "Arizona annual filing", assessment: "confirmed" }] },
      k1_roles: { assessment: "not_applicable", items: [] },
      books: { assessment: "confirmed", bookkeeping_company: { label: "Exact Books LLC", assessment: "confirmed" } },
      payroll: { assessment: "not_applicable" },
      expected_sources: { assessment: "confirmed", items: [{ label: "Operating 4242", kind: "banking", assessment: "confirmed" }] },
    }],
  }],
  accounts: [{
    label: "Operating 4242", disposition: "included", evidence_state: "linked_current_record",
    fields: {
      entity_assignment: { assessment: "confirmed", owner_value: "Exact Family Business", current_value: "Exact Family Business", comparison: "matches_current" },
      kind: { assessment: "confirmed", owner_value: "checking", current_value: "checking", comparison: "matches_current" },
      balance_role: { assessment: "confirmed", owner_value: "asset", current_value: "asset", comparison: "matches_current" },
      currency: { assessment: "confirmed", owner_value: "USD", current_value: "USD", comparison: "matches_current" },
      status: { assessment: "confirmed", owner_value: "open", current_value: "open", comparison: "matches_current" },
    },
  }],
};
const pending = {
  status: "ready", review_state: "pending", authoritative: false,
  activation_performed: false, complete: true, truncated: false,
  review_id: reviewId, map_hash: mapHash, denominator_hash: denominatorHash,
  expected_sequence: 2, created_at: Date.now(), expires_at: Date.now() + 60 * 60_000,
  counts, complete_preview: completePreview,
  prior_comparison: {
    state: "compared", changed: true, change_count: 2,
    changes: [
      { area: "Entities", subject: "Exact Family Business", field: "tax class", before: "confirmed; owner: LLC", after: "confirmed; owner: S corporation" },
      { area: "Accounts", subject: "Operating 4242", field: "Map entry", before: null, after: "Added" },
    ],
    previous_confirmed_map: completePreview,
  },
  unresolved_count: 3,
  unresolved_items: [
    { kind: "required_forms", state: "unknown", label: "Exact Family Business", item_label: "Local filing", tax_year: 2025 },
    { kind: "payroll", state: "unavailable", label: "Exact Family Business", tax_year: 2025 },
    { kind: "account_evidence", state: "unknown", label: "Investment 8181", message: "A current structured account has not been linked." },
  ],
  requires: "explicit_owner_passkey_confirmation",
};

const checks = [];
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
const harness = await startBrowserHarness();

async function visibleLabelCount(page, label) {
  return page.getByText(label, { exact: true }).evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
  }).length);
}

async function fresh({
  cancel = false,
  loseFirstActivationResponse = false,
  activationConflict = null,
} = {}) {
  const page = await harness.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(({ cancelPrompt }) => {
    window.__passkeyPromptCalls = 0;
    window.__clipboardCalls = 0;
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true, value: function SyntheticPublicKeyCredential() {},
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { window.__clipboardCalls += 1; } },
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: async () => {
        window.__passkeyPromptCalls += 1;
        if (cancelPrompt) throw new DOMException("Synthetic cancellation", "NotAllowedError");
        return {
          id: "synthetic-owner-credential",
          response: {
            authenticatorData: new Uint8Array([1, 2, 3]).buffer,
            clientDataJSON: new Uint8Array([4, 5, 6]).buffer,
            signature: new Uint8Array([7, 8, 9]).buffer,
          },
        };
      } },
    });
  }, { cancelPrompt: cancel });
  const state = { activated: false, activeHash: mapHash, options: 0, activations: [], reviews: 0 };
  await page.route("**/api/**", async route => {
    const endpoint = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() || {};
    if (endpoint === "/api/owner/financial-map/review") {
      state.reviews += 1;
      return route.fulfill({ json: state.activated ? {
        status: "no_pending_review", review_state: "none", complete: true, truncated: false,
        active_map_present: true, active_map_authoritative: true, active_sequence: 2,
        active_map_hash: state.activeHash, active_denominator_hash: denominatorHash,
        active_activated_at: 1770000000000,
        owner_message: "No Financial Map is waiting for review.",
      } : pending });
    }
    if (endpoint === "/api/owner/financial-map/passkey/options") {
      state.options += 1;
      assert.deepEqual(body, { review_id: reviewId });
      return route.fulfill({ json: {
        challenge: "c3ludGhldGljLWNoYWxsZW5nZQ", rp_id: "127.0.0.1",
        allow_credentials: [syntheticCredentialId],
        expires_at: Date.now() + 120_000,
        ceremony_message: "Confirm the exact reviewed map.",
      } });
    }
    if (endpoint === "/api/owner/financial-map/activate") {
      state.activations.push(body);
      assert.equal(body.review_id, reviewId);
      assert.match(body.request_id, /^financial_map_/);
      state.activated = true;
      if (activationConflict) {
        if (activationConflict === "different-active-map") state.activeHash = "d".repeat(64);
        return route.fulfill({ status: 409, json: {
          error: "conflict", code: "owner_financial_map_preview_replayed",
          detail: "This preview was already used or altered.",
        } });
      }
      if (loseFirstActivationResponse && state.activations.length === 1) {
        return route.abort("connectionreset");
      }
      return route.fulfill({ json: {
        activated: true, replayed: state.activations.length > 1, sequence: 2, map_hash: mapHash,
        denominator_hash: denominatorHash, population_state: "known_partial",
        tax_year_horizon: { start: 2025, end: 2025 }, counts,
        request_id: body.request_id, activated_at: 1770000000000,
        mutations: {
          owner_financial_map_snapshot: "appended", ledger: "none", sources: "none",
          taxes: "none", books: "none", payroll: "none", accounts: "none",
        },
      } });
    }
    throw new Error(`Unexpected Financial Map endpoint ${endpoint}`);
  });
  await page.goto(new URL("/test/browser/fixtures/financial-map.html", harness.origin).href);
  await page.getByRole("heading", { name: "Financial Map", exact: true }).waitFor();
  await page.getByText("Form 1120-S", { exact: true }).waitFor();
  return { page, state };
}

try {
  {
    const { page, state } = await fresh({ cancel: true });
    const text = await page.locator("body").innerText();
    check("the owner sees the complete exact current map", text.includes("Exact Family Business")
      && text.includes("Operating 4242") && text.includes("Form 1120-S"));
    check("the owner sees every prior change and unresolved item", text.includes("Changes from your last confirmed map (2)")
      && text.includes("Still unresolved (3)") && text.includes("Investment 8181"));
    check("desktop labels every owner answer and current record",
      await visibleLabelCount(page, "Owner answer") === 12
      && await visibleLabelCount(page, "Current record") === 12);
    check("the desktop review has no horizontal overflow",
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check("passkey context appears before the button", text.includes("What the passkey window is doing")
      && text.includes("cannot see or store your biometric data or device PIN")
      && text.includes("Only you choose whether to confirm"));
    check("the correction choice appears before passkey confirmation", await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const correction = buttons.find(button => button.textContent?.trim() === "Something is wrong");
      const confirmation = buttons.find(button => button.textContent?.trim() === "Confirm this Financial Map with my passkey");
      return Boolean(correction && confirmation &&
        (correction.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));
    check("load and guided scrolling do not invoke WebAuthn or activation",
      await page.evaluate(() => window.__passkeyPromptCalls) === 0 && state.activations.length === 0);
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await renderSettled(page);
    check("scrolling still does not invoke WebAuthn",
      await page.evaluate(() => window.__passkeyPromptCalls) === 0);
    await page.screenshot({ path: path.join(output, "financial-map-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await renderSettled(page);
    await page.screenshot({ path: path.join(output, "financial-map-mobile.png"), fullPage: true });
    check("mobile labels every owner answer and current record",
      await visibleLabelCount(page, "Owner answer") === 12
      && await visibleLabelCount(page, "Current record") === 12);
    check("the complete mobile review has no horizontal overflow",
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    await page.getByRole("button", { name: "Something is wrong", exact: true }).click();
    await page.getByRole("heading", { name: "Stop here and correct the preview", exact: true }).waitFor();
    check("choosing correction invokes no passkey, options request, or activation",
      await page.evaluate(() => window.__passkeyPromptCalls) === 0
      && state.options === 0 && state.activations.length === 0);
    check("correction stops confirmation until the owner returns to review",
      await page.getByRole("button", { name: "Create a fresh preview before confirming", exact: true }).isDisabled());
    check("the correction state has no horizontal overflow",
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check("the correction state leaks no selectors, hashes, storage, URL, or clipboard data", !(await page.locator("body").innerText()).includes("ofmp_")
      && !page.url().includes("ofmp_")
      && await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && window.__clipboardCalls === 0));
    await page.screenshot({ path: path.join(output, "financial-map-correction-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Keep reviewing this preview", exact: true }).click();
    check("returning to review still invokes no passkey or activation",
      await page.evaluate(() => window.__passkeyPromptCalls) === 0
      && state.options === 0 && state.activations.length === 0);
    await page.getByRole("button", { name: "Confirm this Financial Map with my passkey", exact: true }).click();
    await page.getByText(/Nothing was confirmed or changed/).waitFor();
    check("cancelling the passkey activates nothing",
      await page.evaluate(() => window.__passkeyPromptCalls) === 1 && state.activations.length === 0);
    check("selectors and hashes never enter UI, URL, storage, or clipboard", !(await page.locator("body").innerText()).includes("ofmp_")
      && !page.url().includes("ofmp_")
      && await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && window.__clipboardCalls === 0));
    await page.close();
  }

  {
    const { page, state } = await fresh();
    await page.getByRole("button", { name: "Confirm this Financial Map with my passkey", exact: true }).click();
    await page.getByRole("heading", { name: "Your Financial Map is confirmed", exact: true }).waitFor();
    const text = await page.locator("body").innerText();
    check("one explicit click performs one fresh ceremony and activation", state.options === 1
      && state.activations.length === 1 && await page.evaluate(() => window.__passkeyPromptCalls) === 1);
    check("success waits for an authoritative reread", state.reviews === 2);
    check("verification fields stay in memory and are never rendered", !text.includes(reviewId)
      && !text.includes(mapHash) && !text.includes(denominatorHash)
      && !text.includes(state.activations[0].request_id));
    check("success says the activation did not mutate financial records",
      text.includes("No account, book, tax, payroll, source, or ledger record was changed"));
    check("successful confirmation persists no selector, receipt, or clipboard value",
      await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && window.__clipboardCalls === 0));
    await page.close();
  }

  {
    const { page, state } = await fresh({ loseFirstActivationResponse: true });
    await page.getByRole("button", { name: "Confirm this Financial Map with my passkey", exact: true }).click();
    await page.getByRole("button", { name: "Retry this exact confirmation", exact: true }).waitFor();
    check("a lost activation response retains one exact signed request only in page memory",
      state.options === 1 && state.activations.length === 1 && state.reviews === 1 &&
      await page.evaluate(() => window.__passkeyPromptCalls) === 1);
    check("an unresolved response keeps the correction escape visible but safely paused",
      await page.getByRole("button", { name: "Something is wrong", exact: true }).isDisabled()
      && (await page.locator("body").innerText()).includes("Retry that exact confirmation first"));
    const firstBody = structuredClone(state.activations[0]);
    await page.getByRole("button", { name: "Retry this exact confirmation", exact: true }).click();
    await page.getByRole("heading", { name: "Your Financial Map is confirmed", exact: true }).waitFor();
    check("lost-response recovery resends the exact request without a second ceremony",
      state.options === 1 && state.activations.length === 2 &&
      await page.evaluate(() => window.__passkeyPromptCalls) === 1 &&
      JSON.stringify(state.activations[1]) === JSON.stringify(firstBody));
    check("lost-response recovery still waits for the authoritative active-map reread", state.reviews === 2);
    const text = await page.locator("body").innerText();
    check("the retained assertion and identifiers never render or persist during recovery",
      !text.includes(firstBody.review_id) && !text.includes(firstBody.request_id) &&
      !text.includes(firstBody.credentialId) && !text.includes(firstBody.authenticatorData) &&
      !text.includes(firstBody.clientDataJSON) && !text.includes(firstBody.signature) &&
      !page.url().includes("ofmp_") && await page.evaluate(() =>
        localStorage.length === 0 && sessionStorage.length === 0 && window.__clipboardCalls === 0));
    await page.close();
  }

  {
    const { page, state } = await fresh({ activationConflict: "exact-active-map" });
    await page.getByRole("button", { name: "Confirm this Financial Map with my passkey", exact: true }).click();
    await page.getByRole("heading", { name: "Your Financial Map is confirmed", exact: true }).waitFor();
    check("a replay conflict succeeds only after the exact authoritative active map is reread",
      state.activations.length === 1 && state.reviews === 2);
    await page.close();
  }

  {
    const { page, state } = await fresh({ activationConflict: "different-active-map" });
    await page.getByRole("button", { name: "Confirm this Financial Map with my passkey", exact: true }).click();
    await page.getByText(/did not show this exact reviewed map as active/).waitFor();
    const text = await page.locator("body").innerText();
    check("a conflict with a different active map never claims confirmation or no activation",
      state.reviews === 2 && !text.includes("Your Financial Map is confirmed") &&
      !text.includes("Nothing was activated"));
    await page.close();
  }

  {
    const page = await harness.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("**/api/owner/financial-map/review", route => route.fulfill({
      status: 404,
      json: { error: "not found" },
    }));
    await page.goto(new URL("/test/browser/fixtures/financial-map.html", harness.origin).href);
    await page.getByText(/not an empty review queue/).waitFor();
    const text = await page.locator("body").innerText();
    check("a missing Financial Map route is called unavailable and update-needed",
      text.includes("ask the installer") && !text.includes("No Financial Map is waiting for review"));
    await page.close();
  }

  {
    const page = await harness.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("**/api/owner/financial-map/review", route => route.fulfill({ json: {
      status: "no_pending_review", review_state: "none", complete: true, truncated: false,
      active_map_present: true, active_map_authoritative: false, active_sequence: 2,
      active_map_hash: mapHash, active_denominator_hash: denominatorHash,
      active_activated_at: 1770000000000,
      owner_message: "No Financial Map is waiting for review.",
    } }));
    await page.goto(new URL("/test/browser/fixtures/financial-map.html", harness.origin).href);
    await page.getByText(/no longer matches the Brain's current records/).waitFor();
    const text = await page.locator("body").innerText();
    check("a stale confirmed map is not presented as current for completeness checks",
      text.includes("Create a corrected review") &&
      !text.includes("latest confirmed map remains available for future completeness checks"));
    await page.close();
  }

  console.log(JSON.stringify({ local_only: true, synthetic_only: true, output, passed: checks.filter(item => item.passed).length, total: checks.length, checks }));
  assert.ok(checks.every(item => item.passed), "one or more Financial Map browser checks failed");
} finally {
  await harness.close();
}
