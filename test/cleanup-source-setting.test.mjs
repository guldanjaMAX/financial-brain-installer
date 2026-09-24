import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareCleanupSourceSetting,
  writeCleanupSourceSetting,
} from "../operations/cleanup-source-setting.mjs";

test("a future-load exclusion needs its exact fingerprint and passes readback", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-source-setting-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "brain.manifest.json");
  const manifest = {
    client: { slug: "fixture" },
    corpora: { google_drive: { enabled: true, exclude_paths: [] } },
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const plan = prepareCleanupSourceSetting(manifest, {
    kind: "outside_drive_path", path: "Reviewed/Archive",
  });

  assert.throws(() => writeCleanupSourceSetting(path, plan, "0".repeat(64)),
    (error) => error?.code === "cleanup_source_setting_not_approved");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), manifest);

  const receipt = writeCleanupSourceSetting(path, plan, plan.fingerprint);
  assert.equal(receipt.applied, true);
  assert.deepEqual(
    JSON.parse(readFileSync(path, "utf8")).corpora.google_drive.exclude_paths,
    ["Reviewed/Archive"],
  );
});
