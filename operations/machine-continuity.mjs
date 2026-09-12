/**
 * Read-only continuity audit for moving an installed Brain to another computer.
 *
 * This report is intentionally less detailed than the structures it inspects.
 * Local paths, manifest/resource identifiers, source names, cursor values,
 * provider identities and credential-store errors never cross its JSON
 * boundary. An operator can use the existing focused commands to repair one
 * named gap after reviewing it; this module never performs that repair.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCOPES,
  loadTokens,
  tokenStorageStatus,
  verifyTokenStorageReadable,
} from "../connectors/google-auth.mjs";
import {
  loadProviderCredentials,
  loadProviderSyncState,
  providerCredentialStatus,
} from "../connectors/provider-oauth.mjs";
import { readInstalledManifest } from "./installed-manifest.mjs";
import { statusDriveScheduler } from "./drive-scheduler.mjs";
import { statusFolderScheduler } from "./folder-scheduler.mjs";
import { statusProviderScheduler } from "./provider-scheduler.mjs";
import { statusImessageScheduler } from "./imessage-scheduler.mjs";
import { statusWhatsappDrainScheduler } from "./whatsapp-drain-scheduler.mjs";
import { statusWhatsappDaemon } from "./whatsapp-daemon.mjs";

export const MACHINE_CONTINUITY_STATUSES = Object.freeze([
  "ready",
  "missing",
  "unproven",
  "inapplicable",
]);

const STATUS = new Set(MACHINE_CONTINUITY_STATUSES);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_LOCAL_ROOTS = 32;
const MAX_CONFIGURED_SOURCES = 48;
const PROVIDERS = Object.freeze([
  "quickbooks",
  "slack",
  "notion",
  "microsoft",
  "dropbox",
  "hubspot",
]);
const SAFE_SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SAFE_WORKER = /^[a-z0-9][a-z0-9-]{1,60}$/;
const PLACEHOLDER = /(?:required|replace|filled[_ -]?in|placeholder|your[_ -]?(?:account|database|index))/i;
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED_CLI = resolve(HERE, "..", "brain.mjs");

const NEXT = Object.freeze({
  none: "none",
  preserve_manifest: "Preserve this exact manifest and use it for every continuity check.",
  recover_manifest: "Recover the existing Brain manifest before installing, syncing, or scheduling anything.",
  remember_manifest: "After reviewing the path, run `brain update <manifest>` once to remember this exact manifest on this computer.",
  restore_owner_credential: "Run `brain setup <manifest>` with the owner to restore this computer's saved owner credential, then rerun the audit.",
  verify_binding: "Keep the old computer available until an authenticated receipt can prove the deployed Brain binding.",
  install_cli: "Resolve the public release target independently, verify its artifact receipt, install that exact CLI, then rerun the audit.",
  repair_skill: "Preview only the technician skill with `brain assistant-repair <manifest> --only technician-skill`.",
  repair_claude: "Preview only Claude Code with `brain assistant-repair <manifest> --only claude-code-mcp`.",
  repair_codex: "Preview only Codex with `brain assistant-repair <manifest> --only codex-mcp`.",
  review_custom_assistant: "Review the preserved local assistant configuration with its owner before changing it.",
  review_source_configuration: "Review the manifest's enabled source names and local-root count, then rerun this audit before syncing.",
  connect_google: "Reconnect the configured Google scopes on this computer, then rerun the audit.",
  connect_imap: "Reconnect the configured mailbox on this computer, then rerun the audit.",
  connect_provider: "Reconnect this provider on this computer, then rerun the audit.",
  verify_hosted_credential: "Verify the hosted connector through its separate owner-approved setup path; this local audit does not inspect Worker secrets.",
  restore_root: "Reconnect or restore this local source folder before running ingest.",
  review_scheduler: "Review and reinstall this one scheduler from the same manifest before leaving it unattended.",
  preserve_checkpoint: "Keep the old computer or a reviewed backup until this source's exact resume state is transferred and verified.",
  reconcile_source_history: "Review the manifest and read-only source inventory together; do not sync until every registered source has an explicit continuity decision.",
  rerun_remote: "Restore ordinary access to the saved Brain and rerun this audit; no Cloudflare sign-in is required.",
});

function freeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
  }
  return Object.freeze(value);
}

function summaryStatus(items) {
  const statuses = items.map((item) => item?.status).filter((value) => STATUS.has(value));
  if (statuses.includes("missing")) return "missing";
  if (statuses.includes("unproven")) return "unproven";
  if (statuses.includes("ready")) return "ready";
  return "inapplicable";
}

function safeHttpsDomain(value) {
  try {
    const raw = String(value || "").trim();
    if (!raw) return false;
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.pathname === "/" && !url.search && !url.hash &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function usableBindingValue(value) {
  const text = String(value || "").trim();
  return Boolean(text) && text.length <= 128 && !PLACEHOLDER.test(text);
}

/**
 * True only after the standard Cloudflare resource identities have been
 * written back to the manifest. A parseable template is not an installed
 * Brain: its placeholder bindings must keep fresh-install prerequisites strict.
 */
export function manifestHasProvisionedResourceBindings(manifest) {
  const cloudflare = manifest?.infrastructure?.cloudflare;
  const d1Id = String(cloudflare?.d1_database_id || "");
  return (cloudflare?.storage ?? "d1") === "d1" &&
    /^[a-f0-9]{32}$/i.test(String(cloudflare?.account_id || "")) &&
    (/^[a-f0-9]{32}$/i.test(d1Id) || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d1Id)) &&
    SAFE_WORKER.test(String(manifest?.brain?.worker_name || "")) &&
    SAFE_WORKER.test(String(cloudflare?.vectorize_index || "")) &&
    usableBindingValue(cloudflare?.d1_database_id) &&
    usableBindingValue(cloudflare?.vectorize_index);
}

