import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { cmdConnect } from "../brain.mjs";
import { buildAuthUrl, pkce, redirectUri, DEFAULT_PORT } from "../connectors/google-auth.mjs";
import { DONE_LINES } from "../operations/answer-setup-copy.mjs";
import { displayResetTime } from "../operations/answer-setup.mjs";

import {
  CONTRACT_SECTION,
  CHECK_PROBLEM,
  GAP_DETAIL,
  HALF_RUN,
  MONEY_RULES_LINE,
  SKILL_CONSOLE_PARAGRAPH,
  SKILL_CREDENTIAL_LINE,
  SKILL_DECISION_STEP,
  SKILL_DECISION_TEXT,
  SKILL_ON_REQUEST,
  SKILL_WINDOWS_LINE,
  KEY_SHAPE,
  MODEL_NOT_REVIEWED,
  ROLLBACK_INCOMPLETE,
} from "../operations/answer-setup-copy.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { GAP_DETAIL as WORKER_GAP_DETAIL } from "../worker/src/lib/answer-render.js";

const text = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("reviewed answer-setup copy stays byte-identical across its packaged consumers", () => {
  const skill = text("skills/financial-brain-technician/SKILL.md");
  for (const reviewed of [
    SKILL_CONSOLE_PARAGRAPH,
    SKILL_WINDOWS_LINE,
    SKILL_DECISION_STEP,
    SKILL_CREDENTIAL_LINE,
    SKILL_ON_REQUEST,
  ]) assert.ok(skill.includes(reviewed));

  assert.ok(text("templates/owner-contract/answer-contract-v1.md").includes(CONTRACT_SECTION));
  for (const name of ["money-rules-v3.md", "money-rules-v3-windows.md"]) {
    assert.ok(text(`templates/owner-contract/${name}`).includes(MONEY_RULES_LINE));
  }
  assert.equal(WORKER_GAP_DETAIL, GAP_DETAIL);
});

test("the technician skill quotes the approved answer decision byte for byte", () => {
  const skill = text("skills/financial-brain-technician/SKILL.md");
  const quoted = SKILL_DECISION_TEXT
    .split("\n")
    .map((line) => line ? `> ${line}` : ">")
    .join("\n");
  assert.ok(skill.includes(`${SKILL_DECISION_STEP}\n\n${quoted}\n`));
});

test("the approved answer decision keeps the confirmed cap and measured unit cost", () => {
  assert.match(SKILL_DECISION_TEXT, /\$5\b/);
  assert.match(SKILL_DECISION_TEXT, /5\.5 cents/);
  assert.doesNotMatch(SKILL_DECISION_TEXT, /\$16\b|\$66\b/);
});

test("the update guidance names the exact legacy exception and keeps the stored key", () => {
  assert.match(SKILL_ON_REQUEST, /claude-sonnet-5.*Opus answers, Sonnet checks/);
  assert.match(SKILL_ON_REQUEST, /same stored key/);
});

test("answer setup remedies avoid the older-version cleanup loop and describe check failures", () => {
  assert.match(KEY_SHAPE, /--key-set-in-dashboard/);
  const remedy = MODEL_NOT_REVIEWED({
    field: "answer_model", id: "fixture-unreviewed", manifest: "/fixture/brain.manifest.json",
  });
  assert.equal(remedy, "This model name isn't supported for updates yet. Nothing was changed. Contact your partner.");
  assert.match(CHECK_PROBLEM, /check.*could not be read/i);
  assert.doesNotMatch(CHECK_PROBLEM, /key|evidence did not support|refused the test message/i);
});

test("interrupted answer copy never recommends removing a stored key", () => {
  const rows = [
    { name: "pre-existing half-run", render: HALF_RUN },
    { name: "rollback could not finish", render: ROLLBACK_INCOMPLETE },
  ];

  for (const row of rows) {
    const held = row.render("<manifest>", true);
    assert.match(held, /Claude setup was interrupted part way/i, row.name);
    assert.match(held, /do not remove the Claude connection.*removes your stored key/i, row.name);
    assert.match(held, /ask the person who set up your Brain for help/i, row.name);
    assert.doesNotMatch(held, /disconnect/i, `${row.name}: no unsafe action name is shown`);
    assert.doesNotMatch(held, /\bbrain\s+(?:connect|disconnect)\b/u,
      `${row.name}: no CLI command is shown`);
    assert.doesNotMatch(held, /<manifest>/u, `${row.name}: the unused command locator is not shown`);

    const noStoredKey = renderCliCommands(row.render("<manifest>", false));
    assert.ok(noStoredKey.includes(renderCliCommands("brain disconnect anthropic <manifest>")),
      `${row.name}: no-stored-key control retains the prior recovery command`);
  }
});

// Execute the real callback and browser-message code with an in-memory server.
// No port, browser, credential helper or provider can be reached by this probe.
const source = readFileSync(new URL("../connectors/google-auth.mjs", import.meta.url), "utf8");
const callbackSource = source.slice(source.includes("const escapePageText") ? source.indexOf("const escapePageText") : source.indexOf("const PAGE ="), source.indexOf("export async function exchangeCode"))
  .replace("export async function authorize", "async function authorize");

