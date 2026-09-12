import { useEffect, useState } from "react";
import { ApiError, api, apiGet, type Device, type Connection, type BankStatus } from "../lib/api";
import { enroll } from "../lib/passkey";
import { Section, Row, Note, Empty, Attention, Badge, Chip, Confirm, EditableName, ago, agoISO } from "./ui";
import { OwnerPreferences } from "./OwnerPreferences";
import { DocumentAccess } from "./DocumentAccess";
import { PasskeyDiagnostics } from "./PasskeyDiagnostics";

const REHEARSAL_PASSKEY_NOTICE = "Adding a passkey is intentionally unavailable in this local rehearsal. No passkey will be added, and nothing will change. To add a real passkey, open Access at your Brain's normal web address.";

export function addPasskeyFailure(error: unknown, rehearsal: boolean): { message: string; unavailable: boolean } {
  if (!(error instanceof ApiError) || error.status !== 404) {
    return {
      message: error instanceof Error ? error.message : String(error),
      unavailable: false,
    };
  }
  return {
    message: rehearsal
      ? REHEARSAL_PASSKEY_NOTICE
      : "This Brain could not start or finish adding a passkey. No passkey was added to this Brain, and nothing changed here. Reload Access once. If it is still unavailable, ask your installer to check that the Brain is up to date before trying again.",
    unavailable: true,
  };
}

function isLocalRehearsalPage(): boolean {
  if (typeof location === "undefined") return false;
  const loopback = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1";
  return loopback && new URLSearchParams(location.search || "").has("state");
}

function isOwnerAccessRehearsalPage(): boolean {
  if (!isLocalRehearsalPage()) return false;
  return new URLSearchParams(location.search || "").get("state") === "owner-access";
}

export type BankStatusReadState = "loading" | "ready" | "unavailable";

export function BankConnectionsSection({ readState, banks, busy, rehearsal = false, onDisconnect }: {
  readState: BankStatusReadState;
  banks: BankStatus | null;
  busy: boolean;
  rehearsal?: boolean;
  onDisconnect: (itemRef: string) => void;
}) {
  const bankRows = banks?.connections || [];
  const attention = new Set((banks?.needs_attention || []).map((bank) => bank.item_ref));
  return (
    <Section
      title="Banks"
      blurb="Connections that can supply bank activity. Ordinary onboarding does not turn this on."
    >
      {readState === "loading" ? (
        <Note>Checking bank connection status. Until this finishes, the state is unknown.</Note>
      ) : readState === "unavailable" ? (
        <Attention>
          Bank connection status could not be read, so this page cannot say whether a bank is linked.
          This is not the same as no bank. Do not reconnect or disconnect anything here. Ask your
          installer to check the Brain and then reload Access.
        </Attention>
      ) : !banks?.configured ? (
        <Empty>
          Bank connections are not enabled for this Brain. That is the expected state during ordinary
          onboarding, not an error, and no bank login or verification code is needed. This says only
          that a live bank feed is not configured. Imported statements or older records may still exist.
        </Empty>
      ) : (
        <>
          {rehearsal && bankRows.length > 0 ? (
            <Note>
              Bank review and repair are intentionally unavailable in this local rehearsal. This row
              is synthetic, no real bank is connected, and no provider page will open. On a real
              approved pilot Brain, those controls appear on its normal Access page.
            </Note>
          ) : bankRows.length > 0 && (
            <p className="mb-4 text-sm">
              <a className="underline underline-offset-4" href="/app/connect/bank">
                Review approved bank account choices
              </a>
            </p>
          )}
          {bankRows.length === 0 ? (
            <Empty>
              No live bank connection is linked. Starting a new one remains outside ordinary
              onboarding. Ask your installer whether this Brain has a separately reviewed pilot plan.
            </Empty>
          ) : bankRows.map((bank) => (
            <Row key={bank.item_ref}>
              <span className="min-w-0">
                <span className="text-[14.5px] flex items-center gap-2 flex-wrap">
                  {bank.institution_label || "a bank"}
                  {attention.has(bank.item_ref) && <Chip state="PROBLEM" />}
                </span>
                <span className="block text-[13px] text-ink-soft mt-0.5">
                  {bank.last_synced_at ? `Last checked ${agoISO(bank.last_synced_at)}` : "Not checked yet"}
                  {attention.has(bank.item_ref) && (
                    <span className="block text-amber-800 mt-0.5">
                      {bank.status_detail
                        ? `${bank.status_detail}. `
                        : "This connection stopped working. "}
                      Answers about money are missing anything that has happened here since.
                    </span>
                  )}
                </span>
              </span>
              <span className="flex items-center gap-3 flex-wrap">
                {bank.status !== "removed" && (
                  rehearsal ? (
                    <span className="text-sm text-ink-soft" aria-disabled="true">
                      Repair unavailable in rehearsal
                    </span>
                  ) : (
                    <a className="text-sm underline underline-offset-4" href={`/app/connect/bank?mode=reauthorise&item_ref=${encodeURIComponent(bank.item_ref)}`}>
                      Repair connection
                    </a>
                  )
                )}
                <Confirm
                  label="Disconnect"
                  question="Disconnect this bank?"
                  disabled={busy}
                  onConfirm={() => onDisconnect(bank.item_ref)}
                />
              </span>
            </Row>
          ))}
        </>
      )}
    </Section>
  );
}

