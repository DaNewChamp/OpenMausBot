# V Bot Premium Mobile Roadmap

> **Planning artifact for the V Bot private release line.**
> Audited against **TestFlight build 62** (`ios/project.yml` → `CURRENT_PROJECT_VERSION: "62"`, marketing `1.0.0`) and repository HEAD **`8bf9ef9`**.
> Observable Grok Bot behavior and screenshots are **reference only** — implementation must be clean-room.

**Goal:** Make V Bot a smooth, visually premium, model-agnostic Grok Bot alternative with reliable local and cloud VM surfaces — without copying proprietary code, private APIs, or assets.

**Architecture:** Keep the existing thin-client split: `CompanionCore` owns wire contracts and state folding; `ios/App` owns SwiftUI. Premium work layers motion, surface tokens, and resilient presentation on top of the companion allowlist — not a second fold of provider events.

**Tech stack:** Swift 6 / SwiftUI, XcodeGen, zero third-party iOS deps, companion sidecar HTTP + SSE, WKWebView for proxied Local VM viewer, SFSafariViewController for cloud Box viewer.

---

## 1. Current-State Scorecard (build 62)

Scores are **1–10** for perceived polish + reliability on a physical iPhone against a paired Mac harness. Higher = closer to premium Grok-class feel without compromising V Bot identity.

| Area | Score | Build-62 implementation state | Primary gaps |
|---|---:|---|---|
| **Home** (`ChatListView`, `PinnedChatShelf`, `UpdatesSheet`) | **8** | Near-black canvas, compact Grok-proportioned header/hero avatars, centered pinned shelf, unread dots, swipe pin | Large-roster scroll and search transition still need physical-device profiling |
| **Chat** (`ChatView`, `SpeechBubble`, `MarkdownText`) | **8** | Natural short/long bubbles, settled-message (non-streaming) presentation, near-bottom follow, grouped tools, approvals, NEW divider, quoted reply | `ChatView.swift` remains large; long-transcript memory/FPS evidence is still missing |
| **Profile / Settings** (`AgentProfileView`, `SettingsView`, `ConnectedAppsView`) | **8** | Grok-style profile hierarchy, persisted avatar color/shape, provider-grouped model catalog, haptics/sounds toggles | Offline copy and device persistence need physical-device confirmation |
| **Groups / Pinning** (`GroupProfileView`, `NewGroupSheet`, `PinnedChatShelf`, `GroupRouting`) | **8** | Group setup/instructions, mention routing, centered 3-across pin shelf, unread/read receipts | Drag reorder and large pin sets remain unverified |
| **Composer / Keyboard** (`ChatView` composer, `SpeechDictation`, `VmKeyboardBar`) | **8** | Soft send/stop haptics, 44pt targets, keyboard restoration after Computer, dictation, slash HUD, share staging | Keyboard and send latency need final iPhone pass |
| **Attachments** (`ChatView`, `ShareInbox`, `AttachmentTests`) | **8** | Image and MP4/MOV import, async thumbnails, 50MB bound, share extension staging, honest upload errors | Device share-sheet matrix is not yet recorded |
| **Streaming / Tool activity** (`StreamPresentation`, `ToolRunGrouping`, `AgentThoughtChamberView`, `TypingIndicatorView`) | **8** | Settled replies by default, frame coalescing, grouped tool runs, reasoning chamber, VoiceOver phase announcements | Live SSE-drop exercise remains a device/backend gate |
| **Onboarding / Pairing** (`CompanionApp`, `OnboardingViews`, `PairingView`, `PairingScanner`) | **7** | QR-first, Bonjour/manual hosted/Tailscale pairing, notification education | No closed-app push; hosted failure copy and remote-origin UX need live validation |
| **Model routing** (`ChatModelPickerSheet`, `ModelPickerView`, `EngineSync`, `ModelClientTests`) | **8** | Server-driven provider order OpenAI → Claude → Cursor → OpenRouter → Grok Auth, per-bot model/effort, busy-switch safety | Catalog behavior on a deployed hub is not yet verified from build 62 |
| **Local VM** (`ComputerView`, `VMViewerWebView`, `LocalVmInteractionChrome`, `RemoteDesktopCanvas`) | **7** | Per-bot lifecycle, proxied noVNC, pointer/clipboard controls, ticket refresh, screenshot fallback and save | Cellular viewer and real bridge VM lifecycle remain physical/backend gates |
| **Cloud VM** (`ComputerView`, `CloudDesktopBrowser`, `ComputerPresentationState`) | **7** | HTTPS-only Box viewer policy, explicit VPS screenshot/watch-only state, no URL persistence | No live cloud/VPS device exercise has been recorded |
| **Accessibility / Performance** (`ConversationTypography`, reduce-motion paths, `ChatView` a11y) | **7** | Dynamic Type, reduce-motion, VoiceOver labels/phase announcements, Release compile hardening | Instruments/FPS and Large Content Viewer audit remain open |

