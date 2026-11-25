import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const browserSource = readFileSync(new URL("../frontend/test/browser/owner-menu.browser.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../frontend/src/App.tsx", import.meta.url), "utf8");
const paragraph = appSource.match(/<p>(Ask the person who set up your Brain\.[\s\S]*?)<\/p>/);
assert.ok(paragraph, "the real Help fallback must be found before checking its expectation");
const helpText = paragraph[1].replace(/<\/?code>/g, "");
assert.doesNotMatch(helpText, /[<>]/, "the fallback probe only handles the current text and code markup");

const posix = {
  platform: "linux", nodePath: "/fixture/node", scriptPath: "/fixture/brain.mjs",
  env: { PATH: "" }, existsSync: () => false,
};
const windows = {
  platform: "win32", nodePath: "C:\\fixture\\node.exe", scriptPath: "C:\\fixture\\brain.mjs",
  env: { PATH: "" }, existsSync: () => false,
};

// Execute only the real expectation and its complete equality assertion.
// Importing the browser module itself would start a server before assertions.
async function checkHelp(text, calls, overrideContext) {
  const declaration = browserSource.match(/const installerStep = [\s\S]*?;(?=\r?\nconst screenshots)/)?.[0];
  const equality = browserSource.match(/else (assert\.equal\(await panel\.innerText\(\), installerStep\));/)?.[1];
  assert.ok(declaration, "the actual browser Help expectation must be reached");
  assert.ok(equality, "the browser must retain its complete exact-text Help assertion");
  return runInNewContext(`(async () => { ${declaration}\n${equality}; return installerStep; })()`, {
    renderCliCommands(value, options) {
      calls.renders.push(options);
      // Defaults simulate a Windows host; the web fixture must pin its own context.
      return renderCliCommands(value, overrideContext ?? options ?? windows);
    },
    panel: { async innerText() { calls.reads++; return text; } },
    assert: { equal(actual, expected) { calls.equalities++; assert.equal(actual, expected); } },
  });
}

const counters = () => ({ renders: [], reads: 0, equalities: 0 });

test("POSIX and Windows controls distinguish bare and renderer-derived expectations", () => {
  let equalities = 0;
  const equal = (actual, expected) => { equalities++; assert.equal(actual, expected); };
  const posixText = renderCliCommands(helpText, posix);
  const windowsText = renderCliCommands(helpText, windows);
  assert.notEqual(posixText, windowsText, "the two fixture arms must differ");
  equal(posixText, helpText);
  assert.throws(() => equal(windowsText, helpText), { code: "ERR_ASSERTION" });
  assert.equal(equalities, 2, "the negative Windows arm must reach the comparison");
  equal(windowsText, renderCliCommands(helpText, windows));
  equal(posixText, renderCliCommands(helpText, posix));
  assert.equal(equalities, 4, "both renderer-derived green controls must run");
});

test("the actual browser expectation renders an explicit web context and matches all Help copy", async () => {
  const calls = counters();
  await checkHelp(helpText, calls);
  assert.equal(calls.reads, 1);
  assert.equal(calls.equalities, 1);
  assert.equal(calls.renders.length, 1, "the reached Help expectation must use the renderer");
  const options = calls.renders[0];
  assert.equal(options.platform, posix.platform);
  assert.equal(options.nodePath, posix.nodePath);
  assert.equal(options.scriptPath, posix.scriptPath);
  assert.equal(options.env.PATH, "");
  assert.equal(options.existsSync("/fixture/absent"), false);
  assert.match(browserSource, /import \{ renderCliCommands \} from "\.\.\/\.\.\/\.\.\/operations\/cli-guidance\.mjs";/);
});

test("the actual Help expectation also passes a forced Windows renderer control", async () => {
  const calls = counters();
  try {
    await checkHelp(renderCliCommands(helpText, windows), calls, windows);
  } finally {
    assert.equal(calls.reads, 1, "the Windows arm must read the panel");
    assert.equal(calls.equalities, 1, "the Windows arm must reach the exact comparison");
  }
});

test("the exact Help assertion rejects trailing copy drift with a reached green control", async () => {
  const rejected = counters();
  await assert.rejects(checkHelp(`${helpText} Extra copy.`, rejected), { code: "ERR_ASSERTION" });
  assert.equal(rejected.reads, 1);
  assert.equal(rejected.equalities, 1, "copy rejection must reach the exact comparison");
  const accepted = counters();
  await checkHelp(helpText, accepted);
  assert.equal(accepted.reads, 1);
  assert.equal(accepted.equalities, 1);
});
