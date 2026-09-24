#!/usr/bin/env bash
# Financial Brain prerequisite preparation for macOS.
# --check and --dry-run are read-only. Real mode is deliberately per-user.
set -eu

NODE_VERSION="24.13.1"
CLAUDE_VERSION="2.1.261"
CODEX_VERSION="0.155.0-alpha.16"
BRAIN_VERSION="0.4.8"
WRANGLER_VERSION="4.131.1"
MODE="${1:---real}"
FIXTURE_DIR="${MACHINE_PREP_FIXTURE_DIR:-}"
PREP_HOME="${MACHINE_PREP_HOME:-${HOME:-}}"
TOOLS_ROOT="$PREP_HOME/.local/share/financial-brain-tools"
USER_PREFIX="$PREP_HOME/.local"
BIN_DIR="$USER_PREFIX/bin"
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
    "       prep-mac.sh --verify-checksum FILE EXPECTED_SHA256"
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
    status_line "$NODE_STATE" "Node.js" "install pinned v$NODE_VERSION; fix: run --real"
  elif printf '%s' "$node_version" | /usr/bin/grep -Eq '^v(22|24)\.'; then
    NODE_STATE="READY"
    status_line "$NODE_STATE" "Node.js" "$node_version"
  else
    NODE_STATE="WRONG_VERSION"
    status_line "$NODE_STATE" "Node.js" "$node_version; supported majors are 22 and 24; fix: run --real"
  fi

  npm_version=$(tool_version npm 2>/dev/null || true)
  if [ -n "$npm_version" ]; then status_line "READY" "npm" "$npm_version"
  else status_line "MISSING" "npm" "install with Node.js; fix: run --real"; fi

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
    status_line "$GIT_STATE" "Git" "install Apple's Command Line Tools; fix: run --real and approve the OS dialog"
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
    status_line "$CLAUDE_STATE" "Claude Code" "install pinned $CLAUDE_VERSION; fix: run --real"
  elif printf '%s' "$claude_version" | /usr/bin/grep -Fq "$CLAUDE_VERSION"; then
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
    status_line "$CODEX_STATE" "Codex CLI" "install pinned $CODEX_VERSION; fix: run --real"
  elif printf '%s' "$codex_version" | /usr/bin/grep -Fq "$CODEX_VERSION"; then
    CODEX_STATE="READY"
    status_line "$CODEX_STATE" "Codex CLI" "$codex_version"
  else
    CODEX_STATE="WRONG_VERSION"
    status_line "$CODEX_STATE" "Codex CLI" "$codex_version; expected $CODEX_VERSION; fix: run --real"
  fi

  brain_paths=$(tool_paths brain)
  brain_count=$(printf '%s\n' "$brain_paths" | /usr/bin/awk 'NF { n += 1 } END { print n + 0 }')
  brain_version=$(tool_version brain 2>/dev/null || true)
  canonical_brain="$PREP_HOME/.financial-brain/bin/brain"
  if [ "$brain_count" -gt 1 ]; then
    BRAIN_STATE="SHADOWED"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "$brain_count PATH matches; fix: remove the earlier PATH entry and reopen the shell"
  elif [ "$brain_count" -eq 0 ]; then
    BRAIN_STATE="MISSING"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "held $BRAIN_VERSION candidate has no stable asset; fix: wait for the immutable release receipt"
  elif [ "$brain_paths" != "$canonical_brain" ]; then
    BRAIN_STATE="SHADOWED"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "$brain_paths resolves first; fix: put $canonical_brain first on PATH"
  elif ! printf '%s' "$brain_version" | /usr/bin/grep -Fq "$BRAIN_VERSION"; then
    BRAIN_STATE="WRONG_VERSION"
    status_line "$BRAIN_STATE" "Financial Brain CLI" "${brain_version:-unknown}; expected $BRAIN_VERSION; fix: use the immutable stable installer when released"
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
    status_line "$XCODE_STATE" "Xcode Command Line Tools" "required only to supply Git; fix: run --real and approve the OS dialog"
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
    "1. CLIENT CLICK: approve Apple's Command Line Tools dialog once, only because Git/Xcode readiness is incomplete." \
    "2. DOWNLOAD: Node.js v$NODE_VERSION from nodejs.org into the per-user tool directory." \
    "3. VERIFY: match the Node archive against the pinned release's official SHASUMS256.txt before extraction." \
    "4. INSTALL: Anthropic Claude Code $CLAUDE_VERSION from a saved official installer file; never pipe a download into a shell." \
    "5. INSTALL: OpenAI Codex CLI $CODEX_VERSION from the exact official npm package into the per-user prefix." \
    "6. PATH: add one managed per-user bin directory without replacing existing PATH entries." \
    "7. SKIP: do not install global Wrangler; Financial Brain owns wrangler@$WRANGLER_VERSION." \
    "8. HOLD: do not install Financial Brain until the published stable contract provides immutable bytes and a SHA-256 receipt." \
    "9. VERIFY: rerun --check and show the operator the green/red list."
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

log_event() {
  /bin/mkdir -p "$LOG_DIR"
  /usr/bin/printf '%s %s\n' "$(TZ=America/Phoenix /bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG_FILE"
  /bin/chmod 600 "$LOG_FILE"
}

ensure_path() {
  profile="$PREP_HOME/.zprofile"
  marker='# Financial Brain machine prep PATH'
  line='export PATH="$HOME/.local/bin:$PATH"'
  if [ -f "$profile" ] && /usr/bin/grep -Fq "$marker" "$profile"; then return 0; fi
  {
    printf '\n%s\n%s\n' "$marker" "$line"
  } >> "$profile"
}

