import { useEffect, useState } from "react";
import { ApiError, api, type PasskeyStatus } from "../lib/api";
import { humanSecurityCode } from "../lib/security";
import { Attention, Badge, Empty, Note, Row, Section, ago } from "./ui";

export function PasskeyDiagnostics() {
  const [status, setStatus] = useState<PasskeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api<PasskeyStatus>("/api/app/passkeys/status", {})
      .then((next) => {
        if (!current) return;
        if (next.status !== "ready" || !next.proof || !Array.isArray(next.ceremonies)) {
          setError("The Brain did not return complete passkey check results.");
          return;
        }
        setStatus(next);
      })
      .catch((next) => {
        if (!current) return;
        setError(next instanceof ApiError && next.status === 503
          ? "Passkey checks are unavailable right now. The passkey list above still shows which passkeys the Brain will accept."
          : "The Brain could not read its passkey checks.");
      });
    return () => { current = false; };
  }, []);

  return (
    <Section
      title="Passkey checks"
      blurb="These checks show whether passkeys are set up, whether a practice check worked, and whether someone independently tested the live Brain. A practice result is not a live result."
    >
      {error && <Attention>{error}</Attention>}
      {!status && !error && <Empty>Reading privacy-safe passkey checks.</Empty>}
      {status && <PasskeyStatusDetails status={status} />}
    </Section>
  );
}

export function PasskeyStatusDetails({ status }: { status: PasskeyStatus }) {
  return (
    <>
      <div className="grid sm:grid-cols-3 border-b border-line">
        <Proof
          label="Brain setup"
          value={status.proof.configured}
          positive="Ready"
          negative="Needs attention"
          detail="The Brain has the settings needed to use passkeys."
        />
        <Proof
          label="Practice check"
          value={status.proof.locally_verified}
          positive="A local check worked"
          negative="No local check yet"
          detail="A privacy-safe result shows whether passkey setup worked in a practice environment."
        />
        <Proof
          label="Your live Brain"
          value={status.proof.live_proven}
          positive="A live check worked"
          negative="Not checked live yet"
          detail="This requires an independent check at your Brain's normal web address."
        />
      </div>
      <Note>
        Passkeys are tied to this web address: {status.rp_id}. {status.devices.owner} owner {status.devices.owner === 1 ? "passkey" : "passkeys"} and {status.devices.grant} shared-document {status.devices.grant === 1 ? "passkey" : "passkeys"} are recorded.
      </Note>
      {status.ceremonies.length === 0 ? (
        <Empty>No privacy-safe passkey result is recorded yet.</Empty>
      ) : status.ceremonies.map((event, index) => (
        <Row key={`${event.ceremony}:${event.stage}:${event.outcome}:${index}`}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 flex-wrap text-[14px]">
              {humanSecurityCode(event.ceremony)} · {humanSecurityCode(event.stage)}
              <Badge tone={event.outcome === "succeeded" ? "accent" : "warn"}>{humanSecurityCode(event.outcome)}</Badge>
            </span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {event.count} recorded {event.count === 1 ? "result" : "results"}
              {event.last_at ? ` · latest ${ago(event.last_at)}` : ""}
            </span>
          </span>
        </Row>
      ))}
      <Note>{status.privacy}</Note>
    </>
  );
}

function Proof({ label, value, positive, negative, detail }: {
  label: string;
  value: boolean;
  positive: string;
  negative: string;
  detail: string;
}) {
  return (
    <div className="p-4 border-b sm:border-b-0 sm:border-r border-line last:border-0">
      <p className="text-[13px] font-medium">{label}</p>
      <p className={`mt-1 text-[13.5px] font-semibold ${value ? "text-emerald-700" : "text-amber-800"}`}>
        {value ? positive : negative}
      </p>
      <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">{detail}</p>
    </div>
  );
}
