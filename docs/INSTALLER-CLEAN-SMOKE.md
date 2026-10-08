# Clean signed-installer checks

## Premise corrections and this week's plan

The signed artifacts currently contain only the machine-preparation shell,
version 0.2.0. The Mac payload has eight files and the Windows payload has seven
files plus a Start Menu shortcut. Neither bundles Node or the Brain CLI. The
preparation scripts later download a separately pinned 0.4.9 kit. Running a
checkout's CLI, using runner Node, or mocking preparation would not prove a
bundled CLI. The shell jobs keep that distinction explicit. Separate bootstrap jobs prove the installed CLI from the pinned kit when they pass; they do not turn it into a bundled CLI.

The Mac distribution enables `CurrentUserHomeDirectory` and disables
`LocalSystem`. Its correct silent install is `installer -pkg <signed.pkg>
-target CurrentUserHomeDirectory`, without sudo. Installing into `/` as root
would test the wrong contract. This follows the checked-in distribution and
the native installer's documented domain target. Interactive authorization
behavior still requires a human observation.

Use separate GitHub-hosted shell and pinned-kit bootstrap jobs after the protected signing jobs, then a
short Windows observation in the tester's spare clean account. Reserve the Mac
observation for an available, explicitly approved test Mac/account when the
owner returns. No installation on the owner's working account is authorized.

| Option | Advantages | Costs or constraints | Proves | Does not prove |
|---|---|---|---|---|
| Fresh GitHub-hosted Mac and Windows jobs | Automated now; no owner password; disposable VMs; same-run signed artifact IDs | Runners include development tools; Windows runner is a server image and may be elevated; native trust services can need network access | Signature, checksum, current-user shell install, exact reviewed payload locations, launcher presence, installed preparation help, native removal; separate jobs prove kit bootstrap and installed CLI version | Bare consumer OS prerequisites, consumer Windows policy, Finder/Explorer prompts, SmartScreen reputation, interactive first-open, absent bundled CLI |
| Local Mac VM using Tart, UTM, or Virtualization.framework | Snapshot rollback; clean guest; potentially repeatable GUI observation | Needs compatible host hardware/OS, images, disk/RAM, software and guest preparation; prompts or authorization may require the owner; not established here | Guest installation and, with a human GUI session, guest dialogs | Physical hardware behavior; cannot be assumed unattended or already authorized on the working Mac |
| Windows tester's spare clean user | Available this week; actual Explorer, SmartScreen and user token | A clean user shares system-wide tools, policies and certificate caches; requires consent on the tester's own PC | Double-click MSI, displayed publisher, unexpected elevation, shortcut visibility, Settings uninstall | Clean Windows image, Mac behavior, absent bundled CLI or full onboarding |
| Owner's second Mac | Physical Mac and normal Finder/Installer | Availability, login and a disposable test account are not established; no remote login or user switching assumed | Physical GUI and Gatekeeper observation once owner participates | Unattended proof before access exists; other Mac architectures/OS versions |
| Disposable hosted Mac rental or an already prepared test VM | Independent clean guest without using the working account | Procurement, account access, cost and remote desktop setup; no authorization or existing machine established | Additional OS/architecture coverage and supervised GUI checks | Password-free readiness this week without prior provisioning |

An existing authorized clean Mac with an available human would be the best
additional GUI gate. Otherwise the hosted shell and bootstrap jobs plus Windows
human observation are the practical plan for this week. Do not create users, install virtualization
software, rent hardware, or contact a tester as part of implementing this plan.

## CI contract

The `installer-signing` workflow retains its manual default-branch and
repository authorization, protected `artifact-signing` environment, and WiX
confirmation. Each signing job exports only its uploaded artifact ID. Its
smoke job needs that successful job and authorization. Missing settings,
failed signing, or failed upload prevent the corresponding smoke job from
running. A skipped platform is missing evidence, not a pass.

The smoke jobs have `contents: read`, no signing environment, no OIDC grant,
and no cross-run artifact lookup. They download by exact same-run artifact ID
and check the adjacent SHA-256 before invoking any installer. The checksum
detects corruption; provenance comes from the protected signing job and exact
artifact ID, not an unauthenticated checksum alone. There is no fallback to an
unsigned build or another run. A failed prior upload requires a new authorized
signing run after these changes reach the default branch. No prior artifact's
availability or historical run success has been independently verified here.

On Mac the smoke job checks `pkgutil --check-signature`, Gatekeeper install
assessment and the stapled ticket. It expands the package, requires the exact
current-user payload and absence of package script phases, installs as the
runner user, compares installed file hashes to the signed payload, checks the
executable launcher and runs installed preparation help. Removal follows the
documented shell removal plus forgetting the receipt in the same home domain.

On Windows it requires Authenticode `Valid`, a timestamp and the exact
`O=Financial Brain LLC` signer organization. It inspects MSI directory,
component, file, shortcut, registry and removal tables before silent
`msiexec /i ... /qn /norestart /L*v ...`. It compares installed file hashes to
the signed MSI's file-hash table and checks the exact directory inventory, shortcut
target at `System32\WindowsPowerShell\v1.0\powershell.exe`, user registry marker and product registration, parses the installed
launcher, and executes only installed preparation help. It then runs
`msiexec /x` with a log and requires absent payload, shortcut, marker and
registration. Nonzero install/uninstall results, including a reboot request,
are failures. A rolled-back failed installation remains a failed smoke run.

The reviewed payload destinations are:

- Mac: `~/Applications/Financial Brain Machine Prep`, plus PackageKit's
  current-user receipt database. No preparation log is expected from help.
