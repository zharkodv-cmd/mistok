#!/usr/bin/env bash
# Mistok installer (macOS, Linux). Safe to re-run — that's also how you update after `git pull`.
#   ./install.sh                 venv + `mistok` on PATH + the bridge auto-starts (macOS: launchd)
#   ./install.sh --with-import   + Playwright/Chromium for web import (a URL in the panel chat)
#   ./install.sh --uninstall     stop the bridge, remove the auto-start and the `mistok` command
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
LABEL="com.mistok.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

ours() {  # does this `mistok` command run this repo: a symlink to ./mistok, or our wrapper?
  [ -n "$1" ] && { [ "$(readlink "$1" 2>/dev/null)" = "$ROOT/mistok" ] || grep -qs "$ROOT/mistok" "$1"; }
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ "$(uname)" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
  fi
  for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
    if ours "$d/mistok"; then rm -f "$d/mistok"; fi
  done
  say "Mistok removed. The repo folder (and its venv) is yours to delete; in Figma: Plugins → Development → Manage plugins"
  exit 0
fi

# ── Python 3.10+ and the venv ────────────────────────────────────────────────
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
    PY="$(command -v "$c")"; break
  fi
done
[ -n "$PY" ] || { echo "Python 3.10+ is required (macOS: brew install python)" >&2; exit 1; }
if ! venv/bin/python -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
  say "Creating venv ($("$PY" --version))"
  rm -rf venv
  "$PY" -m venv venv
fi
say "Installing Python dependencies"
venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
if [ "${1:-}" = "--with-import" ]; then
  say "Installing Playwright + Chromium (web import)"
  venv/bin/python -m pip install -q --disable-pip-version-check playwright
  venv/bin/python -m playwright install chromium
fi

# ── the `mistok` command ─────────────────────────────────────────────────────
chmod +x mistok bridge.py webimport.py start-bridge.sh
if ours "$(command -v mistok || true)"; then
  say "mistok already on PATH: $(command -v mistok)"
else
  BIN=""
  for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
    case ":$PATH:" in *":$d:"*) if [ -w "$d" ]; then BIN="$d"; break; fi ;; esac
  done
  if [ -z "$BIN" ]; then
    BIN="$HOME/.local/bin"
    mkdir -p "$BIN"
    say "Add $BIN to your PATH (e.g. in ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\")"
  fi
  printf '#!/bin/sh\nexec "%s/venv/bin/python" "%s/mistok" "$@"\n' "$ROOT" "$ROOT" > "$BIN/mistok"
  chmod +x "$BIN/mistok"
  say "mistok → $BIN/mistok"
fi

# ── the bridge: start now and at every login ─────────────────────────────────
CLAUDE_BIN="$(command -v claude || true)"
if [ "$(uname)" = Darwin ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$ROOT/venv/bin/python</string><string>$ROOT/bridge.py</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>MISTOK_CLAUDE</key><string>$CLAUDE_BIN</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mistok-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/mistok-bridge.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 30); do  # bootout returns before the old bridge has exited
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then break; fi
    sleep 1
  done
  for _ in $(seq 1 20); do
    curl -sf localhost:8787/status >/dev/null && break
    sleep 0.25
  done
  if curl -sf localhost:8787/status >/dev/null; then
    say "Bridge running on http://localhost:8787 (launchd: $LABEL, log /tmp/mistok-bridge.log)"
  else
    echo "Bridge did not start — see /tmp/mistok-bridge.log" >&2
    exit 1
  fi
else
  say "Start the bridge: ./start-bridge.sh (tmux) or ./venv/bin/python bridge.py"
fi

cat <<EOF

Done. In Figma Desktop:
  1. Plugins → Development → Import plugin from manifest… → $ROOT/plugin/manifest.json  (once)
  2. Plugins → Development → Mistok  (⌘⌥P re-runs the last plugin)
Check:  mistok status   →  "plugin_connected": true
EOF
if [ -n "$CLAUDE_BIN" ]; then
  echo "Claude Code: $CLAUDE_BIN (chat + Claude buttons)"
else
  echo "Claude Code not found — the chat and Claude buttons need it: https://claude.com/claude-code, then re-run ./install.sh"
fi
echo "Optional: FREEPIK_API_KEY=… in $ROOT/.env for one-click photo fill; ./install.sh --with-import for web import."
