import { useState } from "react";
import { enroll, signIn, passkeysSupported } from "../lib/passkey";

/**
 * The first screen a client ever sees, usually on a phone, from a text
 * message. It has to answer "what is this and why should I tap" before it
 * asks for anything, which is why the copy leads and the button follows.
 */
export function Gate({ owner, inviteCode, notice, onIn }: {
  owner: string;
  inviteCode: string | null;
  notice?: string | null;
  onIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrolling = Boolean(inviteCode);
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "Your";
  const hostname = typeof location === "undefined" ? "this Brain's address" : location.hostname;
  // First name in the greeting: a client opening this is being welcomed, not
  // addressed formally, and "Dana, your brain is ready" reads like a person
  // wrote it where "Dana Okonkwo's brain is ready" reads like a database did.
  const firstName = owner.trim().split(/\s+/)[0] || "";

  async function go() {
    setError(null);
    setBusy(true);
    try {
      if (enrolling) {
        await enroll(inviteCode!);
        history.replaceState(null, "", "/app");
      } else {
        await signIn();
      }
      onIn();
    } catch (e) {
      // Surface the real reason. "Something went wrong" on a security screen
      // is how someone decides the product is broken rather than that they
      // cancelled their device's passkey prompt.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-5">
      <div className="w-full max-w-md">
        <div className="mb-6 text-[15px] text-ink-soft">{possessive} brain</div>

        <div className="bg-card border border-line rounded-2xl p-7 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <h1 className="text-[26px] leading-tight tracking-tight font-semibold">
            {enrolling
              ? firstName ? `${firstName}, your brain is ready` : "Your brain is ready"
              : firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          </h1>
          <p className="text-ink-soft mt-3 leading-relaxed">
            {enrolling
              ? "Create the owner passkey you will use to open this Brain without making a Brain password or handling the installer's admin key."
              : "Sign in to ask your Brain a question. Your device will open its normal passkey window only after you choose the button below."}
          </p>

          {notice && (
            <p role="status" className="mt-4 text-[14px] text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 leading-relaxed">
              {notice}
            </p>
          )}

          {enrolling && (
            <div className="mt-6 rounded-xl border border-line bg-paper px-4 py-4 text-[14px] leading-relaxed">
              <p className="font-semibold text-ink">What will happen</p>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-ink-soft">
                <li>Nothing opens until you choose <strong className="text-ink">Create my owner passkey</strong>.</li>
                <li>Your device will show its normal passkey window. It may ask for Face ID, Touch ID, a fingerprint, a security key, or your device PIN.</li>
                <li>Check that this page is at <strong className="text-ink">{hostname}</strong>, then complete the device step yourself. If anything looks wrong, cancel.</li>
              </ol>
              <p className="mt-3 text-ink-soft">
                Your biometric data and device PIN never go to Financial Brain. The private passkey stays
                with your device or passkey provider. This Brain stores only the public verification data
                needed to recognize it, and cannot use the passkey to read other files on your device.
              </p>
            </div>
          )}

          {!enrolling && (
            <p className="mt-5 text-[14px] leading-relaxed text-ink-soft">
              Check that this page is at <strong className="text-ink">{hostname}</strong>, then answer the
              system prompt yourself. Financial Brain does not receive your biometric data or device PIN.
            </p>
          )}

          {passkeysSupported() ? (
            <button
              onClick={go}
              disabled={busy}
              className="mt-7 w-full rounded-xl bg-accent px-5 py-3.5 text-white font-semibold
                         disabled:opacity-55 transition-opacity"
            >
              {busy ? "Waiting for your device…" : enrolling ? "Create my owner passkey" : "Continue to my passkey"}
            </button>
          ) : (
            <p className="mt-7 text-sm text-ink-soft">
              This browser cannot use passkeys. Open this link in Safari or Chrome
              on a device with a screen lock.
            </p>
          )}

          {enrolling && (
            <p className="mt-3 text-[13px] text-ink-soft">
              This private link expires 15 minutes after it was created and works once. Canceling the
              device prompt does not use it, so you can retry before it expires. Your passkey may sync
              through your chosen passkey provider, but availability on every device is not guaranteed.
            </p>
          )}
          {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
