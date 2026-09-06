import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bounded, deferred, renderSettled, startBrowserHarness,
} from "./browser-harness.mjs";

const requestedOutput = process.env.BRAIN_BROWSER_OUTPUT_DIR?.trim();
const output = requestedOutput
  ? path.join(path.resolve(requestedOutput), "document-access")
  : fs.mkdtempSync(path.join(os.tmpdir(), "brain-document-access-"));
const phase = process.env.BRAIN_BROWSER_PHASE?.trim() || "browser";
fs.mkdirSync(output, { recursive: true });

const entities = ["alpha", "beta"].map((name) => ({
  entity_slug: `company-${name}`,
  label: `Company ${name}`,
  legal_name: `Company ${name}`,
  kind: "business",
  status: "active",
  relationship: "owned",
  counterparty: false,
}));
const checks = [];
const syntheticCreates = [];
const harness = await startBrowserHarness();
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });

function grantFor(body) {
  const suffix = String(body.request_id).replace(/[^a-f0-9]/gi, "a")
    .toLowerCase().padEnd(28, "a").slice(0, 28);
  return {
    grant_id: `dg_${suffix}`,
    subject_label: body.subject_label,
    entity_slug: body.entity_slug,
    state: "active",
    expires_at: null,
    created_at: Date.now(),
    revoked_at: null,
    documents: body.document_ids.map((documentId) => ({
      document_id: documentId,
      entity_slug: body.entity_slug,
      granted_at: Date.now(),
      revoked_at: null,
    })),
  };
}

function receiptFor(body, options) {
  const grant = grantFor(body);
  return {
    status: "active",
    grant_id: grant.grant_id,
    subject_label: body.subject_label,
    entity_slug: options.badReceipt ? "company-wrong" : body.entity_slug,
    document_ids: body.document_ids,
    replayed: false,
    invite_state: "active",
    enrollment_url: `https://enrollment.invalid/${grant.grant_id}`,
    enrollment_expires_at: Date.now() + 15 * 60_000,
    scope_rule: "exact_document_ids_only",
  };
}

