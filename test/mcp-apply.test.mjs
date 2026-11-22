/**
 * `brain mcp-config --apply` must actually connect, not print.
 *
 * Setup already wires both assistants at step 5, but a brain that is already
 * installed, or an assistant installed afterwards, had no path except a full
 * setup re-run or copying a printed command by hand. A printed command someone
 * has to retype is how a connected brain ends up unconnected.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdMcpConfig, runCliCommandWithCredentialBoundary } from "../brain.mjs";

// fileURLToPath, never `.pathname`: the pathname of a file URL is percent-encoded
// and, on Windows, keeps a leading slash before the drive letter ("/D:/a/..."),
// which resolves against the current drive as "D:\\D:\\a\\..." and never opens.
const template = fileURLToPath(new URL("../templates/brain.manifest.json", import.meta.url));
// --apply refreshes the owner's Claude guide next to the manifest, so the test
// works on a copy. A guide written beside the template would ship in the package.
const workDir = mkdtempSync(join(tmpdir(), "mcp-apply-"));
const manifest = join(workDir, "brain.manifest.json");
const fixture = JSON.parse(readFileSync(template, "utf8"));
fixture.brain.domain = "fixture.invalid";
writeFileSync(manifest, JSON.stringify(fixture));

// --apply routes to the reconciler and reports per assistant.
let sawArgs = null;
const result = await cmdMcpConfig(manifest, {
  flags: { apply: true },
  wireAgents: async (m, path) => {
    sawArgs = { slug: m?.client?.slug, path };
    return { wired: ["Claude Code", "Codex"], skipped: [], failures: [] };
  },
});
assert.deepEqual(result.wired, ["Claude Code", "Codex"]);
assert.equal(sawArgs.path, manifest, "the reconciler must receive the manifest it was given");

// A partial failure must stop loudly rather than report success.
await assert.rejects(
  cmdMcpConfig(manifest, {
    flags: { apply: true },
    wireAgents: async () => ({ wired: ["Claude Code"], skipped: [], failures: ["Codex"] }),
  }),
  /could not connect: Codex/,
);

// Neither assistant present is a statement, not a failure.
const none = await cmdMcpConfig(manifest, {
  flags: { apply: true },
  wireAgents: async () => ({ wired: [], skipped: [], failures: [] }),
});
assert.deepEqual(none.wired, []);

// An unknown flag is refused rather than silently ignored.
await assert.rejects(
  cmdMcpConfig(manifest, { flags: { aply: true }, wireAgents: async () => ({ wired: [], skipped: [], failures: [] }) }),
  /unknown option/,
);

assert.equal(existsSync(fileURLToPath(new URL("../templates/CLAUDE.md", import.meta.url))), false,
  "nothing is written beside the shipped template");

await assert.rejects(
  cmdMcpConfig(manifest, { flags: { "replace-owner-entry": true } }),
  /requires --apply/,
);

let replacementOptions;
await cmdMcpConfig(manifest, {
  flags: { apply: true, "replace-owner-entry": true },
  wireAgents: async (_manifest, _path, options) => {
    replacementOptions = options;
    return { wired: [], skipped: ["Claude Code"], failures: [] };
  },
});
assert.equal(replacementOptions.replaceOwnerEntry, true);
assert.deepEqual(replacementOptions.targets, ["claude-code-mcp"]);
assert.equal(replacementOptions.baseUrl, "https://fixture.invalid");
assert.equal(await runCliCommandWithCredentialBoundary("mcp-config", () => "local-only", {
  manifestPath: manifest,
  withWranglerSession: () => assert.fail("the saved domain needs no Cloudflare session"),
}), "local-only");
rmSync(workDir, { recursive: true, force: true });
console.log("brain mcp-config --apply connects both assistants, fails loudly, and refuses typos");
