# V Bot Hermes First-Party Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes a first-party V Bot runtime by projecting proven Bot Mode capabilities through the existing Grok-style iOS UI, pairing, approvals, transcript, VM/fleet, and hub messaging — without replacing those surfaces or minting a second mobile transcript store.

**Architecture:** Wave 1 already owns local discovery, exact `Bot Chat` lookup, send, stream, and stop. Wave 2 keeps Hermes behind the hub-owned `hermesBot` adapter (not a `VBotPrimaryEngine`). It adds capability negotiation against `origin/main` `ab9866bc64`, adopt-before-mint for a missing canonical chat, dual-plane messaging intercept (Hermes `message_agent` plus V Bot `ask_bot`/`delegate_bot`) into existing comm/activity UI, event normalization for tools and approvals, recursion/budget/replay controls, and a tiny additive iOS composer field so Stop/Queue/Steer stop lying. Everything else stays classified and deferred.

**Tech Stack:** TypeScript hub (`server/engines/*`, Store, EventBus, SSE), existing SwiftUI companion (`CompanionCore` + `ChatView`), Hermes TUI JSON-RPC at pin `ab9866bc64`, Vitest, Swift Testing.

## Global Constraints

- Work only in `/Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901` on `feat/vbot-hermes-adapter-0901`.
- Never edit, checkout, reset, stash, or clean `/Users/Vincent/Github/hermes-agent`. Read Hermes only with `git show ab9866bc64:<path>` (resolved `origin/main`). Do not depend on that checkout's dirty `main`.
- Do not add Hermes to `VBotPrimaryEngine` in `server/vbot-engine-sync.ts` or `src/lib/vbot-engine.ts`. OpenMaus and Grok Reconstructed stay the primary-engine pair. Hermes remains a hub-owned profile adapter.
- Do not change iOS bundle ID `com.posival.openmausmobile`, pairing, Keychain device tokens, SSE event names, or Store transcript identity. Additive JSON only; omitted fields must keep current Grok-style behavior.
- Phone never receives `HERMES_HOME`, executable/profile paths, SessionDB ids, runtime `session_id`, tokens, `.env`, raw stderr, query text, or JSON-RPC payloads.
- Capability flags stay affirmative. A method existing on the pin is not enough; the adapter must prove the guarded path, then turn the flag on.
- Canonical identity remains exact profile slug plus title literal `Bot Chat`. Lookup always uses `session.list` with `{ profile, title: "Bot Chat", include_hidden: true, limit: 200 }` and denies `kanban`/`tool` sources. `absent` ≠ `unknown`.
- Adopt-before-mint: `session.create` runs only after a successful empty exact lookup under the profile lock. Lookup failure never creates. After create, re-lookup must return `present` or the mint is a typed failure and is never retried as a second title.
- `groups: false` still blocks multi-member V Bot rooms and every Hermes `groups.*` / `bot_relay.*` path. Wave 2 carves one exception: V Bot 1:1 `dm: true` comm channels so both messaging planes can project into existing `CommActivityRow`.
- Child env stays the Wave 1 positive allowlist in `sanitizeHermesChildEnv`. Never inject V Bot API keys. Never call `model.save_key` from V Bot.
- Do not add dependencies. Do not use `--force`, `--no-verify`, or `rm -rf`. Do not run `pnpm` in this worktree (it mutates `pnpm-workspace.yaml`); use `./node_modules/.bin/vitest` and `./node_modules/.bin/tsc`.
- Preserve unrelated dirty work, including untracked `.release/`.

---

## Source pins

Wave 1 shipped against Hermes tag `v2026.8.31`. Wave 2 pins:

```text
origin/main  ab9866bc64df48281a2d929dfb1dfd1001973d24
```

Read with:

```bash
git -C /Users/Vincent/Github/hermes-agent show ab9866bc64:tui_gateway/server.py
```

Do not `cd` into that repo to edit files.

### Hermes RPC and tools used by this plan

| Pin path | Methods / symbols Wave 2 may call |
| --- | --- |
| `tui_gateway/entry.py` | `gateway.ready` handshake; line-delimited JSON-RPC |
| `tui_gateway/server.py` | `gateway.capabilities` (`per_session_exclusive_submit`) |
| `tui_gateway/methods_profiles.py` | `profiles.list`, `profiles.describe` (read-only) |
| `tui_gateway/methods_session.py` | `session.list`, `session.create` (`title`, `hidden`, `profile`, `source`), `session.resume`, `session.interrupt`, `session.set_hidden` |
| `tui_gateway/methods_prompt.py` | `prompt.submit`, `approval.pending`, `approval.respond`, `approval.received`; **not** `prompt.btw` / `image.attach*` in this wave |
| `tui_gateway/methods_complete.py` | `model.options` (read-only later); **not** `model.save_key` |
| `tui_gateway/methods_tools.py` | later waves: `tools.list`, `cron.manage`, `skills.manage`, `mcp.*` |
| `tui_gateway/methods_groups.py` | `groups.capabilities` may be **probed** but `groups` stays false |
| `tui_gateway/methods_bot_relay.py` | never called in Wave 2 |
| `tools/bot_mode_probe.py` | `BOT_CHAT_TITLE = "Bot Chat"`, `is_bot_mode_managed` |
| `tools/bot_mode_dm.py` | `MESSAGE_AGENT_TOOL_NAME`, `MESSAGE_MAX_CHARS = 16000`, local vs `<peer>/<agent>` targets |
| `tools/bot_relay.py` | deferred |
| `tools/approval.py` | gateway approval list/resolve (via TUI methods, not by importing Python) |
| `tools/delegate_tool.py` | deferred spawn; Wave 2 only projects parent-visible tool events |
| `cron/jobs.py`, `hermes_cli/web_routers/cron.py` | never read from TypeScript |

### V Bot seams this wave extends