**Release anchor (build 62):** `79cb731 chore(ios): bump TestFlight build 62 and update release notes` — compact Grok-proportioned home/conversation geometry, settled (non-streaming) replies, unread dots, and provider-grouped model settings. HEAD `8bf9ef9` also isolates the VPS turn-ready cache and registers the backup test with Vitest. Build 62 is recorded as `VALID / IN_BETA_TESTING`; this document does not claim a fresh device install or a deployed HEAD.

### Verified public hub boundary (2026-08-30)

`https://openmaus.posival.com/api/health` responds `200` with `{ "app": "openmausbot" }`. Authenticated status, bot, and version routes correctly return `401` without a paired-device token, so this check proves reachability only—not that the hub is running HEAD `8bf9ef9`, that build 62 can pair, or that VM/model/attachment flows work remotely. Deployment and device QA are explicit release gates; do not infer them from a green test suite or the health response.

---

## 2. Gap Backlog (P0 / P1 / P2)

Each item lists **exact files**, **priority**, and **observable acceptance criteria** (what a tester can verify on device without reading code).

### P0 — Ship blockers for “premium + reliable”

| ID | Gap | Files / components | Acceptance criteria |
|---|---|---|---|
| P0-1 | **Local VM viewer reliability** | `ios/App/VMViewerWebView.swift`, `ios/App/ComputerView.swift`, `ios/App/Session.swift`, `companion/src/routes.ts` (viewer proxy), `server/local-vm-phone.ts` | **Partially implemented.** On Wi‑Fi and LTE: open Computer → Local VM → live viewer loads within 8s or shows actionable retry (not blank WebView). Pointer mode toggle works in both trackpad and touch. Returning to chat restores composer above keyboard. Device + paired-bridge proof is still required. |
| P0-2 | **Streaming reconnect without duplicate tails** | `ios/Sources/CompanionCore/Store.swift`, `ios/Sources/CompanionCore/StreamPresentation.swift`, `ios/App/ChatView.swift` | **Implemented in code/tests; device gate open.** Background app ≤30s → foreground must resume or replace with one settled message; manual SSE-drop proof is still required. |
| P0-3 | **Connection failover clarity** | `ios/Sources/CompanionCore/Failover.swift`, `ios/App/Session.swift`, `ios/App/ChatListView.swift` (`StatusBanner`) | **Implemented in code/tests; device gate open.** Toggle Wi‑Fi off/on and verify reconnecting → live; hosted intent must never silently downgrade to cleartext LAN. |
| P0-4 | **Model switch safety while busy** | `ios/App/ChatModelPickerSheet.swift`, `ios/App/AgentProfileView.swift`, `ios/Sources/CompanionCore/Client.swift` | **Implemented in code/tests; live catalog gate open.** Busy picker is disabled with inline copy; after interrupt, selection persists and the next message uses it. |

