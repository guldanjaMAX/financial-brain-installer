// Google setup on Windows: the technician reads the Desktop OAuth client ID and
// secret from the clipboard inside the CLI process, never from a typed prompt.
//
// Every Windows path here is simulated with an injected platform and an
// in-memory clipboard. Nothing touches the real desktop clipboard, a real
// PowerShell, a browser, or Google.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { cmdTechnician } from "../brain.mjs";
import {
  WINDOWS_CLIPBOARD_CLEAR_SCRIPT,
  WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT,
  clearCustomApiClipboard,
  flushWindowsConsoleInput,
} from "../operations/custom-api-clipboard.mjs";
import {
  TECHNICIAN_STEPS,
  WINDOWS_GOOGLE_OWNER_GUIDANCE,
  collectGoogleClientFromClipboard,
  googleClipboardValueKind,
  renderTechnicianStepBriefing,
  runTechnicianStep,
  technicianPlan,
} from "../operations/technician-setup.mjs";

// Synthetic values in the exact Google shapes, assembled at runtime so no
// credential-looking literal sits in the source.
const CLIENT_ID = ["123456789012", "fixtureclientidonly0123456789abc.apps.googleusercontent.com"].join("-");
const CLIENT_SECRET = ["GOCSPX", "fixtureOnly_notARealSecret01"].join("-");

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-google-windows-clipboard-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const fixtureScriptPath = resolve("/fixture/brain.mjs");
const fixtureNodePath = resolve("/fixture/node");
writeFileSync(manifestPath, JSON.stringify({
  manifest_version: 1,
  client: { slug: "fixture", display_name: "Fixture Brain" },
  brain: { domain: "brain.fixture.test", worker_name: "fixture-brain" },
  corpora: {
    google_drive: { enabled: true },
    gmail: { enabled: true },
    calendar: { enabled: true },
    zoom: { enabled: true },
    imap: { enabled: true },
  },
}));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

/**
 * An in-memory clipboard. `script` lists what the owner copies: each entry is
 * placed on the clipboard just before the matching read (null = no change).
 * `clearWorks: false` simulates the Windows PowerShell 5.1 clear that throws.
 */
function fakeClipboard(script, { clearWorks = true, readFailsAt = new Set() } = {}) {
  const state = { text: "", reads: 0, clears: 0, failedClears: 0 };
  return {
    state,
    readClipboard: async () => {
      const index = state.reads++;
      if (readFailsAt.has(index) || readFailsAt.has("always")) throw new Error("clipboard command failed");
      if (index < script.length && script[index] !== null) state.text = script[index];
      return state.text;
    },
    clearClipboard: async () => {
      state.clears++;
      if (!clearWorks) {
        state.failedClears++;
        throw new Error("clipboard command failed");
      }
      state.text = "";
    },
  };
}

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (milliseconds) => { current += milliseconds; },
  };
}

function windowsGoogleStep({
  clipboard,
  clock = fakeClock(),
  spawn,
  readHidden,
  say,
  flushConsoleInput = () => true,
  ...rest
} = {}) {
  return runTechnicianStep({
    step: "google",
    platformName: "win32",
    manifestPath,
    flags: {},
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "C:\\fixture\\bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    readHidden: readHidden ?? (async () => { throw new Error("the hidden prompt must not run on Windows"); }),
    googleClipboard: {
      readClipboard: clipboard.readClipboard,
      clearClipboard: clipboard.clearClipboard,
      say: say ?? (() => {}),
      sleep: clock.sleep,
      now: clock.now,
    },
    spawn: spawn ?? (() => { throw new Error("the connector must not start"); }),
    flushConsoleInput,
    ...rest,
  });
}

test("the clipboard accepts only exact Google Desktop client shapes", () => {
  assert.equal(googleClipboardValueKind(CLIENT_ID), "client_id");
  assert.equal(googleClipboardValueKind(`  ${CLIENT_ID}\r\n`), "client_id", "a trailing newline from Get-Clipboard is trimmed");
  assert.equal(googleClipboardValueKind(CLIENT_SECRET), "client_secret");
  for (const malformed of [
    "",
    "   ",
    null,
    undefined,
    42,
    "hello",
    "Financial Brain",
    "https://console.cloud.google.com/auth/clients",
    `${CLIENT_ID} ${CLIENT_SECRET}`,
    `${CLIENT_ID}\n${CLIENT_SECRET}`,
    CLIENT_ID.replace(".apps.googleusercontent.com", ".example.com"),
    CLIENT_ID.toUpperCase(),
    `x${CLIENT_ID}`,
    CLIENT_SECRET.replace("GOCSPX-", "GOCSPX "),
    CLIENT_SECRET.replace("GOCSPX-", ""),
    "GOCSPX-short",
    `${CLIENT_SECRET}${"a".repeat(300)}`,
  ]) {
    assert.equal(googleClipboardValueKind(malformed), null, `must refuse: ${JSON.stringify(String(malformed)).slice(0, 40)}`);
  }
});

