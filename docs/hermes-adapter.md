# Hermes Bot Chat adapter (Wave 1)

Wave 1 adds a narrow, hub-owned Hermes Bot Chat adapter. It is disabled by default,
projects only the shared V Bot event contract, and never replaces V Bot pairing or
becomes a new primary engine.

## Trust path

```text
V Bot iOS
  -> authenticated OpenMaus companion/control plane
  -> paired Mac hub
  -> local Hermes CLI in `--tui` loopback mode
  -> Hermes TUI JSON-RPC gateway (line-delimited stdio)
```

The phone never receives Hermes tokens, `HERMES_HOME`, executable paths, profile
paths, durable SessionDB ids, runtime session ids, prompts, raw stderr, or JSON-RPC
payloads. Hermes account login remains Hermes' own setup flow; V Bot device pairing
remains the authorization boundary. Login never replaces pairing.

## Connect Hermes from V Bot

Hermes is connected to the **currently paired V Bot computer**. The iPhone does
not sign in to Hermes or connect to its local gateway directly.

1. On the computer where Hermes is installed and signed in, start the V Bot hub
   and companion.
2. On the iPhone, pair that computer from **Settings → Computers → Connect
   another computer** (or scan the first computer's QR from **Connect my
   computer**). Confirm the friendly computer name before accepting the pairing.
3. Open **Settings → Integrations → Hermes**. V Bot checks the paired computer
   and shows only safe profile labels and capability state.
4. Tap **Connect Hermes** for the default profile. If more than one profile is
   available, choose a profile first.
5. V Bot adopts or creates exactly one canonical Hermes **Bot Chat**, wraps it in
   one V Bot bot, and opens the normal V Bot conversation. Repeating the action
   is idempotent.

V Bot owns the pairing credential, bot identity, transcript, unread state,
streaming activity, approvals, and mobile UI. Hermes remains the profile/runtime
adapter behind the hub. The companion's authenticated setup routes are
`GET /api/hermes/setup/status` and `POST /api/hermes/setup`; they return no
credentials, paths, prompts, or runtime/session identifiers.

For Hermes on another machine, install/sign in to Hermes there, run a V Bot hub
and companion there, pair that computer, and repeat the same flow. A paired
computer is the placement boundary; account discovery never grants access by
itself.

## Canonical identity

Each bound bot resolves the exact canonical chat:

- profile: validated Hermes profile slug from the binding sidecar
- title: literal `Bot Chat`
- lookup: `session.list` with `{ profile, title: "Bot Chat", include_hidden: true, limit: 200 }`

Hermes may return a compression tip via `resolved_id`. The adapter resumes that
resolved id internally and keeps the root id internal only. The gateway's runtime
`session_id` is memory-only and is never written to Store, bindings, logs, SSE,
`/api/*` responses, or `resumeCursors`.

Lookup results are fail-closed:

- `present`: exactly one matching hidden canonical row
- `absent`: successful empty list (`sessions: []`) — Wave 1 never creates a chat
- `unknown` / `unavailable`: RPC, auth, protocol, timeout, corrupt/unreadable
  state, profile rename/deletion, or malformed payloads

Treating lookup failure as an empty roster and minting a second Bot Chat is
explicitly forbidden.

## Binding sidecar

Bindings live in `${DATA_DIR}/hermes-bindings.json` (mode `0600`, parent dir `0700`).

Each record stores only:

- `adapter: "hermesBot"`
- `profile` (validated slug, not a path)
- `canonicalTitle: "Bot Chat"`
- `bindingVersion: 1`

A missing sidecar is an available empty binding set. An unreadable or malformed
existing file is `unavailable` and must not decode to `{}`. Failed writes leave
prior bytes unchanged.

## Capability flags

Capabilities are affirmative. Wave 1 enables only what the loopback gateway proves:

| Flag | Wave 1 |
| --- | --- |
| roster, canonicalChat, send, finalResponse, events, stop | true when live |
| routinesRead, messageAgent, groups, crossMachine, queueing, steer, attachments | false |

