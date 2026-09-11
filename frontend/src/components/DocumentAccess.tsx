import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, ownerError, type DocumentAccessStatus, type DocumentGrant, type DocumentGrantReceipt,
  type EntityScopeEcho,
} from "../lib/api";
import { entityLabel } from "../lib/finance";
import { sourceLabel } from "../lib/words";
import { retrievalUnavailable, unavailableNotice } from "../lib/retrieval-status.js";
import { Attention, Badge, Confirm, Empty, Note, Row, Section, TruthNote, ago } from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { useActionRequests } from "./useActionRequests";

type SearchHit = {
  doc_uid?: string;
  title?: string | null;
  source?: string;
  source_kind?: string | null;
  ts?: string | null;
};
type SearchResponse = {
  results?: SearchHit[];
  status?: string;
  degraded?: string;
  entity_scope?: EntityScopeEcho;
  filter_not_applied?: boolean;
};

type ActionRequests = ReturnType<typeof useActionRequests>;
type ActionLock = {
  busy: boolean;
  begin: () => number | null;
  finish: (operation: number) => void;
};

export function DocumentAccess() {
  const { scope, activeLabel, entities } = useFinanceScope();
  const [status, setStatus] = useState<DocumentAccessStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [invite, setInvite] = useState<DocumentGrantReceipt | null>(null);
  const inviteRevision = useRef(0);
  const actionSequence = useRef(0);
  const activeAction = useRef<number | null>(null);
  const requests = useActionRequests("document_access");

  const clearInvite = useCallback(() => {
    inviteRevision.current += 1;
    setInvite(null);
    setMessage(null);
    setActionError(null);
  }, []);
  const publishInvite = useCallback((receipt: DocumentGrantReceipt) => {
    inviteRevision.current += 1;
    setInvite(receipt);
  }, []);
  const beginAction = useCallback(() => {
    if (activeAction.current !== null) return null;
    const operation = ++actionSequence.current;
    activeAction.current = operation;
    setBusy(true);
    return operation;
  }, []);
  const finishAction = useCallback((operation: number) => {
    if (activeAction.current !== operation) return;
    activeAction.current = null;
    setBusy(false);
  }, []);

  const load = useCallback(async () => {
    setStatusError(null);
    try {
      const next = await api<DocumentAccessStatus>("/api/app/document-access/status", {});
      if (next.status !== "ready" || next.scope_rule !== "exact_document_ids_only" || next.default_access !== "owner_only" || !Array.isArray(next.grants)) {
        throw new Error("Document access status did not return the enforced exact-document policy.");
      }
      setStatus(next);
    } catch (next) {
      setStatus(null);
      setStatusError(ownerError(next).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    clearInvite();
  }, [clearInvite, scope]);

  async function reissue(grant: DocumentGrant) {
    const actionKey = `reissue:${grant.grant_id}`;
    const requestId = requests.forAction(actionKey);
    await runAction(async () => {
      const receipt = await api<DocumentGrantReceipt>("/api/app/document-access/reissue", { request_id: requestId, grant_id: grant.grant_id });
      if (receipt.status !== "active" || receipt.grant_id !== grant.grant_id || receipt.invite_state !== "active"
        || !receipt.enrollment_url || typeof receipt.replayed !== "boolean") {
        throw new Error("The brain did not confirm a new active enrollment link.");
      }
      requests.confirmed(actionKey);
      // The Worker receipt binds the immutable grant id. Retain the matching
      // labeled history row so a late global reissue can never look like a
      // link for the mutable new-grant editor.
      publishInvite({
        ...receipt,
        subject_label: grant.subject_label,
        entity_slug: grant.entity_slug,
      });
      setMessage(receipt.replayed
        ? "The same reissue receipt was returned. No additional enrollment link was created."
        : "The earlier unused link is no longer usable. Copy the newly issued private link before it expires.");
    });
  }

  async function revoke(grantId: string) {
    const actionKey = `revoke:${grantId}`;
    const requestId = requests.forAction(actionKey);
    await runAction(async () => {
      const receipt = await api<DocumentGrantReceipt>("/api/app/document-access/revoke", { request_id: requestId, grant_id: grantId });
      if (receipt.status !== "revoked" || receipt.grant_id !== grantId
        || typeof receipt.changed !== "boolean" || typeof receipt.replayed !== "boolean") {
        throw new Error("The brain did not return a confirmed revocation receipt.");
      }
      requests.confirmed(actionKey);
      clearInvite();
      setMessage(receipt.changed
        ? "Document access was revoked. Its passkey session can no longer read or ask."
        : "The brain confirmed this document access was already revoked.");
      await load();
    });
  }

  async function runAction(work: () => Promise<void>) {
    const operation = beginAction();
    if (operation === null) return;
    clearInvite();
    setActionError(null);
    setMessage(null);
    try { await work(); }
    catch (next) { setActionError(ownerError(next).message); }
    finally { finishAction(operation); }
  }

  async function copyInvite() {
    if (!invite?.enrollment_url) return;
    const current = invite;
    const revision = inviteRevision.current;
    const recipient = current.subject_label || "the intended person";
    const scopeLabel = entityLabel(entities, current.entity_slug);
    try {
      await navigator.clipboard.writeText(current.enrollment_url!);
      if (revision !== inviteRevision.current) return;
      setMessage(`Private enrollment link for ${recipient} in ${scopeLabel} copied. Send it only to the intended person before it expires.`);
    } catch {
      if (revision === inviteRevision.current) {
        setActionError("The browser could not copy the private link. Reissue it from a browser that permits clipboard access.");
      }
    }
  }

  const activeGrants = useMemo(() => status?.grants || [], [status]);
  return (
    <Section
      title="Shared document access"
      blurb="Create and revoke access to exact documents. A financial-entity selection narrows discovery, but it never grants the whole entity."
    >
      <div className="p-4 border-b border-line"><FinanceScopeBar requireEntity /></div>
      <ScopedGrantEditor
        key={scope === null ? "no-scope" : `entity:${scope}`}
        scope={scope}
        activeLabel={activeLabel}
        requests={requests}
        actionLock={{ busy, begin: beginAction, finish: finishAction }}
        clearInvite={clearInvite}
        publishInvite={publishInvite}
        onConfirmed={load}
      />
      {actionError && <div className="p-4 border-b border-line"><Attention>{actionError}</Attention></div>}
      {message && <Note>{message}</Note>}
      {invite?.enrollment_url && invite.invite_state === "active" && (
        <div className="p-4 border-b border-line flex items-center gap-3 flex-wrap">
          <button className="rounded-xl bg-accent px-4 py-2.5 text-white text-[13.5px]" onClick={copyInvite}>Copy private enrollment link</button>
          <span className="text-[12.5px] text-ink-soft">
            For {invite.subject_label || "the intended person"} · {entityLabel(entities, invite.entity_slug)}. {inviteExpiry(invite.enrollment_expires_at)} The link itself is hidden from the page.
          </span>
        </div>
      )}
      {statusError && <Attention>{statusError}</Attention>}
      {!status && !statusError && <Empty>Reading document access status.</Empty>}
      {status && activeGrants.length === 0 && <Empty>No document access has been created.</Empty>}
      {activeGrants.map((grant) => (
        <Row key={grant.grant_id}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 flex-wrap text-[14.5px] font-medium">
              {grant.subject_label}
              <Badge tone={grant.state === "active" ? "accent" : "muted"}>{grant.state}</Badge>
            </span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {grant.documents.filter((document) => !document.revoked_at).length} exact {grant.documents.filter((document) => !document.revoked_at).length === 1 ? "document" : "documents"} · {entityLabel(entities, grant.entity_slug)} · created {ago(grant.created_at)}
            </span>
          </span>
          {grant.state === "active" && (
            <span className="min-w-0 sm:max-w-md sm:text-right">
              <span className="flex items-center gap-2 sm:justify-end">
                <Confirm
                  label="New link"
                  question="Replace any earlier unused link with a new one?"
                  tone="quiet"
                  disabled={busy}
                  onConfirm={() => reissue(grant)}
                />
                <Confirm
                  label="Revoke"
                  question="End this person's access now? Their current passkey session will stop working."
                  disabled={busy}
                  onConfirm={() => revoke(grant.grant_id)}
                />
              </span>
              <span className="block mt-1 text-[12px] leading-relaxed text-ink-soft">
                New link replaces any earlier unused link. Revoke ends this person's document access and current passkey session.
              </span>
            </span>
          )}
        </Row>
      ))}
    </Section>
  );
}

function ScopedGrantEditor({
  scope, activeLabel, requests, actionLock, clearInvite, publishInvite, onConfirmed,
}: {
  scope: string | null;
  activeLabel: string;
  requests: ActionRequests;
  actionLock: ActionLock;
  clearInvite: () => void;
  publishInvite: (receipt: DocumentGrantReceipt) => void;
  onConfirmed: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = useRef(true);
  const draftRevision = useRef(0);
  const searchOperation = useRef(0);
  const createOperation = useRef(0);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      searchOperation.current += 1;
      createOperation.current += 1;
    };
  }, []);

  async function search() {
    const q = query.trim();
    if (!q || !scope || searching) return;
    const operation = ++searchOperation.current;
    setSearching(true);
    setActionError(null);
    setMessage(null);
    try {
      const body = await api<SearchResponse>("/api/rag/unified", { q, limit: 25, entity_slug: scope });
      if (!active.current || operation !== searchOperation.current) return;
      if (retrievalUnavailable(body)) {
        setHits(null);
        setActionError(unavailableNotice(body.degraded));
      } else if (body.filter_not_applied || body.entity_scope?.applied !== true || body.entity_scope.entity_slug !== scope) {
        setHits(null);
        setActionError(`The brain could not prove this search was narrowed to ${activeLabel}. No documents are available to select.`);
      } else {
        const byDocument = new Map<string, SearchHit>();
        for (const hit of body.results || []) {
          if (hit.doc_uid && !byDocument.has(hit.doc_uid)) byDocument.set(hit.doc_uid, hit);
        }
        setHits([...byDocument.values()]);
      }
    } catch (next) {
      if (active.current && operation === searchOperation.current) {
        setHits(null);
        setActionError(ownerError(next).message);
      }
    } finally {
      if (active.current && operation === searchOperation.current) setSearching(false);
    }
  }

  function updateSubject(next: string) {
    draftRevision.current += 1;
    setSubject(next);
    clearInvite();
    setMessage(null);
    setActionError(null);
  }

  function toggle(documentId: string) {
    draftRevision.current += 1;
    setSelected((current) => current.includes(documentId)
      ? current.filter((item) => item !== documentId)
      : [...current, documentId]);
    clearInvite();
    setMessage(null);
    setActionError(null);
  }

  async function create() {
    const label = subject.trim();
    if (!scope || !label || selected.length === 0 || actionLock.busy) return;
    const lockOperation = actionLock.begin();
    if (lockOperation === null) return;
    const documents = [...selected].sort();
    const actionKey = `create:${scope}:${label}:${documents.join("|")}`;
    const requestId = requests.forAction(actionKey);
    const revision = draftRevision.current;
    const operation = ++createOperation.current;
    clearInvite();
    setActionError(null);
    setMessage(null);
    try {
      const receipt = await api<DocumentGrantReceipt>("/api/app/document-access/create", {
        request_id: requestId,
        subject_label: label,
        entity_slug: scope,
        document_ids: documents,
      });
      if (receipt.status !== "active" || receipt.scope_rule !== "exact_document_ids_only"
        || receipt.entity_slug !== scope || receipt.subject_label !== label
        || !sameIds(receipt.document_ids, documents) || typeof receipt.replayed !== "boolean"
        || receipt.invite_state !== "active" || !receipt.enrollment_url) {
        throw new Error("The brain did not return a confirmed exact-document access receipt. No access link is being presented.");
      }
      // The server may have committed before the owner changed this editor.
      // Retire the retry key and refresh labeled history even when the private
      // link is no longer safe to publish in the current draft.
      requests.confirmed(actionKey);
      await onConfirmed();
      if (!active.current || operation !== createOperation.current
        || revision !== draftRevision.current) return;
      publishInvite(receipt);
      setMessage(receipt.replayed
        ? "This exact access request was already created. The same active receipt was returned without a second grant."
        : "Exact document access was created. Copy the private enrollment link before it expires.");
    } catch (next) {
      if (active.current && operation === createOperation.current
        && revision === draftRevision.current) {
        setActionError(ownerError(next).message);
      }
    } finally {
      // Busy represents this network operation, while invite/error publication
      // also requires the original editor revision to remain current.
      actionLock.finish(lockOperation);
    }
  }

  return (
    <div className="p-4 border-b border-line">
      <TruthNote>Documents are owner-only by default. Every grant is an immutable exact-document allowlist enforced by the brain.</TruthNote>
      {!scope && <Attention>Select one part of your finances before finding documents to share.</Attention>}
      <label className="block text-[12.5px] text-ink-soft">Who is this for?
        <input className="field mt-1" value={subject} maxLength={120} onChange={(event) => updateSubject(event.target.value)} placeholder="Accountant, attorney, reviewer" />
      </label>
      <div className="mt-3 flex gap-2">
        <input
          className="field flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void search()}
          placeholder="Find evidence to share"
          aria-label="Find evidence to share"
          disabled={!scope || searching}
        />
        <button className="rounded-xl bg-accent px-4 text-white text-[13.5px] disabled:opacity-45" onClick={search} disabled={!scope || !query.trim() || searching}>
          {searching ? "Looking" : "Find"}
        </button>
      </div>
      {hits?.length === 0 && <p className="mt-3 text-[13px] text-ink-soft">No matching document was returned. Search did complete, but that does not prove the document does not exist.</p>}
      {!!hits?.length && (
        <div className="mt-3 border border-line rounded-xl overflow-hidden">
          {hits.map((hit) => (
            <label key={hit.doc_uid} className="px-3 py-3 border-b border-line last:border-0 flex gap-3 items-start cursor-pointer">
              <input type="checkbox" className="mt-1" checked={selected.includes(hit.doc_uid!)} onChange={() => toggle(hit.doc_uid!)} />
              <span className="min-w-0">
                <span className="block text-[14px] font-medium">{hit.title || "Untitled document"}</span>
                <span className="block text-[12.5px] text-ink-soft">{sourceLabel(hit.source || "unknown", hit.source_kind)}{hit.ts ? ` · ${String(hit.ts).slice(0, 10)}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {selected.length > 0 && <p className="mt-3 text-[13px] text-ink-soft">{selected.length} exact {selected.length === 1 ? "document" : "documents"} selected.</p>}
      {actionError && <div className="mt-3"><Attention>{actionError}</Attention></div>}
      {message && <div className="mt-3"><Note>{message}</Note></div>}
      <button
        className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-white text-[13.5px] disabled:opacity-45"
        onClick={create}
        disabled={actionLock.busy || !scope || !subject.trim() || selected.length === 0 || selected.length > 100}
      >
        {actionLock.busy ? "Saving" : "Create exact document access"}
      </button>
    </div>
  );
}

function sameIds(actual: string[] | undefined, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((item, index) => item === expected[index]);
}

function inviteExpiry(expiresAt: number | undefined): string {
  if (!expiresAt) return "This link expires soon.";
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  return minutes > 0 ? `This link expires in about ${minutes} minutes.` : "This link has reached its expiry time.";
}
