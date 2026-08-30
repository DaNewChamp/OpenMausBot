# Closed-app push (APNs) — future architecture

V Bot today uses **local notifications** and **Live Activities** while the app is open or recently backgrounded. Grok Bot’s closed-app delivery uses **APNs + a Notification Service Extension (NSE)**. This document is the scaffold for an OpenMaus-native path — not a copy of Grok’s pipeline.

## Goal

When a bot finishes or needs approval and the phone is killed, deliver a **communication-style** notification that opens the right chat — without exposing transcripts, model names, tokens, or URLs on the lock screen.

## Current status (W7)

**Not enabled.** No `aps-environment` entitlement, no NSE target, no production relay URL. Settings and onboarding copy state that closed-app push is not available. Live Activity linger (~two minutes while V Bot was recently open) covers the common background case.

Scaffold only:

- `ios/Push/PushRegistrationScaffold.swift` — compile-time no-op registration/revocation API
- `ios/App/Notifications.swift` — local notifications from live/replayed companion frames
- `ios/App/LiveActivities.swift` — ActivityKit without `pushType`
- `ios/Sources/CompanionCore/BackgroundPresencePolicy.swift` — pure linger/dedupe policy

## Threat model

| Actor | Capability | Mitigation |
|---|---|---|
| Relay operator | Holds APNs key, sees device tokens | Host on project-owned infra; audit access; rotate keys |
| Compromised relay | Forge push to arbitrary devices | Harness signs events; relay verifies signature + replay window |
| Compromised phone | Exfiltrate device token | Store token in Keychain; register only over TLS; revoke on sign-out |
| Malicious harness | Spam pushes | Relay rate-limits per device; idempotent `eventId` dedupe |
| Apple reviewer | Inspect entitlement use | Opt-in only; demonstrate communication-notification purpose |

**Out of scope for relay payloads:** full transcripts, prompts, model IDs, API keys, viewer URLs, pairing secrets.

**Minimum payload:** `{ eventId, threadId, botId, headline, requestId?, kind }` where `headline` is privacy-safe (bot name + calm status).

## Device token lifecycle

1. **Registration** — after user opts in and pairing is live, app obtains APNs device token and `POST`s to companion allowlist route `POST /api/companion/push-token` (to be added). Token stored in **Keychain** keyed by paired device id.
2. **Rotation** — on token refresh, replace prior registration; relay treats old token as stale after grace period.
3. **Revocation** — on sign-out, call relay `DELETE` (or mark revoked server-side) and erase Keychain entry. `PushRegistrationScaffold.revokeToken()` will wrap this when wired.
4. **Unpair** — harness drops token mapping for that device; relay must stop sending.

## Server authentication & replay

- Harness signs relay requests with a **per-install secret** configured on the Mac (never on phone).
- Relay checks: signature, timestamp skew (e.g. ±5 min), `eventId` idempotency store (24h TTL).
- Failed verification → drop + metric; no client-visible retry storm.

## Least-privilege payload

```json
{
  "eventId": "uuid",
  "threadId": "thread-abc",
  "botId": "bot-1",
  "kind": "needsYou",
  "headline": "Scout needs you",
  "requestId": "req-9"
}
```

NSE may enrich with avatar attachment from app group cache — not live transcript text.

## Client opt-in & privacy

- Separate from ActivityKit; requires notification permission.
- Settings copy must stay honest: background updates need V Bot recently open until relay ships.
- App Store privacy answers: push used for bot status/approvals only; no ad tracking.

## Entitlements checklist (staging gates)

Before any TestFlight build with push:

- [ ] `aps-environment` on app (+ NSE if rich payload)
- [ ] App Group shared with NSE for avatar cache
- [ ] Communication Notifications entitlement **only** if using `INSendMessageIntent` (today: **not** enabled — generic banner + avatar attachment)
- [ ] Relay URL in project config (not hard-coded prod secret)
- [ ] `companion/src/routes.ts` allowlist entry + `routes.test.ts`
- [ ] Harness fan-out when SSE has zero phone subscribers
- [ ] Sign-out revokes token
- [ ] Staging relay + sandbox APNs soak on physical device
- [ ] App Review notes + in-app opt-in demo

## Required pieces

| Piece | Owner | Notes |
|---|---|---|
| Harness event | Mac `127.0.0.1:8799` | Already emits SSE; needs a **push fan-out** hook when no device is connected |
| Relay | OpenMaus-hosted service | Receives signed events from harness, holds APNs credentials, sends to Apple |
| Device token | iOS app | Register on launch when user opts in; store per paired device on Mac or relay |
| NSE | `com.posival.openmausmobile.notificationservice` | Rich/communication payload; **not started** |
| Entitlements | Apple Developer | `aps-environment`, optional Communication Notifications, app group with NSE |

## Trust boundaries

- Phone never stores harness secrets.
- Relay never stores transcripts — only `{ deviceToken, threadId, headline, requestId? }`.
- Harness signs relay requests with a per-install secret configured on the Mac.

## Enablement sequence (when ready)

1. Create relay endpoint on `openmaus.posival.com` (or dedicated push host).
2. Add `POST /api/companion/push-token` allowlist route (device token registration only).
3. Add NSE target + `PushNotificationService.appex` in `ios/project.yml`.
4. Enable `aps-environment` in entitlements for app + NSE.
5. Wire harness: on approval/bot-idle while SSE has zero phone subscribers → enqueue push via relay.
6. Replace `PushRegistrationScaffold` no-ops with real registration behind `isRelayConfigured`.
7. App Store review: demonstrate opt-in and communication notification use.

## References in repo

- `ios/App/Notifications.swift` — local notifications today
- `ios/App/LiveActivities.swift` — ActivityKit without `pushType`
- `ios/Push/PushRegistrationScaffold.swift` — future registration API (no-op)
- `ios/Sources/CompanionCore/BackgroundPresencePolicy.swift` — background linger policy
- `companion/src/routes.ts` — default-deny; any push route must be added explicitly
