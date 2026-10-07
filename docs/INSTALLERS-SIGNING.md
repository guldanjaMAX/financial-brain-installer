# Signing the double-click installers

The manual `installer-signing` workflow builds signed review artifacts. It does not publish a release, create a tag, or make an artifact customer-ready. Set the repository variable `SIGNING_REPOSITORY` to the exact `owner/repository` slug. The workflow refuses a wrong-repository or non-default-branch dispatch before either signing job enters the protected `artifact-signing` environment. If any required setting is absent, the matching job skips cleanly.

## Apple setup

1. Open Keychain Access on a trusted Mac. Choose Certificate Assistant, then Request a Certificate From a Certificate Authority. Save the CSR to disk and keep its private key in that login keychain.
2. In Apple Developer Certificates, Identifiers & Profiles, create a **Developer ID Application** certificate from the CSR. Download it, add it to Keychain Access, and export the identity as a password-protected `.p12`.
3. Create a separate **Developer ID Installer** certificate. Download it, add it to Keychain Access, and export that identity as its own password-protected `.p12`.
4. In App Store Connect, open Users and Access, Integrations, then Team Keys. Create an API key and choose the Developer role. Record its key ID and issuer ID, and download its `.p8` once.
5. Find the ten-character Team ID in the Apple Developer membership details.
6. Create or update the protected GitHub environment named `artifact-signing`. Restrict it to the default branch and require the owner's approval.
7. Add these environment secrets:

   - `APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64`
   - `APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD`
   - `APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64`
   - `APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD`
   - `APPLE_NOTARY_KEY_ID`
   - `APPLE_NOTARY_ISSUER_ID`
   - `APPLE_NOTARY_KEY_P8_BASE64`

8. Add `APPLE_TEAM_ID` as an environment variable.

Base64 values contain the exact binary `.p12` or `.p8` bytes. Passwords and private-key bytes never belong in source, workflow inputs, logs, or artifacts.

The workflow imports both identities into a temporary keychain. It uses `codesign` for every embedded Mach-O executable, `productsign` with the Developer ID Installer identity for the package, `xcrun notarytool submit --wait`, and `xcrun stapler staple`. It then checks Gatekeeper, the package signature, the staple, and the final SHA-256 before retaining the review artifact.

## Windows setup

Use the identity, federated credential, role, and portal procedure in `docs/WINDOWS-SIGNING.md` from PR #132. That change must land before this guide's cross-reference is considered complete.

The same protected `artifact-signing` environment supplies these six variables:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `ARTIFACT_SIGNING_ENDPOINT`
- `ARTIFACT_SIGNING_ACCOUNT`
- `ARTIFACT_SIGNING_PROFILE`

There is no Azure client secret. GitHub OIDC authenticates the job, and the app registration receives only the Artifact Signing Certificate Profile Signer role on the selected signing account.

When manually dispatching the workflow, set `wix_osmf_confirmed=true` only after the WiX v7 Open Source Maintenance Fee decision is confirmed. A false value skips the Windows job before WiX is downloaded. The job builds the MSI, signs it through Artifact Signing, requires a valid RFC 3161 timestamp, verifies it with Authenticode and `signtool`, and records the final SHA-256.
