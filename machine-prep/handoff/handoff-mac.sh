#!/usr/bin/env bash
# Opens the supported Claude Desktop Code deep link, then falls back to the
# installed Claude Code CLI only when macOS has no registered Claude handler.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd)
PROMPT_FILE="$SCRIPT_DIR/message-macos.txt"
URL_FILE="$SCRIPT_DIR/handoff-macos.url"

[ -s "$PROMPT_FILE" ] || { printf 'REFUSED missing Claude handoff message\n' >&2; exit 2; }
[ -s "$URL_FILE" ] || { printf 'REFUSED missing Claude handoff URL\n' >&2; exit 2; }
URL=$(/bin/cat "$URL_FILE")
case "$URL" in claude://code/new\?q=*) : ;; *) printf 'REFUSED invalid Claude handoff URL\n' >&2; exit 2 ;; esac

printf 'HANDOFF_DECISION_REACHED=1\n'
case "${MACHINE_PREP_HANDOFF_TEST_MODE:-}" in
  desktop)
    printf 'HANDOFF_DESKTOP_URL=%s\n' "$URL"
    exit 0
    ;;
  fallback)
    printf 'HANDOFF_FALLBACK_CLI=%s\n' "$SCRIPT_DIR/continue-in-claude.command"
    exit 0
    ;;
esac

if /usr/bin/open "$URL" >/dev/null 2>&1; then
  printf 'HANDOFF_DESKTOP_OPENED=1\n'
  exit 0
fi

printf 'HANDOFF_FALLBACK_CLI=1\n'
/usr/bin/open -a Terminal "$SCRIPT_DIR/continue-in-claude.command"