- Windows: `%LOCALAPPDATA%\Financial Brain Machine Prep`, the current user's
  `Programs\Financial Brain Machine Prep` Start Menu folder and
  `HKCU\Software\FinancialBrain\MachinePrep`. Windows Installer's own product
  registration, cache and logs are system bookkeeping, not product payload.
- Both: the job's temporary input, expanded inspection and diagnostic folders.

Exact payload/table checks and sentinel readbacks bound the product's install
footprint. They are not a complete filesystem-write trace of either OS package
manager. Neither the visible launcher nor setup is executed by this smoke job:
those launchers perform preparation/downloads and can open provider setup.
No manifest, Brain credential, provider login or real Brain is supplied.
Signature validation, artifact download and CI actions may contact their
platform services when the workflow is eventually run; this is not an
air-gapped runner test.

Logs are retained for 14 days, including failures. The final event
`INSTALLER_SHELL_SMOKE_PASSED=1` means only this shell contract passed.
`BUNDLED_CLI_VERSION_VERIFIED=0 reason=not_bundled` remains explicit. There is
no release, tag, publication or customer-readiness assertion.

## Separately scoped pinned-kit bootstrap

`macos-bootstrap` and `windows-bootstrap` each start on another fresh hosted
runner. They require authorization, a successful platform signing job and its
nonempty same-run signed artifact ID. They receive no signing environment,
secrets or OIDC grant. Both first perform the entire shell trust, payload,
installation and installed-file verification before running preparation.

The installed preparation script now exposes `--prepare-cli`. This explicit
mode requires supported Node.js, npm and a normal non-root/non-administrator
session, refuses fixtures/test mode, and calls the same production kit download,
length/hash verification, staged install, promotion and cleanup as `--real`.
It does not require assistant tools because it never opens setup or an
assistant. The visible launchers still use `--real` with their full prerequisite
gates. npm installs the verified local archive with `--offline --ignore-scripts`
so missing bundled dependencies fail instead of reaching a registry.

The workflow supplies pinned Node.js 24.13.1 using the existing pinned setup
action. It does not prove Node installation on a bare consumer machine.
Windows starts the whole install/bootstrap/removal run through a temporary
Task Scheduler task with the same runner SID, S4U logon and `RunLevel Limited`.
The child verifies SID equality and a non-administrator token. No password,
new user, credential helper or test-mode override is used. A host that cannot
provide this token fails; it must not fall back to elevated preparation. Task
registration, completion and removal require readback and retained receipts.

A separate HTTPS witness download requires a direct 200 response, exact
Content-Length, exact actual length and the pinned SHA-256 before extraction.
The installed script must independently download and authenticate the kit at
its production URL. The witness pins must exactly match the installed script.
Every archived package file is compared with the installed bytes, with exact
source inventory and link containment checks. npm-generated dependency command
shims are permitted only at names derived from the authenticated dependency
bin maps; they are not kit source bytes and are not executed by this proof.
The version command runs the installed package's authenticated `brain.mjs` bin
entry with the provided Node, never a checkout CLI. Node permission mode denies
subprocesses and filesystem writes, and a preload rejects network APIs. No
manifest, Brain address, credential or provider setup is supplied.

Receipts distinguish the download length/hash, installed source-file count,
installed CLI hash, exact version, CLI-prefix cleanup, shell removal and final
`INSTALLER_BOOTSTRAP_SMOKE_PASSED=1`. Cleanup is attempted even after a bootstrap
failure; a failed cleanup prevents success. Only logs are uploaded, never the
witness kit, expanded package, environment context or installed CLI copy.
Native shell install/removal remains separately tested in `*-smoke`.

The Windows package intentionally changes from `SystemFolder` (32-bit
SysWOW64 on x64) to `System64Folder` (64-bit System32). Its x64 package and Node
runtime have no declared 32-bit dependency. Both the signed MSI table and the
installed shortcut must match the 64-bit target exactly. A newly signed MSI is
required; the old artifact cannot satisfy the corrected contract.

## Re-pin after the 0.4.10 seal

All current kit proof is for **0.4.9**, exactly **6,668,013 bytes**, SHA-256
`0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2`.
It is not proof of the 0.4.10 candidate or a newly changed helper.
After the seal supplies the actual URL, length and digest, update together:

- `machine-prep/prep-mac.sh`: `BRAIN_VERSION`, `BRAIN_KIT_URL`,
  `BRAIN_KIT_SIZE`, `BRAIN_KIT_SHA256`.
- `machine-prep/prep-windows.ps1`: `$BrainVersion`, `$BrainKitUrl`,
  `$BrainKitSize`, `$BrainKitSha256`.
- `machine-prep/installers/smoke/bootstrap.mjs`: `KIT.version`, `KIT.url`,
  `KIT.size`, `KIT.sha256`.
- `test/machine-prep-installers.test.mjs`: `KIT_URL`, `KIT_SIZE`, `KIT_SHA256`
  and the version expectations/synthetic package fixtures. Update the matching
  0.4.9 fixtures/snapshots in `test/machine-prep.test.mjs` and
  `test/fixtures/machine-prep/` as part of the same reviewed version change.

Rebuild, sign and rerun both platforms after re-pinning. Do not guess the new
length, digest or content-addressed URL. Installer-shell version 0.2.0 and the
Node/assistant/Wrangler prerequisite selections are separate constants; changing
kit identity does not automatically change those versions.

Native runner execution, public kit availability, S4U behavior, Apple receipts,
PowerShell parsing, all GUI prompts and complete onboarding remain unverified
by local offline contract tests.

The short human packets are [Windows](INSTALLER-WINDOWS-OBSERVATION.md) and
[Mac](INSTALLER-MAC-OBSERVATION.md). Full local host gates, CI execution and an
independent review remain the coordinator's responsibility before sign-off.
