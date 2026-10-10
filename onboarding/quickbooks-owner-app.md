# Connect QuickBooks Online with your own private app

Preview for 0.4.12. Guided portal transfer and production field acceptance
remain held. Version 0.4.11 does not offer this production connection.

The setup page at `/app/setup?provider=quickbooks` has a **Copy setup sentence**
button. It copies this instruction for your supported browser agent:

> Connect QuickBooks Online to my Financial Brain using a private Intuit app owned by me for my company, do the setup in my browser, keep all keys out of chat, and pause only when I need to sign in or approve.

Start with an installed Brain, a paired desktop companion, a supported browser
agent, and authority over the intended Intuit company. On mobile, continue on
the paired computer. Keep that computer available for scheduled updates.

You own the Intuit app and its keys. The keys and rotating tokens stay in the
existing local provider store. macOS uses Keychain, Windows uses the declared
DPAPI protection, and the protected-file backend is plaintext with restricted
permissions. Financial Brain supplies software; it has no shared app secret
or token-exchange service.

Check the company before approving Intuit access. Intuit's Accounting consent
can grant permission to read and change accounting data; Financial Brain only
uses read/query calls. Unknown business and legal answers need your review.
There is no verified click-count promise.

The setup command is `brain connect quickbooks <manifest> --owner-app-setup`.
An explicitly selected Online connection uses
`brain connect quickbooks <manifest> --edition online`. The companion must
first establish non-secret installation, app, company and exact redirect
metadata. Missing metadata or an unavailable secure helper stops setup. Never
supply app keys in a manifest, command argument, environment variable or chat.
The sandbox keeps its separate `http://localhost:47812/` callback.

A saved key pair is not a connected grant. A connected grant is not a completed
import. Check the connection, last completed import and next scheduled check
separately. Reconnect keeps the same company and requires a new consent after
an uncertain exchange. If a saved completion acknowledgement has expired, use
`brain connect quickbooks <manifest> --edition online --reconnect` to start a
fresh same-company consent. Ordinary retry only retries the saved acknowledgement.
Several companies on the same computer remain outside
this first flow; another source name does not create another credential slot.

Disconnect first previews with `brain disconnect quickbooks <manifest> --plan`.
After reviewing, `brain disconnect quickbooks <manifest> --confirm` requires the
paired companion to pause and verify schedules before revocation. If Intuit's
response is uncertain, local reads remain fenced. Confirmed disconnect clears
the grant and staged keys and keeps imported documents and the company
reservation. No app deletion, key rotation or document removal is performed.

The signed browser extension/native-host package, installation and pairing
ceremony, observation isolation on supported agents, portal selectors, fresh
private-app requirements, legal pages and questionnaire facts remain explicit
release seams. No installed production adapter supplies those capabilities in
this candidate. The setup page cannot accept secrets or run arbitrary commands.
A later authorized rehearsal must prove the full first-time, warm, reconnect
and disconnect journeys, company identity, exact portal redirect readback,
credential readback, scheduled reads, desktop/mobile layout and actual actions.
