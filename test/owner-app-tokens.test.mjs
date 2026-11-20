import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const css = await readFile(new URL("frontend/src/styles.css", root), "utf8");
const theme = css.match(/@theme\s*\{([^}]+)\}/)?.[1];
const builtins = new Set(("inherit current transparent black white slate gray zinc neutral stone red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose").split(" "));

async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".tsx") ? [path] : [];
  }))).flat();
}

// These are utility words that share a colour prefix, not colour names.
const nonColors = /^(?:xs|sm|base|lg|xl|[2-9]xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|solid|dashed|dotted|double|hidden|none|collapse|separate|inset|offset-.*|[trblxyse](?:-\d+)?)$/;
function customColors(source) {
  const names = [];
  for (const match of source.matchAll(/(?<![\w-])(?:bg|text|border|ring|outline|from|to|via|fill|stroke)-([a-z][a-z0-9-]*)(?:\/\d+)?/g)) {
    const name = match[1];
    if (!builtins.has(name) && !(/^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)$/.test(name)) && !nonColors.test(name)) names.push(name);
  }
  return names;
}

test("scanner reaches custom colours and ignores built-in palettes and layout utilities", () => {
  assert.deepEqual(customColors('bg-card text-ink-soft border-line-strong ring-wait-line/50 bg-neutral-bg text-sm text-center border-t bg-red-50'), ["card", "ink-soft", "line-strong", "wait-line", "neutral-bg"]);
  assert.ok(theme?.includes("--color-card:"));
});

test("every custom Tailwind colour used by the app is declared in @theme", async () => {
  assert.ok(theme, "the app theme was reached");
  const files = await sources(new URL("frontend/src/", root));
  assert.ok(files.length > 0, "the TSX scan reached app files");
  const missing = [];
  let used = 0;
  for (const file of files) {
    for (const name of customColors(await readFile(file, "utf8"))) {
      used++;
      if (!new RegExp(`--color-${name}\\s*:`).test(theme)) missing.push(`${fileURLToPath(file).split("frontend/")[1]}: ${name}`);
    }
  }
  assert.ok(used > 0, "the scan reached colour utilities");
  assert.deepEqual([...new Set(missing)], []);
});

test("control font inheritance is layered below Tailwind utilities", () => {
  const rule = /button, input, textarea, select\s*\{\s*font: inherit;\s*\}/;
  assert.match(css, rule, "the control rule exists");
  // Balance nested rules so a nearby layer cannot produce a false positive.
  const start = css.indexOf(css.match(rule)[0]);
  const stack = [];
  for (const token of css.slice(0, start).matchAll(/([^{}]*)([{}])/g)) {
    if (token[2] === "{") stack.push(token[1].trim());
    else stack.pop();
  }
  assert.ok(stack.includes("@layer base"), "control inheritance belongs in @layer base");
});
