# V Bot Hermes Connect UX

**Goal:** Make Hermes a first-party V Bot runtime that a paired iPhone can discover and connect without editing files, while making computers and existing bridges understandable and renameable.

## Invariants

- V Bot owns pairing, transcripts, approvals, activity, bot identity, VM access, and the mobile UI.
- Hermes remains a hub-owned profile adapter; it is not a primary-engine switch and does not replace device pairing.
- Hermes credentials, paths, runtime/session ids, stderr, and JSON-RPC payloads never reach iOS, config status, logs, or errors.
- A missing/unreadable binding or identity store fails closed.
- Existing pairings, connection ids, Keychain tokens, and older iOS decoding remain compatible.
- No dependency additions, production deployment, or TestFlight upload in this pass.

## Task 1 — Friendly computers and bridge fleet

- Treat legacy `OpenMaus`/`OpenMausBot` names as generic.
- Let the user rename a saved computer from iOS without changing its pairing id or Keychain token.
- Persist the alias in the phone registry and use it everywhere the computer is shown.
- Add a safe bridge-roster client and show registered bridge machines, online state, and capabilities below paired V Bot computers.
- Tests: connection registry rename/round-trip, presentation fallbacks, bridge decoding/client request, focused Swift suite.

## Task 2 — Safe same-host Hermes setup API

- Add authenticated companion routes to read safe Hermes setup state and connect/import one validated profile.
- Connecting enables the existing internal adapter, reloads providers, discovers profiles, adopts or creates canonical `Bot Chat`, creates or reuses exactly one V Bot bot per profile, and writes only the existing minimal binding.
- Repeat requests are idempotent; failures do not leave an orphan bot or silently fall back to another provider.
- Return only safe state, profile display data, V Bot bot id, and capabilities.
- Tests: disabled/missing CLI, successful discovery/import, idempotency, rollback/fail-closed binding, response redaction.

## Task 3 — Native iOS Connect Hermes flow

- Add a first-party `Hermes` row in Settings, not under the old reconstructed engine picker.
- Show clear states: checking, ready to connect, connected profiles, needs Hermes install/login, and unavailable.
- One tap connects the default profile; profile selection appears only when multiple profiles exist.
- Explain placement succinctly: same computer works directly; for another machine, pair that V Bot machine first and connect Hermes there.
- On success, refresh the fleet and open the imported Hermes bot.
- Tests: Codable/client routes, pure presentation policy, focused Swift suite, simulator Debug and Release builds.

## Task 4 — Closeout and remote-runtime boundary

- Update Hermes, bridge, iOS companion, and architecture docs with the working setup path.
- Document current bridges (`shell`, `local-vm`, `ssh-forward`) and explicitly mark remote Hermes-over-bridge as the next transport rather than pretending shell execution is a streaming Hermes gateway.
- Run the focused Node/Swift tests, full Swift package tests, TypeScript checks, and simulator builds. Review the full diff before release preparation.
