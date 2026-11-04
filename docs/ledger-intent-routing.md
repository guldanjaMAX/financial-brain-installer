# Money intent fallback

The deterministic ledger grammar runs first and retains its routes, figures,
answer bytes and zero extraction calls. Unrestricted owner questions outside
that grammar may use one bounded model request to select a ledger reading.
The model receives the question and a fixed schema prompt, never ledger rows.
Local code computes calendar windows; existing readers and composers compute
and display figures, citations and coverage.

The extractor uses the existing `RERANK_MODEL` selection and reviewed Haiku
4.5 or 5.5 family. Missing provider credentials, another model, restricted
access, entity scope, filters or tax eligibility prevent the request. There
is no provider substitution, retry, new credential store or raw question/error
logging. One eligible question adds at most one request, 650 output tokens and
the shared helper's 4,000 ms timeout. Existing spend accounting applies.

## Every model answer is a reading

Every accepted model route starts with exactly:

> Here's my best reading of your question: Showing ordinary posted expenses across all accounts for September.

The restatement describes the actual reader operation, scope, direction,
literal selector or amount, list cap and exact inclusive window. Balance and
forecast readings state the local day through which recorded observations
were selected. They never promise a current live balance. Forecasts preserve
the honest refusal of future values and the available recorded snapshot.

The existing composer's answer follows, including its figures, citations and
coverage qualifications. Every model answer ends with exactly:

> Is that what you meant? If not, tell me the period or account you had in mind.

A wrong model reading therefore stays visible as a reading. There is no claim
that the validator independently verified its semantics. All model responses
set `intent_outcome: "clarify"` and `evidence_gate.complete: false`, with
`partial: true`. The ledger object's own coverage still describes only the
selected reading. Structured clarification metadata retains the chosen
reading, diagnostic reason and suggested alternatives. Its `question` is the
same exact closing line.

A missing figure remains an explicit limitation with the original gaps and
no invented zero. A later affirmative message does not authorize a stored
plan: every request is evaluated independently. Grammar answers receive no
reading label or new closing question.

## Hard validation

`LEDGER_INTENT_SCHEMA` closes every object and bounds kinds, directions,
counts from 1 through 100 and period parameters. Canonical string digits in
that range have the same meaning as integer counts; an empty `unanswered_part`
has the same meaning as null. Whitespace, other numeric formats and unknown
keys still refuse. Runtime compatibility still
accepts omitted nullable fields or an omitted `ambiguous` flag. A supplied
flag must be boolean and false. Unknown keys, `not_money`, explicit ambiguity,
incompatible selectors or directions and unsupported reader capabilities
retain document fallback.

Vendor, account_hint, amount and literal calendar-date labels occur verbatim, case-insensitively, in the
question. Amounts parse to integer currency cents. Explicit currency amounts
and explicit dates cannot be dropped. Invalid or future dates and invalid
calendar parameters refuse. When no local period is found, a model year
still needs question evidence. Local relative-date resolution
supports today, now, yesterday, weekdays and the start of the current week,
month or year. A weekday means its most recent occurrence, including today.
A single activity day is exactly one day. A dated payment stated as `on`,
`due` or `meant to be` uses that day; `around`, `about` and `expected around`
use a three-day neighborhood capped at the owner's day. Yearless month/day
labels use the owner's current year and remain verbatim grounded. The label
states the exact window. Other near-date wording retains the existing
seven-day neighborhood.

Relative `date_text` annotations are resolved by their temporal class. A
month/week label on an otherwise unspecified activity uses its closed period;
`now`, `current` and ordinal annotations do not create a literal day filter.
Today, yesterday and weekdays keep their local day resolution. Explicit
since/between ordinal operands resolve in the owner's current month and must
be valid past days. Calendar-date literals retain verbatim grounding. Current
balance requests accept `none` and the closed `current` compatibility alias,
and show the date of each recorded observation and its last sync information.
Historical balance windows retain their refusal.

