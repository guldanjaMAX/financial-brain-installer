#!/usr/bin/env bash
# Financial Brain preflight. Reads the machine, changes nothing.
# Every line is a read. No installs, no writes, no credentials printed.
ok(){ printf "  ok    %s\n" "$1"; }
warn(){ printf "  WARN  %s\n" "$1"; WARNED=$((WARNED+1)); }
stop(){ printf "  STOP  %s\n" "$1"; STOPPED=$((STOPPED+1)); }
WARNED=0; STOPPED=0; FRESH=0; NOMANIFEST=0
echo "Financial Brain preflight  -  $(date '+%Y-%m-%d %H:%M')"
echo

echo "MACHINE"
printf "  os              %s %s\n" "$(uname -s)" "$(uname -r)"
if command -v node >/dev/null 2>&1; then
  NV=$(node -v); NMAJ=${NV#v}; NMAJ=${NMAJ%%.*}
  printf "  node            %s (%s)\n" "$NV" "$(command -v node)"
  [ "$NMAJ" -ge 22 ] 2>/dev/null || stop "node $NV is too old; the installer needs 22 or newer"
else stop "node is not installed"; fi
command -v npm >/dev/null 2>&1 && printf "  npm             %s\n" "$(npm -v 2>/dev/null)" || stop "npm is not installed"
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  stop "this shell is running as root; close it and use a normal Terminal without sudo"
else
  ok "running as the current user without root elevation"
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FREE_KIB=$(df -Pk "$SCRIPT_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')
if [ -z "$FREE_KIB" ] || ! [ "$FREE_KIB" -ge 0 ] 2>/dev/null; then
  stop "free space could not be checked on the drive containing this Brain CLI"
elif [ "$FREE_KIB" -lt 2097152 ]; then
  stop "the actual install drive has less than 2 GiB free; free 2 GiB and rerun this check"
else
  ok "actual install drive has at least 2 GiB free"
fi
echo

echo "THE BRAIN CLI"
# This script is Bash, so use Bash's portable all-PATH lookup. `command -v -a`
# is not a valid Bash command and silently made every machine look fresh.
COPIES=$(type -a -P brain 2>/dev/null | sort -u)
N=$(printf "%s" "$COPIES" | grep -c . )
if [ "$N" -eq 0 ]; then
  # The script may be called by its full installed path precisely because the
  # current shell has not inherited the npm prefix yet. Prefer the CLI beside
  # this exact installed package, then the two supported per-user prefixes.
  PACKAGE_PREFIX=$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")")
  PACKAGE_CLI="$PACKAGE_PREFIX/bin/brain"
  LOCAL_CLI=""
  if [ -x "$PACKAGE_CLI" ]; then
    LOCAL_CLI=$PACKAGE_CLI
  else
    for CANDIDATE in "$HOME/.financial-brain/bin/brain" "$HOME/.npm-global/bin/brain"; do
      if [ -x "$CANDIDATE" ]; then
        if [ -n "$LOCAL_CLI" ] && [ "$LOCAL_CLI" != "$CANDIDATE" ]; then
          stop "more than one installed Brain CLI exists outside PATH; use the exact package path and repair PATH before continuing"
          LOCAL_CLI=""
          break
        fi
        LOCAL_CLI=$CANDIDATE
      fi
    done
  fi
  if [ -n "$LOCAL_CLI" ]; then
    warn "'brain' is not on PATH, but the installed CLI is available at $LOCAL_CLI; use that full path in this shell"
  elif [ "$STOPPED" -eq 0 ]; then
    FRESH=1; warn "no installed Brain CLI was found (expected before a first install)"
  fi
elif [ "$N" -eq 1 ]; then
  ok "resolves to $COPIES"
else
  stop "$N copies of 'brain' on PATH; the first one wins and it may not be the one you updated"
  printf "%s\n" "$COPIES" | sed 's/^/          /'
fi
if command -v npm >/dev/null 2>&1; then
  PFX=$(npm config get prefix 2>/dev/null)
  printf "  npm prefix      %s\n" "$PFX"
  [ -n "$COPIES" ] && case "$COPIES" in "$PFX"*) : ;; *) warn "the CLI is NOT under the npm prefix; a plain 'npm i -g' will install somewhere else and leave the old one running" ;; esac
fi
echo

echo "CLOUDFLARE ACCESS"
if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
  warn "CLOUDFLARE_API_TOKEN is present; this preflight does not use or validate it. Check the install's saved auth method with its exact CLI."
else ok "no CLOUDFLARE_API_TOKEN in the environment"; fi
WFORMAT=""
# Match operations/wrangler-oauth.mjs exactly. Inspect files, not merely an
# earlier directory, so an empty directory cannot hide a usable later session.
WCFG_CANDIDATES=("$HOME/.config/.wrangler/config" "$HOME/.wrangler/config")
if [ "$(uname -s)" = "Darwin" ]; then
  WCFG_CANDIDATES=("$HOME/Library/Preferences/.wrangler/config" "${WCFG_CANDIDATES[@]}")
fi
if [ -n "$XDG_CONFIG_HOME" ]; then
  WCFG_CANDIDATES=("$XDG_CONFIG_HOME/.wrangler/config" "${WCFG_CANDIDATES[@]}")