async function callbackProbe({ opens = true, error, mismatch = false, missingCode = false } = {}) {
  const seen = { pages: [], logs: [], requests: 0, opens: 0, exchanges: 0, closes: 0 };
  const authorize = runInNewContext(`${callbackSource}\nauthorize`, {
    URL, DEFAULT_PORT, pkce, buildAuthUrl, redirectUri,
    b64url: (buffer) => buffer.toString("base64url"),
    randomBytes: (length) => Buffer.alloc(length, 1),
    console: { log: (line) => seen.logs.push(line) },
    setTimeout: () => ({ unref() {} }),
    openBrowser: () => { seen.opens++; return opens; },
    exchangeCode: async () => { seen.exchanges++; return { fixture: true }; },
    createServer: (handle) => ({
      on() {}, close() { seen.closes++; },
      listen(port, host, ready) {
        assert.equal(host, "127.0.0.1");
        ready();
        const state = Buffer.alloc(16, 1).toString("base64url");
        const query = new URLSearchParams({ state: mismatch ? "different" : state });
        if (error) query.set("error", error);
        else if (!missingCode) query.set("code", "fixture");
        seen.requests++;
        handle({ url: `/?${query}` }, {
          writeHead(status, headers) {
            return { end(html) { seen.pages.push({ status, headers, html }); } };
          },
        });
      },
    }),
  });
  await authorize({ clientId: "fixture", scopes: ["fixture"] }).catch(() => {});
  assert.equal(seen.requests, 1, "the real callback decision was reached");
  assert.equal(seen.opens, 1, "the browser-open decision was reached");
  assert.equal(seen.pages.length, 1);
  assert.equal(seen.closes, 1);
  return seen;
}

test("callback control preserves successful exchange and HTML status", async () => {
  const seen = await callbackProbe();
  assert.equal(seen.pages[0].status, 200);
  assert.match(seen.pages[0].headers["content-type"], /text\/html/);
  assert.equal(seen.exchanges, 1);
});

test("Google callback uses the owner sentence and a phone-sized column", async () => {
  const { html } = (await callbackProbe()).pages[0];
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /✓ Google connected\. You can close this window and go back to Claude\./);
  assert.doesNotMatch(html, /terminal/i);
  assert.match(html, /max-width:\s*40rem/);
  assert.match(html, /padding:[^;}]*16px/);
  assert.match(html, /system-ui/);
});

test("Cancel explains the choice without a raw provider code", async () => {
  const seen = await callbackProbe({ error: "access_denied" });
  assert.equal(seen.pages[0].status, 400);
  assert.equal(seen.exchanges, 0);
  assert.match(seen.pages[0].html.replaceAll("&#39;", "'"), /You chose Cancel on Google's page\. Nothing was connected\. Go back to Claude to try again\./);
  assert.doesNotMatch(seen.pages[0].html, /<code>access_denied<\/code>/);
});

test("other callback failures retain an escaped code in muted small text", async () => {
  for (const [options, code] of [
    [{ error: "provider_failure" }, "provider_failure"],
    [{ mismatch: true }, "state_mismatch"],
    [{ missingCode: true }, "missing_code"],
  ]) {
    const seen = await callbackProbe(options);
    assert.equal(seen.pages[0].status, 400);
    assert.equal(seen.exchanges, 0);
    assert.match(seen.pages[0].html, new RegExp(`class="code">Code: ${code}`));
    assert.match(seen.pages[0].html, /\.code\s*\{[^}]*font-size:[^}]*color:/);
  }
  const seen = await callbackProbe({ error: '<script>fixture</script>' });
  assert.doesNotMatch(seen.pages[0].html, /<script>fixture/);
});

test("browser-open success hides the URL; failed-open control prints it", async () => {
  const opened = await callbackProbe();
  assert.equal(opened.exchanges, 1);
  assert.doesNotMatch(opened.logs.join("\n"), /https:\/\/accounts\.google/);
  const fallback = await callbackProbe({ opens: false });
  assert.equal(fallback.exchanges, 1);
  assert.match(fallback.logs.join("\n"), /Could not open a browser/);
  assert.match(fallback.logs.join("\n"), /https:\/\/accounts\.google/);
});

test("Google CLI confirms storage with owner words and a masked account", async () => {
  const calls = [], lines = [];
  const log = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await cmdConnect("google", {
      argv: ["node", "brain.mjs", "connect", "google", "--scopes", "drive,gmail"],
      env: { GOOGLE_CLIENT_ID: "fixture" },
      withSourceIngestLock: async (_input, action) => action({ assertOwned() {} }),
      authorizeGoogle: async () => { calls.push("authorize"); return { access_token: "fixture", refresh_token: "fixture" }; },
      fetchConnectedAccountEmail: async () => { calls.push("identity"); return "owner@example.invalid"; },
      loadGoogleTokens: () => ({}),
      saveGoogleTokens: () => { calls.push("save"); assert.doesNotMatch(lines.join("\n"), /✓ Google connected/); },
      tokenStorageDescription: () => { calls.push("storage-description"); return "fixture storage"; },
    });
  } finally { console.log = log; }
  assert.deepEqual(calls, ["authorize", "identity", "save"]);
  const output = lines.join("\n");
  assert.match(output, /✓ Google connected \(o…@example\.invalid\)/);
  assert.equal(output.includes(renderCliCommands("brain ingest")), false);
  assert.doesNotMatch(output, /owner@example\.invalid|Token stored|Keychain|requesting:|now run:|https:\/\//);
});

test("Claude done lines use checks and daily local-time words", () => {
  const reset = displayResetTime("2026-10-23T00:00:00.000Z", "America/Phoenix");
  assert.equal(reset, "5:00 PM Arizona time");
  const lines = DONE_LINES({ cap: 5, reset, clipboard: true });
  assert.equal(lines.length, 3, "the clipboard success decision is included");
  assert.ok(lines.every((line) => line.startsWith("✓ ")));
  assert.match(lines[1], /resets every day at 5:00 PM Arizona time/);
  assert.doesNotMatch(lines.join("\n"), /2026|America\/Phoenix/);
  assert.equal(DONE_LINES({ cap: 5, reset }).length, 2, "non-clipboard control keeps two lines");
});
