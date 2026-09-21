import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { scannerMask, scanReadbackOutput } from "../scripts/lib/readback-secret-scan.mjs";

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

test("an opaque credential-shaped URL path segment is reported without its value", () => {
  const secret = "aB3dE5fG7hI9jK1mN3pQ5rS7tU";
  const url = `https://api.example.com/v1/${secret}/fetch`;
  const findings = scanReadbackOutput(url);
  assert.deepEqual(findings, [{
    line: 1,
    kind: "long_token",
    masked: `${secret.slice(0, 4)}:${secret.length}`,
  }]);
  assert.ok(!JSON.stringify(findings).includes(secret));
  assert.ok(!JSON.stringify(findings).includes(url));
});

test("URL credentials cannot bypass scanning through scheme case, length, or a filename-like suffix", () => {
  const values = [
    ["HTTPS://api.example.com/v1/", "0123456789abcdef".repeat(4), "/fetch"],
    ["https://api.example.com/v1/", "aB3dE5fG7hI9jK1mN3pQ5rS7tU-v1.2-data.zip", "/fetch"],
  ];
  for (const [prefix, secret, suffix] of values) {
    const findings = scanReadbackOutput(`${prefix}${secret}${suffix}`);
    assert.deepEqual(findings, [{
      line: 1,
      kind: "long_token",
      masked: `${secret.slice(0, 4)}:${secret.length}`,
    }]);
    assert.ok(!JSON.stringify(findings).includes(secret));
  }
});

test("published artifacts and absolute local paths stay clean", () => {
  const cleanValues = [
    "https://financialbrain.ai/kit/financial-brain-v0.4.6-field-kit-f6d48781ca11e8e8.zip",
    "https://cdn.example.test/releases/client-suite-v9.8.7-bundle-a1b2c3d4e5f60718.zip",
    String.raw`C:\Users\someone\a_very_long_folder_name_for_this_brain\brain.manifest.json`,
    "/Users/someone/a_very_long_folder_name_for_this_brain/brain.manifest.json",
  ];
  for (const value of cleanValues) assert.deepEqual(scanReadbackOutput(value), []);
});

test("a Windows drive-relative path without a separator stays clean", () => {
  assert.deepEqual(scanReadbackOutput("C:a_very_long_windows_drive_relative_value"), []);
});

test("the quoted-path fallback protects a long filename after a space", () => {
  const filename = "financial_record_archive_2026_complete.json";
  assert.equal(scanReadbackOutput(filename).length, 1);
  assert.deepEqual(
    scanReadbackOutput(`BRAIN_MANIFEST = "/var/lib/Financial Brain/quarterly report ${filename}"`),
    [],
  );
});

test("shared scanner previews degrade to a mask for every admitted shape", () => {
  assert.equal(scannerMask("abcd...[len=32]"), "abcd:32");
  assert.equal(scannerMask("****[len=8]"), "****:8");
  assert.equal(scannerMask("*[len=3]"), "****:3");
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
