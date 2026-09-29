import assert from "node:assert/strict";
import test from "node:test";

import { ensureBankFeedWrappingKey } from "../operations/bank-feed-owner-secrets.mjs";

const expectedName = "BANK_FEED_WRAPPING_KEY_V2";

async function exercise(inventory) {
  let lists = 0;
  let puts = 0;
  const names = [...inventory];
  let error = null;
  try {
    await ensureBankFeedWrappingKey({
      enabled: true,
      listSecretNames: async () => {
        lists += 1;
        return names;
      },
      putSecret: async (name) => {
        puts += 1;
        names.push(name);
      },
      generateWrappingKey: () => "v2.fixture-review-value-not-real",
    });
  } catch (caught) {
    error = caught;
  }
  return { error, lists, puts };
}

test("exact inventory entry is the positive no-write control", async () => {
  const result = await exercise([expectedName]);
  assert.equal(result.error, null);
  assert.equal(result.lists, 1, "the inventory decision point was reached");
  assert.equal(result.puts, 0);
});

for (const [label, name] of [
  ["case variant", expectedName.toLowerCase()],
  ["outer whitespace", ` ${expectedName} `],
]) {
  test(`${label} refuses a duplicate write`, async () => {
    const result = await exercise([name]);
    assert.ok(result.lists >= 1, "the inventory decision point was reached");
    assert.ok(result.error, "the ambiguous inventory must be refused");
    assert.equal(result.puts, 0, "an ambiguous existing name must not trigger a put");
  });
}

test("an ambiguous put result reports uncertainty and retry does not replace the landed key", async () => {
  const names = [];
  let puts = 0;
  let message = "";
  try {
    await ensureBankFeedWrappingKey({
      enabled: true,
      listSecretNames: async () => [...names],
      putSecret: async (name) => {
        puts += 1;
        names.push(name);
        throw new Error("fixture response was lost after apply");
      },
      generateWrappingKey: () => "v2.fixture-review-value-not-real",
    });
  } catch (error) {
    message = String(error?.message || error);
  }
  assert.equal(puts, 1, "the first put decision point was reached and landed once");
  assert.match(message, /result is unknown|result could not be confirmed/i);
  assert.doesNotMatch(message, /nothing was half-written/i,
    "the owner message must not claim the remote write did not land");

  await ensureBankFeedWrappingKey({
    enabled: true,
    listSecretNames: async () => [...names],
    putSecret: async () => { puts += 1; },
  });
  assert.equal(puts, 1, "green control: retry observed the landed name and made no second put");
});
