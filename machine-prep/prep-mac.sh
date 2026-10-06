#!/usr/bin/env bash
# Financial Brain prerequisite preparation for macOS.
# --check and --dry-run are read-only. Real mode is deliberately per-user.
set -eu

NODE_VERSION="24.13.1"
CLAUDE_VERSION="2.1.261"
CODEX_VERSION="0.155.0-alpha.16"
BRAIN_VERSION="0.4.9"
BRAIN_KIT_URL="https://financialbrain.ai/kit/brain-installer-0.4.9-0555ad1972d7f8d6.tgz"
BRAIN_KIT_SIZE="6668013"
BRAIN_KIT_SHA256="0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2"
WRANGLER_VERSION="4.131.1"
MODE="${1:---real}"
if [ "$MODE" = "--test-install-brain" ]; then
  [ "${MACHINE_PREP_TEST_MODE:-}" = "1" ] || { printf 'REFUSED test install seam outside test mode\n' >&2; exit 2; }
  BRAIN_KIT_SIZE="${MACHINE_PREP_TEST_KIT_SIZE:?test kit size required}"
  BRAIN_KIT_SHA256="${MACHINE_PREP_TEST_KIT_SHA256:?test kit checksum required}"
fi
FIXTURE_DIR="${MACHINE_PREP_FIXTURE_DIR:-}"
PREP_HOME="${MACHINE_PREP_HOME:-${HOME:-}}"
TOOLS_ROOT="$PREP_HOME/.local/share/financial-brain-tools"
USER_PREFIX="$PREP_HOME/.local"
BIN_DIR="$USER_PREFIX/bin"
BRAIN_PREFIX="$PREP_HOME/.financial-brain"
LOG_DIR="$PREP_HOME/.local/state/financial-brain-machine-prep"
LOG_FILE="$LOG_DIR/prep.log"
CHECK_FAILURES=0
NODE_STATE="MISSING"
GIT_STATE="MISSING"
CLAUDE_STATE="MISSING"
CODEX_STATE="MISSING"
BRAIN_STATE="MISSING"
XCODE_STATE="MISSING"
SESSION_STATE="READY"

usage() {
  printf '%s\n' \
    "Usage: prep-mac.sh --check | --dry-run | --real" \
    "       prep-mac.sh --verify-checksum FILE EXPECTED_SHA256" \
    "       prep-mac.sh --verify-prefix DIRECTORY" \
    "       prep-mac.sh --verify-installed DIRECTORY"
}

fixture_read() {
  [ -n "$FIXTURE_DIR" ] || return 1
  [ -f "$FIXTURE_DIR/$1" ] || return 1
  /bin/cat "$FIXTURE_DIR/$1"
}

tool_paths() {
  name=$1
  if [ -n "$FIXTURE_DIR" ]; then
    value=$(fixture_read "$name.paths" 2>/dev/null || true)
    [ "$value" = "MISSING" ] && return 0
    printf '%s\n' "$value" | /usr/bin/awk 'NF && !seen[$0]++'
    return 0
  fi
  type -a -P "$name" 2>/dev/null | /usr/bin/awk 'NF && !seen[$0]++'
}

