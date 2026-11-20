// Offline clipboard ceremony. Values are synthetic repeated hex assembled at
// runtime; readers, provider validation, Worker writes and console flushes are
// injected. No desktop clipboard, credentials or provider is used.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmdConnect, cmdConnectBank, supportErrorCode, withAvailableCloudflareToken } from "../brain.mjs";
import { ensureBankFeedWorkerSecrets } from "../operations/bank-feed-owner-secrets.mjs";
import { WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT } from "../operations/custom-api-clipboard.mjs";

const CLIENT = "1".repeat(24);
const SECRET = "2".repeat(30);
const RETRY_SECRET = "3".repeat(30);
const STALE = "4".repeat(24);
const PROVIDER_NAMES = ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"];
const WRAPPING = "BANK_FEED_WRAPPING_KEY_V2";
const ALL_NAMES = [...PROVIDER_NAMES, WRAPPING];
const noValues = (value) => [CLIENT, SECRET, RETRY_SECRET, STALE].every((key) => !String(value).includes(key));

function clipboardFixture(copies = ["", CLIENT, SECRET]) {
  let text = "";
  const state = { reads: 0, clears: 0, flushes: 0, milliseconds: 0, pending: copies.length };
  return {
    state,
    readClipboard: async () => {
      state.reads++;
      if (state.pending > 0) {
        const next = copies[copies.length - state.pending--];
        if (next !== null) text = next;
      }
      return text;
    },
    clearClipboard: async () => { state.clears++; text = ""; },
    flushConsoleInput: () => { state.flushes++; return true; },
    now: () => Date.UTC(2025, 0, 2, 12) + state.milliseconds,
    sleep: async (ms) => { state.milliseconds += ms; },
    timeoutMs: 600_000,
    pollMs: 1_000,
  };
}

async function connect({
  flags = { "from-clipboard": true },
  clipboard = clipboardFixture(),
  initial = [WRAPPING],
  environment = "production",
  env = {},
  validate,
  providerFetch,
  writer,
  inventoryReply,
  platform = "darwin",
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bank-clipboard-"));
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(join(directory, ".brain-admin-key"), ["fixture", "admin", "only"].join("-"), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture", display_name: "Fixture Owner" },
    brain: { worker_name: "fixture-brain", domain: "brain.invalid" },
    corpora: { bank_feed: {
      enabled: true, provider: "plaid", environment,
      registered_redirect_uris: ["https://brain.invalid/app/connect/bank"],
    } },
  }));
  const state = { lists: 0, validations: 0, writes: [], opens: 0, prompts: 0, events: [] };
  const names = new Set(initial);
  const lines = [];
  const errors = [];
  const priorLog = console.log;
  const priorError = console.error;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.ok(inventoryReply, "all provider requests must have an injected reply");
    state.lists++;
    state.events.push("list");
    return inventoryReply();
  };
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  let result;
  let error;
  try {
    const action = () => cmdConnectBank(manifestPath, flags, {
      env,
      platformName: platform,
      clipboard,
      launchctl: () => { throw new Error("no scheduler operation expected"); },
      resolveAccount: async () => ({ id: "fixture-account" }),
      ...(!inventoryReply ? { listWorkerSecretNames: async () => {
        state.lists++; state.events.push("list"); return [...names];
      } } : {}),
      putWorkerSecret: async (name, value) => {
        state.events.push("put");
        state.writes.push(name);
        if (writer) await writer(name, value);
        names.add(name);
      },
      ...(providerFetch ? { plaidFetchImpl: async (input, init) => {
        state.validations++;
        state.events.push("validate");
        return providerFetch(input, init, state.validations);
      } } : { validatePlaidKeys: async (pair) => {
        state.validations++;
        state.events.push("validate");
        if (validate) return validate(pair, state.validations);
        assert.ok(pair.clientId === CLIENT && pair.secret === SECRET, "synthetic pair matches; values withheld");
      } }),
      readSecret: async () => {
        state.prompts++;
        if (flags["from-clipboard"] === true) throw new Error("clipboard mode must never prompt for a paste");
        return state.prompts === 1 ? CLIENT : SECRET;
      },
      openImpl: () => { state.opens++; return true; },
    });
    result = inventoryReply ? await withAvailableCloudflareToken(action, {
      accountId: "fixture-account",
      loadStoredCloudflareToken: () => Buffer.from(["fixture", "only"].join("-")),
    }) : await action();
  } catch (caught) {
    error = caught;
  } finally {
    console.log = priorLog;
    console.error = priorError;
    globalThis.fetch = priorFetch;
    rmSync(directory, { recursive: true, force: true });
  }
  return { state, result, error, output: lines.join("\n"), stderr: errors.join("\n"), clipboard };
}