The reply parser consumes the first complete object from bare JSON or one
complete fence. It tracks quoted strings and escapes, then permits trailing
prose. Another object, braces or another fence in that prose refuse, as do
leading prose, incomplete wrappers and injected keys inside the object.
Schema and grounding checks still apply to the entire parsed object.

Forecast expense requests cannot become balance forecasts. Ordinary future
activity requests refuse. Historical balance windows remain unsupported.
Unsupported entity scopes, exclusions, currency,
accounting qualifiers and grouped activity operations cannot silently become
whole-owner operations. Confirmed owned business balance snapshots retain
the existing entity selection and atomic inventory recheck. A clear verbal
use of checking does not select the checking account type. Typed or named
activity restrictions retain their guard.

Decoys, instructions and outer tasks such as translation, document work,
pricing, advice or recipes never gain ledger authority by mentioning money.
Requests for records with missing dates cannot become current-month expenses.
These boundaries still run for uncertain segmentation and period readings.

## Capability admission

The pre-model list retains unsupported document, accounting, statistic,
currency and approval tasks. It no longer rejects a question merely because
it contains a supported balance measure or exclusion word. The validator
checks those qualifications against the chosen operation before any reader.
Unsupported qualifications still refuse; moving the check does not permit
silently dropping one.

| Removed blanket rule | Existing local authority |
| --- | --- |
| `available`, `pending` | R7 class 3 per-account balances; R9 class 3 balance measures; R10 class 5 pending list |
| `tax` for an account purpose | R7 class 3 account purposes; R10 class 1 and R11 class 1 account hints. Tax computations and filing still refuse. |
| `without`, `not counting` for owned transfers | R10 class 3 ordinary expenses and the ownership detector; `own` is optional after `our` or `my`. |
| `excluding`, `exclude`, `without`, `except`, `including`, `not counting` as blanket early tests | R9 class 4 cash-only snapshots and R10 class 3 owned-transfer wording. Closed qualification checks now run after extraction. Other exclusions still refuse. |
| `payroll` only when it names an account purpose | R13 class 1 closed account-purpose admission; R7 per-account balances and R11 account hints. Payroll computations still refuse. |

R14 removes no pre-model rule. Its shared `gateReason` rejects explicit term
definitions before money-cue admission, extraction, reply parsing or validation.
This covers what does, what is, what's the difference, explain, define and
meaning of when the whole subject uses the closed money-term vocabulary.
It reports `fallback:decoy_outer_task`, even for a schema-valid balance reply.
Owner references, account labels, amounts, dates, how much and show requests
cannot fit that subject. The guard does not infer any ledger operation or
expand admission. Separable ledger cores with an explanatory tail retain
their existing local handling.

R15 removes no pre-model rule. Card wording without an existing money cue
requires both an owner-style card phrase and a pending, uncleared, cleared or
posted state. A bare card mention, nonfinancial card phrase or term definition
does not gain admission. Checking, savings and named or purpose accounts already
carry money cues. On a balance reading, uncleared and explicit not-cleared or
not-posted wording use the existing separate pending-transaction reader. Pending
rows stay outside posted totals, and the answer remains a tentative reading.

Money in `excluding loans` uses the existing account kinds and reciprocal
owned-loan advance detector. Totals keep gross credits explicit and add a
labeled lead figure and excluded loan-proceeds amount. Deposit lists retain
separate gross and lead rows. A memo saying loan proceeds cannot establish
an advance; unproved credits stay counted. This is bank money in, never
accounting revenue or profit.

Freshness on a hinted balance already works at the R11 pin. R12 preserves
that behavior and tests resolved and unresolved hints. Three synthetic prompt
examples demonstrate account nicknames with unknown opening events, and the
local current-year authority. No event date is invented.

## Soft decisions and local defaults