### P1 — Premium feel + Grok-class parity (clean-room)

| ID | Gap | Files / components | Acceptance criteria |
|---|---|---|---|
| P1-1 | **Surface token consistency** | `ios/App/VBotSurface.swift`, `ios/App/Glass.swift`, `ios/App/GroupProfileView.swift`, `ios/App/SettingsView.swift`, `ios/App/ComputerView.swift` | Settings, group profile, and computer screens use the same background, card, and glass treatments as home/chat — no rogue `Form` grays or one-off corner radii. Side-by-side screenshot: home ↔ settings feels like one app. |
| P1-2 | **Loading & empty-state polish** | `ios/App/ModelPickerView.swift` (`ModelPickerLoadingView`), `ios/App/ChatListView.swift`, `ios/App/AgentProfileView.swift`, `ios/App/ComputerView.swift` | Every async surface shows skeleton or `ContentUnavailableView` within 1 frame of appear — never a blank white/black flash. Offline profile shows cached identity + “Reconnect to edit.” |
| P1-3 | **Composer micro-interaction pass** | `ios/App/ChatView.swift`, `ios/App/PlatformBridge.swift` (`Haptics`, `SoundEffects`), `ios/App/Composer/TypingIndicatorView.swift` | Send: soft haptic + brief send-button scale (build 62 baseline). Stop: distinct haptic from send. Dictation start/stop: selection haptic. Settings toggles gate haptics/sounds app-wide. |
| P1-4 | **Share extension staging** | `ios/Share/ShareViewController.swift`, `ios/Shared/ShareInbox.swift`, `ios/App/Session.swift`, `ios/App/CompanionApp.swift` | Share image/text/URL from Safari → V Bot opens with attachment preview in composer (not silent drop). Cancel clears staged payload. |
| P1-5 | **Tool / reasoning presentation** | `ios/App/Cards/AgentThoughtChamberView.swift`, `ios/App/ChatView.swift` (tool run grouping), `ios/Sources/CompanionCore/ToolRunGrouping.swift` | Multi-tool run collapses to one disclosure; expanding shows ordered steps. Reasoning card streams title “Thinking…” → “Thinking” on settle. VoiceOver announces working/finished once per turn. |
| P1-6 | **Group composer affordances** | `ios/Sources/CompanionCore/GroupRouting.swift`, `ios/App/ChatView.swift`, `ios/App/GroupProfileView.swift` | Mentions-only room: composer placeholder hints “@mention a bot”; `@` opens ranked candidates with bot colors. Default responder changes reflect in hint within one navigation pop. |
| P1-7 | **Pinned shelf delight** | `ios/App/PinnedChatShelf.swift`, `ios/App/ChatListView.swift` | Pin/unpin animates shelf without list jump. 4+ pins scroll horizontally with rubber-banding. Context menu pin matches swipe action. |
| P1-8 | **Computer screenshot save** | `ios/App/ComputerView.swift`, `ios/project.yml` (Photos add usage) | Save latest frame to Photos succeeds with success haptic; permission denial shows settings deep-link copy. |

### P2 — Completeness + future-proofing

