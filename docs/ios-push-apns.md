# Closed-app push (APNs)

V Bot uses **local notifications** and **Live Activities** while the app is open or recently backgrounded. Closed-app delivery needs **APNs + a Notification Service Extension**. This document is the in-repo architecture — **not** a claim that locked-phone push works in production.

## In-repo (this branch)

| Piece | Status |
|---|---|
| `POST /api/companion/push-token` | Allowlisted; stores `{ deviceId → token }` in companion `push-tokens.json` |
| `companion/src/push-tokens.ts` | `maybeSendApns` is a deliberate no-op until Apple signing |
| iOS `CompanionClient.registerPushToken` | Client method + tests; **does not** call `registerForRemoteNotifications()` |
| `ios/Push/` | Entitlements checklist only; `aps-environment` stays off |

## Still human / MacBook / iPhone

Apple Developer capabilities, NSE target, TestFlight, hub `OMB_APNS_*` secrets, and locked-phone QA. See `ios/Push/README.md`.

## Goal

When a bot finishes or needs approval and the phone is killed, deliver a **communication-style** notification that opens the right chat. Payload is bot name + kind only — no command text.

## Trust boundaries

- Phone never stores harness secrets.
- Relay never stores transcripts — only `{ deviceToken, threadId, headline, requestId? }`.
- Harness/sidecar credentials for Apple stay off git.

## Enablement checklist (MacBook)

1. Create/sign NSE + `aps-environment` on a TestFlight build.
2. Wire `didRegisterForRemoteNotifications` → `registerPushToken`.
3. On approval/bot-idle while SSE has zero phone subscribers, call `maybeSendApns` after replacing the no-op with a real HTTP/2 APNs client.
4. App Store review: opt-in + communication notification demonstration.
