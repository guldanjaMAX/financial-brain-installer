// A secret prompt that cannot prove it masked must refuse, not ask.
//
// On 2026-09-08 a client entered a live Cloudflare API token at this prompt on
// Windows PowerShell 5.1 and the console echoed it in full on a shared screen.
// Every guard passed while it happened: the stream was a TTY, setRawMode
// existed, and enabling raw mode returned without throwing. The console kept
// echoing anyway. The process could not tell, and the person typing believed it
// was hidden.
import assert from "node:assert/strict";
import { readHiddenInput } from "../brain.mjs";

function terminal({ raw = true } = {}) {
  const listeners = new Map();
  return {
    isTTY: true,
    isRaw: false,
    setRawMode(value) { this.isRaw = value === true ? raw : false; },
    on(event, fn) { listeners.set(event, fn); return this; },
    once(event, fn) { listeners.set(event, fn); return this; },
    removeListener(event) { listeners.delete(event); return this; },
    resume() {},
    pause() {},
    isPaused: () => false,
  };
}
const sink = { isTTY: true, write() {} };

// A prompt that neither refuses nor returns is the defect itself: on the
// unfixed code the Windows call simply waits for keystrokes, echoing them. Time
// it out and report that as the failure rather than hanging the suite.
async function refusal(platform, input) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  let timer;
  try {
    const asked = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("PROMPTED: it asked for the secret instead of refusing")), 250);
    });
    await Promise.race([readHiddenInput({ prompt: "x", input, output: sink, noun: "token" }), asked]);
    return null;
  } catch (error) {
    return String(error?.message || error);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

const windows = await refusal("win32", terminal());
assert.ok(windows, "Windows must refuse the hidden prompt outright");
assert.match(windows, /cannot be trusted to hide/i);
assert.match(windows, /Read-Host -AsSecureString/, "the refusal must name a route that does mask");
console.log("PASS  Windows refuses the hidden prompt and names a masking alternative");

// A console that accepts setRawMode and keeps echoing must be caught, not trusted.
const lying = await refusal("linux", terminal({ raw: false }));
assert.ok(lying, "a terminal that does not actually enter raw mode must be refused");
assert.match(lying, /did not disable echo/i);
console.log("PASS  a terminal that accepts setRawMode without masking is refused");
