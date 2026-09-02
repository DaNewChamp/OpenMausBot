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
contract. While `groups` is false, a Hermes-bound bot cannot join or send in
a V Bot room; unreadable binding state is likewise rejected rather than
falling through to generic ProviderAdapter membership or send.

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
never selects the bot's stored generic provider. Room create/PATCH membership
and room send use the same fail-closed membership/send boundary. Unbound bots
retain the existing ProviderAdapter behavior, including generic Hermes ACP.

Queueing, attachments, MCP, computer-use, reconstructed `/events`, and merged transcripts remain out of scope. Companion still does not proxy reconstructed loopback URLs, tokens, or host paths.

## Hermes Bot Mode adapter boundary (Wave 1)

Hermes Bot Mode is a hub-owned, opt-in profile adapter behind the existing provider
fleet. It is **not** a `VBotPrimaryEngine` and does not change iOS/companion wire
contracts. The separate internal registry talks to the locally installed Hermes CLI
in `--tui` loopback mode and publishes normalized events into the existing EventBus.

V Bot Store and SSE remain the mobile transcript source of truth. Bindings store
only V Bot bot id, validated profile slug, literal `Bot Chat` title, and schema
version in private hub state. Wave 1 does not expose a CLI fallback, raw SessionDB
path, account token, or Hermes runtime/durable ids on public surfaces. See
[hermes-adapter.md](./hermes-adapter.md) for the full Wave 1 contract and deferrals.

## Native V Bot connection flow

The shipped setup path is deliberately simple:

1. Run the V Bot hub and companion on the computer that has the desired runtime.
2. Pair that computer to the iPhone using the existing QR/device-trust flow.
3. On the iPhone, open **Settings → Integrations → Hermes** and connect the
   default profile (or choose one when multiple profiles are advertised).
4. V Bot adopts or creates one canonical Hermes `Bot Chat`, creates/reuses the
   corresponding V Bot bot, and opens the normal V Bot conversation.

V Bot owns pairing, bot identity, transcript storage, unread state, streaming,
approvals, activity, and UI. Hermes is an adapter selected by profile behind the
hub; account login is never a replacement for pairing. For a second machine,
pair that machine as another V Bot computer and connect Hermes there.

The existing bridge fleet remains limited to `shell`, `local-vm`, and
`ssh-forward`. Remote Hermes-over-bridge is not implemented: shell jobs are not
a Hermes gateway and must not carry its prompts, credentials, or JSON-RPC stream.
A future cross-machine Hermes feature requires a dedicated authenticated,
versioned capability/stream transport with cancellation and backpressure.

Voice calls are a separate, unshipped expansion. The reviewed design is tracked
in [V Bot Native iPhone Voice Calls](./superpowers/plans/2026-09-01-vbot-native-voice-calls.md)
and does not alter the Hermes adapter or bridge capabilities in Wave 1.

## Hermes first-party adapter (Wave 2)

Hermes remains a hub-owned **adapter runtime**, not a `VBotPrimaryEngine`. The
iOS companion stays on the existing Grok-style surfaces: pairing, transcripts,
approvals, comm activity, and composer controls. VM/fleet/computer destinations
stay on V Bot's OpenMaus/Grok/ACP fleet; Hermes `computer_use` may run inside a
Hermes turn but is not exposed as a V Bot Computer destination. Bound bots may
receive additive `composer: { queueing: false, steer: false, stop: true }` on
`GET /api/bots`; older phones ignore unknown fields.
