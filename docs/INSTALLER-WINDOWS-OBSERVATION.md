# Windows tester: five-minute signed-MSI observation

Use only your spare clean test user on your own PC. Support must first provide
the exact signed MSI from a successful reviewed signing and smoke run, with
its checksum already verified. Do not use an unsigned build or a client PC.
This tests the installer shell; it does not install or connect a Brain.

1. Sign into the spare test user normally. Do not use Run as administrator.
   Keep the file's normal downloaded-file marking so the observation reflects
   Explorer's real trust behavior. Right-click the MSI, open Properties,
   Digital Signatures, Details. The signature must be valid and identify
   **Financial Brain LLC**. Stop if the signature is missing or invalid.
2. Double-click the MSI. A newly signed file may still show SmartScreen's
   “Windows protected your PC” warning. Count it and stop; do not select
   Run anyway or change security settings. The intended per-user install
   needs no UAC elevation. If UAC appears, count it and cancel, even if the
   verified publisher reads Financial Brain LLC. An unknown or different
   publisher is a stop. Do not enter another account's password.
3. If installation completes, search Start for **Run Financial Brain Machine
   Prep**. Count the visible launcher, but do not open it. It starts a separate
   download/preparation flow that is outside this short observation. No
   account login, credential entry or setup is requested.
4. Open Settings, Apps, Installed apps. Uninstall **Financial Brain Machine
   Prep**. Confirm its Start Menu launcher disappears. Stop if removal asks
   for elevation. Do not remove shared tools or any other app.

Reply with exactly these three lines, replacing each number with your observed
count. Use zero for a step that did not complete. Do not send names, paths,
screenshots, passwords or logs.

```text
TRUST valid=1 smartscreen=0 uac=0
INSTALL completed=1 launchers=1
UNINSTALL completed=1 launchers_remaining=0
```

These counts prove only the observed shell and dialogs. They do not prove a
clean Windows image, CLI execution or onboarding. Support must resolve any
stopped step before requesting a repeat.
