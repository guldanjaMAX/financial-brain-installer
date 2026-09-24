#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd)
PROMPT=$(/bin/cat "$SCRIPT_DIR/message-macos.txt")
CLAUDE="$HOME/.local/bin/claude"

if [ ! -x "$CLAUDE" ]; then
  printf 'Claude Code is not ready. Send the installer log to support: %s\n' \
    "$HOME/.local/state/financial-brain-machine-prep/installer.log"
  printf 'Press Return to close.\n'
  read -r _
  exit 1
fi

exec "$CLAUDE" "$PROMPT"