The question's locally parsed period is authoritative over the model hint.
Supported periods include named months with or without a year, calendar years,
quarters, explicit word or ISO ranges, relative years and year to date.
Relative month/week windows, today, yesterday, rolling days and since-day
windows use the owner's configured calendar. The opening label shows the
actual inclusive dates, including when a wrong model year is replaced. `Lately`
and `recently` use a labeled last 30 days; `most recently` keeps its ordering
meaning. Closed `last_weekend` and `this_weekend` periods mean Saturday through
Sunday in that calendar. Future or unfinished weekend windows refuse instead
of inventing future activity. `Right now` and `as of the latest update` select
current recorded balance observations and label the actual latest synced date;
a missing sync date is stated as unavailable. With
no local parse, the existing closed period validation and tentative calendar
diagnostics still apply. Explicit alternatives joined by `or` stay tentative.

No stated activity period gives a current-month reading for expenses, totals,
largest entries, vendor/category views, deposits and transfers. Recurrence
keeps its 120-day default; payment lookup keeps 60 days. Newest transactions
retain their existing 25-row display cap. The exact chosen dates and cap are
visible before any figure. Selector-free received-payment requests with a
period or grounded day use a deposit list, which makes no aggregate inflow
claim. Closed outflow totals use ordinary expenses; vendor totals use the
merchant reader, preserving exact/possible-match disclosures.

Model-routed transaction lists accept these windows, default to newest first,
and keep the 25-row cap. A `Showing N of M` line counts the actual recorded
rows inside the window and states incomplete coverage when present. A short
list may still have full period coverage. Grammar-routed transaction behavior
is unchanged. An expense overview with no stated period labels its default
as `this month so far`.

Account-type or purpose balance requests use a reading of per-account recorded
balances, with account endings and observation dates. Model selectors resolve
against recorded display labels and account kinds. A word contained in a label
counts as a match; personal and business roles are never guessed from a payee.
Two selectors can compare balances, ordinary spending or money in for the same
local window. Resolved complete figures appear side by side with the signed
first-minus-second difference. An unresolved selector shows every account by
ending, with the line `I couldn't tell which account you mean by '<word>', so this covers all your accounts.` and
no certified difference. Two unresolved balance selectors share one list.

The closed nullable `account_hint` field carries a verbatim account nickname or
purpose. It is independent of a literal payee: a merchant or received-payment
reading may carry both `account_hint` and `vendor_text`. Every supported kind
resolves the hint against the same recorded account labels and kinds. A matching
hint scopes the reader and label; an unresolved hint keeps the all-account
reading and the plain disclosure above, without dropping the payee. Older
replies may still put account words or generic own-business
terms in `vendor_text`; these never become payee filters. An unknown event in
`date_text`, including on a ranked-charge reading,, such as `we opened it` after `since`, uses the earliest covered date
for the matched accounts, or all accounts when unresolved. The answer labels it
`since <date>, the earliest date I have`; this does not claim the event occurred
on that date. Missing coverage still prevents a complete figure.

Spending selectors first preserve exact payees. Otherwise an exact recorded
category name uses the ordinary expense membership for that category. A missing
category, including a known category word such as supplies, software, materials
or repairs, shows the full category breakdown and the line
`I couldn't find a category called '<word>'.` Two matched categories can be
compared. An arbitrary unmatched payee retains its existing refusal. A request
to avoid counting transfers between owned accounts twice uses the existing
ownership detector and labels the excluded transfer total separately.

A ranked `largest` reading may carry a literal vendor and count. Exact
normalized payees select the candidate rows before ordinary-expense membership
and the display cap. The opening states the selector, count, account reading
and local dates. Partial payee words and description-only payee mentions do
not gain exact-match authority.

A `deposits` reading may carry a payer phrase in `vendor_text`. This is a
case-insensitive, whole-word description phrase filter, applied before newest
ordering and count. It never attributes a deposit to that payer. Payee-only
and partial-word matches stay out. An empty list says there are no deposits
with that phrase in the description for the covered period; it makes no
zero-payment claim about the payer.

