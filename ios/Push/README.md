# iOS Push / APNs entitlements checklist

**Do not enable production APNs in this tree until Apple signing and a TestFlight build are done on the MacBook/iPhone release lane.**

This directory is a scaffold. Device token registration exists (`POST /api/companion/push-token` on the sidecar). The sidecar **stores** tokens under `~/.openmausbot-companion/push-tokens.json` and **does not send** APNs without Apple credentials plus a signed NSE.

## Files to add on the MacBook (not in this Linux-only change)

| File | Purpose |
|---|---|
| `ios/Push/OpenMausNotificationService.entitlements` | NSE `aps-environment` + app group |
| `ios/App/OpenMausCompanion.entitlements` | add `aps-environment` only when cutting a push-capable TF build |
| `ios/Push/NotificationService.swift` | NSE that hydrates `{ threadId, headline }` only |

## Entitlements (copy when enabling)

```xml
<key>aps-environment</key>
<string>development</string>
<key>com.apple.security.application-groups</key>
<array>
  <string>group.com.posival.openmausmobile</string>
</array>
```

Production uses `aps-environment` = `production`. Communication Notifications require a separate App ID capability.

## Enablement order (human / MacBook)

1. Apple Developer: App ID capabilities — Push, Communication Notifications, App Groups.
2. Add NSE target in `ios/project.yml` (`com.posival.openmausmobile.notificationservice`).
3. Set `OMB_APNS_KEY_P8`, `OMB_APNS_KEY_ID`, `OMB_APNS_TEAM_ID` on the hub **only after** the p8 lives in 1Password, never in git.
4. Call `UIApplication.registerForRemoteNotifications()` after notification authorization; POST the hex token to `/api/companion/push-token`.
5. Locked-phone QA: kill V Bot, trigger a bridge approval, confirm a communication notification opens the right thread.

Until those steps land, Settings copy must not claim closed-app delivery works.
