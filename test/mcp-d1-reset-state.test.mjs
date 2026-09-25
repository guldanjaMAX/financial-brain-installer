/**
 * Zero-network MCP proof for the production D1 CPU reset response. This file
 * is also its own --import fixture so the child receives a deterministic fetch
 * without opening a loopback port, which restricted test hosts can forbid.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const FIXTURE = String(process.env.BRAIN_MCP_D1_RESET_FIXTURE || "");
const THIS_FILE = fileURLToPath(import.meta.url);
const MCP = fileURLToPath(new URL("../components/brain-mcp.mjs", import.meta.url));
const PRIVATE_CANARY = "private-looking-reset-canary-value";

if (FIXTURE) {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    assert.equal(requests, 1, "each mutation decision must make exactly one request");
    return new Response(JSON.stringify({
      error: `D1_ERROR: D1 DB exceeded its CPU time limit and was reset. ${PRIVATE_CANARY}`,
    }), { status: 500, headers: { "content-type": "application/json" } });
  };
} else {
  const runTool = (tool, args) => spawnSync(process.execPath, ["--import", THIS_FILE, MCP], {
    encoding: "utf8",
    input: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }) + "\n",
    env: {
      ...process.env,
      BRAIN_MCP_D1_RESET_FIXTURE: "1",
      BRAIN_URL: "https://fixture.invalid",
      BRAIN_NAME: "fixture-brain",
      BRAIN_KEY: `fixture-${"k".repeat(40)}`,
      BRAIN_CONFIG: "",
      BRAIN_MANIFEST: "",
      BRAIN_AGENT_PROFILE: "owner-assistant",
    },
    timeout: 10_000,
  });
  const replyFrom = (child, tool) => {
    assert.equal(child.status, 0, `${tool} MCP child failed: ${child.stderr}`);
    const reply = child.stdout.split("\n").filter(Boolean).map(JSON.parse)
      .find((message) => message.id === 1);
    assert.ok(reply, `${tool} returned no MCP response: ${child.stdout}`);
    return reply;
  };

  for (const tool of ["brain_think", "brain_search", "brain_health"]) {
    const reply = replyFrom(runTool(tool, { q: "fixture question" }), tool);
    assert.equal(reply.result?.isError, undefined, `${tool} collapsed the reset into a tool error`);
    const out = JSON.parse(reply.result.content[0].text);
    assert.deepEqual(out, {
      status: "temporarily_unavailable",
      code: "d1_cpu_reset",
      retryable: true,
      retry_after_seconds: 10,
      guidance: renderCliCommands(
        "The Brain database reached its temporary D1 CPU limit and reset. " +
        "Wait at least 10 seconds, then retry this read once. If it repeats, stop polling and run `brain support --preview`.",
      ),
    });
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(PRIVATE_CANARY),
      `${tool} must not expose response text after the reset marker`);
    console.log(`PASS ${tool} returns the named retryable D1 CPU reset state`);
  }

  const rememberReply = replyFrom(runTool("brain_remember", {
    title: "Synthetic offline record",
    body: "This synthetic offline record is long enough to reach the durable write call safely.",
    confidence: "unverified",
  }), "brain_remember");
  assert.equal(rememberReply.result?.isError, undefined,
    "durable-record write returns its existing ambiguous receipt instead of a generic tool error");
  const rememberOut = JSON.parse(rememberReply.result.content[0].text);
  assert.deepEqual(rememberOut, {
    status: "ambiguous",
    code: "d1_cpu_reset_ambiguous",
    ambiguous: true,
    note:
      "The Brain database reset before the mutation receipt was returned. " +
      "The change may or may not have committed. Stop and inspect current state before deciding what to do next.",
  }, "durable-record write returns the fixed ambiguous mutation state");
  assert.equal(rememberOut.retryable, undefined,
    "an ambiguous durable write must not receive the read-only retry shape");
  assert.doesNotMatch(JSON.stringify(rememberReply), new RegExp(PRIVATE_CANARY),
    "durable-record ambiguity must not expose response text");

  const previewReply = replyFrom(runTool("brain_financial_map", {
    mode: "preview",
    snapshot: { version: 1 },
  }), "brain_financial_map preview");
  assert.equal(previewReply.result?.isError, undefined,
    "financial-map preview returns a typed ambiguous result instead of a tool error");
  const previewOut = JSON.parse(previewReply.result.content[0].text);
  assert.deepEqual(previewOut, rememberOut,
    "both mutation tools use the same fixed content-free ambiguous state");
  assert.doesNotMatch(previewReply.result.content[0].text, /retryable/i,
    "an ambiguous financial-map preview must not invite a retry");
  assert.doesNotMatch(JSON.stringify(previewReply), new RegExp(PRIVATE_CANARY),
    "financial-map ambiguity must not expose response text");
  console.log("mcp-d1-reset-state: all focused tests passed");
}
