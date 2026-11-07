#!/bin/bash
# Manual start for the Stealth Smart TV dashboard.
#
# - Starts the backend (if not already running) — only when hosting it
#   locally; see DASHBOARD_HOST below.
# - If ROKU_IP is set, switches that Roku TV over to this PC's input
#   (tvinput.hdmi2 == "Computer"). Optional — skipped entirely if unset.
# - Opens the dashboard in a normal Firefox window. If TV_GEOMETRY is set
#   (for a machine with more than one display, X11 + wmctrl available),
#   relocates it onto the TV's actual output and makes it fullscreen there
#   — NOT on the main monitor, and NOT Firefox's --kiosk mode (which is
#   intentionally hard to escape; a normal fullscreen window plays nicely
#   with Alt-Tab). Leave TV_GEOMETRY unset on a single-display machine
#   (e.g. a Wayland HTPC box whose only output IS the TV) — press F11 in
#   Firefox once if you want borderless fullscreen there instead.
#
# ROKU_IP and TV_GEOMETRY are both optional and both unset by default; set
# them in config.local.sh (see below) if they apply to your setup.
# TV_GEOMETRY is "gravity,x,y,w,h" for `wmctrl -e` — find your layout with
# `DISPLAY=:0 xrandr --query`.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Optional per-host overrides, not part of the shared repo copy — e.g. a
# machine that points at a centrally-hosted backend instead of running its
# own sets DASHBOARD_HOST here. See README "Where this is hosted".
[ -f "$DIR/config.local.sh" ] && source "$DIR/config.local.sh"

# Double-clicking the Desktop icon inherits the session's real DISPLAY /
# WAYLAND_DISPLAY already. This fallback only matters when testing over a
# plain SSH session, which has neither — detect what's actually running
# rather than assuming X11.
if [ -z "$WAYLAND_DISPLAY" ] && [ -z "$DISPLAY" ]; then
  if [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0" ]; then
    export WAYLAND_DISPLAY=wayland-0
  else
    export DISPLAY=:0
  fi
fi
ROKU_IP="${ROKU_IP:-}"
DASHBOARD_HOST="${DASHBOARD_HOST:-localhost}"
TV_GEOMETRY="${TV_GEOMETRY:-}"

if [ "$DASHBOARD_HOST" = "localhost" ]; then
  if ! curl -s -o /dev/null --max-time 2 http://localhost:8765/api/apps; then
    echo "Starting backend..."
    nohup python3 server.py > /tmp/stealth-smart-tv-launcher.log 2>&1 &
    disown
    sleep 1
  else
    echo "Backend already running."
  fi
else
  echo "Using the dashboard hosted on $DASHBOARD_HOST — nothing to start locally."
fi

if [ -n "$ROKU_IP" ]; then
  echo "Switching TV to this PC's input..."
  curl -s -X POST --max-time 3 "http://$ROKU_IP:8060/launch/tvinput.hdmi2" -o /dev/null || \
    echo "Warning: couldn't reach the TV to switch inputs." >&2
fi

firefox --new-window "http://$DASHBOARD_HOST:8765" &
disown

if [ -z "$TV_GEOMETRY" ]; then
  echo "TV_GEOMETRY not set — leaving the dashboard window where Firefox"
  echo "opened it. Press F11 in Firefox for borderless fullscreen."
  exit 0
fi

if ! command -v wmctrl >/dev/null 2>&1; then
  echo "wmctrl not available (likely a Wayland session) — skipping window"
  echo "relocation. Press F11 in Firefox for borderless fullscreen if you"
  echo "want it."
  exit 0
fi

WIN_ID=""
for i in $(seq 1 20); do
  WIN_ID=$(wmctrl -l | grep "Stealth Smart TV" | head -1 | awk '{print $1}')
  [ -n "$WIN_ID" ] && break
  sleep 0.3
done

if [ -n "$WIN_ID" ]; then
  wmctrl -ir "$WIN_ID" -b remove,fullscreen
  wmctrl -ir "$WIN_ID" -e "$TV_GEOMETRY"
  wmctrl -ir "$WIN_ID" -b add,fullscreen
  echo "Dashboard moved to the TV output."
else
  echo "Couldn't find the dashboard window to move it — it may have opened on your main monitor instead." >&2
fi