tool_version() {
  name=$1
  if [ -n "$FIXTURE_DIR" ]; then
    value=$(fixture_read "$name.version" 2>/dev/null || true)
    [ "$value" = "MISSING" ] && return 1
    [ -n "$value" ] || return 1
    printf '%s\n' "$value"
    return 0
  fi
  path=$(tool_paths "$name" | /usr/bin/head -n 1)
  [ -n "$path" ] || return 1
  case "$name" in
    brain)
      package_json="$PREP_HOME/.financial-brain/lib/node_modules/brain-installer/package.json"
      [ -f "$package_json" ] || return 1
      version=$(/usr/bin/sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package_json" | /usr/bin/head -n 1)
      [ -n "$version" ] || return 1
      printf '%s\n' "$version"
      ;;
    claude)
      target=$(/usr/bin/readlink "$path" 2>/dev/null || true)
      version=$(/usr/bin/basename "$target" 2>/dev/null || true)
      printf '%s' "$version" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
      printf '%s (Claude Code)\n' "$version"
      ;;
    codex)
      package_json="$USER_PREFIX/lib/node_modules/@openai/codex/package.json"
      [ "$path" = "$BIN_DIR/codex" ] && [ -f "$package_json" ] || return 1
      version=$(/usr/bin/sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package_json" | /usr/bin/head -n 1)
      [ -n "$version" ] || return 1
      printf 'codex-cli %s\n' "$version"
      ;;
    *) "$path" --version 2>/dev/null | /usr/bin/head -n 1 ;;
  esac
}

status_line() {
  state=$1
  label=$2
  detail=$3
  printf '%-14s %-23s %s\n' "$state" "$label" "$detail"
  case "$state" in
    MISSING|WRONG_VERSION|SHADOWED) CHECK_FAILURES=$((CHECK_FAILURES + 1)) ;;
  esac
}