test("Windows Google reads ID then secret from the clipboard, clears it, and passes them only to the connector child", async () => {
  const clipboard = fakeClipboard([null, CLIENT_ID, null, "an unrelated copied word", CLIENT_SECRET]);
  const said = [];
  const calls = [];
  let promptCalls = 0;
  const receipt = await windowsGoogleStep({
    clipboard,
    say: (line) => said.push(line),
    readHidden: async () => { promptCalls++; return Buffer.from("must-not-be-read"); },
    spawn: (node, args, options) => {
      // The values exist while the child runs, and only in its environment.
      assert.equal(options.env.GOOGLE_CLIENT_ID, CLIENT_ID);
      assert.equal(options.env.GOOGLE_CLIENT_SECRET, CLIENT_SECRET);
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined, "ambient secrets never cross");
      assert.equal(clipboard.state.text, "", "the clipboard is clear before the consent page opens");
      calls.push({ node, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(receipt, { step: "google", completed: true, commands_run: 1 });
  assert.equal(promptCalls, 0, "no typed prompt on Windows");
  assert.deepEqual(calls[0].args, [fixtureScriptPath, "connect", "google", "--scopes", "drive,gmail,calendar"]);
  assert.doesNotMatch(calls[0].args.join(" "), /GOCSPX|googleusercontent/, "no value in argv");
  // The receipt and the coordinator's copy of the child environment are scrubbed.
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_ID, "");
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_SECRET, "");
  assert.doesNotMatch(JSON.stringify(receipt), /GOCSPX|googleusercontent/);
  // Nothing the window printed names either value.
  const printed = said.join("\n");
  assert.equal(printed.includes(CLIENT_ID), false);
  assert.equal(printed.includes(CLIENT_SECRET), false);
  assert.doesNotMatch(printed, /GOCSPX|googleusercontent/);
  assert.match(said[0], /Copy the Client ID/);
  assert.match(printed, /Client ID received\. Now copy the Client secret\./);
  assert.match(printed, /received and cleared from the clipboard/);
  assert.ok(clipboard.state.clears >= 2, "cleared after each capture and once more before proof");
  assert.equal(clipboard.state.text, "");
});

test("Windows Google accepts the secret first and the ID second", async () => {
  const clipboard = fakeClipboard([CLIENT_SECRET, null, CLIENT_ID]);
  const said = [];
  let env = null;
  await windowsGoogleStep({
    clipboard,
    say: (line) => said.push(line),
    spawn: (_node, _args, options) => { env = { ...options.env }; return { status: 0 }; },
  });
  assert.equal(env.GOOGLE_CLIENT_ID, CLIENT_ID);
  assert.equal(env.GOOGLE_CLIENT_SECRET, CLIENT_SECRET);
  assert.match(said.join("\n"), /Client secret received\. Now copy the Client ID\./);
});

test("an empty clipboard is refused after the wait, before any connector or prompt, and the clipboard is cleared", async () => {
  const clipboard = fakeClipboard([]);
  let childCalls = 0;
  let promptCalls = 0;
  await assert.rejects(
    windowsGoogleStep({
      clipboard,
      readHidden: async () => { promptCalls++; return Buffer.alloc(0); },
      spawn: () => { childCalls++; return { status: 0 }; },
    }),
    (error) => error.code === "google_clipboard_timeout" &&
      /Nothing was saved/.test(error.message) &&
      !/GOCSPX|googleusercontent/.test(error.message),
  );
  assert.equal(childCalls, 0);
  assert.equal(promptCalls, 0);
  assert.ok(clipboard.state.clears >= 1, "a refusal still clears the clipboard");
  // 30 minutes of 3-second polls, then stop: the wait is bounded.
  assert.ok(clipboard.state.reads > 500 && clipboard.state.reads < 700, `bounded polling, saw ${clipboard.state.reads}`);
});

test("malformed or partial clipboard values are never taken for credentials and never start the connector", async () => {
  for (const script of [
    ["not a client id", "GOCSPX-short", `${CLIENT_ID} ${CLIENT_SECRET}`],
    [CLIENT_SECRET.replace("GOCSPX-", "")],
    [CLIENT_ID],
    [CLIENT_SECRET],
    [`${CLIENT_ID}\n${CLIENT_SECRET}`],
  ]) {
    const clipboard = fakeClipboard(script);
    let childCalls = 0;
    await assert.rejects(
      windowsGoogleStep({ clipboard, spawn: () => { childCalls++; return { status: 0 }; } }),
      (error) => error.code === "google_clipboard_timeout" && !error.message.includes(CLIENT_SECRET),
    );
    assert.equal(childCalls, 0);
    assert.equal(clipboard.state.text, "", "whatever was left is cleared at the refusal");
  }
});

test("repeated clipboard read failures stop the step without starting the connector", async () => {
  const clipboard = fakeClipboard([], { readFailsAt: new Set(["always"]) });
  let childCalls = 0;
  await assert.rejects(
    windowsGoogleStep({ clipboard, spawn: () => { childCalls++; return { status: 0 }; } }),
    (error) => error.code === "google_clipboard_unavailable" && /Nothing was saved/.test(error.message),
  );
  assert.equal(childCalls, 0);
  assert.equal(clipboard.state.reads, 10, "bounded: ten failed reads in a row, then stop");
});

test("a few failed clipboard reads in a row are tolerated", async () => {
  const clipboard = fakeClipboard([null, null, null, CLIENT_ID, CLIENT_SECRET], { readFailsAt: new Set([0, 1, 2]) });
  let env = null;
  await windowsGoogleStep({
    clipboard,
    spawn: (_node, _args, options) => { env = { ...options.env }; return { status: 0 }; },
  });
  assert.equal(env.GOOGLE_CLIENT_ID, CLIENT_ID);
  assert.equal(env.GOOGLE_CLIENT_SECRET, CLIENT_SECRET);
});

test("a clipboard that will not clear waits for an ordinary copied word, then continues", async () => {
  // The clear always throws (the PowerShell 5.1 failure). The owner copies the
  // two values, then an ordinary word once the window asks for it.
  const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET, null, null, "hello"], { clearWorks: false });
  const said = [];
  let env = null;
  await windowsGoogleStep({
    clipboard,
    say: (line) => said.push(line),
    spawn: (_node, _args, options) => {
      assert.equal(clipboard.state.text, "hello", "the secret is off the clipboard before the connector starts");
      env = { ...options.env };
      return { status: 0 };
    },
  });
  assert.equal(env.GOOGLE_CLIENT_SECRET, CLIENT_SECRET);
  assert.match(said.join("\n"), /copy any ordinary word in your browser now/i);
  assert.ok(clipboard.state.failedClears >= 3);
});

