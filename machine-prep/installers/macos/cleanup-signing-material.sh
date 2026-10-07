#!/usr/bin/env bash
# Remove only the deterministic signing keychain marked by this workflow run.
set -u

keychain=${SIGNING_KEYCHAIN:?signing keychain path required}
marker=${SIGNING_KEYCHAIN_MARKER:?signing keychain marker path required}
attempt_id=${SIGNING_ATTEMPT_ID:?signing attempt id required}
security_command=${SIGNING_SECURITY_COMMAND:-/usr/bin/security}
runner_temp=${RUNNER_TEMP:?runner temp required}
cleanup_failed=0

printf 'KEYCHAIN_CLEANUP_DECISION_REACHED=1\n'
if [ -e "$keychain" ] || [ -L "$keychain" ]; then
  marker_value=""
  if [ -f "$marker" ]; then marker_value=$(/bin/cat "$marker" 2>/dev/null || true); fi
  if [ "$marker_value" != "$attempt_id" ]; then
    printf 'KEYCHAIN_CLEANUP_STOP_UNOWNED=1\n' >&2
    cleanup_failed=1
  elif ! "$security_command" delete-keychain "$keychain" >/dev/null 2>&1; then
    printf 'KEYCHAIN_CLEANUP_FAILED=1\n' >&2
    cleanup_failed=1
  elif [ -e "$keychain" ] || [ -L "$keychain" ]; then
    printf 'KEYCHAIN_CLEANUP_FAILED=1\n' >&2
    cleanup_failed=1
  else
    /bin/rm -f "$marker" || cleanup_failed=1
  fi
elif [ -e "$marker" ] || [ -L "$marker" ]; then
  marker_value=""
  if [ -f "$marker" ]; then marker_value=$(/bin/cat "$marker" 2>/dev/null || true); fi
  if [ "$marker_value" = "$attempt_id" ]; then
    /bin/rm -f "$marker" || cleanup_failed=1
  else
    printf 'KEYCHAIN_CLEANUP_STOP_UNOWNED=1\n' >&2
    cleanup_failed=1
  fi
fi

/bin/rm -f "$runner_temp/application.p12" "$runner_temp/application.pem" \
  "$runner_temp/installer.p12" "$runner_temp/installer.pem" "$runner_temp/notary-key.p8" || cleanup_failed=1

if [ "$cleanup_failed" -ne 0 ]; then
  printf 'KEYCHAIN_CLEANUP_FAILED=1\n' >&2
  exit 1
fi
printf 'KEYCHAIN_CLEANUP_VERIFIED=1\n'
