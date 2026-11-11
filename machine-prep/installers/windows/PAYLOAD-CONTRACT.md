# Windows x64 payload contract (unsigned review candidate)

This candidate carries the current CLI, private runtime and terminal setup
launcher. It is lane evidence, not a signed release or first-answer approval.
The production MSBuild verifier requires `evidence=real` as well as exact
version and generated-authoring readback. Synthetic stages remain usable for
fixture and self-check APIs but cannot pass the installer compilation gate.
The setup child retains an allowlisted environment and a bounded PATH containing
the private runtime, System32 and the official `%USERPROFILE%\.local\bin`
Claude directory. The profile must be absolute and contain no PATH delimiter,
quote or control character. Desktop PATH and loader overrides are not inherited.
The source SHA in a local receipt is the worktree base; the inventory identifies
the supplied bytes, including uncommitted helper changes. MAIN must rebuild from
the exact reviewed commit and record the final signed MSI identity separately.

## Inventory and pins

The default destination is `%LOCALAPPDATA%\FinancialBrain\app\<version>\`:

```text
runtime/
  node.exe
  LICENSE
  npm, npm.cmd, npx, npx.cmd
  node_modules/npm/...             private official npm, including empty directories
cli.tgz                           npm pack --ignore-scripts from this tree
cli/                              extraction of that exact archive
  package.json, brain.mjs, ...
  node_modules/...                 the package's bundled dependencies
payload.mjs
launcher.mjs
start-brain-setup.ps1
payload-receipt.json
```

Node is pinned to **24.13.1, Windows x64**. Its official ZIP is
`https://nodejs.org/dist/v24.13.1/node-v24.13.1-win-x64.zip`, SHA-256
`fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279`.
The builder fetches `SHASUMS256.txt` from that same official release directory,
requires the exact pinned record, then verifies the ZIP before extraction.
Both downloads stay inside the explicitly supplied `.lane-scratch` directory.

The selected runtime inventory SHA-256 is
`4bee47218eb338fe490e628d21ccd51dd1bb377ff563a9b4dd9e7aac2568b38d`.
It covers 1,832 files, plus directories, derived from the authenticated ZIP.
The separate tree pin prevents an authentic archive from authenticating an
unrelated supplied runtime. Upstream machine-wide tool-install scripts are
excluded. The real builder extracts the CLI directly from its recorded archive;
no global npm install, install lifecycle script, dependency resolution, or PATH
change occurs while assembling the payload.

`inventory(root)` matches the macOS contract's recursive sorted rows:
`path`, `kind`, `mode`, and, for files, `size` and `sha256`. Paths use `/` in JSON
on both platforms. Windows normalizes directory mode to 493 and file mode to
420 because POSIX executable bits are not a Windows permission contract.
Directories, including empty directories, are part of exact readback. MSI
explicitly creates them; a Directory table row alone is insufficient.

Receipt schema 1 retains the macOS names `schema`, `evidence`, `version`,
`architecture`, `source_sha`, `binding`, and `inventory`. Input components retain
`runtime.root/version/inventory` and `cli.root/archive/inventory`. File identities
use `path/size/sha256`. Windows architecture is `x64`; `runtime.archive` also
records the official ZIP. The installed binding retains runtime version and
inventory digest, CLI archive size/digest and tree digest. Absolute build input
paths are omitted from the installed receipt. Node's LICENSE is carried in the
runtime; dependency license files remain inside the exact archive/tree.

The receipt excludes itself from its recursive inventory. Its bytes, together
with the helpers, require the external MSI identity and signature. An unsigned
receipt detects accidental drift, not a malicious same-user rewrite of both
verifier and receipt. This candidate has no signed native bootstrap or sealed
native binding comparable to the macOS proposal. MAIN must review that trust
boundary before customer release; signing only the outer MSI does not provide
ongoing protection against same-user application-file replacement.

## Staging and build

