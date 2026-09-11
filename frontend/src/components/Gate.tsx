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
              ? "A private place to ask about the material connected to your Brain. Each answer shows its sources and calls out coverage it cannot prove."
              : "Sign in to ask your brain a question."}
          </p>

          {notice && (
            <p role="status" className="mt-4 text-[14px] text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 leading-relaxed">
              {notice}
            </p>
          )}

          {enrolling ? (
            <div role="note" className="mt-6 rounded-xl border border-line bg-paper/60 p-4">
              <h2 className="text-[15px] font-semibold">Here is what happens next</h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
                What will happen remains in your control. Nothing opens until you choose the button below.
              </p>
              <ol className="mt-3 space-y-2.5">
                <li className="flex gap-2.5 text-[14.5px] leading-6">
                  <span className="text-accent font-semibold" aria-hidden="true">1</span>
                  <span>Choose <strong>Create my owner passkey</strong> below.</span>
                </li>
                <li className="flex gap-2.5 text-[14.5px] leading-6">
                  <span className="text-accent font-semibold" aria-hidden="true">2</span>
                  <span>
                    Your device will open its secure passkey window. Follow that window using
                    Face ID, Touch ID, a fingerprint, a security key, your device PIN, or screen
                    lock. First check that this page is at <strong>{hostname}</strong>.
                  </span>
                </li>
              </ol>
              <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
                This verifies that you are the owner and protects your private owner area without
                another password. Your biometric data and device PIN never go to Financial Brain.
                Financial Brain and your Claude or Codex guide cannot see or store your passkey,
                Face ID, fingerprint, or device PIN. The private passkey stays with your device or
                passkey provider. The Brain keeps only the public sign-in record needed to recognize you.
              </p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
                This passkey step does not connect files, messages, accounts, or other device data.
                If the address or secure window looks unexpected, choose Cancel. Nothing is enrolled.
                Canceling the device prompt does not use it, so you can try again before this private
                link expires.
              </p>
            </div>
          ) : (
            <div role="note" className="mt-6 rounded-xl border border-line bg-paper/60 p-4 text-[14px] leading-relaxed text-ink-soft">
              Your device will open its normal passkey window only after you choose the button
              below. Check that this page is at <strong>{hostname}</strong>, then answer the system
              prompt yourself. Financial Brain never receives your biometric data or device PIN.
            </div>
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
              Usually takes about ten seconds. This private link expires 15 minutes after it was
              created and works once. You stay in control of the secure device window, and your
              passkey may sync through your chosen passkey provider.
            </p>
          )}
          {error && <p role="alert" className="mt-4 text-[14px] text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
