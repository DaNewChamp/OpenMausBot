# V Bot Hermes Chief Platform Design

**Date:** 2026-09-02  
**Status:** Approved direction  
**Scope:** Runtime rebinding, Hermes-native capabilities, temporary agents, fleet/VM access, protected web client, and voice sequencing

## Product Position

V Bot is the organization and client platform. Hermes is a first-party agent runtime that may power the chief of staff, any subordinate bot, or an entire fleet. A user may mix Hermes-backed and provider-backed bots without changing the V Bot hierarchy, rooms, history, approvals, or connected-computer model.

The Grok Bot UI remains a reference, not a runtime dependency or product identity.

## Core Decision: Bot Identity Is Not Its Runtime

A bot has a stable V Bot identity and a replaceable runtime binding. Converting a V Bot to “native Hermes” is therefore a safe rebind, not deletion and recreation.

A rebind preserves:

- bot ID, name, avatar, hierarchy, rooms, pins, unread state, and policies;
- V Bot’s canonical transcript and audit history;
- device pairings and fleet grants;
- references from other bots and existing bot-to-bot conversations.

A Hermes binding identifies one installed Hermes endpoint by computer/bridge and profile. Users can set a global default and override it per bot. A user or an authorized Hermes chief may request the change through the same runtime-binding tool. Autonomous runtime changes always require explicit approval.

## Runtime Binding Model

```ts
type BotRuntimeBinding =
  | {
      kind: "provider";
      instanceId: string;
      model?: string;
    }
  | {
      kind: "hermes";
      placement:
        | { kind: "local"; profile: string }
        | { kind: "bridge"; bridgeId: string; profile: string };
      bindingVersion: 2;
    };
```

The server must adopt an existing Hermes installation identity before creating anything new. An unreadable identity, profile, or secret store is unavailable, never empty. A rebind may occur only while the target bot is idle. Context transfer is a bounded, sanitized handoff summary; provider sessions, raw credentials, and secret-bearing tool output never cross runtimes.

## First-Party Hermes Connector

The integration is not MCP-only. Its primary path is:

1. A lightweight V Bot bridge runs on each connected computer.
2. It detects local Hermes profiles and reports capability metadata to the paired hub.
3. An official Hermes connector/plugin registers V Bot tools and Hermes lifecycle events.
4. Plugin-to-bridge traffic stays on a Unix socket or loopback endpoint.
5. The bridge relays over the existing authenticated, device-paired V Bot connection.

An MCP-compatible stdio facade is included for portability, but it delegates to the local bridge. Hermes never receives the hub’s device token, provider credentials, or unrestricted Docker/socket access.

## Hermes Capability Contract

V Bot projects Hermes-native capabilities rather than reimplementing them:

- persistent memory and native learning;
- skill creation, refinement, installation, and status;
- MoA and temporary subagents;
- routines and scheduled work;
- provider/model authentication and selection;
- native tools and MCP servers;
- approvals and interruptions;
- sessions, streamed events, and final responses;
- bot-to-bot messages, groups, and delegation.

Every Hermes endpoint publishes a capability manifest. Unsupported capabilities remain visibly unavailable; the UI must not synthesize fake success or silently fall back to a weaker behavior.

## Bots Created by Hermes

- A named or persistent Hermes agent is projected immediately as a real V Bot with a stable bot ID and hierarchy position.
- A temporary MoA/subagent remains an activity nested under its parent chat.
- Temporary-agent activity appears as a compact `N agents` pill that fans upward only. Text may widen, but controls do not fan sideways.
- The home pill is absent when all work is quiet.
- Tapping the pill opens the temporary transcript. Completed transcripts remain reachable from the parent history.
- `Promote to Bot` converts a temporary agent into a persistent V Bot without losing its transcript or provenance.

## Bot-to-Bot Conversation Projection

Bot-to-bot communication is a first-class conversation, not a required public channel. V Bot renders send/receive markers inline, provides a participant picker, and anchors taps to the corresponding point in the peer transcript. Rooms/channels remain optional and may be hidden globally or per bot.

Hermes may delegate to Hermes-backed or provider-backed V Bots through the same roster and message tools. V Bot remains authoritative for hierarchy, visibility, unread state, and audit records.

## Fleet and Local VM

Every connected machine is a separately paired bridge. Each detected Hermes profile becomes a selectable endpoint such as `Mac mini M4 / default` or `MacBook Pro / research`. Friendly computer names are user-editable and must replace legacy `OpenMaus` labels in the UI.

V Bot owns VM lifecycle, leases, approvals, and screen projection. Hermes requests computer actions through narrowly scoped V Bot tools. Initially Hermes runs on the host and its approved actions execute inside the V Bot Local VM. Running Hermes itself inside a VM is a later optional deployment mode.

## Web Client and Authentication

`vbot.posival.com` is a Cloudflare-hosted thin client using the existing Worker control plane and D1 exchange primitives. It does not create a second transcript, provider, or fleet database.

Authentication is layered:

1. Cloudflare Access delegates OIDC authentication to PocketID, with PocketID passkeys first.
2. Account identity discovers eligible hubs.
3. V Bot device pairing or hub invitation remains mandatory before private hub data is exposed.
4. Native WebAuthn/passkey ownership inside V Bot is a later enhancement, not a replacement for device pairing.

## Voice

Voice remains runtime-agnostic and follows `docs/superpowers/plans/2026-09-01-vbot-native-voice-calls.md`: foreground iPhone half-duplex first, on-device Apple speech recognition, existing chat/SSE/TTS, tap-to-interrupt, silence detection, and team calls. Kokoro is the next TTS provider. Full duplex waits for acoustic echo cancellation.

## Security Invariants

- The harness remains loopback-only.
- Account login discovers hubs but never replaces device pairing.
- Existing desktop installation identity is adopted rather than replaced.
- Existing desktop account and managed endpoint behavior remains compatible.
- An unreadable identity or secret store is unavailable, never empty.
- Secrets never appear in `config.json`, logs, argv, fleet metadata, snapshots, transcripts, or errors.
- Runtime rebinding is transactional and fails closed.
- Autonomous runtime changes, skill installation, persistence, and computer access require the applicable V Bot approval.
- Hermes receives only the tools and fleet scopes explicitly granted to that bot.

## Delivery Order

1. Runtime binding and safe conversion tool.
2. First-party local Hermes connector and capability negotiation.
3. Persistent/temporary agent projection and iOS controls.
4. Hermes skills, learning, MoA, approvals, and routines parity.
5. Scoped fleet/VM tools.
6. Protected Cloudflare web client with PocketID Access plus V Bot pairing.
7. Voice plan execution after runtime event contracts stabilize.

Each wave must ship independently, preserve existing iOS behavior until its own UI task, and must not implement later waves early.
