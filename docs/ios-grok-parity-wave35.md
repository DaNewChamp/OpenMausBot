# V Bot iOS — Grok parity wave 35

TestFlight build **35**. Native reimplementation only — **no Grok IPA assets, fonts, JS, or branding**.

Reference audit: `/tmp/vbot-wave2-audit.md` (Grok Bot 1.4.0 interaction inventory).

## Already shipped (do not redo)

Group tap → chat, quoted reply banner, swipe pin, graphite pairing, Open chat on group profile, attach permission strings, idle VM screenshot, connector connect sound, VBotMark icon.

---

## A. Companion + harness routes (required before iOS)

Harness already supports these on loopback; companion must add **narrow allowlist routes** with **proxy body rewrite** (copy `COMPUTER_DESTINATION_ROUTE` / `BOT_MODEL_ROUTE` patterns in `companion/src/routes.ts` + `companion/src/proxy.ts`).

### A1. Group setup — `PATCH /api/groups/:id/setup`

Allow only: `{ bulletin?: string, defaultResponder?: { kind: "everyone"|"mentions"|"member", botId?: string } }`

Rewrite to harness `PATCH /api/groups/:id` with same keys. Validate bulletin max 12000 chars; defaultResponder member botId must be in group's memberIds (proxy can pass through; harness validates).

### A2. Bot visibility — `PATCH /api/bots/:id/visibility`

Allow only: `{ hidden: boolean }`

Rewrite to harness `PATCH /api/bots/:id` with `{ hidden }` only.

### A3. Chat read state — extend existing

- `POST /api/bots/:id/read` — already exists? If not, add allowlist + proxy.
- `POST /api/groups/:id/read` — already allowed.
- **Mark unread:** new routes:
  - `POST /api/bots/:id/unread` → harness `PATCH /api/bots/:id` `{ unread: true }`
  - `POST /api/groups/:id/unread` → harness `PATCH /api/groups/:id` `{ unread: true }`

Add tests in `companion/test/routes.test.ts` and `companion/test/proxy.test.ts`.

Add `Client.swift` methods: `updateGroupSetup`, `setBotHidden`, `markBotUnread`, `markRoomUnread`.

---

## B. iOS features

### B1. Share extension (P1)

- New XcodeGen target `OpenMausCompanionShare` (share extension).
- App group: `group.com.posival.openmausmobile`
- Activation: 1 image, 1 file, text, 1 web URL (match Grok behavior, not their bundle id).
- Write payload to shared UserDefaults / file in app group; open host app via `openmausbot://share`.
- `CompanionApp.onOpenURL`: handle `share` host → stage attachment in `Session` → navigate to last open chat or chat list with composer staged.
- Reuse `Session.uploadAttachment` + existing image attach flow.

### B2. Group instructions + default responder (P1)

- `GroupProfileView`: tappable Instructions → sheet editor; save via `updateGroupSetup`.
- Default responder picker: Everyone / Mentions only / Lead bot (member picker from group members). Show current mode read-only when offline.
- Use `GroupRouting.groupResponseHint` for helper copy.

### B3. Hide / unhide chats (P2)

- Context menu on bot chat: Hide chat → `setBotHidden(true)`.
- Settings or Account sheet: **Hidden chats** list (bots where `hidden == true`); tap to unhide or open 1:1.
- Filter hidden from roster (already done); add UI to manage.

### B4. Mark unread from phone (P2)

- Context menu: Mark unread on bot and group rows.
- Call new unread routes.

### B5. Haptics & Sounds settings (P2)

- New section in Settings: toggles stored in `@AppStorage("companion.hapticsEnabled")` and `@AppStorage("companion.soundsEnabled")` (default true).
- Gate all `Haptics.*` and `SoundEffects.*` calls through helpers that respect toggles.
- Grok-style copy: "Feel a light tap when you press a button, swipe a row, or save a photo."

### B6. Attach haptic (P1)

- Light impact after successful photo library / camera attach in `ChatView`.

### B7. Save screenshot to Photos (P2)

- Computer view: Save button on latest frame → `UIImageWriteToSavedPhotosAlbum` / Photos API.
- Add `NSPhotoLibraryAddUsageDescription` to `project.yml`.

### B8. Video attachments (P2 — needs server)

- `server/attachments.ts`: add `video/mp4`, `video/quicktime` with size cap (e.g. 50MB).
- iOS `ChatView`: PhotosPicker filter includes videos; upload with correct MIME.
- Companion upload route already exists for images — extend if needed.

### B9. Live Activity linger (P1)

- `LiveActivities.swift`: do not end activities on background if bot still working/needs-you; rely on `Session.linger()` + hydrate on return.
- `NotificationOnboardingView`: honest copy — island/lock screen work while app was recently open; closed-app push not yet available.
- Optional banner in chat when bot working: "V Bot keeps updating for a short time after you leave."

### B10. Computer clipboard bar (P2 — minimal)

- If no harness endpoint exists, add **read-only scaffold** in `ComputerView`: "Paste from iPhone" copies **iPhone clipboard text** into composer of active chat (not into VM). Document that full VM paste needs future companion route.
- Do not invent Grok cloud desktop APIs.

### B11. APNs scaffold (P2 — not full prod)

- Add `docs/ios-push-apns.md`: architecture for OpenMaus-hosted relay, NSE, communication notifications.
- Add placeholder `ios/Push/` with entitlements checklist — **do not** enable production APNs without relay URL in env.
- Improve local notifications path only where trivial.

---

## C. Version bump

- `ios/project.yml`: `CURRENT_PROJECT_VERSION: "35"`
- `ios/AppStore/en-US/release_notes.txt`: summarize wave 35 features.

---

## D. Verification

```sh
cd /Users/Vincent/Github/OpenMausBot
./node_modules/.bin/vitest run companion/test/routes.test.ts companion/test/proxy.test.ts
cd ios && swift test
xcodegen generate  # if project.yml changed
```

---

## E. Out of scope

Grok branding, CursorIcons font, IAP/SuperGrok, Face ID lock, Trackpad/noVNC remote desktop, marketplace plugin artwork, sand-mobile URL schemes.

---

## Shipped or waived (2026-08-29)

| Item | In-repo | External leftover |
|---|---|---|
| A1–A3 companion routes | Shipped (group setup, visibility, unread) | Live hub deploy |
| B1 Share extension | Shipped (`ios/Share`, app group) | Device QA |
| B2 Group instructions | Shipped | Phone QA |
| B3 Hidden chats | Shipped | Phone QA |
| B4 Mark unread | Shipped | Phone QA |
| B5–B6 Haptics/sounds | Shipped | Phone QA |
| B7 Save screenshot | Shipped | Photos permission on device |
| B8 Video attachments | `mp4`/`mov` GET allowlist + server MIME | Large-upload QA |
| B9 Live Activity linger | Shipped; copy is honest | — |
| B10 Clipboard bar | Scaffold as documented | Full VM paste is out of scope |
| B11 APNs | Token registration + `ios/Push` checklist | Apple signing, NSE, TestFlight, locked-phone |
| C Version bump | `CURRENT_PROJECT_VERSION` is **54** (not 35). Do not reset it. | Next TF notes on MacBook |
| D `swift test` / xcodegen | Not runnable on this Linux agent | MacBook |

Do not claim TestFlight 35 or live Grok parity from this branch. Bundle id stays `com.posival.openmausmobile`.