For inflows, refund and reimbursement selectors use whole description words,
case-insensitively, accepting the singular and plural spelling. They do not
classify the deposits or filter by payee. The answer labels the description
keyword; absence is `no deposits with 'refund' in the description`, rather than
a claim that no refunds occurred.

The optional, nullable `unanswered_part` field is at most 120 characters and
must match a contiguous question span after case, punctuation and whitespace
comparison. Instructions and invented text refuse. A separable ledger core
keeps its ordinary reading. Freshness details show each account's observation
and last sync dates; account details identify cited row endings. For largest
outgoing expenses, share of total uses the same snapshot, accounts, period
and ordinary-expense membership for both figures. Integer cents and integer
rounding produce a percentage to one decimal. Incomplete coverage, unproved
expense membership and a zero denominator cannot certify a share. A card
balance's meaning uses one fixed sentence saying it is money owed on that card.
These details are labeled and may also be recognized with a null model tail.
Other extra parts keep a plain fixed limitation. Unknown and interior spans
retain the whole question under its scope and calendar guards; model text
never becomes an instruction. Same-length month qualifiers remain in the
calendar question even if a model places them in this field.

Two current `balance` intents whose selectors name balance measures share one
per-account snapshot. This path shows current and any stored available balance
for every account. Missing available values are explicit, and statement,
ledger and pending balances are disclosed as absent from the feed. A pending
request separately reads any stored pending transactions, labels them, and
keeps them outside posted figures. If the records show none, the answer says
the bank feed does not show pending items in these records and retains current
and any recorded available balances. Historical
snapshots and outer tasks retain their guards. A cash balance request without
card debt, or not counting cards, totals confirmed depository assets only.
Card balances appear separately and are never netted against cash. Other or
unknown kinds remain outside that total. No recorded depository account means
the cash total is unavailable, rather than a certified zero.

Merchant, money-in/out totals and ordinary-expense readings can show `by month`
or `month by month` breakdowns. One locally computed period is split at calendar
month boundaries, including `since June` through the owner's current day. Each
month reuses the existing reader, integer-cent arithmetic and expense/ownership
rules, with distinct evidence references. The label states the actual period
and calendar-month grouping. An unproved month says `no bank records for <month>`
sufficient to establish an exact figure, while other covered months remain
usable. Zero requires the entire calendar month to be covered across every
selected account; an empty partial first or current month never becomes zero.
A literal merchant also needs an exact recorded payee in the requested period
before an empty covered month can show zero. Unknown and possible-only payees
retain their limitations. Both money-in and money-out requests show separate
monthly measures and do not establish accounting income or profit.

`This year` already uses the owner's current calendar year, regardless of a
stale or future integer year in the model period hint. Monthly breakdowns use
that same authority and never substitute the model's year.

Two locally determined periods may use the same reader kind. Complete
expense, literal selector or money-in figures appear side by side with the
exact signed first-minus-second difference. Money-in-and-out comparisons
show separate differences for each measure. Partial or uncertain figures
cannot certify a difference. `same_days_last_month` ends on the corresponding
day of the prior month, capped at that month's final day. Arithmetic adds no
verdict about performance. A totals intent plus a selector-free category
intent at count 1 shares the total's local window and shows its top category.

A recurring literal selector filters only when it is an exact normalized
payee. Otherwise the reading shows the unfiltered recurring list, says
category filtering is unavailable, and lists up to five payees containing the
word when any exist. Recurrence remains detected, never confirmed.

The clause guard separates parts without reconstructing the model's kind,
selector, direction or count. Grounded entity conjunctions and date ranges
stay intact. Background and display details may accompany a single reading.
Uncertain single-intent segmentation produces a tentative reading after all
hard checks. Account restrictions still inspect the full original question.
Inseparable two-part questions, missing shared windows and additive periods
that need separate operations retain document fallback.

Two cleanly separable operations use their existing readers independently.
One combined opening restates both operations with their exact dates, and
one closing question follows the answers. Numeric citations and structured
references are rebased together, preserving literal selector text and all
amounts. If either reader fails, the original document behavior remains,
except that a validated forecast always retains its honest refusal.

