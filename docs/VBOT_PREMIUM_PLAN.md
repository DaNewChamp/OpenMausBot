# V Bot Premium Mobile Roadmap

> **Planning artifact for the `cursor/vbot-premium-plan` worktree.**  
> Audited against **TestFlight build 56** (`ios/project.yml` → `CURRENT_PROJECT_VERSION: "56"`, marketing `1.0.0`).  
> Observable Grok Bot behavior and screenshots are **reference only** — implementation must be clean-room.

**Goal:** Make V Bot a smooth, visually premium, model-agnostic Grok Bot alternative with reliable local and cloud VM surfaces — without copying proprietary code, private APIs, or assets.

**Architecture:** Keep the existing thin-client split: `CompanionCore` owns wire contracts and state folding; `ios/App` owns SwiftUI. Premium work layers motion, surface tokens, and resilient presentation on top of the companion allowlist — not a second fold of provider events.

**Tech stack:** Swift 6 / SwiftUI, XcodeGen, zero third-party iOS deps, companion sidecar HTTP + SSE, WKWebView for proxied Local VM viewer, SFSafariViewController for cloud Box viewer.

---

## 1. Current-State Scorecard (build 56)

Scores are **1–10** for perceived polish + reliability on a physical iPhone against a paired Mac harness. Higher = closer to premium Grok-class feel without compromising V Bot identity.

| Area | Score | Build-56 baseline | Primary gaps |
|---|---:|---|---|
| **Home** (`ChatListView`, `PinnedChatShelf`, `UpdatesSheet`) | **7** | Near-black canvas (`VBotSurface`), glass header, pinned hero row, Updates pill, Needs-you island, swipe pin | Large-roster scroll jank untested at 100+ chats; search opens secondary mode without transition polish; account sheet vs settings split feels uneven |
| **Chat** (`ChatView`, `SpeechBubble`, `MarkdownText`) | **8** | Coalesced streaming, near-bottom follow, grouped tool runs, approval cards, NEW divider, quoted reply | `ChatView.swift` still ~3k LOC — Release compile risk; long transcripts need memory/scroll profiling |
| **Profile / Settings** (`AgentProfileView`, `SettingsView`, `ConnectedAppsView`) | **7** | Full agent profile (avatar, model, voice, routines), calm settings hierarchy, haptics/sounds toggles | Profile sheets duplicate model picker logic from chat; offline/disconnected states vary by screen |
| **Groups / Pinning** (`GroupProfileView`, `NewGroupSheet`, `PinnedChatShelf`, `GroupRouting`) | **7** | Pin shelf (3-across), group profile with instructions + default responder, mention routing | Group creation UX is functional not delightful; no drag-reorder for pins |
| **Composer / Keyboard** (`ChatView` composer, `SpeechDictation`, `VmKeyboardBar`) | **8** | Build 56: soft haptic on send, 44pt targets, computer-return keyboard restore (`composerLayoutRevision`), dictation, slash HUD | Busy/interrupt affordances dense; mention autocomplete could use stronger visual hierarchy |
| **Attachments** (`ChatView`, `ShareInbox`, `AttachmentTests`) | **6** | Image pick/camera/file import, 10MB cap, share extension handoff, failed-upload retention | Images only — no video; share-to-chat routing can feel abrupt without staging preview |
| **Streaming / Tool activity** (`StreamPresentation`, `ToolRunGrouping`, `AgentThoughtChamberView`, `TypingIndicatorView`) | **8** | Frame cadence coalescer, stable markdown gate, tool-run disclosure, reasoning chamber, VoiceOver phase announcements | Reasoning UI is custom not Grok-cloned — good; error/reconnect banners could be more legible |
| **Onboarding / Pairing** (`CompanionApp`, `OnboardingViews`, `PairingView`, `PairingScanner`) | **7** | Welcome → opt-in pairing, QR-first, Bonjour discovery, hosted/Tailscale paths, notification education | No closed-app push; hosted pairing failure copy still technical on edge cases |
| **Model routing** (`ChatModelPickerSheet`, `ModelPickerView`, `EngineSync`, `ModelClientTests`) | **7** | Per-bot instance + model + effort, inline chat picker, reconstructed-engine guardrails | Catalog load errors are plain; no “recent models” or favorites; fast-mode surfacing inconsistent |
| **Local VM** (`ComputerView`, `VMViewerWebView`, `LocalVmInteractionChrome`, `RemoteDesktopCanvas`) | **6** | Per-bot status, create/stop/recreate, proxied noVNC viewer, pointer modes, phone clipboard bar | Viewer load failures fall back to screenshot canvas; join ticket/WebSocket health is fragile on cellular |
| **Cloud VM** (`ComputerView`, `CloudDesktopBrowser`, `ComputerPresentationState`) | **5** | Secure Box viewer via in-app Safari; VPS/cloud screenshot watch path | No native cloud viewer; VPS explicitly unavailable on phone; cloud feels second-class vs local |
| **Accessibility / Performance** (`ConversationTypography`, reduce-motion paths, `ChatView` a11y) | **6** | Dynamic Type on conversation text, reduce-motion on animations, extensive labels in chat | No systematic Large Content Viewer audit; `ComputerView` Release compile history; no Instruments baseline |