function sameFile(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function defaultReadSafeFile(path, maximumBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 2 || before.size > maximumBytes ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    throw new Error("unsafe local file");
  }
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) throw new Error("local file changed while opening");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const final = lstatSync(path);
    if (!sameFile(opened, after) || !sameFile(opened, final)) {
      throw new Error("local file changed while reading");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readSafeJson(path, maximumBytes, options) {
  const readSafeFile = options.readSafeFile ?? defaultReadSafeFile;
  const bytes = readSafeFile(path, maximumBytes);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return { value, bytes };
  } catch {
    throw new Error("invalid local JSON");
  }
}

function inspectManifest(manifest, manifestPath, productVersion, options) {
  let parsed = null;
  let fingerprint = null;
  let safeFile = false;
  try {
    const loaded = readSafeJson(resolve(manifestPath), MAX_MANIFEST_BYTES, options);
    parsed = loaded.value;
    fingerprint = createHash("sha256").update(loaded.bytes).digest("hex");
    safeFile = JSON.stringify(parsed) === JSON.stringify(manifest);
  } catch { /* represented by closed evidence below */ }

  const manifestVersionValid = parsed?.manifest_version === 1;
  const clientIdentityValid = SAFE_SLUG.test(String(parsed?.client?.slug || "")) &&
    typeof parsed?.client?.display_name === "string" && parsed.client.display_name.trim().length > 0;
  const domainValid = safeHttpsDomain(parsed?.brain?.domain);
  const resourceBindingPresent = manifestHasProvisionedResourceBindings(parsed);
  const versionMatches = parsed?.brain?.version === productVersion;
  const ready = safeFile && manifestVersionValid && clientIdentityValid && domainValid &&
    resourceBindingPresent && versionMatches;
  return {
    parsed,
    fingerprint,
    check: {
      check: "manifest_identity",
      status: ready ? "ready" : "missing",
      evidence: {
        safe_exact_file: safeFile,
        manifest_identity_fields_valid: manifestVersionValid && clientIdentityValid,
        deployed_address_valid: domainValid,
        resource_binding_declared: resourceBindingPresent,
        cli_version_matches_manifest: versionMatches,
      },
      next_step: ready ? NEXT.none : NEXT.recover_manifest,
    },
  };
}

function inspectRememberedManifest(manifestPath, options) {
  const reader = options.readInstalledManifest ?? readInstalledManifest;
  try {
    const remembered = reader(options.installedManifestOptions || {});
    if (!remembered) {
      return {
        check: "remembered_manifest",
        status: "missing",
        evidence: { saved_location_present: false, exact_manifest_selected: false },
        next_step: NEXT.remember_manifest,
      };
    }
    let exact = false;
    try {
      const canonical = options.realpath ?? realpathSync;
      exact = canonical(resolve(remembered)) === canonical(resolve(manifestPath));
    } catch { /* unsafe/unreadable is not exact */ }
    return {
      check: "remembered_manifest",
      status: exact ? "ready" : "unproven",
      evidence: { saved_location_present: true, exact_manifest_selected: exact },
      next_step: exact ? NEXT.none : NEXT.remember_manifest,
    };
  } catch {
    return {
      check: "remembered_manifest",
      status: "unproven",
      evidence: { saved_location_present: true, exact_manifest_selected: false },
      next_step: NEXT.remember_manifest,
    };
  }
}

function inspectOwnerCredential(manifestPath, options) {
  const reader = options.resolveAdminKey;
  if (typeof reader !== "function") {
    return {
      check: "owner_admin_credential",
      status: "unproven",
      evidence: {
        saved_credential_readable: false,
        credential_inspection_completed: false,
        ambient_credential_ignored: true,
      },
      next_step: NEXT.restore_owner_credential,
    };
  }
  let readable = false;
  let inspectionCompleted = true;
  try {
    const value = reader(manifestPath, { ignoreEnvironment: true });
    readable = typeof value === "string" && value.length > 0;
  } catch {
    inspectionCompleted = false;
  }
  const status = !inspectionCompleted ? "unproven" : readable ? "ready" : "missing";
  return {
    check: "owner_admin_credential",
    status,
    evidence: {
      saved_credential_readable: readable,
      credential_inspection_completed: inspectionCompleted,
      ambient_credential_ignored: true,
    },
    next_step: readable ? NEXT.none : NEXT.restore_owner_credential,
  };
}

function inspectCli(manifest, productVersion, options) {
  let packageEntrypointReadable = false;
  let invocationBound = options.runningPackageEntrypointVerified === true;
  try {
    const canonical = options.realpath ?? realpathSync;
    const packaged = canonical(options.packagedCliPath ?? PACKAGED_CLI);
    const info = (options.lstat ?? lstatSync)(packaged);
    packageEntrypointReadable = info.isFile() && !info.isSymbolicLink() &&
      (typeof process.getuid !== "function" || info.uid === process.getuid());
    if (!invocationBound && (options.cliExecutablePath ?? process.argv[1])) {
      invocationBound = canonical(resolve(options.cliExecutablePath ?? process.argv[1])) === packaged;
    }
  } catch { /* represented as missing */ }
  const versionMatches = manifest?.brain?.version === productVersion && /^\d+\.\d+\.\d+$/.test(productVersion);
  const ready = packageEntrypointReadable && invocationBound && versionMatches;
  return {
    installation: {
      check: "installed_cli",
      status: ready ? "ready" : "missing",
      evidence: {
        current_package_entrypoint_readable: packageEntrypointReadable,
        invocation_bound_to_current_package: invocationBound,
        declared_version_matches_manifest: versionMatches,
      },
      next_step: ready ? NEXT.none : NEXT.install_cli,
    },
    releaseIntegrity: {
      check: "cli_release_integrity",
      status: "unproven",
      evidence: {
        independent_public_target_resolved: false,
        artifact_receipt_verified: false,
        release_currency_proven: false,
      },
      next_step: NEXT.install_cli,
    },
  };
}