collect_checks() {
  CHECK_FAILURES=0

  if [ -n "$FIXTURE_DIR" ]; then
    xcode_status=$(fixture_read xcode.status 2>/dev/null || true)
  elif /usr/bin/xcode-select -p >/dev/null 2>&1; then
    xcode_status="ready"
  else
    xcode_status="missing"
  fi

  node_version=$(tool_version node 2>/dev/null || true)
  if [ -z "$node_version" ]; then
    NODE_STATE="MISSING"
    status_line "$NODE_STATE" "Node.js" "OWNER ACTION: install supported Node.js from its official signed installer"
  elif printf '%s' "$node_version" | /usr/bin/grep -Eq '^v(22|24)\.'; then
    NODE_STATE="READY"
    status_line "$NODE_STATE" "Node.js" "$node_version"
  else
    NODE_STATE="WRONG_VERSION"
    status_line "$NODE_STATE" "Node.js" "$node_version; OWNER ACTION: install supported major 22 or 24"
  fi

  npm_version=$(tool_version npm 2>/dev/null || true)
  if [ -n "$npm_version" ]; then status_line "READY" "npm" "$npm_version"
  else status_line "MISSING" "npm" "OWNER ACTION: install it with supported Node.js"; fi

  git_path=$(tool_paths git | /usr/bin/head -n 1)
  if [ -z "$FIXTURE_DIR" ] && [ "$git_path" = "/usr/bin/git" ] && [ "$xcode_status" != "ready" ]; then
    git_version=""
  else
    git_version=$(tool_version git 2>/dev/null || true)
  fi
  if [ -n "$git_version" ]; then
    GIT_STATE="READY"
    status_line "$GIT_STATE" "Git" "$git_version"
  else
    GIT_STATE="MISSING"
    status_line "$GIT_STATE" "Git" "OWNER ACTION: install Apple's signed Command Line Tools"
  fi

  claude_paths=$(tool_paths claude)
  claude_count=$(printf '%s\n' "$claude_paths" | /usr/bin/awk 'NF { n += 1 } END { print n + 0 }')
  claude_version=$(tool_version claude 2>/dev/null || true)
  if [ "$claude_count" -gt 1 ]; then
    CLAUDE_STATE="SHADOWED"
    status_line "$CLAUDE_STATE" "Claude Code" "$claude_count PATH matches; fix: keep only the official per-user path"
  elif [ "$claude_count" -eq 1 ] && [ "$claude_paths" != "$BIN_DIR/claude" ]; then
    CLAUDE_STATE="SHADOWED"
    status_line "$CLAUDE_STATE" "Claude Code" "$claude_paths resolves first; fix: put $BIN_DIR/claude first on PATH"
  elif [ -z "$claude_version" ]; then
    CLAUDE_STATE="MISSING"
    status_line "$CLAUDE_STATE" "Claude Code" "OWNER ACTION: install pinned $CLAUDE_VERSION from the official signed installer"
  elif [ "$claude_version" = "$CLAUDE_VERSION (Claude Code)" ]; then
    CLAUDE_STATE="READY"
    status_line "$CLAUDE_STATE" "Claude Code" "$claude_version"
  else
    CLAUDE_STATE="WRONG_VERSION"
    status_line "$CLAUDE_STATE" "Claude Code" "$claude_version; expected $CLAUDE_VERSION; fix: run --real"
  fi

  codex_paths=$(tool_paths codex)
  codex_count=$(printf '%s\n' "$codex_paths" | /usr/bin/awk 'NF { n += 1 } END { print n + 0 }')
  codex_version=$(tool_version codex 2>/dev/null || true)
  if [ "$codex_count" -gt 1 ]; then
    CODEX_STATE="SHADOWED"
    status_line "$CODEX_STATE" "Codex CLI" "$codex_count PATH matches; fix: keep only the managed per-user path"
  elif [ "$codex_count" -eq 1 ] && [ "$codex_paths" != "$BIN_DIR/codex" ]; then
    CODEX_STATE="SHADOWED"
    status_line "$CODEX_STATE" "Codex CLI" "$codex_paths resolves first; fix: put $BIN_DIR/codex first on PATH"
  elif [ -z "$codex_version" ]; then
    CODEX_STATE="MISSING"
    status_line "$CODEX_STATE" "Codex CLI" "OWNER ACTION: install pinned $CODEX_VERSION from the official package"
  elif [ "$codex_version" = "codex-cli $CODEX_VERSION" ]; then
    CODEX_STATE="READY"
    status_line "$CODEX_STATE" "Codex CLI" "$codex_version"
  else
    CODEX_STATE="WRONG_VERSION"
    status_line "$CODEX_STATE" "Codex CLI" "$codex_version; expected $CODEX_VERSION; fix: run --real"
  fi

  brain_paths=$(tool_paths brain)
  brain_count=$(printf '%s\n' "$brain_paths" | /usr/bin/awk 'NF { n += 1 } END { print n + 0 }')
  brain_version=$(tool_version brain 2>/dev/null || true)
  canonical_brain="$BRAIN_PREFIX/bin/brain"
  if [ "$brain_count" -gt 1 ]; then
    BRAIN_STATE="SHADOWED"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "$brain_count PATH matches; fix: remove the earlier PATH entry and reopen the shell"
  elif [ "$brain_count" -eq 0 ]; then
    BRAIN_STATE="MISSING"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "install pinned $BRAIN_VERSION kit; fix: run --real"
  elif [ "$brain_paths" != "$canonical_brain" ]; then
    BRAIN_STATE="SHADOWED"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "$brain_paths resolves first; fix: put $canonical_brain first on PATH"
  elif [ "$brain_version" != "$BRAIN_VERSION" ]; then
    BRAIN_STATE="WRONG_VERSION"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "${brain_version:-unknown}; expected $BRAIN_VERSION; fix: use the signed installer for a clean prefix"
  else
    BRAIN_STATE="READY"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "$brain_version at the canonical per-user path"
  fi

  status_line "READY" "Wrangler" "package pin $WRANGLER_VERSION; no global install needed"
  status_line "READY" "Python 3" "not required by standard machine prep"

  if [ "$xcode_status" = "ready" ]; then
    XCODE_STATE="READY"
    status_line "$XCODE_STATE" "Xcode Command Line Tools" "available"
  elif [ "$GIT_STATE" = "READY" ]; then
    XCODE_STATE="READY"
    status_line "$XCODE_STATE" "Xcode Command Line Tools" "not required because Git is already available"
  else
    XCODE_STATE="MISSING"
    status_line "$XCODE_STATE" "Xcode Command Line Tools" "OWNER ACTION: install Apple's signed tools to supply Git"
  fi

  if [ -n "$FIXTURE_DIR" ]; then
    session_status=$(fixture_read session.status 2>/dev/null || printf 'standard')
  elif [ "$(/usr/bin/id -u 2>/dev/null || printf '0')" = "0" ]; then
    session_status="elevated"
  else
    session_status="standard"
  fi
  if [ "$session_status" = "standard" ]; then
    SESSION_STATE="READY"
    status_line "$SESSION_STATE" "macOS session" "normal current-user shell"
  else
    SESSION_STATE="WRONG_VERSION"
    status_line "$SESSION_STATE" "macOS session" "root or sudo shell; fix: reopen Terminal as the current user"
  fi
}