**Release anchor (build 56):** `996d221 chore(ios): release TestFlight build 56` — composer haptics/44pt targets and reliable composer restore after Computer (`1ee000f`). Streaming coalescence landed in builds 54–55 (`dbbb0aa`, `66f4bd7`).

---

## 2. Gap Backlog (P0 / P1 / P2)

Each item lists **exact files**, **priority**, and **observable acceptance criteria** (what a tester can verify on device without reading code).

### P0 — Ship blockers for “premium + reliable”

| ID | Gap | Files / components | Acceptance criteria |
|---|---|---|---|
| P0-1 | **Local VM viewer reliability** | `ios/App/VMViewerWebView.swift`, `ios/App/ComputerView.swift`, `ios/App/Session.swift`, `companion/src/routes.ts` (viewer proxy), `server/local-vm-phone.ts` | On Wi‑Fi and LTE: open Computer → Local VM → live viewer loads within 8s or shows actionable retry (not blank WebView). Pointer mode toggle works in both trackpad and touch. Returning to chat restores composer above keyboard (build-56 behavior preserved). |
| P0-2 | **Streaming reconnect without duplicate tails** | `ios/Sources/CompanionCore/Store.swift`, `ios/Sources/CompanionCore/StreamPresentation.swift`, `ios/App/ChatView.swift` | Background app ≤30s → foreground: live bubble resumes or cleanly replaces with settled message — never duplicate assistant bubbles. `StreamPresentationTests` + manual: kill SSE mid-stream, reconnect, no stuck “Working…” row. |
| P0-3 | **Connection failover clarity** | `ios/Sources/CompanionCore/Failover.swift`, `ios/App/Session.swift`, `ios/App/ChatListView.swift` (`StatusBanner`) | Toggle Wi‑Fi off/on: status banner shows reconnecting → live without requiring force-quit. Hosted → LAN promotion never silently downgrades to cleartext LAN after user chose hosted. |
| P0-4 | **Model switch safety while busy** | `ios/App/ChatModelPickerSheet.swift`, `ios/App/AgentProfileView.swift`, `ios/Sources/CompanionCore/Client.swift` | Busy bot: model picker disabled with inline copy; interrupt path still works. After interrupt, model change persists and next message uses new model (verify via harness transcript metadata). |

### P1 — Premium feel + Grok-class parity (clean-room)

| ID | Gap | Files / components | Acceptance criteria |
|---|---|---|---|
| P1-1 | **Surface token consistency** | `ios/App/VBotSurface.swift`, `ios/App/Glass.swift`, `ios/App/GroupProfileView.swift`, `ios/App/SettingsView.swift`, `ios/App/ComputerView.swift` | Settings, group profile, and computer screens use the same background, card, and glass treatments as home/chat — no rogue `Form` grays or one-off corner radii. Side-by-side screenshot: home ↔ settings feels like one app. |
| P1-2 | **Loading & empty-state polish** | `ios/App/ModelPickerView.swift` (`ModelPickerLoadingView`), `ios/App/ChatListView.swift`, `ios/App/AgentProfileView.swift`, `ios/App/ComputerView.swift` | Every async surface shows skeleton or `ContentUnavailableView` within 1 frame of appear — never a blank white/black flash. Offline profile shows cached identity + “Reconnect to edit.” |
| P1-3 | **Composer micro-interaction pass** | `ios/App/ChatView.swift`, `ios/App/PlatformBridge.swift` (`Haptics`, `SoundEffects`), `ios/App/Composer/TypingIndicatorView.swift` | Send: soft haptic + brief send-button scale (build 56 baseline). Stop: distinct haptic from send. Dictation start/stop: selection haptic. Settings toggles gate haptics/sounds app-wide. |
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
| P2-5 | **Model catalog UX** | `ios/App/ModelPickerView.swift`, `ios/App/ChatModelMenu.swift`, `ios/App/ProviderMarks.swift` | Engine chips show provider mark + model name; error state offers retry; empty catalog explains “No models on computer.” |
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

