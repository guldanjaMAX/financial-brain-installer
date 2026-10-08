# Machine prep prototype

These two launchers prepare and diagnose the local developer tools used before a Financial Brain install day:

- `prep-mac.sh --check`
- `prep-windows.ps1 --check`

Both also support `--dry-run` and `--real`. Check and dry-run mode make no change and create no log. Real mode is per-user, verifies downloads, and refuses root, Administrator, fixture, or test execution. The prep scripts write no log of their own; the visible launchers keep the fixed-schema `installer.log` described below.

The fixed selections are Node.js 24.13.1, Claude Code 2.1.261, Codex CLI 0.155.0-alpha.16, and the published Financial Brain 0.4.9 kit. Missing prerequisites are visible owner actions because the launcher does not execute prerequisite downloads it cannot authenticate first. When real mode stops for a prerequisite, it exits with code 2 before anything is downloaded and prints a plain block instead of status rows: a line saying setup cannot start yet and nothing was downloaded or installed, then one line per tool that needs action. Each line names the tool, what is wrong, the version the check accepts, and one next step on an official page: the "macOS Installer (.pkg)" or "Windows Installer (.msi)" button for Node.js 24 at `https://nodejs.org/en/download`; Apple's "Install the Command Line Tools package in Terminal" section on macOS or the Git for Windows download at `https://git-scm.com/install/windows`; and the "Install a specific version" section at `https://code.claude.com/docs/en/setup#install-a-specific-version` for Claude Code. Codex CLI names no page, because no official Codex installer produces the layout the pinned check accepts; its line asks the owner to contact Financial Brain support. A last line asks the owner to reopen the launcher. No private path is printed. `--check` rows for a wrong, duplicate or displaced Claude Code or Codex name the replacement to install instead of a real-mode rerun, because real mode never installs either one. Real mode downloads the exact Brain kit without redirects, requires its exact byte count and SHA-256, installs it with an isolated npm environment into a private staging prefix, and atomically promotes only a verified result. Every existing destination fails closed rather than being reused from version text alone. Wrangler is not installed globally. The Brain package owns its fixed `wrangler@4.131.1` runtime.

The scripts are intentionally outside the npm package allowlist. A prerequisite downloader cannot depend on the package it exists to prepare. Customer distribution needs separately reviewed, signed installer artifacts and physical clean-machine acceptance on Mac and Windows.

The hidden `--verify-checksum FILE SHA256` seam exists for deterministic refusal tests. It performs no installation.

## Double-click installer sources

- `installers/macos/build-pkg.sh` builds an unsigned current-user Apple `.pkg` with `pkgbuild` and `productbuild`. It installs a visible launcher under the owner's Applications folder and has no package script phase.
- `installers/windows/FinancialBrainMachinePrep.wixproj` builds an unsigned per-user MSI under LocalAppData and installs a visible Start Menu launcher. The launcher uses `-ExecutionPolicy Bypass` only for that process.
- Both launchers keep a fixed-schema `installer.log`, open `brain setup` only after prep succeeds, propagate prep or window-launch failures, and open Claude Desktop only on the successful path. The note asks Claude to guide only owner choices and contains no URL to fetch.
- Both launchers write their status markers to `installer.log` only and show the owner plain sentences instead. The prep's own lines reach the screen with its status markers and banner hidden; only its standard output is filtered, so refusals and owner steps on standard error are never hidden. The Windows OS check line stays on screen because it is printed before `installer.log` exists. After a failed prep, each launcher ends with one plain sentence asking the owner to reopen it. On every failure the Windows launcher waits for Enter, because its Start Menu window would otherwise close before the owner could read it.
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
The visible launchers continue to use `--real` and all assistant prerequisites.
Both install modes use offline npm on the authenticated local archive; missing
bundled dependencies are a failure. Hosted bootstrap receipts prove the current
0.4.9 kit only. The clean smoke plan lists every constant to re-pin after the
0.4.10 seal.
