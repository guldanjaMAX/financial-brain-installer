import { api } from "./api";

// WebAuthn speaks ArrayBuffers; the wire speaks base64url. These two are the
// whole translation layer.
const toBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
const toB64u = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const passkeysSupported = (): boolean =>
  typeof window !== "undefined" && !!window.PublicKeyCredential;

type RegisterOptions = { challenge: string; rp: { id: string; name: string }; user_name: string };
type EnrollmentKind = "owner" | "document";
export type AssertionOptions = {
  challenge: string;
  rp_id: string;
  allow_credentials?: string[];
};
export type AssertionPayload = {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
};

export class PasskeyCeremonyCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyCeremonyCancelledError";
  }
}

/** Create a passkey. `code` is the one-time invite; omit it to add a device
 *  from an already signed-in session. */
export async function enroll(code?: string, kind: EnrollmentKind = "owner"): Promise<void> {
  const options = await api<RegisterOptions>("/auth/register/options", code ? { code } : {});
  const action = kind === "document"
    ? "Create my passkey for shared access"
    : "Create my owner passkey";
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: toBytes(options.challenge),
        rp: { id: options.rp.id, name: options.rp.name },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: options.user_name,
          displayName: options.user_name,
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        // residentKey so signing in later needs no username, and userVerification
        // so it is genuinely a face or a fingerprint rather than mere presence.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw explainCeremonyFailure(error, options.rp.id, "enroll", kind);
  }
  if (!credential) {
    throw new PasskeyPromptError(
      `No passkey was created. Nothing was enrolled. You can choose ${action} and try again while this private link is valid.`,
      "PASSKEY_CANCELLED",
    );
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  await api("/auth/register/verify", {
    code,
    nickname: navigator.platform || "this device",
    credentialId: credential.id,
    attestationObject: toB64u(response.attestationObject),
    clientDataJSON: toB64u(response.clientDataJSON),
  });
}

// Keep support identity separate from owner copy. Callers can offer recovery
// without parsing a translated sentence or exposing browser exception names.
export class PasskeyPromptError extends Error {
  constructor(message: string, readonly code: string, readonly details?: string) {
    super(message);
  }
}

/** Turn a WebAuthn failure into owner guidance with a stable support code. */
export function explainCeremonyFailure(
  error: unknown,
  rpId: string,
  purpose: "enroll" | "sign_in" | "confirm_map" = "sign_in",
  enrollmentKind: EnrollmentKind = "owner",
): Error {
  const name = (error as { name?: string })?.name || "Error";
  const enrollmentAction = enrollmentKind === "document"
    ? "Create my passkey for shared access"
    : "Create my owner passkey";
  if (name === "NotAllowedError") {
    if (purpose === "enroll") {
      return new PasskeyPromptError(
        `No passkey was created for ${rpId}. The secure window may have been canceled or timed out. ` +
        `Nothing was enrolled. You can choose ${enrollmentAction} and try again while this private link is valid.`,
        "PASSKEY_CANCELLED",
      );
    }
    if (purpose === "confirm_map") {
      return new PasskeyCeremonyCancelledError(
        "The secure passkey window was canceled or timed out. Nothing was confirmed or changed. You can review the map and try again when you are ready.",
      );
    }
    return new PasskeyPromptError(
      "Sign-in was cancelled or no passkey was found on this device. Tap Continue with a passkey to try again.",
      "PASSKEY_CANCELLED",
      `Use a passkey saved for ${rpId}. A passkey saved under a different address for this Brain will not work here.`,
    );
  }
  if (name === "SecurityError") {
    return new PasskeyPromptError(
      `This page's address does not match the one your passkey was saved under ` +
      `(${rpId}). Open the Brain at its normal address and try again.`,
      "PASSKEY_ADDRESS_MISMATCH",
    );
  }
  if (name === "InvalidStateError") {
    return new PasskeyPromptError(purpose === "enroll"
      ? enrollmentKind === "document"
        ? `This device could not create another shared-access passkey for ${rpId}. Open the Brain at its normal address and sign in with an existing passkey, or ask the Brain owner for a fresh link.`
        : `This device already has an owner passkey for ${rpId}. Open the Brain at its normal address and sign in with it.`
      : `This device already has a passkey for ${rpId}.`, "PASSKEY_ALREADY_SAVED");
  }
  if (name === "NotSupportedError" || name === "AbortError") {
    return new PasskeyPromptError(
      "This browser could not run the passkey prompt. Try opening the Brain in " +
      "Safari or Chrome directly rather than inside another app.",
      name === "AbortError" ? "PASSKEY_INTERRUPTED" : "PASSKEY_BROWSER_UNSUPPORTED",
    );
  }
  return new PasskeyPromptError(String((error as { message?: string })?.message || error), "PASSKEY_PROMPT_FAILED");
}

/**
 * Ask the device for one assertion. Calling this function is the WebAuthn
 * boundary, so owner screens must call it only from the owner's explicit click.
 */
export async function requestPasskeyAssertion(
  options: AssertionOptions,
  purpose: "sign_in" | "confirm_map" = "sign_in",
): Promise<AssertionPayload> {
  if (!passkeysSupported()) {
    throw new Error("This browser cannot open a passkey window. Open this Brain in Safari or Chrome and try again.");
  }
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: toBytes(options.challenge),
        rpId: options.rp_id,
        userVerification: "required",
        allowCredentials: (options.allow_credentials || []).map((id) => ({
          id: toBytes(id), type: "public-key" as const,
        })),
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw explainCeremonyFailure(error, options.rp_id, purpose);
  }
  if (!assertion) {
    if (purpose === "confirm_map") {
      throw new PasskeyCeremonyCancelledError("No passkey was offered. Nothing was confirmed or changed.");
    }
    throw new PasskeyPromptError(
      "Sign-in was cancelled or no passkey was found on this device. Tap Continue with a passkey to try again.",
      "PASSKEY_CANCELLED",
      `Use a passkey saved for ${options.rp_id}. A passkey saved under a different address for this Brain will not work here.`,
    );
  }
  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    credentialId: assertion.id,
    authenticatorData: toB64u(response.authenticatorData),
    clientDataJSON: toB64u(response.clientDataJSON),
    signature: toB64u(response.signature),
  };
}

export async function signIn(): Promise<void> {
  const options = await api<{ challenge: string; rp_id: string }>("/auth/login/options");
  await api("/auth/login/verify", await requestPasskeyAssertion(options));
}
