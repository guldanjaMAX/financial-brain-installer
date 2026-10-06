# Machine prep prototype

These two launchers prepare and diagnose the local developer tools used before a Financial Brain install day:

- `prep-mac.sh --check`
- `prep-windows.ps1 --check`

Both also support `--dry-run` and `--real`. Check and dry-run mode make no change and create no log. Real mode is per-user, writes a metadata-only log, verifies downloads, and refuses root, Administrator, fixture, or test execution.

The fixed selections are Node.js 24.13.1, Claude Code 2.1.261, Codex CLI 0.155.0-alpha.16, and the published Financial Brain 0.4.9 kit. Missing prerequisites are visible owner actions because the launcher does not execute prerequisite downloads it cannot authenticate first. Real mode downloads the exact Brain kit without redirects, requires its exact byte count and SHA-256, installs it with an isolated npm environment into a private staging prefix, and atomically promotes only a verified result. Every existing destination fails closed rather than being reused from version text alone. Wrangler is not installed globally. The Brain package owns its fixed `wrangler@4.131.1` runtime.

The scripts are intentionally outside the npm package allowlist. A prerequisite downloader cannot depend on the package it exists to prepare. Customer distribution needs separately reviewed, signed installer artifacts and physical clean-machine acceptance on Mac and Windows.

The hidden `--verify-checksum FILE SHA256` seam exists for deterministic refusal tests. It performs no installation.

## Double-click installer sources

- `installers/macos/build-pkg.sh` builds an unsigned current-user Apple `.pkg` with `pkgbuild` and `productbuild`. It installs a visible launcher under the owner's Applications folder and has no package script phase.
- `installers/windows/FinancialBrainMachinePrep.wixproj` builds an unsigned per-user MSI under LocalAppData and installs a visible Start Menu launcher. The launcher uses `-ExecutionPolicy Bypass` only for that process.
- Both launchers keep a fixed-schema `installer.log`, open `brain setup` only after prep succeeds, propagate prep or window-launch failures, and open Claude Desktop only on the successful path. The note asks Claude to guide only owner choices and contains no URL to fetch.
- `SIGNING.md` records the decision boundary. `docs/INSTALLERS-SIGNING.md` gives the current owner setup. The manual signing workflow can produce signed review artifacts but cannot publish, tag, or release them.

The Windows workflow is manual because WiX v7's binary SDK carries an Open Source Maintenance Fee decision. The Mac job can run independently. Missing signing settings skip the corresponding job cleanly. Neither artifact is client-ready until signing, clean physical-machine opening, user-context execution, setup launch, handoff, and uninstall behavior pass on supported hardware.
