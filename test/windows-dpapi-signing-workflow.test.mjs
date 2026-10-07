import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowUrl = new URL("../.github/workflows/windows-dpapi-signing.yml", import.meta.url);
const expectedVariables = [
  "ARTIFACT_SIGNING_ACCOUNT",
  "ARTIFACT_SIGNING_ENDPOINT",
  "ARTIFACT_SIGNING_PROFILE",
  "AZURE_CLIENT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_TENANT_ID",
];

test("the DPAPI signing workflow is manual, secretless, pinned, and gives OIDC only to its signing job", () => {
  const workflow = readFileSync(workflowUrl, "utf8").replace(/\r\n/g, "\n");
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^    permissions:\n      contents: read\n      id-token: write$/m);
  assert.doesNotMatch(workflow, /secrets\.|client-secret|creds:/i);
  const variables = [...new Set(
    [...workflow.matchAll(/\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]),
  )].sort();
  assert.deepEqual(variables, expectedVariables);
  const actions = [...workflow.matchAll(/^\s+(?:- )?uses: ([^\s#]+)(?:\s+# (.+))?$/gm)];
  assert.ok(actions.length >= 4);
  for (const [, reference, comment] of actions) {
    assert.match(reference, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i);
    assert.match(comment || "", /SHA unverified offline/);
  }
});

test("unset variables skip cleanly while configured runs compile, sign, verify, pin, and upload", () => {
  const workflow = readFileSync(workflowUrl, "utf8").replace(/\r\n/g, "\n");
  for (const name of expectedVariables) assert.match(workflow, new RegExp(`\\b${name}\\b`));
  assert.match(workflow, /enabled=false/);
  assert.match(workflow, /Artifact Signing is not configured; unsigned development behavior remains enabled/);
  assert.match(workflow, /windows-dpapi\.cs/);
  assert.match(workflow, /\/target:exe/);
  assert.match(workflow, /azure\/login@[0-9a-f]{40}/);
  assert.match(workflow, /azure\/artifact-signing-action@[0-9a-f]{40}/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /Status -ne 'Valid'/);
  assert.match(workflow, /O=Financial Brain LLC/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256/);
  assert.match(workflow, /windows-dpapi-helper\.sha256/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});