| Path | Role |
| --- | --- |
| `server/engines/contracts.ts` | flags, binding, discovery, errors |
| `server/engines/discovery.ts` | `projectHermesCapabilities`, canonical lookup |
| `server/engines/bindings.ts` | `${DATA_DIR}/hermes-bindings.json` |
| `server/engines/hermes.ts` | TUI client + `HermesBotEngine` |
| `server/engines/index.ts` | registry |
| `server/testing/fake-hermes-tui-gateway.ts` | CI fixture |
| `server/hermes-groups.ts` | membership/send fail-closed gate |
| `server/hermes-interrupt.ts` | stop routing |
| `server/comms-visibility.ts` | `getOrCreateChannel`, `mirrorExchange` |
| `server/delegations.ts` | V Bot `delegate_bot` queue |
| `server/index.ts` | `startTurn` Hermes branch, `/api/bots/:id/messages`, `/api/instances` |
| `server/contracts.ts` | `RuntimeEvent` union — prefer reuse; additive event fields only if tests prove existing fold ignores extras |
| `server/store.ts` | `createGroup(..., dm=true)`, `BotRecord`, messages |
| `server/provider-catalog.ts` | additive `capabilities.hermesBot` |
| `server/approval-reviewer.ts` | display-only explainer; sandbox/guard stay authoritative |
| `ios/Sources/CompanionCore/Models.swift` | `Bot`, `CommChip`, `InstanceCapabilities` |
| `ios/Sources/CompanionCore/ComposerActionPolicy.swift` | Stop/Steer/Queue |
| `ios/Sources/CompanionCore/CommActivityPresentation.swift` | existing comm row |
| `ios/App/ChatView.swift` | composer + `CommActivityRow` |
| `docs/hermes-adapter.md` | Wave 1 contract to extend |

---

## Capability matrix

Classification keys:

- **already supported** — Wave 1 (or existing V Bot) already proves it for Hermes-bound bots
- **backend-only gap** — Hermes RPC exists at the pin; hub can project it without a new iOS wire type
- **iOS contract/UI gap** — phone must decode or present something new, or today's UI lies
- **intentionally unsupported** — out of product scope, unsafe on the phone, or no honest mapping

| Area | Class | Wave 2? | Evidence / rule |
| --- | --- | --- | --- |
| Canonical Bot Chat lookup/send/final/events/stop | already supported | keep | `server/engines/hermes.ts` `session.list` / `resume` / `prompt.submit` / `session.interrupt` |
| Profiles: roster read | already supported | keep | `profiles.list` via `normalizeProfileRows` |
| Profiles: create/configure/assets | iOS contract/UI gap | no | `profiles.create` / `profiles.configure` / `profiles.set_asset` would need a settings surface and must not write secrets |
| Tools list / MCP catalog read | backend-only gap | no | `tools.list`, `mcp.catalog`, `mcp.servers.list` at `methods_tools.py`; Wave 3 |
| Tools / MCP add, API key, OAuth | intentionally unsupported | no | `mcp.servers.set_api_key`, `mcp.servers.oauth.*` violate secret isolation |
| Skills read/reload | backend-only gap | no | `skills.manage`, `skills.reload`; Wave 3 |
| Files / attachments / vision | iOS contract/UI gap | no | Hermes `image.attach` / `image.attach_bytes` / `pdf.attach` / `file.attach` vs V Bot share/attachment pipeline; different bytes contract |
| Permissions / approvals | backend-only gap + existing iOS cards | **yes** | Map TUI `approval.pending` → `request.opened`; answer via `approval.respond`; reuse iOS approval cards |
| Streaming deltas | already supported | keep | `message.delta` → `content.delta` |
| Sessions / history / search | intentionally unsupported as a second store | no | V Bot Store remains SoT. Hermes `session_search` is an in-turn tool, not a phone search API. Do not mirror SessionDB |
| Goals / tasks | intentionally unsupported merge | no | V Bot `BotRecord.tasks` ≠ Hermes `todo_tool` / `kanban_tools.py`. Kanban sources already denied in lookup |
| V Bot routines on a bound bot | already supported | keep | Hub `RoutineManager` → existing `startTurn` Hermes branch |
| Hermes cron read (`cron.manage` list) | backend-only gap | no | Wave 3, authenticated dashboard-equivalent only; never parse `jobs.json` |
| Hermes cron mutate | iOS contract/UI gap | no | Wave 4; deliver `bot-chat[:name]` must stay adopt-before-mint |
| V Bot delegates (`ask_bot` / `delegate_bot`) | already supported for unbound; **blocked for Hermes pairs today** | **yes (1:1 only)** | `comms-visibility.ts` currently throws `hermesGroupMembershipError` |
| Hermes `delegate_task` subagents | backend-only gap | no | Project parent tool chips in Wave 2 if events exist; do not spawn or steer children from iOS |
| Hermes `message_agent` | backend-only gap | **yes** | Intercept sender tool + local target binding into comm UI |
| V Bot multi-member rooms | already fail-closed | keep false | `server/hermes-groups.ts` |
| Hermes hosted `groups.*` | iOS contract/UI gap | no | `groups.capabilities` is a different protocol (authority epoch, replicas). Wave 5 |
| Hermes `bot_relay.*` / cross-machine | intentionally unsupported | no | Peer gateways, Desktop drain, remote credential forwarding |
| Stop | already supported | keep | `hermes-interrupt.ts` |
| Steer | intentionally unsupported | no | Hermes `prompt.btw` is a side question that **does not** enter history or interrupt. Mapping it to V Bot steer would lie |
| Hub queue while busy | already supported | keep | `/api/bots/:id/messages` can Queue when `canSteer` is false (`server/index.ts` ~6732) |
| Native Hermes queueing flag | intentionally unsupported | no | No matching RPC; do not set `queueing: true` |
| Models / effort read | backend-only gap | no | `model.options`; `prompt.submit` already accepts `model` internally. Effort → `reasoning_effort` is Wave 3 |
| Setup / auth / billing | intentionally unsupported | no | `setup.status`, `model.save_key`, `billing.state`. Login never replaces pairing |
| Computer / terminal / VM / fleet | intentionally unsupported as Hermes destinations | keep V Bot's | Bound turns skip MCP/computer setup in `startTurn`. iOS Local VM stays OpenMaus/Claude/Codex/ACP. Hermes `computer_use/` and `terminal_tool.py` may run **inside** a Hermes turn; they are not V Bot Computer surfaces |
| Notifications | iOS contract/UI gap | no | V Bot `bot.notifications` + existing APNS path. Hermes `wake.*` / gateway delivery stay hub-local |
| Artifacts / previews | iOS contract/UI gap | no | `browser_control_artifacts`, preview RPCs |
| Recovery (CLI/gateway/auth/sidecars) | already supported | extend | Wave 2 adds mint-failure and comm-dedupe recovery; still no OpenMaus fallback |

---

## Wave 2 scope (smallest safe)

Ship only what makes Hermes first-party **on the surfaces iOS already has**:

1. Pin + capability negotiation (`gateway.capabilities`, expanded flags, still fail-closed).
2. Adopt-before-mint for missing `Bot Chat`.
3. Dual-plane messaging intercept into existing comm/activity UI, with source attribution.
4. Recursion / budget / replay controls for that intercept.
5. Normalize Hermes tool + approval events onto existing `RuntimeEvent` / iOS cards.
6. Additive per-bot composer `{ queueing:false, steer:false, stop:true }` so the Grok-style composer stops offering Steer on Hermes-bound chats.
7. Docs + fixture proof.

