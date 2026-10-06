// A secret prompt that cannot prove it masked must not let anyone type a
// credential believing it is hidden.
//
// On 2026-09-08 a live Cloudflare API token was echoed in full at this prompt on
// Windows PowerShell 5.1, on a shared screen, and was revoked. Every guard
// passed while it happened: the stream was a TTY, setRawMode existed, and
// enabling raw mode returned without throwing. The console kept echoing anyway.
//
// The first fix refused EVERY hidden prompt on Windows, and the Windows suite
// caught that this helper is shared: it also removed mailbox app-password
// entry, which has no environment alternative. Refusing there protects nobody
// and strands every Windows owner. So the refusal belongs to the caller that
// has a safe alternative, and everything else warns before it asks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  askForTesting,
  closePromptsForTesting,
  openPromptsForTesting,
  promptsOpenForTesting,
  readHiddenInput,
  readHiddenCloudflareToken,
} from "../brain.mjs";

function terminal({ raw = true } = {}) {
  return {
    isTTY: true,
    isRaw: false,
    setRawMode(value) { this.isRaw = value === true ? raw : false; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    resume() {},
    pause() {},
    isPaused: () => false,
  };
}
const sink = { isTTY: true, write() {} };

async function onPlatform(platform, run) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  let timer;
  try {
    // A prompt that neither refuses nor returns is the defect itself: the
    // unfixed code simply waits for keystrokes while echoing them.
    const asked = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("PROMPTED")), 250);
    });
    await Promise.race([run(), asked]);
    return null;
  } catch (error) {
    return String(error?.message || error);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

const token = await onPlatform("win32", () =>
  readHiddenCloudflareToken({ input: terminal(), output: sink }));
assert.ok(token, "the Cloudflare token prompt must refuse on Windows");
assert.match(token, /cannot be trusted to hide/i);
assert.match(token, /not available from this Windows command in this release/i,
  "the refusal must not claim a nonexistent secure launcher");
assert.match(token, /Do not save a customer token in the user environment/i);
console.log("PASS  the token prompt refuses on Windows without inventing a masking alternative");

// The lesson from the first attempt. A secret with no environment alternative
// must still be enterable on Windows, or the fix strands the whole platform.
const shared = await onPlatform("win32", () =>
  readHiddenInput({ prompt: "x", input: terminal(), output: sink, noun: "mailbox password" }));
assert.equal(shared, "PROMPTED",
  "a secret with no alternative must still be askable on Windows; refusing it removes the only path");
console.log("PASS  a secret with no alternative still asks on Windows rather than stranding the owner");

// A console that accepts setRawMode and keeps echoing must be caught everywhere.
const lying = await onPlatform("linux", () =>
  readHiddenInput({ prompt: "x", input: terminal({ raw: false }), output: sink, noun: "token" }));
assert.match(String(lying), /did not disable echo/i);
console.log("PASS  a terminal that accepts setRawMode without masking is refused on every platform");

function interactiveStreams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value === true; return input; };
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  sink.isTTY = true;
  return { input, sink, output: () => output };
}

const scheduleLine = (input, value) => queueMicrotask(() => input.write(`${value}\n`));

async function hiddenRead(input, sink, fill) {
  const value = String(fill).repeat(40);
  scheduleLine(input, value);
  const read = await readHiddenCloudflareToken({ input, output: sink });
  try {
    assert.equal(read.toString("ascii"), value);
  } finally {
    read.fill(0);
  }
  return value;
}

