import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, requestId } from "../lib/api";
import {
  humanMapWord, mapValue, validFinancialMapActivation, validFinancialMapOptions,
  validFinancialMapNoPending, validFinancialMapReview, type FinancialMapReview,
  type MapChange, type MapReviewField, type MapReviewGroup, type MapReviewYear,
  type MapUnresolvedItem,
} from "../lib/financial-map";
import {
  PasskeyCeremonyCancelledError, passkeysSupported, requestPasskeyAssertion,
} from "../lib/passkey";
import { Attention, Badge, Empty, TruthNote } from "./ui";

type PageState =
  | { kind: "loading" }
  | { kind: "ready"; review: FinancialMapReview }
  | { kind: "idle"; message: string }
  | { kind: "missing"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "stale"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "activated" };

type ActivationRequest = {
  review_id: string;
  request_id: string;
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
};

type ActivationAttempt = {
  reviewId: string;
  requestId: string;
  // This exact signed request is the only safe lost-response retry. It stays
  // in this component ref, is never rendered, and disappears with the page.
  activationBody?: ActivationRequest;
};

const ENTITY_FIELDS = ["kind", "status", "holds", "ownership", "tax_class", "relationship", "parent"];
const ACCOUNT_FIELDS = ["entity_assignment", "kind", "balance_role", "currency", "status"];

function responseMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && typeof error.body.detail === "string") return error.body.detail;
  return error instanceof Error ? error.message : fallback;
}

function failedState(error: unknown): PageState {
  if (error instanceof ApiError) {
    if (error.status === 404) return { kind: "missing", message: responseMessage(error, "No Financial Map is waiting for review.") };
    if (error.status === 410) return { kind: "expired", message: responseMessage(error, "This Financial Map review expired.") };
    if (error.status === 409) return { kind: "stale", message: responseMessage(error, "This Financial Map review is no longer current.") };
  }
  return {
    kind: "unavailable",
    message: responseMessage(error, "The complete Financial Map review could not be read. Nothing was treated as empty or confirmed."),
  };
}

function sameCounts(left: FinancialMapReview["counts"], right: FinancialMapReview["counts"]): boolean {
  return left.entities === right.entities && left.accounts === right.accounts &&
    left.entity_years === right.entity_years && left.filing_units === right.filing_units &&
    left.obligation_items === right.obligation_items;
}