**Explicitly not Wave 2:** Hermes groups/rooms/relay, attachments/vision, cron UI, skills/MCP settings, model/effort picker beyond today's V Bot `modelSelection`, Computer panel for Hermes, SessionDB search, kanban, `prompt.btw` steer, provider secrets, remote Hermes, `VBotPrimaryEngine`.

---

## Architectural contracts

### Capability negotiation

Handshake after `gateway.ready`:

1. `gateway.capabilities` → require `per_session_exclusive_submit === true` or refuse overlapping `prompt.submit` on one runtime session (treat missing key as unsupported, not true).
2. `profiles.list` → roster.
3. Optional probe `groups.capabilities` **must not** set `groups: true`. Record `groupsProtocolSeen` only in adapter memory for later waves.
4. `projectHermesCapabilities` starts every flag false. Wave 2 may set `messageAgent`, `approvals`, `adoptMint` only after the corresponding fixture/live path succeeds.

New flags (append; do not reorder existing Wave 1 keys until tests are updated in the same commit):

```ts
export const HERMES_CAPABILITY_KEYS = [
  "roster",
  "canonicalChat",
  "send",
  "finalResponse",
  "events",
  "stop",
  "routinesRead",
  "messageAgent",
  "groups",
  "crossMachine",
  "queueing",
  "steer",
  "attachments",
  "adoptMint",
  "approvals",
  "exclusiveSubmit",
] as const;
```

`server/provider-catalog.ts` and `/api/instances` `capabilities.hermesBot.capabilities` must grow the same keys. iOS `InstanceCapabilities` does **not** need them; the phone already ignores unknown nested JSON.

### Event normalization

Map only these TUI events onto existing `RuntimeEvent` (`server/contracts.ts`):

| Hermes TUI | V Bot `RuntimeEvent` | Rule |
| --- | --- | --- |
| `message.start` | `turn.started` / `session.started` (sessionId null) | already Wave 1 |
| `message.delta` | `content.delta` `assistant_text` | already Wave 1 |
| `message.complete` | one `item.completed` `assistant_text` + one `turn.completed` | already Wave 1 |
| tool start (`tool` / function name `message_agent`) | `item.started` `tool` + comm intercept | Wave 2 |
| tool complete | `item.completed` `tool` | Wave 2 |
| `approval.pending` / approval ask event | `request.opened` `permission` | Wave 2; `summary` is explainer-safe text only |
| approval resolved | `request.resolved` | Wave 2 |
| `btw.complete`, `background.complete`, group events | drop | unsupported |

`RuntimeEventBase.raw` may hold `{ source: "hermes-tui", payload: { type } }` with **no** session ids, paths, or prompt text.

### Source attribution

Internal (hub-only) envelope for comm projection:

```ts
export type HermesCommPlane = "vbot" | "hermesMessageAgent";

export interface HermesCommAttribution {
  plane: HermesCommPlane;
  fromBotId: string;
  toBotId: string;
  /** SHA-256 hex of from+to+turnId+normalized body; never a Hermes id */
  deliveryKey: string;
}
```

Wire: keep existing `Message.comm` (`groupId`, `withBotId`, `withName`, `withColor`). Add optional additive `plane?: "vbot" | "hermesMessageAgent"` on `comm`. iOS `CommChip` must decode it optionally; `CommActivityPresentation` ignores unknown values. Do not put Hermes profile slugs on the wire when a V Bot bot id exists.

Tool chip titles stay the current English strings (`Messaged @Name` / `Message from @Name`) so `CommActivityPresentation.shouldSuppressNarration` keeps working.

### Recursion, budget, replay

| Control | Value | Enforcement |
| --- | --- | --- |
| V Bot `ask_bot` depth | already 1 (no agents tool on the peer) | keep |
| Hermes `message_agent` → V Bot `ask_bot` loop | depth 1 | if the inbound plane is `hermesMessageAgent`, do not attach V Bot `agents` MCP even if the bot is unbound on a later hop (bound bots already skip MCP) |
| `message_agent` projections per V Bot turn | max 4 | drop extras with `item.completed` tool `ok: false` title `too many teammate messages` |
| Body cap | 16000 chars (Hermes `MESSAGE_MAX_CHARS`) | truncate is a failure, not silent clip |
| Cross-machine / `peer/agent` targets | refuse | `messageAgent` stays local-hub only; `crossMachine` remains false |
| Replay | memory set of `deliveryKey` for 24h in-process; not persisted | SSE reconnect and gateway restart must not duplicate chips |
| Self-target | refuse | same as V Bot self-delegation |

### Secret isolation

Unchanged Wave 1 allowlist plus: comm intercept stores only V Bot bot ids and redacted chip titles. Approval summaries run through `server/approval-explainer.ts` (display-only). Never forward `model.save_key`, MCP API keys, or `HERMES_HOME`.

### Adopt-before-mint identity

Under the existing per-profile `AsyncLock`:

