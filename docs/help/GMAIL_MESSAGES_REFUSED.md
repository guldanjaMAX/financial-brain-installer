---
code: GMAIL_MESSAGES_REFUSED
title: Some emails were skipped safely
applies_to: both, Gmail ingest and daily refresh
catalog_source: support-recovery.mjs:77
---
# Some emails were skipped safely
**What this means.** Some emails looked like they held a password or sign-in link, so the credential safety check skipped them. Other mail can finish updating; stored copies awaiting removal review are kept. The run summary separately names any unfinished work.
**What you do.**
1. Read the run summary for other work still pending.
2. Keep passwords and sign-in links in your password manager. The next scheduled Gmail refresh continues automatically.
3. Read [the help page](https://financialbrain.ai/help/GMAIL_MESSAGES_REFUSED) if you need the code again.
**What Claude can do for you.** Read the run summary and check whether Gmail completed. Ask before applying an exact removal plan. Keep refused email content private.
**The provider's own words.** This is a local safety decision, so no provider error is shown. Example summary: "2 emails were skipped because they looked like they held a password or sign-in link; everything else is up to date."
**If it still fails.** Send the code and the safe run summary to the installer or support contact if the same message is downloaded every run or other mail cannot finish. A code and safe run summary are enough; keep keys, tokens, passwords, email bodies and sign-in links private.
**Safe to run again?** yes. The same immutable refused message is not downloaded again under the same safety policy.