Generic Hermes ACP/MCP availability does **not** enable `message_agent`, groups,
relay, routines mutation, queue, steer, attachments, or computer integrations.
While `groups` is false, Hermes-bound bots cannot join V Bot rooms.

## Send, interrupt, and transcript source of truth

Dispatch reuses the existing hub turn path:

1. append the V Bot user message to Store
2. optional `content.delta` events
3. exactly one `assistant_text` from authoritative `message.complete`
4. one terminal `turn.completed`
5. activity reset without writing Hermes ids into public JSON

`session.interrupt` is the only turn mutation exposed in Wave 1. V Bot Store and
SSE remain the mobile transcript source of truth; Hermes history is not mirrored
into V Bot transcripts.

## Child process hygiene

The adapter spawns `hermes --tui` with a positive environment allowlist. V Bot and
provider credential variables are stripped before spawn. Prompt text is passed as
JSON-RPC parameters, never shell-interpolated. stderr, argv, paths, provider
payloads, and query text are redacted from public errors, logs, activity, SSE, and
API fixtures.

## Recovery behavior

| Condition | Result |
| --- | --- |
| missing CLI | `missing_cli`, capabilities demoted |
| gateway/auth/protocol failure | typed unavailable; no OpenMaus fallback |
| unreadable binding sidecar | setup failure; binding not treated as empty |
| profile rename/deletion | `profile_unavailable` / unavailable roster row |
| timeout | terminal failed turn; safe code only |
| malformed final/event | `malformed_response`; no guessed assistant text |
| upstream Hermes error | typed runtime/setup error; binding retained |

After a gateway crash, the next send performs a fresh hidden title lookup and
resumes the compression tip; it does not reuse a stale runtime id or create a
second canonical chat.

## Hub placement

Hermes Bot Mode is a provider/profile adapter behind the existing hub. It is **not**
a `VBotPrimaryEngine`, does not change iOS/companion contracts, and does not
replace OpenMaus/Grok paths or generic Hermes ACP.

The current bridge fleet does not change this placement rule. Bridges advertise
only `shell`, `local-vm`, and `ssh-forward`; none is a Hermes gateway. Remote
Hermes-over-bridge streaming is not implemented, and shell execution must never
be presented as a Hermes transport. A future remote path needs a dedicated,
authenticated capability and streaming protocol with explicit cancellation and
backpressure before it can be enabled.

## Wave 1 deferrals

Wave 1 explicitly does **not** include:

- Hermes `message_agent` / V Bot–Hermes A2A protocol
- groups/rooms, `bot_relay.*`, peer gateways, cross-machine delivery
- provider login/OAuth UI, billing, or provider secrets in bindings
- remote/node-hosted Hermes runtimes or fleet control planes
- routine create/edit/run/cancel or raw SessionDB/`jobs.json` reads from TypeScript
- attachments/vision, computer/phone/composio/custom MCP, queue, steer, fork/rewind
- CLI one-shot fallback
- any change in the Hermes source checkout (`/Users/Vincent/Github/hermes-agent`)

API gaps require a separately reviewed Hermes proposal with versioned compatibility
tests. V Bot Wave 1 ships adapter-side only.

## Deterministic test fixture

`server/testing/fake-hermes-tui-gateway.ts` implements the tag-pinned `v2026.8.31`
handshake/events for CI and release gates. It uses deterministic session ids
(`session-root`, `session-tip`) and fixture text only. It is imported by tests,
never by production code.

## Voice/call planning

Voice calls are not part of Hermes Wave 1. The approved, separate iPhone plan is
[V Bot Native iPhone Voice Calls](./superpowers/plans/2026-09-01-vbot-native-voice-calls.md):
foreground half-duplex capture, existing V Bot chat/SSE/TTS, tap-to-interrupt,
and team-call sequencing. It does not add a Hermes voice transport or a bridge
`tts` capability; implementation remains gated on its own device and safety
review.
