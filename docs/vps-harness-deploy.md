# VPS harness deploy (Linux)

Headless OpenMausBot on a Linux VPS (e.g. Servarica): harness + companion + subscription engine CLIs.

## Quick start

On the VPS as root (or with sudo):

```sh
cd ~/Github/OpenMausBot   # or git clone your fork
git checkout <your-branch>
bun run deploy:vps-harness
```

This will:

1. Build `dist-server` + `dist-companion`
2. Sync to `/opt/openmausbot/runtime`
3. Install **Codex**, **Cursor**, and **Claude** CLIs if missing (`~/.local/bin`)
4. Install systemd units with `PATH` that includes `~/.local/bin` (fixes `cursor-agent` spawn failures)
5. Enable + restart `openmausbot-harness` and `openmausbot-sidecar`

## Flags

| Flag | Effect |
|------|--------|
| `--skip-build` | Reuse existing dist trees |
| `--skip-engines` | Do not npm/curl install CLIs |
| `--skip-restart` | Install files only |
| `--engines=codex,cursor` | Subset of engines to install (default: `codex,cursor,claude`) |

## Engine auth (required once per VPS)

After deploy, authenticate each engine on the **same machine** the harness runs on:

```sh
# Codex (ChatGPT OAuth)
codex login

# Cursor (browser URL or API key)
cursor-agent login
# optional headless: add to /etc/systemd/system/openmausbot-harness.service.d/cursor.conf
#   [Service]
#   Environment=CURSOR_API_KEY=...

# Claude
claude login
```

Or copy `~/.codex/auth.json` from a Mac that is already logged in.

Then:

```sh
systemctl restart openmausbot-harness.service
curl -s http://127.0.0.1:8799/api/instances | jq '.instances[] | {id:.instanceId, state:.snapshot.state, auth:.snapshot.authenticated}'
```

## Layout

| Path | Purpose |
|------|---------|
| `/opt/openmausbot/runtime` | Built server + companion + start scripts |
| `/var/lib/openmausbot` | Harness user data (`bots.json`, `messages.db`, VPS config) |
| `/var/lib/openmausbot-companion` | Sidecar pairing state |
| `/var/log/openmausbot/` | harness + sidecar logs |

## Mac mini vs VPS

- **Mac mini:** `bun run deploy:hosted-runtime` — launchd, Local VM image prep
- **Linux VPS:** `bun run deploy:vps-harness` — systemd, BYO-VPS computer containers

Phone pairs via hosted HTTPS (`OMB_COMPANION_HOSTED_URL`, default `https://openmaus.posival.com`).

## Gotcha: PATH

`cursor-agent` installs to `~/.local/bin`. Without that on the harness `PATH`, turns fail with:

> `cursor-agent` isn't installed, or isn't on this app's PATH

The deploy script sets this in systemd and in `start-harness.sh`. Do not remove it.
