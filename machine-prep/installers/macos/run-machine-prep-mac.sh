#!/usr/bin/env bash
# Runs only when the owner opens the installed per-user launcher. Installer
# never invokes this script as root or guesses which console user owns it.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd)
LOG_DIR="${MACHINE_PREP_LOG_DIR:-$HOME/.local/state/financial-brain-machine-prep}"
LOG_FILE="$LOG_DIR/installer.log"
PREP_RUNNER="${MACHINE_PREP_RUNNER:-$SCRIPT_DIR/prep-mac.sh}"
OPEN_RUNNER="${MACHINE_PREP_OPEN:-/usr/bin/open}"
HANDOFF_RUNNER="${MACHINE_PREP_HANDOFF:-$SCRIPT_DIR/handoff/handoff-mac.sh}"
/bin/mkdir -p "$LOG_DIR"
/bin/chmod 700 "$LOG_DIR"
: > "$LOG_FILE"
/bin/chmod 600 "$LOG_FILE"

emit_status() {
  case "$1" in
    LOG_SCHEMA_DECISION_REACHED=1|INSTALLER_PROGRESS=*|PREP_EXIT_CODE=*|SETUP_LAUNCH_DECISION_REACHED=*|SETUP_WINDOW_STARTED=*|INSTALLER_HANDOFF_STARTED=*|INSTALLER_HANDOFF_EXIT_CODE=*) ;;
    *) printf 'REFUSED non-schema installer log event\n' >&2; return 2 ;;
  esac
  printf '%s\n' "$1" | /usr/bin/tee -a "$LOG_FILE"
}

emit_status 'LOG_SCHEMA_DECISION_REACHED=1'
emit_status 'INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain'
set +e
/usr/bin/env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" \
  PATH="$HOME/.financial-brain/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" BRAIN_NO_WRANGLER_LOGIN=1 \
  MACHINE_PREP_HOME="$HOME" "$PREP_RUNNER" --real
prep_status=$?
set -e
emit_status "PREP_EXIT_CODE=$prep_status"

if [ "$prep_status" -ne 0 ]; then
  emit_status 'INSTALLER_PROGRESS=2/4 Prep needs attention; setup was not opened'
  emit_status 'SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed'
  exit "$prep_status"
fi

emit_status 'INSTALLER_PROGRESS=2/4 Tool and CLI checks completed'
emit_status 'SETUP_LAUNCH_DECISION_REACHED=1'
set +e
"$OPEN_RUNNER" -a Terminal "$SCRIPT_DIR/start-brain-setup.command"
setup_status=$?
set -e
if [ "$setup_status" -ne 0 ]; then
  emit_status 'SETUP_WINDOW_STARTED=0'
  exit "$setup_status"
fi
emit_status 'SETUP_WINDOW_STARTED=1'

emit_status 'INSTALLER_PROGRESS=3/4 Opening the local Claude handoff'
set +e
"$HANDOFF_RUNNER"
handoff_status=$?
set -e
emit_status "INSTALLER_HANDOFF_EXIT_CODE=$handoff_status"
if [ "$handoff_status" -ne 0 ]; then
  emit_status 'INSTALLER_HANDOFF_STARTED=0'
  exit "$handoff_status"
fi
emit_status 'INSTALLER_HANDOFF_STARTED=1'
emit_status 'INSTALLER_PROGRESS=4/4 Installer handoff completed'
