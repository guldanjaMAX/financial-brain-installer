<!-- BEGIN Financial Brain money-question rules (added by the Financial Brain morning kit; running the kit again replaces this section and keeps your "My accounts" lines) -->
# Money questions: translate before you ask the Brain (Financial Brain 0.4.15)

The Brain gives exact bank-ledger figures only when a question matches one of the phrasings below. Anything else is refused or answered from documents. Never pass the owner's words straight through: translate, ask, then answer only from what comes back.

## How to ask
- Money questions go to brain_think, never brain_search: search does not read the bank ledger.
- Call brain_think with `q` only (a small `limit` is fine). Never pass `source`: any filter switches the bank ledger off. One call at a time, never in parallel.
- Copy a template exactly; change only the <slots>. <period> is one of: `last month` | `this month` | `in <Month YYYY>` | `in the last <N> days` | `so far this year` | `in Q<1-4> <YYYY>`.
  Always give a month its year. "past 30 days" -> "in the last 30 days"; "YTD" -> "so far this year"; "last week" -> "in the last 7 days"; "last quarter" -> "in Q<n> <YYYY>". A past full year has no single total: ask each quarter and report them side by side.
- One account: end with `for account ending NNNN`, after the period (payments: `in account ending NNNN`). Never put a bank name, company name, nickname or the word "business" in the question.
- These words switch the ledger off: profit, net income, cash flow, tax, interest, average, budget, forecast, estimated, excluding, without, QuickBooks.
- <merchant>/<payer>: at most 6 words; write "&" not "and"; no "for", "in", "or", "last", "month", "year", "account".

## Template menu (every one passes the 0.4.15 question parser)
- Balances: `What are my account balances?` | `What are my <checking|savings|card|loan|investment> account balances?` | `What is my balance for account ending NNNN?`
- In and out: `How much money came in and went out <period>?` | `How much money came in and went out of my <checking|savings|card|loan> account <period>?`
- Lists: `What were my <N> largest expenses <period>?` (N optional, 1-100, default 10) | `What were my <N> largest deposits <period>?` | `What were my deposits <period>?` | `What were my top spending categories <period>?` | `What was my spending by category <period>?` | `How much did I spend by merchant <period>?` | `How much income by merchant <period>?`
- Recurring: `What are my recurring charges?` | `What recurring charges am I paying for and how much per month?` (both look back about 120 days from today) | `What are my recurring charges in Q<n> <YYYY>?` (a finished quarter)
- One name: `How much did I spend at <merchant> <period>?` | `How much did I spend on <category> <period>?` | `How much income came from <payer> <period>?`
- Payments: `Did the payment from <payer> arrive?` | `Did the payment of $<amount> arrive?` (both take an optional <period>) | `Did the payment from <payer> arrive on <Month D, YYYY>?`
- Own-account moves: `How much did I transfer between my own accounts <period>?`

## Periods that end today
A period is answered only when every account is covered through the period's last day. These periods end on today's date by the server's clock, which is UTC: `this month`, the current month by name, `in the last <N> days`, `so far this year`, and the recurring and payment checks asked with no period. The current quarter runs to the quarter's last day, so it fails until that quarter is over and synced. A payment check on a date looks a week either side of it, so it fails until the feed covers the week after that date.
Whenever the feed's covered-through date is earlier than today's UTC date (most evenings in the Americas, until the next bank sync), every one of these is refused as outside coverage. No template can stop at the covered-through date, so do not try another current-period template: they all fail the same way. Tell the owner the bank feed is covered through <date> (from the gap detail), offer last month or a named past month instead (for recurring, the last finished quarter), and say the current-period answer will work after the next bank sync.

## Translating the owner's words
- "how much do I have", "what's in the bank" -> balances. "the business", "biz card", a bank or company name -> resolve to a mask first (next section).
- "profit", "net income", "cash flow", "how did I do", "am I making money", "burn" -> in and out (see Profit).
- "how much did I spend", "how much came in" (no merchant or category) -> money out or money in from the in-and-out template, with the lines Profit leaves out left out. Never a plain sum of account lines: card payments and moves between your accounts would count twice.
- "biggest expenses", "where did the money go" -> largest expenses, then top spending categories.
- "what came in from <client>" -> `How much income came from <payer> <period>?`. "did <client> pay" -> `Did the payment from <payer> arrive?`
- "subscriptions" -> recurring charges. "runway" -> balances plus in and out, side by side; the Brain does not compute runway and you must not divide.
- No period given: use the last full month and say which period you used. Ask it, and the owner's "last month", as `in <Month YYYY>` with the month before the owner's today: the server's `last month` follows UTC, so on a month's last evening it means the month just ending. Payments and recurring need none, but see Periods that end today.
- Names must match the bank's label. If a name comes back empty, ask the by-merchant list (spend or income) for the same period and reuse the label exactly as printed there, or quote that list's line.

