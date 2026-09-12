// A brain that found the right documents and failed to write an answer must
// never report itself as a brain with nothing on file. Those two outcomes are
// indistinguishable to the consuming model, and only one of them is honest.
//
// Field case, 2026-08-31: `/api/rag/think` was asked a question carrying four
// clauses. Two of them ("pause", "status") had no answer in the corpus, so the
// synthesis model refused the whole question and cited nothing, while its own
// results array held the owner's signed coaching agreement at ranks 2, 3 and 4.
// The MCP layer then attached "The brain has nothing on this", because the
// refusal string is truthy and so the raw rows were never carried out. The
// consumer relayed absence to the owner about a contract sitting in the payload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const MCP = fileURLToPath(new URL("../components/brain-mcp.mjs", import.meta.url));

/** Serve one canned /api/rag/think body, then report what the MCP made of it. */
async function thinkReturns(body, tool = "brain_think") {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  try {
    const child = spawn(process.execPath, [MCP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRAIN_URL: `http://127.0.0.1:${port}`,
        BRAIN_NAME: "fixture-brain",
        BRAIN_KEY: `fixture-${"k".repeat(40)}`,
        BRAIN_CONFIG: "",
        BRAIN_MANIFEST: "",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: { q: "anything" } },
      }) + "\n",
    );
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, "mcp exited non-zero");

    const line = stdout.split("\n").filter(Boolean).map(JSON.parse).find((m) => m.id === 1);
    assert.ok(line, `no reply on stdout: ${stdout}`);
    assert.ok(!line.result?.isError, `mcp errored: ${line.result?.content?.[0]?.text}`);
    return JSON.parse(line.result.content[0].text);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ABSENCE =
  "The brain has nothing on this. Report that as the finding, in those terms. Do not substitute inference.";

async function initializeInstructions(profile) {
  const child = spawn(process.execPath, [MCP], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BRAIN_URL: "https://brain.fixture.test",
      BRAIN_NAME: "fixture-brain",
      BRAIN_KEY: `fixture-${"k".repeat(40)}`,
      BRAIN_CONFIG: "",
      BRAIN_MANIFEST: "",
      BRAIN_AGENT_PROFILE: profile,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
    }) + "\n",
  );
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, `MCP initialize exited non-zero: ${stderr}`);
  const reply = stdout.split("\n").filter(Boolean).map(JSON.parse).find((message) => message.id === 1);
  assert.ok(reply?.result?.instructions, `MCP initialize returned no instructions: ${stdout}`);
  return reply.result.instructions;
}

function orderedIndex(text, expression, after, label) {
  const offset = Math.max(0, after + 1);
  const relative = text.slice(offset).search(expression);
  assert.ok(relative >= 0, `${label} is missing or out of order: ${expression}`);
  return offset + relative;
}

function assertMapOpeningSequence(text, label) {
  let cursor = -1;
  cursor = orderedIndex(text,
    /What would you\s+most\s+like\s+your\s+Financial Brain to help you understand or keep current\?/i,
    cursor, label);
  cursor = orderedIndex(text, /This sends no Financial Map\s+snapshot and changes nothing\./i, cursor, label);
  cursor = orderedIndex(text,
    /(?:report (?:its )?current, stale, or not-established map state|whether the active map is current, stale, or not established)/i,
    cursor, label);
  cursor = orderedIndex(text,
    /Before (?:making )?any financial\s+completeness conclusion, offer the (?:optional )?guided/i,
    cursor, label);
  cursor = orderedIndex(text,
    /(?:end\s+Optimize without submitting the working draft|End Optimize before previewing)/i,
    cursor, label);
  cursor = orderedIndex(text,
    /separate explicit owner\s+approval(?: outside Optimize)? before (?:calling|preview mode)/i,
    cursor, label);
  orderedIndex(text,
    /Activation requires another separate owner decision[\s\S]{0,260}?fresh passkey/i,
    cursor, label);
}