print_check() {
  printf 'Machine Prep for macOS\n'
  printf 'MODE check (read-only)\n\n'
  printf 'READINESS\n'
  collect_checks
  printf 'CHECKS_REACHED=10\n'
  if [ "$CHECK_FAILURES" -eq 0 ]; then
    printf 'READINESS GREEN\n'
    return 0
  fi
  printf 'READINESS RED\n'
  return 1
}

print_plan() {
  printf 'Machine Prep for macOS\n'
  printf 'MODE dry-run (no changes)\n\n'
  printf 'READINESS\n'
  collect_checks
  printf 'CHECKS_REACHED=10\n'
  if [ "$CHECK_FAILURES" -eq 0 ]; then printf 'READINESS GREEN\n'; else printf 'READINESS RED\n'; fi
  printf '\nPLAN\n'
  printf "%s\n" \
    "1. OWNER ACTION: install any missing Node.js, Git, Claude Code, or Codex prerequisite from its official signed installer, then rerun this launcher." \
    "2. REFUSE: the launcher does not download or execute prerequisite installers whose bytes it cannot authenticate before execution." \
    "3. SKIP: do not install global Wrangler; Financial Brain owns wrangler@$WRANGLER_VERSION." \
    "4. DOWNLOAD: Financial Brain $BRAIN_VERSION from the one pinned HTTPS kit URL without following redirects." \
    "5. VERIFY: require exactly $BRAIN_KIT_SIZE bytes and SHA-256 $BRAIN_KIT_SHA256 before npm sees the local file." \
    "6. INSTALL: use an isolated npm environment and private staging prefix, then atomically promote to clean per-user $BRAIN_PREFIX." \
    "7. VERIFY: rerun --check and show the operator the green/red list."
  printf '\nNo command was executed, no directory was created, and no log was written.\n'
}

verify_checksum() {
  file=${2:-}
  expected=${3:-}
  printf 'CHECKSUM_DECISION_REACHED=1\n'
  if [ ! -f "$file" ] || ! printf '%s' "$expected" | /usr/bin/grep -Eq '^[0-9a-fA-F]{64}$'; then
    printf 'REFUSED checksum input invalid\n' >&2
    return 2
  fi
  actual=$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}')
  if [ "$actual" != "$(printf '%s' "$expected" | /usr/bin/tr 'A-F' 'a-f')" ]; then
    printf 'REFUSED checksum mismatch\n' >&2
    return 2
  fi
  printf 'VERIFIED checksum\n'
}

verify_prefix() {
  target=${2:-}
  printf 'PREFIX_DECISION_REACHED=1\n'
  if [ -z "$target" ]; then
    printf 'REFUSED prefix input invalid\n' >&2
    return 2
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf 'REFUSED prefix collision\n' >&2
    return 2
  fi
  printf 'AVAILABLE prefix\n'
}

verify_installed_brain() {
  prefix=${2:-}
  printf 'INSTALLED_BRAIN_DECISION_REACHED=1\n'
  printf 'REUSE_ATTEMPTED=0\n'
  [ -n "$prefix" ] || { printf 'REFUSED existing prefix input invalid\n' >&2; return 2; }
  printf 'REFUSED existing prefix cannot be authenticated against reviewed release bytes; move it aside and rerun\n' >&2
  return 2
}

