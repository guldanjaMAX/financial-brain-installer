import { useState } from "react";
import { ApiError } from "../lib/api";
import { enroll, signIn, passkeysSupported, PasskeyPromptError } from "../lib/passkey";

export type EnrollmentKind = "owner" | "document";

function rehearsalPasskeyNotice(kind: EnrollmentKind | null): string {
  return kind === "document"
    ? "Shared-access passkey creation is intentionally unavailable in this local rehearsal. No passkey or document access was created, and nothing changed. A real recipient uses the private shared-access link from the Brain owner at that Brain's normal web address."
    : "Passkey creation is intentionally unavailable in this local rehearsal. No passkey was enrolled in a Brain, and nothing changed. To create a real passkey, use the private setup link from your technician at your Brain's normal web address.";
}

export function gatePasskeyFailure(error: unknown, {
  enrolling,
  enrollmentKind = null,
  rehearsal,
}: {
  enrolling: boolean;
  enrollmentKind?: EnrollmentKind | null;
  rehearsal: boolean;
}): { message: string; unavailable: boolean; allowSignIn?: boolean } {
  const serverError = error instanceof ApiError && typeof error.body.error === "string"
    ? error.body.error
    : "";
  const invalidEnrollment = serverError === "a valid enrollment link is required" ||
    serverError === "the enrollment link is invalid, expired, or already used";
  if (enrolling && enrollmentKind !== "document" && invalidEnrollment) {
    return {
      message: "This setup link has expired or was already used. Links work once and expire 15 minutes after they're made. If you already made a passkey on this device, choose Sign in instead. Otherwise ask your installer for a new link.",
      unavailable: true,
      allowSignIn: true,
    };
  }
  if (enrolling && error instanceof PasskeyPromptError && error.code === "PASSKEY_ALREADY_SAVED") {
    return { message: error.message, unavailable: true, allowSignIn: true };
  }
  if (!enrolling && serverError === "unknown passkey") {
    return {
      message: "This Brain doesn't recognize this passkey. Try another passkey or ask for a new setup link.",
      unavailable: false,
    };
  }
  if (!enrolling && (serverError === "unknown or expired challenge" ||
      serverError === "unknown, expired, or already used challenge")) {
    return {
      message: "This sign-in expired before it finished. Choose Continue with a passkey to try again.",
      unavailable: false,
    };
  }
  if (!(error instanceof ApiError) || error.status !== 404) {
    return {
      message: error instanceof Error ? error.message : String(error),
      unavailable: false,
    };
  }
  if (rehearsal) {
    return {
      message: rehearsalPasskeyNotice(enrollmentKind),
      unavailable: true,
    };
  }
  return {
    message: enrolling
      ? enrollmentKind === "document"
        ? "This private shared-access link could not start or finish passkey creation. No passkey was created, no document was opened, and nothing changed here. Ask the Brain owner for a fresh private shared-access link, then open it at this Brain's normal web address."
        : "This private setup link could not start or finish passkey creation. No passkey was enrolled in this Brain, and nothing changed here. Ask your installer for a fresh private setup link, then open it at your Brain's normal web address."
      : "Passkey sign-in is unavailable at this address. Nothing changed. Open your Brain at its normal web address and try again. If you are already there, ask your installer to check that the Brain is up to date.",
    unavailable: true,
    allowSignIn: enrolling,
  };
}

function isLocalRehearsalPage(): boolean {
  if (typeof location === "undefined") return false;
  const loopback = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1";
  return loopback && new URLSearchParams(location.search || "").has("state");
}

/**
 * The first screen a client ever sees, usually on a phone, from a text
 * message. It has to answer "what is this and why should I tap" before it
 * asks for anything, which is why the copy leads and the button follows.
 */
