# Windows DPAPI helper signing

The installer can use a prebuilt, Authenticode-signed DPAPI helper instead of
compiling an unsigned executable on the owner's computer. The signed helper is
optional until the signing identity is configured and a reviewed artifact is
adopted into the package.

The workflow is `.github/workflows/windows-dpapi-signing.yml`. It runs only by
manual dispatch, signs only from the repository's default branch, and uses the
protected `artifact-signing` GitHub environment. It stores no Azure secret.
GitHub OIDC authenticates one Entra app registration, and that app receives
only the Artifact Signing certificate-profile signer role.

Portal labels below are **from memory, unverified offline**. Microsoft can
rename a blade without changing the underlying resource. Confirm the labels in
the current Azure and GitHub interfaces before granting access.

## 1. Create the Public Trust certificate profile

1. In the Azure portal, open **Artifact Signing** and select the existing
   signing account. If the account does not exist yet, create it in the Azure
   subscription and region the owner intends to use.
2. Open **Certificate profiles**, then choose **Create**.
3. Choose **Public Trust** as the profile type.
4. Enter a stable profile name. Select the existing validated organization
   identity for Financial Brain LLC. Do not start a second identity validation.
5. Review the publisher fields and create the profile. Record the exact profile
   name, including case.

## 2. Create the OIDC app registration

1. Open **Microsoft Entra ID > App registrations > New registration**.
2. Give the app a purpose-specific name, keep it single-tenant, and leave the
   redirect URI empty.
3. On the app's **Overview**, record **Application (client) ID** and
   **Directory (tenant) ID**.
4. Open **Certificates & secrets > Federated credentials > Add credential**.
5. Choose the GitHub Actions federated-credential scenario and enter:

   - Organization: `guldanjaMAX`
   - Repository: `financial-brain-installer`
   - Entity type: `Environment`
   - Environment: `artifact-signing`

6. Save the credential. Do not create a client secret.

In the GitHub repository, create an environment named `artifact-signing` under
**Settings > Environments**. Restrict its deployment branches to the default
branch and require the owner's review. The workflow checks the ref itself as a
second guard. The federated subject is therefore:

```text
repo:guldanjaMAX/financial-brain-installer:environment:artifact-signing
```

## 3. Grant the one signing role

1. Return to the Artifact Signing account and open the new certificate profile.
2. Open **Access control (IAM) > Add > Add role assignment**.
3. Select **Artifact Signing Certificate Profile Signer**.
4. Assign access to **User, group, or service principal**, then select the app
   registration created above.
5. Review and assign. Scope the role to the certificate profile. Do not grant a
   subscription-wide contributor role.

## 4. Add the six repository variables

In GitHub, open **Settings > Secrets and variables > Actions > Variables** and
add these repository variables. None is a secret:

| Variable | Azure source |
| --- | --- |
| `AZURE_TENANT_ID` | Entra app registration **Overview > Directory (tenant) ID** |
| `AZURE_CLIENT_ID` | Entra app registration **Overview > Application (client) ID** |
| `AZURE_SUBSCRIPTION_ID` | Azure portal **Subscriptions > selected subscription > Subscription ID** |
| `ARTIFACT_SIGNING_ENDPOINT` | Artifact Signing account **Overview > Account endpoint** |
| `ARTIFACT_SIGNING_ACCOUNT` | Artifact Signing account **Overview > Name** |
| `ARTIFACT_SIGNING_PROFILE` | Artifact Signing account **Certificate profiles > selected profile > Name** |

If any variable is absent, the manual workflow builds the ordinary unsigned
development helper, reports that signing is not configured, skips Azure login,
signing, verification, and upload, and exits successfully.

## 5. Produce and adopt the signed helper

1. From the default branch, manually run **windows-dpapi-signing** and approve
   the `artifact-signing` environment deployment.
2. Download the `windows-dpapi-helper-signed` workflow artifact.
3. Review the run and verify that its signature step required `Valid`, an RFC
   3161 timestamp, and a signer subject containing `O=Financial Brain LLC`.
4. In a separate reviewed change, place both artifact files at:

   - `operations/windows-dpapi-helper.exe`
   - `operations/windows-dpapi-helper.sha256`

5. Add both exact paths to the package privacy allowlist in
   `test/package-privacy.test.mjs`. Run the package contract and Windows DPAPI
   release gates before release review.

The runtime accepts the shipped helper only when its bytes match the SHA-256
pin, `Get-AuthenticodeSignature` returns `Valid`, and the signer subject
contains `O=Financial Brain LLC`. A missing helper, missing or malformed pin,
pin mismatch, signature-check error, any non-`Valid` signature status, or wrong
signer records a fixed reason and falls back to today's local `csc.exe` build.
Credential bytes are not read until after that selection.

## PowerShell scripts

The package also contains PowerShell scripts. **From memory, unverified:**
Smart App Control primarily makes reputation and code-integrity decisions about
executables, while PowerShell script admission also depends on execution policy
and enterprise policy. The repository evidence identifies the intermittent
refusal at the freshly compiled DPAPI EXE launch, not at a `.ps1` launch. This
change therefore does not Authenticode-sign PowerShell scripts. Revisit script
signing only after a Windows policy matrix supplies direct evidence that one of
the shipped scripts is blocked.