verify_brain_kit() {
  file=$1
  printf 'KIT_SIZE_DECISION_REACHED=1 expected=%s\n' "$BRAIN_KIT_SIZE"
  actual_size=$(/usr/bin/stat -f '%z' "$file" 2>/dev/null || printf 'invalid')
  if [ "$actual_size" != "$BRAIN_KIT_SIZE" ]; then
    printf 'REFUSED kit size mismatch\n' >&2
    return 2
  fi
  verify_checksum --verify-checksum "$file" "$BRAIN_KIT_SHA256"
}

log_event() {
  /bin/mkdir -p "$LOG_DIR"
  /usr/bin/printf '%s %s\n' "$(TZ=America/Phoenix /bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG_FILE"
  /bin/chmod 600 "$LOG_FILE"
}

ensure_path() {
  profile="$PREP_HOME/.zprofile"
  marker='# Financial Brain machine prep PATH'
  line='export PATH="$HOME/.local/bin:$PATH"'
  if ! { [ -f "$profile" ] && /usr/bin/grep -Fq "$marker" "$profile"; }; then
    printf '\n%s\n%s\n' "$marker" "$line" >> "$profile"
  fi
  brain_marker='# Financial Brain CLI PATH'
  brain_line='export PATH="$HOME/.financial-brain/bin:$PATH"'
  if ! { [ -f "$profile" ] && /usr/bin/grep -Fq "$brain_marker" "$profile"; }; then
    printf '\n%s\n%s\n' "$brain_marker" "$brain_line" >> "$profile"
  fi
}