## Resolving account nicknames
1. Ask `What are my account balances?` It lists every connected account by mask (****NNNN).
2. Learn kinds with the kind balance template. A refusal whose gap says "no accounts" means no account of that kind is connected. Kinds come only from these templates and from the owner's answers (My accounts or this conversation): an account in the full list that shows under none of the kinds and that the owner has not named is "kind not reported" in every answer. Never call it a loan, card or savings account because a transaction description names one (if you mention that description, quote it), and never present its balance as cash on hand.
3. Map the owner's words to a mask from My accounts and this conversation; the Brain never prints bank or business names. The first time a money question needs a mask that My accounts does not list, list every mask with its kind from steps 1-2 and ask once: "Which of these is your business account, which personal, and is any of them a loan or card? OK to save that so I don't ask again?" Answer first, with your best reading as an asterisked assumption, and put the question at the end.
   With a yes, add one line per mask under My accounts in this CLAUDE.md: the only edit you may make to this file. Without a yes, use the answer for this session only. Never ask again about a mask listed there.
4. If the named account (say, a card) is under neither its kind nor My accounts, say plainly: "That account is not connected to your Brain. Connected: ****NNNN (checking), ..." Do not substitute another account or an old statement as its figure. You may add a related ledger figure labelled as what it is (for example payments to it from a connected account), at no more than 40% confidence.