export function AddPasskeyContext({ busy, hostname, onContinue, onCancel }: {
  busy: boolean;
  hostname: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="region" aria-label="Add an owner passkey" className="mb-4 rounded-xl border border-line bg-paper px-4 py-4">
      <p className="text-[14.5px] font-semibold">Before your device opens a passkey window</p>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
        Continuing will ask your device or security key to create another owner sign-in for
        <strong className="text-ink"> {hostname}</strong>. It may use Face ID, Touch ID, a fingerprint,
        a security key, or your device PIN. Complete that system step yourself only if the address is correct.
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
        Your biometric data and device PIN never go to Financial Brain. The private passkey stays with
        your device or passkey provider. This Brain stores only public verification data and cannot use
        the passkey to read other files on your device.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={onContinue}
          className="rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Waiting for your device…" : "Continue to my device"}
        </button>
        <button
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg px-3.5 py-2 text-[13.5px] text-ink-soft hover:bg-card disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Who and what can open this brain.
 *
 *  There are four ways in, and an owner who has just handed over their
 *  documents asks about all four early: a person with a passkey, an AI app
 *  holding a grant, a bank the brain pulls from, and the operator key used to
 *  install it. A page that answers three of them reads as an answer rather
 *  than as three quarters of one, so the fourth is here too — as the honest
 *  statement that this screen cannot see it. */
export function Settings({ devices, connections, onChange }: {
  devices: Device[];
  connections: Connection[];
  onChange: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banks, setBanks] = useState<BankStatus | null>(null);
  const [bankReadState, setBankReadState] = useState<BankStatusReadState>("loading");
  const [showPasskeyContext, setShowPasskeyContext] = useState(false);
  const [passkeyUnavailable, setPasskeyUnavailable] = useState<string | null>(() =>
    isLocalRehearsalPage() ? REHEARSAL_PASSKEY_NOTICE : null,
  );
  const hostname = typeof location === "undefined" ? "this Brain's address" : location.hostname;

  // The bank feed is a separate surface with its own auth, so it is fetched
  // here rather than folded into /api/app/me: a brain with no bank configured
  // should not make the whole page fail.
  const loadBanks = () => {
    setBankReadState("loading");
    return apiGet<BankStatus>("/api/bank-feed/status")
      .then((next) => {
        setBanks(next);
        setBankReadState("ready");
      })
      .catch(() => {
        setBanks(null);
        setBankReadState("unavailable");
      });
  };
  useEffect(() => { loadBanks(); }, []);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
      onChange();
      await loadBanks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setError(null);
    setBusy(true);
    try {
      await enroll();
      setShowPasskeyContext(false);
      onChange();
      await loadBanks();
    } catch (next) {
      const failure = addPasskeyFailure(next, isLocalRehearsalPage());
      if (failure.unavailable) {
        setPasskeyUnavailable(failure.message);
        setShowPasskeyContext(false);
      } else {
        setError(failure.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="max-w-2xl mb-7">
        <p className="eyebrow">People, devices, and apps</p>
        <h1 className="page-title">Access</h1>
        <p className="page-intro">
          See who and what can open this Brain, manage shared documents, and check whether passkeys are ready.
        </p>
      </header>
      {isOwnerAccessRehearsalPage() && (
        <section role="note" aria-labelledby="guest-access-rehearsal-title" className="mb-6 max-w-3xl rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4 text-amber-950 sm:px-5">
          <p className="eyebrow">Synthetic owner walkthrough</p>
          <h2 id="guest-access-rehearsal-title" className="mt-1.5 text-lg font-semibold">What real guest access needs</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed">
            This rehearsal creates no access. On a real Brain, first open its normal HTTPS address,
            sign in as the owner with your owner passkey, and confirm that this Shared document access
            section is available. If it is missing or unavailable, stop and ask your installer to update the Brain.
          </p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed">
            <li>Have at least one owner-confirmed financial entity and at least one searchable document assigned to that exact entity.</li>
            <li>Choose the entity below, search for the documents, select only the exact documents to share, and enter a clear label for the intended person.</li>
            <li>Choose <strong>Create exact document access</strong>, then send the private, expiring enrollment link only to that person.</li>
            <li>The recipient must open the link at the same Brain address before it expires and create their own passkey on their device.</li>
          </ol>
          <p className="mt-3 text-[13px] leading-relaxed">
            The recipient gets only the selected documents and their shared Explore view, never owner controls or the whole entity. A new link replaces an earlier unused link. Revoke ends the access and its current passkey session.
          </p>
        </section>
      )}
      {error && (
        <p className="mb-5 text-[14px] text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <Section
        title="Your passkeys"
        blurb="These passkeys can open this Brain. A passkey may sync through your chosen passkey provider, but availability on every device is not guaranteed. Add another only when you intend to give that device or provider owner access."
        action={
          <button
            disabled={busy || Boolean(passkeyUnavailable)}
            aria-describedby={passkeyUnavailable ? "passkey-action-unavailable" : undefined}
            onClick={() => setShowPasskeyContext((shown) => !shown)}
            className="text-[13.5px] text-accent font-medium disabled:opacity-50 shrink-0"
          >
            {passkeyUnavailable ? "Passkey setup unavailable" : "+ Add a passkey"}
          </button>
        }
      >
        {passkeyUnavailable && (
          <p
            id="passkey-action-unavailable"
            role="status"
            className="px-4 py-3.5 text-[14px] leading-relaxed text-amber-900 bg-amber-50 border-b border-amber-200"
          >
            {passkeyUnavailable}
          </p>
        )}
        {showPasskeyContext && (
          <AddPasskeyContext
            busy={busy}
            hostname={hostname}
            onContinue={addPasskey}
            onCancel={() => setShowPasskeyContext(false)}
          />
        )}
        {devices.length === 0 ? (
          <Empty>No devices yet.</Empty>
        ) : devices.map((device) => (
          <Row key={device.credential_id}>
            <span className="min-w-0">
              <EditableName
                value={device.nickname || ""}
                placeholder="unnamed device"
                disabled={busy}
                onSave={(nickname) => run(() => api("/api/app/devices/rename", {
                  credential_id: device.credential_id, nickname,
                }))}
              />
              <span className="block text-[13px] text-ink-soft mt-0.5">
                Added {ago(device.created_at)}
                {device.last_used_at ? ` · last used ${ago(device.last_used_at)}` : " · not used yet"}
              </span>
            </span>
            <Confirm
              label="Remove"
              question="Remove this device?"
              disabled={busy}
              onConfirm={() => run(async () => {
                const result = await api<{ removed: boolean; reason?: string }>(
                  "/api/app/devices/revoke", { credential_id: device.credential_id },
                );
                // Removing the last passkey is refused by the brain, not by
                // this button. The reason it gives is the useful part.
                if (result.reason) setError(result.reason);
              })}
            />
          </Row>
        ))}
      </Section>

      <PasskeyDiagnostics />

      <DocumentAccess />

      <OwnerPreferences />

      <Section
        title="Connected AI"
        blurb="Remote apps you approved in a browser with your passkey. Each can search this Brain; only one explicitly approved for writing can add or correct information."
      >
        <p className="border-b border-line px-4 py-3.5 text-[13px] leading-relaxed text-ink-soft">
          Your local Claude Code or Codex Owner assistant is managed on that computer, so it does not
          appear in these remote OAuth rows. When its Financial Brain Owner connection is installed and
          verified, it includes <code className="text-ink">brain_remember</code>. It can add or correct a
          record only after you explicitly approve the exact proposed record.
        </p>
        {connections.length === 0 ? (
          <Empty>
            No remote connector is connected yet. Add this Brain to Claude on the web or phone,
            or ChatGPT, to ask questions there.
          </Empty>
        ) : connections.map((connection) => (
          <Row key={connection.client_id}>
            <span className="min-w-0">
              <span className="text-[14.5px] flex items-center gap-2 flex-wrap">
                {connection.name}
                <Badge tone={connection.can_write ? "accent" : "muted"}>
                  {connection.can_write ? "Reads and writes" : "Reads only"}
                </Badge>
              </span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                Connected {ago(connection.connected_at)}
                {connection.last_used_at
                  ? ` · last used ${ago(connection.last_used_at)}`
                  : " · not used yet"}
              </span>
            </span>
            <Confirm
              label="Disconnect"
              question="Disconnect?"
              disabled={busy}
              onConfirm={() => run(() => api("/api/app/connections/revoke", {
                client_id: connection.client_id,
              }))}
            />
          </Row>
        ))}
      </Section>

      <BankConnectionsSection
        readState={bankReadState}
        banks={banks}
        busy={busy}
        rehearsal={isLocalRehearsalPage()}
        onDisconnect={(itemRef) => {
          void run(() => api("/api/bank-feed/disconnect", { item_ref: itemRef }));
        }}
      />

      <Section
        title="Your owner administration"
        blurb="Your owner passkeys are the normal way you administer this Brain. A separate recovery key used during installation also needs clear custody."
      >
        <Note>
          You are the owner administrator. Your passkeys control normal owner
          sign-in and the explicit owner controls on this page. The operator key
          is a separate installation and recovery capability, not a replacement
          owner account. Because anyone holding it can create a new owner
          enrollment link, removing a device or signing out everywhere does not
          cancel that key. A newly enrolled device will appear in the list above.
        </Note>
        <Note>
          At owner handoff, ask your installer to rotate the operator key, tell
          you the date, and confirm where the new key is kept under your approved
          custody plan. Until that is verified, describe operator-key custody as
          unconfirmed. If a device appears that you do not recognize, stop using
          the Brain for private work and ask your installer to rotate the key and
          review access with you.
        </Note>
      </Section>

      <Section
        title="Signing out"
        blurb="Signing out never deletes anything. You come back in with your passkey."
      >
        <Row>
          <span className="min-w-0">
            <span className="text-[14.5px]">Sign out on this device</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              Your other devices and connected apps keep working.
            </span>
          </span>
          <Confirm
            label="Sign out"
            question="Sign out here?"
            tone="quiet"
            disabled={busy}
            onConfirm={() => run(async () => { await api("/api/app/signout"); location.reload(); })}
          />
        </Row>
        <Row>
          <span className="min-w-0">
            <span className="text-[14.5px]">Sign out everywhere</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              Ends every device's session and every AI connection above, in one
              move. Use this if a device is lost. It does not remove anything
              from your device list, does not disconnect a bank, and does not
              affect the operator key.
            </span>
          </span>
          <Confirm
            label="Sign out everywhere"
            question="Sign out everywhere, including AI?"
            disabled={busy}
            onConfirm={() => run(async () => { await api("/api/app/signout-all"); location.reload(); })}
          />
        </Row>
      </Section>
    </div>
  );
}
