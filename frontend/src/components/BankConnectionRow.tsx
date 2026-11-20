import type { BankConnection } from "../lib/api";
import type { OutcomeKey } from "../lib/outcome";
import { Chip, Confirm, Row, agoISO } from "./ui";

export const DISCONNECT_BANK_QUESTION = "Disconnect this bank? New transactions stop. Your saved history stays.";
export const BANK_BUTTON = "inline-flex min-h-11 max-w-full items-center justify-center rounded-[10px] border px-4 py-2 text-[15px] font-semibold leading-snug text-center";

// The health service still owns every state and word. Format its joined text
// only here, so a raw timestamp or repeated sentence cannot crowd the row.
function localDates(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, (iso) => {
    const stamp = new Date(iso);
    return Number.isFinite(stamp.getTime())
      ? stamp.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : "an unknown time";
  });
}

export function BankConnectionRow({ bank, outcome, attention, busy, rehearsal, onDisconnect }: {
  bank: BankConnection;
  outcome: OutcomeKey;
  attention: boolean;
  busy: boolean;
  rehearsal: boolean;
  onDisconnect: (itemRef: string) => void;
}) {
  const needsSignin = bank.health?.needs_sign_in || ['reauth_required', 'permission_revoked'].includes(bank.status);
  const needsReplacement = bank.health?.needs_reconnect || bank.replacement_ref;
  const ownerCount = bank.accounts_needing_owner || 0;
  const ownerLine = `${ownerCount} ${ownerCount === 1 ? "account needs" : "accounts need"} an owner.`;
  const source = localDates(bank.status_line || bank.status_detail || "This connection stopped working.");
  const first = source.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() || source;
  const line = outcome === "WORKING"
    ? "Loading your transactions. Answers about money won't include this bank until loading finishes."
    : outcome === "NEEDS"
    ? ownerLine
    : outcome === "CURRENT"
    ? (bank.last_synced_at ? `Last checked ${agoISO(bank.last_synced_at)}` : "Bank connection is up to date.")
    : needsSignin ? "Your bank needs you to sign in again." : first;
  const detail = localDates(bank.status_detail || "");
  // Keep a provider explanation even when the sign-in sentence takes priority.
  // A legacy status_detail may already be part of the joined status_line.
  const extra = outcome === "PROBLEM" ? [
    source.startsWith(line) ? source.slice(line.length).trim() : source,
    detail && detail !== line && !source.includes(detail) ? detail : "",
  ].filter(Boolean).join(" ") : "";
  const code = bank.health?.last_error_code || (needsSignin ? "ITEM_LOGIN_REQUIRED" : needsReplacement ? "BANK_ACCESS_REFERENCE_UNREADABLE" : "BANK_SYNC_FAILED");
  const problemMeaning = "Answers about money are missing anything that has happened here since the last complete bank sync.";

  return (
    <Row>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium">
          <span className="min-w-0 break-words">{bank.institution_label || "a bank"}</span>
          <Chip state={outcome} />
        </div>
        <p className="mt-1 break-words text-[14px] leading-relaxed text-ink-soft">{line}</p>
        {/* A failure can take chip priority without resolving the owner's other task. */}
        {ownerCount > 0 && outcome !== "NEEDS" && (
          <p className="mt-1 break-words text-[14px] leading-relaxed text-ink-soft">{ownerLine}</p>
        )}
        {outcome === "PROBLEM" && (
          <details className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
            <summary className="min-h-11 cursor-pointer content-center break-words">Code {code} · What this means</summary>
            <p className="max-w-[42rem] pb-2">{problemMeaning}</p>
          </details>
        )}
        {extra && (
          <details className="text-[12.5px] leading-relaxed text-ink-soft">
            <summary className="min-h-11 cursor-pointer content-center">Details</summary>
            <p className="max-w-[42rem] break-words pb-2">{extra}</p>
          </details>
        )}
        {rehearsal && ownerCount > 0 && (
          <p className="mt-1 text-[14px] text-ink-soft">Choose owners on your Brain's Connect a bank page.</p>
        )}
      </div>
      <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
        {needsReplacement && !rehearsal ? (
          <a className={`${BANK_BUTTON} border-accent bg-accent text-white`} href={`/app/connect/bank?mode=replace&item_ref=${encodeURIComponent(bank.item_ref)}${bank.replacement_ref ? '&operation_ref=' + encodeURIComponent(bank.replacement_ref) : ''}`}>
            {bank.replacement_ref ? 'Continue recovery' : 'Replace unreadable connection'}
          </a>
        ) : bank.status !== "removed" && needsSignin ? (
          rehearsal ? <span className="text-sm text-ink-soft" aria-disabled="true">Repair unavailable in rehearsal</span> : (
            <a className={`${BANK_BUTTON} border-accent bg-accent text-white`} href={`/app/connect/bank?mode=reauthorise&item_ref=${encodeURIComponent(bank.item_ref)}`}>
              Repair connection
            </a>
          )
        ) : ownerCount > 0 && !rehearsal ? (
          <a className={`${BANK_BUTTON} border-accent bg-accent text-white`} href="/app/connect/bank#accounts">Choose owners</a>
        ) : null}
        {!bank.replacement_ref && !bank.health?.needs_reconnect && !attention && <Confirm
          label="Disconnect"
          question={DISCONNECT_BANK_QUESTION}
          disabled={busy}
          onConfirm={() => onDisconnect(bank.item_ref)}
        />}
      </div>
    </Row>
  );
}
