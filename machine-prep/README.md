# Machine prep prototype

These two launchers prepare and diagnose the local developer tools used before a Financial Brain install day:

- `prep-mac.sh --check`
- `prep-windows.ps1 --check`

Both also support `--dry-run` and `--real`. Check and dry-run mode make no change and create no log. Real mode is per-user, verifies downloads, and refuses root, Administrator, fixture, or test execution. The prep scripts write no log of their own; the visible launchers keep the fixed-schema `installer.log` described below.

Machine prep accepts Node.js 22 or 24, Git (any available version), and Claude Code **2.1.261 or newer** from its official native install. Codex CLI is optional: check, dry-run, and the visible launcher report whether it was found and its version when readable, but no Codex state blocks setup. The check reads known local package metadata without starting Codex; other layouts report "found; version unavailable". Claude's default native install auto-updates, so newer releases continue to pass.

The native locations come from the [vendor setup guide](https://code.claude.com/docs/en/setup): `~/.local/bin/claude` on macOS (a link into `~/.local/share/claude/versions/`) and `%USERPROFILE%\.local\bin\claude.exe` on Windows. Both visible launchers include the native folder in their tool lookup. Only a different copy selected before the native one blocks setup; unused later copies do not. A conflicting copy prompts the owner to run `claude doctor` and follow its installation warning. This checks location and version, not signature provenance or assistant login; product doctor checks login later.

Missing tools are visible owner actions because the launcher does not execute tool downloads it cannot authenticate first. When real mode stops for a required tool, it exits with code 2 before any download and says "Nothing was downloaded or installed", followed by one step for each tool needing action. Node's step selects a **v24** release and the "macOS Installer (.pkg)" or "Windows Installer (.msi)" at `https://nodejs.org/en/download`. Keep that explicit selection when the website changes its default LTS. The product engines and preflights accept Node >=22; this launcher retains its narrower existing 22/24 policy. Git keeps Apple's "Install the Command Line Tools package in Terminal" step on macOS and the Git for Windows download on Windows. Missing or unreadable Claude Code points to **Native Install (Recommended)** and the default command in the setup page's **Install Claude Code** section; a release below the floor has one step, `claude update`. No exact-version installation or Codex support request is needed. The final line asks the owner to reopen the launcher. No private path is printed.

The Financial Brain **0.4.9 kit** remains pinned. Real mode downloads the exact Brain kit without redirects, requires its exact byte count and SHA-256, installs it with an isolated npm environment into a private staging prefix, and atomically promotes only a verified result. Every existing destination fails closed rather than being reused from version text alone. Wrangler is not installed globally. The Brain package owns its fixed `wrangler@4.131.1` runtime.

The scripts are intentionally outside the npm package allowlist. A prerequisite downloader cannot depend on the package it exists to prepare. Customer distribution needs separately reviewed, signed installer artifacts and physical clean-machine acceptance on Mac and Windows.

The hidden `--verify-checksum FILE SHA256` seam exists for deterministic refusal tests. It performs no installation.

## Double-click installer sources

- `installers/macos/build-pkg.sh` builds an unsigned current-user Apple `.pkg` with `pkgbuild` and `productbuild`. It installs a visible launcher under the owner's Applications folder and has no package script phase.
- `installers/windows/FinancialBrainMachinePrep.wixproj` builds an unsigned per-user MSI under LocalAppData and installs a visible Start Menu launcher. The launcher uses `-ExecutionPolicy Bypass` only for that process.
- Both launchers keep a fixed-schema `installer.log`, open `brain setup` only after prep succeeds, propagate prep or window-launch failures, and open Claude Desktop only on the successful path. The note asks Claude to guide only owner choices and contains no URL to fetch.
- Both launchers write their status markers to `installer.log` only and show the owner plain sentences instead. The prep's own lines reach the screen with its status markers and banner hidden; only its standard output is filtered, so refusals and owner steps on standard error are never hidden. The Windows OS decision also stays in `installer.log`; an unsupported PC gets a plain sentence on screen. After a failed prep, each launcher ends with one plain sentence asking the owner to reopen it. On every failure the Windows launcher waits for Enter, because its Start Menu window would otherwise close before the owner could read it.
- `SIGNING.md` records the decision boundary. `docs/INSTALLERS-SIGNING.md` gives the current owner setup. The manual signing workflow can produce signed review artifacts but cannot publish, tag, or release them.

The Windows workflow is manual because WiX v7's binary SDK carries an Open Source Maintenance Fee decision. The Mac job can run independently. Missing signing settings skip the corresponding job cleanly. Neither artifact is client-ready until signing, clean physical-machine opening, user-context execution, setup launch, handoff, and uninstall behavior pass on supported hardware.

The signing workflow also defines fresh hosted-runner checks of each exact
signed artifact after upload. The [clean smoke plan](../docs/INSTALLER-CLEAN-SMOKE.md)
documents their current-user install, signature, payload and removal checks,
separate pinned-kit bootstrap/version jobs, and short Windows and Mac observations.
A passing shell smoke is not a CLI or customer-readiness result.

Explicit `--prepare-cli` mode installs only the pinned CLI with Node.js and npm
already available. It preserves normal-user, fixture refusal, verified-download
and clean-prefix guards. It never opens setup or checks assistant logins.
The visible launchers continue to use `--real` and the required Claude Code check; Codex remains optional.
Both install modes use offline npm on the authenticated local archive; missing
bundled dependencies are a failure. Hosted bootstrap receipts prove the current
0.4.9 kit only. The clean smoke plan lists every constant to re-pin after the
0.4.10 seal.