function assistantCheck(plan, scope) {
  const item = plan?.items?.find((candidate) => candidate?.scope === scope);
  const isCodex = scope === "codex-mcp";
  const check = scope === "technician-skill"
    ? "technician_skill"
    : scope === "claude-code-mcp" ? "claude_code_mcp" : "codex_mcp";
  const next = scope === "technician-skill" ? NEXT.repair_skill
    : scope === "claude-code-mcp" ? NEXT.repair_claude : NEXT.repair_codex;
  const isMcp = scope.endsWith("-mcp");
  // The real assistant plan sets this only after the packaged stdio server has
  // completed initialize plus tools/list without launching Claude or Codex.
  // A caller-supplied plan status alone is not protocol evidence.
  const protocolReady = isMcp && item?.protocol_discovery_verified === true;
  if (!item) {
    return {
      check,
      status: "unproven",
      evidence: isMcp
        ? { installed: false, exact_configuration: false, protocol_discovery_ready: false }
        : { installed: false, exact_configuration: false },
      next_step: next,
    };
  }
  if (item.status === "not_installed") {
    return {
      check,
      status: isCodex ? "inapplicable" : "missing",
      evidence: isMcp
        ? { installed: false, exact_configuration: false, protocol_discovery_ready: false }
        : { installed: false, exact_configuration: false },
      next_step: isCodex ? NEXT.none : next,
    };
  }
  if (item.status === "ready") {
    return {
      check,
      status: isMcp && !protocolReady ? "unproven" : "ready",
      evidence: isMcp
        ? { installed: true, exact_configuration: true, protocol_discovery_ready: protocolReady }
        : { installed: true, exact_configuration: true },
      next_step: isMcp && !protocolReady ? next : NEXT.none,
    };
  }
  if (item.status === "repairable") {
    return {
      check,
      status: "missing",
      evidence: isMcp
        ? { installed: true, exact_configuration: false, protocol_discovery_ready: protocolReady }
        : { installed: true, exact_configuration: false },
      next_step: next,
    };
  }
  return {
    check,
    status: "unproven",
    evidence: isMcp
      ? { installed: true, exact_configuration: false, protocol_discovery_ready: protocolReady }
      : { installed: true, exact_configuration: false },
    next_step: NEXT.review_custom_assistant,
  };
}

function sourceConfiguration(manifest) {
  const corpora = manifest?.corpora || {};
  const sources = [];
  const named = new Map();
  let declarations = 0;
  let sourceNamesValid = true;
  let sourceNamesUnique = true;
  const add = (connector, source, extra = {}, countDeclaration = true) => {
    if (countDeclaration) declarations++;
    const value = String(source || "");
    if (!SAFE_SOURCE.test(value)) {
      sourceNamesValid = false;
      return;
    }
    const priorConnector = named.get(value);
    if (priorConnector) {
      // Several upload roots may intentionally feed the same named source.
      if (!(connector === "upload" && priorConnector === "upload")) sourceNamesUnique = false;
      return;
    }
    named.set(value, connector);
    if (sources.length < MAX_CONFIGURED_SOURCES) sources.push({ connector, source: value, ...extra });
  };
  if (corpora.google_drive?.enabled) add("google_drive", corpora.google_drive.source || "drive", { credential: "google", checkpoint: "file", scheduler: "drive" });
  if (corpora.gmail?.enabled) add("gmail", corpora.gmail.source || "gmail", { credential: "google", checkpoint: "file" });
  if (corpora.calendar?.enabled) add("calendar", corpora.calendar.source || "calendar", { credential: "google", checkpoint: "file" });
  if (corpora.imap?.enabled) add("imap", corpora.imap.source || "imap", { credential: "imap", checkpoint: "file" });
  if (corpora.imessage?.enabled) add("imessage", corpora.imessage.source || "imessage", { checkpoint: "file", scheduler: "imessage" });
  if (corpora.whatsapp?.enabled) add("whatsapp", corpora.whatsapp.source || "whatsapp", { checkpoint: "file", scheduler: "whatsapp" });
  for (const provider of PROVIDERS) {
    if (corpora[provider]?.enabled) add(provider, corpora[provider].source || provider, {
      credential: provider,
      checkpoint: "provider",
      scheduler: "provider",
    });
  }
  if (corpora.local_folder?.enabled) add("local_folder", corpora.local_folder.source || "documents", { checkpoint: "file", scheduler: "folder" });
  if (corpora.upload?.enabled) {
    const declared = corpora.upload.folders ?? corpora.upload.paths ??
      (corpora.upload.path ? [corpora.upload.path] : []);
    if (Array.isArray(declared) && declared.length) {
      declarations += declared.length;
      for (const item of declared.slice(0, MAX_LOCAL_ROOTS + 1)) {
        add(
          "upload",
          typeof item === "object" && item?.source ? item.source : "upload",
          { checkpoint: "file" },
          false,
        );
      }
    } else {
      add("upload", "upload", { checkpoint: "file" });
    }
  }
  if (corpora.zoom?.enabled) add("zoom", corpora.zoom.source || "zoom", { credential: "hosted", checkpoint: "push" });
  if (corpora.bank_feed?.enabled) add("bank_feed", "bank_feed", { credential: "hosted", checkpoint: "hosted" });
  const configuredRoots = configuredLocalRoots(manifest);
  const withinSourceLimit = declarations <= MAX_CONFIGURED_SOURCES;
  const withinRootLimit = configuredRoots.declaredCount <= MAX_LOCAL_ROOTS;
  const valid = withinSourceLimit && withinRootLimit && sourceNamesValid && sourceNamesUnique;
  return {
    sources,
    roots: configuredRoots.roots,
    check: {
      check: "source_configuration_scope",
      status: valid ? "ready" : "missing",
      evidence: {
        configured_source_count: declarations,
        audited_source_count: sources.length,
        within_source_limit: withinSourceLimit,
        configured_local_root_count: configuredRoots.declaredCount,
        audited_local_root_count: configuredRoots.roots.length,
        within_local_root_limit: withinRootLimit,
        all_source_names_audited: withinSourceLimit && withinRootLimit,
        audited_source_names_valid: sourceNamesValid,
        audited_source_names_unambiguous: sourceNamesUnique,
      },
      next_step: valid ? NEXT.none : NEXT.review_source_configuration,
    },
  };
}