test("a clipboard that keeps the secret stops the step before the connector, with nothing saved", async () => {
  const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET], { clearWorks: false });
  let childCalls = 0;
  await assert.rejects(
    windowsGoogleStep({ clipboard, spawn: () => { childCalls++; return { status: 0 }; } }),
    (error) => error.code === "google_clipboard_not_cleared" &&
      /stopped before connecting/.test(error.message) &&
      !error.message.includes(CLIENT_SECRET),
  );
  assert.equal(childCalls, 0);
});

test("the collected buffers are zeroed by the step, and zeroed on every refusal", async () => {
  const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET]);
  const clock = fakeClock();
  const collected = await collectGoogleClientFromClipboard({ ...clipboard, ...clock });
  assert.equal(collected.clientId.toString("utf8"), CLIENT_ID);
  assert.equal(collected.clientSecret.toString("utf8"), CLIENT_SECRET);

  // Observe the buffers the collector creates for the two values, through the
  // real step: once on success, once on a refusal after both were captured.
  const seen = [];
  const originalFrom = Buffer.from;
  Buffer.from = function observed(...args) {
    const value = originalFrom.apply(Buffer, args);
    if (args[0] === CLIENT_ID || args[0] === CLIENT_SECRET) seen.push(value);
    return value;
  };
  try {
    await windowsGoogleStep({ clipboard: fakeClipboard([CLIENT_ID, CLIENT_SECRET]), spawn: () => ({ status: 0 }) });
    await assert.rejects(
      windowsGoogleStep({ clipboard: fakeClipboard([CLIENT_ID, CLIENT_SECRET], { clearWorks: false }) }),
      (error) => error.code === "google_clipboard_not_cleared",
    );
    await assert.rejects(
      windowsGoogleStep({
        clipboard: fakeClipboard([CLIENT_ID, CLIENT_SECRET]),
        spawn: () => ({ status: 1 }),
      }),
      /paused before completion/,
    );
  } finally {
    Buffer.from = originalFrom;
  }
  // Two captured values per run, plus the readback copies the clear proof
  // makes while the clipboard still holds a value; all must end zeroed.
  assert.ok(seen.length >= 6, "two captured values in each of the three runs");
  for (const buffer of seen) assert.ok(buffer.every((byte) => byte === 0), "every captured value buffer is zeroed");
});

