/**
 * Pure plan contract for the small, local handoff repair Optimize may offer
 * after its read-only report. This module names no broad setup action: the
 * running CLI, Brain corpus, Cloudflare resources, passkeys, access, zones,
 * and provider connections are permanently outside these three scopes.
 */

import { createHash } from "node:crypto";

export const LOCAL_ASSISTANT_REPAIR_SCOPES = Object.freeze([
  "technician-skill",
  "claude-code-mcp",
  "codex-mcp",
]);

const LABELS = Object.freeze({
  "technician-skill": "Financial Brain technician skill",
  "claude-code-mcp": "Claude Code owner connection",
  "codex-mcp": "Codex owner connection",
});

export function parseLocalAssistantRepairScopes(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      `--only must name one or more of: ${LOCAL_ASSISTANT_REPAIR_SCOPES.join(", ")}`,
    );
  }
  const scopes = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = scopes.filter((scope) => !LOCAL_ASSISTANT_REPAIR_SCOPES.includes(scope));
  if (unknown.length) {
    throw new TypeError(
      `unsupported local repair scope ${unknown.join(", ")}. Choose only: ${LOCAL_ASSISTANT_REPAIR_SCOPES.join(", ")}`,
    );
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new TypeError("--only contains the same local repair scope more than once");
  }
  return Object.freeze(LOCAL_ASSISTANT_REPAIR_SCOPES.filter((scope) => scopes.includes(scope)));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function localAssistantRepairPlan({
  productVersion,
  manifestFingerprint,
  selectedScopes,
  items,
  desiredDescriptor = null,
}) {
  if (!Array.isArray(selectedScopes) || !selectedScopes.length) {
    throw new TypeError("a local repair preview needs at least one selected scope");
  }
  if (!Array.isArray(items) || items.length !== selectedScopes.length) {
    throw new TypeError("each selected local repair scope needs one inspected item");
  }
  const selectedMcp = selectedScopes.some((scope) => scope.endsWith("-mcp"));
  let approvalDescriptor = null;
  if (selectedMcp && desiredDescriptor) {
    const allowedEnv = ["BRAIN_AGENT_PROFILE", "BRAIN_MANIFEST", "BRAIN_NAME", "BRAIN_URL"];
    const env = desiredDescriptor.env;
    if (desiredDescriptor.type !== "stdio" || typeof desiredDescriptor.name !== "string" ||
        typeof desiredDescriptor.command !== "string" || !Array.isArray(desiredDescriptor.args) ||
        !env || typeof env !== "object" || Array.isArray(env) ||
        Object.keys(env).sort().join("\0") !== [...allowedEnv].sort().join("\0") ||
        [...desiredDescriptor.args, ...Object.values(env)].some((value) => typeof value !== "string")) {
      throw new TypeError("the local MCP repair needs one exact secret-free descriptor");
    }
    approvalDescriptor = {
      name: desiredDescriptor.name,
      type: desiredDescriptor.type,
      command: desiredDescriptor.command,
      args: [...desiredDescriptor.args],
      env: Object.fromEntries(allowedEnv.map((name) => [name, env[name]])),
    };
  } else if (selectedMcp) {
    // A blocked missing-domain preview has no descriptor and cannot be applied.
    if (items.some((item) => item.scope.endsWith("-mcp") && item.status !== "blocked")) {
      throw new TypeError("a repairable local MCP plan cannot omit its desired descriptor");
    }
  }
  const internal = {
    schema_version: 2,
    product_version: String(productVersion || ""),
    manifest_fingerprint: String(manifestFingerprint || ""),
    selected_scopes: [...selectedScopes],
    desired_descriptor: approvalDescriptor,
    items: items.map((item) => ({
      scope: item.scope,
      state_fingerprint: item.state_fingerprint,
      status: item.status,
      protocol_discovery_verified: item.scope.endsWith("-mcp")
        ? item.protocol_discovery_verified === true
        : null,
      destinations: item.destinations,
      write_set: item.write_set,
    })),
  };
  const planId = createHash("sha256")
    .update(JSON.stringify(canonical(internal)))
    .digest("hex");
  const blocked = items.filter((item) => item.status === "blocked");
  const writes = items.flatMap((item) => item.write_set || []);
  return Object.freeze({
    schema_version: 2,
    operation: "local-assistant-repair",
    mode: "preview",
    read_only: true,
    product_version: String(productVersion || ""),
    selected_scopes: Object.freeze([...selectedScopes]),
    excluded_scopes: Object.freeze([
      "cli",
      ...LOCAL_ASSISTANT_REPAIR_SCOPES.filter((scope) => !selectedScopes.includes(scope)),
    ]),
    items: Object.freeze(items.map((item) => Object.freeze({
      scope: item.scope,
      label: LABELS[item.scope],
      status: item.status,
      ...(item.scope.endsWith("-mcp")
        ? { protocol_discovery_verified: item.protocol_discovery_verified === true }
        : {}),
      detail: item.detail,
      destinations: Object.freeze((item.destinations || []).map((entry) => Object.freeze({ ...entry }))),
      write_set: Object.freeze((item.write_set || []).map((entry) => Object.freeze({ ...entry }))),
      rollback: item.rollback,
      verification: item.verification,
    }))),
    write_set: Object.freeze(writes.map((entry) => Object.freeze({ ...entry }))),
    plan_id: planId,
    can_apply: blocked.length === 0,
    blocked_scopes: Object.freeze(blocked.map((item) => item.scope)),
    transaction: Object.freeze({
      scope: "complete-selected-write-set",
      behavior: "snapshot-before-first-write; exact-readback; reverse-order-rollback-on-any-failure",
    }),
    boundaries: Object.freeze({
      changes_brain_records: false,
      changes_sources_or_providers: false,
      changes_access_or_zones: false,
      changes_passkeys_or_devices: false,
      changes_cloud_resources: false,
      replaces_cli: false,
    }),
  });
}

export function renderLocalAssistantRepairPlan(plan) {
  const lines = [
    "",
    "  Local assistant repair preview",
    "",
    "  This preview is read-only. Nothing has changed.",
  ];
  for (const item of plan.items) {
    lines.push("", `  ${item.label}: ${item.status}`, `    ${item.detail}`);
    for (const destination of item.destinations) {
      lines.push(`    ${destination.action}: ${destination.path}${destination.setting ? ` (${destination.setting})` : ""}`);
    }
    lines.push(`    Rollback: ${item.rollback}`, `    Verify: ${item.verification}`);
  }
  lines.push(
    "",
    `  Exact write set: ${plan.write_set.length ? "" : "none"}`,
  );
  for (const change of plan.write_set) {
    lines.push(`    ${change.action}: ${change.path}${change.setting ? ` (${change.setting})` : ""}`);
  }
  lines.push(
    "",
    "  Bundle transaction: every write destination is snapshotted before the first write. If any selected item fails, the complete write set is restored in reverse order before this command returns.",
    "",
    "  Outside this approval: the CLI, Brain records, sources, providers, access, zones, passkeys, devices, and cloud resources.",
  );
  if (plan.can_apply && plan.write_set.length) {
    lines.push(
      "  If the owner approves this complete write set, apply this same state-bound plan once:",
      `    brain assistant-repair <manifest> --only ${plan.selected_scopes.join(",")} --apply --approve ${plan.plan_id}`,
    );
  } else if (!plan.can_apply) {
    lines.push("  This bundle cannot be applied while a selected destination is blocked.");
  } else {
    lines.push("  Every selected item is already ready or intentionally preserved. No repair is needed.");
  }
  return lines.join("\n") + "\n";
}
