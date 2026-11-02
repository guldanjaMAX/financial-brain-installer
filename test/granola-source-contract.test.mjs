import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectorCatalog } from "../connectors/catalog.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("manifest schema, disabled template and catalog describe supervised export only", () => {
  const schema = JSON.parse(read("manifest.schema.json")).properties.corpora.properties.granola;
  const template = JSON.parse(read("templates/brain.manifest.json")).corpora.granola;
  assert.ok(schema);
  assert.equal(schema.properties.transport.const, "file-export");
  assert.equal(schema.properties.format.const, "granola.meeting.v1");
  assert.equal(schema.additionalProperties, false);
  assert.equal(template.enabled, false);
  assert.equal(template.owner_email, "");
  assert.equal(template.export_path, "");
  const [entry] = connectorCatalog({ provider: "granola" });
  assert.equal(entry.build, "supervised_file_export");
  assert.equal(entry.installed_connection, false);
  assert.equal(entry.real_boundary, "not_run");
  for (const path of ["docs/README-developer.md", "docs/ARCHITECTURE.md", "onboarding/07-ingest-source-matrix.md"]) {
    assert.match(read(path), /Granola/);
  }
});

test("the package privacy inventory explicitly reviews every meeting import module", () => {
  const inventory = read("test/package-privacy.test.mjs");
  for (const path of ["connectors/granola-records.mjs", "connectors/granola-export.mjs", "connectors/granola-export-reader.mjs"]) {
    assert.ok(inventory.includes(JSON.stringify(path)), `missing reviewed package entry: ${path}`);
  }
});

test("source kind is registered atomically and cannot overwrite an upload registration", async t => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const post = body => fixture.post("/api/admin/brain/source-register", body, { "X-Admin-Key": fixture.env.ADMIN_KEY });
  let response = await post({ source: "meeting-export", kind: "granola" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).registered, true);
  assert.equal(fixture.first("SELECT kind FROM sources WHERE name='meeting-export'").kind, "granola");
  response = await post({ source: "meeting-export", kind: "granola" });
  assert.equal((await response.json()).registered, false);
  assert.equal(fixture.first("SELECT count(*) n FROM source_events WHERE event='registered'").n, 1);
  response = await post({ source: "meeting-export", kind: "upload" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "source_kind_conflict");
  assert.ok(fixture.seen.sql.filter(sql => /FROM sources s WHERE s.name/.test(sql)).length >= 3);
});
