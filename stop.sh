#!/bin/bash
# Closes just the dashboard window (not your whole Firefox session) and
# stops the backend, if this machine hosts its own.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/config.local.sh" ] && source "$DIR/config.local.sh"

export DISPLAY="${DISPLAY:-:0}"
DASHBOARD_HOST="${DASHBOARD_HOST:-localhost}"

if command -v wmctrl >/dev/null 2>&1; then
  WIN_ID=$(wmctrl -l | grep "Stealth Smart TV" | head -1 | awk '{print $1}')
  if [ -n "$WIN_ID" ]; then
    wmctrl -ic "$WIN_ID"
    echo "dashboard window closed"
  else
    echo "dashboard window wasn't open"
  fi
else
  echo "wmctrl not available (Wayland) — close the dashboard window by hand"
fi

if [ "$DASHBOARD_HOST" = "localhost" ]; then
  pkill -f "python3 .*server.py" 2>/dev/null && echo "backend stopped" || echo "backend wasn't running"
else
  echo "Dashboard backend is hosted remotely on $DASHBOARD_HOST — nothing to stop locally."
fi