// Optimize ordering must live in the MCP initialize response, because that is
// what the owner-facing assistant actually reads. Keep its anchors aligned
// with both packaged contracts so one copy cannot silently fall back to an
// after-the-report interview.
{
  const instructions = await initializeInstructions("owner-assistant");
  const skill = readFileSync(new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../operations/claude-workspace.mjs", import.meta.url), "utf8");

  assertMapOpeningSequence(instructions, "MCP runtime guidance");
  assertMapOpeningSequence(skill, "technician skill");
  assertMapOpeningSequence(workspace, "Claude workspace contract");
  for (const [label, text] of [
    ["MCP runtime guidance", instructions],
    ["technician skill", skill],
    ["Claude workspace contract", workspace],
  ]) {
    assert.match(text,
      /one total owner-question budget per (?:owner-facing Optimize )?response across\s+the optional goal, evidence clarification, and zoning/i,
      label);
    assert.match(text,
      /material evidence conflict,\s+(?:then )?a\s+whole-source zoning decision, then\s+the\s+optional goal/i,
      label);
    assert.match(text,
      /Skip\s+the goal whenever a material evidence conflict or any\s+zoning decision is\s+(?:already )?pending/i,
      label);
    assert.match(text, /records do not determine\s+the choice/i, label);
    assert.match(text,
      /source label, connector kind, document count, or plausible\s+guess is\s+not enough/i,
      label);
    assert.match(text,
      /Without (?:that|supporting) evidence, (?:do not|never) propose or recommend a\s+zone/i,
      label);
    assert.match(text,
      /material evidence conflict has higher priority,\s+(?:ask only that evidence question and\s+)?defer\s+(?:the\s+)?zoning(?:\s+choice)?\s+to\s+the\s+next response/i,
      label);
    assert.match(text,
      /Do not run Golden Questions, a Golden evaluation, a canned refusal exercise, a\s+known-answer control question/i,
      label);
    assert.match(text,
      /Never claim an MCP or other Optimize check ran without its actual receipt[\s\S]{0,180}?never call Optimize complete while any planned check is not run/i,
      label);
    assert.match(text,
      /gpt-5\.6-luna.*medium reasoning[\s\S]{0,180}?gpt-5\.6-terra.*low reasoning/i,
      label);
    assert.match(text, /synthetic behavioral\s+evidence only, not live Brain proof/i, label);
    assert.match(text,
      /Do not pin [`]?gpt-5\.6-sol[`]? or infer Optimize\s+completeness from model choice/i,
      label);
    assert.match(text,
      /Each interview response asks only (?:that|its) one adaptive map question and combines it\s+with no goal, evidence-clarification, or zoning question/i,
      label);
    assert.doesNotMatch(text,
      /one total owner-question budget for the complete Optimize run/i,
      label);
  }
  assert.match(instructions, /keep the audit read-only/i);
  assert.match(instructions, /first audit evidence after that opening decision, whether the goal was asked or skipped/i);
  assert.match(instructions, /Immediately before calling brain_financial_map with mode=read/i);
  assert.match(instructions, /optional guided, session-only Owner Financial Map interview/i);
  assert.match(instructions, /Do not start the interview automatically/i);
  assert.match(instructions, /The interview submits nothing and changes nothing/i);
  assert.match(instructions,
    /preview is a separate data-changing step outside Optimize.*separate explicit owner approval/is);
  assert.match(instructions, /Activation is never an Optimize or MCP step/i);
  assert.doesNotMatch(instructions, /After the read-only Optimize report, offer a guided financial map interview/i);
  console.log("PASS MCP Optimize guidance is map-first and keeps preview and activation separate");
}

// 1. Retrieval matched nothing. This is the product working, it is the hard
//    part, and it is pinned byte for byte so no later fix softens it.
{
  const out = await thinkReturns({
    answer: "The documents do not answer the question.",
    citations: [],
    results: [],
    gaps: [],
  });
  assert.equal(out.note, ABSENCE, "a genuinely empty search must still say so plainly");
  console.log("PASS empty retrieval still reports absence, unchanged");
}

// 2. The defect. Retrieval returned documents, the answer layer cited none.
{
  const rows = [
    { source: "upload", source_id: "signed-agreement", ref_key: "signed-agreement", uri: "https://files.example/signed-agreement", chunk_uid: "upload:signed-agreement#2", title: "Signed coaching agreement.md", ts: "2026-04-11T00:00:00.000Z", date_source: "filename", date_reliable: false, text_source: "ocr_partial", text_reliable: false, snippet: "Monthly fee: $5,000" },
    { title: "Covenant for the Work Ahead.docx", ts: "2026-04-11T00:00:00.000Z", snippet: "30 days written notice" },
    { title: "Intro email.md", ts: "2026-04-11T00:00:00.000Z", snippet: "First Stripe payment" },
  ];
  const out = await thinkReturns({
    answer: "The documents do not answer the question.",
    citations: [],
    results: rows,
    gaps: [],
  });

  assert.notEqual(out.note, ABSENCE, "a synthesis failure must not be reported as absence");
  assert.ok(!/nothing on this/i.test(out.note ?? ""), `note still reads as absence: ${out.note}`);
  assert.match(out.note ?? "", /NOT "nothing recorded"/, "the note must say plainly what this is not");
  assert.match(out.note ?? "", /3 document/, "the note must state how many documents were held back");
  // The rows themselves have to travel, or the consumer has nothing to recover
  // from and no way to check the claim.
  assert.equal(out.results?.length, 3, "raw rows must be attached when nothing was cited");
  assert.equal(out.results[0].title, "Signed coaching agreement.md");
  assert.equal(out.results[0].ref, "signed-agreement", "stable document identity must survive the refusal path");
  assert.equal(out.results[0].source_id, "signed-agreement");
  assert.equal(out.results[0].uri, "https://files.example/signed-agreement");
  assert.equal("chunk_uid" in out.results[0], false, "unstable chunk identity must stay internal");
  assert.equal(out.results[0].date_reliable, false, "date trust must survive the MCP boundary");
  assert.equal(out.results[0].text_source, "ocr_partial", "extraction provenance must survive the MCP boundary");
  assert.equal(out.results[0].text_reliable, false, "extraction trust must survive the MCP boundary");
  console.log("PASS documents found but none cited is not reported as absence");
}

// 3. A cited answer stays clean: no scolding note bolted onto a good result.
{
  const out = await thinkReturns({
    answer: "The monthly fee is $5,000 [1].",
    citations: [{ n: 1, title: "Signed coaching agreement.md" }],
    results: [{ title: "Signed coaching agreement.md", ts: null, snippet: "Monthly fee: $5,000" }],
    gaps: [],
  });
  assert.equal(out.note, undefined, "a cited answer must carry no note");
  assert.equal(out.results, undefined, "a cited answer must not duplicate the corpus back");
  console.log("PASS a cited answer is returned clean");
}

// 4. Raw search keeps the same provenance fields as the cited answer path.
{
  const out = await thinkReturns({
    results: [{
      source: "upload", ref: "statement-public-ref", source_id: "statement-source-id",
      uri: "https://files.example/statement", chunk_uid: "upload:statement-source-id#4",
      title: "Scanned statement", category: "upload",
      ts: "2026-01-02T00:00:00.000Z", date_source: "filename", date_reliable: false,
      text_source: "ocr_partial", text_reliable: false,
      lineage: {
        kind: "unclassified", status: "unknown", derived: false,
        reason: "derivation family was not recorded",
      },
      snippet: "Balance shown on scan",
    }],
  }, "brain_search");
  assert.equal(out.results[0].id, "upload:statement-source-id",
    "raw search must expose the exact id the remember contract accepts");
  assert.equal(out.results[0].ref, "statement-public-ref");
  assert.equal(out.results[0].source_id, "statement-source-id");
  assert.equal(out.results[0].uri, "https://files.example/statement");
  assert.equal("chunk_uid" in out.results[0], false, "raw search must expose document identity only");
  assert.equal(out.results[0].date_source, "filename");
  assert.equal(out.results[0].date_reliable, false);
  assert.equal(out.results[0].text_source, "ocr_partial");
  assert.equal(out.results[0].text_reliable, false);
  assert.equal(out.results[0].lineage.status, "unknown");
  console.log("PASS raw search keeps date and extraction provenance");
}

console.log("mcp-absence-honesty: all assertions passed");
