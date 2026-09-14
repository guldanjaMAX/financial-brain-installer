import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FILES = Object.freeze([
  "cloudflare-disposable-deployment-provider.test.mjs",
  "disposable-recovery-field-closeout-cli.test.mjs",
  "disposable-recovery-field-closeout.test.mjs",
  "disposable-recovery-field-deploy-cli.test.mjs",
  "disposable-recovery-field-deploy.test.mjs",
  "disposable-recovery-field-keychain-prep.test.mjs",
  "disposable-recovery-field-teardown.test.mjs",
  "disposable-recovery-target-eval-cli.test.mjs",
  "disposable-recovery-target-eval.test.mjs",
]);

const WHOLE_FILE_WINDOWS_WRAPPER =
  /if\s*\(process\.platform\s*===\s*["']win32["']\)\s*\{\s*test\([\s\S]{0,240}?suite[\s\S]{0,240}?\}\s*else\s*\{/u;
const TOP_LEVEL_PLATFORM_WRAPPER =
  /^if\s*\(process\.platform\s*(?:===|!==)\s*["'][^"']+["']\)\s*\{/mu;
const SILENT_WINDOWS_RETURN =
  /if\s*\(process\.platform\s*===\s*["']win32["']\)\s*return\s*;/u;

test("field suites register portable tests and represent platform limits as test skips", () => {
  for (const name of FILES) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, WHOLE_FILE_WINDOWS_WRAPPER, `${name} hides a whole suite`);
    assert.doesNotMatch(source, TOP_LEVEL_PLATFORM_WRAPPER,
      `${name} has a top-level platform wrapper`);
    assert.doesNotMatch(source, SILENT_WINDOWS_RETURN, `${name} silently passes on Windows`);
    assert.doesNotMatch(source, /macOS-only[^\n]*suite/u,
      `${name} collapses individual registrations into one suite skip`);
  }
});
