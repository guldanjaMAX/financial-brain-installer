import assert from "node:assert/strict";

// Lifecycle suites simulate a verified receipt just as they simulate provider
// replies. Real persistence and native ACLs belong to the receipt suites.
export function createUpgradeBookmarkWriter() {
  const receipts = [];
  return {
    receipts,
    saveUpgradeBookmark(record) {
      for (const key of ["account_id", "database_id", "bookmark", "from_version", "to_version"]) {
        assert.equal(typeof record[key], "string", `receipt ${key} must be a string`);
        assert.ok(record[key].length > 0, `receipt ${key} must be present`);
      }
      assert.match(record.manifest_sha256, /^[a-f0-9]{64}$/);
      receipts.push(structuredClone(record));
      return "fixture-verified-bookmark-receipt";
    },
    assertCalled() {
      assert.ok(receipts.length > 0, "the simulated update reached the injected receipt writer");
    },
  };
}
