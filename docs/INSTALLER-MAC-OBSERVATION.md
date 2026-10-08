# Owner: five-minute Mac signed-package observation

Do this only when you are back and can personally use an explicitly approved
disposable test Mac/account. The second Mac is an option only after you confirm
access and a safe test account. Do not install in your working account, create
a user on the working laptop, or ask an unattended agent to enter a password.

Support must first provide the exact signed, notarized, stapled package from a
reviewed signing run with passing Mac shell smoke and a verified checksum.
Keep its normal downloaded-file quarantine marking. A file copied out of a CI
archive may not reproduce a browser download; record that observation as
unproven if quarantine was absent rather than bypassing Gatekeeper.

1. In Finder, double-click the package. Observe the initial Gatekeeper message
   and Installer's certificate/lock details. The signing identity must match
   the reviewed package. Stop on an unidentified developer, damaged file or
   invalid certificate warning. Do not use Open Anyway or remove quarantine.
2. Install only for the current test user. This package disables the system
   domain. If Installer asks for administrator credentials or offers only a
   system-wide install, cancel and report it. The actual prompt behavior is
   what this observation is testing.
3. In your home Applications folder, confirm **Financial Brain Machine Prep**
   contains **Run Financial Brain Machine Prep.command**. Do not open that
   launcher in this packet: it starts separate preparation/downloads and can
   open setup. The present package has no bundled CLI to version-check.
4. Follow the included uninstall notes with support: remove only this test
   install's folder and forget `com.financialbrain.machineprep` in this test
   user's home receipt domain. Support's reviewed command uses
   `pkgutil --volume "$HOME" --forget com.financialbrain.machineprep`, without
   sudo. Confirm the folder and receipt are gone; leave shared tools alone.
5. Record whether trust verification, install, visible launcher and removal
   succeeded, plus counts of trust warnings and authorization prompts. Report
   no personal paths, credentials or source content.

This observes Finder/Installer trust and user scope on that Mac. Running the
visible preparation launcher, opening Terminal, downloading the pinned CLI,
executing its version command and completing setup remain a separately
approved first-run gate. It also does not cover another CPU architecture or
older supported macOS release.