function success(run) {
  assert.ok(!run.error, `expected successful ceremony: ${noValues(run.error?.message) ? run.error?.message : "withheld"}`);
  assert.equal(run.state.validations, 1);
  assert.deepEqual(run.state.writes, PROVIDER_NAMES, "one complete provider pair, never a wrapping-key write");
  assert.deepEqual(run.state.events, ["list", "validate", "put", "put", "list"]);
  assert.equal(run.state.prompts, 0);
  assert.equal(run.state.opens, 1);
  assert.equal(run.clipboard.state.clears, 2);
}

test("two Copy clicks validate then write one pair and clear twice", async () => {
  const run = await connect();
  success(run);
  assert.equal(run.clipboard.state.reads, 3, "no clipboard polling after pickup or save");
  const step1 = run.output.indexOf("STEP 1 of 2 · On Plaid's Keys page, click the copy icon next to client_id");
  const pickup = run.output.indexOf("✅ client_id picked up");
  const step2 = run.output.indexOf("STEP 2 of 2 · On Plaid's Keys page, click the copy icon next to the Production secret");
  const saved = run.output.indexOf("✅ Plaid keys saved to your Brain");
  assert.ok(step1 >= 0 && pickup > step1 && step2 > pickup && saved > step2);
  assert.match(run.output, /^STEP 1 of 2/m, "the step is the start of its owner line");
  assert.match(run.output, /^✅ Plaid keys saved to your Brain$/m);
  assert.match(run.output, /⏱.*10 minutes.*give up at/);
  assert.match(run.output, /Plaid's return address: https:\/\/brain\.invalid\/app\/connect\/bank \(added in Plaid's API page\)/);
  assert.doesNotMatch(run.output, /BANK_FEED_|hidden\)|not a page to open|Plaid needs to know/);
});

test("a stale key at start is ignored until two new copies arrive", async () => {
  const run = await connect({ clipboard: clipboardFixture([STALE, null, null, CLIENT, SECRET]) });
  success(run);
  assert.equal(run.clipboard.state.reads, 5, "both stale polls were reached before accepting the new copies");
});

test("a URL, words, short hex and a duplicate pickup are ignored", async () => {
  const run = await connect({ clipboard: clipboardFixture([
    "", "https://dashboard.invalid/keys", "unrelated words", "a".repeat(19), CLIENT, CLIENT, SECRET,
  ]) });
  success(run);
  assert.equal(run.clipboard.state.reads, 7);
});

test("reverse order uses the named client-id length; other lengths keep fixed order", async () => {
  success(await connect({ clipboard: clipboardFixture(["", SECRET, CLIENT]) }));
  const run = await connect({
    clipboard: clipboardFixture(["", "a".repeat(20), "b".repeat(40)]),
    validate: (pair) => assert.ok(pair.clientId === "a".repeat(20) && pair.secret === "b".repeat(40), "fixed order, values withheld"),
  });
  success(run);
  assert.match(run.output, /✅ client_id picked up/);
});