| ID | Gap | Files / components | Acceptance criteria |
|---|---|---|---|
| P2-1 | **Video attachments** | `server/attachments.ts`, `ios/App/ChatView.swift`, `ios/Sources/CompanionCore/Client.swift`, `companion/src/routes.ts` | Pick ≤50MB MP4/MOV → uploads → message shows playable thumbnail in transcript. Rejected formats show inline error, draft retained. |
| P2-2 | **Mark unread + hidden chats UX** | `ios/App/ChatListView.swift`, `ios/App/HiddenChatsView.swift`, `ios/Sources/CompanionCore/Client.swift` | Context menu Mark unread → blue dot on row. Hidden chat absent from roster; visible in Settings → Hidden chats → unhide restores position. |
| P2-3 | **Live Activity linger** | `ios/App/LiveActivities.swift`, `ios/App/Session.swift`, `ios/App/OnboardingViews.swift` | Background while bot working: Live Activity updates ≥2 min or until turn completes. Copy honestly states no closed-app push. |
| P2-4 | **ChatView decomposition** | `ios/App/ChatView.swift` → extract `ChatTranscriptView`, `ChatComposerView`, `ChatChromeView` | Release archive succeeds on CI Mac without single-file timeout. Zero user-visible behavior change — snapshot/preview parity. |
| P2-5 | **Model catalog UX** | `ios/App/ModelPickerView.swift`, `ios/App/ProviderMarks.swift` | Engine chips show provider mark + model name; error state offers retry; empty catalog explains “No models on computer.” |
| P2-6 | **Cloud VM parity (watch path)** | `ios/App/ComputerView.swift`, `ios/Sources/CompanionCore/ComputerPresentationState.swift`, `docs/cloud-viewer.md` | Box backend: “Open cloud desktop” opens `CloudDesktopBrowser` with visible HTTPS origin. VPS: screenshot watch + honest unavailable copy for interactive viewer. |
| P2-7 | **APNs scaffold (no prod relay)** | `docs/ios-push-apns.md`, `ios/App/Notifications.swift`, future `ios/Push/` | Document relay architecture; entitlements checklist committed; local notifications unchanged. No production APNs until relay URL exists. |
| P2-8 | **Performance baseline** | `ios/App/ChatView.swift`, `ios/App/ChatListView.swift`, Instruments templates in `ios/TESTING.md` | 500-message thread: scroll FPS ≥55 on iPhone 15 class; memory plateau <200MB after 5 min chat. Document repro steps. |

---

## 3. Implementation Waves

Bounded, non-overlapping waves in dependency order. Each wave ends with a **verification gate** before the next starts.

| Wave | Name | Scope | Depends on | Cursor model | Verification gate |
|---|---|---|---|---|---|
| **W1** | **Surface Cohesion & Perceived Responsiveness** | P1-1, P1-2, P1-3, P1-7 | — | `composer-2.5` (UI tokens, skeletons) | `swift test` in `ios/`; XcodeGen generate; Debug on simulator: home ↔ settings ↔ group profile visual pass; device: send/stop haptics |
| **W2** | **Chat Reliability Hardening** | P0-2, P0-4, P2-4 (extract only) | W1 (avoid merge conflicts in `ChatView`) | `cursor-grok-4.6-xhigh` (streaming + file splits) | `StreamPresentationTests`, `StoreTests`, `EventStreamTests`; device: SSE drop/reconnect script; Release archive `-O` |
| **W3** | **Local VM Premium** | P0-1, P1-8, `RemoteDesktopCanvas` fallback polish | W2 | `cursor-grok-4.6-xhigh` (WKWebView + `ComputerView`) | `LocalVmStatusTests`, `ComputerPresentationStateTests`; companion `local-vm-proxy.test.ts`; device: create → viewer → paste → return to chat |
| **W4** | **Groups, Share & Attachments** | P1-4, P1-6, P2-1 (if server ready), share polish | W2 | `composer-2.5` | `GroupRoutingTests`, `AttachmentTests`; device: share sheet, mention flow, image attach |
| **W5** | **Model Agnosticism UX** | P0-4 (finish), P2-5, profile/chat picker dedup | W2 | `composer-2.5` + `cursor-grok-4.6-xhigh` for `EngineSync` edge cases | `ModelClientTests`, `EngineSyncTests`; device: switch Codex ↔ Claude ↔ Grok-route instances |
| **W6** | **Cloud & Connection Resilience** | P0-3, P2-6 | W3 | `cursor-grok-4.6-xhigh` | `FailoverTests`, `EndpointRefreshTests`; device: hosted/LAN/Tailscale failover matrix |
| **W7** | **Background Presence** | P2-3, P2-7 (docs/scaffold only) | W5, W6 | `composer-2.5` | `LiveActivities` manual QA; no new entitlements without review |
| **W8** | **Performance & Accessibility Audit** | P2-8, Large Content Viewer, contrast pass | W1–W7 | `cursor-grok-4.6-xhigh` (Instruments + a11y) | Instruments trace attached to PR; VoiceOver walkthrough checklist green |

