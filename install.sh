#!/usr/bin/env bash
# install.sh — register Comm's server (and optionally ngrok tunnel) as launchd
# services that start automatically at login.
#
# Run from the comms directory:  bash install.sh
set -euo pipefail

COMMS_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node 2>/dev/null || true)"
NGROK_BIN="$(command -v ngrok 2>/dev/null || true)"

# Resolve symlinks so launchd gets a stable absolute path (handles nvm, volta, etc.)
if [ -n "$NODE_BIN" ]; then
  NODE_BIN="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$NODE_BIN" 2>/dev/null || readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
fi

echo "Comm's installer"
echo "  Directory : $COMMS_DIR"
echo "  Node      : ${NODE_BIN:-not found}"
echo "  ngrok     : ${NGROK_BIN:-not found}"
echo ""

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install Node.js first." >&2
  exit 1
fi

if [ ! -f "$COMMS_DIR/.env" ]; then
  echo "Error: .env not found. Copy .env.example and fill it in first." >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS"

# ---------------------------------------------------------------------------
# Comm's server
# ---------------------------------------------------------------------------

SERVER_PLIST="$LAUNCH_AGENTS/com.comms.server.plist"

cat > "$SERVER_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.comms.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${COMMS_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${COMMS_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/comms-server.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/comms-server.log</string>
</dict>
</plist>
PLIST

launchctl unload "$SERVER_PLIST" 2>/dev/null || true
launchctl load "$SERVER_PLIST"
echo "  ✓ Comm's server registered (com.comms.server)"

# ---------------------------------------------------------------------------
# ngrok tunnel (only if ngrok is installed and configured)
# ---------------------------------------------------------------------------

NGROK_CONFIG="$HOME/Library/Application Support/ngrok/ngrok.yml"

if [ -n "$NGROK_BIN" ] && [ -f "$NGROK_CONFIG" ] && grep -q "authtoken" "$NGROK_CONFIG" 2>/dev/null; then
  NGROK_PLIST="$LAUNCH_AGENTS/com.comms.ngrok.plist"

  cat > "$NGROK_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.comms.ngrok</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NGROK_BIN}</string>
    <string>start</string>
    <string>comms</string>
    <string>--log</string>
    <string>/tmp/ngrok-comms.log</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ngrok-comms.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ngrok-comms.log</string>
</dict>
</plist>
PLIST

  launchctl unload "$NGROK_PLIST" 2>/dev/null || true
  launchctl load "$NGROK_PLIST"
  echo "  ✓ ngrok tunnel registered (com.comms.ngrok)"
else
  echo "  — ngrok skipped (not installed or not configured)"
fi

# ---------------------------------------------------------------------------

echo ""
echo "Done. Services will start automatically at login."
echo ""
echo "Logs:"
echo "  tail -f /tmp/comms-server.log"
echo "  tail -f /tmp/ngrok-comms.log"
echo ""
echo "To stop:"
echo "  launchctl unload ~/Library/LaunchAgents/com.comms.server.plist"
echo "  launchctl unload ~/Library/LaunchAgents/com.comms.ngrok.plist"