fi
for WCFG in "${WCFG_CANDIDATES[@]}"; do
  if [ -f "$WCFG/default.toml" ]; then WFORMAT="toml"; break
  elif [ -f "$WCFG/default.enc" ]; then WFORMAT="encrypted"; break
  fi
done
if [ "$WFORMAT" = "toml" ]; then ok "wrangler session found (legacy default.toml only; current named-profile authorization is not checked)"
elif [ "$WFORMAT" = "encrypted" ]; then warn "wrangler wrote default.enc; legacy-file discovery cannot verify the current named browser profile"
else warn "no legacy wrangler session found; current named-profile setup can still be used"; fi
warn "Cloudflare authorization is not proven here. Use the exact installed CLI and the saved manifest for its supported owner sign-in and account checks."
echo

echo "NETWORK"
for pair in "api.github.com|https://api.github.com" "github.com|https://github.com" "release assets|https://release-assets.githubusercontent.com"; do
  H=${pair%%|*}; U=${pair##*|}
  C=$(curl -s -o /dev/null -w '%{http_code}' -m 12 "$U" 2>/dev/null)
  case "$C" in 2*|3*|4*) ok "$H reachable (http $C)" ;; *) stop "$H unreachable (http ${C:-000}); the download will fail" ;; esac
done
echo

echo "RELEASE"
LATEST=$(curl -s -m 15 https://api.github.com/repos/guldanjaMAX/financial-brain-installer/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
[ -n "$LATEST" ] && ok "current release is $LATEST" || warn "could not read the current release"
if [ "$N" -ge 1 ] && command -v npm >/dev/null 2>&1; then
  INST=$(npm ls -g --depth=0 2>/dev/null | sed -n 's/.*brain-installer@\([0-9.]*\).*/\1/p' | head -1)
  [ -n "$INST" ] && { printf "  installed       %s\n" "$INST"; [ "v$INST" = "$LATEST" ] || warn "installed $INST is not the current release $LATEST"; }
fi
echo

echo "MANIFESTS"
POINTER_HELPER="$SCRIPT_DIR/../operations/installed-manifest.mjs"
SELECTED_MANIFEST=$(node "$POINTER_HELPER" --preflight-locator 2>/dev/null)
POINTER_STATUS=$?
if [ "$POINTER_STATUS" -eq 0 ]; then
  MF=$SELECTED_MANIFEST
  MN=1
  ok "using the saved installed manifest: $MF"
elif [ "$POINTER_STATUS" -eq 2 ]; then
  MF=$(find "$HOME" -maxdepth 4 -name brain.manifest.json -not -path "*/node_modules/*" -not -path "*/templates/*" -not -path "*/.*/*" 2>/dev/null)
  MN=$(printf "%s" "$MF" | grep -c .)
elif [ "$POINTER_STATUS" -eq 3 ]; then
  MF=""; MN=0
  stop "the saved installed Brain location is unsafe, unreadable, or missing; repair that private pointer before choosing a manifest"
else
  MF=""; MN=0
  stop "the installed Brain manifest selector could not run; use the exact installed package before choosing a manifest"
fi
if [ "$POINTER_STATUS" -eq 2 ] && [ "$MN" -eq 0 ]; then NOMANIFEST=1; ok "no manifest yet (expected before a first install)"
elif [ "$POINTER_STATUS" -eq 2 ] && [ "$MN" -eq 1 ]; then
  ok "one manifest: $MF"
fi
if [ "$MN" -eq 1 ] && [ "$POINTER_STATUS" -ne 3 ]; then
  DOM=$(grep -o '"domain": *"[^"]*"' "$MF" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -n "$DOM" ]; then
    H=$(curl -s -m 15 "https://$DOM/health" 2>/dev/null)
    ST=$(printf "%s" "$H" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    AD=$(printf "%s" "$H" | grep -o '"accepting_documents":[a-z]*' | cut -d: -f2)
    case "$ST" in
      ok) ok "brain at $DOM is $ST, accepting_documents=$AD" ;;
      paused-for-upgrade) stop "brain at $DOM is PAUSED (an update did not finish). See /kit/known-issues" ;;
      "") warn "no answer from https://$DOM/health" ;;
      *) warn "brain at $DOM reports status=$ST" ;;
    esac
  fi
elif [ "$POINTER_STATUS" -eq 2 ] && [ "$MN" -gt 1 ]; then
  stop "$MN manifests found; the wrong one will be picked. Ask which folder is theirs."
  printf "%s\n" "$MF" | sed 's/^/          /'
fi
echo
echo "-----"
if [ "$STOPPED" -gt 0 ]; then printf "%d thing(s) will stop the install, and %d worth knowing.\nClear the STOP lines first. Each one says what to do.\n" "$STOPPED" "$WARNED"; exit 1;
elif [ "$WARNED" -gt 0 ]; then
  if [ "$FRESH" = 1 ] && [ "$NOMANIFEST" = 1 ]; then
    printf "Nothing is wrong here. This is a machine before its first install,\nand every line above says so. Go ahead and start.\n";
  else printf "%d thing(s) to be aware of, none of them blocking. Read them, then carry on.\n" "$WARNED"; fi
  exit 0;
else echo "All clear."; exit 0; fi