test("without a clipboard reader the Windows Google step refuses before anything runs", async () => {
  let childCalls = 0;
  let flushes = 0;
  await assert.rejects(
    runTechnicianStep({
      step: "google",
      platformName: "win32",
      manifestPath,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      readHidden: async () => { throw new Error("must not prompt"); },
      spawn: () => { childCalls++; return { status: 0 }; },
      flushConsoleInput: () => { flushes++; return true; },
    }),
    (error) => error.code === "windows_clipboard_unavailable",
  );
  assert.equal(childCalls, 0);
  assert.equal(flushes, 1, "the console input is flushed on this refusal too");
});

test("the Windows Google step still requires the three Google sources enabled first", async () => {
  const partialPath = join(sandbox, "partial.manifest.json");
  writeFileSync(partialPath, JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Fixture Brain" },
    corpora: { google_drive: { enabled: true } },
  }));
  const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET]);
  await assert.rejects(
    windowsGoogleStep({ clipboard, manifestPath: partialPath }),
    /Google sources enabled before connection/,
  );
  assert.equal(clipboard.state.reads, 0, "the clipboard is not read before the plan allows the step");
});

test("Zoom and IMAP keep the Windows refusal", async () => {
  for (const step of ["zoom", "imap"]) {
    const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET]);
    await assert.rejects(
      runTechnicianStep({
        step,
        platformName: "win32",
        manifestPath,
        scriptPath: fixtureScriptPath,
        nodePath: fixtureNodePath,
        googleClipboard: clipboard,
        spawn: () => { throw new Error("must not launch"); },
        flushConsoleInput: () => { throw new Error("only the Google step flushes the console"); },
      }),
      (error) => error.code === "windows_secure_input_unavailable",
    );
    assert.equal(clipboard.state.reads, 0);
  }
});

test("macOS keeps the hidden prompt and never touches the clipboard", async () => {
  const entered = [Buffer.from(CLIENT_ID), Buffer.from(CLIENT_SECRET)];
  const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET]);
  let env = null;
  const receipt = await runTechnicianStep({
    step: "google",
    platformName: "darwin",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin" },
    readHidden: async () => entered.shift(),
    googleClipboard: clipboard,
    spawn: (_node, _args, options) => { env = { ...options.env }; return { status: 0 }; },
    flushConsoleInput: () => { throw new Error("macOS never runs the Windows console flush"); },
  });
  assert.deepEqual(receipt, { step: "google", completed: true, commands_run: 1 });
  assert.equal(env.GOOGLE_CLIENT_ID, CLIENT_ID);
  assert.equal(clipboard.state.reads, 0);
  assert.equal(clipboard.state.clears, 0);
});

test("the Windows briefing and plan say copy, not type; macOS wording is unchanged", () => {
  const google = TECHNICIAN_STEPS.find((step) => step.id === "google");
  const windowsBriefing = renderTechnicianStepBriefing("google", { platformName: "win32" });
  assert.match(windowsBriefing, /picks each one up from the clipboard by itself/);
  assert.match(windowsBriefing, /Nothing is typed or pasted into the window/);
  assert.doesNotMatch(windowsBriefing, /hidden terminal prompt/);
  const macBriefing = renderTechnicianStepBriefing("google", { platformName: "darwin" });
  assert.match(macBriefing, /hidden terminal prompt/);
  assert.equal(macBriefing.includes(google.owner_guidance.owner_only), true);

  const windowsPlan = technicianPlan(manifestPath, { platformName: "win32", intent: "existing_this_computer" });
  const darwinPlan = technicianPlan(manifestPath, { platformName: "darwin", intent: "existing_this_computer" });
  assert.deepEqual(windowsPlan.steps.find((step) => step.id === "google").owner_guidance, WINDOWS_GOOGLE_OWNER_GUIDANCE);
  assert.deepEqual(darwinPlan.steps.find((step) => step.id === "google").owner_guidance, google.owner_guidance);
});