export function Gate({ owner, inviteCode, enrollmentKind, notice, onIn }: {
  owner: string;
  inviteCode: string | null;
  enrollmentKind: EnrollmentKind | null;
  notice?: string | null;
  onIn: (notice?: string) => void;
}) {
  const enrolling = Boolean(inviteCode);
  const documentEnrollment = enrolling && enrollmentKind === "document";
  const rehearsal = isLocalRehearsalPage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => rehearsal ? rehearsalPasskeyNotice(enrollmentKind) : null);
  const [unavailable, setUnavailable] = useState(rehearsal);
  const [allowSignIn, setAllowSignIn] = useState(false);
  const [errorCode, setErrorCode] = useState(rehearsal ? "PASSKEY_REHEARSAL" : "");
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const supported = passkeysSupported();
  const setupUnavailable = enrolling && (unavailable || allowSignIn);
  const showInstructions = supported && !setupUnavailable;
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "Your";
  const hostname = typeof location === "undefined" ? "this Brain's address" : location.hostname;
  // The rehearsal card describes the real setup page, so it must not name the
  // loopback host it happens to be served from as the address to check.
  const enrollmentAddress = rehearsal
    ? documentEnrollment ? "that Brain's normal web address" : "your Brain's normal web address"
    : hostname;
  // A first-name greeting welcomes the owner without turning the setup page
  // into a formal account record.
  const firstName = owner.trim().split(/\s+/)[0] || "";
  const enrollmentButton = documentEnrollment
    ? "Create my passkey for shared access"
    : "Create my owner passkey";

  function finishSignIn() {
    // The query carries a closed intent, never a caller-supplied destination.
    // Read it before clearing the URL, including an expired invite fragment.
    const connectBank = new URLSearchParams(location.search || "").get("then") === "connect-bank";
    history.replaceState(null, "", "/app");
    if (connectBank) {
      // The bank page is served by the Worker, so changing SPA history alone
      // would leave the owner in the app instead of loading that page.
      location.assign("/app/connect/bank");
      return;
    }
    onIn();
  }

  async function go() {
    setError(null);
    setBusy(true);
    try {
      if (enrolling) {
        await enroll(inviteCode!, enrollmentKind || "owner");
        history.replaceState(null, "", "/app");
        onIn(documentEnrollment ? undefined : "✓ Passkey saved. Sign in with Touch ID from now on.");
      } else {
        await signIn();
        finishSignIn();
      }
    } catch (e) {
      // Surface the real reason. "Something went wrong" on a security screen
      // is how someone decides the product is broken rather than that they
      // cancelled their device's passkey prompt.
      const failure = gatePasskeyFailure(e, { enrolling, enrollmentKind, rehearsal });
      showFailure(e, failure);
      setUnavailable(failure.unavailable);
      setAllowSignIn(failure.allowSignIn === true);
    } finally {
      setBusy(false);
    }
  }

  async function signInInstead() {
    setError(null);
    setBusy(true);
    try {
      await signIn();
      finishSignIn();
    } catch (e) {
      const failure = gatePasskeyFailure(e, { enrolling: false, rehearsal });
      showFailure(e, failure);
      setUnavailable(failure.unavailable);
    } finally {
      setBusy(false);
    }
  }

  function showFailure(cause: unknown, failure: ReturnType<typeof gatePasskeyFailure>) {
    setError(failure.message);
    const providerCode = cause instanceof ApiError ? cause.body.code : null;
    setErrorCode(cause instanceof PasskeyPromptError ? cause.code
      : typeof providerCode === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(providerCode) ? providerCode
      : failure.unavailable ? "PASSKEY_LINK_UNAVAILABLE" : "PASSKEY_FAILED");
    setErrorDetails(cause instanceof PasskeyPromptError ? cause.details || null : null);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopyFailed(false);
      setCopyNotice("Link copied. Open it in Safari or Chrome.");
    } catch {
      setCopyFailed(true);
      setCopyNotice("Copy the link from your address bar, then open it in Safari or Chrome.");
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-8 sm:px-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-[15px] text-ink-soft">{possessive} Brain</div>

        <div className="bg-card border border-line rounded-2xl p-4 sm:p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          {enrolling && !setupUnavailable && supported && <p className="mb-2 text-xs font-semibold tracking-wide text-accent">STEP 1 of 1</p>}
          <h1 className="text-[26px] leading-tight tracking-tight font-semibold">
            {setupUnavailable
              ? "This setup link can't be used"
              : documentEnrollment
              ? "Set up your shared document access"
              : enrolling
              ? firstName ? `${firstName}, your Brain is ready` : "Your Brain is ready"
              : "Welcome back"}
          </h1>
          <p className="text-sm text-ink-soft mt-3 leading-relaxed">
            {setupUnavailable
              ? documentEnrollment ? "Ask the Brain owner for a fresh shared-access link, or sign in with a saved passkey." : "Sign in with a saved passkey, or ask your installer for a new setup link."
              : documentEnrollment
              ? "The Brain owner invited you to a private workspace containing only the exact documents they chose. You will not get owner controls or anything else in this Brain."
              : enrolling
              ? "Last step: save your passkey (about 10 seconds)."
              : "Sign in to continue to the part of this Brain your passkey can access."}
          </p>

          {enrolling && !documentEnrollment && !setupUnavailable && (
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              A private place to ask about the material connected to your Brain. Each answer shows
              its sources and calls out coverage it cannot prove.
            </p>
          )}

          {notice && (
            <p role="status" className="mt-4 text-[14px] text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 leading-relaxed">
              {notice}
            </p>
          )}
          {error && (
            <div role="alert" className={`mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed break-words ${unavailable || errorCode === "PASSKEY_CANCELLED" || errorCode === "PASSKEY_INTERRUPTED" || errorCode === "PASSKEY_BROWSER_UNSUPPORTED"
              ? "border-act-line bg-act-bg text-act" : "border-bad-line bg-bad-bg text-bad"}`}>
              <p>{error}</p>
              <p className="mt-1 text-xs text-ink-soft">Code {errorCode}</p>
              {errorDetails && <details className="mt-2 text-ink-soft">
                <summary className="min-h-11 cursor-pointer py-3 font-medium">Not working?</summary>
                <p>{errorDetails}</p>
              </details>}
            </div>
          )}

          {showInstructions && (enrolling ? (
            <div role="note" className="mt-4 rounded-xl border border-line bg-paper/60 p-4">
              <h2 className="text-[15px] font-semibold">
                {rehearsal
                  ? documentEnrollment ? "What happens on the real shared-access page" : "What happens on the real setup page"
                  : "Here is what happens next"}
              </h2>
              <p className="mt-2 text-[14.5px] leading-6">
                Tap the button below. Your device will open its secure passkey window and ask for Face ID, Touch ID, or your screen lock. No password is needed.
              </p>
              {/* The scope, privacy and Cancel sentences stay in view before the
                  device prompt, not inside the collapsed section below. */}
              <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
                {documentEnrollment
                  ? "Your passkey protects only this shared-document workspace and does not make you an owner of the Brain. It unlocks only the exact shared documents already chosen by the Brain owner. "
                  : "This verifies that you are the owner and protects your private owner area. "}
                Financial Brain and your guide cannot see or store your passkey, Face ID, fingerprint, or device PIN.
              </p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
                Check that this page is at <strong>{enrollmentAddress}</strong>. If the address or secure window looks unexpected, choose Cancel. Nothing is enrolled.
              </p>
              <details className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
                <summary className="min-h-11 cursor-pointer py-3 font-medium text-ink">How this keeps you safe</summary>
                <p className="mt-2">
                  Your biometric data and device PIN never go to Financial Brain. The private passkey stays with your device or passkey provider. The Brain keeps only the public sign-in record needed to recognize that passkey.
                </p>
                <p className="mt-2">
                  This passkey step does not connect your files, messages, accounts, or other device data. Canceling the device prompt does not use it, so you can try again before this private link expires.
                </p>
              </details>
            </div>
          ) : (
            <div role="note" className="mt-4 rounded-xl border border-line bg-paper/60 p-4 text-[14px] leading-relaxed text-ink-soft">
              Your device will open its normal passkey window only after you choose the button
              below. Check that this page is at <strong>{hostname}</strong>, then answer the system
              prompt yourself. Financial Brain never receives your biometric data or device PIN.
              <span className="block mt-2">New computer? In the passkey window choose to use your phone, then scan the code with the phone you set up. Lost your phone? Ask for a new setup link.</span>
            </div>
          ))}

          {supported ? (
            <>
              {!allowSignIn && <button
                onClick={go}
                disabled={busy || unavailable}
                className="mt-6 min-h-11 w-full rounded-[10px] bg-accent px-4 py-3 text-white font-semibold
                           disabled:opacity-55 transition-opacity"
              >
                {busy
                  ? "Waiting for your device…"
                  : unavailable
                    ? "Passkey setup unavailable here"
                    : enrolling
                      ? enrollmentButton
                      : "Continue with a passkey"}
              </button>}
              {allowSignIn && (
                <button
                  type="button"
                  onClick={signInInstead}
                  disabled={busy}
                  className="mt-6 min-h-11 w-full rounded-[10px] bg-accent px-4 py-3 text-white font-semibold disabled:opacity-55"
                >
                  Sign in instead
                </button>
              )}
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-act-line bg-act-bg px-4 py-3 text-sm text-act">
              <p role="status">△ This browser cannot use passkeys. Open this link in Safari or Chrome on a device with a screen lock.</p>
              <p className="mt-1 text-xs text-ink-soft">Code PASSKEY_BROWSER_UNSUPPORTED</p>
              <button type="button" onClick={copyLink} className="mt-3 min-h-11 rounded-[10px] border border-line-strong bg-card px-4 py-3 font-semibold text-ink">Copy this link</button>
              {copyNotice && <p role="status" className="mt-3">{copyNotice}</p>}
              {copyFailed && <p className="mt-1 text-xs text-ink-soft">Code PASSKEY_COPY_UNAVAILABLE</p>}
            </div>
          )}

          {enrolling && showInstructions && (
            <p className="mt-3 text-[13px] text-ink-soft">
              {rehearsal ? "On the real page, this usually" : "Usually"} takes about ten seconds. The private link expires 15 minutes after it was
              created and works once. You stay in control of the secure device window, and your
              passkey may sync through your chosen passkey provider.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