install_brain() {
  verify_prefix --verify-prefix "$BRAIN_PREFIX" || return 1
  npm_path="${MACHINE_PREP_TEST_NPM_PATH:-$(tool_paths npm | /usr/bin/head -n 1)}"
  [ -n "$npm_path" ] || { printf 'npm is unavailable\n' >&2; return 1; }
  temp=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/financial-brain-installer.XXXXXX") || return 1
  stage=""
  lock=""
  prefix_published=0
  install_complete=0
  attempt_id="attempt-$(/usr/bin/uuidgen)"
  marker_name=".financial-brain-install-attempt"

  owns_attempt_dir() {
    owned_path=$1
    [ ! -L "$owned_path" ] && [ -d "$owned_path" ] && [ -f "$owned_path/$marker_name" ] &&
      [ "$(/bin/cat "$owned_path/$marker_name" 2>/dev/null || true)" = "$attempt_id" ]
  }
  mark_attempt_dir() {
    owned_path=$1
    printf '%s\n' "$attempt_id" > "$owned_path/$marker_name" || return 1
    owns_attempt_dir "$owned_path"
  }
  remove_owned_dir() {
    owned_path=$1
    printf 'CLEANUP_OWNERSHIP_DECISION_REACHED=1\n'
    if ! owns_attempt_dir "$owned_path"; then
      printf 'CLEANUP_STOP_UNOWNED=1 path_role=installer_material\n' >&2
      return 1
    fi
    /bin/rm -rf "$owned_path"
  }
  cleanup_brain_install() {
    cleanup_failed=0
    if [ "$prefix_published" -eq 1 ] && [ "$install_complete" -eq 0 ] && { [ -e "$BRAIN_PREFIX" ] || [ -L "$BRAIN_PREFIX" ]; }; then
      remove_owned_dir "$BRAIN_PREFIX" || cleanup_failed=1
    fi
    if [ "$install_complete" -eq 0 ] && [ -n "$stage" ] && { [ -e "$stage" ] || [ -L "$stage" ]; }; then
      remove_owned_dir "$stage" || cleanup_failed=1
    fi
    if [ -n "$lock" ] && { [ -e "$lock" ] || [ -L "$lock" ]; }; then
      remove_owned_dir "$lock" || cleanup_failed=1
    fi
    if [ -n "$temp" ] && { [ -e "$temp" ] || [ -L "$temp" ]; }; then
      remove_owned_dir "$temp" || cleanup_failed=1
    fi
    [ "$cleanup_failed" -eq 0 ] || {
      printf 'REFUSED cleanup could not prove ownership of every target\n' >&2
      return 1
    }
  }
  trap cleanup_brain_install EXIT
  trap 'exit 1' HUP INT TERM
  mark_attempt_dir "$temp" || { printf 'REFUSED temporary directory ownership marker failed\n' >&2; return 1; }
  archive="$temp/brain-installer-$BRAIN_VERSION.tgz"
  printf 'DOWNLOAD_STARTED=1 kit_version=%s\n' "$BRAIN_VERSION"
  printf 'NO_REDIRECTS=1\n'
  if [ "${MACHINE_PREP_TEST_MODE:-}" = "1" ] && [ -n "${MACHINE_PREP_TEST_KIT_SOURCE:-}" ]; then
    /bin/cp "$MACHINE_PREP_TEST_KIT_SOURCE" "$archive" || return 1
  else
    /usr/bin/curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 0 --max-filesize "$BRAIN_KIT_SIZE" --output "$archive" "$BRAIN_KIT_URL" || return 1
  fi
  verify_brain_kit "$archive" || return 1
  lock="$PREP_HOME/.financial-brain.install.lock"
  printf 'INSTALL_LOCK_DECISION_REACHED=1\n'
  if ! /bin/mkdir "$lock" 2>/dev/null; then
    printf 'REFUSED another install owns the per-user install lock\n' >&2
    return 1
  fi
  mark_attempt_dir "$lock" || { printf 'REFUSED install lock ownership marker failed\n' >&2; return 1; }
  printf 'INSTALL_LOCK_ACQUIRED=1\n'
  printf 'STAGE_ALLOCATION_DECISION_REACHED=1\n'
  if [ -n "${MACHINE_PREP_TEST_STAGE_PATH:-}" ]; then
    stage="$MACHINE_PREP_TEST_STAGE_PATH"
    if ! /bin/mkdir "$stage" 2>/dev/null; then
      printf 'REFUSED staging prefix collision\n' >&2
      return 1
    fi
  else
    stage=$(/usr/bin/mktemp -d "$PREP_HOME/.financial-brain.stage.XXXXXX") || {
      printf 'REFUSED staging prefix allocation failed\n' >&2
      return 1
    }
  fi
  if ! mark_attempt_dir "$stage"; then
    printf 'REFUSED staging prefix collision\n' >&2
    return 1
  fi
  : > "$temp/npmrc"
  printf 'INSTALL_STARTED=1 kit_version=%s\n' "$BRAIN_VERSION"
  printf 'NPM_ENVIRONMENT_ISOLATED=1\n'
  npm_bin_dir=$(/usr/bin/dirname "$npm_path")
  /usr/bin/env -i HOME="$PREP_HOME" PATH="$npm_bin_dir:/usr/bin:/bin" BRAIN_NO_WRANGLER_LOGIN=1 \
    npm_config_userconfig="$temp/npmrc" npm_config_cache="$temp/npm-cache" npm_config_update_notifier=false \
    "$npm_path" install --global --ignore-scripts --no-audit --no-fund --prefix "$stage" "$archive" || return 1
  package_json="$stage/lib/node_modules/brain-installer/package.json"
  installed_brain="$stage/bin/brain"
  expected_brain_link="../lib/node_modules/brain-installer/brain.mjs"
  installed_version=$(/usr/bin/sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package_json" 2>/dev/null | /usr/bin/head -n 1)
  installed_link=$(/usr/bin/readlink "$installed_brain" 2>/dev/null || true)
  if [ "$installed_version" != "$BRAIN_VERSION" ] || [ ! -L "$installed_brain" ] || \
     [ "$installed_link" != "$expected_brain_link" ] || [ ! -f "$stage/lib/node_modules/brain-installer/brain.mjs" ]; then
    printf 'REFUSED staged Financial Brain readback failed\n' >&2
    return 1
  fi
  printf 'STAGED_PREFIX_VERIFIED=1\n'
  printf 'ATOMIC_PROMOTION_DECISION_REACHED=1\n'
  # macOS renamex_np(RENAME_EXCL) is an atomic same-volume rename that returns
  # EEXIST rather than replacing or moving inside a destination that appeared.
  if ! /usr/bin/osascript -l JavaScript -e \
    'ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]); function run(argv) { if (Number($.renamex_np(argv[0], argv[1], 4)) !== 0) throw new Error("exclusive rename failed"); return "promoted"; }' \
    "$stage" "$BRAIN_PREFIX" >/dev/null 2>&1; then
    printf 'REFUSED destination appeared before atomic promotion\n' >&2
    return 1
  fi
  prefix_published=1
  promoted_version=$(/usr/bin/sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$BRAIN_PREFIX/lib/node_modules/brain-installer/package.json" 2>/dev/null | /usr/bin/head -n 1)
  promoted_link=$(/usr/bin/readlink "$BRAIN_PREFIX/bin/brain" 2>/dev/null || true)
  if [ "$promoted_version" != "$BRAIN_VERSION" ] || \
     [ "$promoted_link" != "$expected_brain_link" ] || [ ! -f "$BRAIN_PREFIX/lib/node_modules/brain-installer/brain.mjs" ]; then
    printf 'REFUSED atomic promotion readback failed\n' >&2
    return 1
  fi
  printf 'ATOMIC_PROMOTION_VERIFIED=1\n'
  /bin/rm "$BRAIN_PREFIX/$marker_name" || return 1
  install_complete=1
  cleanup_brain_install || return 1
  lock=""
  temp=""
  trap - EXIT HUP INT TERM
  export PATH="$BRAIN_PREFIX/bin:$PATH"
  printf 'BRAIN_INSTALL_VERIFIED=1 version=%s\n' "$installed_version"
}

run_real() {
  if [ "${MACHINE_PREP_TEST_MODE:-}" = "1" ] || [ -n "$FIXTURE_DIR" ]; then
    printf 'REFUSED real mode while fixture/test mode is active\n' >&2
    return 2
  fi
  if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
    printf 'REFUSED prep-mac.sh real mode runs only on macOS\n' >&2
    return 2
  fi
  if [ "$(/usr/bin/id -u)" = "0" ]; then
    printf 'REFUSED run this as the current user, never root or sudo\n' >&2
    return 2
  fi

  printf 'Machine Prep for macOS\nMODE real\n'
  collect_checks >/dev/null
  printf 'PREREQUISITE_DECISION_REACHED=1\n'
  if [ "$NODE_STATE" != "READY" ] || [ "$GIT_STATE" != "READY" ] || [ "$CLAUDE_STATE" != "READY" ] || \
     [ "$CODEX_STATE" != "READY" ] || [ "$SESSION_STATE" != "READY" ]; then
    printf 'OWNER ACTION: install the missing prerequisite from its official signed installer, then rerun. No prerequisite was downloaded or executed.\n' >&2
    return 2
  fi
  if [ -e "$BRAIN_PREFIX" ] || [ -L "$BRAIN_PREFIX" ]; then verify_installed_brain --verify-installed "$BRAIN_PREFIX"; return 2; fi
  install_brain || return 1
  printf 'Financial Brain CLI preparation completed\n'
}

case "$MODE" in
  --check) print_check ;;
  --dry-run) print_plan ;;
  --real) run_real ;;
  --verify-checksum) verify_checksum "$@" ;;
  --verify-prefix) verify_prefix "$@" ;;
  --verify-installed) verify_installed_brain "$@" ;;
  --test-install-brain) install_brain ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
