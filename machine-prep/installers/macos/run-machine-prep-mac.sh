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

printf 'INSTALLER_PROGRESS=1/3 Preparing developer tools\n' | /usr/bin/tee -a "$LOG_FILE"
notify "Preparing Node.js, Git, Claude Code, and Codex."
set +e
"$SCRIPT_DIR/prep-mac.sh" --real 2>&1 | sanitize_log | /usr/bin/tee -a "$LOG_FILE"
prep_status=${PIPESTATUS[0]}
set -e
printf 'PREP_EXIT_CODE=%s\n' "$prep_status" | /usr/bin/tee -a "$LOG_FILE"

if [ "$prep_status" -eq 0 ]; then
  printf 'INSTALLER_PROGRESS=2/3 Tool checks completed\n' | /usr/bin/tee -a "$LOG_FILE"
  notify "Tool checks completed. Opening Claude with the next step."
else
  printf 'INSTALLER_PROGRESS=2/3 Prep needs attention; Claude will guide the fix\n' | /usr/bin/tee -a "$LOG_FILE"
  notify "Prep needs attention. Claude will open with the next step."
fi

printf 'INSTALLER_PROGRESS=3/3 Opening Claude\n' | /usr/bin/tee -a "$LOG_FILE"
if "$SCRIPT_DIR/handoff/handoff-mac.sh" 2>&1 | sanitize_log | /usr/bin/tee -a "$LOG_FILE"; then
  printf 'INSTALLER_HANDOFF_STARTED=1\n' | /usr/bin/tee -a "$LOG_FILE"
else
  printf 'INSTALLER_HANDOFF_STARTED=0 manual_fallback=~/.local/bin/claude\n' | /usr/bin/tee -a "$LOG_FILE"
fi

# The package transaction installed the reviewed launcher successfully. Prep
# readiness remains separately visible through PREP_EXIT_CODE and Claude.
exit 0
