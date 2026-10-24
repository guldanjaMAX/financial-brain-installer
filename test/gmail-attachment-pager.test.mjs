import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as gmail from "../connectors/gmail.mjs";

const query = `${gmail.gmailQuery()} has:attachment {filename:xlsx filename:xls filename:csv filename:pdf}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = async () => "synthetic-provider-authority";
function options(body = { messages: [{ id: "report-one" }] }, extra = {}) {
  return { query, pageSize: 2, opts: { attempts: 1,
    fetchImpl: async () => json(body), sleep: async () => {},
  }, ...extra };
}
async function control() {
  assert.deepEqual(await gmail.listAttachmentCandidates(token, options()), {
    ids: ["report-one"], nextPageToken: null,
  });
}

test("control: the historical membership query remains unchanged", () => {
  assert.equal(gmail.gmailQuery(), gmail.gmailQuery({ since: null }));
  assert.ok(gmail.gmailQuery({ since: "2026-01-01" }).endsWith("after:2026/01/01"));
});

test("attachment extraction does not change the historical membership hash", () => {
  const scanner = "synthetic-scanner";
  const legacy = createHash("sha256").update(JSON.stringify({
    version: 1, query: gmail.gmailQuery(),
    excludedLabelIds: [...gmail.DEFAULT_EXCLUDED_LABEL_IDS].sort(),
    extractionPolicyVersion: 1, credentialScannerFingerprint: scanner,
  })).digest("hex");
  assert.equal(gmail.gmailPolicyFingerprint({ credentialScannerFingerprint: scanner }), legacy);
});

test("candidate pager issues exactly one bounded supported-attachment request", async () => {
  let calls = 0;
  const floorQuery = `${gmail.gmailQuery({ since: "2026-01-01" })} has:attachment {filename:xlsx filename:xls filename:csv filename:pdf}`;
  assert.equal(gmail.gmailAttachmentCandidateQuery({ since: "2026-01-01" }), floorQuery);
  assert.equal(gmail.GMAIL_ATTACHMENT_BACKFILL_LIMIT, 100);
  const result = await gmail.listAttachmentCandidates(token, { query: floorQuery, pageToken: "page-one", pageSize: 2,
    opts: { attempts: 1, search: { q: "must-not-replace-query", maxResults: 500 }, fetchImpl: async (url) => {
      calls++;
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/gmail/v1/users/me/messages");
      assert.equal(parsed.searchParams.get("q"), floorQuery);
      assert.equal(parsed.searchParams.get("maxResults"), "2");
      assert.equal(parsed.searchParams.get("pageToken"), "page-one");
      return json({ messages: [{ id: "report-one" }, { id: "report-two" }], nextPageToken: "page-two" });
    } },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ids: ["report-one", "report-two"], nextPageToken: "page-two" });
});

test("candidate pager accepts an empty result but rejects malformed and overfull pages", async () => {
  await control();
  assert.deepEqual(await gmail.listAttachmentCandidates(token, options({ resultSizeEstimate: 0 })), {
    ids: [], nextPageToken: null,
  });
  for (const body of [null, [], { messages: null }, { messages: {} },
    { messages: [{ id: "one" }, { id: "two" }, { id: "three" }] }]) {
    await assert.rejects(gmail.listAttachmentCandidates(token, options(body)), error =>
      error.reason === "invalidAttachmentCandidatePage" && error.operationClass === "gmail_message_list");
  }
});

test("candidate pager rejects malformed or duplicate message identities", async () => {
  await control();
  for (const id of ["", " report-one", "report one", "report/one", "x".repeat(257), 123, null]) {
    await assert.rejects(gmail.listAttachmentCandidates(token, options({ messages: [{ id }] })),
      error => error.reason === "invalidAttachmentCandidateId");
  }
  await assert.rejects(gmail.listAttachmentCandidates(token, options({ messages: [{ id: "one" }, { id: "one" }] })),
    error => error.reason === "invalidAttachmentCandidateId");
});

test("candidate pager validates outgoing bounds before a provider read", async () => {
  await control();
  let calls = 0;
  const opts = { fetchImpl: async () => { calls++; return json({}); } };
  for (const pageSize of [0, -1, 1.5, 101, Infinity]) {
    await assert.rejects(gmail.listAttachmentCandidates(token, { query, pageSize, opts }));
  }
  for (const pageToken of ["", " page", "page\n", "x".repeat(8193), 123]) {
    await assert.rejects(gmail.listAttachmentCandidates(token, { query, pageToken, opts }));
  }
  await assert.rejects(gmail.listAttachmentCandidates(token, { query: gmail.gmailQuery(), opts }));
  assert.equal(calls, 0);
});

test("candidate pager rejects malformed and repeated returned page tokens", async () => {
  await control();
  for (const nextPageToken of ["", " page", "page\n", "x".repeat(8193), 123]) {
    await assert.rejects(gmail.listAttachmentCandidates(token, options({ nextPageToken })),
      error => error.reason === "invalidPageToken");
  }
  await assert.rejects(gmail.listAttachmentCandidates(token, options({ nextPageToken: "page-one" }, { pageToken: "page-one" })),
    error => error.reason === "repeatedPageToken");
});

test("an expired candidate token is a restart signal only after requesting that token", async () => {
  await control();
  for (const reason of ["invalidPageToken", "pageTokenExpired", "invalidArgument", "INVALID_ARGUMENT"]) {
    const opts = { attempts: 1, fetchImpl: async () => json({ error: { errors: [{ reason }] } }, 400) };
    await assert.rejects(gmail.listAttachmentCandidates(token, { query, pageToken: "expired-page", opts }),
      error => error.reason === "attachmentPageTokenExpired" && error.status === 400);
    await assert.rejects(gmail.listAttachmentCandidates(token, { query, opts }),
      error => error.reason === reason);
  }
  const opts = { attempts: 1, fetchImpl: async () => json({ error: { errors: [{ reason: "accessNotConfigured" }] } }, 403) };
  await assert.rejects(gmail.listAttachmentCandidates(token, { query, pageToken: "page-one", opts }),
    error => error.reason === "accessNotConfigured");
});