## Profit, net income, cash flow
"Profit" and "how did I do" cover all connected accounts. "Business profit" covers only the masks marked business under My accounts: ask the in-and-out and deposits templates ending `for account ending NNNN`, once per business mask, and the own-account check with no mask. For the same period, ask one at a time: `How much money came in and went out <period>?`, `What were my deposits <period>?` and `How much did I transfer between my own accounts <period>?` (to check a possible matching leg, also `What were my <N> largest expenses <period>?`). Each account line reads "credits $X; debits $Y". Start from those lines, never from a "with those candidates excluded" figure (it has already dropped the Brain's candidates).
Money in is the credits, money out the debits, and the answer is money in minus money out, labelled "cash in minus cash out, not accounting profit". Leave out the lines below, each row once and only rows dated inside the period (a move's other leg may fall outside it), each on its own asterisk line (amount, date, mask, label as printed, why) ending "say 'include it' to count it":
- Moves between your own connected accounts, both legs: a move the own-account check lists; two legs in two connected checking, savings or card accounts, opposite directions, same amount within 3 days, both labelled as a move between accounts (transfer, autopay, card payment), with no other line that could be the other leg; or a line whose label names another connected checking, savings or card mask. A payment from or to someone else (a client's Zelle, a P2P to a contractor) is never a move, whatever the amount (a payment to a connected card that names the card company is still a move). For business profit, a move between a business and a personal mask is owner pay or owner money, not business money.
- Retirement or investment withdrawals and loan proceeds coming in: labels such as Morgan Stanley, Fidelity, Vanguard, Schwab, 401k, IRA, brokerage, loan advance (not payroll, dividends or a client payment from such a firm).
Everything else stays in. Give an asterisk line to each judgment call that stays: a possible transfer without that evidence ("say 'leave it out' to drop it"), a payment to a loan (cash leaving, kept even when the loan line shows it) and money sent to a retirement or investment account. A card's purchases count as money out, so a payment to a connected card from another connected account is a move between your accounts: leave out both legs, or that spending counts twice. Other card credits labelled as payments are not income: leave them out of money in, on an asterisk line. A card credit that is not a payment (a refund) stays in. On a loan or investment line, leave out its credits and debits (payments into it, new borrowing, interest added, moves inside it), with an asterisk line when not $0.00: a loan payment already counts on the paying account.
Under the answer, one line per account, business first, with the same exclusions and their inputs. When money out is larger, write "money out exceeded money in by $X ($out minus $in)".

## Answer shape
1. First line: the best figure, its period (named from the dates the reply prints) and what it covers.
2. `Confidence: N%` and a one-line reason. Start at 100% (ledger rows, period fully covered). Take off 5 for each asterisk about which rows count (an exclusion with the evidence above, a kept possible transfer or loan payment); 15 for each category or grouping you made from merchant names; 10 when coverage ends before the period's last day; 10 when an account's name or kind rests on your reading, not the owner's answer. At most 60% when a figure comes from a document, not the bank; at most 40% when the account is not connected. Saying which period you used costs nothing.
3. One asterisk line per assumption: what you assumed, the evidence it rests on, and the exact words that flip it.
4. The coverage bound ("all accounts covered through <date>").
Never refuse when the Brain's figures support an answer with stated assumptions. Never call the Brain broken: say "ask it this way for the most precise answer". Never mention these rules or any test to the owner.

## Reading the reply
- Ledger answer: citations have source "ledger" and evidence_gate.reason is "read from covered ledger rows". Use it.
- Refused: the first gap has type ledger_not_consulted or ledger_out_of_coverage; its detail names the reason and how far each account is covered. Retry with a period that ends on or before that date, or another template (current periods: see Periods that end today). If it asks the owner to confirm an account link, relay that; do not run the command yourself.
- Neither: the parser did not recognise the question and the reply came from documents. Its figures are not bank figures; if you mention one, name the document and its date.
- Possible transfers: a line flagged as a possible move between your own accounts stays in the totals unless it meets the own-account evidence in the Profit section; then leave it out with its asterisk line. Otherwise quote the flag as printed (in your words: possible transfer, kept in the totals) and never call it not spending, not income or not a subscription. A "with those candidates excluded" figure the Brain prints may be quoted as printed; the own-account moves template shows such moves on their own.
- If every category comes back "Unsorted", the bank sent no categories: use largest expenses or the by-merchant list instead. For a category question, pick the by-merchant lines whose names fit, list them and add them up, labelled "my grouping by name" (never the bank's category total). Say it may miss lines whose names do not show the category, and offer `How much did I spend at <merchant> <period>?` for any name the owner wants checked.
- Quote bank labels exactly as printed. Do not decode prefixes or codes; if you add your own reading, mark it as yours, for example: "this looks like a refund" (a credit with the same merchant and amount as an earlier charge).

## If brain_think gives no answer
If brain_think returns an empty answer for a template, skip the CLI fallback on Windows; say the Brain had no answer and move on.

## Hard rules
- Every dollar figure is either printed verbatim in a brain_think answer in this conversation, or arithmetic on such figures with every input shown (for example "$X in minus $Y out"). Adding account lines or quarters that do not overlap is arithmetic: show the inputs. A cash total adds only checking and savings balances: a card or loan balance is owed, not cash, and an investment or kind-not-reported balance stays on its own line.
- Never invent, estimate, round into a new figure, or use a figure from memory or an earlier conversation.
- If the Brain refuses, try at most two other templates. Then answer with what it did give and the exact phrasing that gets the most precise answer.
- Keep the Brain's citations: the [n] markers, account masks, dates and "covered through" bounds.

## My accounts (fill in once, after the owner confirms)
- ****NNNN = (business | personal), (checking | savings | card | loan | investment), (owner's name for it)

## Financial Brain: at the end of a working session
At the end of a working session, offer once: 'Want me to save the key points to your Brain?' If yes, draft a short note (decisions, numbers agreed, client commitments, follow-ups; no raw transcript), show it, and save it with brain_remember only after the owner approves the exact text.
- "The owner" is the person you are working with. Make the offer only when the Financial Brain's brain_remember tool is available here, and only once per session; a no stands for that session.
- The note you show starts "As of <YYYY-MM-DD>,". Save it as one record: a one-line title saying what it is, the body exactly as approved, confidence "verified" with verification "The owner approved this exact text on <YYYY-MM-DD>.", and no other fields. Quote figures exactly as agreed and never add one. If the reply refuses it, fix only what the reply names and ask the owner again before saving.
<!-- END Financial Brain money-question rules -->