## Decision API and offline gates

R13 admits directional newest-transaction lists, counted transfer lists,
counted occurrences of detected recurring series, and largest entries per
account. Direction filtering happens before ordering and the display cap.
Personal and business on a transfer request describe its sides. Bare personal
or business on another activity request keeps an all-account reading and says
that the account could not be determined. A literal spend selector may contain
bank or business without becoming an account restriction.

Closed spelling expansion applies to account grounding and capability checks
on both operands: acct/accts, txn/txns, bal and biz. Payroll, rent and tax can
name account purposes. The remaining pre-model capability terms still refuse;
only the account-purpose use of payroll gains the R7 per-account and R11 hint
reader. Payroll calculations and tax filing do not gain ledger authority.

Pending and cleared activity questions use posted records with an explicit
pending exclusion. Vendor refunds requested separately receive a fixed line
saying that they are not split out. Cash balances without a card debt remain
cash-only readings even when a verb separates those words. An inflow amount
uses the exact-amount payment reader; fee-adjusted amounts are never inferred.
A requested payee breakdown receives the category summary and a limitation.

The single-intent clause guard recognizes output-detail vocabulary and grammar
for that kind. It retains the full wording for scope and calendar checks.
Details the reader cannot supply receive the standard unanswered-part line.
A separate period, amount, account selector or vendor cannot gain admission as
a detail. Incoming and outgoing stays one direction-both operation.

More/less than supports two locally computed windows. So far, at this point
and same dates use matching elapsed spans in the prior month or year. A local
range or month shared by two activity clauses governs the otherwise undated
clause; it never turns a current balance into a historical snapshot. The day
before resolves from the other clause's single day. Payment dates drop
approximation annotations and accept a model-added current year only when the
local day agrees with the question. On or after is a since-window. A tolerance
lookup uses seven days on either side, lists every exact-amount candidate, and
marks multiple candidates ambiguous. Recurring accepts unknown event anchors.
Annual recurrence requests use a 400-day reading, ignore a model year hint,
and disclose that annual cadence detection is unavailable; the detector still
recognizes weekly and monthly series only.

Three additional synthetic extractor examples cover recurring analysis,
payment tolerance and split-by-type summaries. Offline request and natural-reply
tests do not prove that a new real model response will choose those cores.

The narrow refund qualifier repair interprets spending after or net of refunds
as ordinary posted expenses less inflows whose descriptions contain the whole
word refund or refunds, over the same accounts and dates. Both operands and
their description-based meaning are labeled. It never claims those inflows are
verified refunds. Other category-versus-payee or ranking changes are deferred.

The decision API retains `ready`, `clarify` and `fallback` as plan-admission
states. Legacy array APIs accept only a ready plan; uncertain clause plans
remain unavailable to those callers. A ready plan certifies schema and reader
admission, never semantic certainty. The answer wrapper labels both admitted
states before presenting model-routed facts.

`explainLedgerIntentDecision(question, rawReplyText, { now, timeZone })` is a
pure view of the same parser and validator. It returns only `{ outcome,
reason }`, without a provider call or logging. Every extraction fallback
carries a closed reason from `LEDGER_INTENT_REASONS`: `parse_failed`, `schema`,
`ungrounded_vendor`, `ungrounded_amount`, `date_literal_mismatch`,
`period_contradiction`, `two_part_unsplittable`, `decoy_outer_task`,
`gate_refused`, `capability`, `model_refused` or `provider_failed`. Admitted
plans retain `model_reading`, `period_uncertain` or
`single_intent_clause_uncertain`. Legacy array APIs still return null for
fallback or an uncertain clause plan; diagnostics expose the reason without
changing that compatibility behavior. Provider configuration and failures
are diagnosed by the async decision API because the pure view has no provider.