export function FinancialMap() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [correctionRequested, setCorrectionRequested] = useState(false);
  const [ceremonyNote, setCeremonyNote] = useState<string | null>(null);
  const attempt = useRef<ActivationAttempt | null>(null);

  useEffect(() => {
    let current = true;
    api<unknown>("/api/owner/financial-map/review", {})
      .then((value) => {
        if (!current) return;
        if (validFinancialMapNoPending(value)) {
          setState({ kind: "idle", message: value.owner_message });
          return;
        }
        if (!validFinancialMapReview(value)) {
          setState({
            kind: "unavailable",
            message: "The Brain did not return one complete, privacy-safe Financial Map review. Nothing was confirmed.",
          });
          return;
        }
        setState({ kind: "ready", review: value });
      })
      .catch((error) => { if (current) setState(failedState(error)); });
    return () => { current = false; };
  }, []);

  const confirm = async (review: FinancialMapReview) => {
    setConfirming(true);
    setCeremonyNote(null);
    if (attempt.current?.reviewId !== review.review_id) {
      attempt.current = { reviewId: review.review_id, requestId: requestId("financial_map") };
    }
    let receiptVerified = false;
    try {
      let exactAttempt = attempt.current;
      if (!exactAttempt?.activationBody) {
        const options = await api<unknown>("/api/owner/financial-map/passkey/options", {
          review_id: review.review_id,
        });
        if (!validFinancialMapOptions(options) || options.expires_at <= Date.now()) {
          throw new Error("The Brain did not return a complete fresh passkey request. Nothing was confirmed.");
        }
        const assertion = await requestPasskeyAssertion(options, "confirm_map");
        exactAttempt = attempt.current;
        if (!exactAttempt || exactAttempt.reviewId !== review.review_id) {
          throw new Error("The confirmation attempt changed before it could be sent. Nothing was confirmed.");
        }
        exactAttempt.activationBody = {
          review_id: review.review_id,
          request_id: exactAttempt.requestId,
          ...assertion,
        };
      }
      // One owner click sends one request. If a response is lost after the
      // server commits, the next click reaches this same line with the exact
      // same signed body and no second WebAuthn ceremony.
      const receipt = await api<unknown>("/api/owner/financial-map/activate", exactAttempt.activationBody);
      if (!validFinancialMapActivation(receipt) || receipt.request_id !== exactAttempt.requestId ||
          receipt.map_hash !== review.map_hash || receipt.denominator_hash !== review.denominator_hash ||
          receipt.sequence !== review.expected_sequence ||
          receipt.population_state !== review.complete_preview.population_state ||
          receipt.tax_year_horizon.start !== review.complete_preview.tax_year_horizon.start ||
          receipt.tax_year_horizon.end !== review.complete_preview.tax_year_horizon.end ||
          !sameCounts(receipt.counts, review.counts)) {
        throw new Error("The activation receipt did not match the exact reviewed map. Do not assume the map was confirmed.");
      }
      receiptVerified = true;
      const active = await api<unknown>("/api/owner/financial-map/review", {});
      if (!validFinancialMapNoPending(active) || !active.active_map_present ||
          !active.active_map_authoritative || active.active_sequence !== receipt.sequence ||
          active.active_map_hash !== receipt.map_hash ||
          active.active_denominator_hash !== receipt.denominator_hash ||
          active.active_activated_at !== receipt.activated_at) {
        throw new Error("The Brain could not independently verify the confirmed map. Do not assume confirmation succeeded. Reload this page before taking another action.");
      }
      attempt.current = null;
      setState({ kind: "activated" });
    } catch (error) {
      if (error instanceof PasskeyCeremonyCancelledError) {
        setCeremonyNote(error.message);
      } else {
        const next = failedState(error);
        const conclusiveActivationRefusal = error instanceof ApiError && error.status >= 400 &&
          error.status < 500 && !receiptVerified;
        if (conclusiveActivationRefusal) attempt.current = null;
        if (["expired", "stale", "missing"].includes(next.kind) && !receiptVerified) {
          attempt.current = null;
          setState(next);
        } else if (attempt.current?.activationBody) {
          setCeremonyNote(
            `${next.message} The exact signed request is held only in this open page's memory. ` +
            "Choose Retry this exact confirmation to resend it once without opening another passkey window.",
          );
        } else {
          setCeremonyNote(next.message);
        }
      }
    } finally {
      setConfirming(false);
    }
  };

  if (state.kind === "loading") {
    return <PageShell><Empty>Reading the complete Financial Map review.</Empty></PageShell>;
  }
  if (state.kind === "missing") {
    return <PageShell><TruthNote>{state.message} Complete the guided interview in Claude Code or Codex, then return here.</TruthNote></PageShell>;
  }
  if (state.kind === "idle") {
    return <PageShell><TruthNote>{state.message}</TruthNote></PageShell>;
  }
  if (state.kind === "expired" || state.kind === "stale") {
    return <PageShell><Attention>{state.message} Complete a fresh guided interview before confirming a map.</Attention></PageShell>;
  }
  if (state.kind === "unavailable") {
    return <PageShell><Attention>{state.message}</Attention></PageShell>;
  }
  if (state.kind === "activated") {
    return (
      <PageShell>
        <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-5 text-emerald-950">
          <h2 className="text-lg font-semibold">Your Financial Map is confirmed</h2>
          <p className="mt-2 text-[14px] leading-relaxed">
            The Brain verified the exact map you reviewed as your owner-confirmed financial picture.
            No account, book, tax, payroll, source, or ledger record was changed.
          </p>
        </div>
      </PageShell>
    );
  }

  const { review } = state;
  return (
    <PageShell>
      <TruthNote>
        This is a review, not a change. It shows the complete map prepared during your guided interview,
        including what the Brain currently holds and anything that remains unknown or different.
      </TruthNote>

      <ReviewSummary review={review} />
      <PriorComparison review={review} />
      <FilingUnits review={review} />

      <ReviewSection title="Entities" intro="Every person, household, trust, business, property, and investment in this preview appears below.">
        {review.complete_preview.entities.length === 0 ? (
          <Empty>No entities are in this complete preview.</Empty>
        ) : review.complete_preview.entities.map((entity, index) => (
          <article key={`${entity.label}:${index}`} className="border-b border-line last:border-b-0 px-4 py-5 sm:px-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold text-[15.5px]">{entity.label}</h3>
                <p className="mt-1 text-[12.5px] text-ink-soft">
                  {entity.evidence_state === "linked_current_record"
                    ? "Linked to a current structured record"
                    : "Owner-declared, with no linked current structured record"}
                </p>
              </div>
              <Badge tone={entity.disposition === "included" ? "accent" : "muted"}>{humanMapWord(entity.disposition)}</Badge>
            </div>
            <FinancialMapFieldList fields={entity.fields} order={ENTITY_FIELDS} />
            <div className="mt-5 space-y-3">
              {entity.tax_years.map((year) => <YearReview key={year.tax_year} year={year} />)}
            </div>
          </article>
        ))}
      </ReviewSection>

      <ReviewSection title="Accounts" intro="Every expected account in this preview appears below, including accounts not yet present in current structured records.">
        {review.complete_preview.accounts.length === 0 ? (
          <Empty>No accounts are in this complete preview.</Empty>
        ) : review.complete_preview.accounts.map((account, index) => (
          <article key={`${account.label}:${index}`} className="border-b border-line last:border-b-0 px-4 py-5 sm:px-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold text-[15.5px]">{account.label}</h3>
                <p className="mt-1 text-[12.5px] text-ink-soft">
                  {account.evidence_state === "linked_current_record"
                    ? "Linked to a current structured record"
                    : "Owner-declared, with no linked current structured record"}
                </p>
              </div>
              <Badge tone={account.disposition === "included" ? "accent" : "muted"}>{humanMapWord(account.disposition)}</Badge>
            </div>
            <FinancialMapFieldList fields={account.fields} order={ACCOUNT_FIELDS} />
          </article>
        ))}
      </ReviewSection>

      <ReviewSection
        title={`Still unresolved (${review.unresolved_count})`}
        intro="These items stay visible in the confirmed map. Confirming a partial map does not turn an unknown answer into a known one."
      >
        {review.unresolved_items.length === 0 ? (
          <p className="px-4 py-5 text-[14px] text-emerald-800">No unresolved items are recorded in this preview.</p>
        ) : review.unresolved_items.map((item, index) => (
          <Unresolved key={`${item.kind}:${item.label || ""}:${item.tax_year || ""}:${index}`} item={item} />
        ))}
      </ReviewSection>

      <section className="mt-8 rounded-2xl border border-accent/25 bg-accent-soft px-5 py-5 sm:px-6">
        <p className="eyebrow">Your confirmation</p>
        <h2 className="mt-1.5 text-lg font-semibold">What the passkey window is doing</h2>
        <div className="mt-3 space-y-2 text-[14px] leading-relaxed text-ink-soft">
          <p>Your passkey confirms this exact reviewed map as the owner-approved financial picture used for future completeness checks.</p>
          <p>After you choose the button, your device opens its normal secure window. Follow it with Face ID, Touch ID, a fingerprint, security key, screen lock, or device PIN.</p>
          <p>Financial Brain cannot see or store your biometric data or device PIN. Your private passkey stays with your device or passkey provider.</p>
          <p>Choosing Cancel, closing the secure window, or letting it time out confirms nothing and changes nothing. You can return to this review while it remains current.</p>
          <p>A browser guide may open and scroll this page, but it must stop here. Only you choose whether to confirm.</p>
        </div>
        <FinancialMapCorrectionChoice
          requested={correctionRequested}
          confirmationInProgress={confirming}
          confirmationUnresolved={Boolean(attempt.current?.activationBody)}
          onRequest={() => {
            // This branch is deliberately local-only. A correction starts with
            // another complete preview; it never mutates or activates this one.
            if (confirming || attempt.current?.activationBody) return;
            attempt.current = null;
            setCeremonyNote(null);
            setCorrectionRequested(true);
          }}
          onContinue={() => setCorrectionRequested(false)}
        />
        {ceremonyNote && <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13.5px] text-amber-900">{ceremonyNote}</div>}
        <button
          type="button"
          disabled={correctionRequested || confirming || !passkeysSupported()}
          onClick={() => confirm(review)}
          className="mt-5 w-full sm:w-auto rounded-xl bg-accent px-5 py-3 text-[14px] font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-default disabled:opacity-55"
        >
          {correctionRequested ? "Create a fresh preview before confirming"
            : confirming ? "Waiting for your device"
            : attempt.current?.activationBody ? "Retry this exact confirmation"
              : "Confirm this Financial Map with my passkey"}
        </button>
        {!passkeysSupported() && (
          <p className="mt-3 text-[13px] text-amber-900">This browser cannot open a passkey window. Open your Brain directly in Safari or Chrome.</p>
        )}
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
          This review expires {new Date(review.expires_at).toLocaleString()}. No passkey window opens until you choose the button.
        </p>
      </section>
    </PageShell>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-4xl mx-auto">
      <p className="eyebrow">Owner review</p>
      <h1 className="page-title">Financial Map</h1>
      <p className="page-intro">
        Review the entities, accounts, filing responsibilities, books, payroll, and expected sources that define your complete financial picture.
      </p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function PriorComparison({ review }: { review: FinancialMapReview }) {
  const comparison = review.prior_comparison;
  if (comparison.state === "no_prior_confirmed_map") {
    return (
      <ReviewSection
        title="Changes from your last confirmed map"
        intro="This is your first owner-confirmed Financial Map, so there is no earlier map to compare."
      >
        <Empty>No earlier confirmed map exists.</Empty>
      </ReviewSection>
    );
  }
  return (
    <ReviewSection
      title={`Changes from your last confirmed map (${comparison.change_count})`}
      intro="Every recorded difference from the last owner-confirmed map appears here. The complete current map follows below."
    >
      {comparison.changes.length === 0 ? (
        <p className="px-4 py-5 text-[14px] text-emerald-800">No recorded field or map entry changed.</p>
      ) : comparison.changes.map((change, index) => (
        <MapChangeRow key={`${change.area}:${change.subject}:${change.field}:${change.tax_year || ""}:${index}`} change={change} />
      ))}
    </ReviewSection>
  );
}

function MapChangeRow({ change }: { change: MapChange }) {
  return (
    <div className="border-b border-line last:border-b-0 px-4 py-4 sm:px-5">
      <p className="text-[12px] font-medium uppercase tracking-wide text-ink-soft">
        {change.area}{change.tax_year ? ` · Tax year ${change.tax_year}` : ""}
      </p>
      <p className="mt-1 text-[14px] font-semibold break-words">{change.subject}: {change.field}</p>
      <div className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
        <p className="min-w-0 break-words"><span className="text-ink-soft">Before: </span>{change.before ?? "Not previously listed"}</p>
        <p className="min-w-0 break-words"><span className="text-ink-soft">Now: </span>{change.after ?? "No longer listed"}</p>
      </div>
    </div>
  );
}

function ReviewSummary({ review }: { review: FinancialMapReview }) {
  const preview = review.complete_preview;
  const population = preview.population_state === "owner_asserted_complete" ? "Owner says complete"
    : preview.population_state === "known_partial" ? "Known to be partial" : "Completeness is unknown";
  return (
    <section aria-labelledby="map-summary" className="rounded-2xl border border-line bg-card overflow-hidden">
      <div className="px-4 py-4 sm:px-5 border-b border-line">
        <h2 id="map-summary" className="text-[15px] font-semibold">Review summary</h2>
        <p className="mt-1 text-[13.5px] text-ink-soft">
          Tax years {preview.tax_year_horizon.start} through {preview.tax_year_horizon.end}. {population}.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5">
        <Count label="Entities" value={review.counts.entities} />
        <Count label="Accounts" value={review.counts.accounts} />
        <Count label="Entity-years" value={review.counts.entity_years} />
        <Count label="Filing units" value={review.counts.filing_units} />
        <Count label="Yearly items" value={review.counts.obligation_items} />
      </div>
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-3 border-r border-b border-line last:border-r-0 sm:border-b-0">
      <span className="block text-xl font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="block mt-0.5 text-[12px] text-ink-soft">{label}</span>
    </div>
  );
}

function FilingUnits({ review }: { review: FinancialMapReview }) {
  return (
    <ReviewSection title="Filing units" intro="The people or groups that tax returns and filing responsibilities are organized around.">
      {review.complete_preview.filing_units.length === 0 ? <Empty>No filing units are in this complete preview.</Empty>
        : review.complete_preview.filing_units.map((unit, index) => (
          <div key={`${unit.label}:${index}`} className="px-4 py-3.5 border-b border-line last:border-b-0 flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium">{unit.label}</span>
            <Assessment value={unit.assessment} />
          </div>
        ))}
    </ReviewSection>
  );
}

function ReviewSection({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 text-[13.5px] text-ink-soft leading-relaxed">{intro}</p>
      <div className="mt-3 rounded-2xl border border-line bg-card overflow-hidden">{children}</div>
    </section>
  );
}

export function FinancialMapFieldList({ fields, order }: { fields: Record<string, MapReviewField>; order: string[] }) {
  return (
    <div aria-label="Financial Map field comparison" className="mt-4 rounded-xl border border-line overflow-hidden">
      {order.map((field) => {
        const answer = fields[field];
        if (!answer) return null;
        return (
          <div
            key={field}
            role="group"
            aria-label={`${humanMapWord(field)} comparison`}
            className="grid gap-3 px-3 py-3 border-b border-line last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start"
          >
            <span className="text-[12.5px] font-semibold text-ink-soft">{humanMapWord(field)}</span>
            <Value label="Owner answer" value={mapValue(field, answer.owner_value)} />
            <Value label="Current record" value={mapValue(field, answer.current_value)} />
            <LabeledComparison value={answer.comparison} assessment={answer.assessment} />
          </div>
        );
      })}
    </div>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{label}</span>
      <span className="mt-0.5 block text-[13.5px] break-words">{value}</span>
    </span>
  );
}

function LabeledComparison({ value, assessment }: { value: MapReviewField["comparison"]; assessment: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Comparison</span>
      <span className="mt-1 block"><Comparison value={value} assessment={assessment} /></span>
    </span>
  );
}

export function FinancialMapCorrectionChoice({
  requested, confirmationInProgress, confirmationUnresolved, onRequest, onContinue,
}: {
  requested: boolean;
  confirmationInProgress: boolean;
  confirmationUnresolved: boolean;
  onRequest: () => void;
  onContinue: () => void;
}) {
  if (requested) {
    return (
      <div role="status" className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-amber-950">
        <h3 className="text-[14px] font-semibold">Stop here and correct the preview</h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed">
          Return to the Claude Code or Codex conversation that prepared this Financial Map. Explain what is wrong and ask it to create a complete fresh preview, then reload this page.
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed">
          This choice did not activate or change anything, and no passkey window opened.
        </p>
        <button
          type="button"
          onClick={onContinue}
          className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-2 text-[13px] font-semibold text-amber-950 hover:bg-amber-100"
        >
          Keep reviewing this preview
        </button>
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-line bg-card px-4 py-4">
      <h3 className="text-[14px] font-semibold">Something is wrong?</h3>
      <p id="financial-map-correction-help" className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft">
        Do not confirm this version. Choose the correction option, return to your guided interview, and ask for a complete fresh preview.
      </p>
      <button
        type="button"
        aria-describedby="financial-map-correction-help"
        disabled={confirmationInProgress || confirmationUnresolved}
        onClick={onRequest}
        className="mt-3 rounded-lg border border-line-strong bg-paper px-3 py-2 text-[13px] font-semibold text-ink hover:bg-card disabled:cursor-default disabled:opacity-55"
      >
        Something is wrong
      </button>
      {confirmationInProgress ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">
          Finish or cancel the device confirmation before choosing a different path.
        </p>
      ) : confirmationUnresolved && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">
          The earlier confirmation response is unresolved. Retry that exact confirmation first so this page can verify whether the Brain already accepted it.
        </p>
      )}
    </div>
  );
}

