# iOS Agent-to-Agent Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished native iOS agent-to-agent experience with authentic peer activity, stable navigation, adjustable conversation typography, synchronized pinned chats, and explicit Stop/Steer/Queue controls.

**Architecture:** Keep paired-device privileges narrow by adding purpose-built pin, room-interrupt, and delivery-mode contracts instead of exposing broad desktop mutation routes. Put reusable presentation policy in CompanionCore where it can be unit tested, keep SwiftUI views declarative, and let server/SSE state remain authoritative. Implement in independently reviewable waves so UI polish cannot conceal an API or concurrency regression.

**Tech Stack:** Swift 5.9, SwiftUI iOS 17+, Foundation, TypeScript, Node HTTP server, Zod, Vitest, XcodeGen, XCTest/Swift Testing.

## Global Constraints

- Add no dependencies.
- Preserve the paired-device allowlist; broad bot and room PATCH routes remain unavailable to iOS.
- A normal Send while busy defaults to **Steer**; long-press always exposes Steer and Queue.
- Preserve existing callers by treating omitted delivery mode as `auto`.
- Use server-backed pin state for bots and rooms.
- Respect Reduce Motion and standard iOS Dynamic Type behavior.
- Do not imply local VM lifecycle or interactive control where only viewing is supported.
- Do not upload TestFlight without a new explicit authorization after every release gate is green.

---

### Task 1: Dedicated Agent-to-Agent Activity Row

**Files:**
- Create: `ios/Sources/CompanionCore/CommActivityPresentation.swift`
- Create: `ios/Tests/CompanionCoreTests/CommActivityPresentationTests.swift`
- Modify: `ios/App/ChatView.swift`

**Interfaces:**
- Consumes: `Message.comm`, `Message.tool`, `Message.from`, `CompanionState.bot(_:)`, and `BotAvatarView`.
- Produces: `CommActivityPresentation.init?(message:)`, `CommActivityRow`, and one navigation callback carrying `comm.groupId`.

- [ ] **Step 1: Write failing presentation tests**

```swift
func testOutgoingCommUsesOneNeutralPeerLabel() throws {
    let data = Data(#"{"id":"m1","role":"bot","kind":"activity","at":1,"tool":{"name":"Messaged @CIO"},"comm":{"groupId":"room-1","withBotId":"cio","withName":"CIO","withColor":"blue"}}"#.utf8)
    let message = try JSONDecoder().decode(Message.self, from: data)
    let row = try #require(CommActivityPresentation(message: message))
    #expect(row.peerBotId == "cio")
    #expect(row.title == "Messaged @CIO")
    #expect(row.groupId == "room-1")
    #expect(row.showsRunning == false)
}

func testOrdinaryToolActivityIsNotACommRow() {
    let data = Data(#"{"id":"m2","role":"bot","kind":"activity","at":1,"tool":{"name":"Read file","ok":true}}"#.utf8)
    let message = try! JSONDecoder().decode(Message.self, from: data)
    #expect(CommActivityPresentation(message: message) == nil)
}
```

- [ ] **Step 2: Run the new tests and confirm the missing type failure**

Run: `cd ios && swift test --filter CommActivityPresentationTests`  
Expected: FAIL because `CommActivityPresentation` does not exist.

- [ ] **Step 3: Implement the renderer-neutral presentation type**

```swift
public struct CommActivityPresentation: Equatable, Sendable {
    public let peerBotId: String
    public let title: String
    public let groupId: String
    public let showsRunning = false

    public init?(message: Message) {
        guard message.kind == .activity, let comm = message.comm else { return nil }
        peerBotId = comm.withBotId
        let candidate = message.tool?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        title = candidate.isEmpty ? "Messaged @\(comm.withName)" : candidate
        groupId = comm.groupId
    }
}
```

- [ ] **Step 4: Render the comm branch before generic activity**