async function fresh(options = {}) {
  const page = await harness.newPage();
  await page.addInitScript(({ holdClipboard, failClipboard }) => {
    sessionStorage.setItem("financial-brain:entity-scope", "company-alpha");
    window.__copiedEnrollmentLink = null;
    window.__clipboardWaiting = false;
    let releaseClipboard;
    const clipboardBarrier = holdClipboard
      ? new Promise((resolve, reject) => {
        releaseClipboard = () => failClipboard ? reject(new Error("synthetic clipboard failure")) : resolve();
      })
      : null;
    window.__releaseClipboard = () => releaseClipboard?.();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => {
        window.__clipboardWaiting = true;
        if (clipboardBarrier) await clipboardBarrier;
        window.__copiedEnrollmentLink = value;
      } },
    });
  }, { holdClipboard: Boolean(options.holdClipboard), failClipboard: Boolean(options.failClipboard) });
  const searchArrival = deferred();
  const searchRelease = deferred();
  const createArrival = deferred();
  const createRelease = deferred();
  const reissueArrival = deferred();
  const reissueRelease = deferred();
  const state = {
    grants: [],
    creates: [],
    searchArrived: searchArrival.promise,
    releaseSearch: searchRelease.resolve,
    createArrived: createArrival.promise,
    releaseCreate: createRelease.resolve,
    reissueArrived: reissueArrival.promise,
    releaseReissue: reissueRelease.resolve,
  };

  await page.route("**/api/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() || {};
    let response;
    let status = 200;
    if (endpoint === "/api/fin/snapshot") {
      response = { ledger_installed: true, entities, sections_unavailable: [], unavailable: false };
    } else if (endpoint === "/api/owner/preferences/read") {
      response = { preferences: [] };
    } else if (endpoint === "/api/app/document-access/status") {
      response = {
        status: "ready",
        scope_rule: "exact_document_ids_only",
        default_access: "owner_only",
        grants: state.grants,
      };
    } else if (endpoint === "/api/rag/unified") {
      if (options.holdSearch) {
        searchArrival.resolve();
        await bounded(searchRelease.promise, "Synthetic document search was never released");
      }
      if (options.searchFailure) {
        status = 503;
        response = { error: "synthetic search unavailable" };
      } else response = {
        status: "ok",
        entity_scope: { applied: true, entity_slug: body.entity_slug },
        filter_not_applied: false,
        results: [{
          doc_uid: `doc-${body.entity_slug}`,
          title: body.entity_slug === "company-alpha" ? "Alpha evidence" : "Beta evidence",
          source: "upload",
          source_kind: "upload",
          ts: "2026-09-06T12:00:00.000Z",
        }],
      };
    } else if (endpoint === "/api/app/document-access/create") {
      state.creates.push(body);
      syntheticCreates.push({
        entity_slug: body.entity_slug,
        subject_label: body.subject_label,
        document_ids: body.document_ids,
      });
      const grant = grantFor(body);
      if (options.holdCreate) {
        createArrival.resolve();
        await bounded(createRelease.promise, "Synthetic document grant was never released");
      }
      if (options.createFailure) {
        status = 503;
        response = { error: "synthetic grant unavailable" };
      } else {
        state.grants.push(grant);
        response = receiptFor(body, options);
      }
    } else if (endpoint === "/api/app/document-access/reissue") {
      const grant = state.grants.find((item) => item.grant_id === body.grant_id);
      if (!grant) throw new Error("Synthetic reissue referenced an unknown grant");
      if (options.holdReissue) {
        reissueArrival.resolve();
        await bounded(reissueRelease.promise, "Synthetic reissue was never released");
      }
      response = {
        status: "active",
        grant_id: grant.grant_id,
        replayed: false,
        invite_state: "active",
        enrollment_url: `https://enrollment.invalid/reissue-${grant.grant_id}`,
        enrollment_expires_at: Date.now() + 15 * 60_000,
      };
    } else {
      throw new Error(`Unexpected synthetic endpoint ${endpoint}`);
    }
    try { await route.fulfill({ status, json: response }); } catch {}
  });

  await page.goto(new URL("/test/browser/fixtures/document-access.html", harness.origin).href);
  await page.getByRole("button", { name: "Company alpha", exact: true }).waitFor();
  await page.getByText("No document access has been created.", { exact: true }).waitFor();
  return { page, state };
}

async function searchAndSelect(page) {
  await page.getByLabel("Find evidence to share").fill("synthetic evidence");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByText("Alpha evidence", { exact: true }).waitFor();
  await page.getByText("Alpha evidence", { exact: true }).click();
  await page.getByText("1 exact document selected.", { exact: true }).waitFor();
}

async function beginHeldCreate(page, state) {
  await searchAndSelect(page);
  await page.getByLabel("Who is this for?").fill("Original recipient");
  await page.getByRole("button", { name: "Create exact document access", exact: true }).click();
  await bounded(state.createArrived, "Synthetic document grant did not arrive");
}

