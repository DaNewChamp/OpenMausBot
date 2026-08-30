# V Bot iOS — Grok parity wave 35 (historical implementation record)

Originally scoped for TestFlight build 35; the current release line is **build 62** at HEAD **`8bf9ef9`**. Native reimplementation only — **no Grok IPA assets, fonts, JS, or branding**.

Reference audit: `/tmp/vbot-wave2-audit.md` (Grok Bot 1.4.0 interaction inventory).

## Status at build 62

The companion routes and iOS behaviors in this record are implemented in the private V Bot line and covered by focused tests. The remaining proof is physical-device/backend QA (share sheet, video playback, VM bridge, and background behavior); this document does not claim those gates passed.

## Already shipped (do not redo)

Group tap → chat, quoted reply banner, swipe pin, graphite pairing, Open chat on group profile, attach permission strings, idle VM screenshot, connector connect sound, VBotMark icon.

---

## A. Companion + harness routes (required before iOS)

Harness already supports these on loopback; companion must add **narrow allowlist routes** with **proxy body rewrite** (copy `COMPUTER_DESTINATION_ROUTE` / `BOT_MODEL_ROUTE` patterns in `companion/src/routes.ts` + `companion/src/proxy.ts`).

### A1. Group setup — `PATCH /api/groups/:id/setup` (**implemented**)

Allow only: `{ bulletin?: string, defaultResponder?: { kind: "everyone"|"mentions"|"member", botId?: string } }`

Rewrite to harness `PATCH /api/groups/:id` with same keys. Validate bulletin max 12000 chars; defaultResponder member botId must be in group's memberIds (proxy can pass through; harness validates).

### A2. Bot visibility — `PATCH /api/bots/:id/visibility` (**implemented**)

Allow only: `{ hidden: boolean }`

Rewrite to harness `PATCH /api/bots/:id` with `{ hidden }` only.

### A3. Chat read state — extend existing (**implemented**)

- `POST /api/bots/:id/read` — already exists? If not, add allowlist + proxy.
- `POST /api/groups/:id/read` — already allowed.
- **Mark unread:** new routes:
  - `POST /api/bots/:id/unread` → harness `PATCH /api/bots/:id` `{ unread: true }`
  - `POST /api/groups/:id/unread` → harness `PATCH /api/groups/:id` `{ unread: true }`

Add tests in `companion/test/routes.test.ts` and `companion/test/proxy.test.ts`.

Add `Client.swift` methods: `updateGroupSetup`, `setBotHidden`, `markBotUnread`, `markRoomUnread`.

---

## B. iOS features

### B1. Share extension (P1) (**implemented; device gate open**)

- New XcodeGen target `OpenMausCompanionShare` (share extension).
- App group: `group.com.posival.openmausmobile`
- Activation: 1 image, 1 file, text, 1 web URL (match Grok behavior, not their bundle id).
- Write payload to shared UserDefaults / file in app group; open host app via `openmausbot://share`.
- `CompanionApp.onOpenURL`: handle `share` host → stage attachment in `Session` → navigate to last open chat or chat list with composer staged.
- Reuse `Session.uploadAttachment` + existing image attach flow.

### B2. Group instructions + default responder (P1) (**implemented**)

- `GroupProfileView`: tappable Instructions → sheet editor; save via `updateGroupSetup`.
- Default responder picker: Everyone / Mentions only / Lead bot (member picker from group members). Show current mode read-only when offline.
- Use `GroupRouting.groupResponseHint` for helper copy.

### B3. Hide / unhide chats (P2) (**implemented**)

- Context menu on bot chat: Hide chat → `setBotHidden(true)`.
- Settings or Account sheet: **Hidden chats** list (bots where `hidden == true`); tap to unhide or open 1:1.
- Filter hidden from roster (already done); add UI to manage.

### B4. Mark unread from phone (P2) (**implemented**)

- Context menu: Mark unread on bot and group rows.
- Call new unread routes.

### B5. Haptics & Sounds settings (P2) (**implemented; device gate open**)

- New section in Settings: toggles stored in `@AppStorage("companion.hapticsEnabled")` and `@AppStorage("companion.soundsEnabled")` (default true).
- Gate all `Haptics.*` and `SoundEffects.*` calls through helpers that respect toggles.
- Grok-style copy: "Feel a light tap when you press a button, swipe a row, or save a photo."

### B6. Attach haptic (P1) (**implemented**)

- Light impact after successful photo library / camera attach in `ChatView`.

### B7. Save screenshot to Photos (P2) (**implemented; device permission gate open**)

- Computer view: Save button on latest frame → `UIImageWriteToSavedPhotosAlbum` / Photos API.
- Add `NSPhotoLibraryAddUsageDescription` to `project.yml`.

### B8. Video attachments (P2) (**implemented; device playback gate open**)

- `server/attachments.ts`: add `video/mp4`, `video/quicktime` with size cap (e.g. 50MB).
- iOS `ChatView`: PhotosPicker filter includes videos; upload with correct MIME.
- Companion upload route already exists for images — extend if needed.

### B9. Live Activity linger (P1) (**implemented; closed-app push not claimed**)

- `LiveActivities.swift`: do not end activities on background if bot still working/needs-you; rely on `Session.linger()` + hydrate on return.
- `NotificationOnboardingView`: honest copy — island/lock screen work while app was recently open; closed-app push not yet available.
- Optional banner in chat when bot working: "V Bot keeps updating for a short time after you leave."

### B10. Computer clipboard bar (P2 — minimal) (**implemented as phone-side scaffold**)

- If no harness endpoint exists, add **read-only scaffold** in `ComputerView`: "Paste from iPhone" copies **iPhone clipboard text** into composer of active chat (not into VM). Document that full VM paste needs future companion route.
- Do not invent Grok cloud desktop APIs.

### B11. APNs scaffold (P2 — not full prod) (**scaffold only**)

- Add `docs/ios-push-apns.md`: architecture for OpenMaus-hosted relay, NSE, communication notifications.
- Add placeholder `ios/Push/` with entitlements checklist — **do not** enable production APNs without relay URL in env.
- Improve local notifications path only where trivial.

---

## C. Version history

- Historical scope: `ios/project.yml` build 35.
- Current artifact: `ios/project.yml` `CURRENT_PROJECT_VERSION: "62"`; see `ios/AppStore/en-US/release_notes.txt` for the user-facing build-62 notes.

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
