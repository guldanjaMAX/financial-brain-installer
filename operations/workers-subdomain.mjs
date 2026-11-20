/** Account address reservation. The caller supplies the credential-bound transport. */
import { randomInt } from "node:crypto";
import { redactAll, sanitizeSensitiveLinks, scan } from "../worker/src/lib/secret-scan.js";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const FIRST_WORDS = Object.freeze(["quiet", "bright", "calm", "gentle", "clear", "soft", "still", "open"]);
const SECOND_WORDS = Object.freeze(["meadow", "harbor", "grove", "valley", "forest", "brook", "field", "ridge"]);
const REGISTER_FAILED = "CLOUDFLARE_WORKERS_SUBDOMAIN_REGISTER_FAILED";

// No manifest or account name is accepted by the generator.
export function neutralWorkersSubdomainLabel() {
  return `${FIRST_WORDS[randomInt(FIRST_WORDS.length)]}-${SECOND_WORDS[randomInt(SECOND_WORDS.length)]}-${randomInt(1000, 10000)}`;
}

export function maskedSubdomainMessage(value, secrets = [], limit = 400) {
  let text = String(value || "Cloudflare returned no message");
  for (const secret of secrets) {
    const exact = Buffer.isBuffer(secret) ? secret.toString("utf8") : secret;
    if (typeof exact === "string" && exact) text = text.split(exact).join("[masked]");
  }
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  text = redactAll(sanitizeSensitiveLinks(text));
  if (scan(text).shouldFlag) return "Cloudflare message masked because it contained sensitive data";
  return text.slice(0, limit);
}

// Rebuild, rather than mutate, transport errors: Error.stack captures its
// original message and a cause can retain the unmasked provider response.
// Keep the prototype for the OAuth/Fatal decision boundary, plus closed metadata.
function maskedReadFailure(error, secrets) {
  // The CLI's own missing-credential guidance includes the shell-paste guard.
  // Keep that complete while provider diagnostics retain the shorter bound.
  const ownCredentialGuidance = error?.constructor?.name === "Fatal" &&
    /^no Cloudflare credential is available/.test(String(error?.message || ""));
  const safe = new Error(maskedSubdomainMessage(error?.message || error, secrets, ownCredentialGuidance ? 2000 : 400));
  if (error instanceof Error) Object.setPrototypeOf(safe, Object.getPrototypeOf(error));
  safe.name = ["Error", "Fatal", "CloudflareOAuthSessionError"].includes(error?.name) ? error.name : "Error";
  for (const field of ["code", "supportCode"]) {
    if (typeof error?.[field] === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error[field])) safe[field] = error[field];
  }
  if (["profile", "request", "preflight", "token", "authorize"].includes(error?.phase)) safe.phase = error.phase;
  if (Number.isInteger(error?.status)) safe.status = error.status;
  if (Array.isArray(error?.cloudflareErrorCodes)) safe.cloudflareErrorCodes = Object.freeze(error.cloudflareErrorCodes.filter(Number.isInteger));
  if (error?.namedProfileSessionRejected === true) safe.namedProfileSessionRejected = true;
  if (typeof error?.providerMessage === "string") safe.providerMessage = maskedSubdomainMessage(error.providerMessage, secrets);
  return safe;
}

function issue(code, detail) {
  const error = new Error(`${detail}\nIssue: ${code}.\nHelp: https://financialbrain.ai/help/${code}`);
  error.code = code;
  error.supportCode = code;
  return error;
}

export function isWorkersSubdomainMissing(error) {
  return error?.status === 404 && error?.cloudflareErrorCodes?.includes(10007);
}

/**
 * A 200 is authoritative even when malformed: it never authorizes a PUT.
 * Missing means exactly HTTP 404 + 10007, never a permission or transport error.
 * The optional availability endpoint is undocumented, so it is not a dependency.
 */
export async function ensureWorkersDevSubdomain({
  accountId, request, required = true, registrationContext,
  generateLabel = neutralWorkersSubdomainLabel, writeLine = () => {}, secrets = [],
} = {}) {
  if (!required) return null;
  if (typeof request !== "function") throw new TypeError("a credential-bound subdomain request is required");
  const path = `/accounts/${accountId}/workers/subdomain`;
  const read = async () => {
    let result;
    try { result = await request(path); } catch (error) { throw maskedReadFailure(error, secrets); }
    const label = result?.subdomain;
    if (typeof label !== "string" || !LABEL.test(label)) {
      throw issue("CLOUDFLARE_OAUTH_RESPONSE_INVALID", "Cloudflare did not return a usable account subdomain; the read succeeded without a usable name. No further address write was attempted.");
    }
    return label;
  };
  try {
    return await read();
  } catch (error) {
    if (!isWorkersSubdomainMissing(error)) throw error;
  }
  if (!["setup", "persist_workers_dev"].includes(registrationContext)) {
    throw issue("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED", "Cloudflare reports no registered workers.dev subdomain. Ask your installer to resume address setup in the same account.");
  }
  const attempted = new Set();
  for (let attempt = 0; attempt < 5; attempt++) {
    const label = generateLabel();
    if (typeof label !== "string" || !/^[a-z]+-[a-z]+-\d{4}$/.test(label) || attempted.has(label)) {
      throw issue(REGISTER_FAILED, "The neutral address candidate was invalid or repeated. No further address change was attempted.");
    }
    attempted.add(label);
    try {
      await request(path, { method: "PUT", body: { subdomain: label } });
    } catch (error) {
      const conflict = error?.status === 409 ||
        (error?.status === 400 && error?.cloudflareErrorCodes?.includes(10031));
      if (!conflict || attempt === 4) {
        throw issue(REGISTER_FAILED, `Cloudflare could not reserve the web address: ${maskedSubdomainMessage(error?.providerMessage || error?.message, secrets)}`);
      }
      // A conflicting writer may have registered this account already. A 200
      // ends all writes; only a fresh absence proof permits the next candidate.
      try { return await read(); } catch (readError) {
        if (!isWorkersSubdomainMissing(readError)) throw readError;
      }
      continue;
    }
    let observed;
    try { observed = await read(); } catch (error) {
      throw issue(REGISTER_FAILED, `The web address reservation could not be confirmed by readback: ${maskedSubdomainMessage(error?.providerMessage || error?.message, secrets)}`);
    }
    if (observed !== label) {
      throw issue(REGISTER_FAILED, "Cloudflare's web address readback did not match the reserved label. No further address change was attempted.");
    }
    writeLine("✅ Web address reserved");
    return label;
  }
}
