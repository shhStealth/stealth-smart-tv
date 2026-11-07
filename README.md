# Stealth Smart TV

A no-ads, no-tracking "smart TV" homescreen you self-host on any PC that's
plugged into a TV over HDMI. The TV just displays whatever that PC shows —
no native smart-TV OS, no ACR tracking, no ads on the homescreen.

Tiles are entirely yours: there are **no default apps or logos shipped** —
you add each one yourself from the dashboard (name, URL, optional uploaded
icon). That's deliberate: shipping default tiles for named streaming
services would mean bundling their logos, which isn't this project's to
redistribute. Add whatever you actually use — a media server, a streaming
site, a weather page, anything with a URL.

## Quick start

No pip installs, no build step — the backend is a single stdlib-only
Python file.

```sh
git clone <this repo>
cd stealth-smart-tv
python3 server.py
# open http://localhost:8765 in a browser
```

Or with Docker (recommended if you want it to survive reboots — see
"Running with Docker" below):

```sh
docker compose up -d
```

Either way, on first run the dashboard is empty except for a dashed **"+
Add app"** tile. Click it, fill in a name and URL, optionally upload an
icon (PNG/JPEG/GIF/WEBP, up to 2 MB), and it's saved immediately. Hover or
focus any tile to reveal a small **×** to remove it.

Your tiles live in `data/tiles.json` and `data/icons/` (both
git-ignored — they're your data, not part of the repo). Back up or copy
that `data/` folder to carry your setup to a new machine.

Tiles shrink automatically as you add more, so they keep fitting the
screen without you needing to do anything — down to a minimum legible
size, past which the grid scrolls (mouse wheel or touch) instead of
shrinking further.

## Running with Docker

`docker-compose.yml` runs the stock `python:3.12-alpine` image directly —
no Dockerfile/build step, since the backend has zero dependencies.
`server.py` and `public/` are bind-mounted read-only (pulling a repo
update takes effect on restart, no rebuild); `data/` is bind-mounted
read-write so your tiles persist. `restart: unless-stopped` plus Docker's
own boot-enabled service means the backend comes back after a reboot or
power loss with no desktop login required — it has no GUI dependency at
all.

```sh
docker compose up -d
docker compose logs -f      # if you want to watch it
docker restart stealth-smart-tv   # after editing server.py
```

## `start.sh` / `stop.sh`

Convenience scripts for the common case of a dedicated HTPC: open (or
close) the dashboard in a normal Firefox window (not `--kiosk` mode,
which is intentionally hard to escape — a normal fullscreen window plays
nicely with Alt-Tab). Both read an optional `config.local.sh` in the same
directory (not committed — it's your own machine's overrides) for:

- `DASHBOARD_HOST` — if set to something other than `localhost`, skips
  starting a local backend entirely and just points Firefox at that host.
  Useful if you run the backend centrally on one always-on machine and
  want other TVs' PCs to just display it (see "Multiple TVs" below).
- `ROKU_IP` — optional, see "Optional: Roku TV integration" below.
- `TV_GEOMETRY` — optional, for a machine with more than one display
  (e.g. a gaming PC where the TV is a secondary output, separate from the
  main monitor). If set, `start.sh` uses `wmctrl` (X11 only) to move the
  dashboard window onto that output and make it fullscreen there instead
  of wherever Firefox happened to open it. Format is `gravity,x,y,w,h`
  for `wmctrl -e` — find your layout with `DISPLAY=:0 xrandr --query`.
  Leave unset on a single-display machine (e.g. a Wayland HTPC box whose
  only output *is* the TV) — press F11 in Firefox for borderless
  fullscreen there instead.

```sh
# example config.local.sh
export DASHBOARD_HOST=100.x.x.x   # a Tailscale IP, say
export ROKU_IP=192.168.1.50
export TV_GEOMETRY=0,1920,0,1920,1080
```

## Multiple TVs / rooms

If you're running this on more than one TV, host the backend on whichever
machine is on 24/7, and on the others just set `DASHBOARD_HOST` in
`config.local.sh` to that machine's IP — no `server.py`/`public/`/`data/`
copy needed on the other machines at all, just `start.sh`, `stop.sh`, and
the one-line override.

## Optional: Roku TV integration

If one of your TVs is itself a Roku TV, set `ROKU_IP` to its LAN IP (and
enable ECP — Settings → System → Advanced system settings → Control by
mobile apps → Network access → Permissive or Default) and `server.py`
will proxy a couple of ECP calls:

- `start.sh` sends `tvinput.hdmi2` so the TV switches to this PC's input
  automatically (adjust the input number for your wiring).
- The header's "On TV" line polls `/query/active-app` so you can see at a
  glance if the TV's drifted off this input (e.g. after a power cycle).

This is a genuinely optional fallback, not a dependency — with `ROKU_IP`
unset, both of those are silently inert and everything else works
exactly the same. There's no "switch back to this PC" tile in the
dashboard, since by definition you can't see that tile unless the TV's
already showing it; switch back with the remote/TV buttons if it drifts.

Also worth knowing: the Roku remote only talks to the TV's own OS, with
no path to whatever's plugged into an HDMI input — there's no way around
needing a mouse/keyboard (or a KVM-style input-sharing tool like
[Deskflow](https://github.com/deskflow/deskflow)) to actually drive the
dashboard once the TV's showing it.

## Why browser tabs, not native TV-OS channels

If you do have a Roku (or similar) TV, it's tempting to launch its native
streaming apps via ECP instead of opening the same service in a browser
tab. Don't, unless you have a specific reason to — it's janky: launching
a native channel switches the TV *away* from this PC's input, so you'd
need the TV's own remote to drive it, and then back to a mouse/keyboard
for every browser tile. Keeping everything as a browser tab means one
input device for the whole dashboard, no mode-switching. The trade-off:
services using Widevine DRM are capped at L3 on Linux/Firefox, which can
mean lower resolution than a native app's hardware-backed DRM, or rarely
a refusal to play — varies a lot by service, worth just testing each one.

## Navigation

Tiles are focusable buttons. Arrow keys (Left/Right) + Enter move focus
and open a tile — works with a wireless keyboard, or a controller running
a D-pad-to-keyboard mapper. Mouse/touch also works directly.

## Security note

There's no authentication on *viewing* the dashboard — it's meant for a
trusted home network (or something like Tailscale), not the open
internet. Don't port-forward it.

Adding/removing tiles can optionally be gated with a shared token: set
`EDIT_TOKEN` (env var) to any value you choose, and the dashboard will
prompt for it the first time you add or remove a tile from a given
browser, then remember it. Leave `EDIT_TOKEN` unset (the default) and
anyone who can reach the dashboard can edit tiles with no prompt at all,
same as viewing — fine for a single-household LAN, less fine if you're
exposing this more broadly.

## Also worth doing, separately

This project doesn't touch ACR/tracking on the TV itself — if your TV has
a "smart TV experience"/viewing-data setting, turn it off in its own
settings, and consider Pi-hole/AdGuard Home as your router's DNS if you
want telemetry blocked network-wide too.

## License

MIT — see `LICENSE`.
