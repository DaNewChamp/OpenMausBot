# V Bot Desktop Architecture

V Bot’s desktop app is a clean-room UI over the existing MIT/Apache OpenMausBot desktop, harness, companion, and bridge pipeline. The staged desktop migration changes the visible product name and artifacts while retaining the legacy bundle, protocol, data, and network contracts.

Upstream license and attribution remain in `LICENSE`, `README.md`, and third-party notices. Visible product copy in this private tree says **V Bot**.

## Desktop identity and rollback

- New packages are branded **V Bot** and register `vbot://` package links.
- `com.openmausbot.app` and `openmausbot://` remain registered for existing
  installations, package links, CUA permissions, and companion clients.
- When an `OpenMausBot` user-data directory already exists, V Bot continues to
  use it in place. It does not copy, merge, delete, or silently split state;
  credentials, pairings, transcripts, and window state therefore remain
  available to the previous OpenMausBot build.
- New installations use Electron's normal V Bot user-data directory. An
  explicit migration can be added later after a backup/export contract is
  agreed; until then rollback is simply reinstalling the prior OpenMausBot
  build, which reads the same legacy directory.

## Updates

Desktop artifacts do not contain a public OpenMausBot release feed. The
updater stays disabled unless `VBOT_UPDATE_FEED_URL` is explicitly set to a
private HTTPS feed. The packaged app configures electron-updater for that
generic feed only; credentials, query strings, and non-HTTPS URLs are rejected.

## Source of truth

The **desktop app and/or the VPS harness** own durable state:

- bot roster, rooms, pins, and Chief of Staff
- transcripts, unreads, and active thread leaves
- routines and webhook triggers
- Local VM / VPS / cloud computer ownership
- provider credentials and engine CLIs
- pairing registry and device grants

```text
 iPhone (V Bot, thin client)
       │  paired companion (LAN / hosted HTTPS / Tailscale)
       ▼
 companion sidecar (allowlist, SSE scrubbing)
       │  loopback only
       ▼
 harness server (127.0.0.1)
       │
       ▼
 desktop / VPS data dir  —  bots, messages, config, VM workspaces
```

There is no second database on the phone. A send, approval, pin, or unread change hits the harness immediately. If the desktop/VPS is asleep, the client cannot read or write.

## iOS as a thin client

The phone stores pairing trust (Keychain) and a live view of harness state. It must never receive:

- provider API keys, tokens, or CLI paths
- Local VM host paths, image IDs, commands, ports, or loopback viewer URLs
- raw engine payloads or unauthenticated loopback routes

Interactive Local VM remains an explicit per-device grant. Default is off.

## Bot, thread, and unread sync

- Roster and threads are harness-authored. The desktop shell and the phone fold the same bot/group records.
- Unread is a harness flag. Opening a conversation on any paired surface PATCHes `unread: false`.
- Pins, Chief of Staff, and section labels live on the bot/group record so every client sees the same order.

## Provider secret isolation

Provider keys stay on the desktop or VPS. The renderer settings UI and the companion catalog expose **names, models, and capability flags only**.

Mobile receives a **sanitized catalog**: instance id, display name, driver kind, and default model. It does not receive credentials, file paths, or secret material. `sanitizeProviderCatalog()` is the desktop-side contract for that shape.

## QR / pairing trust

Pairing is device trust, not account login:

1. Desktop/VPS companion issues a short-lived code (QR or manual).
2. The phone stores the device token in Keychain.
3. Subsequent calls use that token against the companion allowlist.
4. Companion still does not proxy reconstructed loopback URLs, tokens, or host paths.

Revocation is a desktop/VPS registry change. A lost phone is unpaired there; the phone cannot mint a new trust relationship by itself.

## VM ownership

Local VM and VPS computers are owned by the harness host:

- The Mac or VPS creates, stops, and recreates containers.
- Viewer URLs stay loopback or SSH-tunneled on that host.
- The phone may watch a proxied frame or granted viewer; it does not own the VM.
- Auto-provision of cloud boxes remains the existing Computer panel lifecycle when that panel is opened — it is not a phone-side create.

## Desktop shell (phase 1)

The Electron renderer is a three-column product shell over the existing store/runtime:

- Left: traffic-light-safe header, search, pinned Chief card, compact conversations, Plugins, profile
- Center: compact bot/model header, dark transcript, bubbles, centered provenance, pill composer
- Right: computer watch, screen label, routines, Local VM/VPS badge, bridge status, secure pairing, provider management

Right rail collapses first as the window narrows, then the left rail becomes an overlay drawer. Chat, stream, and tool behavior is unchanged.

## Demo fixture

`?vbotDemo=1` hydrates a deterministic in-renderer fixture (no production data, no network). Use it for layout screenshots. Do not commit reference or screenshot files.