test("the public technician command wires the clipboard on Windows and prints neither value", async () => {
  const clipboard = fakeClipboard([CLIENT_ID, CLIENT_SECRET]);
  const clock = fakeClock();
  const said = [];
  const briefings = [];
  const childEnvs = [];
  const logged = [];
  let flushes = 0;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args.join(" "));
  console.error = (...args) => logged.push(args.join(" "));
  let receipt;
  try {
    receipt = await cmdTechnician(manifestPath, { run: "google" }, {
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      baseEnv: { PATH: "C:\\fixture\\bin" },
      platformName: "win32",
      readClipboard: clipboard.readClipboard,
      clearClipboard: clipboard.clearClipboard,
      sleep: clock.sleep,
      now: clock.now,
      say: (line) => said.push(line),
      writeBriefing: (text) => briefings.push(text),
      readHidden: async () => { throw new Error("must not prompt on Windows"); },
      spawn: (_node, args, options) => {
        childEnvs.push({ args, id: options.env.GOOGLE_CLIENT_ID, secret: options.env.GOOGLE_CLIENT_SECRET });
        return { status: 0 };
      },
      flushConsoleInput: () => { flushes++; return true; },
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(receipt, { step: "google", completed: true, commands_run: 1 });
  assert.equal(flushes, 1, "the public command flushes the console input once, after the step");
  assert.equal(childEnvs.length, 1);
  assert.equal(childEnvs[0].id, CLIENT_ID);
  assert.equal(childEnvs[0].secret, CLIENT_SECRET);
  assert.match(briefings.join("\n"), /from the clipboard by itself/);
  const everything = [...said, ...briefings, ...logged].join("\n");
  assert.equal(everything.includes(CLIENT_ID), false);
  assert.equal(everything.includes(CLIENT_SECRET), false);
  assert.equal(clipboard.state.text, "");
});

test("the Windows clipboard clear never uses an empty value and proves itself by readback", () => {
  assert.doesNotMatch(WINDOWS_CLIPBOARD_CLEAR_SCRIPT, /\$null|-Value\s*''|-Value\s*""/i);
  assert.match(WINDOWS_CLIPBOARD_CLEAR_SCRIPT, /\[System\.Windows\.Forms\.Clipboard\]::Clear\(\)/);
  assert.match(WINDOWS_CLIPBOARD_CLEAR_SCRIPT, /Get-Clipboard -Raw/);
  assert.match(WINDOWS_CLIPBOARD_CLEAR_SCRIPT, /exit 3/);
  assert.doesNotMatch(WINDOWS_CLIPBOARD_CLEAR_SCRIPT, /"/, "no double quote, so Windows argument quoting cannot split it");

  const calls = [];
  clearCustomApiClipboard({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    spawn: (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shell, false);
  assert.equal(calls[0].args.at(-1), WINDOWS_CLIPBOARD_CLEAR_SCRIPT);

  // Text still on the clipboard after the clear exits 3, which must surface
  // as a failure so no caller reports a clear that did not happen.
  assert.throws(
    () => clearCustomApiClipboard({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      spawn: () => ({ status: 3, signal: null, stdout: "", stderr: "" }),
    }),
    /clipboard command failed/,
  );
});

test("the Windows Google step flushes the console input when it ends: success, every refusal, and a connector failure", async () => {
  const runs = [
    { name: "success", clipboard: () => fakeClipboard([CLIENT_ID, CLIENT_SECRET]), connector: { status: 0 } },
    { name: "timeout", clipboard: () => fakeClipboard([]), refusal: (error) => error.code === "google_clipboard_timeout" },
    {
      name: "clipboard not cleared",
      clipboard: () => fakeClipboard([CLIENT_ID, CLIENT_SECRET], { clearWorks: false }),
      refusal: (error) => error.code === "google_clipboard_not_cleared",
    },
    {
      name: "clipboard unreadable",
      clipboard: () => fakeClipboard([], { readFailsAt: new Set(["always"]) }),
      refusal: (error) => error.code === "google_clipboard_unavailable",
    },
    {
      name: "connector failure",
      clipboard: () => fakeClipboard([CLIENT_ID, CLIENT_SECRET]),
      connector: { status: 1 },
      refusal: (error) => /paused before completion/.test(error.message),
    },
  ];
  for (const run of runs) {
    const order = [];
    const step = windowsGoogleStep({
      clipboard: run.clipboard(),
      spawn: run.connector ? () => { order.push("connector"); return run.connector; } : undefined,
      flushConsoleInput: () => { order.push("flush"); return true; },
    });
    if (run.refusal) await assert.rejects(step, run.refusal, run.name);
    else assert.deepEqual(await step, { step: "google", completed: true, commands_run: 1 }, run.name);
    const expected = run.connector ? ["connector", "flush"] : ["flush"];
    assert.deepEqual(order, expected, `${run.name}: one flush, after everything else`);
  }

  // A flush that fails never replaces the step's own result.
  const failingFlush = () => { throw new Error("flush failed"); };
  assert.deepEqual(
    await windowsGoogleStep({
      clipboard: fakeClipboard([CLIENT_ID, CLIENT_SECRET]),
      spawn: () => ({ status: 0 }),
      flushConsoleInput: failingFlush,
    }),
    { step: "google", completed: true, commands_run: 1 },
  );
  await assert.rejects(
    windowsGoogleStep({ clipboard: fakeClipboard([]), flushConsoleInput: failingFlush }),
    (error) => error.code === "google_clipboard_timeout",
  );
});

test("the Windows console flush empties this window's input, reads and prints nothing, and never throws", () => {
  assert.match(WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT, /\$Host\.UI\.RawUI\.FlushInputBuffer\(\)/);
  assert.match(WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT, /\[Console\]::ReadKey\(\$true\)/, "fallback discards keys without echo");
  assert.doesNotMatch(WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT, /"/, "no double quote, so Windows argument quoting cannot split it");
  assert.doesNotMatch(WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT, /Clipboard|Read-Host|Write-|Out-|echo/i);

  const calls = [];
  const windows = { SystemRoot: "C:\\Windows", CLOUDFLARE_API_TOKEN: "ambient-secret" };
  const flushed = flushWindowsConsoleInput({
    platform: "win32",
    environment: windows,
    stdinIsConsole: () => true,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, signal: null };
    },
  });
  assert.equal(flushed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CONSOLE_INPUT_FLUSH_SCRIPT]);
  assert.equal(calls[0].options.shell, false);
  // stdin is inherited so the child shares this console: with no inherited
  // stdio, windowsHide gives it a new hidden console and the flush would miss.
  assert.deepEqual(calls[0].options.stdio, ["inherit", "ignore", "ignore"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.CLOUDFLARE_API_TOKEN, undefined, "ambient secrets never cross");

  // Failures report false and never throw.
  for (const spawn of [
    () => ({ status: 3, signal: null }),
    () => ({ status: null, signal: "SIGTERM" }),
    () => ({ error: new Error("spawn failed") }),
    () => { throw new Error("spawn threw"); },
  ]) {
    assert.equal(flushWindowsConsoleInput({ platform: "win32", environment: windows, stdinIsConsole: () => true, spawn }), false);
  }

  // No console to flush, another platform, or no Windows directory: nothing runs.
  let ran = 0;
  const counted = () => { ran++; return { status: 0, signal: null }; };
  assert.equal(flushWindowsConsoleInput({ platform: "win32", environment: windows, stdinIsConsole: () => false, spawn: counted }), false);
  assert.equal(flushWindowsConsoleInput({ platform: "darwin", environment: windows, stdinIsConsole: () => true, spawn: counted }), false);
  assert.equal(flushWindowsConsoleInput({ platform: "win32", environment: {}, stdinIsConsole: () => true, spawn: counted }), false);
  assert.equal(
    flushWindowsConsoleInput({ platform: "win32", environment: windows, stdinIsConsole: () => { throw new Error("no tty"); }, spawn: counted }),
    false,
  );
  assert.equal(ran, 0);
});
