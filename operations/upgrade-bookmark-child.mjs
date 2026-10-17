import { saveUpgradeBookmark } from "./upgrade-bookmark.mjs";

// Only the reviewed writer runs here. Keep native errors and identifying
// receipt bytes off stderr; the parent accepts a small, closed result shape.
const chunks = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65_536) throw new Error("invalid receipt request");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  let request;
  try { request = JSON.parse(bytes.toString("utf8")); }
  finally { bytes.fill(0); }
  const path = saveUpgradeBookmark(request.record, {
    directory: request.directory, now: () => new Date(request.capturedAt),
  });
  process.stdout.write(JSON.stringify({ path }));
} catch (error) {
  const code = ["UPGRADE_BOOKMARK_ACL_TIMEOUT", "UPGRADE_BOOKMARK_MAC_ACL_TIMEOUT"].includes(error?.code)
    ? error.code : "UPGRADE_BOOKMARK_FAILED";
  process.stdout.write(JSON.stringify({ code }));
  process.exitCode = 1;
} finally {
  for (const chunk of chunks) chunk.fill(0);
}
