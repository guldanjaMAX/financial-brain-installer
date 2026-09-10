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
      // cancelled a Face ID prompt.
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
              ? "Everything you have written, decided and been told, in one place that belongs to you. Ask it anything and it answers with its sources."
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
              <ol className="mt-3 space-y-2.5">
                <li className="flex gap-2.5 text-[14.5px] leading-6">
                  <span className="text-accent font-semibold" aria-hidden="true">1</span>
                  <span>Choose <strong>Create my owner passkey</strong> below.</span>
                </li>
                <li className="flex gap-2.5 text-[14.5px] leading-6">
                  <span className="text-accent font-semibold" aria-hidden="true">2</span>
                  <span>
                    Your device will open its secure passkey window. Follow that window using
                    Face ID, fingerprint, your device PIN, or screen lock.
                  </span>
                </li>
              </ol>
              <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
                This verifies that you are the owner and protects your private owner area without
                another password. Financial Brain and your Claude or Codex guide cannot see or
                store your passkey, Face ID, fingerprint, or device PIN. Those stay protected by
                your device. The Brain keeps only the public sign-in record needed to recognize you.
              </p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
                Nothing else on this device is connected. If the address or secure window looks
                unexpected, choose Cancel. Nothing is enrolled, and you can try again before this
                private link expires.
              </p>
            </div>
          ) : (
            <div role="note" className="mt-6 rounded-xl border border-line bg-paper/60 p-4 text-[14px] leading-relaxed text-ink-soft">
              Choosing <strong>Sign in with my passkey</strong> opens your device's secure passkey
              window. Financial Brain never receives your Face ID, fingerprint, or device PIN.
            </div>
          )}

          {passkeysSupported() ? (
            <button
              onClick={go}
              disabled={busy}
              className="mt-7 w-full rounded-xl bg-accent px-5 py-3.5 text-white font-semibold
                         disabled:opacity-55 transition-opacity"
            >
              {busy ? "Waiting for your device…" : enrolling ? "Create my owner passkey" : "Sign in with my passkey"}
            </button>
          ) : (
            <p className="mt-7 text-sm text-ink-soft">
              This browser cannot use passkeys. Open this link in Safari or Chrome
              on a device with a screen lock.
            </p>
          )}

          {enrolling && (
            <p className="mt-3 text-[13px] text-ink-soft">
              Usually takes about ten seconds. You stay in control of the secure device window.
            </p>
          )}
          {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