**Ship W1: Surface Cohesion & Perceived Responsiveness** first.

**Why:** It is almost entirely presentational — touches shared tokens (`VBotSurface`, `Glass`) and loading/empty patterns, not SSE, VM, or model wire formats. Build 56 already invested in composer haptics; W1 extends that discipline app-wide without risking the streaming/VM contracts that caused prior Release compile pain.

**W1 task bundle (ordered):**

1. Audit and align backgrounds/cards in `SettingsView.swift`, `GroupProfileView.swift`, `ComputerView.swift` to `VBotSurface` + `glassSheet` patterns used in `ChatListView.swift`.
2. Add skeleton loaders mirroring `ModelPickerLoadingView` to `AgentProfileView` (instances/routines) and `ComputerView` (instances list, viewer connecting).
3. Centralize haptic/sound gating in `PlatformBridge.swift` — respect `CompanionPreferences.hapticsKey` / `soundsKey` already in `SettingsView`.
4. Polish `PinnedChatShelf` pin/unpin animation and horizontal scroll metrics (`PinnedChatShelf.swift`).
5. Increment `CURRENT_PROJECT_VERSION` to **57**; update `ios/AppStore/en-US/release_notes.txt`.

**W1 regression watchlist:** composer send/stop, computer return keyboard, pin swipe, pairing QR — all must pass smoke on physical device before merge.

---

## 6. Release Cadence (internal TestFlight → external)

| Stage | Build bump | Audience | Physical-device QA checkpoint |
|---|---|---|---|
| **Alpha** | 57–58 (W1) | Vincent only, Wi‑Fi install fallback OK | Home/settings visual cohesion; haptics toggle; pin shelf |
| **Internal TF 1** | 59–60 (W2) | Internal TestFlight group | SSE drop mid-reply; model switch after interrupt; Release archive |
| **Internal TF 2** | 61–62 (W3) | Internal + 1 trusted tester | Local VM create → viewer → clipboard → chat return on LTE |
| **Internal TF 3** | 63–64 (W4–W5) | Internal group | Share extension; group mentions; model picker across engines |
| **Internal TF 4** | 65–66 (W6–W7) | Internal group | Failover matrix; Live Activity linger |
| **External TF** | 67+ (W8 complete) | External TestFlight | Full QA script below; 48h soak |
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

1. **Scorecard:** Every area in §1 is **≥8** on a physical iPhone against a production-class paired Mac (hosted + LAN tested).
2. **P0 cleared:** P0-1 through P0-4 verified on device with no open Sev-1/Sev-2 issues.
3. **Model agnostic:** User can switch among all harness-advertised instances (Codex, Claude, Grok-route, opencode-go, etc.) from chat and profile without app update; busy/interrupt rules enforced.
4. **Local VM reliable:** Create/stop/recreate works per-bot; viewer loads or degrades to screenshot canvas with explicit status — never a silent blank surface.
5. **Cloud VM honest:** Box interactive viewer works via in-app Safari; VPS/cloud backends show correct non-interactive copy (`ComputerPresentationState`).
6. **Premium feel:** Surface tokens consistent across home, chat, settings, profile, computer; loading/empty states everywhere; haptics/sounds respect user toggles.
7. **Streaming integrity:** No duplicate tails, no stuck working rows after reconnect — `StreamPresentationTests` green and manual SSE-drop pass.
8. **Accessibility:** VoiceOver completes home → chat → approve → settings without traps; Dynamic Type does not clip composer or bubbles at AX5.
9. **Performance:** 500-message thread meets §P2-8 thresholds on iPhone 15 class hardware.
10. **Clean-room:** No Grok proprietary assets, APIs, or copied UI vectors; `ProductIdentityTests` green; App Store privacy answers match binary.
11. **Release:** External TestFlight soak ≥48h, internal QA script §6 completed on two network conditions (Wi‑Fi + cellular), `CURRENT_PROJECT_VERSION` incremented per upload, release notes user-facing.

---

*Plan authored from audit of `ios/App`, `ios/Tests/CompanionCoreTests`, `ios/Sources/CompanionCore`, `companion/src/routes.ts`, and build-56 release state. Execution agents should not modify this file from implementation worktrees unless explicitly tasked with plan revisions.*
