# V Bot Architecture

## Product goal

V Bot is an iOS-first agent messaging app with Grok Bot-quality interaction design. It keeps OpenMausBot's secure mobile pairing and companion transport, while allowing Grok Bot 0.18 Reconstructed to act as the primary desktop agent engine.

## Trust boundary

```text
V Bot iOS
  -> authenticated OpenMaus companion/control plane
  -> loopback-only engine adapter on the paired Mac
  -> OpenMaus runtime or Grok Reconstructed runtime
```

The phone never connects directly to Grok Reconstructed, Docker, VNC, or an unauthenticated loopback service. The adapter must not expose credentials, local paths, ports, image identifiers, viewer URLs, or raw engine payloads.

## Compatibility contract

The mobile app consumes one stable V Bot contract regardless of engine:

- engine availability and capability reasons
- bot and group roster
- conversation history and streaming events
- send, stop, steer, and queue
- attachments
- compact tool and agent-to-agent activity
- profile/model controls where the engine supports them
- safe VM lifecycle, status, and screen projection

Every capability is explicit. Unsupported or unstable reconstructed behavior is disabled with a human-readable reason; the bridge must never invent or guess an undocumented route.

## Product identity

- Visible product name: V Bot
- Master icon and mascot: Vincent's approved white V Bot droplet on black glass
- Preserve the existing iOS bundle identifier, pairing protocol, URL scheme, Bonjour identity, and data directory until a deliberate migration is shipped
- Retain Apache-2.0 license and required OpenMausBot attribution in About and repository documentation
- Do not reuse Grok/xAI trademarks, icons, proprietary assets, or imply affiliation

## Delivery order

1. Detect Grok Reconstructed locally and report version/capabilities.
2. Bridge roster, history, sending, and streaming using stable local interfaces.
3. Bridge stop/steer/queue, attachments, profiles, and groups.
4. Project safe VM status/screens and bounded controls through existing companion authorization.
5. Finish V Bot branding, motion, haptics, pinned chats, compact activity, and settings parity.
6. Verify both engines, remote pairing, reconnects, backgrounding, and TestFlight installation.

OpenMaus remains a fallback engine until Grok Reconstructed reaches equivalent verified coverage.

## Verified in this slice

The desktop harness can:

- Detect Grok Bot 0.18 Reconstructed on loopback and report why it is unavailable
- List reconstructed bots as session/model options after `GET /health` and `POST /api/listAgents`
- Send a prompt and read reply text through `POST /api/sendPrompt` and `POST /api/getAgentTranscriptTail`

Stop/steer/queue, attachments, MCP, computer-use, reconstructed `/events`, and any companion or iOS reconstructed proxy are out of scope. Companion still only exposes the existing authenticated OpenMaus control plane.