function Comparison({ value, assessment }: { value: MapReviewField["comparison"]; assessment: string }) {
  if (assessment !== "confirmed") return <Assessment value={assessment} />;
  if (value === "matches_current") return <Badge tone="accent">Matches current</Badge>;
  if (value === "differs_from_current") return <Badge tone="warn">Different</Badge>;
  return <Badge tone="muted">Not compared</Badge>;
}

function Assessment({ value }: { value: string }) {
  return <Badge tone={value === "confirmed" ? "accent" : value === "unknown" || value === "unavailable" ? "warn" : "muted"}>{humanMapWord(value)}</Badge>;
}

function YearReview({ year }: { year: MapReviewYear }) {
  return (
    <section className="rounded-xl border border-line bg-paper/55 px-3 py-3.5 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[14px] font-semibold">Tax year {year.tax_year}</h4>
        <Badge tone={year.state === "included" ? "accent" : "muted"}>{humanMapWord(year.state)}</Badge>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <YearItem title="Filing units" assessment={year.filing_units.assessment} labels={year.filing_units.labels} />
        <Group title="Required returns" group={year.required_returns} />
        <Group title="Required forms" group={year.required_forms} />
        <Group title="K-1 roles" group={year.k1_roles} />
        <YearItem
          title="Books"
          assessment={year.books.assessment}
          labels={year.books.bookkeeping_company ? [year.books.bookkeeping_company.label] : []}
        />
        <YearItem title="Payroll" assessment={year.payroll.assessment} labels={[]} />
        <Group title="Expected sources" group={year.expected_sources} />
      </div>
    </section>
  );
}

function Group({ title, group }: { title: string; group: MapReviewGroup }) {
  return <YearItem title={title} assessment={group.assessment} labels={group.items.map((item) => item.label)} />;
}

function YearItem({ title, assessment, labels }: { title: string; assessment: string; labels: string[] }) {
  return (
    <div className="rounded-lg bg-card border border-line px-3 py-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium">{title}</span>
        <Assessment value={assessment} />
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft break-words">
        {labels.length ? labels.join(", ") : "No individual items are listed in this preview."}
      </p>
    </div>
  );
}

function Unresolved({ item }: { item: MapUnresolvedItem }) {
  const parts = [item.label, item.item_label, item.tax_year ? `Tax year ${item.tax_year}` : null,
    item.field ? humanMapWord(item.field) : null].filter(Boolean);
  return (
    <div className="px-4 py-3.5 border-b border-line last:border-b-0 flex items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium break-words">{parts.join(" · ") || humanMapWord(item.kind)}</span>
        {item.message && <span className="block mt-1 text-[12.5px] leading-relaxed text-ink-soft">{item.message}</span>}
      </span>
      <Assessment value={item.state} />
    </div>
  );
}