test("the real validator's invalid-pair code triggers exactly one clipboard retry", async () => {
  const run = await connect({
    clipboard: clipboardFixture(["", CLIENT, SECRET, RETRY_SECRET]),
    providerFetch: async (input, init, count) => {
      assert.equal(new URL(input).hostname, "production.plaid.com");
      assert.equal(new URL(input).pathname, "/institutions/get");
      const pair = JSON.parse(init.body);
      assert.ok(pair.client_id === CLIENT && pair.secret === (count === 1 ? SECRET : RETRY_SECRET), "provider receives only the synthetic pair; values withheld");
      return new Response(JSON.stringify(count === 1
        ? { error_code: "INVALID_API_KEYS", error_message: "fixture provider refusal" }
        : { institutions: [] }), { status: count === 1 ? 400 : 200 });
    },
  });
  assert.ok(!run.error);
  assert.equal(run.state.validations, 2);
  assert.deepEqual(run.state.writes, PROVIDER_NAMES);
  assert.ok(noValues([run.output, run.stderr, JSON.stringify(run.result)].join("\n")));
});

test("a refused pair restarts the secret wait once and writes nothing after two refusals", async () => {
  const run = await connect({
    clipboard: clipboardFixture(["", CLIENT, SECRET, RETRY_SECRET]),
    validate: () => { throw Object.assign(new Error("fixture refusal"), { code: "INVALID_API_KEYS" }); },
  });
  assert.ok(run.error, "refused pair must exit nonzero");
  assert.equal(run.state.validations, 2, "both provider decision points were reached");
  assert.equal(run.clipboard.state.clears, 3);
  assert.deepEqual(run.state.writes, []);
  assert.equal(run.state.opens, 0);
  assert.match(run.error.message, /Plaid didn't accept that pair\. Copy the Production secret\. Code: INVALID_API_KEYS/);
  assert.equal((run.output.match(/STEP 2 of 2/g) || []).length, 2);
});

test("one fresh secret after a refusal validates the retained client_id before writing", async () => {
  const run = await connect({
    environment: "sandbox",
    clipboard: clipboardFixture(["", CLIENT, SECRET, RETRY_SECRET]),
    validate: (pair, count) => {
      if (count === 1) throw Object.assign(new Error("fixture refusal"), { code: "INVALID_API_KEYS" });
      assert.ok(pair.clientId === CLIENT && pair.secret === RETRY_SECRET, "fresh secret and retained ID, values withheld");
    },
  });
  assert.ok(!run.error);
  assert.equal(run.state.validations, 2);
  assert.deepEqual(run.state.writes, PROVIDER_NAMES);
  assert.match(run.output, /Copy the Sandbox secret\. Code: INVALID_API_KEYS/);
});

test("stdout, stderr, the owner return object and masked errors contain no picked-up value", async () => {
  const accepted = await connect();
  success(accepted);
  const refused = await connect({ writer: () => { throw new Error(`fixture failure ${SECRET}`); } });
  assert.equal(refused.state.validations, 1);
  assert.equal(refused.state.writes.length, 1, "the failing write path was reached");
  assert.equal(refused.state.opens, 0);
  for (const run of [accepted, refused]) {
    assert.ok(noValues([run.output, run.stderr, JSON.stringify(run.result), run.error?.message].join("\n")), "no values in public surfaces; output withheld");
  }
});

test("control: ordinary hidden entry still preserves the deploy-owned wrapping key", async () => {
  const run = await connect({ flags: {} });
  assert.ok(!run.error);
  assert.equal(run.state.prompts, 2, "the existing custody path was reached");
  assert.equal(run.state.validations, 1);
  assert.deepEqual(run.state.writes, PROVIDER_NAMES);
  assert.equal(run.state.writes.includes(WRAPPING), false);
});

test("control: ambient keys and key-valued argv switches are refused before inventory", async () => {
  let inventoryReads = 0;
  for (const name of ALL_NAMES) {
    await assert.rejects(ensureBankFeedWorkerSecrets({
      env: { [name]: CLIENT },
      listSecretNames: async () => { inventoryReads++; return [WRAPPING]; },
    }), (error) => /not accepted from environment/.test(error.message) && noValues(error.message));
  }
  assert.equal(inventoryReads, 0);
  // Green control above proves that this same inventory/write injection runs.
  for (const flags of [{ "client-id": CLIENT }, { secret: SECRET }, { "replace-keys": SECRET }, { "from-clipboard": SECRET }]) {
    const run = await connect({ flags });
    assert.ok(run.error);
    assert.match(run.error.message, /does not recognize|does not take a value/);
    assert.equal(run.state.lists, 0);
    assert.deepEqual(run.state.writes, []);
    assert.ok(noValues(run.error.message), "argv refusal never echoes the key");
  }
});

test("a half pair times out after clearing the first copy and never validates or saves", async () => {
  const run = await connect({ clipboard: clipboardFixture(["", CLIENT]) });
  assert.ok(run.error);
  assert.match(run.error.message, /Code: BANK_KEYS_CLIPBOARD_TIMEOUT/);
  assert.ok(run.clipboard.state.reads > 2, "the second-key wait was reached");
  assert.equal(run.clipboard.state.clears, 1);
  assert.equal(run.state.validations, 0);
  assert.deepEqual(run.state.writes, []);
});

test("an unknown provider failure is masked, is not retried, and cannot write", async () => {
  const run = await connect({ validate: () => { throw new Error(SECRET); } });
  assert.ok(run.error);
  assert.match(run.error.message, /Code: BANK_KEYS_VALIDATION_FAILED/);
  assert.equal(run.state.validations, 1, "the provider failure was reached once");
  assert.equal(run.clipboard.state.clears, 2);
  assert.deepEqual(run.state.writes, []);
  assert.equal(run.state.opens, 0);
  assert.ok(noValues(run.error.message));
});

test("clipboard mode cannot create a missing wrapping key", async () => {
  const run = await connect({ initial: PROVIDER_NAMES });
  assert.ok(run.error);
  assert.equal(run.state.lists, 1, "custody inventory was reached");
  assertOwnerStop(run, "SAFETY_REVIEW_REQUIRED");
  assert.equal(run.clipboard.state.reads, 0);
  assert.deepEqual(run.state.writes, []);
  assert.equal(run.state.validations, 0);
  assert.equal(run.state.opens, 0);
});

function assertOwnerStop(run, code) {
  assert.equal(run.error?.supportCode, code, "the CLI wrapper preserves the typed support code");
  assert.equal(supportErrorCode(run.error, { command: "connect" }), code);
  assert.ok(run.error.message.includes(`Code: ${code}`));
  assert.doesNotMatch(run.error.message, /[\r\n]|BANK_FEED_|Worker|brain (?:setup|update|deploy|connect)/);
  assert.ok(noValues(run.error.message), "a stopped command cannot echo a collected value");
  const help = new URL(run.error.message.split(" · Help: ")[1]);
  assert.equal(help.protocol, "file:", "help uses shipped instructions without an unpublished web page");
  assert.equal(help.href, new URL("../README.md#if-something-goes-wrong", import.meta.url).href);
  assert.match(readFileSync(help, "utf8"), /## If something goes wrong/);
}

test("an inventory request failure stops with a coded help line before pickup", async () => {
  const run = await connect({ inventoryReply: () => new Response(JSON.stringify({
    success: false, errors: [{ code: 1000, message: "fixture unavailable" }],
  }), { status: 503 }) });
  assert.equal(run.state.lists, 1, "the real inventory adapter reached its injected HTTP request");
  assertOwnerStop(run, "REMOTE_UNAVAILABLE");
  assert.equal(run.clipboard.state.reads, 0);
  assert.equal(run.state.validations, 0);
  assert.deepEqual(run.state.writes, []);
  assert.equal(run.state.opens, 0);
  success(await connect());
});

test("an invalid inventory stops with a coded help line before pickup", async () => {
  const run = await connect({ inventoryReply: () => new Response(JSON.stringify({
    success: true, result: [{ unexpected: true }],
  }), { status: 200 }) });
  assert.equal(run.state.lists, 1, "the real inventory response shape was inspected");
  assertOwnerStop(run, "REMOTE_UNAVAILABLE");
  assert.equal(run.clipboard.state.reads, 0);
  assert.equal(run.state.validations, 0);
  assert.deepEqual(run.state.writes, []);
  assert.equal(run.state.opens, 0);
});

test("give-up after ten minutes exits nonzero with a code and no writes", async () => {
  const run = await connect({ clipboard: clipboardFixture([""]) });
  assert.ok(run.error);
  assert.match(run.error.message, /Code: BANK_KEYS_CLIPBOARD_TIMEOUT/);
  assert.ok(run.clipboard.state.reads > 1, "the clipboard polling decision was reached");
  assert.equal(run.clipboard.state.milliseconds, 600_000);
  assert.equal(run.state.validations, 0);
  assert.deepEqual(run.state.writes, []);
  assert.equal(run.state.opens, 0);
});

test("Windows uses the injected clipboard reader and flushes console input after success and timeout", async () => {
  const run = await connect({ platform: "win32" });
  success(run);
  assert.equal(run.clipboard.state.flushes, 1);
  const timeout = await connect({ platform: "win32", clipboard: clipboardFixture([""]) });
  assert.ok(timeout.error);
  assert.match(timeout.error.message, /Code: BANK_KEYS_CLIPBOARD_TIMEOUT/);
  assert.ok(timeout.clipboard.state.reads > 1);
  assert.equal(timeout.clipboard.state.flushes, 1);
});

test("clipboard read or clear failures stop with a safe code before validation or writes", async () => {
  for (const phase of ["read", "clear"]) {
    const clipboard = clipboardFixture();
    if (phase === "read") clipboard.readClipboard = async () => { clipboard.state.reads++; throw new Error(SECRET); };
    else clipboard.clearClipboard = async () => { clipboard.state.clears++; throw new Error(SECRET); };
    const run = await connect({ clipboard, platform: "win32" });
    assert.ok(run.error);
    assert.match(run.error.message, /Code: BANK_KEYS_CLIPBOARD_(?:UNAVAILABLE|NOT_CLEARED)/);
    assert.ok(phase === "read" ? clipboard.state.reads > 0 : clipboard.state.clears > 0, "failure decision reached");
    assert.equal(clipboard.state.flushes, 1);
    assert.equal(run.state.validations, 0);
    assert.deepEqual(run.state.writes, []);
    assert.ok(noValues(run.error.message), "native command errors are never echoed");
  }
});

test("--from-clipboard also replaces both existing keys and uses no clipboard when already configured", async () => {
  success(await connect({ flags: { "from-clipboard": true, "replace-keys": true }, initial: ALL_NAMES }));
  const present = await connect({ initial: ALL_NAMES });
  assert.ok(!present.error);
  assert.equal(present.state.lists, 1, "the inventory decision was reached");
  assert.equal(present.clipboard.state.reads, 0);
  assert.deepEqual(present.state.writes, []);
});

test("the dispatcher keeps clipboard entry and replacement as switches", async () => {
  let seen;
  await cmdConnect("bank", {
    argv: ["node", "brain.mjs", "connect", "bank", "fixture.manifest.json", "--from-clipboard", "--replace-keys"],
    withManifestControl: (_path, action) => action(),
    connectBank: async (path, flags) => { seen = { path, flags }; },
  });
  assert.deepEqual(seen, { path: "fixture.manifest.json", flags: { "from-clipboard": true, "replace-keys": true } });
});

test("the native Windows flush script used by this ceremony remains silent", () => {
  assert.match(WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT, /FlushInputBuffer/);
  assert.doesNotMatch(WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT, /Write-|Out-|echo/i);
});