`stagePayload({receipt, destination}, {checkpoint})` accepts parsed inputs. It
refuses occupied or overlapping destinations, verifies inputs before copying,
uses an exclusive adjacent staging lock, verifies copied bytes, and publishes
through one rename after full readback. Failures clean only the attempt's own
temporary directory and lock. Abrupt termination can leave a lock; it is never
silently adopted. Links, junctions, hard links, changed files, extra entries,
missing entries and non-x64 PE headers refuse. A header is architecture screening,
not standalone provenance proof.

`evidence: synthetic` accepts inert fixture artifacts with recorded digests and
performs no download. The JS self-check seam accepts synthetic fixtures; those
fake runtimes are never executable installers. Synthetic setup is refused.
`evidence: real` additionally requires the official ZIP and selected runtime tree
pins. Direct CLI dependencies require exact versions and matching package
records. The entire transitive tree is covered by its inventory.

Transient Windows rename sharing violations receive at most eight attempts,
with 50 ms waits and fresh verification before each attempt. An occupied
destination stops recovery without touching its contents. Publication is read
back again before staging reports success. The bounded retry and race refusal
have deterministic injected tests as well as the observed host-lock regression.

From a prepared source checkout, use explicit absolute build-host paths:

```powershell
node machine-prep/installers/windows/build-payload.mjs <repository> <absent-scratch-directory> <npm-cli.js> <source-sha>
dotnet build machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj --configuration Release -p:WixOsmfConfirmed=true "-p:PayloadBuildNode=<build-node.exe>" "-p:PayloadRoot=<scratch-directory>\payload" -p:PayloadVersion=<version>
```

The renderer generates `Payload.generated.wxs` from the verified inventory;
generated authoring, payloads, downloads and build outputs are ignored. WiX's
own NuGet restore supplies WiX v7. The founder's 10-07 EULA decision authorizes
`AcceptEula=wix7` (`-acceptEula wix7`). An inline MSBuild task starts the explicit
build Node directly with a cleared, allowlisted environment and runs
`verify-build.mjs` to check the complete stage, version and generated authoring
before compilation. No shell receives the desktop environment. Native MSI inspection checks
all exact paths against the stage receipt, per-user HKCU component key paths,
app/state boundaries, empty-directory-only removals, shortcut and absence of
custom actions, automatic major upgrade, services and PATH mutations.

## Launch, updates and removal

The version-specific Start-menu shortcut targets 64-bit Windows PowerShell and
`start-brain-setup.ps1`. That script checks ancestors and rejects links before
walking descendants, then verifies every entry and byte digest **before private
Node executes**. It starts only adjacent `runtime\node.exe` with a cleared,
allowlisted environment. It never discovers a preinstalled Node. `launcher.mjs`
repeats exact verification before invoking adjacent `cli\brain.mjs setup`.
`-SelfCheck` / `--self-check` verify without starting setup or accessing a provider.
The script and JS verifier are compatible with Windows PowerShell 5.1 and
PowerShell 7; PowerShell 7 is not an installation prerequisite.

The manifest default remains the owner's `Financial Brain\brain.manifest.json`.
The launcher opens the existing CLI's terminal setup, not a new native graphical
wizard. Git, Claude, provider sign-in, account approval and first-answer gates
are not bypassed or claimed as complete by carrying Node and the CLI.