Add `CommActivityRow` to `ChatView.swift` with an 18-point `BotAvatarView`, one title, secondary styling, and a chevron. In `MessageRow.content`, branch on `CommActivityPresentation(message:)` before `ActivityChip`; delete the separate generic `if let comm` label so the message renders exactly once. Resolve the peer from `session.state.bot(row.peerBotId)` and fall back to the comm color/name only when the bot no longer exists.

- [ ] **Step 5: Run focused and complete Swift tests**

Run: `cd ios && swift test --filter CommActivityPresentationTests && swift test`  
Expected: new tests PASS and all existing Swift tests PASS.

- [ ] **Step 6: Commit the activity row**

```bash
git add ios/Sources/CompanionCore/CommActivityPresentation.swift ios/Tests/CompanionCoreTests/CommActivityPresentationTests.swift ios/App/ChatView.swift
git commit -m "feat(ios): polish agent communication activity"
```

---

### Task 2: Stable Header, Native Back Swipe, and Conversation Typography

**Files:**
- Create: `ios/Sources/CompanionCore/ConversationTextSize.swift`
- Create: `ios/Tests/CompanionCoreTests/ConversationTextSizeTests.swift`
- Create: `ios/App/ConversationTypography.swift`
- Create: `ios/App/InteractivePopGesture.swift`
- Modify: `ios/App/SettingsView.swift`
- Modify: `ios/App/ChatView.swift`
- Modify: `ios/App/MarkdownText.swift`
- Modify: `ios/App/Cards/SkillExecutionReceiptView.swift`

**Interfaces:**
- Produces: `ConversationTextSize` (`small`, `standard`, `large`), `ConversationTypography`, environment key `conversationTypography`, and `InteractivePopGestureEnabler`.
- Consumes: `@AppStorage("conversationTextSize")` and `accessibilityReduceMotion`.

- [ ] **Step 1: Write failing text-size mapping tests**

```swift
func testConversationTextSizeUsesBoundedScales() {
    #expect(ConversationTextSize.small.scale == 0.9)
    #expect(ConversationTextSize.standard.scale == 1.0)
    #expect(ConversationTextSize.large.scale == 1.15)
    #expect(ConversationTextSize(rawValue: "future") ?? .standard == .standard)
}
```

- [ ] **Step 2: Add the enum and shared typography environment**

```swift
public enum ConversationTextSize: String, CaseIterable, Codable, Sendable {
    case small, standard, large
    public var scale: CGFloat { self == .small ? 0.9 : self == .large ? 1.15 : 1.0 }
}

struct ConversationTypography {
    let scale: CGFloat
    var body: Font { .system(size: 17 * scale) }
    var heading1: Font { .system(size: 21 * scale, weight: .semibold) }
    var code: Font { .system(size: 14 * scale, design: .monospaced) }
}
```

- [ ] **Step 3: Add the Settings picker**

Use `@AppStorage("conversationTextSize") private var conversationTextSize = ConversationTextSize.standard.rawValue` and a segmented or navigation-style Picker labeled `Conversation text size`. Apply the environment once at the chat root so Markdown, composer, activity, and action chips consume the same values.

- [ ] **Step 4: Remove the per-conversation avatar expansion**

Delete the `facePhase` transition that grows `60 + 72 * facePhase`; keep the header seat fixed at 60 points. Any face-state animation must remain inside that frame and be disabled when `accessibilityReduceMotion` is true.

- [ ] **Step 5: Restore the system interactive-pop gesture**

Implement a minimal `UIViewControllerRepresentable` that locates its containing `UINavigationController`, sets `interactivePopGestureRecognizer?.delegate = nil`, and enables it when the navigation stack has more than one controller. Attach it as a zero-size background to `ChatView`; retain the custom back button without adding a competing `DragGesture`.

- [ ] **Step 6: Replace fixed chat fonts with the environment**

Update `MarkdownText`, message prose, composer text, tool summaries/details, and predictive chips to use `ConversationTypography`. Do not scale navigation titles, avatar sizes, or standard buttons.

- [ ] **Step 7: Verify tests and simulator compilation**

