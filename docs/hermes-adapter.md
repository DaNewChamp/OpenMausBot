# Hermes Bot Chat adapter

## Purpose and boundary

Hermes Bot Chat is an optional, model-agnostic Wave 1 adapter for V Bot. The
headless OpenMausBot hub owns storage, authorization, transcripts, events, and
all provider processes. The desktop app is an optional UI for that hub. The iOS
companion speaks the existing authenticated companion/control-plane contract;
it does not launch Hermes or learn a Hermes session id.

The adapter starts the locally installed Hermes CLI in `--tui` mode and
exchanges typed JSON-RPC frames over the loopback process. Only normalized V Bot events
cross the hub boundary. Credentials, host paths, ports, runtime handles,
provider payloads, and gateway diagnostics stay on the hub.

## Exact binding

The hub's binding record is the authority for a bot selected for Hermes Bot
Chat. Version 1 has exactly these fields:

```json
{
  "adapter": "hermesBot",
  "profile": "<validated Hermes profile>",
  "canonicalTitle": "Bot Chat",
  "bindingVersion": 1
}
```

The profile is normalized and validated before use. The binding store is
private hub state and is never projected into the mobile provider catalog.
The canonical `Bot Chat` session is resolved from Hermes state; ephemeral
runtime session handles are not persisted as V Bot resume cursors.

## Fail-closed routing

Every stop path uses the hub's binding-aware interrupt dispatcher: the HTTP bot
and room endpoints, routine cancellation, room timeout/stall cleanup,
watchdog recovery, deletion/settings cleanup, and adapter cancellation races.

- A readable valid binding routes to the Hermes registry and its profile.
- A valid binding with Hermes disabled, unavailable, or unreadable fails with a
  fixed setup error; it never falls through to the bot's stored generic
  ProviderAdapter.
- An unreadable or malformed binding store is not treated as an empty store.
- Only a readable store that proves a bot is unbound may use the normal
  ProviderAdapter, including generic Hermes ACP.
- A Hermes interrupt failure is not retried through another provider.

The same rule applies to steer decisions: a bound or unknown-binding bot
cannot be steered through a generic engine. It must queue or report that the
capability is unavailable until Hermes exposes a verified steer contract.

## Supported and deferred capabilities

Wave 1 advertises only capabilities exercised by the adapter and gateway:

- Hermes profile discovery and safe roster projection
- canonical `Bot Chat` lookup
- send and final assistant response
- normalized streaming/content and lifecycle events
- stop/interrupt

These remain explicitly deferred (and are reported as unsupported rather than
guessed): routines, `messageAgent`, groups, cross-machine execution, queueing,
steer, attachments, MCP/computer tools, and arbitrary provider/model controls.
The existing OpenMaus provider fleet and generic Hermes ACP behavior remain
unchanged for unbound bots.

## Setup and install

1. Install and authenticate the Hermes CLI on the paired Mac using Hermes' own
   documented installer and profile setup. Verify that `hermes --tui` starts
   the local gateway.
2. Enable Hermes Bot Chat in V Bot's desktop settings and select the Hermes
   provider instance. Keep the adapter disabled until the local gateway is
   installed and authenticated.
3. Bind a bot to its Hermes profile through the hub's settings flow. The hub
   validates and writes the binding; do not edit the record while a turn is in
   flight.
4. Confirm the provider panel reports `available`, the expected profile is
   present, and the canonical `Bot Chat` is found. Then send a short test from
   the desktop or iOS client.
5. If discovery or a turn fails, fix the local Hermes installation/profile and
   retry. Do not substitute a different provider for a still-bound bot.

No iOS wire migration is required for Wave 1. Existing pairing, companion
authorization, SSE/event folding, URL scheme, and bundle identity stay intact.

## Security invariants

- Hermes runs only on the paired hub through a loopback process boundary.
- Binding files and local runtime state are hub-private and least-privilege;
  never commit them or include them in diagnostics.
- Public errors use fixed, user-actionable messages and omit paths, tokens,
  profile internals, raw RPC frames, and provider text.
- The mobile client receives capability flags and normalized events only.
- No adapter change weakens companion authorization, enables host computer
  access, or uploads a TestFlight build.
- Hermes remains opt-in; an unconfigured or disabled adapter does not alter
  legacy OpenMaus provider selection.
