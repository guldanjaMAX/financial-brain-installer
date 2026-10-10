#!/usr/bin/env bash
# Financial Brain prerequisite preparation for macOS.
# --check and --dry-run are read-only. Real mode is deliberately per-user.
set -eu

NODE_VERSION="24.13.1"
CLAUDE_MIN_VERSION="2.1.261"
BRAIN_VERSION="0.4.10"
BRAIN_KIT_URL="https://financialbrain.ai/kit/brain-installer-0.4.10-55824b383909c57b.tgz"
BRAIN_KIT_SIZE="6828366"
BRAIN_KIT_SHA256="55824b383909c57b37f4db6179562bf603f670eaae3c7d315135dd290b0afdfe"
WRANGLER_VERSION="4.131.1"
# Official pages and the exact step on each, named to the owner when a
# prerequisite needs action. Real mode never downloads or runs anything from
# them; the owner installs by hand. Claude uses a floor because native
# installs auto-update. Codex is informational and never blocks preparation.
NODE_SOURCE="https://nodejs.org/en/download"
GIT_SOURCE="https://developer.apple.com/documentation/xcode/installing-the-command-line-tools"
CLAUDE_SOURCE="https://code.claude.com/docs/en/setup#install-claude-code"
NODE_HOW="At the top of the page, choose a version that starts with v24 (marked LTS). Then, under \"Or get a prebuilt Node.js\", click \"macOS Installer (.pkg)\" and open the downloaded file. Download page: $NODE_SOURCE"
GIT_HOW="Follow the section \"Install the Command Line Tools package in Terminal\". Apple's guide: $GIT_SOURCE"
CLAUDE_HOW="Under \"Install Claude Code\" on the setup page, choose \"Native Install (Recommended)\" and run the default command for your system. Setup page: $CLAUDE_SOURCE"
CLAUDE_UPDATE_HOW="Open a new terminal and run claude update."
CLAUDE_CONFLICT_HOW="Open a new terminal and run claude doctor. Follow its installation warning to select the Native Install copy."
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
CODEX_DETAIL="not found. Setup can continue without it."
BRAIN_STATE="MISSING"
XCODE_STATE="MISSING"
SESSION_STATE="READY"
OWNER_STEPS=""

usage() {
  printf '%s\n' \
    "Usage: prep-mac.sh --check | --dry-run | --real | --prepare-cli" \
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

# Records one plain-language line for a prerequisite that blocks real mode:
# the tool, what is wrong, what the check needs, and the one next step.
# Only run_real prints these, so check and dry-run output stay unchanged.
owner_step() {
  OWNER_STEPS="$OWNER_STEPS- $1: $2. Needs $3. $4
"
}

# Compare numeric components, not strings (2.1.1000 is newer than 2.1.261).
# Both callers validate the stable x.y.z shape before reaching this comparison.
claude_meets_floor() {
  /usr/bin/awk -v actual="$1" -v floor="$CLAUDE_MIN_VERSION" 'BEGIN {
    split(actual, a, "."); split(floor, f, ".")
    for (i = 1; i <= 3; i++) {
      if (a[i] + 0 > f[i] + 0) exit 0
      if (a[i] + 0 < f[i] + 0) exit 1
    }
    exit 0
  }'
}