Run: `cd ios && swift test && xcodegen generate && xcodebuild -project OpenMausCompanion.xcodeproj -scheme OpenMausCompanion -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' CODE_SIGNING_ALLOWED=NO build`  
Expected: all Swift tests PASS and `** BUILD SUCCEEDED **`.

- [ ] **Step 8: Commit navigation and typography**

```bash
git add ios/Sources/CompanionCore/ConversationTextSize.swift ios/Tests/CompanionCoreTests/ConversationTextSizeTests.swift ios/App/ConversationTypography.swift ios/App/InteractivePopGesture.swift ios/App/SettingsView.swift ios/App/ChatView.swift ios/App/MarkdownText.swift ios/App/Cards/SkillExecutionReceiptView.swift
git commit -m "feat(ios): add stable navigation and chat typography"
```

---

### Task 3: Narrow Server-Backed Conversation Pinning

**Files:**
- Create: `server/chat-pin.ts`
- Create: `server/chat-pin.test.ts`
- Modify: `server/store.ts`
- Modify: `server/index.ts`
- Modify: `server/index.test.ts`
- Modify: `companion/src/routes.ts`
- Modify: `companion/test/routes.test.ts`
- Modify: `companion/test/proxy.test.ts`
- Modify: `ios/Sources/CompanionCore/Models.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift`
- Modify: `ios/App/Session.swift`
- Modify: `ios/Tests/CompanionCoreTests/ProfileClientTests.swift`

**Interfaces:**
- Produces: `PATCH /api/bots/:id/pin`, `PATCH /api/groups/:id/pin`, body `{ pinned: boolean }`, `Bot.pinned`, `Room.pinned`, `CompanionClient.setPinned(_:botId:)`, and `CompanionClient.setPinned(_:roomId:)`.

- [ ] **Step 1: Write strict parser and route tests**

```ts
expect(parseChatPin({ pinned: true })).toEqual({ ok: true, pinned: true });
expect(parseChatPin({ pinned: true, autoApprove: true }).ok).toBe(false);
expect((await api("PATCH", `/api/bots/${bot.id}/pin`, { pinned: true })).body.bot.pinned).toBe(true);
expect((await api("PATCH", `/api/groups/${room.id}/pin`, { pinned: true })).body.group.pinned).toBe(true);
```

- [ ] **Step 2: Add `pinned?: boolean` to `GroupRecord` and the strict parser**

Use a strict Zod object containing only `pinned: z.boolean()`. Persist through `store.patchBot`/`store.patchGroup` and broadcast the updated wire object.

- [ ] **Step 3: Add the two narrow routes and companion allowlist entries**

Reject missing records with 404 and malformed/extra fields with 400. Add only the two exact regexes to `companion/src/routes.ts`; keep broad PATCH routes denied and explicitly test that denial.

- [ ] **Step 4: Add typed Swift models and clients**

```swift
public struct ChatPinPatch: Encodable, Sendable { public let pinned: Bool }
public func setPinned(_ pinned: Bool, botId: String) async throws -> Bot
public func setPinned(_ pinned: Bool, roomId: String) async throws -> Room
```

Add `Room.pinned` and Session helpers that apply the returned `.bot` or `.room` state only after server acknowledgement.

- [ ] **Step 5: Run focused server, companion, and Swift tests**

Run: `./node_modules/.bin/vitest run server/chat-pin.test.ts server/index.test.ts companion/test/routes.test.ts companion/test/proxy.test.ts && ./node_modules/.bin/tsc -p tsconfig.server.json && ./node_modules/.bin/tsc -p tsconfig.companion.build.json && (cd ios && swift test)`  
Expected: all selected tests and builds PASS.

- [ ] **Step 6: Commit the pin contract**

```bash
git add server/chat-pin.ts server/chat-pin.test.ts server/store.ts server/index.ts server/index.test.ts companion/src/routes.ts companion/test/routes.test.ts companion/test/proxy.test.ts ios/Sources/CompanionCore/Models.swift ios/Sources/CompanionCore/Client.swift ios/App/Session.swift ios/Tests/CompanionCoreTests/ProfileClientTests.swift
git commit -m "feat(companion): add safe conversation pinning"
```

