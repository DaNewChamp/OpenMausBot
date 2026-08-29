# Cloud VPS hosting

Run the OpenMausBot harness + phone sidecar on a Linux VPS instead of a home Mac.
The iPhone stays a thin client; bots and SQLite live on the VPS.

## Architecture

```text
 iPhone  →  https://openmaus.posival.com  →  cloudflared  →  companion (unix socket)
                                                    ↓
                                              harness :8799
                                                    ↓
                                         bots + SQLite on VPS
                                                    ↓
                              docker -H ssh://openmaus-docker  (local Docker on same VPS)
```

Optional later: a **bridge** on a home Mac exposes Local VM or LAN-only SSH targets.

## Deploy

From a machine with SSH to the VPS and the Cloudflare tunnel credentials:

```sh
bun run deploy:cloud-vps              # build + migrate + install
bun run deploy:cloud-vps --cutover  # also stop mini tunnel and verify public URL
bun run deploy:cloud-vps --host servarica --skip-build
```

| Path on VPS | Purpose |
|---|---|
| `/opt/openmausbot/runtime` | harness + companion + cloudflared binary |
| `/var/lib/openmausbot` | bots, SQLite, workspaces |
| `/var/lib/openmausbot-companion` | paired devices |
| `/etc/openmausbot/` | tunnel config + local-docker SSH key |
| `/var/log/openmausbot/` | service logs |

systemd units: `openmausbot-harness`, `openmausbot-sidecar`, `openmausbot-cloudflared`.

## Bot computers

Cloud bots use **Self-hosted VPS** with `vps.sshAlias: openmaus-docker` — Docker on the
same machine over `ssh://127.0.0.1`. To run containers on a home Windows box instead,
add a ProxyJump SSH alias on the VPS and set `vps.sshAlias` accordingly (see `docs/byo-vps.md`).

Local VM on the phone requires a home **bridge** (Phase B); the cloud harness does not run the Mac Local VM.
See [`docs/bridge-agent.md`](bridge-agent.md).

## Cutover from Mac mini

1. `bun run deploy:cloud-vps --cutover` — migrates data, starts VPS services, stops mini sidecar/tunnel.
2. Mini `com.posival.openmaus-harness` can stay for bridge work or be disabled manually.
3. Phone keeps existing pairing if `devices.json` was migrated.

## Verify

```sh
curl -sf https://openmaus.posival.com/api/health
curl -sf -o /dev/null -w '%{http_code}\n' https://openmaus.posival.com/api/bots   # expect 401
ssh servarica systemctl status openmausbot-harness openmausbot-sidecar openmausbot-cloudflared
```