function defaultGoogleCredential(manifest, options) {
  const required = ["drive", "gmail", "calendar"].filter((scope) =>
    manifest?.corpora?.[scope === "drive" ? "google_drive" : scope]?.enabled);
  if (!required.length) return null;
  const storage = {
    ...(options.credentialStorage || {}),
    backend: manifest?.operations?.google_token_store || "auto",
    env: {},
    migrateLegacy: false,
    platform: options.platform ?? process.platform,
  };
  let envelope;
  let readable;
  try {
    envelope = tokenStorageStatus(storage);
    readable = verifyTokenStorageReadable(storage);
  } catch {
    return {
      connector: "google",
      status: "unproven",
      evidence: {
        configured: true,
        stored_credential_present: false,
        stored_credential_readable: false,
        credential_record_complete: false,
        configured_scopes_present: false,
        ambient_storage_override_ignored: true,
      },
      next_step: NEXT.connect_google,
    };
  }
  let record = null;
  if (readable.readable) {
    try { record = loadTokens(storage)?.google || null; } catch { /* static result below */ }
  }
  const fieldsComplete = Boolean(record?.client_id && record?.refresh_token);
  const scopes = new Set(Array.isArray(record?.scopes) ? record.scopes : []);
  const scopesComplete = required.every((scope) => scopes.has(scope) || scopes.has(SCOPES[scope]));
  const status = envelope.error || (envelope.exists && !readable.readable)
    ? "unproven"
    : envelope.exists && readable.readable && fieldsComplete && scopesComplete ? "ready" : "missing";
  return {
    connector: "google",
    status,
    evidence: {
      configured: true,
      stored_credential_present: Boolean(envelope.exists),
      stored_credential_readable: Boolean(readable.readable),
      credential_record_complete: fieldsComplete,
      configured_scopes_present: scopesComplete,
      ambient_storage_override_ignored: true,
    },
    next_step: status === "ready" ? NEXT.none : NEXT.connect_google,
  };
}

async function defaultImapCredential(manifest, options) {
  if (!manifest?.corpora?.imap?.enabled) return null;
  const sourceName = manifest.corpora.imap.source || "imap";
  let makeStorage;
  try {
    makeStorage = options.imapStorageOptions ?? (await import("../connectors/imap.mjs")).imapStorageOptions;
  } catch {
    return {
      connector: "imap",
      status: "unproven",
      evidence: {
        configured: true,
        stored_credential_present: false,
        stored_credential_readable: false,
        credential_record_complete: false,
        ambient_storage_override_ignored: true,
      },
      next_step: NEXT.connect_imap,
    };
  }
  const storage = makeStorage({
    ...(options.credentialStorage || {}),
    sourceName,
    backend: "auto",
    env: {},
    migrateLegacy: false,
    platform: options.platform ?? process.platform,
  });
  let envelope;
  let readable;
  try {
    envelope = tokenStorageStatus(storage);
    readable = verifyTokenStorageReadable(storage);
  } catch {
    return {
      connector: "imap",
      status: "unproven",
      evidence: {
        configured: true,
        stored_credential_present: false,
        stored_credential_readable: false,
        credential_record_complete: false,
        ambient_storage_override_ignored: true,
      },
      next_step: NEXT.connect_imap,
    };
  }
  let record = null;
  if (readable.readable) {
    try { record = loadTokens(storage)?.imap || null; } catch { /* static result below */ }
  }
  const complete = Boolean(record?.host && record?.username && record?.password);
  const status = envelope.error || (envelope.exists && !readable.readable)
    ? "unproven"
    : envelope.exists && readable.readable && complete ? "ready" : "missing";
  return {
    connector: "imap",
    status,
    evidence: {
      configured: true,
      stored_credential_present: Boolean(envelope.exists),
      stored_credential_readable: Boolean(readable.readable),
      credential_record_complete: complete,
      ambient_storage_override_ignored: true,
    },
    next_step: status === "ready" ? NEXT.none : NEXT.connect_imap,
  };
}

