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

Detection only verifies the reconstructed process identity and these
loopback methods:

| Capability | Local method | When |
|---|---|---|
| Runtime health | `GET /health` | detection |
| Bot / session discovery | `POST /api/listAgents` | detection |
| Send a chat turn | `POST /api/sendPrompt` | send time |
| Read reply text | `POST /api/getAgentTranscriptTail` | send time |

`sendPrompt` and transcript tail are not claimed during detection, because
probing them would send a real turn. If they are missing at send time, the
turn fails with a public reason.

Undocumented reconstructed routes, including `/events`, are not guessed.
Interrupt stops OpenMausBot from waiting on the reply; it does not invent a
reconstructed cancel API.

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
