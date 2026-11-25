import { useState } from "react";
import { api } from "../lib/api";
import { Confirm } from "./ui";

export function SignOutConfirm({ disabled, triggerClassName }: { disabled?: boolean; triggerClassName?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/app/signout");
      location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not sign out. Try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <Confirm
        label="Sign out"
        question="Sign out here?"
        tone="quiet"
        disabled={disabled || busy}
        triggerClassName={triggerClassName}
        onConfirm={signOut}
      />
      {error && <p role="alert" className="text-bad">{error}</p>}
    </div>
  );
}
