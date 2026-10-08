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

# Status markers are for tests and support, not for the owner: a line whose
# first word is all capitals followed by "=" or a space, and the prep banner.
SCREEN_HIDDEN='^([A-Z][A-Z_]*([= ]|$)|Machine Prep for macOS$)'

# installer.log keeps the fixed marker schema. Markers are not shown on screen.
emit_status() {
  case "$1" in
    LOG_SCHEMA_DECISION_REACHED=1|INSTALLER_PROGRESS=*|PREP_EXIT_CODE=*|SETUP_LAUNCH_DECISION_REACHED=*|SETUP_WINDOW_STARTED=*|INSTALLER_HANDOFF_STARTED=*|INSTALLER_HANDOFF_EXIT_CODE=*) ;;
    *) printf 'REFUSED non-schema installer log event\n' >&2; return 2 ;;
  esac
  printf '%s\n' "$1" >> "$LOG_FILE"
}

# One plain line for the owner's screen. Never written to installer.log.
say() {
  printf '%s\n' "$1"
}

# Runs a child with its own lines on screen and its status markers hidden.
# Only stdout is filtered: refusals and owner steps on stderr pass untouched,
# and the child's exit code is returned, not the filter's. grep, not sed -l:
# GNU sed reads -l as a line length, swallows -E, and would hide nothing.
run_for_screen() {
  "$@" | /usr/bin/grep -v -E --line-buffered "$SCREEN_HIDDEN"
  return "${PIPESTATUS[0]}"
}

emit_status 'LOG_SCHEMA_DECISION_REACHED=1'
emit_status 'INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain'
say 'Financial Brain Machine Prep: checking this Mac for the tools setup needs.'
set +e
run_for_screen /usr/bin/env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" \
  PATH="$HOME/.financial-brain/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" BRAIN_NO_WRANGLER_LOGIN=1 \
  MACHINE_PREP_HOME="$HOME" "$PREP_RUNNER" --real
prep_status=$?
set -e
emit_status "PREP_EXIT_CODE=$prep_status"

if [ "$prep_status" -ne 0 ]; then
  emit_status 'INSTALLER_PROGRESS=2/4 Prep needs attention; setup was not opened'
  emit_status 'SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed'
  say ''
  say 'Financial Brain setup has not started yet: follow the steps above, then open Run Financial Brain Machine Prep again.'
  exit "$prep_status"
fi

emit_status 'INSTALLER_PROGRESS=2/4 Tool and CLI checks completed'
emit_status 'SETUP_LAUNCH_DECISION_REACHED=1'
say 'This Mac is ready. Opening Financial Brain setup in a new Terminal window.'
set +e
"$OPEN_RUNNER" -a Terminal "$SCRIPT_DIR/start-brain-setup.command"
setup_status=$?
set -e
if [ "$setup_status" -ne 0 ]; then
  emit_status 'SETUP_WINDOW_STARTED=0'
  say 'The Financial Brain setup window did not open. Ask Financial Brain support for help.'
  exit "$setup_status"
fi
emit_status 'SETUP_WINDOW_STARTED=1'

emit_status 'INSTALLER_PROGRESS=3/4 Opening the local Claude handoff'
say 'Opening Claude to guide your next steps.'
set +e
run_for_screen "$HANDOFF_RUNNER"
handoff_status=$?
set -e
emit_status "INSTALLER_HANDOFF_EXIT_CODE=$handoff_status"
if [ "$handoff_status" -ne 0 ]; then
  emit_status 'INSTALLER_HANDOFF_STARTED=0'
  say 'Claude did not open. Continue in the Financial Brain setup window.'
  exit "$handoff_status"
fi
emit_status 'INSTALLER_HANDOFF_STARTED=1'
emit_status 'INSTALLER_PROGRESS=4/4 Installer handoff completed'
say 'Done. Continue in the Financial Brain setup window.'
