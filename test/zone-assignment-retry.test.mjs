import assert from "node:assert/strict";

import {
  isHtmlDocumentBody,
  requestZoneAssignmentWithRetry,
  ZONE_HTML_RETRY_DELAYS_MS,
  zoneAssignmentExhaustedMessage,
  zoneAssignmentRecoveredNotice,
  zoneAssignmentRetryNotice,
} from "../operations/zone-assignment-retry.mjs";

const HTML_500 = "<!DOCTYPE html><html><body>temporary edge error</body></html>";

function reply(status, body = "") {
  let reads = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      reads += 1;
      return body;
    },
    get textReads() {
      return reads;
    },
  };
}

assert.equal(isHtmlDocumentBody(HTML_500), true);
assert.equal(isHtmlDocumentBody("  <HTML><body>edge</body></HTML>"), true);
assert.equal(isHtmlDocumentBody("\n<head><title>edge</title></head>"), true);
assert.equal(isHtmlDocumentBody('{"error":"worker failure"}'), false);
assert.equal(isHtmlDocumentBody("proxy said <html> later"), false);

const retryCopy = zoneAssignmentRetryNotice({
  source: "drive",
  zone: "private",
  retry: 1,
  maxRetries: 3,
  delayMs: 1_000,
});
assert.match(retryCopy, /"drive" -> "private"/);
assert.match(retryCopy, /may already be saved/i);
assert.match(retryCopy, /retry 1 of 3/i);
assert.match(retryCopy, /1 second/i);

const recoveredCopy = zoneAssignmentRecoveredNotice({ source: "drive", zone: "private", retries: 2 });
assert.match(recoveredCopy, /same "drive" -> "private" checkpoint resumed/i);
assert.match(recoveredCopy, /2 retries/i);

const exhaustedCopy = zoneAssignmentExhaustedMessage({
  source: "drive\nnot-a-checkpoint",
  zone: "private",
  status: 500,
  detail: "the reply was a web page, not this brain",
});
assert.doesNotMatch(exhaustedCopy, /drive\nnot-a-checkpoint/, "checkpoint labels must not inject terminal lines");
assert.match(exhaustedCopy, /all 3 bounded retries were exhausted/i);
assert.match(exhaustedCopy, /previous pass may already be saved/i);
assert.match(exhaustedCopy, /this command confirmed no checkpoint/i);
assert.match(exhaustedCopy, /if an earlier brain zone run succeeded.*last confirmed checkpoint/i);
assert.match(exhaustedCopy, /safe to rerun the same brain zone command/i);

{
  const success = reply(200);
  let requests = 0;
  const result = await requestZoneAssignmentWithRetry(async () => {
    requests += 1;
    return success;
  }, {
    source: "drive",
    zone: "private",
    sleep: async () => assert.fail("an immediate success must not sleep"),
    onRetry: () => assert.fail("an immediate success must not announce a retry"),
  });
  assert.equal(requests, 1);
  assert.equal(success.textReads, 0, "a successful JSON body must remain unread for the caller");
  assert.equal(result.recovered, false);
  assert.equal(result.exhausted, false);
  assert.equal(result.retries, 0);
}

{
  const first = reply(500, HTML_500);
  const success = reply(200);
  const responses = [first, success];
  const delays = [];
  const notices = [];
  const result = await requestZoneAssignmentWithRetry(async () => responses.shift(), {
    source: "drive",
    zone: "private",
    sleep: async (delayMs) => delays.push(delayMs),
    onRetry: (notice) => notices.push(notice),
  });
  assert.equal(first.textReads, 1);
  assert.equal(success.textReads, 0);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(notices, [{ retry: 1, maxRetries: 3, delayMs: 1_000 }]);
  assert.equal(result.response, success);
  assert.equal(result.recovered, true);
  assert.equal(result.retries, 1);
}

{
  const responses = [
    reply(500, HTML_500),
    reply(500, "<html>second</html>"),
    reply(500, "<body>third</body>"),
    reply(500, "<head>fourth</head>"),
  ];
  const delays = [];
  const notices = [];
  let requests = 0;
  const result = await requestZoneAssignmentWithRetry(async () => {
    requests += 1;
    return responses.shift();
  }, {
    source: "drive",
    zone: "private",
    sleep: async (delayMs) => delays.push(delayMs),
    onRetry: (notice) => notices.push(notice),
  });
  assert.equal(requests, 4, "three retries means four total attempts, never an unbounded loop");
  assert.deepEqual(delays, ZONE_HTML_RETRY_DELAYS_MS);
  assert.deepEqual(notices.map(({ retry }) => retry), [1, 2, 3]);
  assert.equal(result.exhausted, true);
  assert.equal(result.recovered, false);
  assert.equal(result.retries, 3);
  assert.equal(result.raw, "<head>fourth</head>");
}

for (const scenario of [
  { name: "JSON 500", response: reply(500, '{"error":"real worker failure"}'), source: "drive", zone: "private" },
  { name: "HTML 502", response: reply(502, HTML_500), source: "drive", zone: "private" },
  { name: "HTML 500 list", response: reply(500, HTML_500), source: "", zone: "" },
  { name: "HTML 500 missing zone", response: reply(500, HTML_500), source: "drive", zone: "" },
  { name: "HTML 500 missing source", response: reply(500, HTML_500), source: "", zone: "private" },
]) {
  let requests = 0;
  const result = await requestZoneAssignmentWithRetry(async () => {
    requests += 1;
    return scenario.response;
  }, {
    source: scenario.source,
    zone: scenario.zone,
    sleep: async () => assert.fail(`${scenario.name} must not sleep`),
    onRetry: () => assert.fail(`${scenario.name} must not retry`),
  });
  assert.equal(requests, 1, `${scenario.name} must make one request`);
  assert.equal(result.exhausted, false);
  assert.equal(result.retries, 0);
}

{
  const failure = new Error("socket closed after write");
  let requests = 0;
  await assert.rejects(
    requestZoneAssignmentWithRetry(async () => {
      requests += 1;
      throw failure;
    }, {
      source: "drive",
      zone: "private",
      sleep: async () => assert.fail("transport failures must not sleep"),
      onRetry: () => assert.fail("transport failures must not retry"),
    }),
    (error) => error === failure,
  );
  assert.equal(requests, 1);
}

await assert.rejects(
  requestZoneAssignmentWithRetry(null),
  /request must be a function/,
);

console.log("zone assignment retry: all focused tests passed");
