# Grok Bot 0.18 Reconstructed

OpenMausBot can use a locally installed **Grok Bot 0.18 Reconstructed** desktop
app as an optional engine. This is a compatibility adapter, not a replacement
for OpenMausBot's own bots, CLI engines, or iOS companion.

The official Grok CLI (`grokAgent`) and xAI API (`grok`) engines are unchanged.
If the reconstructed app is missing or stopped, OpenMausBot keeps working.

## Security boundary

iPhone and iPad clients still talk only to OpenMausBot's authenticated
companion / control plane. They never receive:

- reconstructed loopback ports or URLs
- the local gateway discovery token
- reconstructed host filesystem paths

The desktop harness is the only process that may read `~/.grokbot/gateway.json`
and call `127.0.0.1`. A non-loopback advertised host is refused. Companion
does not proxy reconstructed routes.

## What this slice supports

Detection verifies the reconstructed process identity and these
loopback methods:

| Capability | Local method | When |
|---|---|---|
| Runtime health | `GET /health` | detection |
| Bot / session discovery | `POST /api/listAgents` | detection |
| V Bot interoperability | `GET /vbot/v1` | detection, optional |
| Bots / groups / providers / router / activity | `GET /vbot/v1/...` | read |
| Host provider / Cursor model | `PUT /vbot/v1/router` | mutation |
| Send a chat turn | `POST /vbot/v1/bots/{id}/turns` or `POST /api/sendPrompt` | send time |
| Steer | `POST /vbot/v1/bots/{id}/steer` | send time |
| Stop | `POST /vbot/v1/bots/{id}/stop` | when the runner interrupt is bound |
| Read reply text | `POST /api/getAgentTranscriptTail` | OpenMaus provider send time |

iPhone clients still talk only to authenticated OpenMaus `/api/vbot/*`
routes. Those routes never return gateway URLs, tokens, or host paths.
OpenMaus roster fallback is read-only: a selected Grok Reconstructed engine
does not silently send, steer, or stop on OpenMaus.

`sendPrompt` and transcript tail are not claimed during detection unless
`/vbot/v1` advertises them, because probing `sendPrompt` would send a real
turn. If they are missing at send time, the turn fails with a public reason.

Undocumented reconstructed routes, including `/events`, are not guessed.

## Setup

1. Install and launch **Grok Bot 0.18 Reconstructed** on this Mac. It uses
   bundle id `com.anysphere.sand.reconstructed` and must stay distinct from
   the official Grok Bot app.
2. Leave OpenMausBot's own data in `~/.openmausbot`. Do not point iOS at the
   reconstructed app.
3. In OpenMausBot, choose the **Grok Reconstructed** engine. Available
   reconstructed bots appear as model/session options (`active` follows the
   reconstructed app's current bot).
4. Send from OpenMausBot (desktop or a paired phone). The phone request still
   lands on OpenMausBot; the Mac forwards only the prompt text to the local
   reconstructed session.

The reconstructed app owns that session's native transcript. OpenMausBot
records the turn in its own store. The two histories are not merged.

## Unavailable reasons

The engine stays visible when it cannot run. Reasons are public and do not
include ports, tokens, or paths:

- reconstructed app not found
- installed but not running
- a local Grok Bot host is running, but it is not the reconstructed app
- discovery advertised a non-loopback address
- `/health` or `listAgents` is missing

## Out of scope for this slice

- Publishing reconstructed ports through Companion, Bonjour, Tailscale, or
  hosted HTTPS
- Changing OpenMausBot or iOS bundle, protocol, or data identifiers
- Approvals, computer-use, MCP, or attachments against reconstructed APIs
- Treating official Grok Bot as reconstructed
- Queueing on Grok Reconstructed
- Silently sending, steering, or stopping on OpenMaus while Grok Reconstructed is the selected engine

## Freeze (2026-08-29)

**Grok Reconstructed is frozen as an optional legacy adapter.** Invest in native Codex / Cursor / Claude drivers and the iOS companion. Do not expand reconstructed `/events`, queueing, attachments, MCP, or computer-use. Do not claim live-phone verification of reconstructed turns from a Linux Cloud Agent.

Wave 35 Grok **interaction** parity (share, hidden chats, unread, haptics, group setup) is native V Bot work — see `docs/ios-grok-parity-wave35.md`. That checklist is shipped-or-waived in-repo; `swift test` / xcodegen / TestFlight remain the MacBook lane.

