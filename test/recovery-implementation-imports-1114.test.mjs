import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { localImplementationSpecifiers } from "../operations/cloudflare-recovery-adapter.mjs";

test("sealed graph keeps multiline declarations and excludes generated entry source", () => {
  const source = `import { first,\n  second } from "./actual.mjs";\n` +
    `export { first,\n  second } from "./exported.mjs";\n` +
    `import "./side-effect.mjs";\n` +
    `const loaded = await import("./dynamic.mjs");\n` +
    `writeFileSync(entry, 'import { value } from "./generated-entry/value.mjs";\\n');\n`;
  assert.deepEqual(localImplementationSpecifiers(Buffer.from(source)),
    ["./actual.mjs", "./dynamic.mjs", "./exported.mjs", "./side-effect.mjs"]);
});

test("actual update dependencies remain inside the recovery implementation approval", () => {
  let decisions = 0;
  for (const [path, dependencies] of [
    ["brain.mjs", ["./operations/private-update-offer.mjs"]],
    ["operations/private-update-recovery.mjs", ["./update-scheduler-inventory.mjs", "./daily-refresh-scheduler.mjs"]],
    ["operations/private-update-package.mjs", ["./private-update-offer.mjs", "./private-update-recovery.mjs"]],
  ]) {
    const specifiers = localImplementationSpecifiers(readFileSync(path));
    assert.ok(specifiers.length > 0);
    for (const dependency of dependencies) { decisions++; assert.ok(specifiers.includes(dependency)); }
  }
  assert.equal(decisions, 5);
});
