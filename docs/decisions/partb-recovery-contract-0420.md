# Part B interrupted answer-setup contract

- Status: Accepted fail-closed fallback for 0.4.20
- Date: 2026-10-25
- Owners: Product and engineering
- Confidence: High for the sealed local evidence and refusal behavior
- Supersedes: The proposed automatic recovery contract dated 2026-10-24

## Decision

An answer setup left with a current schema-2 journal has no automatic recovery
action. The CLI classifies the local evidence without changing it, prints a
fixed content-free card, and exits nonzero.

The same rule applies when a command includes `--recover` or
`--confirm-recovery`. Those arguments do not authorize rollback, secret
deletion, deployment, schedule changes, or cleanup. There is no confirmation
identifier and no HMAC confirmation verifier.

This decision is intentionally narrower than the ordinary transaction path.
During the process that starts answer setup, the existing catch path can still
restore a manifest publication that the same process just made. This record
governs only a later command that encounters an interrupted transaction.

Version 0.4.20 supports only the first Claude answer connection from built-in
models. If either current answer model already selects Claude, every mode that
would bring in a new key refuses before setup work; `--keep-key` remains
available. Key replacement is deferred to a later release.

## Owner-facing result

The non-JSON result contains only the proved classification and these fixed
lines:

```text
Recovery state: <original|changed|ambiguous>
Answer setup was interrupted.
Nothing more will run automatically.
Your Brain keeps working as before.
Contact your Financial Brain partner.
```

No path, file name, manifest content, secret state, exception text, or provider
response is included. A boundary exception maps to `ambiguous` and the same
card. JSON mode returns a closed error object with `automatic_action` set to
`none`.

## Ordering and authority

Recovery arguments are recognized before manifest control. For an interrupted
setup, local classification also runs before manifest control. This ordering is
part of the security boundary:

1. Recognize a recovery request or a current schema-2 journal.
2. Read and validate only the local journal, manifest, and owned stage proofs.
3. Optionally inspect the secret-name inventory through an injected read-only
   boundary.
4. Map every read or validation exception to `ambiguous`.
5. Return the fixed card and a nonzero exit.

Malformed recovery arguments and an unreadable or malformed manifest do not
permit manifest-bound credential control. A recovery request reaches the same
closed result even when its action or confirmation value is invalid.

## Journal contract

The journal remains schema version 2 and uses closed validation. Unknown,
missing, mistyped, contradictory, or incomplete members make the classification
`ambiguous`. The journal binds:

- the operation and operation identifier;
- the canonical target identity;
- exact original and intended manifest bytes and identities;
- previous answer-model, gate-model, and daily-cap receipts;
- secret-name history, mode, and secret-phase receipts;
- the allowed forward addition policy;
- guide records;
- publication bounds; and
- exact operation-owned stage proofs.

The journal does not contain a confirmation verifier. Creating the forward
journal never creates confirmation material.

## Read-only classification

Classification has exactly three public outcomes:

- `original`: exact local evidence proves the manifest is still the original
  candidate allowed by the journal.
- `changed`: exact local evidence proves the manifest is the intended candidate
  allowed by the journal.
- `ambiguous`: the evidence is incomplete, contradictory, unrecognized, or a
  read-only boundary failed.

Classification is conservative. Matching JSON fields are not enough. Exact
bytes, stable file identity, closed journal structure, stage ownership, and the
declared forward policy must agree.

The intended stage is phase evidence, not optional residue. While the manifest
is the exact original candidate, that stage must still be the exact
journal-recorded regular single-link file. Once the manifest is the exact
intended candidate, the publication must have consumed the stage and its former
path must be absent. Altered, replaced, missing, linked, unreadable, or
phase-inconsistent intended evidence is `ambiguous`.

### Forward-owned domain

Answer setup can publish its intended manifest before deployment records a
verified `brain.domain`. The journal permits only that one forward-owned
addition. A classified forward manifest must have:

- exactly the declared domain path;
- the journal's exact nonempty domain value;
- no other semantic change;
- exact reviewed JSON serialization and byte receipts; and
- the proved original and intended bases from the same journal.

Anything less is `ambiguous`. The retained same-process rollback path preserves
a proved forward-owned domain addition rather than reverting it accidentally.
Before rollback creates an artifact, the current manifest must still match the
transaction's last accepted file identity and exact bytes. That proof begins
with the original manifest, advances to the operation-owned intended
publication, and advances once more only for the complete allowed domain
addition. A replacement, malformed file, unstable read, or other unrecognized
target is never adopted from its current pathname. It stops rollback and all
later mutation while retaining the journal and stages.

## Prohibited interrupted-run effects

An interrupted-run preview or recovery request must not:

- write or replace the manifest;
- delete or write a secret;
- deploy a Worker;
- register or reconcile a schedule;
- delete the journal;
- delete any stage or receipt;
- create a new stage, receipt, or confirmation file; or
- invoke manifest-bound credential control.

The journal and every existing stage remain byte-identical so a partner can
inspect them. This is true for `original`, `changed`, and `ambiguous`, for both
possible prior secret-name histories, and when a read-only boundary throws.

## Forward transaction invariants retained

This fallback does not weaken the forward answer-setup transaction:

- Primary manifest publication keeps the reviewed Windows `EPERM` and `EBUSY`
  retry behavior.
- A proved forward-owned domain is preserved by the same-process rollback path.
- Daily registration receives the final manifest after any verified domain
  publication.
- Journal publication remains fail-closed and schema-2 validation remains
  closed.
- Fixed non-JSON preview lines remain stable and content-free.

Runtime cleanup in the ordinary completed transaction is limited to the exact
stage paths created and retained in that transaction. It does not discover
files by a shared prefix. Before the first unlink, cleanup proves the complete
runtime artifact set against each artifact's creation or final-publication
identity and exact bytes. Consumed stage paths must still be absent. A mismatch
retains every artifact and the journal. The journal is removed last, only after
every proved artifact removal and every expected absence have been read back.

## Compatibility boundary

The new card is selected by a current schema-2 recovery journal or by an
explicit recovery argument. The recognizer returns the established half-run
refusal only for an exact valid schema-1 journal. Empty, malformed, non-file,
unreadable, and otherwise unrecognized journal states fail closed into the
fixed ambiguous card. No journal state gains recovery authority or is adopted
as schema-2 evidence merely because it occupies the expected pathname.

## Verification contract

The executable contract covers:

- closed validation of every schema-2 field and nested record;
- all `original`, `changed`, and `ambiguous` arms for both secret histories;
- preview and former execution arguments producing the same refusal;
- byte-identical journals and stages after every arm;
- zero manifest, secret, deploy, schedule, and cleanup mutation calls;
- a throwing boundary with private text producing the fixed card without a
  leak;
- malformed manifests and bad recovery arguments reaching zero manifest
  control calls;
- Windows primary and same-process rollback publication retry;
- same-process rollback target custody across original, intended, and the one
  allowed domain state, with replacement and malformed targets held;
- exact schema-1 recognition, with every other non-current journal state held
  by the fixed ambiguous card;
- forward-owned domain preservation;
- daily registration bound to the final manifest; and
- ordinary unlocked success as a green control.

Negative assertions include a reached decision counter or a nonempty
classification plan so they cannot pass without exercising the decision point.

## Consequences

The owner cannot complete recovery from a later CLI invocation in 0.4.20. The
preserved evidence and content-free card provide a safe handoff to a partner.
Adding automatic recovery later requires a new reviewed contract and new proof
that every mutation and cleanup boundary fails closed.
