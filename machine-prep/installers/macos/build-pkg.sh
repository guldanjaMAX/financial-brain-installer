#!/usr/bin/env bash
# Builds an unsigned native macOS installer. Signing and notarization are a
# separate owner-approved release step; this script never reads signing state.
set -eu
export COPYFILE_DISABLE=1

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && /bin/pwd)
VERSION="0.1.0"
IDENTIFIER="com.financialbrain.machineprep"
INSTALL_ROOT="Library/Application Support/FinancialBrainMachinePrep"

usage() {
  printf '%s\n' \
    "Usage: build-pkg.sh OUTPUT.pkg" \
    "       build-pkg.sh --staging-only OUTPUT_DIRECTORY"
}

stage_package() {
  stage=$1
  if [ -e "$stage" ] && [ -n "$(/bin/ls -A "$stage" 2>/dev/null)" ]; then
    printf 'REFUSED staging directory must be absent or empty: %s\n' "$stage" >&2
    return 2
  fi

  install_dir="$stage/payload/$INSTALL_ROOT"
  /bin/mkdir -p "$install_dir/handoff" "$stage/scripts" "$stage/resources"
  /bin/cp "$ROOT/machine-prep/prep-mac.sh" "$install_dir/prep-mac.sh"
  /bin/cp "$SCRIPT_DIR/run-machine-prep-mac.sh" "$install_dir/run-machine-prep-mac.sh"
  /bin/cp "$SCRIPT_DIR/UNINSTALL.md" "$install_dir/UNINSTALL.md"
  /bin/cp "$ROOT/machine-prep/handoff/handoff-mac.sh" "$install_dir/handoff/handoff-mac.sh"
  /bin/cp "$ROOT/machine-prep/handoff/continue-in-claude.command" "$install_dir/handoff/continue-in-claude.command"
  /bin/cp "$ROOT/machine-prep/handoff/message-macos.txt" "$install_dir/handoff/message-macos.txt"
  /usr/bin/env node "$ROOT/machine-prep/handoff/render-url.mjs" \
    "$ROOT/machine-prep/handoff/message-macos.txt" > "$install_dir/handoff/handoff-macos.url"
  /bin/cp "$SCRIPT_DIR/scripts/preinstall" "$stage/scripts/preinstall"
  /bin/cp "$SCRIPT_DIR/scripts/postinstall" "$stage/scripts/postinstall"
  /bin/cp "$SCRIPT_DIR/resources/Welcome.html" "$stage/resources/Welcome.html"
  /bin/cp "$SCRIPT_DIR/resources/Conclusion.html" "$stage/resources/Conclusion.html"
  /bin/cp "$SCRIPT_DIR/Distribution.xml" "$stage/Distribution.xml"
  /bin/chmod 755 \
    "$install_dir/prep-mac.sh" \
    "$install_dir/run-machine-prep-mac.sh" \
    "$install_dir/handoff/handoff-mac.sh" \
    "$install_dir/handoff/continue-in-claude.command" \
    "$stage/scripts/preinstall" \
    "$stage/scripts/postinstall"
  /bin/chmod 644 \
    "$install_dir/UNINSTALL.md" \
    "$install_dir/handoff/message-macos.txt" \
    "$install_dir/handoff/handoff-macos.url"
}

case "${1:-}" in
  --staging-only)
    [ "$#" -eq 2 ] || { usage >&2; exit 2; }
    stage_package "$2"
    printf 'STAGING_READY=%s\n' "$2"
    ;;
  ""|--help|-h)
    usage
    ;;
  *)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    command -v pkgbuild >/dev/null 2>&1 || { printf 'REFUSED pkgbuild is unavailable\n' >&2; exit 2; }
    command -v productbuild >/dev/null 2>&1 || { printf 'REFUSED productbuild is unavailable\n' >&2; exit 2; }
    output=$1
    case "$output" in /*) : ;; *) output="$PWD/$output" ;; esac
    build_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/financial-brain-machine-prep-pkg.XXXXXX")
    trap '/bin/rm -rf "$build_root"' EXIT HUP INT TERM
    stage_package "$build_root"
    /usr/bin/xattr -cr "$build_root/payload" "$build_root/scripts" "$build_root/resources"
    /usr/bin/pkgbuild \
      --root "$build_root/payload" \
      --scripts "$build_root/scripts" \
      --identifier "$IDENTIFIER" \
      --version "$VERSION" \
      --install-location / \
      "$build_root/FinancialBrainMachinePrep-component.pkg"
    /usr/bin/productbuild \
      --distribution "$build_root/Distribution.xml" \
      --resources "$build_root/resources" \
      --package-path "$build_root" \
      "$output"
    printf 'UNSIGNED_PKG=%s\n' "$output"
    ;;
esac