`worker/test/ledger-intent-router.test.mjs` covers exact templates across
supported kinds, R1-R14 probes, hard boundaries with green controls,
restoring mutants, real reader/composer paths, stubbed HTTP responses,
accounting and timeout behavior. Existing ledger grammar suites and the
pinned fast-loop comparison remain separate regression gates.

Both recorded dev tapes are replayed offline against fixed question-derived
keys and an explicit frozen owner-zone clock. Tape 1 has its supplied key;
tape 2 has no supplied expected-answer key. Its replay must record a separate
question-authored key and hash, independent of categories and model replies.
Counts are primary-kind measurements only: they do not prove selector,
direction, amount, period or multipart accuracy. Missing recordings and
explicit model refusals cannot be repaired by replaying old replies.

The fast-loop comparison holds its synthetic inputs, harness and scoring key
fixed while restoring four ledger modules from `129c78f5`. Its grammar-case
responses must remain byte-identical, with zero new wrong figures or
unsupported claims. These gates provide offline review material, never
release or live-deployment evidence.

## R16 answer details and capability normalization

Clause planning and model-provided tails now share an independence check.
A new period, date, currency amount, differing account scope, literal payee or
outer task stays independent. References to the same item do not become a
second operation merely because they contain payment, credit or account words.
A grounded payee-only total can supply the core clause. The old per-kind word
lists and the requirement for a recognized detail word are removed.

A detail uses the core calendar, including when an `or` tail would otherwise
hide the stated window. Grounding, explicit amounts and dates, qualifications
and scope checks retain the complete question. Existing account, freshness,
row, date and amount details remain visible. Unsupported extra analysis gets
the fixed extra-part disclosure. Independent windows and selectors retain
clarification or refusal. Local `ready` still produces the ordinary tentative
model-reading wrapper and partial evidence gate.

No pre-model admission rule is removed in R16. The capability-admission table
above records the earlier blanket removals and the rounds that supply their
local authority. Definitions, outer tasks, injection, unsupported currency,
accounting/statistic/approval tasks, non-owner accounts, tax computations and
missing-date filters retain their existing refusal controls. Moving a detail
out of the core never removes those full-question guards.

The extractor now reserves `not_money` for outer tasks, non-ledger topics and
non-owner accounts. Unusual entity, account and event restrictions are preserved
for local validation. A payee, business scope and event anchor are fields of
one core. Four synthetic JSON examples cover an item cost at a possessive owned
business, scoped payee spending since an event, a recurring service across two
owned accounts and uncertain subscription classification. Offline recordings
cannot establish whether these prompt edits reduce fresh model refusals.
`explainLedgerIntentDecision` adds only the closed `modelRefusal` values
`ambiguous` and `not_money` for a `model_refused` decision, without question text.

Snapshot directions are irrelevant and become null. A transfer direction of
`both` becomes null; inflow-only and outflow-only transfer lists still refuse.
Posted, cleared and pending balance labels use recorded balances with pending
items shown separately. Freshness recognizes last-check verb constructions
and searches wh-word suffixes of model-provided tails as well as null tails.
Historical snapshots and future figures keep their guards.

Closed refund, loan and own-transfer phrases accept one determiner: any, the,
all or their. Arbitrary intervening modifiers remain unsupported. Payee totals
asked net of refunds retain gross spend and explicitly say refunds are not
netted. A `both` direction is accepted for that payee wording only. Whole-owner
refund-description netting retains its separate existing semantics.

A payee overview without a literal payee uses the expense summary and states
that its requested payee breakdown is unavailable. A same-payee, same-window
list companion can fold into the total; different dates, scopes or directions
cannot fold. An exact-amount transaction lookup can search outflows or both
directions, with the searched direction stated. Received-payment behavior and
its attribution checks are preserved.

One expense selector versus everything else, the rest or all other spending
uses one complete expense summary and a partition over the same ordinary rows.
A bank category is tried first, then an exact payee. An unknown selector gets
no invented zero or remainder. Two independently named selectors retain the
comparison contract. A single-amount lookup offering either owned account
searches all owned accounts and shows the account of each matching row.