**Parallelism:** W4 and W5 can run in parallel after W2 merges. W6 requires W3 Local VM routes stable. W8 is strictly last.

---

## 4. Clean-Room, Proprietary & Safety Boundaries

### Do not copy

| Grok / xAI observable | V Bot clean-room alternative |
|---|---|
| Grok IPA fonts, colors, icons, Lottie, bundled assets | `VBotSurface` tokens, SF Pro, `MausAvatar` / `ProviderMarks`, system SF Symbols |
| Grok private API hosts, auth headers, discovery tokens | Companion allowlist only (`companion/src/routes.ts`); Keychain device token |
| Grok cloud desktop / super-app routes | `CloudDesktopBrowser` (SFSafariViewController) for Box viewer URLs minted by harness |
| Grok-specific model branding in UI chrome | `ProductIdentity.displayName` = “V Bot”; provider marks are generic |
| Re-hosting Grok models inside V Bot | Model-agnostic: show harness `Instance` catalog as configured on the user’s Mac |

### Architectural red lines (from `ios/README.md`, `docs/ios-companion.md`)

- Phone **never** calls harness loopback directly — only paired companion `:8810`.
- Phone **never** persists cloud viewer URLs or Local VM loopback URLs (`LocalVmStatus` strips `viewer_url` on encode — `LocalVmStatusTests`).
- Phone **never** exposes `PUT /api/config`, pairing revocation, or `/api/internal/*`.
- Interactive Local VM requires explicit per-device `localVmAccess` grant.
- Default-deny companion proxy: new capabilities need route + test in `companion/test/routes.test.ts` before iOS UI.

### Safety checks for VM work

- All Local VM actions go through `CompanionClient.localVmAction` — no shell injection surfaces.
- `VMViewerWebView.stableViewerKey` strips one-time `omb_viewer` tickets from reload identity.
- Screenshot save requires `NSPhotoLibraryAddUsageDescription` — no silent album writes.

---

## 5. Recommended First Wave (maximum polish, lowest regression)

**W1–W7 are implemented on the private release line; W8 is the remaining audit wave.**

**Why:** The completed waves deliberately kept presentation, stream safety, VM policy, attachments, model routing, and background presence in separate changes. Build 62 is the current iOS validation anchor; W8 is intentionally held until physical-device and Instruments evidence exists.

**W1 task bundle (ordered):**

1. Audit and align backgrounds/cards in `SettingsView.swift`, `GroupProfileView.swift`, `ComputerView.swift` to `VBotSurface` + `glassSheet` patterns used in `ChatListView.swift`.
2. Add skeleton loaders mirroring `ModelPickerLoadingView` to `AgentProfileView` (instances/routines) and `ComputerView` (instances list, viewer connecting).
3. Centralize haptic/sound gating in `PlatformBridge.swift` — respect `CompanionPreferences.hapticsKey` / `soundsKey` already in `SettingsView`.
4. Polish `PinnedChatShelf` pin/unpin animation and horizontal scroll metrics (`PinnedChatShelf.swift`).
5. For the next upload, increment `CURRENT_PROJECT_VERSION` from **62** only after the gates below pass; update `ios/AppStore/en-US/release_notes.txt`.

**W1 regression watchlist:** composer send/stop, computer return keyboard, pin swipe, pairing QR — all must pass smoke on physical device before merge.

---

## 6. Release Cadence (internal TestFlight → external)