function defaultProviderCredential(provider, manifest, options) {
  if (!manifest?.corpora?.[provider]?.enabled) return null;
  const storage = {
    ...(options.credentialStorage || {}),
    backend: manifest?.operations?.provider_token_stores?.[provider] || "auto",
    env: {},
    migrateLegacy: false,
    platform: options.platform ?? process.platform,
  };
  let observed = null;
  try { observed = providerCredentialStatus(provider, storage); } catch { /* static result below */ }
  const ready = Boolean(observed?.connected && observed?.readable && !observed?.migration_pending);
  const status = ready
    ? "ready"
    : !observed || observed?.storage?.error || (observed?.storage?.exists && !observed?.readable)
      ? "unproven"
      : "missing";
  return {
    connector: provider,
    status,
    evidence: {
      configured: true,
      stored_credential_present: Boolean(observed?.storage?.exists),
      stored_credential_readable: Boolean(observed?.readable),
      credential_record_complete: Boolean(observed?.connected),
      custody_migration_pending: Boolean(observed?.migration_pending),
      ambient_storage_override_ignored: true,
    },
    next_step: ready ? NEXT.none : NEXT.connect_provider,
  };
}

async function inspectCredentials(manifest, sources, options) {
  if (typeof options.inspectCredentials === "function") {
    return (await options.inspectCredentials({ manifest, sources })).map((item) => ({ ...item }));
  }
  const results = [];
  const google = defaultGoogleCredential(manifest, options);
  if (google) results.push(google);
  const imap = await defaultImapCredential(manifest, options);
  if (imap) results.push(imap);
  for (const provider of PROVIDERS) {
    const observed = defaultProviderCredential(provider, manifest, options);
    if (observed) results.push(observed);
  }
  const hosted = [...new Set(sources.filter((source) => source.credential === "hosted").map((source) => source.connector))];
  for (const connector of hosted) {
    results.push({
      connector,
      status: "unproven",
      evidence: {
        configured: true,
        local_credential_expected: false,
        hosted_credential_inspection_allowed: false,
      },
      next_step: NEXT.verify_hosted_credential,
    });
  }
  return results;
}

function configuredLocalRoots(manifest) {
  const roots = [];
  let declaredCount = 0;
  const local = manifest?.corpora?.local_folder;
  if (local?.enabled) {
    declaredCount++;
    roots.push({ kind: "local_folder", path: local.path });
  }
  const upload = manifest?.corpora?.upload;
  if (upload?.enabled) {
    const declared = upload.folders ?? upload.paths ?? (upload.path ? [upload.path] : []);
    if (Array.isArray(declared) && declared.length) {
      declaredCount += declared.length;
      for (const item of declared.slice(0, MAX_LOCAL_ROOTS)) {
        roots.push({ kind: "upload", path: typeof item === "string" ? item : item?.path });
      }
    } else {
      declaredCount++;
      roots.push({ kind: "upload", path: null });
    }
  }
  return { roots: roots.slice(0, MAX_LOCAL_ROOTS), declaredCount };
}

function inspectRoots(roots, options) {
  return roots.map((root, ordinal) => {
    let accessible = false;
    if (typeof options.inspectLocalRoot === "function") {
      try { accessible = options.inspectLocalRoot(root.path) === true; } catch { /* missing */ }
    } else if (typeof root.path === "string" && root.path && isAbsolute(root.path)) {
      try {
        const info = lstatSync(root.path);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          if ((options.platform ?? process.platform) === "win32") {
            const directory = opendirSync(root.path);
            directory.closeSync();
          } else {
            const descriptor = openSync(root.path, fsConstants.O_RDONLY |
              (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0));
            closeSync(descriptor);
          }
          accessible = true;
        }
      } catch { /* missing/inaccessible */ }
    }
    return {
      root_kind: root.kind,
      ordinal: ordinal + 1,
      status: accessible ? "ready" : "missing",
      evidence: { declared: Boolean(root.path), accessible_directory: accessible },
      next_step: accessible ? NEXT.none : NEXT.restore_root,
    };
  });
}

function schedulerStatusFromObservation(kind, observation, platform) {
  if (platform !== "darwin") {
    return {
      scheduler: kind,
      status: "inapplicable",
      evidence: {
        supported_on_platform: false,
        installed: null,
        loaded: null,
        exact_configuration: null,
        configuration_drift: null,
        interpreter_present: null,
        last_exit_code: null,
        last_run_succeeded: null,
        local_session_present: null,
      },
      next_step: NEXT.none,
    };
  }
  if (!observation || typeof observation !== "object") {
    return {
      scheduler: kind,
      status: "unproven",
      evidence: {
        supported_on_platform: true,
        installed: null,
        loaded: null,
        exact_configuration: null,
        configuration_drift: null,
        interpreter_present: null,
        last_exit_code: null,
        last_run_succeeded: null,
        local_session_present: null,
      },
      next_step: NEXT.review_scheduler,
    };
  }
  const planError = Boolean(observation?.scheduleError || observation?.planError);
  const installed = typeof observation.installed === "boolean" ? observation.installed : null;
  const loaded = typeof observation.loaded === "boolean" ? observation.loaded : null;
  const exactConfiguration = typeof observation.definitionMatches === "boolean"
    ? observation.definitionMatches && !planError
    : null;
  const interpreterPresent = typeof observation.interpreterPresent === "boolean"
    ? observation.interpreterPresent
    : null;
  const ready = Boolean(installed === true && loaded === true && exactConfiguration === true &&
    interpreterPresent !== false && !planError &&
    (observation?.lastExitCode === null || observation?.lastExitCode === 0));
  const missing = installed === false || loaded === false || interpreterPresent === false;
  return {
    scheduler: kind,
    status: ready ? "ready" : missing ? "missing" : "unproven",
    evidence: {
      supported_on_platform: true,
      installed,
      loaded,
      exact_configuration: exactConfiguration,
      configuration_drift: installed === true && exactConfiguration !== null
        ? !exactConfiguration
        : null,
      interpreter_present: interpreterPresent,
      last_exit_code: Number.isInteger(observation?.lastExitCode) ? observation.lastExitCode : null,
      last_run_succeeded: typeof observation?.lastRunSucceeded === "boolean" ? observation.lastRunSucceeded : null,
      local_session_present: typeof observation?.pairedSessionExists === "boolean"
        ? observation.pairedSessionExists
        : typeof observation?.sessionPresent === "boolean" ? observation.sessionPresent : null,
    },
    next_step: ready ? NEXT.none : NEXT.review_scheduler,
  };
}

