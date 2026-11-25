import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { workerBindings } from "../brain.mjs";
import { POST_LAUNCHER_TEST_COMMANDS, TEST_COMMANDS } from "../scripts/run-test-chain.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("support contact bindings are optional and preserve the ordinary owner bindings", () => {
  const cfg = { d1_database_id: "fixture-db" };
  for (const value of [undefined, {}, { contact_url: "" }, { contact_url: "   " }, { contact_url: 12 }]) {
    const bindings = workerBindings({ support: value }, cfg);
    assert.equal(bindings.filter((row) => row.name === "BRAIN_NAME").length, 1,
      "every omitted-contact arm must reach real binding construction");
    assert.equal(bindings.filter((row) => row.name === "BRAIN_SUPPORT_CONTACT_URL").length, 0);
  }
  for (const contact of ["https://support.invalid/contact", "mailto:help@support.invalid"]) {
    const bindings = workerBindings({ support: { contact_url: `  ${contact}  ` } }, cfg);
    assert.deepEqual(bindings.filter((row) => row.name === "BRAIN_SUPPORT_CONTACT_URL"), [
      { type: "plain_text", name: "BRAIN_SUPPORT_CONTACT_URL", text: contact },
    ]);
  }
});

test("schema, template and guide describe the same optional support contact", () => {
  const schema = JSON.parse(read("../manifest.schema.json"));
  const template = JSON.parse(read("../templates/brain.manifest.json"));
  const support = schema.properties.support;
  assert.equal(support.type, "object");
  assert.equal(support.additionalProperties, false);
  assert.equal(schema.required.includes("support"), false);
  const pattern = new RegExp(support.properties.contact_url.pattern);
  assert.equal(pattern.test("https://support.invalid/contact"), true);
  assert.equal(pattern.test("mailto:help@support.invalid"), true);
  assert.equal(pattern.test("http://support.invalid/contact"), false);
  assert.deepEqual(template.support, {});
  assert.match(read("../docs/README-developer.md"), /Set `support\.contact_url` in the manifest/);
});

test("both owner menu regression suites are in both ordered-chain lists", () => {
  for (const path of ["test/owner-menu-command-1121.test.mjs", "test/owner-menu-basics-0434.test.mjs"]) {
    const command = `node --test ${path}`;
    assert.equal(TEST_COMMANDS.filter((row) => row === command).length, 1);
    assert.equal(POST_LAUNCHER_TEST_COMMANDS.filter((row) => row === command).length, 1);
  }
});