| Stage | Build bump | Audience | Physical-device QA checkpoint |
|---|---|---|---|
| **Completed internal builds** | 57–62 (W1–W7 implementation) | Internal TestFlight | Code/test gates passed; build 62 is the current approved internal artifact |
| **Next internal build** | 63+ (W8/device fixes) | Internal group | Only after the physical-device matrix below and any required fixes |
| **External TF** | After W8 | External TestFlight | Full QA script below; 48h soak |
| **App Store 1.0** | Marketing version bump when ready | Phased release manual | App Review notes from `ios/AppStore/review-notes.md` |

### Physical-device QA script (run before every internal TestFlight upload)

1. **Pairing:** QR scan → confirm computer name → land on roster (`PairingView`, `PairingScanner`).
2. **Chat:** Send text + image; receive streaming reply; scroll up (no yank); approve/deny card.
3. **Composer:** Send haptic; stop generation; dictation append; return from `ComputerView` with keyboard visible.
4. **Groups:** Open group profile; edit instructions; `@mention` routes to correct bot (`GroupRoutingTests` behaviors).
5. **VM:** Local VM create if idle; viewer or screenshot fallback; paste from phone clipboard.
6. **Background:** Home app 20s → return; unread/updates reconcile; no duplicate live bubble.
7. **Settings:** Toggle haptics off → no haptic on pin; sign out → Keychain cleared → unpaired home.

### Automation before upload

```sh
cd ios && swift test
cd ios && xcodegen generate
# Release archive on generic iOS device — see ios/AppStore/RELEASE.md
```

---

## 7. Definition of Done

The premium mobile goal is **done** when all of the following are true:

1. **Scorecard:** Every area in §1 is **≥8** on a physical iPhone against a production-class paired Mac (hosted + LAN tested); current scores are implementation estimates until W8 evidence is attached.
2. **P0 cleared:** P0-1 through P0-4 verified on device with no open Sev-1/Sev-2 issues; code/tests alone are not sufficient.
3. **Model agnostic:** User can switch among all harness-advertised instances (Codex, Claude, Grok-route, opencode-go, etc.) from chat and profile without app update; busy/interrupt rules enforced.
4. **Local VM reliable:** Create/stop/recreate works per-bot; viewer loads or degrades to screenshot canvas with explicit status — never a silent blank surface.
5. **Cloud VM honest:** Box interactive viewer works via in-app Safari; VPS/cloud backends show correct non-interactive copy (`ComputerPresentationState`).
6. **Premium feel:** Surface tokens consistent across home, chat, settings, profile, computer; loading/empty states everywhere; haptics/sounds respect user toggles.
7. **Streaming integrity:** No duplicate tails, no stuck working rows after reconnect — `StreamPresentationTests` green and manual SSE-drop pass.
8. **Accessibility:** VoiceOver completes home → chat → approve → settings without traps; Dynamic Type does not clip composer or bubbles at AX5.
9. **Performance:** 500-message thread meets §P2-8 thresholds on iPhone 15 class hardware.
10. **Clean-room:** No Grok proprietary assets, APIs, or copied UI vectors; `ProductIdentityTests` green; App Store privacy answers match binary.
11. **Release:** External TestFlight soak ≥48h, internal QA script §6 completed on two network conditions (Wi‑Fi + cellular), `CURRENT_PROJECT_VERSION` incremented per upload, release notes user-facing, and the current hub commit is deployed and health-checked. None of the device/deploy gates are claimed by this planning update.

---

*Plan refreshed 2026-08-30 from the private release line at HEAD `8bf9ef9`, `ios/project.yml`, `ios/AppStore/en-US/release_notes.txt`, and the completed W1–W7 changes. Observable Grok Bot behavior and screenshots remain clean-room references; no proprietary code, assets, private APIs, or signing material are copied. Execution agents should not modify this file from implementation worktrees unless explicitly tasked with plan revisions.*