async function inspectSchedulers(manifestPath, sources, options) {
  const platformName = options.platform ?? process.platform;
  const platform = ["darwin", "win32", "linux"].includes(platformName) ? platformName : "other";
  const descriptors = [];
  if (sources.some((source) => source.scheduler === "drive")) descriptors.push({ kind: "drive", run: () => statusDriveScheduler(manifestPath, options.schedulerOptions || {}) });
  if (sources.some((source) => source.scheduler === "folder")) descriptors.push({ kind: "local_folder", run: () => statusFolderScheduler(manifestPath, options.schedulerOptions || {}) });
  if (sources.some((source) => source.scheduler === "imessage")) descriptors.push({ kind: "imessage", run: () => statusImessageScheduler(manifestPath, options.schedulerOptions || {}) });
  if (sources.some((source) => source.scheduler === "whatsapp")) {
    descriptors.push({ kind: "whatsapp_capture", run: () => statusWhatsappDaemon(manifestPath, options.schedulerOptions || {}) });
    descriptors.push({ kind: "whatsapp_drain", run: () => statusWhatsappDrainScheduler(manifestPath, options.schedulerOptions || {}) });
  }
  for (const provider of PROVIDERS) {
    if (sources.some((source) => source.connector === provider && source.scheduler === "provider")) {
      descriptors.push({ kind: provider, run: () => statusProviderScheduler(provider, manifestPath, options.schedulerOptions || {}) });
    }
  }
  const results = [];
  for (const descriptor of descriptors) {
    let observation = null;
    if (platform === "darwin") {
      try {
        observation = typeof options.inspectScheduler === "function"
          ? await options.inspectScheduler(descriptor.kind)
          : await descriptor.run();
      } catch { /* static closed result below */ }
    }
    results.push(schedulerStatusFromObservation(descriptor.kind, observation, platform));
  }
  return results;
}

function checkpointPath(manifestPath, source) {
  return join(dirname(resolve(manifestPath)), `.brain-ingest-${source}.json`);
}

function remoteCursorStatus(row) {
  const value = row?.configuration?.cursor?.status;
  return ["present", "absent", "unavailable"].includes(value) ? value : "unavailable";
}

function explicitCheckpointBinding(state, manifestFingerprint, source) {
  return state?.manifest_binding_version === 1 &&
    typeof manifestFingerprint === "string" &&
    state?.manifest_fingerprint === manifestFingerprint &&
    state?.source === source;
}

function fileCheckpoint(source, manifestPath, manifestFingerprint, options) {
  if (typeof options.inspectFileCheckpoint === "function") {
    try {
      const loaded = options.inspectFileCheckpoint(source.connector, source.source);
      if (!loaded) {
        return { present: false, readable: false, source_configuration_bound: false, brain_manifest_bound: false };
      }
      const bound = explicitCheckpointBinding(loaded, manifestFingerprint, source.source);
      return { present: true, readable: true, source_configuration_bound: bound, brain_manifest_bound: bound };
    } catch {
      return { present: null, readable: false, source_configuration_bound: false, brain_manifest_bound: false };
    }
  }
  const path = checkpointPath(manifestPath, source.source);
  try {
    (options.lstat ?? lstatSync)(path);
  } catch (error) {
    return {
      present: error?.code === "ENOENT" ? false : null,
      readable: false,
      source_configuration_bound: false,
      brain_manifest_bound: false,
    };
  }
  try {
    const loaded = readSafeJson(path, MAX_CHECKPOINT_BYTES, options).value;
    const bound = explicitCheckpointBinding(loaded, manifestFingerprint, source.source);
    return { present: true, readable: true, source_configuration_bound: bound, brain_manifest_bound: bound };
  } catch {
    return { present: true, readable: false, source_configuration_bound: false, brain_manifest_bound: false };
  }
}