---

### Task 4: Favorite-Agent Shelf and Pin Affordances

**Files:**
- Create: `ios/App/PinnedChatShelf.swift`
- Modify: `ios/App/ChatListView.swift`
- Modify: `ios/App/Session.swift`
- Modify: `ios/Tests/CompanionCoreTests/StoreTests.swift`

**Interfaces:**
- Consumes: server-backed `ChatSummary.pinned` and `Session.setPinned(_:for:)`.
- Produces: a horizontally scrolling pinned shelf and Pin/Unpin swipe/context actions.

- [ ] **Step 1: Extend sorting tests to include pinned rooms**

Construct one pinned bot, one pinned room, and newer unpinned chats. Assert the pinned pair precede all unpinned summaries while unread/recency ordering remains stable within each partition.

- [ ] **Step 2: Update `ChatSummary.pinned` for both chat kinds**

```swift
private static func pinned(_ chat: Chat) -> Bool {
    switch chat {
    case .bot(let bot): return bot.pinned ?? false
    case .room(let room): return room.pinned ?? false
    }
}
```

- [ ] **Step 3: Add the shelf from the supplied mobile reference**

Show pinned chats above the normal list in a horizontal `ScrollView`. Use 72-point bot avatars, room avatar stacks, one-line names, and stable IDs. Exclude pinned items from the normal recency rows so each conversation appears once.

- [ ] **Step 4: Add Pin/Unpin actions**

Attach trailing swipe actions and context-menu actions to normal rows and shelf items. Disable repeated mutations while the specific chat request is pending; reorder with a Reduce-Motion-aware animation only after the server response reaches state.

- [ ] **Step 5: Build and visually verify one, two, and many pinned chats**

Run the iPhone 17 Pro simulator with preview fixtures for one pinned bot, two pinned chats, and an overflowing shelf. Expected: no duplicate rows, clipped names use one-line truncation, and unread/busy indicators remain visible.

- [ ] **Step 6: Commit the pinned shelf**

```bash
git add ios/App/PinnedChatShelf.swift ios/App/ChatListView.swift ios/App/Session.swift ios/Tests/CompanionCoreTests/StoreTests.swift
git commit -m "feat(ios): add pinned conversation shelf"
```

---

### Task 5: Explicit Delivery Modes and Paired-Safe Room Stop

**Files:**
- Create: `server/message-delivery.ts`
- Create: `server/message-delivery.test.ts`
- Modify: `server/index.ts`
- Modify: `server/index.test.ts`
- Modify: `server/steer-queue.test.ts`
- Modify: `companion/src/routes.ts`
- Modify: `companion/test/routes.test.ts`
- Modify: `companion/test/proxy.test.ts`
- Modify: `ios/Sources/CompanionCore/Models.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift`
- Modify: `ios/App/Session.swift`
- Create: `ios/Tests/CompanionCoreTests/MessageDeliveryClientTests.swift`

**Interfaces:**
- Produces: `DeliveryMode = "auto" | "steer" | "queue"`, response `{ ok, disposition, queueId?, threadId? }`, paired-safe room interrupt, and Swift `MessageDeliveryMode`/`MessageDeliveryReceipt`.

- [ ] **Step 1: Write failing parser and behavior tests**

```ts
expect(parseDeliveryMode(undefined)).toBe("auto");
expect(parseDeliveryMode("steer")).toBe("steer");
expect(() => parseDeliveryMode("later")).toThrow();
```

Add integration tests proving: idle `steer` starts normally or returns a documented 409; busy supported `steer` never silently queues; busy `queue` never calls adapter steer; `auto` preserves current steer-then-queue behavior; a failed explicit steer leaves no user message; a busy room applies explicit steer to its active member and explicit queue to the serialized room turn; room interrupt is reachable through the sidecar while broad group PATCH remains blocked.

- [ ] **Step 2: Extract delivery policy without changing auto behavior**