collect_checks() {
  CHECK_FAILURES=0
  OWNER_STEPS=""

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
    owner_step "Node.js" "not found" "version 24 or 22" "$NODE_HOW"
  elif printf '%s' "$node_version" | /usr/bin/grep -Eq '^v(22|24)\.'; then
    NODE_STATE="READY"
    status_line "$NODE_STATE" "Node.js" "$node_version"
  else
    NODE_STATE="WRONG_VERSION"
    status_line "$NODE_STATE" "Node.js" "$node_version; OWNER ACTION: install supported major 22 or 24"
    found=$node_version
    owner_step "Node.js" "version $found is installed" "version 24 or 22" "$NODE_HOW"
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
    owner_step "Git" "not found" "Apple's Command Line Tools, any version" "$GIT_HOW"
  fi

  claude_path=$(tool_paths claude | /usr/bin/head -n 1)
  claude_version=$(tool_version claude 2>/dev/null || true)
  # Only the selected copy can block setup. Later copies do not shadow it.
  # The native launcher location is documented in the vendor setup guide.
  if [ -n "$claude_path" ] && [ "$claude_path" != "$BIN_DIR/claude" ]; then
    CLAUDE_STATE="SHADOWED"
    status_line "$CLAUDE_STATE" "Claude Code" "another install is selected; $CLAUDE_CONFLICT_HOW"
    owner_step "Claude Code" "another install is selected instead of the Native Install copy" "version $CLAUDE_MIN_VERSION or newer from Native Install" "$CLAUDE_CONFLICT_HOW"
  elif [ -z "$claude_path" ] || ! printf '%s' "$claude_version" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+ \(Claude Code\)$'; then
    CLAUDE_STATE="MISSING"
    status_line "$CLAUDE_STATE" "Claude Code" "version $CLAUDE_MIN_VERSION or newer; $CLAUDE_HOW"
    if [ -z "$claude_path" ]; then problem="not found"; else problem="a copy was found, but its version could not be read"; fi
    owner_step "Claude Code" "$problem" "version $CLAUDE_MIN_VERSION or newer" "$CLAUDE_HOW"
  elif claude_meets_floor "${claude_version%" (Claude Code)"}"; then
    CLAUDE_STATE="READY"
    status_line "$CLAUDE_STATE" "Claude Code" "$claude_version"
  else
    CLAUDE_STATE="WRONG_VERSION"
    status_line "$CLAUDE_STATE" "Claude Code" "$claude_version; needs $CLAUDE_MIN_VERSION or newer; $CLAUDE_UPDATE_HOW"
    found=${claude_version%" (Claude Code)"}
    owner_step "Claude Code" "version $found is installed" "version $CLAUDE_MIN_VERSION or newer" "$CLAUDE_UPDATE_HOW"
  fi

  codex_path=$(tool_paths codex | /usr/bin/head -n 1)
  codex_version=$(tool_version codex 2>/dev/null || true)
  if [ -z "$codex_path" ]; then
    CODEX_DETAIL="not found. Setup can continue without it."
  elif printf '%s' "$codex_version" | /usr/bin/grep -Eq '^codex-cli [0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'; then
    CODEX_DETAIL="found, version ${codex_version#"codex-cli "}."
  else
    # Inspect known package metadata only. Never start an optional assistant
    # just to get its version, and never echo unrecognized tool output.
    CODEX_DETAIL="found; version unavailable. Setup can continue without it."
  fi
  status_line "OPTIONAL" "Codex CLI" "$CODEX_DETAIL"

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
    owner_step "macOS session" "this launcher was started with administrator rights (sudo)" "your own normal account" "Close this window and double-click the launcher again."
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
    "1. OWNER ACTION: install any missing Node.js, Git, or Claude Code tool from its official signed installer, then rerun this launcher." \
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

# Traverse through directory descriptors and open leaves without following links.
# A pathname check followed by shell redirection is not enough: either parent
# can be replaced between the check and the read/write. Perl is supplied by macOS.
safe_npm_io() {
  /usr/bin/env -i /usr/bin/perl -e '
    use strict; use warnings;
    use Fcntl qw(:DEFAULT :mode O_NOFOLLOW O_DIRECTORY);
    use File::Temp qw(tempfile);
    my ($mode, $path, $identity) = @ARGV;
    sub enter_dir {
      my ($name, $create) = @_;
      mkdir($name, 0700) if $create && !lstat($name);
      sysopen(my $dir, $name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or die "unsafe directory\n";
      chdir($dir) or die "directory unavailable\n";
      return $dir;
    }
    die "absolute path required\n" unless $path =~ m{^/};
    my $dir = enter_dir("/", 0);
    for my $part (split m{/}, $path) {
      next if $part eq "";
      die "unsafe component\n" if $part eq "." || $part eq "..";
      $dir = enter_dir($part, $mode ne "newest");
    }
    my @root = stat($dir);
    die "directory owner mismatch\n" unless $root[4] == $<;
    if ($mode eq "newest") {
      die "attempt changed\n" unless "$root[0]:$root[1]" eq $identity;
      $dir = enter_dir("npm-cache", 0);
      $dir = enter_dir("_logs", 0);
      opendir(my $entries, ".") or die "logs unavailable\n";
      my ($newest, $mtime);
      for my $name (sort readdir($entries)) {
        next unless $name =~ /\.log\z/;
        sysopen(my $file, $name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW) or next;
        my @s = stat($file);
        next unless S_ISREG($s[2]) && $s[3] == 1 && $s[4] == $<;
        if (!defined($mtime) || $s[9] > $mtime) { $newest = $file; $mtime = $s[9]; }
      }
      die "no regular debug log\n" unless $newest;
      while (read($newest, my $buffer, 65536)) { print $buffer or die "read failed\n"; }
    } else {
      my ($out, $name);
      if ($mode eq "unique") {
        # File::Temp uses O_CREAT|O_EXCL and mode 0600. Never reuse a log name.
        ($out, $name) = tempfile("npm-debug-XXXXXXXX", SUFFIX => ".log", DIR => ".", UNLINK => 0);
      } elsif ($mode eq "append") {
        sysopen($out, "prep.log", O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK | O_NOFOLLOW, 0600) or die "unsafe prep log\n";
        my @s = stat($out);
        die "unsafe prep log\n" unless S_ISREG($s[2]) && $s[3] == 1 && $s[4] == $<;
        chmod(0600, $out) or die "log permissions failed\n";
      } else { die "invalid mode\n"; }
      while (read(STDIN, my $buffer, 65536)) { print $out $buffer or die "write failed\n"; }
      close($out) or die "close failed\n";
      if ($mode eq "unique") { $name =~ s{^\./}{}; print "$name\n"; }
    }
  ' "$@"
}

log_event() {
  /usr/bin/printf '%s %s\n' "$(TZ=America/Phoenix /bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$1" | safe_npm_io append "$LOG_DIR"
}

# npm can echo config, argv and authenticated URLs. Redact before persistent
# writes, including the retained debug log; never relay raw npm output.
redact_npm_output() {
  /usr/bin/awk '
    {
      line = $0
      gsub(/\033\[[0-9;]*[[:alpha:]]/, "", line)
      gsub(/[[:cntrl:]]/, "", line)
      gsub(/\/\/[^\/[:space:]]*@/, "//[REDACTED]@", line)
      gsub(/[?#][^[:space:]"<>]*/, "[REDACTED]", line)
      if (tolower(line) ~ /auth|token|password|passwd|secret|credential|bearer|api[ _-]?key|npm_[a-z0-9]{16,}|gh[pousr]_[a-z0-9]+|github_pat_|eyj[a-z0-9_-]+\./) line = "[REDACTED]"
      print line
    }'
}

run_isolated_npm() {
  /usr/bin/env -i HOME="$PREP_HOME" PATH="$npm_bin_dir:/usr/bin:/bin" BRAIN_NO_WRANGLER_LOGIN=1 \
    npm_config_userconfig="$temp/npmrc" npm_config_cache="$temp/npm-cache" npm_config_update_notifier=false \
    "$@"
}

record_npm_failure() (
  # A diagnostics failure must not change the install result or prevent cleanup.
  set -o pipefail
  umask 077
  log_event "npm_exit_code=$npm_exit" || exit 1
  for stream in stdout stderr; do
    /usr/bin/tail -n 40 "$temp/npm-$stream" | redact_npm_output | /usr/bin/sed "s/^/$stream: /" | safe_npm_io append "$LOG_DIR" || exit 1
  done
  # Select before version probes, which can themselves create npm debug logs.
  if debug=$(safe_npm_io newest "$temp" "$temp_identity" 2>/dev/null | redact_npm_output); then
    debug_file=$(printf '%s\n' "$debug" | safe_npm_io unique "$LOG_DIR") || exit 1
    log_event "npm_debug_log=saved file=$debug_file" || exit 1
  else
    log_event 'npm_debug_log=unavailable' || exit 1
  fi
  printf 'npm_selected=%s\n' "$npm_path" | redact_npm_output | safe_npm_io append "$LOG_DIR" || exit 1
  run_isolated_npm /bin/sh -c '
    printf "npm_path="; command -v npm || printf "unavailable\n"
    printf "node_path="; command -v node || printf "unavailable\n"
    printf "node_version="; node --version || printf "unavailable\n"
    printf "npm_version="; "$1" --version || printf "unavailable\n"
  ' diagnostics "$npm_path" 2>&1 | redact_npm_output | safe_npm_io append "$LOG_DIR"
)

show_npm_failure() {
  reason='an unclassified npm error'
  if /usr/bin/grep -Eiq "node.*(not recognized|not found|no such file)|cannot find.*node" "$temp/npm-stdout" "$temp/npm-stderr"; then
    reason='npm could not find Node.js'
  elif /usr/bin/grep -Eiq 'ENOTCACHED' "$temp/npm-stdout" "$temp/npm-stderr"; then
    reason='a package was not in the offline cache (ENOTCACHED)'
  elif /usr/bin/grep -Eiq 'EACCES|EPERM|EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|network|permission' "$temp/npm-stdout" "$temp/npm-stderr"; then
    reason='a network or permission error'
  fi
  printf 'Financial Brain CLI install failed: %s. For help, send Financial Brain support this log: %s\n' "$reason" "$LOG_FILE" >&2
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
  # Canonicalize the system temp alias before npm can change its cache tree.
  temp=$(cd "$temp" && /bin/pwd -P) || return 1
  temp_identity=$(/usr/bin/stat -f '%d:%i' "$temp") || return 1
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
  npm_exit=0
  run_isolated_npm "$npm_path" install --global --offline --ignore-scripts --no-audit --no-fund --prefix "$stage" "$archive" \
    > "$temp/npm-stdout" 2> "$temp/npm-stderr" || npm_exit=$?
  if [ "$npm_exit" -ne 0 ]; then
    if ! record_npm_failure; then printf 'Machine Prep could not save all npm diagnostics.\n' >&2; fi
    show_npm_failure
    return 1
  fi
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

# This explicit mode prepares only the CLI. The visible launcher still uses
# --real, including its assistant prerequisites, before it can open setup.
prepare_cli() {
  printf 'CLI_PREPARATION_SESSION_DECISION_REACHED=1\n'
  if [ "${MACHINE_PREP_TEST_MODE:-}" = "1" ] || [ -n "$FIXTURE_DIR" ]; then
    printf 'REFUSED CLI preparation while fixture/test mode is active\n' >&2
    return 2
  fi
  if [ "$(/usr/bin/uname -s)" != "Darwin" ] || [ "$(/usr/bin/id -u)" = "0" ]; then
    printf 'REFUSED CLI preparation requires a non-root macOS user\n' >&2
    return 2
  fi
  printf 'CLI_PREPARATION_PREREQUISITE_DECISION_REACHED=1\n'
  node_version=$(tool_version node 2>/dev/null || true)
  case "$node_version" in
    v22.*|v24.*) ;;
    *) printf 'REFUSED CLI preparation requires Node.js 22 or 24\n' >&2; return 2 ;;
  esac
  [ -n "$(tool_paths npm)" ] || { printf 'REFUSED npm is unavailable\n' >&2; return 2; }
  install_brain
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
     [ "$SESSION_STATE" != "READY" ]; then
    printf 'Financial Brain setup cannot start yet. Nothing was downloaded or installed.\n' >&2
    printf 'What you need to do:\n' >&2
    printf '%s' "$OWNER_STEPS" >&2
    printf 'When everything above is done, open Run Financial Brain Machine Prep again.\n' >&2
    # Keep optional information outside the required-action block on screen.
    printf 'Codex CLI (optional): %s\n' "$CODEX_DETAIL"
    return 2
  fi
  printf 'Codex CLI (optional): %s\n' "$CODEX_DETAIL"
  if [ -e "$BRAIN_PREFIX" ] || [ -L "$BRAIN_PREFIX" ]; then verify_installed_brain --verify-installed "$BRAIN_PREFIX"; return 2; fi
  install_brain || return 1
  printf 'Financial Brain CLI preparation completed\n'
}

case "$MODE" in
  --check) print_check ;;
  --dry-run) print_plan ;;
  --real) run_real ;;
  --prepare-cli) prepare_cli ;;
  --verify-checksum) verify_checksum "$@" ;;
  --verify-prefix) verify_prefix "$@" ;;
  --verify-installed) verify_installed_brain "$@" ;;
  --test-install-brain) install_brain ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
