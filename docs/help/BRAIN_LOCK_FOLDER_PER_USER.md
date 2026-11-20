---
code: BRAIN_LOCK_FOLDER_PER_USER
title: Brain commands are locked for this Windows user
applies_to: Windows, commands using the Brain lifecycle lock
catalog_source: support-recovery.mjs:71
---
# Brain commands are locked for this Windows user
**What this means.** Windows could not safely acquire the shared lock at `%ProgramData%\FinancialBrain\locks`. The command continues with private Windows account locks. Another Windows account cannot see them, and an older Brain tool may still use the shared folder.

**What you do.**
1. Keep running Brain commands from this Windows account. Do not run an older Brain tool at the same time, or simultaneous Brain work in another account.
2. If more than one account needs to run Brain commands, ask the installer to review folder access. Fix guide: https://financialbrain.ai/help/BRAIN_LOCK_FOLDER_PER_USER.

**What Claude can do for you.** An assistant can first inspect which Windows account and lock-folder setting are in use. It must ask before changing folder permissions or an explicit lock-folder override, and keep existing locks and recovery records.

**The provider's own words.** This is a local Windows warning, not a provider response: “BRAIN_LOCK_FOLDER_PER_USER: Using private Windows account locks; another Windows account on this PC cannot see this lock or its recovery fence. Run Brain commands from this Windows account. Do not run an older Brain tool at the same time. https://financialbrain.ai/help/BRAIN_LOCK_FOLDER_PER_USER”

**If it still fails.** Send the code and the warning text to the installer or support contact. Never send a key, token or password.

**Safe to run again?** Yes, from the same Windows account, with no older Brain tool running at the same time. The warning itself does not stop the command.