Implement a small decision function returning `start`, `steer`, `queue`, or `unsupported`. Keep the existing bot queue persistence and prompt-with-reply code as the execution path; do not duplicate the queue implementation. For rooms, route `steer` to the current `busyBotId` adapter and route `queue` through the existing serialized group-turn queue, preserving member order and reply targeting.

- [ ] **Step 3: Add typed response bodies**

Return `disposition: "started" | "steered" | "queued"`; include `queueId` and `threadId` only for queued work. Continue returning HTTP 202 for accepted work and use 409 for an explicit mode the active engine cannot honor.

- [ ] **Step 4: Permit the exact room interrupt route**

Add `POST /api/groups/:id/interrupt` to the companion allowlist and proxy tests. No other group mutation becomes reachable.

- [ ] **Step 5: Add Swift request/response types**

```swift
public enum MessageDeliveryMode: String, Codable, Sendable { case auto, steer, queue }
public struct MessageDeliveryReceipt: Decodable, Sendable {
    public let disposition: Disposition
    public let queueId: String?
    public let threadId: String?
}
```

Change `CompanionClient.send` and `Session.send` to return the receipt. Add `interrupt(roomId:)` and one `Session.interrupt(chat:)` switch covering bots and rooms.

- [ ] **Step 6: Run focused and full contract gates**

Run: `./node_modules/.bin/vitest run server/message-delivery.test.ts server/steer-queue.test.ts server/index.test.ts companion/test/routes.test.ts companion/test/proxy.test.ts && ./node_modules/.bin/tsc -b && ./node_modules/.bin/tsc -p tsconfig.server.json && ./node_modules/.bin/tsc -p tsconfig.companion.build.json && (cd ios && swift test)`  
Expected: all tests and TypeScript builds PASS.

- [ ] **Step 7: Commit delivery semantics**

```bash
git add server/message-delivery.ts server/message-delivery.test.ts server/index.ts server/index.test.ts server/steer-queue.test.ts companion/src/routes.ts companion/test/routes.test.ts companion/test/proxy.test.ts ios/Sources/CompanionCore/Models.swift ios/Sources/CompanionCore/Client.swift ios/App/Session.swift ios/Tests/CompanionCoreTests/MessageDeliveryClientTests.swift
git commit -m "feat(companion): add explicit steer and queue delivery"
```

---

### Task 6: Native Stop, Steer, and Queue Composer

**Files:**
- Create: `ios/Sources/CompanionCore/ComposerActionPolicy.swift`
- Create: `ios/Tests/CompanionCoreTests/ComposerActionPolicyTests.swift`
- Modify: `ios/App/SettingsView.swift`
- Modify: `ios/App/ChatView.swift`

**Interfaces:**
- Produces: `BusySendDefault` (`steer`, `queue`), `ComposerPrimaryAction`, and a request-in-flight guard.
- Consumes: `Session.send(_:to:mode:)`, `Session.interrupt(chat:)`, `Chat.busy`, draft text, and `@AppStorage("busySendDefault")`.

- [ ] **Step 1: Write the composer state-matrix tests**

```swift
#expect(ComposerActionPolicy.action(busy: true, draft: "", defaultMode: .steer) == .stop)
#expect(ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .steer) == .send(.steer))
#expect(ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .queue) == .send(.queue))
#expect(ComposerActionPolicy.action(busy: false, draft: "next", defaultMode: .queue) == .send(.auto))
```

- [ ] **Step 2: Add the Settings default**

Create `While agent is working` with Steer (default) and Queue. Store only the raw enum value; unknown future values decode as Steer.

- [ ] **Step 3: Replace the composer primary action**

When busy and the trimmed draft is empty, show a red stop-square button. When text exists, show Send using the configured default. Keep microphone visible when appropriate. Disable duplicate submissions while the request is awaiting acknowledgement.

- [ ] **Step 4: Add explicit long-press choices**

Attach a context menu to Send with `Steer now` and `Queue after current work`. Both call the same submission function with an explicit mode, preserve the draft on failure, and clear it only after a receipt is returned.

