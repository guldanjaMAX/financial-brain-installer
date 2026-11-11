# Local calendar operands and explicit account scopes

The intent labeler supplies money operations. Calendar windows are computed
locally from the owner's configured time zone and an injected or current clock.
Closed month abbreviations include `Sep`, `Sept` and `Oct`, with an optional
period. Relative quarter operands accept `this q` and `last q`. An apostrophe
before a two-digit year, such as `in '25`, means the corresponding year in the
2000s. A month plus a straight or curly apostrophe year is one operand, so
`Oct '25` cannot default to the current year's October. Invalid dates, future
activity and ambiguous month prefixes refuse. Negated intervals such as
`not in September` and `not during October` refuse; neither may select the
positive month. Both the direct grammar and extracted-intent path enforce this.
Literal payees and account labels are removed before calendar resolution.

A period-only operand inherits the one grounded scope of its substantive core,
including when either model hint is omitted. Independent operations retain their
own scopes. A missing or ambiguous scope never grants the whole inventory.
Whole-owner operands carry an explicit plan marker after a bounded local check;
unknown wording refuses instead of restoring an unrestricted read. This check
also applies when the labeler omits every account hint.

Inventory-backed merchant-to-account recognition happens before committing an
operand's selected slugs. Each reader rechecks that same inventory and selected
set; a late reinterpretation cannot bypass narrowing because a plan exists.

Two explicitly combined months retain two separate windows, including when the
labeler returns one core. Period comparisons retain both sides and their
coverage even when a reader refuses. A difference requires complete compatible
operands with safe integer amounts. Money direction, requested refund basis
and exclusion rules must agree. The response exposes a closed reason when no
difference is shown. No cross-period amount is inferred from a partial subtotal.

A bounded spending split can contain two or three explicit selectors. Local
code expands one spending core without raising the general model intent limit.
Selectors resolve against confirmed owned entities, exact stored account labels
or masks, checking/savings kinds, or recorded personal/business entity kinds.
There is no abbreviation-to-entity mapping. Unknown, duplicate and overlapping
selectors refuse before transaction reads; a fourth selector refuses planning.
Each partition retains its own coverage and citations. Entity display labels
are read in the same inventory snapshots as account mapping and facts.

Transfer requests carry separate source and destination selectors. `from A to
B` is directed; `between A and B` accepts either direction. Candidate pairing
uses the complete authorized inventory before applying these endpoint filters.
The diagnostic candidate sum is counted once by outgoing posting date. It is
not a confirmed transfer total, and `confirmed_total_minor` remains null.
Concurrent inventory changes refuse subsequent scoped reads rather than mixing
account mappings across operands. Existing owner, grant, filter and outer-task
boundaries still apply.

Every explicit scope plan records its matched question span and passes through
the clause contract. Calendar resolution uses that operation's text. Unmatched
text must be a fully recognized request wrapper; another operation or unknown
remainder refuses the incomplete plan before inventory or transaction reads.
This rule applies to transfers and partitions without a bad-prefix list.

Offline synthetic probes are in `worker/test/c3-calendar-scope.test.mjs` and
`worker/test/c3-final-operands.test.mjs`. They
use real SQLite migrations, readers and answer composition with injected model
replies. They include restoring mutants. These probes do not establish provider
reliability, real account mappings, corpus coverage or release acceptance.

Replay SQL admission uses shared exact digests, including the inventory query
that combines entity labels with SimpleFIN proof checks. Router patch authoring keeps
all frozen response values. Only a one-rounding-bit host difference in an FTS
score may compare equal while retaining the original score bytes; this does
not apply to amounts, binds or model requests.

An unconsumed end-of-period restriction refuses before facts, including prefixes
and suffixes. The financial idiom `end up paying` or `end up spending` is admitted
as a complete phrase; bare `end` cannot license a whole-month answer.

Within a payment core, `last pay`, `last paid`, and `last payment` describe
receipt ranking. Only that closed ranking phrase is masked before calendar
consumption; an additional unsupported date constraint still refuses before
facts. Latest-date ties keep every matching receipt.
