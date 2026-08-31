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

## Trust split and canonical state

The VPS is a `headless-hub`. Account login is only a control-plane operation:
it discovers the VPS installation and owns managed endpoint metadata. It does
not grant access to bots or machines. A phone or desktop still needs the
hub-issued pairing credential before it can call the companion. The control
plane has no chats, transcripts, provider secrets, or SQLite state. Raw
provider secrets, account bearer values, installation credential values, and
connector tokens are not stored in D1; Better Auth persists session records and
hashed OTP values, while installation rows retain credential metadata and
SHA-256 digests.

The headless runtime has one explicit data directory, normally
`/var/lib/openmausbot`. Its stable `hub.json` identity is the installation's
`clientInstanceId`; the encrypted host store lives beside it as
`host-secret.key` and `host-secrets.bin`. Never create a second identity under a
home directory, and never delete `hub.json` as troubleshooting: deletion mints
a new hub identity and can strand the existing installation. Electron uses its
final `app.getPath("userData")` instead; its archive includes `hub.json` and
the OS-encrypted credential file there. POSIX runtimes enforce owner-only
directory/file metadata and reject symlinks or non-regular files; Windows keeps
the type/read checks and relies on its ACLs because POSIX uid/mode bits are not
available.

Presence is explicit and one-shot in Wave 1. `stopPresence()` runs during
sign-out and `dispose()` runs during app quit. There is no background heartbeat
service in this wave. `Node Only` and `Hub plus Node` remain Wave 4 deployment
compositions, not Wave 1 runtime profiles.

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

## Wave 1 headless registration

Run these commands on the VPS (or from a local checkout pointed at the VPS's
runtime directory). Every headless command requires an explicit absolute
`--data-dir`; do not rely on the current directory or an implicit environment
default:

```sh
pnpm run vbotctl -- --data-dir /var/lib/openmausbot account request-code --email owner@example.com
pnpm run vbotctl -- --data-dir /var/lib/openmausbot account verify-code --email owner@example.com
pnpm run vbotctl -- --data-dir /var/lib/openmausbot hub register --name "Home V Bot"
pnpm run vbotctl -- --data-dir /var/lib/openmausbot hub heartbeat --once
pnpm run vbotctl -- --data-dir /var/lib/openmausbot fleet list --json
```

`account verify-code` uses a hidden TTY prompt. For a non-interactive local
fixture only, pipe the short-lived code through stdin:

```sh
printf '%s\n' '12345678' | \
  pnpm run vbotctl -- --data-dir "$OMB_DATA_DIR" account verify-code \
  --email owner@example.com --stdin
```

`OMB_DATA_DIR` remains a legacy, explicit override for existing server and
Electron consumers; it is not a `vbotctl` default. `vbotctl` requires
`--data-dir` and does not read `OMB_DATA_DIR`; the injected local fixture passes
its temporary path directly through that option. The CLI does not accept OTPs,
account bearers, or installation credentials as argv values. It emits safe JSON
only and exits `0` on success, `1` on an operational failure, or `2` for a usage
error.

The local route/CLI regression is automated by
`pnpm --filter @openmausbot/control-plane exec vitest run test/vbotctl-local-smoke.test.ts`.
It uses `createWorker().fetch`, an in-memory mail capture, and dependency-
injected `runVbotctl` in the Workers pool; no VPS or deployed control plane is
involved.

## Bot computers

Cloud bots use **Self-hosted VPS** with `vps.sshAlias: openmaus-docker` — Docker on the
same machine over `ssh://127.0.0.1`. To run containers on a home Windows box instead,
add a ProxyJump SSH alias on the VPS and set `vps.sshAlias` accordingly (see `docs/byo-vps.md`).

Local VM on the phone requires a home **bridge** (Phase B); the cloud harness does not run the Mac Local VM.
See [`docs/bridge-agent.md`](bridge-agent.md).

## Backup and migration surface

The existing `scripts/backup-openmausbot-cloud.mjs` stages the selected runtime
directory recursively (while excluding only `node_modules`, `omb-hosted`, and
SQLite WAL/SHM files), so the canonical headless archive contains
`hub.json`, `host-secret.key`, and `host-secrets.bin` alongside the hub state.
The companion directory is staged separately when enabled. The script's
dry-run path does not contact Drive; use a temporary runtime directory to
assert that those three files survive a local stage/archive/extract round trip
before any operator performs a real backup or restore. No remote backup,
upload, or restore is part of Wave 1.

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

The public health check proves reachability only. Fleet presence and endpoint
metadata are account-authenticated; client access still depends on companion
pairing. Keep the control-plane account bearer and the per-installation
`omb_install_…` credential separate, and never place either value in logs,
configuration files, or command arguments.
