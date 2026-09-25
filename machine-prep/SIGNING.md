# Installer signing and notarization decision

Prices and vendor behavior below were read on 2026-09-24. This repository builds unsigned review artifacts only. No signing account, certificate, key, or paid service has been created.

## Recommended decision

Use Apple Developer ID plus notarization for the macOS package. Use Microsoft Artifact Signing Basic for the Windows MSI if the public-trust identity application is available to the owner. Do not buy EV only to avoid SmartScreen. Microsoft now says EV no longer receives automatic SmartScreen reputation.

Before enabling the Windows CI build, also decide the WiX Toolset v7 Open Source Maintenance Fee. WiX states that revenue-generating users with at least US$10,000 annual gross revenue must follow its OSMF EULA. Its published small-organization tier is $10 per month for fewer than 20 people, $40 per month for 20 to 100 people, and $60 per month above 100 people. The manual workflow therefore requires `wix_osmf_confirmed=true` before it downloads the WiX binary SDK.

## macOS

Required owner actions and purchase:

1. Enroll the distributing legal person or organization in the [Apple Developer Program](https://developer.apple.com/programs/). Apple listed the membership at **$99 per year** when read on 2026-09-24.
2. Create a **Developer ID Installer** certificate. Apple says installer packages distributed outside the Mac App Store use that identity, which is distinct from a Developer ID Application identity.
3. Sign the final flat package with `productsign` or `productbuild --sign`.
4. Submit it with `xcrun notarytool submit --wait`, review the notary log, then staple the ticket with `xcrun stapler staple`. Apple documents `notarytool` as the supported replacement for `altool` and supports notarizing flat installer packages: [Apple notarization guidance](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution) and [packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).
5. Verify the exact distributed bytes with `pkgutil --check-signature`, `spctl --assess --type install`, `stapler validate`, and a SHA-256 receipt.

Client experience:

- Signed and notarized: Installer shows the verified developer identity and Gatekeeper can validate Apple's notarization ticket. The normal installer authorization is the one password or Touch ID moment.
- Unsigned: macOS says it cannot verify the developer or check whether the software was modified. The user may need System Settings > Privacy & Security > Open Anyway and another password. Apple explicitly recommends not bypassing this warning for unverified software: [Apple warning guidance](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

CI secret boundary:

- Put the Developer ID Installer certificate and its password in a protected GitHub Environment or an external signing service, never in Git, artifacts, logs, or pull requests.
- Prefer an App Store Connect API key for `notarytool`; store its issuer ID, key ID, and private key only as protected environment secrets.
- The signing job should require environment approval, download the already reviewed unsigned artifact by immutable artifact ID, sign once, notarize once, staple, verify, and upload a separate signed artifact. It must not publish a release.

## Windows

Recommended service:

- [Microsoft Artifact Signing](https://azure.microsoft.com/products/artifact-signing) Public Trust Basic was **$9.99 per month for up to 5,000 signatures**, with **$0.005 per additional signature**, when read on 2026-09-24. Premium was **$99.99 per month for up to 100,000 signatures**, then $0.005 each. Public Trust identity validation is available to eligible organizations and individuals in Microsoft's listed regions.
- Microsoft's Public Trust model is intended for publicly distributed Win32 code and Authenticode: [trust model](https://learn.microsoft.com/azure/artifact-signing/concept-trust-models). Use the Basic plan unless actual signing volume exceeds it.
- Traditional CA alternative, read from [DigiCert's current comparison page](https://www.digicert.com/signing/compare-code-signing-certificates): OV was **$696 per year with an owner-provided token** or $840 with a USB token; EV was **$972 per year with an owner-provided token** or $1,116 with a USB token. Cloud KeyLocker options were higher. Prices can change at checkout.

Client experience:

- Signed: UAC shows the verified publisher rather than Unknown publisher. A newly signed file can still show a SmartScreen unrecognized-app warning until publisher or file reputation develops.
- Unsigned: SmartScreen shows **Windows protected your PC** and requires More info > Run anyway when policy permits. Enterprise policy can block continuation. Smart App Control can block unknown unsigned code outright.
- Microsoft says OV and EV have the same first-download SmartScreen behavior now, and EV no longer bypasses reputation. See [Microsoft SmartScreen guidance](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation).

CI secret boundary:

- Prefer Artifact Signing with GitHub OIDC and Azure federated credentials. The future signing job receives `id-token: write` only inside a protected environment and keeps the account and certificate profile names in protected configuration.
- Artifact Signing keeps the private key in the managed service, so no PFX or hardware-token secret is copied into CI.
- A traditional OV or EV certificate requires an HSM, token, or vendor cloud-signing integration. Do not export a private key into a repository secret merely to make CI convenient.
- No signing credential belongs in the repository. The unsigned workflow has `contents: read`, no OIDC permission, and no signing or release step.

## Owner decisions and purchases

1. Approve or reject Apple Developer Program enrollment at $99 per year.
2. Choose Microsoft Artifact Signing Basic at $9.99 per month, or select and purchase a named OV/EV alternative after checkout pricing is reviewed.
3. Confirm whether the WiX OSMF applies and, if it does, approve the correct $10, $40, or $60 monthly tier before running the Windows artifact job.
4. Choose the legal publisher names to display on macOS and Windows and complete both identity checks.
5. Approve a protected signing environment and named reviewers. Until then, CI remains unsigned artifact-only.

## Signing workflow

`.github/workflows/installer-signing.yml` is the separate, manually dispatched signing path. It takes the numeric run ID of a reviewed `machine-prep-installers` run, downloads that run's unsigned artifact, and uploads a separately named signed artifact with a SHA-256 receipt. It never publishes a release. Both jobs run only in the protected `installer-signing` GitHub Environment; the owner must add required reviewers to that environment before the first run.

- macOS job: environment secrets `APPLE_DEVID_INSTALLER_P12_BASE64`, `APPLE_DEVID_INSTALLER_P12_PASSWORD`, `APPLE_NOTARY_KEY_P8`, `APPLE_NOTARY_KEY_ID`, and `APPLE_NOTARY_ISSUER_ID`. It imports the identity into a temporary keychain, runs `productsign --timestamp`, `pkgutil --check-signature`, `xcrun notarytool submit --wait`, reads the notary log, staples, validates, runs `spctl -a -vv -t install`, and always deletes the keychain.
- Windows job: GitHub OIDC with Azure Artifact Signing. Environment variables (not secrets) `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT_NAME`, `ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`. It signs with SHA-256 and the `http://timestamp.acs.microsoft.com` timestamp server, then requires `Get-AuthenticodeSignature` to report Valid and `signtool verify /pa /v` to pass.
- Either job stops with a "not configured yet" message before downloading anything when its secrets or variables are missing.
- The MSI's Manufacturer is the planned publisher, Financial Brain LLC. It must match the legal name validated for the Artifact Signing certificate profile before the first signed build.
- The owner approved the WiX Open Source Maintenance Fee. The unsigned Windows build still accepts the WiX v7 EULA only when `wix_osmf_confirmed=true`; otherwise it stops before downloading WiX.
