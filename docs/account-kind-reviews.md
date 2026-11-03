# Owner account classifications

A bank feed may report an account as `other` with role `neither`. Those are
provider observations. An owner can separately review an account as `checking`,
`savings`, `card`, `loan`, `line_of_credit`, or `other`. Checking and savings use
role `asset`; card, loan and line of credit use `liability`. For `other`, specify
`--role asset` or `--role liability` explicitly.

Preview the exact account before writing:

```sh
brain ledger account-kind <manifest> --account <mask-or-slug> --kind loan --preview
brain ledger account-kind <manifest> --account <mask-or-slug> --kind loan --apply --approve <hash>
```

The preview shows the mask, provider kind and role, status, closure date,
retirement reference, and any previous review.
Checking or savings review is blocked when the provider role is `liability`;
the preview exposes `balance_conflict`. A label change cannot establish that an
amount owed means money held. If an existing current review contradicts that
provider role, cash stays unavailable with `account_kind_balance_conflict` until
the conflict is resolved. Revocation remains available and preserves history.
Duplicate masks refuse. Use the exact slug or `--account id:<number>` from the
preview to select one account. An approval binds the selected identity, current
provider observations, status, closure date, retirement state, previous review
and proposed kind/role. A changed plan
requires a fresh preview. Repeating a completed approval is a verified no-op.

The review records reviewer `owner`, UTC timestamp, source `owner_account_kind`
and the exact provider identity. Feed replay updates provider observations and
preserves the independent review. Account replacement, reassignment, currency,
mask, institution, feed mode or source changes make an old review stale. Revoke
that review before reviewing the new identity. A review never supplies a missing
mask, guesses ownership, joins accounts, certifies coverage, or splits a payment.

```sh
brain ledger account-kind <manifest> --account <mask-or-slug> --revoke --preview
brain ledger account-kind <manifest> --account <mask-or-slug> --revoke --apply --approve <hash>
brain financial-picture <manifest> --sections accounts
```

Revocation retains history and restores provider classification. The inventory
shows provider values beside reviewed kind, role, provenance and effective
values. JSON also carries a keyed reference to the bound identity, without raw
provider references. Stale and revoked reviews are visible and do not take effect.

After supersession, revoke a historical review with `--account id:<number>`.
That exact row lookup stays available independently of the replacement account.
Slug and mask selectors continue to select current rows only. New reviews
require a current, confirmed account belonging to a confirmed owned entity.
A closed current account remains eligible for a historical classification;
closure status and date are explicit approval context. Closure alone does not
invalidate a saved type or exclude later posted payments. Payment classification
still requires the usual exact counterparty, ownership and coverage evidence.
A type review leaves unresolved duplicate-account guards in place until the
separate account-link approval or other reviewed identity evidence resolves them.

Ledger account selection and transaction/balance reads verify the review in the
same D1 snapshot. A directed payment to a uniquely identified but unclassified
owned account withholds an ordinary-expense headline or ranking until reviewed.
An account still classified as `other` keeps that guard even after an explicit
liability-role review. Confirm `card`, `loan`, or `line_of_credit` before the
payment can enter a supported repayment bucket.
A saved deposit review that conflicts with provider liability evidence keeps
the same expense-total and ranking guard until a supported review or revocation
resolves it. The conflicting payment cannot establish a repayment bucket.
An explicit outside lender remains included. Missing masks or ambiguous payment
locators cannot prove that a payment belongs to an owned liability.

Migration 0058 adds review history without changing existing account rows or
creating approvals. Schema-58 recovery retains that history. Review/revoke also
marks derived bank-activity documents for refresh. These changes have offline
synthetic proof only; live account and release gates remain separate.
An older runtime ignores these reviews even if the additive table is retained.
Keeping the schema on downgrade preserves history but does not preserve reviewed
answer semantics; assess provider-only classification before any rollback.
