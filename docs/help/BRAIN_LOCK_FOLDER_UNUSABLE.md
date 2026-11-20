---
code: BRAIN_LOCK_FOLDER_UNUSABLE
title: Windows could not open a Brain lock folder
applies_to: Windows, commands using the Brain lifecycle lock
catalog_source: support-recovery.mjs:72
---
# Windows could not open a Brain lock folder
**What this means.** Windows could not safely use `%ProgramData%\FinancialBrain\locks`, `%LOCALAPPDATA%\FinancialBrain\locks`, `<Windows user profile>\AppData\Local\FinancialBrain\account-locks`, or the explicit `BRAIN_LIFECYCLE_LOCK_ROOT` override. The account or selected folder may be inaccessible, or unsafe because it is a link, junction or non-directory. An unusable default shared boundary alone permits private-only acquisition with BRAIN_LOCK_FOLDER_PER_USER. This command stopped before acquiring a writer lock. Existing documents, locks and recovery records were kept.

**What you do.**
1. Ask the installer to inspect folder access and links as this Windows user, including the account-locks folder and the explicit override if one is set. Fix guide: https://financialbrain.ai/help/BRAIN_LOCK_FOLDER_UNUSABLE.
2. Keep existing locks and recovery records. Retry the same command after access is fixed.

**What Claude can do for you.** An assistant can first inspect the folder setting and access failure locally. It must ask before changing permissions or an override; it must not remove a lock or recovery record to make a retry pass.

**The provider's own words.** This is a local Windows failure, not a provider response: “BRAIN_LOCK_FOLDER_UNUSABLE: Windows cannot use %ProgramData%\FinancialBrain\locks or %LOCALAPPDATA%\FinancialBrain\locks.”

**If it still fails.** Send the code and the failure text to the installer or support contact. Never send a key, token or password.

**Safe to run again?** After the folder-access step above.
