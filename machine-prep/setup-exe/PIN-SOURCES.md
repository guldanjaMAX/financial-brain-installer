# Trust pins and unresolved inputs


| Input | Offline evidence | Required before build/signing |
| --- | --- | --- |
| Node 24.13.1 x64 MSI | Existing machine-prep uses version 24.13.1; its authenticated object is a ZIP, not an MSI | `PIN_ME_NODE_MSI_SHA256`; exact MSI row at https://nodejs.org/dist/v24.13.1/SHASUMS256.txt; confirm current v24 LTS at https://nodejs.org/en/download |
| Git for Windows x64 | No release version/checksum in the named offline sources | `PIN_ME_GIT_RELEASE_TAG`, `PIN_ME_GIT_VERSION`, `PIN_ME_GIT_INSTALLER_SHA256`; official release https://github.com/git-for-windows/git/releases; record exact checksum provenance and prove per-user flags |
| Claude native installer | Existing prep points at vendor setup docs; packet supplies official bootstrap URL | MAIN checks https://code.claude.com/docs/en/setup#install-claude-code and https://claude.ai/install.ps1 on the build date; no login by bootstrap |
| Client ZIP 0.4.36 | Copied download-artifact.json: 8,527,362 bytes, SHA-256 `68d4d041f6e581d6609e3eab253a5cb43b3b8284233e5c525d09f63fac7fe59f` | Native fetch/readback. The actual ZIP was not included under in/; decoded client files are present |
| Signed Setup EXE | Source only | Compile/sign, Valid + timestamp + signtool; record actual EXE bytes/hash; native standard-user rehearsal |

`Assert-SetupPins` blocks compilation on every unresolved trust placeholder. The static self-test accepts explicitly labelled placeholders so offline scaffold checks can pass; `--release` rejects them. This distinction never constitutes release approval.

## Filled by MAIN 2026-11-28 10:5x
- Node v24.22.3 (latest v24 LTS "Krypton", 2026-11-10 per nodejs.org/dist/index.json); node-v24.22.3-x64.msi sha256 4a1ab5bd...db545 from nodejs.org/dist/v24.22.3/SHASUMS256.txt (signed .asc present).
- Git for Windows v2.56.1.windows.1 (latest release); Git-2.56.1-64-bit.exe sha256 c330c72e...a559, matching both the GitHub asset digest and the release notes table.
