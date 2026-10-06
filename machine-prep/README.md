# Machine prep prototype

These two launchers prepare and diagnose the local developer tools used before a Financial Brain install day:

- `prep-mac.sh --check`
- `prep-windows.ps1 --check`

Both also support `--dry-run` and `--real`. Check and dry-run mode make no change and create no log. Real mode is per-user, writes a metadata-only log, verifies downloads, and refuses root, Administrator, fixture, or test execution.

The fixed selections are Node.js 24.13.1, Claude Code 2.1.261, Codex CLI 0.155.0-alpha.16, and the published Financial Brain 0.4.9 kit. Real mode downloads that exact kit from its pinned HTTPS URL, requires its exact byte count and SHA-256, installs only the verified local file into the standard per-user prefix, and reads the installed version back. It refuses an existing non-ready prefix instead of overwriting it. Wrangler is not installed globally. The Brain package owns its fixed `wrangler@4.131.1` runtime.

The scripts are intentionally outside the npm package allowlist. A prerequisite downloader cannot depend on the package it exists to prepare. Customer distribution needs separately reviewed, signed installer artifacts and physical clean-machine acceptance on Mac and Windows.

The hidden `--verify-checksum FILE SHA256` seam exists for deterministic refusal tests. It performs no installation.

## Double-click installer sources

- `installers/macos/build-pkg.sh` builds an unsigned Apple `.pkg` with `pkgbuild` and `productbuild`. Installer owns the one authorization prompt, while the real prep runs in the signed-in user's session.
- `installers/windows/FinancialBrainMachinePrep.wixproj` builds an unsigned per-machine MSI. Windows Installer owns the one UAC prompt, and the embedded PowerShell uses `-ExecutionPolicy Bypass` only for those installer children.
- Both installers keep a client-shareable `installer.log`, open `brain setup` in a visible owner-controlled shell, and open Claude Desktop with a short local handoff note. The note asks Claude to guide only owner choices and contains no URL to fetch.
- `SIGNING.md` records the decision boundary. `docs/INSTALLERS-SIGNING.md` gives the current owner setup. The manual signing workflow can produce signed review artifacts but cannot publish, tag, or release them.

The Windows workflow is manual because WiX v7's binary SDK carries an Open Source Maintenance Fee decision. The Mac job can run independently. Missing signing settings skip the corresponding job cleanly. Neither artifact is client-ready until signing, clean physical-machine opening, user-context execution, setup launch, handoff, and uninstall behavior pass on supported hardware.
