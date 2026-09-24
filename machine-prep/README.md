# Machine prep prototype

These two launchers prepare and diagnose the local developer tools used before a Financial Brain install day:

- `prep-mac.sh --check`
- `prep-windows.ps1 --check`

Both also support `--dry-run` and `--real`. Check and dry-run mode make no change and create no log. Real mode is per-user, writes a metadata-only log, verifies downloads, and refuses root, Administrator, fixture, or test execution.

The fixed prototype selections are Node.js 24.13.1, Claude Code 2.1.261, and Codex CLI 0.155.0-alpha.16. Financial Brain itself is not installed because the checked-in 0.4.8 candidate has no stable immutable customer asset. Wrangler is not installed globally. The Brain package owns its fixed `wrangler@4.131.1` runtime.

The scripts are intentionally outside the npm package allowlist. A prerequisite downloader cannot depend on the package it exists to prepare, and the held package is not a public distribution channel. Publication needs a separately reviewed, signed prework asset and physical clean-machine acceptance on Mac and Windows.

The hidden `--verify-checksum FILE SHA256` seam exists for deterministic refusal tests. It performs no installation.

## Double-click installer sources

- `installers/macos/build-pkg.sh` builds an unsigned Apple `.pkg` with `pkgbuild` and `productbuild`. Installer owns the one authorization prompt, while the real prep runs in the signed-in user's session.
- `installers/windows/FinancialBrainMachinePrep.wixproj` builds an unsigned per-machine MSI. Windows Installer owns the one UAC prompt, and the embedded PowerShell uses `-ExecutionPolicy Bypass` only for that child process.
- Both installers keep a client-shareable `installer.log`, open Claude Desktop through the supported `claude://code/new` deep link with a reviewed prompt, and fall back to the installed Claude Code CLI.
- `SIGNING.md` records the owner decisions, current vendor prices, warning behavior, and future CI secret boundaries. The current workflow uploads review artifacts only and never signs, notarizes, publishes, tags, or releases them.

The Windows workflow is manual because WiX v7's binary SDK carries an Open Source Maintenance Fee decision. The Mac job can run independently. Neither artifact is client-ready until signing, clean physical-machine opening, user-context execution, handoff, and uninstall behavior pass on supported hardware.