1. Exact hidden title lookup.
2. `present` → resume resolved id (Wave 1).
3. `unknown` → typed error; **no create**.
4. `absent` → `session.create` with `{ profile, title: "Bot Chat", hidden: true, source: "tui" }` (or omit source if the pin treats empty as a non-deny-listed source — tests must assert the created row's `source` is not `kanban`/`tool`).
5. If create returns no durable id, fail `malformed_response`.
6. `session.set_hidden` if the row is not hidden.
7. Exact lookup again. Must be `present` with title `Bot Chat`. If `absent`/`unknown`/duplicate rows → `malformed_response`, **do not create a second chat**.
8. Only then `session.resume` + `prompt.submit`.
9. Set `adoptMint: true` after one successful mint in the fixture. Production still mints only when absent.

Durable/runtime ids stay memory-only. Bindings still store only `{ adapter, profile, canonicalTitle, bindingVersion }`.

### Compatibility with existing iOS

- Pairing, SSE, transcripts, approvals, Computer/VM, hub messaging, Grok engine picker remain.
- `GET /api/bots` may add optional `composer: { queueing, steer, stop }` when the bot is Hermes-bound. Omitted = today's `VBotMutationRouting` (OpenMaus or Grok).
- `CommChip.plane` optional. Older phones ignore it.
- Do not require iOS to understand `capabilities.hermesBot`.
- Do not hide mascots, rooms list, or Computer for unbound bots.

---

## File map

Create:

- `server/engines/hermes-events.ts` — TUI event → `RuntimeEvent` + comm candidates
- `server/engines/hermes-events.test.ts`
- `server/engines/hermes-comms.ts` — deliveryKey, budget, plane, local target resolve
- `server/engines/hermes-comms.test.ts`
- `ios/Tests/CompanionCoreTests/HermesComposerPolicyTests.swift`

Modify:

- `server/engines/contracts.ts`, `contracts.test.ts`
- `server/engines/discovery.ts`, `discovery.test.ts`
- `server/engines/hermes.ts`, `hermes-adapter.test.ts`
- `server/engines/index.ts`, `index.test.ts`
- `server/testing/fake-hermes-tui-gateway.ts`
- `server/engines/hermes-live-fixture.test.ts`
- `server/hermes-groups.ts`, `hermes-groups.test.ts`
- `server/comms-visibility.ts`, `comms-visibility.test.ts`
- `server/index.ts`, `server/index.hermes-adapter.test.ts`
- `server/provider-catalog.ts` (and its test if it snapshots keys)
- `ios/Sources/CompanionCore/Models.swift` (`Bot.composer`, `CommChip.plane`)
- `ios/Sources/CompanionCore/ComposerActionPolicy.swift` (per-bot override helper)
- `ios/App/ChatView.swift` (prefer `bot.composer`)
- `ios/Tests/CompanionCoreTests/ComposerActionPolicyTests.swift`
- `docs/hermes-adapter.md`, `docs/v-bot-architecture.md`

Do not modify `server/vbot-engine-sync.ts`, `server/drivers/acp/hermes.ts`, companion pairing routes, or Hermes source.

---

### Task 1: Capability negotiation v2

**Files:**
- Modify: `server/engines/contracts.ts`, `server/engines/contracts.test.ts`, `server/engines/discovery.ts`, `server/engines/discovery.test.ts`, `server/engines/hermes.ts`, `server/engines/hermes-adapter.test.ts`, `server/testing/fake-hermes-tui-gateway.ts`, `server/provider-catalog.ts`, `server/engines/index.ts`
- Test: those `*.test.ts` files

**Interfaces:**
- Consumes: Wave 1 `HermesCapabilityFlags`, `HermesGatewayClient.request`
- Produces: expanded flags; `exclusiveSubmit` true only when `gateway.capabilities.per_session_exclusive_submit === true`

- [ ] **Step 1: Write the failing test**

```ts
it("turns exclusiveSubmit on only after gateway.capabilities proves per_session_exclusive_submit", () => {
  expect(projectHermesCapabilities({ exclusiveSubmit: true }).exclusiveSubmit).toBe(false);
  expect(projectHermesCapabilities({
    exclusiveSubmit: true,
    provenExclusiveSubmit: true,
  } as never).exclusiveSubmit).toBe(false);
});

it("lists the Wave 2 keys after the Wave 1 keys", () => {
  expect(HERMES_CAPABILITY_KEYS.slice(-3)).toEqual([
    "adoptMint",
    "approvals",
    "exclusiveSubmit",
  ]);
});
```

Prefer a typed readiness field over `as never`:

```ts
export interface HermesReadiness {
  // ...existing Wave 1 fields...
  adoptMint?: boolean;
  approvals?: boolean;
  exclusiveSubmit?: boolean;
}
```

`projectHermesCapabilities` allowlists Wave 2 keys the same way Wave 1 allowlisted send/stop: only `exclusiveSubmit` is in the supported set for this task; `adoptMint` / `approvals` / `messageAgent` stay forced false until later tasks.

Update `contracts.test.ts` expected object to include the three new keys as `false` even when readiness claims `true`, except this task should allow `exclusiveSubmit` when `readiness.exclusiveSubmit === true`.

Adapter test:

```ts
it("calls gateway.capabilities after gateway.ready and refuses exclusiveSubmit when omitted", async () => {
  const child = new FakeHermesProcess();
  const engine = createHermesBotEngine({ spawn: () => child });
  const discover = engine.discover();
  child.ready();
  const caps = await child.awaitMethod("gateway.capabilities");
  expect(caps.params).toEqual({});
  child.frame({ jsonrpc: "2.0", id: caps.id, result: {} });
  child.frame({
    jsonrpc: "2.0",
    id: (await child.awaitMethod("profiles.list")).id,
    result: { profiles: [{ name: "default" }] },
  });
  const discovery = await discover;
  expect(discovery.capabilities.exclusiveSubmit).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901
./node_modules/.bin/vitest run \
  server/engines/contracts.test.ts \
  server/engines/discovery.test.ts \
  server/engines/hermes-adapter.test.ts
```

Expected: FAIL on missing keys / missing `gateway.capabilities` call.

- [ ] **Step 3: Write minimal implementation**

After `gateway.ready`, call `gateway.capabilities`. If `result.per_session_exclusive_submit === true`, set `readiness.exclusiveSubmit = true`. Missing/false/malformed → leave false; overlapping sends already throw `upstream_error` in Wave 1 when a runtime exists.

Extend the fake gateway to answer `gateway.capabilities` with `{ per_session_exclusive_submit: true }` by default so Wave 1 send tests stay green.

Update `unavailableDescription` in `server/engines/index.ts` and `provider-catalog.ts` nested capabilities with the three new booleans defaulting false.

- [ ] **Step 4: Run tests to verify they pass**

```bash
./node_modules/.bin/vitest run \
  server/engines/contracts.test.ts \
  server/engines/discovery.test.ts \
  server/engines/hermes-adapter.test.ts \
  server/engines/index.test.ts \
  server/index.hermes-adapter.test.ts
./node_modules/.bin/tsc -b && ./node_modules/.bin/tsc -p tsconfig.server.json
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/engines/contracts.ts server/engines/contracts.test.ts \
  server/engines/discovery.ts server/engines/discovery.test.ts \
  server/engines/hermes.ts server/engines/hermes-adapter.test.ts \
  server/engines/index.ts server/testing/fake-hermes-tui-gateway.ts \
  server/provider-catalog.ts
git commit -m "$(cat <<'EOF'
feat(vbot): negotiate Hermes gateway capabilities without enabling groups

EOF
)"
```

---

### Task 2: Adopt-before-mint canonical Bot Chat

**Files:**
- Modify: `server/engines/hermes.ts`, `server/engines/hermes-adapter.test.ts`, `server/testing/fake-hermes-tui-gateway.ts`, `server/engines/discovery.ts` (only if a `normalizeCreatedSession` helper is needed)
- Test: `server/engines/hermes-adapter.test.ts`

**Interfaces:**
- Consumes: `lookupCanonicalOutsideLock`, `session.create` at pin `methods_session.py`
- Produces: `adoptCanonical` behavior inside `send()` when lookup is `absent`; `readiness.adoptMint = true` after proven mint

Create params (exact):

```ts
{
  profile: resolvedProfile,
  title: "Bot Chat",
  hidden: true,
  source: "tui",
}
```

- [ ] **Step 1: Write the failing test**

```ts
it("mints Bot Chat only after a successful empty hidden lookup, then re-resolves", async () => {
  const child = new FakeHermesProcess();
  const engine = createHermesBotEngine({ spawn: () => child });
  await engine.discover(); // drive ready + capabilities + profiles as existing tests do

  const send = engine.send({
    profile: "coder",
    text: "hello",
    threadId: "thr",
    turnId: "turn-1",
  });

  const list1 = await child.awaitMethod("session.list");
  expect(list1.params).toEqual({
    profile: "coder",
    title: "Bot Chat",
    include_hidden: true,
    limit: 200,
  });
  child.frame({ jsonrpc: "2.0", id: list1.id, result: { sessions: [] } });

  const created = await child.awaitMethod("session.create");
  expect(created.params).toEqual({
    profile: "coder",
    title: "Bot Chat",
    hidden: true,
    source: "tui",
  });
  child.frame({ jsonrpc: "2.0", id: created.id, result: { session_id: "rt-new" } });

  const list2 = await child.awaitMethod("session.list");
  child.frame({
    jsonrpc: "2.0",
    id: list2.id,
    result: {
      sessions: [{
        id: "root-new",
        resolved_id: "tip-new",
        title: "Bot Chat",
        hidden: true,
        source: "tui",
      }],
    },
  });

  const resume = await child.awaitMethod("session.resume");
  expect(resume.params.session_id).toBe("tip-new");
  child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "rt-live" } });

  const submit = await child.awaitMethod("prompt.submit");
  expect(submit.params.session_id).toBe("rt-live");
  child.frame({ jsonrpc: "2.0", id: submit.id, result: { ok: true } });
  await send;
});

it("does not mint when hidden lookup fails", async () => {
  // session.list RPC error → unknown → send throws; assert no session.create
});

it("does not mint a second chat when post-create lookup is unknown", async () => {
  // create succeeds, second list malformed → throw malformed_response, no second create
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
./node_modules/.bin/vitest run server/engines/hermes-adapter.test.ts
```

Expected: FAIL because `send` still throws on `absent`.

- [ ] **Step 3: Write minimal implementation**

In `lookup`/`send` lock:

```ts
if (canonical.state === "absent") {
  await this.client.request("session.create", {
    profile: resolvedProfile,
    title: "Bot Chat",
    hidden: true,
    source: "tui",
  });
  canonical = await this.lookupCanonicalOutsideLock(resolvedProfile);
  if (canonical.state !== "present") {
    throw new HermesEngineError("malformed_response");
  }
  this.readiness.adoptMint = true;
}
```

Never pass create params from user text. If `session.create` throws, map through `asHermesError` and do not loop.

Fake gateway: empty list on first `session.list` for a test flag; after create, return one hidden `Bot Chat`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
./node_modules/.bin/vitest run \
  server/engines/hermes-adapter.test.ts \
  server/engines/hermes-live-fixture.test.ts \
  server/index.hermes-adapter.test.ts
./node_modules/.bin/tsc -b && ./node_modules/.bin/tsc -p tsconfig.server.json
```

Expected: PASS. Live fixture that starts with an existing chat must still not call `session.create`.

- [ ] **Step 5: Commit**

```bash
git add server/engines/hermes.ts server/engines/hermes-adapter.test.ts \
  server/testing/fake-hermes-tui-gateway.ts server/engines/discovery.ts
git commit -m "$(cat <<'EOF'
feat(vbot): adopt-before-mint missing Hermes Bot Chat

EOF
)"
```

---

### Task 3: Dual-plane comm intercept and 1:1 DM exception

**Files:**
- Create: `server/engines/hermes-comms.ts`, `server/engines/hermes-comms.test.ts`, `server/engines/hermes-events.ts`, `server/engines/hermes-events.test.ts`
- Modify: `server/hermes-groups.ts`, `server/hermes-groups.test.ts`, `server/comms-visibility.ts`, `server/comms-visibility.test.ts`, `server/engines/hermes.ts`, `server/index.ts`

**Interfaces:**
- Consumes: `getOrCreateChannel`, `mirrorExchange`; Hermes tool event name `message_agent`
- Produces: `projectHermesMessageAgent`, `hermesPairChannelError` (null for 1:1 DM)

```ts
export function hermesPairChannelError(
  memberIds: readonly string[],
  dm: boolean,
  loadBindings: HermesBindingLoader = loadHermesBindings,
): HermesEngineError | null {
  if (dm && memberIds.length === 2) return null;
  return hermesGroupMembershipError(memberIds, loadBindings);
}
```

`getOrCreateChannel` uses `hermesPairChannelError(..., true)`. Room create/PATCH and non-DM `createGroup` keep `hermesGroupMembershipError`.

```ts
export function deliveryKey(input: {
  fromBotId: string;
  toBotId: string;
  turnId: string;
  text: string;
}): string {
  return createHash("sha256")
    .update(`${input.fromBotId}\0${input.toBotId}\0${input.turnId}\0${input.text}`)
    .digest("hex");
}