- [ ] **Step 5: Surface accepted queue state without fake completion**

For a queued receipt, add a small local pending label keyed by `queueId` until the server transcript delivers the queued user message or a reconnect refresh removes it. Do not show Running or Worked for a mere acknowledgement.

- [ ] **Step 6: Verify policy tests and simulator interaction**

Run: `cd ios && swift test --filter ComposerActionPolicyTests && swift test && xcodegen generate && xcodebuild -project OpenMausCompanion.xcodeproj -scheme OpenMausCompanion -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' CODE_SIGNING_ALLOWED=NO build`  
Expected: all tests PASS and `** BUILD SUCCEEDED **`.

- [ ] **Step 7: Commit composer controls**

```bash
git add ios/Sources/CompanionCore/ComposerActionPolicy.swift ios/Tests/CompanionCoreTests/ComposerActionPolicyTests.swift ios/App/SettingsView.swift ios/App/ChatView.swift
git commit -m "feat(ios): add stop steer and queue controls"
```

---

### Task 7: Computer-State Polish and Release-Candidate Verification

**Files:**
- Create: `ios/Sources/CompanionCore/ComputerPresentationState.swift`
- Create: `ios/Tests/CompanionCoreTests/ComputerPresentationStateTests.swift`
- Modify: `ios/App/ComputerView.swift`
- Modify: `ios/App/StorePreview.json`

**Interfaces:**
- Produces: `ComputerPresentationState.starting`, `.watching`, `.unavailable(message:)`, and `.cloudViewerAvailable`.
- Consumes: existing screen frames, `Bot.computer`, `Bot.cloudBackend`, and `Session.cloudDesktop(for:)`.

- [ ] **Step 1: Write truthful state-mapping tests**

Assert that cloud+supported maps to viewer available, VPS/local VM never claims interactive viewer support, missing frames map to Starting before timeout and Unavailable after a load failure, and a received frame maps to Watching.

- [ ] **Step 2: Refine ComputerView states from the mobile reference**

Use a compact avatar/title header, centered Starting indicator, clear Unavailable retry state, and the existing secure viewing path. Show keyboard/clipboard controls only when the current viewer implementation can consume them; do not add inert buttons.

- [ ] **Step 3: Add preview fixtures for visual QA**

Represent pinned shelf overflow, one communication row, busy composer with Stop, busy composer with Steer, and the three computer states. Preview data must remain synthetic and contain no credentials or private URLs.

- [ ] **Step 4: Run the complete release-candidate gate**

Run:

```bash
./node_modules/.bin/vitest run 'server/**/*.test.ts' 'companion/test/**/*.test.ts'
./node_modules/.bin/tsc -b
./node_modules/.bin/tsc -p tsconfig.server.json
./node_modules/.bin/tsc -p tsconfig.companion.build.json
cd ios && swift test
xcodegen generate
xcodebuild -project OpenMausCompanion.xcodeproj -scheme OpenMausCompanion -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' CODE_SIGNING_ALLOWED=NO build
```

Expected: all selected Vitest suites PASS, TypeScript builds PASS, all Swift tests PASS, and `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Perform simulator interaction checks**

Verify: one comm row with peer avatar; no Running label; fixed header avatar across conversation pushes; left-edge back swipe; all three text sizes; one/two/many pinned chats; bot and room Pin/Unpin; bot and room Stop; Steer default; explicit Queue; Reduce Motion; truthful computer states.

- [ ] **Step 6: Commit the verified candidate**

```bash
git add ios/Sources/CompanionCore/ComputerPresentationState.swift ios/Tests/CompanionCoreTests/ComputerPresentationStateTests.swift ios/App/ComputerView.swift ios/App/StorePreview.json
git commit -m "feat(ios): polish computer states and agent experience"
```

- [ ] **Step 7: Stop at the release boundary**

Report commits, exact test counts, simulator evidence, remaining physical-device checks, and whether the working tree is clean. Do not bump build number, archive, or upload until Vincent explicitly authorizes the next TestFlight release.
