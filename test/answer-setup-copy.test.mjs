import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CONTRACT_SECTION,
  CHECK_PROBLEM,
  GAP_DETAIL,
  HALF_RUN,
  MONEY_RULES_LINE,
  SKILL_CONSOLE_PARAGRAPH,
  SKILL_CREDENTIAL_LINE,
  SKILL_DECISION_STEP,
  SKILL_DECISION_TEXT,
  SKILL_ON_REQUEST,
  SKILL_WINDOWS_LINE,
  KEY_SHAPE,
  MODEL_NOT_REVIEWED,
  ROLLBACK_INCOMPLETE,
} from "../operations/answer-setup-copy.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { GAP_DETAIL as WORKER_GAP_DETAIL } from "../worker/src/lib/answer-render.js";

const text = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("reviewed answer-setup copy stays byte-identical across its packaged consumers", () => {
  const skill = text("skills/financial-brain-technician/SKILL.md");
  for (const reviewed of [
    SKILL_CONSOLE_PARAGRAPH,
    SKILL_WINDOWS_LINE,
    SKILL_DECISION_STEP,
    SKILL_CREDENTIAL_LINE,
    SKILL_ON_REQUEST,
  ]) assert.ok(skill.includes(reviewed));

  assert.ok(text("templates/owner-contract/answer-contract-v1.md").includes(CONTRACT_SECTION));
  for (const name of ["money-rules-v3.md", "money-rules-v3-windows.md"]) {
    assert.ok(text(`templates/owner-contract/${name}`).includes(MONEY_RULES_LINE));
  }
  assert.equal(WORKER_GAP_DETAIL, GAP_DETAIL);
});

test("the technician skill quotes the approved answer decision byte for byte", () => {
  const skill = text("skills/financial-brain-technician/SKILL.md");
  const quoted = SKILL_DECISION_TEXT
    .split("\n")
    .map((line) => line ? `> ${line}` : ">")
    .join("\n");
  assert.ok(skill.includes(`${SKILL_DECISION_STEP}\n\n${quoted}\n`));
});

test("the approved answer decision keeps the confirmed cap and measured unit cost", () => {
  assert.match(SKILL_DECISION_TEXT, /\$5\b/);
  assert.match(SKILL_DECISION_TEXT, /5\.5 cents/);
  assert.doesNotMatch(SKILL_DECISION_TEXT, /\$16\b|\$66\b/);
});

test("answer setup remedies name executable commands and honest check failures", () => {
  assert.match(KEY_SHAPE, /--key-set-in-dashboard/);
  const remedy = MODEL_NOT_REVIEWED({
    field: "answer_model", id: "fixture-unreviewed", manifest: "/fixture/brain.manifest.json",
  });
  assert.match(remedy, /brain disconnect anthropic \/fixture\/brain\.manifest\.json/);
  assert.ok(remedy.indexOf("brain disconnect anthropic") < remedy.indexOf("brain connect anthropic"),
    "the executable cleanup step comes before the command that needs reviewed state");
  assert.match(CHECK_PROBLEM, /check.*could not be read/i);
  assert.doesNotMatch(CHECK_PROBLEM, /key|evidence did not support|refused the test message/i);
});

test("interrupted answer copy never recommends removing a stored key", () => {
  const rows = [
    { name: "pre-existing half-run", render: HALF_RUN },
    { name: "rollback could not finish", render: ROLLBACK_INCOMPLETE },
  ];

  for (const row of rows) {
    const held = row.render("<manifest>", true);
    assert.match(held, /Claude setup was interrupted part way/i, row.name);
    assert.match(held, /do not remove the Claude connection.*removes your stored key/i, row.name);
    assert.match(held, /ask the person who set up your Brain for help/i, row.name);
    assert.doesNotMatch(held, /disconnect/i, `${row.name}: no unsafe action name is shown`);
    assert.doesNotMatch(held, /\bbrain\s+(?:connect|disconnect)\b/u,
      `${row.name}: no CLI command is shown`);
    assert.doesNotMatch(held, /<manifest>/u, `${row.name}: the unused command locator is not shown`);

    const noStoredKey = renderCliCommands(row.render("<manifest>", false));
    assert.ok(noStoredKey.includes(renderCliCommands("brain disconnect anthropic <manifest>")),
      `${row.name}: no-stored-key control retains the prior recovery command`);
  }
});