export function resolveLocalTarget(target: string, roster: ReadonlyMap<string, string>): string | null {
  // roster: hermes handle/slug -> vbot botId
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target)) return null; // refuse peer/agent
  return roster.get(target.toLowerCase()) ?? null;
}
```

- [ ] **Step 1: Write the failing tests**

`server/hermes-groups.test.ts`:

```ts
it("allows a 1:1 dm channel for Hermes-bound bots", () => {
  expect(hermesPairChannelError(["bot-a", "bot-b"], true, () => ({
    state: "available",
    value: new Map([["bot-a", binding]]),
  }))).toBeNull();
});

it("still rejects multi-member rooms for Hermes-bound bots", () => {
  expect(hermesPairChannelError(["bot-a", "bot-b", "bot-c"], false, () => ({
    state: "available",
    value: new Map([["bot-a", binding]]),
  }))?.code).toBe("groups_unavailable");
});
```

`server/engines/hermes-comms.test.ts`:

```ts
it("refuses peer/agent and oversize bodies", () => {
  expect(resolveLocalTarget("spark/researcher", new Map([["researcher", "bot-1"]]))).toBeNull();
  expect(normalizeMessageAgentBody("x".repeat(16001))).toMatchObject({ ok: false });
});

it("hashes delivery keys without Hermes session ids", () => {
  const key = deliveryKey({ fromBotId: "a", toBotId: "b", turnId: "t", text: "hi" });
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toMatch(/session|HERMES|Bot Chat/i);
});
```

`server/engines/hermes-events.test.ts`: tool payload `{ name: "message_agent", arguments: { target: "researcher", message: "ship it" } }` → comm candidate with `plane: "hermesMessageAgent"`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
./node_modules/.bin/vitest run \
  server/hermes-groups.test.ts \
  server/engines/hermes-comms.test.ts \
  server/engines/hermes-events.test.ts \
  server/comms-visibility.test.ts
```

