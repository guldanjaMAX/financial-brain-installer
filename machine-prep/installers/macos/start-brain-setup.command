#!/usr/bin/env bash
# Runs the installed CLI in a visible owner-controlled Terminal window.
set -u

BRAIN="$HOME/.financial-brain/bin/brain"
MANIFEST="$HOME/Financial Brain/brain.manifest.json"

if [ ! -x "$BRAIN" ]; then
  printf 'Financial Brain setup could not start because the installed CLI is missing.\n'
  printf 'Send the installer log at ~/.local/state/financial-brain-machine-prep/installer.log to support.\n'
  printf 'Press Return to close this window. '
  IFS= read -r _
  exit 2
fi

printf 'Financial Brain setup\n'
printf 'The private prompts in this window belong to the Brain CLI. Do not copy credentials into chat.\n\n'
"$BRAIN" setup "$MANIFEST"
status=$?
printf '\nSetup exited with code %s. This window can stay open while Claude helps with the next owner action.\n' "$status"
printf 'Press Return to close this window. '
IFS= read -r _
exit "$status"