install_node() {
  arch=$(uname -m)
  case "$arch" in arm64) node_arch="arm64" ;; x86_64) node_arch="x64" ;; *) printf 'Unsupported Mac architecture: %s\n' "$arch" >&2; return 1 ;; esac
  archive="node-v$NODE_VERSION-darwin-$node_arch.tar.gz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  target="$TOOLS_ROOT/node-v$NODE_VERSION-darwin-$node_arch"
  [ ! -e "$target" ] || { printf 'Existing managed Node target is not ready; refusing to overwrite %s\n' "$target" >&2; return 1; }
  for name in node npm npx; do
    [ ! -e "$BIN_DIR/$name" ] && [ ! -L "$BIN_DIR/$name" ] || { printf 'Refusing to replace existing %s\n' "$BIN_DIR/$name" >&2; return 1; }
  done
  temp=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/financial-brain-machine-prep.XXXXXX") || return 1
  /usr/bin/curl --fail --location --silent --show-error --output "$temp/$archive" "$base/$archive" || { /bin/rm -rf "$temp"; return 1; }
  /usr/bin/curl --fail --location --silent --show-error --output "$temp/SHASUMS256.txt" "$base/SHASUMS256.txt" || { /bin/rm -rf "$temp"; return 1; }
  expected=$(/usr/bin/awk -v file="$archive" '$2 == file { print $1 }' "$temp/SHASUMS256.txt")
  verify_checksum --verify-checksum "$temp/$archive" "$expected" || { /bin/rm -rf "$temp"; return 1; }
  /bin/mkdir -p "$TOOLS_ROOT" "$BIN_DIR"
  /usr/bin/tar -xzf "$temp/$archive" -C "$temp" || { /bin/rm -rf "$temp"; return 1; }
  /bin/mv "$temp/node-v$NODE_VERSION-darwin-$node_arch" "$target" || { /bin/rm -rf "$temp"; return 1; }
  for name in node npm npx; do
    /bin/ln -s "$target/bin/$name" "$BIN_DIR/$name"
  done
  /bin/rm -rf "$temp"
  export PATH="$BIN_DIR:$PATH"
  log_event "installed Node.js v$NODE_VERSION after SHA-256 verification"
}

install_claude() {
  temp=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/financial-brain-machine-prep.XXXXXX") || return 1
  installer="$temp/claude-install.sh"
  /usr/bin/curl --fail --location --silent --show-error --output "$installer" "https://claude.ai/install.sh" || { /bin/rm -rf "$temp"; return 1; }
  /bin/sh "$installer" "$CLAUDE_VERSION" || { /bin/rm -rf "$temp"; return 1; }
  claude_path="$PREP_HOME/.local/bin/claude"
  [ -x "$claude_path" ] || { printf 'Claude installer did not create the official per-user executable\n' >&2; /bin/rm -rf "$temp"; return 1; }
  claude_target=$(/usr/bin/readlink "$claude_path" 2>/dev/null || printf '%s' "$claude_path")
  case "$claude_target" in /*) : ;; *) claude_target="$(/usr/bin/dirname "$claude_path")/$claude_target" ;; esac
  /usr/bin/codesign --verify --deep --strict "$claude_target" >/dev/null 2>&1 || {
    printf 'Claude executable signature verification failed\n' >&2
    /bin/rm -rf "$temp"
    return 1
  }
  "$claude_path" --version 2>/dev/null | /usr/bin/grep -Fq "$CLAUDE_VERSION" || {
    printf 'Claude executable version readback failed\n' >&2
    /bin/rm -rf "$temp"
    return 1
  }
  /bin/rm -rf "$temp"
  log_event "installed Claude Code $CLAUDE_VERSION and verified its code signature and version"
}

install_codex() {
  npm_path=$(tool_paths npm | /usr/bin/head -n 1)
  [ -n "$npm_path" ] || { printf 'npm is unavailable after Node preparation\n' >&2; return 1; }
  "$npm_path" install --global --prefix "$USER_PREFIX" --no-audit --no-fund "@openai/codex@$CODEX_VERSION" || return 1
  log_event "installed OpenAI Codex CLI $CODEX_VERSION through npm integrity verification"
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
  /bin/mkdir -p "$TOOLS_ROOT" "$BIN_DIR" "$LOG_DIR"
  /bin/chmod 700 "$TOOLS_ROOT" "$BIN_DIR" "$LOG_DIR"
  log_event "real mode started"

  if [ "$GIT_STATE" != "READY" ]; then
    printf "CLIENT ACTION: approve Apple's Command Line Tools dialog. Other downloads can continue while it runs.\n"
    /usr/bin/xcode-select --install || true
    log_event "requested Apple Command Line Tools dialog"
  fi
  if [ "$NODE_STATE" != "READY" ]; then install_node || return 1; fi
  ensure_path || return 1
  export PATH="$BIN_DIR:$PATH"
  if [ "$CLAUDE_STATE" != "READY" ]; then install_claude || return 1; fi
  if [ "$CODEX_STATE" != "READY" ]; then install_codex || return 1; fi

  log_event "Financial Brain install held pending immutable stable package receipt"
  printf 'HOLD: Financial Brain %s has no immutable stable customer asset. No Brain install was attempted.\n' "$BRAIN_VERSION"
  printf 'Log: %s\n\n' "$LOG_FILE"
  print_check
}

case "$MODE" in
  --check) print_check ;;
  --dry-run) print_plan ;;
  --real) run_real ;;
  --verify-checksum) verify_checksum "$@" ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