Expected: FAIL on missing exports / still-blocked DM.

- [ ] **Step 3: Write minimal implementation**

Implement the helpers. Change `getOrCreateChannel` to allow DM. In `HermesBotAdapter.handleGatewayEvent`, when a tool event names `message_agent`, emit `item.started`/`item.completed` and call a registry-provided `onComm` callback (do not import Store into `hermes.ts`).

`server/engines/index.ts` / `server/index.ts` wiring:

```ts
onComm: (candidate) => {
  const from = store.bot(candidate.fromBotId);
  const to = store.bot(candidate.toBotId);
  if (!from || !to) return;
  const channel = getOrCreateChannel(store, from, to);
  mirrorExchange({ store, broadcast }, from, to, candidate.text, channel);
}
```

Build `handle → botId` from the binding sidecar plus roster handles (`hermes` default → profile `default`). Unbound Hermes profiles: sender chip only, `comm` omitted (`mirrorExchange` already supports `channel` undefined — keep that).

V Bot `ask_bot` / `delegate_bot` automatically gain 1:1 channels for Hermes-bound bots via the same `getOrCreateChannel` change. Set `comm.plane` to `"vbot"` there and `"hermesMessageAgent"` on the Hermes intercept. Additive field on Store `Message.comm`.

Turn `messageAgent: true` only after the adapter has projected one fixture `message_agent` tool event.

- [ ] **Step 4: Run tests to verify they pass**

```bash
./node_modules/.bin/vitest run \
  server/hermes-groups.test.ts \
  server/engines/hermes-comms.test.ts \
  server/engines/hermes-events.test.ts \
  server/comms-visibility.test.ts \
  server/delegations.test.ts \
  server/index.hermes-adapter.test.ts
```

Expected: PASS. `delegations.test.ts` Hermes case that expected group rejection must be updated **only** for 1:1 DM; keep rejection for room membership.

- [ ] **Step 5: Commit**

```bash
git add server/engines/hermes-comms.ts server/engines/hermes-comms.test.ts \
  server/engines/hermes-events.ts server/engines/hermes-events.test.ts \
  server/hermes-groups.ts server/hermes-groups.test.ts \
  server/comms-visibility.ts server/comms-visibility.test.ts \
  server/engines/hermes.ts server/engines/index.ts server/index.ts \
  server/delegations.test.ts
git commit -m "$(cat <<'EOF'
feat(vbot): project Hermes and V Bot messaging into comm activity

EOF
)"
```

---

### Task 4: Recursion, budget, and replay controls

**Files:**
- Modify: `server/engines/hermes-comms.ts`, `server/engines/hermes-comms.test.ts`, `server/engines/hermes.ts`
- Test: `server/engines/hermes-comms.test.ts`, `server/index.hermes-adapter.test.ts`

**Interfaces:**
- Consumes: `deliveryKey`, comm callback from Task 3
- Produces: `HermesCommBudget.tryConsume(turnId)` → allow | `too_many`; `HermesCommReplay.seen(deliveryKey)`

```ts
export class HermesCommBudget {
  constructor(private readonly maxPerTurn = 4) {}
  private counts = new Map<string, number>();
  tryConsume(turnId: string): boolean {
    const next = (this.counts.get(turnId) ?? 0) + 1;
    if (next > this.maxPerTurn) return false;
    this.counts.set(turnId, next);
    return true;
  }
  releaseTurn(turnId: string): void {
    this.counts.delete(turnId);
  }
}

export class HermesCommReplay {
  private readonly seen = new Set<string>();
  remember(deliveryKey: string): boolean {
    if (this.seen.has(deliveryKey)) return false;
    this.seen.add(deliveryKey);
    return true;
  }
}
```

- [ ] **Step 1: Write the failing tests**

```ts
it("drops the fifth message_agent on the same turn", () => {
  const budget = new HermesCommBudget(4);
  expect([1, 2, 3, 4].every((i) => budget.tryConsume("t"))).toBe(true);
  expect(budget.tryConsume("t")).toBe(false);
});

it("does not re-project an identical deliveryKey", () => {
  const replay = new HermesCommReplay();
  const key = deliveryKey({ fromBotId: "a", toBotId: "b", turnId: "t", text: "hi" });
  expect(replay.remember(key)).toBe(true);
  expect(replay.remember(key)).toBe(false);
});
```

Adapter: two identical tool events → one `mirrorExchange`. Inbound `hermesMessageAgent` must not call V Bot agents MCP (already true for bound bots; assert `startTurn` still skips integrations).

- [ ] **Step 2: Run tests to verify they fail**

```bash
./node_modules/.bin/vitest run server/engines/hermes-comms.test.ts
```

Expected: FAIL until budget/replay exist and are wired.

- [ ] **Step 3: Write minimal implementation**

Wire budget/replay in the comm callback path. On drop, emit `item.completed` `{ itemType: "tool", ok: false }` with title `too many teammate messages` (no Hermes text). Clear budget on `turn.completed`.

Refuse `target` matching the sender handle.

- [ ] **Step 4: Run tests to verify they pass**

```bash
./node_modules/.bin/vitest run \
  server/engines/hermes-comms.test.ts \
  server/engines/hermes-adapter.test.ts \
  server/index.hermes-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/engines/hermes-comms.ts server/engines/hermes-comms.test.ts \
  server/engines/hermes.ts server/index.ts
git commit -m "$(cat <<'EOF'
feat(vbot): cap and dedupe Hermes message_agent projections

EOF
)"
```

---

### Task 5: Normalize tools and approvals onto existing cards

**Files:**
- Modify: `server/engines/hermes-events.ts`, `server/engines/hermes-events.test.ts`, `server/engines/hermes.ts`, `server/engines/hermes-adapter.test.ts`, `server/testing/fake-hermes-tui-gateway.ts`, `server/index.ts`
- Test: those tests plus existing approval fold in `server/index.ts` (`request.opened` case ~1386)

