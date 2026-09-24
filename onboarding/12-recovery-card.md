# Financial Brain recovery card

Complete this with the owner during install. Store the completed card in the
owner's password manager. Do not put a credential value, recovery code, source
file name, document title, or private content on this card.

## Brain identity

- Owner label for this Brain:
- Installed Brain version:
- Cloudflare account label or approved internal reference:
- Exact manifest backup location:
- Owner-backup folder location:
- Backup retention in days:
- Optional backup encryption: off / Keychain locator recorded

## Credential custody

- Admin-key password-manager item name:
- Admin-key protected local store: Keychain / DPAPI / owner-only Linux file
- Optional backup-encryption password-manager item name:
- Cloudflare account recovery method reviewed: yes / no

The password-manager item contains the admin-key value. This card contains only
the item name. The install is not handed off until the owner confirms the item
is saved outside the Brain computer and can be found without the installer.

## Recovery checks

- Manual `brain backup <manifest>` completed at:
- Daily backup schedule installed or native scheduler task recorded: yes / no
- Backup receipt says `admin_key_included: false`: yes / no
- Exact manifest visible from another owner-controlled device: yes / no
- Password-manager item visible from another owner-controlled device: yes / no
- `brain machine-continuity <manifest> --json` last reviewed at:
- Disposable restore rehearsal last completed at:
- Next recovery review date:

## First response

1. Stop ingest, update, removal, and restore commands.
2. Keep the exact manifest and newest receipts.
3. Preview `brain rewind-last` for the most recent protected operation, or preview
   `brain restore --to <RFC3339-time>` for an older point.
4. Have the owner review the fresh fingerprint before any restore.
5. If the computer is lost, recover the manifest and password-manager item
   first. Never run setup against a guessed or similarly named resource.
6. If compromise is possible, rotate the key. Do not restore the old value.
