# V Bot Architecture

## Product goal

V Bot is an iOS-first agent messaging app with Grok Bot-quality interaction design. It keeps OpenMausBot's secure mobile pairing and companion transport, while allowing Grok Bot 0.18 Reconstructed to act as the primary desktop agent engine.

The headless OpenMausBot hub remains the system of record. The optional desktop
app is a local shell around that hub; iOS never owns an engine process.

## Trust boundary

```text
V Bot iOS
  -> authenticated OpenMaus companion/control plane
  -> loopback-only engine adapter on the paired Mac
  -> OpenMaus runtime, Grok Reconstructed runtime, or Hermes TUI gateway
```

The phone never connects directly to Grok Reconstructed, Docker, VNC, or an unauthenticated loopback service. The adapter must not expose credentials, local paths, ports, image identifiers, viewer URLs, or raw engine payloads.

Hermes Bot Chat is a hub-owned, opt-in adapter. It talks to the locally
installed Hermes CLI in `--tui` mode over its loopback process boundary and
projects only the shared V Bot event contract. A bot's exact binding is
`adapter: "hermesBot"`, a validated `profile`, `canonicalTitle: "Bot Chat"`,
and `bindingVersion: 1`; the binding sidecar is private hub state, not an iOS
wire field.

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

Hermes Wave 1 currently supports roster/discovery, the canonical Bot Chat,
send, final responses, streaming events, and stop. Hermes does not advertise
or emulate routines, agent messaging, groups, cross-machine work, queueing,
steer, attachments, or computer integrations until each has a real adapter
contract.

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
3. Keep Hermes Bot Chat on its exact binding and loopback adapter, with stop and
   setup failures failing closed rather than falling through to another provider.
4. Bridge stop/steer/queue, attachments, profiles, and groups where each
   engine has a verified contract.
5. Project safe VM status/screens and bounded controls through existing companion authorization.
6. Finish V Bot branding, motion, haptics, pinned chats, compact activity, and settings parity.
7. Verify both engines, remote pairing, reconnects, backgrounding, and TestFlight installation.

OpenMaus remains a fallback engine until Grok Reconstructed reaches equivalent verified coverage.

## Verified in this slice

The desktop harness can:

- Detect Grok Bot 0.18 Reconstructed on loopback and report why it is unavailable
- List reconstructed bots as session/model options after `GET /health` and `POST /api/listAgents`
- Read `/vbot/v1` bots, groups, providers, router, and activity
- Set the host-wide reconstructed provider and Cursor model
- Submit, steer, and stop a selected reconstructed bot through authenticated `/api/vbot/*` companion routes
- Keep OpenMaus roster fallback read-only: mutating send/steer/stop never silently change engines

The Hermes Wave 1 harness can discover a local gateway, resolve the canonical
Bot Chat, send and stream a bound profile, and stop it through the same event
bus. A valid Hermes binding remains authoritative when the adapter is disabled;
an unavailable or unreadable binding store produces a fixed setup failure and
never selects the bot's stored generic provider. Unbound bots retain the
existing ProviderAdapter behavior, including generic Hermes ACP.

Queueing, attachments, MCP, computer-use, reconstructed `/events`, and merged transcripts remain out of scope. Companion still does not proxy reconstructed loopback URLs, tokens, or host paths.
