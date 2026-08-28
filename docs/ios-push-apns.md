# Closed-app push (APNs) — future architecture

V Bot today uses **local notifications** and **Live Activities** while the app is open or recently backgrounded. Grok Bot’s closed-app delivery uses **APNs + a Notification Service Extension (NSE)**. This document is the scaffold for an OpenMaus-native path — not a copy of Grok’s pipeline.

## Goal

When a bot finishes or needs approval and the phone is killed, deliver a **communication-style** notification that opens the right chat.

## Required pieces

| Piece | Owner | Notes |
|---|---|---|
| Harness event | Mac `127.0.0.1:8799` | Already emits SSE; needs a **push fan-out** hook when no device is connected |
| Relay | OpenMaus-hosted service | Receives signed events from harness, holds APNs credentials, sends to Apple |
| Device token | iOS app | Register on launch when user opts in; store per paired device on Mac or relay |
| NSE | `com.posival.openmausmobile.notificationservice` | Rich/communication payload; **not started in TF 35** |
| Entitlements | Apple Developer | `aps-environment`, Communication Notifications, app group with NSE |

## Trust boundaries

- Phone never stores harness secrets.
- Relay never stores transcripts — only `{ deviceToken, threadId, headline, requestId? }`.
- Harness signs relay requests with a per-install secret configured on the Mac.

## TF 35 status

**Not enabled.** Settings and onboarding copy state that closed-app push is coming. Live Activity linger covers the “recently opened” case.

## Enablement checklist (when ready)

1. Create relay endpoint on `openmaus.posival.com` (or dedicated push host).
2. Add `POST /api/companion/push-token` allowlist route (device token registration only).
3. Add NSE target + `PushNotificationService.appex` in `ios/project.yml`.
4. Enable `aps-environment` in entitlements for app + NSE.
5. Wire harness: on approval/bot-idle while SSE has zero phone subscribers → enqueue push via relay.
6. App Store review: demonstrate opt-in and communication notification use.

## References in repo

- `ios/App/Notifications.swift` — local notifications today
- `ios/App/LiveActivities.swift` — ActivityKit without `pushType`
- `companion/src/routes.ts` — default-deny; any push route must be added explicitly