**Interfaces:**
- Consumes: TUI approval events; `approval.respond` at `methods_prompt.py`
- Produces: `request.opened` / `request.resolved`; `HermesBotEngine.respondToApproval`

Pin respond:

```ts
await client.request("approval.respond", {
  session_id: runtime.runtimeId,
  request_id: input.requestId,
  choice: input.choice === "allow" ? "once" : "deny",
});
```

Use `"once"` not `"always"` (V Bot broadening stays a separate explicit step). Map V Bot `allowed-once` → `once`, `rejected` → `deny`.

- [ ] **Step 1: Write the failing tests**

```ts
it("projects a Hermes approval ask as request.opened without paths or argv", async () => {
  // drive a running turn, then child.emit approval event
  const opened = events.find((e) => e.type === "request.opened");
  expect(opened).toMatchObject({
    requestType: "permission",
    tool: "shell",
    summary: "Run a command",
  });
  expect(JSON.stringify(opened)).not.toMatch(/HERMES_HOME|\/Users\/|session-/);
});

it("answers through approval.respond with once|deny", async () => {
  await engine.respondToApproval({
    profile: "coder",
    requestId: "req-1",
    choice: "allow",
  });
  const rpc = await child.awaitMethod("approval.respond");
  expect(rpc.params.choice).toBe("once");
  expect(rpc.params.request_id).toBe("req-1");
});
```

Hub test: bound bot's `request.opened` folds into the same Store card as Codex/ACP; answering `/api` permission route calls `respondToApproval` instead of `ProviderAdapter.respondToRequest`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
./node_modules/.bin/vitest run \
  server/engines/hermes-events.test.ts \
  server/engines/hermes-adapter.test.ts \
  server/index.hermes-adapter.test.ts
```

Expected: FAIL; events currently ignored except `message.*`.

- [ ] **Step 3: Write minimal implementation**

Parse TUI frames in `hermes-events.ts` only. Safe summary: if the payload looks like a shell command, run it through `explainCommand` from `server/approval-explainer.ts` and use `explanation.summary`; otherwise a fixed `"Hermes wants approval"`. Never copy raw command strings that contain newlines or process substitution into `summary` (explainer already fail-closes those).

Set `readiness.approvals = true` after one projected ask.

If no live runtime, `respondToApproval` throws `gateway_unavailable` (stale card → existing unavailable outcome).

- [ ] **Step 4: Run tests to verify they pass**

```bash
./node_modules/.bin/vitest run \
  server/engines/hermes-events.test.ts \
  server/engines/hermes-adapter.test.ts \
  server/index.hermes-adapter.test.ts \
  server/approval-explainer.test.ts
./node_modules/.bin/tsc -b && ./node_modules/.bin/tsc -p tsconfig.server.json
```

Expected: PASS. Explainer tests remain 137+ green.

- [ ] **Step 5: Commit**

```bash
git add server/engines/hermes-events.ts server/engines/hermes-events.test.ts \
  server/engines/hermes.ts server/engines/hermes-adapter.test.ts \
  server/testing/fake-hermes-tui-gateway.ts server/index.ts \
  server/index.hermes-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(vbot): broker Hermes approvals through existing request cards

EOF
)"
```

---

### Task 6: Additive iOS composer honesty

**Files:**
- Modify: `server/index.ts` (bot JSON projection), `ios/Sources/CompanionCore/Models.swift`, `ios/Sources/CompanionCore/ComposerActionPolicy.swift`, `ios/App/ChatView.swift`, `ios/Tests/CompanionCoreTests/ComposerActionPolicyTests.swift`
- Create: `ios/Tests/CompanionCoreTests/HermesComposerPolicyTests.swift`
- Test: Swift tests + `server/index.hermes-adapter.test.ts`

**Interfaces:**
- Consumes: binding sidecar; existing `EngineComposerCapabilities`
- Produces: optional `Bot.composer` on GET `/api/bots`

Hub projection (do **not** persist on `BotRecord`):

```ts
function projectBotComposer(botId: string): { queueing: false; steer: false; stop: true } | undefined {
  const bindings = loadHermesBindings();
  if (bindings.state !== "available") return undefined;
  if (!bindings.value.has(botId)) return undefined;
  return { queueing: false, steer: false, stop: true };
}
```

Unavailable sidecar: omit `composer` (phone keeps global routing) while send/steer still fail closed server-side.

Swift:

```swift
public struct BotComposerCapabilities: Codable, Hashable, Sendable {
    public var queueing: Bool
    public var steer: Bool
    public var stop: Bool
}

// on Bot:
public var composer: BotComposerCapabilities? = nil
```

```swift
public enum VBotMutationRouting {
    public static func composerCapabilities(
        for sync: VBotEngineSync?,
        bot: Bot? = nil
    ) -> EngineComposerCapabilities {
        if let composer = bot?.composer {
            return EngineComposerCapabilities(
                queueing: composer.queueing,
                steer: composer.steer,
                stop: composer.stop
            )
        }
        // existing OpenMaus vs reconstructed path unchanged
        return composerCapabilities(for: sync)
    }
}
```

`ChatView.composerCapabilities` passes `session.selectedBot`.

Optional `CommChip.plane: String? = nil`.

- [ ] **Step 1: Write the failing tests**

```swift
@Test("Hermes-bound composer keeps stop and refuses steer")
func hermesBoundComposer() {
    let caps = EngineComposerCapabilities(queueing: false, steer: false, stop: true)
    #expect(ComposerActionPolicy.action(busy: true, draft: "", defaultMode: .steer, capabilities: caps) == .stop)
    #expect(ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .steer, capabilities: caps) == .send(.auto))
    #expect(ComposerActionPolicy.deliveryMode(defaultMode: .steer, capabilities: caps) == .auto)
}
```

Hub: `GET /api/bots` for a seeded Hermes binding includes `composer.stop === true` and does not include profile/session fields.

Decode fixture: extra `plane` on `comm` does not drop the message.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901
./node_modules/.bin/vitest run server/index.hermes-adapter.test.ts
cd ios && swift test --filter HermesComposerPolicyTests --filter ComposerActionPolicyTests
```

Expected: Swift filter FAIL (missing type / still using global reconstructed-or-openmaus path). Hub FAIL on missing `composer`.

- [ ] **Step 3: Write minimal implementation**

