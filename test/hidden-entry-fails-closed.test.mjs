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
import { readHiddenInput, readHiddenCloudflareToken } from "../brain.mjs";

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
assert.match(token, /Read-Host -AsSecureString/, "the refusal must name a route that does mask");
console.log("PASS  the token prompt refuses on Windows and names a masking alternative");

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