async function promptOwnershipSequence(platformName) {
  const originalPlatform = process.platform;
  const priorRisk = process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK;
  Object.defineProperty(process, "platform", { value: platformName, configurable: true });
  process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK = "1";
  try {
    {
      const io = interactiveStreams();
      openPromptsForTesting({ input: io.input, output: io.sink });
      scheduleLine(io.input, "y");
      assert.equal(await askForTesting("Use recovery access? (y/n)", "n"), "y");
      const secret = await hiddenRead(io.input, io.sink, "k");
      assert.equal(promptsOpenForTesting(), true,
        "the shared question reader must be reopened before the hidden read settles");
      scheduleLine(io.input, "n");
      assert.equal(await askForTesting("Continue? (y/n)", "y"), "n",
        "the next shared question must receive its own answer, not hidden input");
      assert.equal(io.output().includes(secret), false,
        "hidden input must not reach terminal output after a shared question");
      closePromptsForTesting();
      io.input.destroy();
    }

    {
      const io = interactiveStreams();
      const secret = await hiddenRead(io.input, io.sink, "r");
      assert.equal(io.input.readableFlowing, false,
        "a first hidden read must restore stdin to a non-flowing state");
      assert.equal(io.input.isPaused(), true,
        "a first hidden read must pause stdin so the process can finish naturally");
      openPromptsForTesting({ input: io.input, output: io.sink });
      scheduleLine(io.input, "y");
      assert.equal(await askForTesting("Continue? (y/n)", "n"), "y");
      assert.equal(io.output().includes(secret), false,
        "a hidden read before the first shared question must stay hidden");
      closePromptsForTesting();
      io.input.destroy();
    }

    {
      const io = interactiveStreams();
      const first = await hiddenRead(io.input, io.sink, "u");
      const second = await hiddenRead(io.input, io.sink, "v");
      assert.equal(io.output().includes(first) || io.output().includes(second), false,
        "consecutive hidden reads must not echo either value");
      io.input.destroy();
    }
  } finally {
    closePromptsForTesting();
    if (priorRisk === undefined) delete process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK;
    else process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK = priorRisk;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
}

await promptOwnershipSequence("darwin");
console.log("PASS  hidden input owns the macOS terminal across shared-question and repeated-read sequences");
await promptOwnershipSequence("win32");
console.log("PASS  hidden input owns the Windows terminal across shared-question and repeated-read sequences");

// The Cloudflare token prompt refuses on a real Windows host unless the
// echo-risk override is set (asserted at the top of this file), so each hidden
// read below names the platform it models instead of inheriting the host's.
async function onHiddenEntryPlatform(platformName, run) {
  const originalPlatform = process.platform;
  const priorRisk = process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK;
  Object.defineProperty(process, "platform", { value: platformName, configurable: true });
  if (platformName === "win32") process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK = "1";
  try {
    return await run();
  } finally {
    closePromptsForTesting();
    if (priorRisk === undefined) delete process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK;
    else process.env.BRAIN_ALLOW_WINDOWS_ECHO_RISK = priorRisk;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
}

for (const platformName of ["darwin", "win32"]) {
  await onHiddenEntryPlatform(platformName, async () => {
    const io = interactiveStreams();
    let readCalls = 0;
    const realRead = io.input.read.bind(io.input);
    io.input.read = (...args) => {
      readCalls += 1;
      return realRead(...args);
    };
    io.input.write(`${"q".repeat(40)}\n`);
    const secret = await hiddenRead(io.input, io.sink, "d");
    assert.equal(secret, "d".repeat(40), "already-buffered input must not become the hidden value");
    assert.ok(readCalls > 0, "the buffered-input drain decision point must be reached");
    assert.equal(io.output().includes("q".repeat(12)), false, "drained input must not reach the screen");
    io.input.destroy();
  });
}
console.log("PASS  hidden entry drains bytes already buffered inside Node before reading the secret");

// A terminal echoes keystrokes itself whenever it is not in raw mode, and
// closing the shared question reader puts it back in that mode. This models
// that line discipline and a typist (or a paste) that answers the instant each
// prompt appears, the same sequence the pseudo-terminal check below drives.
// Unlike that check it does not depend on timing, and it also runs on Windows.
async function promptShownOnlyAfterEchoIsOff() {
  const key = `K7${"q".repeat(36)}Z9`;
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value === true; return input; };
  let screen = "";
  const steps = [
    ["Use recovery access? (y/n)", "y\r"],
    ["Cloudflare token (hidden):", `${key}\r`],
    ["Continue? (y/n)", "n\r"],
  ];
  let decisionPoints = 0;
  const type = (text) => {
    if (input.isRaw !== true) screen += text;
    input.write(text);
  };
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  sink.isTTY = true;
  sink.write = (chunk, encoding, callback) => {
    screen += String(chunk);
    const step = steps[0];
    if (step && screen.includes(step[0])) {
      steps.shift();
      decisionPoints += 1;
      type(step[1]);
    }
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };

  openPromptsForTesting({ input, output: sink });
  const first = await askForTesting("Use recovery access? (y/n)", "n");
  const hidden = await readHiddenCloudflareToken({ input, output: sink });
  const hiddenMatched = hidden.toString("ascii") === key;
  hidden.fill(0);
  const second = await askForTesting("Continue? (y/n)", "y");
  closePromptsForTesting();
  input.destroy();
  return { decisionPoints, keyVisible: screen.includes(key), first, hiddenMatched, second };
}

for (const platformName of ["darwin", "win32"]) {
  const receipt = await onHiddenEntryPlatform(platformName, promptShownOnlyAfterEchoIsOff);
  assert.equal(receipt.decisionPoints, 3, JSON.stringify(receipt));
  assert.equal(receipt.keyVisible, false,
    `${platformName}: a key typed the instant the hidden prompt appears must not be echoed`);
  assert.equal(receipt.first, "y", JSON.stringify(receipt));
  assert.equal(receipt.hiddenMatched, true, JSON.stringify(receipt));
  assert.equal(receipt.second, "n", JSON.stringify(receipt));
}
console.log("PASS  the hidden prompt appears only after echo is off, so an instant answer is never shown");

{
  const io = interactiveStreams();
  io.input.isTTY = undefined;
  openPromptsForTesting({ input: io.input, output: io.sink, terminal: io.input.isTTY });
  scheduleLine(io.input, "y");
  assert.equal(await askForTesting("Piped answer? (y/n)", "n"), "y");
  io.sink.write("AFTER-ANSWER");
  assert.match(io.output(), /Piped answer\? \(y\/n\).*y\r?\nAFTER-ANSWER/,
    "terminal stdout must echo a piped answer and its newline");
  closePromptsForTesting();
  io.input.destroy();
}
console.log("PASS  piped answers retain readline's terminal-output echo behavior");

if (process.platform !== "win32") {
  const driver = fileURLToPath(new URL("./fixtures/hidden-entry-pty.py", import.meta.url));
  const child = fileURLToPath(new URL("./fixtures/hidden-entry-pty-child.mjs", import.meta.url));
  const home = process.env.HOME || dirname(dirname(driver));
  const run = spawnSync("/usr/bin/python3", [driver, process.execPath, child], {
    cwd: dirname(dirname(driver)),
    encoding: "utf8",
    timeout: 15_000,
    env: {
      HOME: home,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_CHAIN: "1",
      BRAIN_TEST_LAUNCHCTL: process.env.BRAIN_TEST_LAUNCHCTL || join(home, "launchctl-unavailable"),
      BRAIN_ADMIN_KEY_FILE: process.env.BRAIN_ADMIN_KEY_FILE || join(home, ".brain-admin-key"),
      NO_COLOR: "1",
    },
  });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const receipt = JSON.parse(run.stdout.trim());
  assert.equal(receipt.decisionPoints, 3, JSON.stringify(receipt));
  assert.equal(receipt.keyVisible, false, JSON.stringify(receipt));
  assert.equal(receipt.result?.first, "y", JSON.stringify(receipt));
  assert.equal(receipt.result?.hiddenMatched, true, JSON.stringify(receipt));
  assert.equal(receipt.result?.second, "n", JSON.stringify(receipt));
  assert.equal(receipt.exited, true, JSON.stringify(receipt));
  console.log("PASS  a real pseudo-terminal completes question, hidden entry, and question without showing the key");
}