function providerCheckpoint(source, manifest, manifestFingerprint, options) {
  const config = manifest?.corpora?.[source.connector] || {};
  const storage = {
    ...(options.credentialStorage || {}),
    backend: manifest?.operations?.provider_token_stores?.[source.connector] || "auto",
    env: {},
    migrateLegacy: false,
    platform: options.platform ?? process.platform,
  };
  try {
    if (typeof options.inspectProviderCheckpoint === "function") {
      return options.inspectProviderCheckpoint(source.connector, source.source, config, manifestFingerprint);
    }
    const state = loadProviderSyncState(source.connector, source.source, storage);
    const connection = source.connector === "quickbooks" ? loadProviderCredentials(source.connector, storage) : null;
    const expected = options.providerConfigurationFingerprint?.(
      source.connector,
      source.source,
      config,
      connection?.provider_metadata?.qbo_company_fingerprint
        ? { qbo_company_fingerprint: connection.provider_metadata.qbo_company_fingerprint }
        : null,
    );
    const present = Boolean(state && Object.keys(state).length);
    const configBound = present && typeof expected === "string" && state.configuration_fingerprint === expected;
    const manifestBound = explicitCheckpointBinding(state, manifestFingerprint, source.source);
    return { present, readable: true, source_configuration_bound: configBound, brain_manifest_bound: manifestBound };
  } catch {
    return { present: null, readable: false, source_configuration_bound: false, brain_manifest_bound: false };
  }
}

function checkpointResult(source, local, remoteRow, remoteAvailable) {
  const remoteHistory = Boolean(remoteRow?.registered);
  const remoteCursor = remoteCursorStatus(remoteRow);
  if (["push", "hosted"].includes(source.checkpoint)) {
    return {
      connector: source.connector,
      status: source.checkpoint === "push" ? "inapplicable" : "unproven",
      evidence: {
        local_checkpoint_expected: false,
        local_checkpoint_present: false,
        source_configuration_bound: false,
        brain_manifest_bound: false,
        remote_history_present: remoteHistory,
        remote_cursor_receipt: remoteCursor,
        exact_cursor_comparison: "inapplicable",
      },
      next_step: source.checkpoint === "push" ? NEXT.none : NEXT.verify_hosted_credential,
    };
  }
  const exactCursorComparable = false;
  const status = local.present === false
    ? "missing"
    : local.present === true && local.readable && local.source_configuration_bound && local.brain_manifest_bound && exactCursorComparable
      ? "ready"
      : "unproven";
  return {
    connector: source.connector,
    status,
    evidence: {
      local_checkpoint_expected: true,
      local_checkpoint_presence_proven: local.present !== null,
      local_checkpoint_present: local.present === null ? null : Boolean(local.present),
      local_checkpoint_readable: Boolean(local.readable),
      source_configuration_bound: Boolean(local.source_configuration_bound),
      brain_manifest_bound: Boolean(local.brain_manifest_bound),
      remote_history_available: remoteAvailable,
      remote_history_present: remoteHistory,
      remote_cursor_receipt: remoteCursor,
      exact_cursor_comparison: exactCursorComparable ? "ready" : "unproven",
    },
    next_step: NEXT.preserve_checkpoint,
  };
}

function inspectCheckpoints(manifest, manifestPath, manifestFingerprint, sources, remote, options) {
  const remoteRows = new Map((remote?.sources || []).map((row) => [row?.source_id, row]));
  const remoteAvailable = remote?.complete === true;
  return sources.map((source) => {
    let local = { present: false, readable: false, source_configuration_bound: false, brain_manifest_bound: false };
    if (source.checkpoint === "file") local = fileCheckpoint(source, manifestPath, manifestFingerprint, options);
    else if (source.checkpoint === "provider") local = providerCheckpoint(source, manifest, manifestFingerprint, options);
    return checkpointResult(source, local, remoteRows.get(source.source), remoteAvailable);
  });
}

function remoteHistoryResult(remote, sources, attempted, configurationComplete) {
  if (!remote?.complete || !Array.isArray(remote.sources)) {
    return {
      status: "unproven",
      evidence: {
        authenticated_read_attempted: attempted,
        stable_complete_snapshot: false,
        local_configuration_scope_complete: configurationComplete,
        configured_connector_count: sources.length,
        registered_remote_source_count: 0,
        matching_registered_source_count: 0,
      },
      next_step: NEXT.rerun_remote,
    };
  }
  const rows = new Map(remote.sources.map((row) => [row?.source_id, row]));
  const matches = sources.filter((source) => rows.get(source.source)?.registered).length;
  const registeredRemote = remote.sources.filter((row) => row?.registered === true).length;
  const exactCoverage = configurationComplete &&
    matches === sources.length && registeredRemote === sources.length;
  return {
    status: !configurationComplete ? "unproven" : exactCoverage ? "ready" : "missing",
    evidence: {
      authenticated_read_attempted: true,
      stable_complete_snapshot: true,
      local_configuration_scope_complete: configurationComplete,
      configured_connector_count: sources.length,
      registered_remote_source_count: registeredRemote,
      matching_registered_source_count: matches,
    },
    next_step: exactCoverage ? NEXT.none
      : configurationComplete ? NEXT.reconcile_source_history : NEXT.review_source_configuration,
  };
}

function deployedBindingResult(manifestCheck, ownerCredential, remote) {
  const dataPlaneAuthenticated = remote?.complete === true;
  // The current source-inventory response proves the saved domain/key pair and
  // that D1 answered, but deliberately does not echo the manifest's account,
  // Worker, D1 or Vectorize identifiers. Do not turn that privacy property into
  // a false exact-resource match.
  const exactResourceBinding = false;
  return {
    check: "deployed_brain_binding",
    status: manifestCheck.status === "missing" || ownerCredential.status === "missing"
      ? "missing"
      : exactResourceBinding ? "ready" : "unproven",
    evidence: {
      local_resource_binding_declared: Boolean(manifestCheck.evidence.resource_binding_declared),
      saved_domain_and_owner_credential_authenticated: dataPlaneAuthenticated,
      d1_source_history_readable: dataPlaneAuthenticated,
      exact_deployed_resource_binding_proven: exactResourceBinding,
      cloudflare_control_plane_inspected: false,
    },
    next_step: exactResourceBinding ? NEXT.none : NEXT.verify_binding,
  };
}

