# Money-in transfer breakdown

Money-in-only totals retain every recorded posted credit and the label
"not established income". They additionally report matched transfers between
owned accounts, the pair count and citations for both legs, then the recorded
inflow minus those matched transfers as "Inflow from outside your covered
accounts". Unmatched credits can still contain unproved own-account moves.
This remainder is a recorded-ledger measure, not a certification of the source.
Refunds stay in that remainder.

The existing candidate matcher requires equal integer cents, opposite
directions, different effective owned accounts and mutually unique peers within
three calendar days, inclusive. At least one leg must identify the other owned
account. The breakdown additionally requires the existing reciprocal directed
identity checks and no outside-payee or refund conflict. A stated account kind
cannot distinguish duplicate masks. An unreviewed `other` kind cannot establish
a matched transfer. A unique stored account label can still resolve identity.
Generic channel payees such as "Transfer" are admitted only for money-in
breakdowns when both directed endpoints already prove owned identity. External
payees still conflict; the default advisory and outflow admission is unchanged.

A transfer belongs to the selected inflow's period. Its outgoing leg may be in
another selected period or another covered owned account outside the question's
account scope. Both posting days must be covered. The reader's existing six-day
padding checks competing peers of a counterpart up to three days away. Padding
rows never enter recorded inflow or the per-account gross figures. The matched
counterpart is cited even when it is outside the question's period or scope.

Expense, outflow, repayment and diagnostic-transfer answers keep their existing
behavior. Reusing this breakdown for outflow would need a separate decision
about outgoing-date membership and existing repayment labels.

The development cases and independent key live in
`worker/test/fixtures/inflow-transfer-{cases,key}.mjs`. Run
`node --test worker/test/inflow-transfers.test.mjs` after the required host
quiet-file wait, using a scratch HOME and `BRAIN_NO_WRANGLER_LOGIN=1`.
The suite exercises `withLedgerAnswer` through the real SQLite replay and
restores the actual pinned implementation as a failing control. These offline
checks provide development evidence only.
