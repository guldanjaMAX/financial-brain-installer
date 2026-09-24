# Uninstall notes for macOS

The installer shell is separate from the user-owned tools it prepares.

1. Ask support to confirm which tools are shared with other work before removing anything.
2. Remove `/Library/Application Support/FinancialBrainMachinePrep` and forget package receipt `com.financialbrain.machineprep` with administrator approval.
3. The metadata-only support log is `~/.local/state/financial-brain-machine-prep/installer.log`.
4. Node.js, Claude Code, Codex, Git, and any later Financial Brain installation remain in their documented per-user or Apple-managed locations. They are deliberately not removed by uninstalling the installer shell.

No uninstall step removes source documents, manifests, credentials, or a Brain. Those require their own reviewed owner workflow.
