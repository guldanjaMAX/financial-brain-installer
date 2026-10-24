import assert from "node:assert/strict";
import test from "node:test";
import { BODY, REPORT, message, fixture } from "./fixtures/gmail-attachment-parts.mjs";

test("control: clean report mail advances history and remains accepted", async () => fixture(async (f) => {
  f.ids = ["clean-message"];
  f.raw["clean-message"] = message([["report.csv", REPORT]]);
  assert.equal(await f.once(), null);
  assert.equal(f.state().history_id, "history-one");
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].content.includes("Operating cash"));
  assert.equal(f.receipts.at(-1).status, "ready");
}));

test("bad immutable attachment then corrected resend keeps readable parts and advances both windows", async () => fixture(async (f) => {
  f.ids = ["bad-original", "clean-sibling"];
  f.raw["bad-original"] = message([["broken.xlsx", "invalid workbook"], ["readable.csv", REPORT]]);
  f.raw["clean-sibling"] = message([["report.csv", REPORT]]);
  assert.equal(await f.once(), null, "an immutable bad attachment cannot pin the history cursor");
  assert.equal(f.state().history_id, "history-one");
  assert.equal(f.sends.length, 2);
  const original = f.sends.find((doc) => doc.source_id === "bad-original");
  assert.ok(original.content.includes(BODY));
  assert.ok(original.content.includes("Operating cash"));
  assert.ok(original.content.includes("Attachment excluded: malformed_attachment"));
  assert.equal(original.metadata.gmail_attachments.items[0].status, "excluded");
  assert.equal(original.metadata.gmail_attachments.items[1].status, "read");
  assert.equal(f.receipts.at(-1).status, "ready");
  f.ids = ["corrected-resend"];
  f.marker = "history-two";
  f.raw["corrected-resend"] = message([["corrected.csv", REPORT]]);
  assert.equal(await f.once(), null);
  assert.deepEqual(f.histories, ["history-zero", "history-one"]);
  assert.deepEqual(f.reads, ["bad-original", "clean-sibling", "corrected-resend"]);
  assert.equal(f.state().history_id, "history-two");
  assert.ok(f.state().done["gmail:bad-original"]);
  assert.ok(f.state().done["gmail:corrected-resend"]);
  assert.equal(f.receipts.at(-1).status, "ready");
}));

test("missing message MIME evidence still blocks history beside a readable control", async () => fixture(async (f) => {
  f.ids = ["clean-message"];
  f.raw["clean-message"] = message([["report.csv", REPORT]]);
  assert.equal(await f.once(), null);
  f.ids = ["missing-message"];
  f.marker = "history-two";
  assert.ok(await f.once());
  assert.equal(f.state().history_id, "history-one");
  assert.equal(f.sends.length, 1);
  assert.equal(f.receipts.at(-1).status, "error");
}));