try {
  {
    const { page, state } = await fresh({ holdSearch: true });
    await page.getByLabel("Find evidence to share").fill("alpha evidence");
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await bounded(state.searchArrived, "Synthetic document search did not arrive");
    await page.getByRole("button", { name: "Company beta", exact: true }).click();
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/rag/unified");
    state.releaseSearch();
    await (await responseArrived).finished();
    await renderSettled(page);
    check("late A search cannot repopulate A results under B",
      await page.getByText("Alpha evidence", { exact: true }).count() === 0
      && await page.locator("input[type=checkbox]").count() === 0);
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdSearch: true, searchFailure: true });
    await page.getByLabel("Find evidence to share").fill("alpha evidence");
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await bounded(state.searchArrived, "Synthetic failing search did not arrive");
    await page.getByRole("button", { name: "Company beta", exact: true }).click();
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/rag/unified");
    state.releaseSearch();
    await (await responseArrived).finished();
    await renderSettled(page);
    check("late A search failure and finally cannot alter the B editor",
      !(await page.locator("body").innerText()).includes("This part of the brain is unavailable")
      && await page.getByRole("button", { name: "Find", exact: true }).count() === 1);
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdCreate: true });
    await beginHeldCreate(page, state);
    const created = state.creates[0];
    check("started grant stays bound to captured A context",
      created?.entity_slug === "company-alpha"
      && created?.subject_label === "Original recipient"
      && created?.document_ids?.join() === "doc-company-alpha");
    await page.getByRole("button", { name: "Company beta", exact: true }).click();
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/document-access/create");
    state.releaseCreate();
    await (await responseArrived).finished();
    await page.getByText("Original recipient", { exact: false }).first().waitFor();
    check("scope change suppresses late private enrollment link",
      await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0
      && await page.getByText("Exact document access was created. Copy the private enrollment link before it expires.", { exact: true }).count() === 0);
    check("late valid grant remains visible in labeled history",
      (await page.getByRole("button", { name: "New link", exact: true })
        .locator("xpath=ancestor::div[contains(@class,'px-4') and contains(@class,'py-3.5')][1]")
        .innerText()).includes("Original recipient")
      && (await page.getByRole("button", { name: "New link", exact: true })
        .locator("xpath=ancestor::div[contains(@class,'px-4') and contains(@class,'py-3.5')][1]")
        .innerText()).includes("Company alpha"));
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdCreate: true, createFailure: true });
    await beginHeldCreate(page, state);
    await page.getByLabel("Who is this for?").fill("New recipient");
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/document-access/create");
    state.releaseCreate();
    await (await responseArrived).finished();
    await renderSettled(page);
    check("obsolete create error is suppressed and its own finally releases busy",
      !(await page.locator("body").innerText()).includes("This part of the brain is unavailable")
      && await page.getByRole("button", { name: "Create exact document access", exact: true }).isEnabled());
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdCreate: true });
    await beginHeldCreate(page, state);
    await page.getByLabel("Who is this for?").fill("New recipient");
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/document-access/create");
    state.releaseCreate();
    await (await responseArrived).finished();
    await page.getByText("Original recipient", { exact: false }).first().waitFor();
    check("recipient edit suppresses the obsolete private enrollment link",
      await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0
      && await page.getByText("Exact document access was created. Copy the private enrollment link before it expires.", { exact: true }).count() === 0
      && await page.getByLabel("Who is this for?").inputValue() === "New recipient");
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdCreate: true });
    await beginHeldCreate(page, state);
    await page.getByRole("button", { name: "Company beta", exact: true }).click();
    await page.getByRole("button", { name: "Company alpha", exact: true }).click();
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/document-access/create");
    state.releaseCreate();
    await (await responseArrived).finished();
    await page.getByText("Original recipient", { exact: false }).first().waitFor();
    check("A-B-A cannot revive an obsolete private enrollment link",
      await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0
      && await page.getByText("Exact document access was created. Copy the private enrollment link before it expires.", { exact: true }).count() === 0);
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdCreate: true });
    await beginHeldCreate(page, state);
    await page.getByText("Alpha evidence", { exact: true }).click();
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/document-access/create");
    state.releaseCreate();
    await (await responseArrived).finished();
    await page.getByText("Original recipient", { exact: false }).first().waitFor();
    check("selection edit suppresses the obsolete private enrollment link",
      await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0
      && await page.getByText("Exact document access was created. Copy the private enrollment link before it expires.", { exact: true }).count() === 0
      && await page.getByText("1 exact document selected.", { exact: true }).count() === 0);
    await page.close();
  }

  {
    const { page, state } = await fresh();
    await searchAndSelect(page);
    await page.getByLabel("Who is this for?").fill("Current recipient");
    await page.getByRole("button", { name: "Create exact document access", exact: true }).click();
    const copy = page.getByRole("button", { name: "Copy private enrollment link", exact: true });
    await copy.waitFor();
    await copy.click();
    const expectedLink = `https://enrollment.invalid/${state.grants[0].grant_id}`;
    check("current valid grant remains copyable exactly once",
      state.creates.length === 1
      && await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 1
      && await page.evaluate((expected) => window.__copiedEnrollmentLink === expected, expectedLink));
    await page.screenshot({ path: path.join(output, `document-access-${phase}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await renderSettled(page);
    await page.screenshot({ path: path.join(output, `document-access-${phase}-mobile.png`), fullPage: true });
    check("mobile access editor has no horizontal overflow",
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
  }

  for (const failClipboard of [false, true]) {
    const { page } = await fresh({ holdClipboard: true, failClipboard });
    await searchAndSelect(page);
    await page.getByLabel("Who is this for?").fill("Current recipient");
    await page.getByRole("button", { name: "Create exact document access", exact: true }).click();
    const copy = page.getByRole("button", { name: "Copy private enrollment link", exact: true });
    await copy.waitFor();
    await copy.click();
    await page.waitForFunction(() => window.__clipboardWaiting === true);
    await page.getByLabel("Who is this for?").fill("Edited while copying");
    await page.evaluate(() => window.__releaseClipboard());
    await renderSettled(page);
    check(failClipboard
      ? "obsolete clipboard error cannot publish into an edited grant draft"
      : "obsolete clipboard success cannot publish into an edited grant draft",
    await page.getByText(/Private enrollment link(?: for .* in .*)? copied/).count() === 0
      && await page.getByText(/browser could not copy the private link/).count() === 0
      && await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0);
    await page.close();
  }

  {
    const { page, state } = await fresh({ holdReissue: true });
    await searchAndSelect(page);
    await page.getByLabel("Who is this for?").fill("Current recipient");
    await page.getByRole("button", { name: "Create exact document access", exact: true }).click();
    await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).waitFor();
    await page.getByLabel("Who is this for?").fill("Another draft");
    await page.getByRole("button", { name: "New link", exact: true }).click();
    await bounded(state.reissueArrived, "Synthetic reissue did not arrive");
    check("create and history mutations retain one shared action lock",
      await page.getByRole("button", { name: "Saving", exact: true }).isDisabled()
      && await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0);
    await page.getByRole("button", { name: "Company beta", exact: true }).click();
    const responseArrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/document-access/reissue");
    state.releaseReissue();
    await (await responseArrived).finished();
    const copy = page.getByRole("button", { name: "Copy private enrollment link", exact: true });
    await copy.waitFor();
    check("late global reissue remains labeled with its immutable recipient and entity",
      await copy.count() === 1
      && (await copy.locator("..").innerText()).includes("For Current recipient · Company alpha."));
    await copy.click();
    await renderSettled(page);
    check("reissue copy confirmation names the same immutable receipt",
      (await page.locator("body").innerText()).includes("Private enrollment link for Current recipient in Company alpha copied. Send it only to the intended person before it expires.")
      && await page.evaluate(() => String(window.__copiedEnrollmentLink || "").includes("/reissue-dg_")));
    await page.close();
  }

  {
    const { page, state } = await fresh({ badReceipt: true });
    await searchAndSelect(page);
    await page.getByLabel("Who is this for?").fill("Current recipient");
    await page.getByRole("button", { name: "Create exact document access", exact: true }).click();
    await page.getByText(/did not return a confirmed exact-document access receipt/).waitFor();
    check("wrong-entity receipt remains refused",
      state.creates.length === 1
      && await page.getByRole("button", { name: "Copy private enrollment link", exact: true }).count() === 0);
    await page.close();
  }

  const result = {
    local_only: true,
    synthetic_only: true,
    phase,
    checks,
    synthetic_creates: syntheticCreates,
  };
  fs.writeFileSync(path.join(output, `document-access-${phase}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ phase, passed: checks.filter((item) => item.passed).length, total: checks.length }));
  assert.ok(checks.every((item) => item.passed), "one or more document access scope boundaries failed");
} finally {
  try { await harness.close(); }
  finally {
    if (!requestedOutput) fs.rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