Versions coexist with separate Start-menu entries. `UpgradeStrategy="none"` is
explicit: WiX otherwise inserts a major upgrade even if no MajorUpgrade element
is authored (see the [WiX Package schema](https://docs.firegiant.com/wix/schema/wxs/package/)). Installing a newer version preserves the older folder and shortcut
through new-version verification, and retains it afterward until explicit
uninstall. There is no silent current-version pointer or automatic provider
update. The owner chooses the new version's shortcut; updating the remote Brain
remains a separate normal CLI operation.

The version's install location is saved in its HKCU key and searched in the
64-bit registry view before native repair/uninstall costing. This also preserves
a reviewed custom path containing spaces. Native uninstall removes only that
MSI's registered application files, its shortcut and empty directories. Unknown
extra files are left for review. There is no wildcard or recursive removal.
Owner state in LocalAppData\FinancialBrain, manifests, credentials, documents,
`.brain` material and remote Brain data survive. Other installed versions survive.

## Host evidence and remaining gates

Observed host: Windows x64 build **26200.9711**, effective Standard account.
Windows PowerShell **5.1.26100.9711** was present. PowerShell **7.6.9** was tested
from a portable scratch download verified against the official GitHub asset's
SHA-256 (`ce7484804c0f0ad4dda10c958e71acdaf7eebfb22505c1b480f89e0e9f1da94d`).
No Windows policy or machine-wide installation was changed. Missing .NET was
installed with Microsoft's `dotnet-install.ps1`, CurrentUser-only, SDK
**10.0.403** under `%LOCALAPPDATA%\Microsoft\dotnet`. WiX came from NuGet restore.

Final rerun results and exact artifact/inventory digest summaries are recorded
in the lane's `REPORT.md`. Local raw exit codes, MSI logs and installed file
inventories with SHA-256 values remain under ignored `.lane-scratch/`.
Intermediate failures were retained: missing custom-path persistence and omitted
empty runtime directories were both detected, given red regressions, corrected,
and rerun. A verified MSI build is distinct from a successful native launch.

| Host check | Observation |
| --- | --- |
| Original completeness regression | Red; legacy per-user script control green |
| Synthetic staging and launch refusals | Changed, extra, missing, wrong architecture and junction refused |
| Real archive and private CLI | Official checksum matched; offline CLI version probe 0.4.26 passed |
| Three restoring mutants | Skipped launch digest, accepted extra file, destructive owner-state uninstall all red |
| Unsigned WiX build | Exit 0; 2,570 ICE91 per-user notices, zero errors |
| Native install, default and spaces paths | Exit 0 at both paths |
| Shortcut target, headless, PowerShell 5.1 | Exit 0 at both paths |
| Installed private CLI, offline version probe | Exit 0, version 0.4.26, at both paths |
| PowerShell 7 self-check | Exit 0 at both paths |
| Second install / forced repair | Exit 0 at both paths |
| Tampered CLI under PowerShell 5.1 and 7 | Exit 2 for both versions at both paths |
| Restore using native MSI repair | Exit 0; subsequent exact verification exit 0 |
| Native uninstall, default and spaces paths | Exit 0; version folder and shortcut absent |
| Independent staged/installed digest comparison | All 2,570 files match at both paths, including receipt |
| Invalid inherited NODE_OPTIONS | Build verifier and PowerShell launcher both exit 0 after dropping it |
| Owner state | Synthetic sentinel survived native removal |
| File-symlink fixture creation | Unavailable to this Standard account; reported skips, no policy change |
| Signing / browser SmartScreen / clean VM | Not run here; MAIN gates |

The table above records the original V2 rehearsal. Its targeted suites had 129
passed cases and 61 skips; its full graph had 473 passing and 48 failing commands
without a baseline comparison. The R1 correction reran the real-artifact gate,
unsigned build and both native install/repair/tamper/restore/uninstall paths
under PowerShell 5.1. PowerShell 7 was not present on PATH for this rerun.
The current `REPORT.md` records R1 test counts and the untouched-base comparison.

MAIN still owns signing in CI, publisher and timestamp verification, SmartScreen
from a **signed browser download**, a clean-VM first-open with no preinstalled
Node/Git/Claude/Brain, owner-controlled sign-ins and first answer, and a separately
reviewed newer-version update. All six supported OS/Node CI jobs must pass.
The new Windows payload smoke replaces thin-shell inspection for new MSIs;
macOS retains its separate legacy pinned-kit bootstrap. Historical thin-shell
receipts do not certify this payload. No signing, publishing, real sign-in,
production Brain operation or credential entry occurred in this lane.
