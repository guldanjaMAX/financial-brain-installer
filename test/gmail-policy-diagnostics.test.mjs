import assert from "node:assert/strict";
import test from "node:test";
import { gmailPolicyRunDiagnostics } from "./fixtures/gmail-policy-diagnostics.mjs";

const reviewOutput = "Source gmail: 100 stored document(s) would be removed\n" +
  `Review this plan, then run: brain ingest <manifest> --approve-removals ${"a".repeat(64)}`;
const review = () => ({ code: 1, output: reviewOutput, state: {} });

test("control: normal first and retry removal reviews remain visible", () => {
  const summary = gmailPolicyRunDiagnostics({ first: review(), retry: review() });
  assert.match(summary, /(?:stored document\(s\) would be removed|review=observed)/);
  assert.doesNotMatch(summary, /EPERM|EACCES|EBUSY/);
});

test("an initial checkpoint replacement failure is visible beside the later review", () => {
  const first = { code: 1, output: "EPERM: operation not permitted, rename 'private-source' -> 'private-target'" };
  const summary = gmailPolicyRunDiagnostics({ first, retry: review() });
  assert.match(summary, /^first: exit=1; review=not_observed; approval=not_observed; filesystem=EPERM\/rename$/m);
  assert.match(summary, /^retry: exit=1; review=observed; approval=observed; filesystem=not_observed$/m);
});

test("a retry chmod failure keeps its own exit status and operation", () => {
  const retry = { code: 2, output: "EACCES: permission denied, chmod 'private-target'" };
  const summary = gmailPolicyRunDiagnostics({ first: review(), retry });
  assert.match(summary, /^first: exit=1; review=observed; approval=observed; filesystem=not_observed$/m);
  assert.match(summary, /^retry: exit=2; review=not_observed; approval=not_observed; filesystem=EACCES\/chmod$/m);
});

test("diagnostics exclude raw paths, source content, credentials and state with a fixed bound", () => {
  const privatePath = String.raw`C:\fixture-private\checkpoint.json`;
  const credential = `sk-proj-${"A7".repeat(16)}`;
  const rawContent = "PRIVATE_CONTENT_SENTINEL";
  const first = { code: credential, output: `${rawContent.repeat(10_000)}\n${credential}`,
    state: { privatePath, credential, rawContent } };
  const retry = { code: null, output: `EPERM: operation not permitted, rename '${privatePath}'\n${credential}\n${rawContent}`,
    state: first.state };
  const summary = gmailPolicyRunDiagnostics({ first, retry });
  assert.ok(summary.length < 400, "diagnostic summary exceeded its fixed bound");
  for (const forbidden of [privatePath, credential, rawContent]) {
    assert.ok(!summary.includes(forbidden), "diagnostic summary exposed private fixture material");
  }
  assert.match(summary, /^first: exit=unknown;/m);
  assert.match(summary, /^retry: exit=unknown;.*filesystem=EPERM\/rename$/m);
});
