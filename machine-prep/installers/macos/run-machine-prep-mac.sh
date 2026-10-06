#!/usr/bin/env bash
# Runs after Installer's one authorization, but inside the console user's
# session. Prep output is home-path-scrubbed into a client-shareable log.
set -u
set -o pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd)
LOG_DIR="$HOME/.local/state/financial-brain-machine-prep"
LOG_FILE="$LOG_DIR/installer.log"
/bin/mkdir -p "$LOG_DIR"
/bin/chmod 700 "$LOG_DIR"
: > "$LOG_FILE"
/bin/chmod 600 "$LOG_FILE"

notify() {
  message=$1
  /usr/bin/osascript -e "display notification \"$message\" with title \"Financial Brain Machine Prep\"" >/dev/null 2>&1 || true
}

sanitize_log() {
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "${line//$HOME/~}"
  done
}

printf 'INSTALLER_PROGRESS=1/4 Preparing tools and Financial Brain\n' | /usr/bin/tee -a "$LOG_FILE"
notify "Preparing tools and the verified Financial Brain CLI."
set +e
"$SCRIPT_DIR/prep-mac.sh" --real 2>&1 | sanitize_log | /usr/bin/tee -a "$LOG_FILE"
prep_status=${PIPESTATUS[0]}
set -e
printf 'PREP_EXIT_CODE=%s\n' "$prep_status" | /usr/bin/tee -a "$LOG_FILE"

if [ "$prep_status" -eq 0 ]; then
  printf 'INSTALLER_PROGRESS=2/4 Tool and CLI checks completed\n' | /usr/bin/tee -a "$LOG_FILE"
  notify "Financial Brain is ready. Opening setup in Terminal."
  printf 'SETUP_LAUNCH_DECISION_REACHED=1\n' | /usr/bin/tee -a "$LOG_FILE"
  if /usr/bin/open -a Terminal "$SCRIPT_DIR/start-brain-setup.command"; then
    printf 'SETUP_WINDOW_STARTED=1\n' | /usr/bin/tee -a "$LOG_FILE"
  else
    printf 'SETUP_WINDOW_STARTED=0\n' | /usr/bin/tee -a "$LOG_FILE"
  fi
else
  printf 'INSTALLER_PROGRESS=2/4 Prep needs attention; setup was not opened\n' | /usr/bin/tee -a "$LOG_FILE"
  printf 'SETUP_LAUNCH_DECISION_REACHED=1 skipped=prep_failed\n' | /usr/bin/tee -a "$LOG_FILE"
  notify "Prep needs attention. Claude will open with the next step."
fi

printf 'INSTALLER_PROGRESS=3/4 Opening the local Claude handoff\n' | /usr/bin/tee -a "$LOG_FILE"
if "$SCRIPT_DIR/handoff/handoff-mac.sh" 2>&1 | sanitize_log | /usr/bin/tee -a "$LOG_FILE"; then
  printf 'INSTALLER_HANDOFF_STARTED=1\n' | /usr/bin/tee -a "$LOG_FILE"
else
  printf 'INSTALLER_HANDOFF_STARTED=0 manual_fallback=~/.local/bin/claude\n' | /usr/bin/tee -a "$LOG_FILE"
fi
printf 'INSTALLER_PROGRESS=4/4 Installer handoff completed\n' | /usr/bin/tee -a "$LOG_FILE"

# The package transaction installed the reviewed launcher successfully. Prep
# readiness remains separately visible through PREP_EXIT_CODE and Claude.
exit 0
