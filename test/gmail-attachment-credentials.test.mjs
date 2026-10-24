import assert from "node:assert/strict";
import test from "node:test";
import { BODY, REPORT, message, fixture } from "./fixtures/gmail-attachment-parts.mjs";

const credential = () => `sk-proj-${"B8".repeat(16)}`;
const privateReport = () => `Account,Amount\nOperating cash,1200\nadmin_key: ${credential()}\n`;
const hasCredential = (value) => JSON.stringify(value).includes(credential());

test("control: clean body and two report attachments survive the credential boundary", async () => fixture(async (f) => {
  f.ids = ["clean-parts"];
  f.raw["clean-parts"] = message([["first.csv", REPORT], ["second.csv", REPORT.replace("1200", "1400")]]);
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].content.includes(BODY));
  assert.equal(f.sends[0].metadata.gmail_attachments.read_count, 2);
  assert.equal(f.state().history_id, "history-one");
}));

test("a credential attachment excludes only that part and preserves its clean sibling and body", async () => fixture(async (f) => {
  f.ids = ["private-report", "clean-sibling"];
  f.raw["private-report"] = message([["private.csv", privateReport()], ["clean.csv", REPORT]]);
  f.raw["clean-sibling"] = message([["clean.csv", REPORT]]);
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 2, "the credential-bearing report must not remove its readable family");
  const retained = f.sends.find((doc) => doc.source_id === "private-report");
  assert.ok(retained.content.includes(BODY));
  assert.ok(retained.content.includes("Operating cash"));
  assert.ok(retained.content.includes("Attachment excluded: credential_detected"));
  assert.equal(retained.metadata.gmail_attachments.items[0].reason, "credential_detected");
  assert.equal(retained.metadata.gmail_attachments.items[1].status, "read");
  assert.ok(!hasCredential(f.sends), "credential bytes must not reach the Worker");
  assert.ok(!hasCredential(f.state()), "credential bytes must not reach checkpoint state");
  assert.equal(f.state().history_id, "history-one");
  assert.equal(f.receipts.at(-1).status, "ready");
}));

test("a credential body is omitted while its readable attachment remains", async () => fixture(async (f) => {
  f.ids = ["private-body"];
  f.raw["private-body"] = message([["clean.csv", REPORT]], `${BODY} admin_key: ${credential()}`);
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 1, "a bad body cannot discard a readable attachment");
  assert.ok(f.sends[0].content.includes("Message body excluded: credential_detected"));
  assert.ok(f.sends[0].content.includes("Operating cash"));
  assert.equal(f.sends[0].metadata.gmail_body.reason, "credential_detected");
  assert.ok(!hasCredential(f.sends), "omitted body bytes must not reach the Worker");
}));

test("a credential filename cannot poison the body or survive in exclusion metadata", async () => fixture(async (f) => {
  f.ids = ["private-name"];
  f.raw["private-name"] = message([[`${credential()}.csv`, REPORT], ["clean.csv", REPORT]]);
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].content.includes(BODY));
  assert.equal(f.sends[0].metadata.gmail_attachments.items[0].reason, "credential_detected");
  assert.equal(f.sends[0].metadata.gmail_attachments.items[1].status, "read");
  assert.ok(!hasCredential(f.sends), "filename bytes must not survive in content, title or metadata");
}));

test("body-only credentials retain the established whole-family refusal outcome", async () => fixture(async (f) => {
  f.ids = ["body-only-private", "body-only-clean"];
  f.raw["body-only-private"] = message([], `${BODY} admin_key: ${credential()}`);
  f.raw["body-only-clean"] = message();
  assert.equal(await f.once(), null);
  assert.deepEqual(f.sends.map((doc) => doc.source_id), ["body-only-clean"]);
  assert.equal(f.state().history_id, "history-one");
  assert.equal(f.receipts.at(-1).docs_refused, 1);
  assert.ok(!hasCredential(f.state()), "refused body bytes must not enter checkpoint state");
}));

test("final envelope scan still catches a credential outside the MIME parts", async () => fixture(async (f) => {
  f.ids = ["clean-control"];
  f.raw["clean-control"] = message([["report.csv", REPORT]]);
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 1);
  f.ids = ["private-label"];
  f.raw["private-label"] = message([["report.csv", REPORT]]);
  f.labels = ["INBOX", credential()];
  f.marker = "history-two";
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 1, "final assembled-envelope scan must remain active");
  assert.equal(f.receipts.at(-1).docs_refused, 1);
  assert.equal(f.state().history_id, "history-two");
}));

test("control: the declared scanner opt-out reaches part preparation", async () => fixture(async (f) => {
  f.ids = ["scanner-disabled"];
  f.raw["scanner-disabled"] = message([["report.csv", privateReport()]]);
  assert.equal(await f.once(), null);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].metadata.gmail_attachments.items[0].status, "read");
  assert.ok(hasCredential(f.sends), "the fixture must prove the explicit scanner opt-out was passed through");
}, { scannerEnabled: false }));