Project `composer` only for bound bots. Extend `CommChip` with optional `plane`. Do not change `VBotPrimaryEngine`, Settings engine picker, or Computer VM eligibility (`Instance.supportsLocalVmDestination` stays false for unknown Hermes computer MCP — missing `computerMcp` currently means unknown/allow; **do not** set `computerMcp: true` for `hermesBot`). If a bound bot currently appears Local-VM-eligible via missing capabilities, set advertised `computerMcp: false` and `localComputerMcp: false` on the Hermes instance snapshot in the same change so Computer stays the existing V Bot fleet, not Hermes `computer_use`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901
./node_modules/.bin/vitest run server/index.hermes-adapter.test.ts server/provider-catalog.test.ts
cd ios && swift test
```

Expected: PASS. Unbound OpenMaus composer tests still show Steer/Queue.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/index.hermes-adapter.test.ts server/provider-catalog.ts \
  ios/Sources/CompanionCore/Models.swift \
  ios/Sources/CompanionCore/ComposerActionPolicy.swift \
  ios/App/ChatView.swift \
  ios/Tests/CompanionCoreTests/ComposerActionPolicyTests.swift \
  ios/Tests/CompanionCoreTests/HermesComposerPolicyTests.swift
git commit -m "$(cat <<'EOF'
feat(ios): honor per-bot Hermes composer capabilities without changing Grok UI

EOF
)"
```

---

### Task 7: Fixture, docs, and release gate

**Files:**
- Modify: `server/testing/fake-hermes-tui-gateway.ts`, `server/engines/hermes-live-fixture.test.ts`, `docs/hermes-adapter.md`, `docs/v-bot-architecture.md`
- Test: live fixture + docs assertions already in `hermes-live-fixture.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6
- Produces: documented Wave 2 boundary; fixture covering mint, `message_agent` intercept, approval, exclusive submit

- [ ] **Step 1: Write the failing live-fixture and doc assertions**

Extend `hermes-live-fixture.test.ts` "documents Bot Chat…" test to require the strings `adopt-before-mint`, `message_agent`, `per_session_exclusive_submit`, `1:1`, and `prompt.btw`.

Add a fixture scenario:

1. Profile with **no** Bot Chat → first send calls `session.create` once → second send does not.
2. Tool event `message_agent` to another bound profile → one activity chip each side, `comm.plane === "hermesMessageAgent"`, no Hermes ids in `/api/bots/:id/messages`.
3. Approval event → card → respond `once`.
4. `groups.capabilities` if probed does not set `capabilities.groups true`.

- [ ] **Step 2: Run the live fixture to verify it fails**

```bash
./node_modules/.bin/vitest run server/engines/hermes-live-fixture.test.ts
```

Expected: FAIL until docs and fixture flags exist.

- [ ] **Step 3: Write the fixture and docs**

Update `docs/hermes-adapter.md` title to Wave 2. Keep Wave 1 trust path. Add sections: pin `ab9866bc64`, negotiation, adopt-before-mint, dual-plane comms, 1:1 exception, approvals, composer projection, and the deferral table from this plan's matrix.

Append to `docs/v-bot-architecture.md`: Hermes is a first-party **adapter runtime**, not a `VBotPrimaryEngine`; iOS stays Grok-style; VM/fleet stay V Bot's.

Fake gateway: implement `gateway.capabilities`, `session.create`, `approval.respond`, and a test-only `message_agent` tool event.

- [ ] **Step 4: Run the release gate**

```bash
cd /Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901
./node_modules/.bin/vitest run \
  server/engines \
  server/index.hermes-adapter.test.ts \
  server/hermes-groups.test.ts \
  server/hermes-interrupt.test.ts \
  server/comms-visibility.test.ts \
  server/delegations.test.ts \
  server/routines.test.ts \
  server/provider-catalog.test.ts \
  server/vbot-engine-sync.test.ts \
  server/approval-explainer.test.ts \
  server/approval-reviewer.test.ts \
  server/bridge-approval.test.ts
./node_modules/.bin/tsc -b && ./node_modules/.bin/tsc -p tsconfig.server.json
node scripts/test-floor.mjs
cd ios && swift test
```

If `test-floor.mjs` or iOS has a pre-existing failure, record the exact command output and do not "fix" unrelated work.

Security grep on fixtures:

```bash
git grep -n -E 'HERMES_HOME|state\.db|session-root|session-tip|sk-|Bearer ' \
  server/index.hermes-adapter.test.ts \
  server/engines/hermes-live-fixture.test.ts \
  || true
```

Public JSON fixtures must not contain real home paths or tokens. Deterministic fixture ids (`session-root`) are allowed only inside the fake gateway module, not in `/api/*` expected bodies.

- [ ] **Step 5: Commit**

```bash
git add server/testing/fake-hermes-tui-gateway.ts \
  server/engines/hermes-live-fixture.test.ts \
  docs/hermes-adapter.md docs/v-bot-architecture.md
git commit -m "$(cat <<'EOF'
docs(vbot): document Hermes first-party Wave 2 adapter boundary

EOF
)"
```

---

## Later waves (do not implement here)

| Wave | Contents |
| --- | --- |
| 3 | Read-only `model.options` / effort mapping; `tools.list` / `skills.manage` / `cron.manage` list projected as existing V Bot settings **without** secret fields; optional Session search as in-turn tool chips only |
| 4 | Attachments/vision once a bytes contract matches V Bot share inbox; honest steer only if Hermes adds a history-mutating barge-in (not `prompt.btw`); cron mutate with adopt-before-mint deliver |
| 5 | Hermes `groups.*` / `bot_relay.*` as a **new** room protocol — requires iOS contract, identity, replay, and secret isolation designs of their own |
| never on phone | `model.save_key`, MCP OAuth/API keys, billing, raw SessionDB, Computer-as-Hermes-destination, `VBotPrimaryEngine: "hermes"` |

---

## Self-review

**Spec coverage:** Canonical Bot Chat, profiles, tools/MCP, skills, files/vision, approvals, streaming, sessions/search, goals/tasks, cron/routines, delegates, `message_agent`, groups/relay, stop/steer/queue, models/effort, setup/auth, computer/terminal, notifications, artifacts, and recovery each appear in the matrix with a class and wave. Wave 2 tasks implement only negotiation, mint, comm intercept, budget/replay, approvals, composer honesty, and docs.

**Placeholder scan:** No TBD/TODO/implement-later steps. Tests include concrete expected params.

**Type consistency:** `HermesCapabilityFlags` new keys `adoptMint` / `approvals` / `exclusiveSubmit` are used in Tasks 1, 2, 5, and 7. `hermesPairChannelError` is the only 1:1 exception. `deliveryKey` / `HermesCommPlane` are shared by Tasks 3–4. `Bot.composer` is optional and hub-projected.

**iOS compatibility:** Pairing, Grok primary engine, VM/fleet, transcripts, and existing comm rows stay. Steer remains a server 409 for Hermes even if an old phone omits `composer`.
