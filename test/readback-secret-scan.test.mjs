import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { scanReadbackOutput } from "../scripts/lib/readback-secret-scan.mjs";

const formats = [
  (key, value) => `-e '${key}=${value}'`,
  (key, value) => `--env ${key}=${value}`,
  (key, value) => JSON.stringify({ env: { [key]: value } }),
  (key, value) => `${key} = "${value}"`,
];

test("the mcp-config help paragraph is not a credential", () => {
  // The printed paragraph at brain.mjs:6169-6173, including its exact words.
  const help =
    "After an admin-key rotation: replace any older manual MCP entry with this\n" +
    "  locator-only version and restart the AI tool. Setup refreshes Claude Code and\n" +
    "  Codex registrations automatically. Claude Desktop remains a manual config update.\n";
  assert.deepEqual(scanReadbackOutput(help), []);
});

for (const [index, format] of formats.entries()) {
  test(`env format ${index + 1} flags a secret value once without returning it`, () => {
    const secret = randomBytes(16).toString("hex");
    const findings = scanReadbackOutput(format("ADMIN_KEY", secret));
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      line: 1,
      // The shared env rule does not match a JSON-quoted key; the long-run
      // rule covers that format without duplicating the shared rule.
      kind: index === 2 ? "long_token" : "env_assignment",
      masked: `${secret.slice(0, 4)}:${secret.length}`,
    });
    assert.ok(!JSON.stringify(findings).includes(secret));
  });

  test(`env format ${index + 1} does not flag an absolute manifest path`, () => {
    const path = String.raw`C:\Users\someone\brain.manifest.json`;
    assert.deepEqual(scanReadbackOutput(format("BRAIN_MANIFEST", path)), []);
  });
}

test("a long component inside a path is not a standalone token", () => {
  const path = String.raw`C:\Users\someone\a_very_long_folder_name_for_this_brain\brain.manifest.json`;
  assert.deepEqual(scanReadbackOutput(formats[2]("BRAIN_MANIFEST", path)), []);
});

test("a long component after a space in a quoted path stays clean", () => {
  const path = String.raw`C:\Program Files\a_very_long_folder_name_for_this_brain\brain.manifest.json`;
  assert.deepEqual(scanReadbackOutput(formats[0]("BRAIN_MANIFEST", path)), []);
});

test("a bearer literal is reported once", () => {
  const secret = randomBytes(16).toString("hex");
  assert.deepEqual(scanReadbackOutput(`Authorization: Bearer ${secret}`), [{
    line: 1,
    kind: "bearer_literal",
    masked: `${secret.slice(0, 4)}:${secret.length}`,
  }]);
});

test("a private key header is reported without the header value", () => {
  assert.deepEqual(scanReadbackOutput("-----BEGIN PRIVATE KEY-----"), [{
    line: 1,
    kind: "private_key_header",
    masked: "----:27",
  }]);
});

test("the four locator fields across the four rendered formats stay clean", () => {
  const sample = [
    formats[0]("BRAIN_URL", "https://brain.example.com"),
    formats[1]("BRAIN_NAME", "example-brain"),
    formats[2]("BRAIN_MANIFEST", String.raw`C:\Users\someone\brain.manifest.json`),
    formats[3]("BRAIN_AGENT_PROFILE", "owner-assistant"),
  ].join("\n");
  assert.deepEqual(scanReadbackOutput(sample), []);
});

test("findings use one-based source line numbers", () => {
  const secret = randomBytes(16).toString("hex");
  assert.equal(scanReadbackOutput(`safe text\nAuthorization: Bearer ${secret}`)[0].line, 2);
});

test("unselected provider-specific scanner findings do not return as generic findings", () => {
  const providerShape = "sk_live_" + randomBytes(12).toString("hex");
  assert.deepEqual(scanReadbackOutput(providerShape), []);
});