function validatePrivacy(value) {
  const strings = [];
  (function visit(item, path = "report") {
    if (Array.isArray(item)) return item.forEach((child, index) => visit(child, `${path}[${index}]`));
    if (!item || typeof item !== "object") {
      if (typeof item === "string") strings.push(item);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:path|domain|slug|name|source|source_id|account_id|database_id|worker_name|vectorize_index|cursor|cursor_value|token|secret|credential_value|manifest_fingerprint|provider_identity)$/i.test(key)) {
        throw new Error(`machine continuity privacy boundary rejected ${path}.${key}`);
      }
      if (key === "status" && !STATUS.has(child)) {
        throw new Error(`machine continuity status boundary rejected ${path}.${key}`);
      }
      visit(child, `${path}.${key}`);
    }
  })(value);
  for (const text of strings) {
    if (/\b(?:[A-Fa-f0-9]{32}|[A-Fa-f0-9]{64}|[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27,})\b/.test(text) ||
        /(?:^|\s)(?:\/(?:[^\s/]+\/)+[^\s]*|[A-Za-z]:\\|keychain:\/\/|secret:\/\/|https?:\/\/[^\s<>]+)/.test(text)) {
      throw new Error("machine continuity privacy boundary rejected a raw locator or identifier");
    }
  }
  return value;
}

export function assertMachineContinuityPrivacy(report) {
  return validatePrivacy(report);
}

function smallestNextStep(items) {
  for (const status of ["missing", "unproven"]) {
    const found = items.find((item) => item?.status === status && item.next_step && item.next_step !== NEXT.none);
    if (found) return found.next_step;
  }
  return NEXT.none;
}

export async function auditMachineContinuity({
  manifest,
  manifestPath,
  productVersion,
  assistantPlan,
  remoteInventoryLoader,
  providerConfigurationFingerprint,
  options = {},
}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("machine continuity needs one manifest");
  if (!manifestPath) throw new TypeError("machine continuity needs an explicit manifest path");
  const platformName = options.platform ?? process.platform;
  const platform = ["darwin", "win32", "linux"].includes(platformName) ? platformName : "other";
  const manifestInspection = inspectManifest(manifest, manifestPath, productVersion, options);
  const remembered = inspectRememberedManifest(manifestPath, options);
  const ownerCredential = inspectOwnerCredential(manifestPath, options);
  const cli = inspectCli(manifest, productVersion, options);
  const assistants = [
    assistantCheck(assistantPlan, "technician-skill"),
    assistantCheck(assistantPlan, "claude-code-mcp"),
    assistantCheck(assistantPlan, "codex-mcp"),
  ];
  const sourceConfig = sourceConfiguration(manifest);
  const sources = sourceConfig.sources;
  const credentials = await inspectCredentials(manifest, sources, options);
  const localRoots = inspectRoots(sourceConfig.roots, options);
  const schedulers = await inspectSchedulers(manifestPath, sources, { ...options, platform });

  let remote = null;
  let remoteAttempted = false;
  if (manifestInspection.check.evidence.deployed_address_valid && ownerCredential.status === "ready" &&
      typeof remoteInventoryLoader === "function") {
    remoteAttempted = true;
    try { remote = await remoteInventoryLoader(); } catch { remote = null; }
  }
  const remoteSourceHistory = remoteHistoryResult(
    remote,
    sources,
    remoteAttempted,
    sourceConfig.check.status === "ready",
  );
  const checkpoints = inspectCheckpoints(
    manifest,
    manifestPath,
    manifestInspection.fingerprint,
    sources,
    remote,
    { ...options, providerConfigurationFingerprint },
  );
  const deployedBinding = deployedBindingResult(manifestInspection.check, ownerCredential, remote);
  const checks = [
    manifestInspection.check,
    sourceConfig.check,
    remembered,
    ownerCredential,
    deployedBinding,
    cli.installation,
    cli.releaseIntegrity,
    ...assistants,
  ];
  const all = [...checks, ...credentials, ...localRoots, ...schedulers, ...checkpoints, remoteSourceHistory];
  const report = {
    schema_version: 1,
    kind: "machine_continuity",
    mode: "audit",
    read_only: true,
    status: summaryStatus(all),
    checked_at: (options.now?.() ?? new Date()).toISOString(),
    platform,
    checks,
    connector_credentials: credentials,
    local_source_roots: localRoots,
    schedulers,
    resume_checkpoints: checkpoints,
    remote_source_history: remoteSourceHistory,
    smallest_safe_next_step: smallestNextStep(all),
    limitations: {
      exact_deployed_resource_binding: "unproven",
      exact_local_to_remote_cursor_comparison: "unproven",
      cli_release_integrity_and_currency: "unproven",
      reason: "Local self-inspection cannot authenticate a public release; the read-only D1 inventory also masks cursors and Cloudflare resource identifiers.",
    },
    boundaries: {
      writes_files: false,
      installs_or_updates_software: false,
      changes_brain_records: false,
      changes_sources_or_providers: false,
      refreshes_provider_data: false,
      changes_schedulers: false,
      opens_browser_or_prompts: false,
      reads_cloudflare_control_plane: false,
      checks_passkeys_or_devices: false,
      accepts_ambient_credentials: false,
    },
  };
  assertMachineContinuityPrivacy(report);
  return freeze(report);
}
