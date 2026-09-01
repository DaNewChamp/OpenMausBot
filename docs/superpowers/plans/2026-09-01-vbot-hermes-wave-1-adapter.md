# V Bot Hermes Wave 1 Bot Chat Adapter Implementation Plan

> **For implementation workers:** Execute this plan sequentially. Keep the change set
> in `/Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901` on
> `feat/vbot-hermes-adapter-0901`. Return files changed, checks run, pass/fail,
> and remaining risk after each task. Do not modify the Hermes source checkout.

## Goal

Add a narrow, hub-owned Hermes Bot Chat adapter. It discovers a local Hermes
installation and safe profile roster, resolves each profile's exact canonical
`(profile, "Bot Chat")` session, sends one turn through Hermes' loopback TUI
JSON-RPC gateway, streams optional deltas, persists the final answer through the
existing V Bot Store/SSE projector, and interrupts a running turn. Existing
OpenMaus/Grok/provider-instance behavior, iOS/companion wire contracts, and
Hermes' generic ACP driver remain unchanged.

## Non-goals / release boundary

Wave 1 is one local hub/runtime path only. It does **not** add account login,
pairing replacement, a second mobile transcript store, Hermes source changes,
raw SQLite reads, profile/session auto-import, canonical session creation,
`message_agent`, groups/rooms, peer/cross-machine relay, routine mutation,
attachments/vision, queueing/steer/fork/rewind, provider-secret UI, or a remote
Hermes runtime. Existing V Bot bots without a binding continue through their
stored `modelSelection.instanceId`; existing Hermes ACP instances continue to
use `server/drivers/acp/hermes.ts`.

## Source and seams inspected

- V Bot audit: `.superpowers/sdd/hermes-wave1-audit.md` (revision `ec75194`).
- V Bot runtime seams: `server/contracts.ts`, `server/config.ts`,
  `server/store.ts`, `server/index.ts`, `server/harness/registry.ts`,
  `server/harness/bus.ts`, `server/provider-catalog.ts`,
  `server/drivers/acp/hermes.ts`, and their focused tests.
- Hermes clean-room source: `/Users/Vincent/Github/hermes-agent` at tag
  `v2026.8.31` (`6e8f8418e6378eb2617e4de074e13dedd091b8af`). Read-only source
  contracts used by the fixture are `tui_gateway/entry.py`,
  `tui_gateway/methods_profiles.py`, `tui_gateway/methods_session.py`,
  `tui_gateway/methods_prompt.py`, `tui_gateway/transport.py`,
  `tools/bot_mode_probe.py`, `tools/bot_mode_dm.py`, `tools/bot_relay.py`,
  `cron/jobs.py`, and `hermes_cli/web_routers/cron.py`.
- `server/index.ts::startTurn` already performs busy checks, Store user-message
  append, transcript construction, activity ownership, dispatch, and event
  folding. `EventBus` accepts normalized `RuntimeEvent` values and writes the
  redacted per-thread NDJSON stream. Reuse these seams; do not create a second
  turn projector or engine framework.

## Global constraints

- Only change the V Bot worktree named above. Never edit, checkout, reset,
  stash, or clean `/Users/Vincent/Github/hermes-agent`; do not depend on its
  dirty `main` state, only on tag `v2026.8.31`.
- Keep Hermes Bot Mode behind a separate internal adapter/engine registry. Do
  not add Hermes to `VBotPrimaryEngine` in `server/vbot-engine-sync.ts`, do not
  alter `server/contracts.ts` public wire types, and do not replace or modify
  `HermesAgentDriver`'s ACP behavior.
- Use `HERMES_HOME` and the configured `hermes` executable only on the hub.
  The phone never receives Hermes tokens, auth files, environment values,
  executable/profile paths, session ids, raw stderr, query text, or JSON-RPC
  payloads. Provider/account setup remains Hermes' own setup flow; V Bot device
  pairing remains the authorization boundary.
- Child environment is allowlisted. Start from a copied environment, strip all
  V Bot workspace/provider credential variables with the existing
  `stripWorkspaceCredentialEnv` pattern, then keep only explicitly allowed
  Hermes runtime variables (`HERMES_HOME`, `HOME`/`USERPROFILE`, `PATH`, locale,
  and harmless terminal flags). Hermes reads its own auth store; never inject a
  V Bot API key into the child.
- Prompt text travels as JSON-RPC parameters. Do not shell-interpolate it. Do
  not scrape terminal output or implement a CLI one-shot fallback in this wave.
- Canonical identity is exact profile name plus title literal `Bot Chat`.
  `session.list` must pass `include_hidden: true`, exact `title`, and bounded
  `limit: 200`; deny `kanban` and `tool` sources. Keep durable `id` and
  compression `resolved_id` in the adapter request only; the ephemeral runtime
  id from `session.resume` is memory-only and is never put in Store,
  `resumeCursors`, JSON responses, logs, or config.
- Distinguish `absent` from `unknown/unavailable`. Missing, locked, corrupt, or
  unreadable state is never an empty roster/session/routine result. Failed
  binding writes leave the previous valid binding unchanged and never mint a
  canonical session or silently fall back to OpenMaus.
- Bindings store only V Bot id, validated Hermes profile slug, literal title,
  and schema version. Use a mode-0600 atomic sidecar under `DATA_DIR`; no
  profile paths, credentials, session ids, prompts, or provider payloads.
- Capability flags are affirmative. Wave 1 advertises only what the gateway
  proves: roster/canonical lookup/send/final response/events/stop when live;
  `messageAgent`, `groups`, `crossMachine`, `queueing`, `steer`,
  `attachments`, and routine read stay false unless their exact guarded path is
  proven. Generic ACP `agentsMcp` does not imply Hermes Bot Mode support.
- Preserve the existing Store/SSE sequence: append the V Bot user message,
  project optional deltas, persist one `assistant_text` item from
  `message.complete`, emit one terminal `turn.completed`, reset activity, and
  retain the binding on all failures. Do not duplicate Hermes history into V
  Bot transcripts.
- No account-login/pairing or iOS Swift changes. Do not add provider-secret
  settings. Do not change groups, routines, OpenMaus, Grok Reconstructed,
  generic ACP, or companion routes except for additive safe capability metadata
  already tolerated by the existing `/api/instances` projection.
- Follow repository hygiene: do not add dependencies without approval; no
  `--force`, `--no-verify`, or destructive cleanup; preserve unrelated dirty
  work. Run focused tests after each logic change and the full release gate
  before claiming completion.

## File map

### Task 1 — contracts, normalization, and fail-closed binding storage

Create:

- `server/engines/contracts.ts`
- `server/engines/discovery.ts`
- `server/engines/bindings.ts`
- `server/engines/contracts.test.ts`
- `server/engines/discovery.test.ts`
- `server/engines/bindings.test.ts`

No existing public contract file is changed in this task.

### Task 2 — loopback TUI gateway transport and canonical Bot Chat turn

Create:

- `server/engines/hermes.ts`
- `server/engines/hermes-adapter.test.ts`

The adapter may keep its small JSON-RPC process client in `hermes.ts`; do not
introduce a generalized provider framework. Test transport via dependency
injection (spawn/clock) so unit tests do not need a real Hermes account.

### Task 3 — hub integration, capability projection, compatibility

Create:

- `server/engines/index.ts`
- `server/engines/index.test.ts`
- `server/index.hermes-adapter.test.ts` (or focused additions to
  `server/index.test.ts` if the existing harness fixture is the safer seam)

Modify only as needed:

- `server/index.ts`
- `server/config.ts` (disabled-by-default, non-secret `vbot.hermes` metadata;
  preserve old config decode and save behavior)
- `server/harness/bus.ts` only if a tiny external-event attach helper is needed;
  otherwise publish adapter events directly with the existing `EventBus`.
- `server/provider-catalog.ts` only to type/project safe Hermes capability
  booleans; do not expose profile/session/path fields.

Do **not** modify `server/contracts.ts`, `server/store.ts` public JSON shapes,
`server/vbot-engine-sync.ts`, companion, iOS, `server/drivers/acp/hermes.ts`,
or existing OpenMaus/Grok paths.

### Task 4 — fixture, documentation, and release gate

Create:

- `server/testing/fake-hermes-tui-gateway.ts` (a deterministic child fixture;
  no secrets and no real Hermes state)
- `server/engines/hermes-live-fixture.test.ts`
- `docs/hermes-adapter.md`

Modify:

- `docs/v-bot-architecture.md` (append the accepted Wave 1 adapter boundary;
  do not rewrite existing engine sections)

## Task 1: Internal contracts, normalized discovery, and binding store

### Interfaces to produce

`server/engines/contracts.ts` is internal to the hub. Keep fields carrying
Hermes ids/path-like data out of any type exported from `server/contracts.ts`.
Use a shape equivalent to:

```ts
export type HermesCapabilityState = "available" | "unavailable";
export type HermesCanonicalState = "present" | "absent" | "unknown";

export interface HermesCapabilityFlags {
  roster: boolean;
  canonicalChat: boolean;
  send: boolean;
  finalResponse: boolean;
  events: boolean;
  stop: boolean;
  routinesRead: boolean;
  messageAgent: boolean;
  groups: boolean;
  crossMachine: boolean;
  queueing: boolean;
  steer: boolean;
  attachments: boolean;
}

export interface HermesBotBinding {
  adapter: "hermesBot";
  profile: string;             // validated slug, not a path
  canonicalTitle: "Bot Chat";
  bindingVersion: 1;
}

export interface HermesCanonicalChat {
  profile: string;
  title: "Bot Chat";
  rootSessionId: string;
  resolvedSessionId: string;
  messageCount: number;
  preview?: string;
}

export interface HermesRosterRow {
  profile: string;
  handle: string;
  displayName: string;
  description: string;
  model?: string;
  provider?: string;
  canonicalChat: HermesCanonicalState;
  availability: HermesCapabilityState;
}

export interface HermesDiscovery {
  state: HermesCapabilityState;
  reason?: "missing_cli" | "invalid_credentials" | "gateway_unavailable" |
    "state_unavailable" | "malformed_response" | "timeout";
  version?: string;
  authenticated?: boolean;
  capabilities: HermesCapabilityFlags;
  profiles: HermesRosterRow[];
}
```

Add a typed internal error carrying only the stable failure code and a safe
human message. Redact path, argv, raw stderr, provider payload, and query text
before constructing it.

`server/engines/discovery.ts` owns pure normalizers and validators:

- `normalizeProfileRows(payload)` maps Hermes `profiles.list` rows to bounded
  `HermesRosterRow` fields (`name`, `display_name`, `description`, `model`,
  `provider`) and never copies `path` or raw `ui_meta`.
- Default profile handle is exactly `hermes`; named profiles use their
  case-insensitive validated profile slug. Reject invalid/ambiguous handles as
  unavailable rather than guessing.
- `normalizeCanonicalLookup(payload, profile)` consumes the exact
  `session.list` response, preserves `id`/`resolved_id` internally, requires
  title `Bot Chat`, includes hidden rows, denies `kanban`/`tool`, and returns
  `present`, `absent` (`sessions: []`), or `unknown` (malformed/error).
- Sort profile rows deterministically by normalized profile name and bound text
  lengths before any projection.
- `projectHermesCapabilities(readiness)` starts all false and turns on only
  roster/canonicalChat/send/finalResponse/events/stop after the transport proves
  each operation. Keep `messageAgent`, `groups`, `crossMachine`, queueing,
  steer, attachments, and routines read false by default.

`server/engines/bindings.ts` owns `${DATA_DIR}/hermes-bindings.json` and exposes
small methods such as:

```ts
export type BindingStoreResult<T> =
  | { state: "available"; value: T }
  | { state: "unavailable"; code: "state_unavailable" | "malformed_response"; message: string };

export function loadHermesBindings(path?: string): BindingStoreResult<ReadonlyMap<string, HermesBotBinding>>;
export function setHermesBinding(botId: string, binding: HermesBotBinding, path?: string): BindingStoreResult<void>;
export function removeHermesBinding(botId: string, path?: string): BindingStoreResult<void>;
```

Decode a strict `{version: 1, bindings: Record<botId, HermesBotBinding>}`
sidecar, ensure parent directory mode `0700`, write atomically mode `0600`,
and preserve the old file if validation or replacement fails. A missing file is
an available empty *binding set* (legacy V Bot has no bindings); an unreadable
or malformed existing file is unavailable and must not be converted to `{}`.

### TDD steps

- [ ] **1.1 Write red tests first.** In the three new test files cover:
  - exact capability keys and all unsupported flags false;
  - profile normalization, default `hermes` handle, named profile slug
    validation, deterministic order, bounded text, and no path/raw metadata;
  - exact title lookup requiring hidden rows and limit 200; absent versus
    malformed/RPC/DB failure (`unknown`); denied `kanban`/`tool` rows;
  - root/resolved compression ids retained only in the internal result;
  - valid sidecar load/write, atomic mode `0600`, directory mode `0700`,
    schema/version validation, malformed existing sidecar -> unavailable,
    missing sidecar -> available empty set, failed mutation preserving prior
    bytes, and binding fields rejecting paths/session ids/alternate titles.

  Example red assertion:

  ```ts
  it("does not turn unreadable binding storage into an empty map", () => {
    writeFileSync(file, "{not-json", { mode: 0o600 });
    expect(loadHermesBindings(file)).toMatchObject({ state: "unavailable" });
  });
  ```

- [ ] **1.2 Run the focused tests and confirm they fail for missing modules.**

  ```bash
  pnpm vitest run \
    server/engines/contracts.test.ts \
    server/engines/discovery.test.ts \
    server/engines/bindings.test.ts
  ```

  Expected: collection/import failures because the new modules are not yet
  present. Do not weaken the tests to make an empty result pass.

- [ ] **1.3 Implement only the internal types, pure normalizers, strict decoder,
  and atomic binding store.** Keep the module independent of HTTP, iOS, Hermes
  imports, SQLite, and provider registry. Use `writeFileAtomic` and existing
  `DATA_DIR` conventions. Error messages contain only stable typed codes.

- [ ] **1.4 Run the focused tests to green and inspect the serialized sidecar.**

  ```bash
  pnpm vitest run \
    server/engines/contracts.test.ts \
    server/engines/discovery.test.ts \
    server/engines/bindings.test.ts
  ```

  Also run:

  ```bash
  pnpm typecheck
  ```

  Confirm the test sidecar contains only bot id/profile/title/version and no
  `state.db`, `HERMES_HOME`, path, token, prompt, or session id.

- [ ] **1.5 Commit the task-sized change.**

  ```bash
  git add server/engines
  git commit -m "feat(vbot): add Hermes Bot Chat contracts and safe bindings"
  ```

## Task 2: Loopback TUI gateway transport, canonical lookup, send, interrupt

### Transport contract

Implement `server/engines/hermes.ts` as a local process client with an injected
spawn/clock seam. Spawn the configured Hermes executable with `--tui` and
`stdio: ["pipe", "pipe", "pipe"]`; the process must identify itself by a
`gateway.ready` event and line-delimited JSON-RPC. Do not parse Ink/terminal
output. Correlate numeric JSON-RPC ids, keep asynchronous `event` frames separate
from responses, reject pending calls on close, and bound initialization, request,
and turn waits. A crashed child marks the adapter generation unavailable;
reconnect is explicit and bounded, not an implicit session remint.

The adapter implements the internal SPI:

```ts
export interface HermesBotEngine {
  discover(): Promise<HermesDiscovery>;
  resolveCanonical(profile: string): Promise<HermesCanonicalChat>;
  send(input: {
    profile: string;
    text: string;
    model?: string;
    cwd?: string;
    threadId: string;
    turnId: string;
  }): Promise<{ turnId: string }>;
  interrupt(profile: string, turnId?: string): Promise<void>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
}
```

Use an internal runtime map keyed by profile/gateway generation. The map stores
only the ephemeral runtime id and active V Bot thread/turn association; delete it
on terminal event, interrupt, timeout, child close, and adapter close.

### Exact Hermes calls

- Initialize once, then call `profiles.list` with `include_sessions: true` only
  for safe profile metadata. Do not project the returned `path`, `ui_meta`, or
  raw error strings.
- For every canonical send, call `session.list` with
  `{profile, title: "Bot Chat", include_hidden: true, limit: 200}`. Treat a
  successful empty list as `absent`; an RPC/DB/protocol failure as `unknown`.
  Do not call `session.create` or pass `--create-if-missing` in Wave 1.
- For a present row, call `session.resume` with `profile` and the durable
  `resolved_id` (falling back to `id`), retaining the returned runtime
  `session_id`/`session_key` only in memory. Never pass a Hermes durable id as
  `ProviderAdapter.resumeCursor`.
- Call `prompt.submit` with the runtime id and prompt text in JSON-RPC params.
  Parse `message.start`, optional `message.delta`, and authoritative
  `message.complete` (`payload.text`, status, usage). Emit normalized
  `RuntimeEvent` values with opaque server event ids; deltas are optional.
- Map `message.complete` to exactly one `item.completed` (`assistant_text`),
  then one `turn.completed` with `ok`, `stopReason`, and usage. Malformed/missing
  final text is `malformed_response`; do not persist guessed text.
- `session.interrupt` is the only turn mutation. It maps to one terminal
  cancellation/error event and clears the runtime map. `steer` is not implemented.

`readRoutines` must remain absent/false in this task unless a later task injects
an authenticated dashboard channel and validates its schema. Never read
`cron/jobs.py` storage from TypeScript and never scrape `hermes cron list`.

### TDD steps

- [ ] **2.1 Write red transport/adapter tests** in
  `server/engines/hermes-adapter.test.ts` using a fake process/clock seam. Cover:
  - JSON-RPC correlation with interleaved asynchronous events and bounded
    timeout; gateway-ready/protocol absence and child crash;
  - sanitized child env/argv (no V Bot credential variables, no profile path or
    prompt in logs/errors);
  - exact canonical title/hidden/limit lookup; absent versus unknown; denied
    sources; compression root/resolved id and resume of resolved id;
  - `session.resume` + `prompt.submit` + delta/complete projection, final text,
    usage, one terminal event, and runtime-id cleanup;
  - restart redoes title lookup (no runtime-id persistence), profile deletion or
    ambiguous handle preserves binding, and `session.interrupt` cancellation;
  - malformed final/event, auth error, timeout, nonzero exit, and safe typed
    diagnostics; all unsupported capability flags stay false.

- [ ] **2.2 Run the focused test and confirm red.**

  ```bash
  pnpm vitest run server/engines/hermes-adapter.test.ts
  ```

  Expected: import/implementation failures. The test must not launch a real
  Hermes account or read a user's `state.db`.

- [ ] **2.3 Implement the smallest process client and adapter.** Keep parsing and
  redaction local to `hermes.ts`, use one profile-scoped lock to serialize
  lookup/resume/send/interrupt, and make terminal handling idempotent. A child
  process failure is `gateway_unavailable`, never a signal to mint a new chat or
  use another provider.

- [ ] **2.4 Run adapter tests and typecheck to green.**

  ```bash
  pnpm vitest run server/engines/hermes-adapter.test.ts
  pnpm typecheck
  ```

- [ ] **2.5 Commit.**

  ```bash
  git add server/engines/hermes.ts server/engines/hermes-adapter.test.ts
  git commit -m "feat(vbot): transport Hermes Bot Chat over loopback TUI gateway"
  ```

## Task 3: Hub integration, capability projection, and compatibility

### Integration design

Implement `server/engines/index.ts` as a deliberately small registry: one
`HermesBotEngine` per configured runtime, explicit lifecycle (`discover`,
`describe`, `disposeAll`), and one event unsubscribe per engine. Its public
server-side methods are `forBinding(binding)`, `describe()` (safe state,
reason-code, capability booleans, and normalized roster only), and `disposeAll()`.
It consumes the existing Hermes provider instance's configured executable and
allowlisted environment without copying provider secrets. If no safe Hermes
runtime is configured, the registry is unavailable and makes no child process.

Add disabled-by-default, non-secret config metadata only when needed:

```ts
vbot: {
  primaryEngine?: "openmaus" | "grokReconstructed";
  hermes?: { enabled?: boolean; instanceId?: string };
}
```

Keep the existing default `hermes` instance and its `config.cli` seam. If
`server/config.ts` is extended, update the Zod schema/interface and include
`vbot` in the existing read-modify-write merge without accepting executable,
path, token, key, or environment fields. `enabled` must default false and
`instanceId` must be a bounded instance id (default `hermes`).

At server startup, create the separate engine registry after the normal
`ProviderRegistry` load, then discover once. At provider reload, detach Hermes
listeners, dispose its children, recreate from the new config, and rediscover.
Do not attach Hermes Bot Mode as a `ProviderInstance`; publish normalized events
to the existing `EventBus` with a fixed safe provider instance id such as the
configured Hermes instance id. Event fold, Store, activity, watchdog, routine
receipt, and SSE behavior remain the existing code paths.

Change `startTurn` only at the narrow dispatch seam:

1. Perform the existing bot/checkpoint/busy/task/user-message work.
2. Read `HermesBotBinding` from the binding store. An unavailable sidecar is a
   typed setup error; do not treat it as no bindings.
3. For a valid bound bot, bypass generic `ProviderAdapter.sendTurn` and dispatch
   through `HermesBotEngine.send` with the current V Bot thread/turn ids and a
   newly generated opaque adapter turn id. Do not
   write Hermes ids into `TaskRecord.resumeCursors`; retain `modelSelection`
   unchanged for compatibility.
4. Let the adapter publish `turn.started`, `session.started`, optional deltas,
   final `assistant_text`, and `turn.completed` into the EventBus. Existing
   `lastReply`, Store assistant persistence, usage, activity reset, and SSE
   projection must occur once.
5. On setup/unavailable errors emit `runtime.error` with `setup: true` and a
   stable code/message. On transient turn failures emit `setup: false` and one
   terminal failed completion. Always preserve the binding and V Bot user
   message; never fall back to OpenMaus.

`/api/bots/:id/interrupt` maps to the engine's `interrupt` for a bound bot,
while existing room/group interrupt paths remain unchanged. A bound bot reports
`queueing: false`/`steer: false`; existing V Bot queue handling therefore queues
or rejects through its current route. No Hermes profile roster is auto-imported
as a V Bot and no binding edit UI/route is added in this wave; tests seed the
sidecar through the internal store API.

Project only safe, additive capability metadata through the existing
`/api/instances` projection if the client needs to render setup state: add a
`capabilities.hermesBot` object containing booleans, state, and stable typed
reason codes, or omit it when the feature is disabled. No profile rows, session
ids, paths, query text, stderr, or tokens may cross this projection.
`sanitizeMobileProviderCatalog()` remains unchanged unless a type-only
extension is required; no iOS/companion Swift or route changes.

### TDD steps

- [ ] **3.1 Write red registry/integration tests.** Cover:
  - disabled-by-default config and old config files decoding byte-for-byte;
  - registry lifecycle/discovery, event unsubscribe, and provider reload cleanup;
  - bound Hermes bot dispatches once through Hermes, appends the existing user
    message, persists exactly one assistant message/final response, emits the
    expected SSE/runtime sequence, resets activity, and records no Hermes
    `resumeCursor`/id in public JSON;
  - interrupt reaches `session.interrupt`; unsupported steer/queue/groups do
    not call Hermes;
  - unreadable/malformed binding sidecar is unavailable (not empty), profile
    rename/deletion is unavailable, and no OpenMaus fallback occurs;
  - old unbound bots, generic Hermes ACP turns, OpenMaus/Grok, routines, groups,
    `/api/bots`, `/api/events`, `/api/instances`, and model picker snapshots are
    unchanged; unknown drivers stay unavailable shadows;
  - security scan of captured argv/env/log/SSE/activity/error output for
    `HERMES_HOME`, profile paths, state/session ids, query text, raw stderr,
    keys, and tokens.

  Focused command before implementation:

  ```bash
  pnpm vitest run server/engines/index.test.ts server/index.hermes-adapter.test.ts
  ```

  Expected: red import/behavior failures.

- [ ] **3.2 Implement the small engine registry and integration branch.** Keep
  Hermes events in the existing bus/fold. Ensure binding reads are immutable for
  a turn and failed writes do not alter prior records. Ensure registry reload
  settles busy Hermes turns like existing provider reloads, without leaving a
  bot stuck or deleting its binding.

- [ ] **3.3 Run focused tests and compatibility regressions.**

  ```bash
  pnpm vitest run \
    server/engines/contracts.test.ts \
    server/engines/discovery.test.ts \
    server/engines/bindings.test.ts \
    server/engines/hermes-adapter.test.ts \
    server/engines/index.test.ts \
    server/index.hermes-adapter.test.ts \
    server/harness/registry.test.ts \
    server/provider-catalog.test.ts \
    server/vbot-engine-sync.test.ts \
    server/routines.test.ts
  pnpm typecheck
  ```

  Inspect `git diff --stat` and serialized API fixtures; confirm no iOS Swift,
  companion, `server/contracts.ts`, `server/store.ts`, or generic Hermes ACP
  behavior was changed.

- [ ] **3.4 Commit.**

  ```bash
  git add server/engines server/index.ts server/config.ts server/provider-catalog.ts
  git commit -m "feat(vbot): dispatch bound bots through Hermes Bot Chat adapter"
  ```

## Task 4: Deterministic live fixture, docs, and release gate

### Fixture

`server/testing/fake-hermes-tui-gateway.ts` is a child process implementing only
the tag-pinned line protocol needed by Wave 1. It emits `gateway.ready`, accepts
`initialize`, `profiles.list`, exact `session.list`, `session.resume`,
`prompt.submit`, and `session.interrupt`, and can be configured by test-only
flags for interleaved deltas, compression tips, missing/renamed profile,
malformed final, timeout, and crash. It must use deterministic profile/session
ids (`profile-default`, `session-root`, `session-tip`) and fixture text, never a
real home, account, key, or path. It must not be imported by production code.

`server/engines/hermes-live-fixture.test.ts` launches this child through the
same adapter factory used by the hub, with `HERMES_HOME` pointing at a temporary
mode-0700 fixture directory and an explicit executable override. The test:

1. Starts with one default profile and an existing hidden canonical Bot Chat.
2. Discovers the safe roster and verifies `hermes` handle/capability flags.
3. Seeds one internal binding, sends a message, and verifies the final text in
   EventBus/SSE and `/api/bots/:id/messages` with no runtime/durable Hermes id in
   the response.
4. Interrupts a long fixture turn and verifies one terminal cancellation.
5. Kills/restarts the gateway, then sends again; the adapter must call exact
   title lookup and resume the compression tip rather than reuse the old runtime
   id or create a second chat.
6. Replaces the fixture with unreadable state/protocol failure and verifies
   typed unavailable state, stale safe roster (if present), and no empty-roster
   success or binding mutation.

### Documentation

`docs/hermes-adapter.md` must document:

- local-only trust path (iOS -> paired hub -> loopback TUI gateway);
- exact profile/title identity and compression-tip handling;
- safe binding sidecar contents and unavailable/unknown semantics;
- normalized capability flags and why generic ACP/MCP does not enable
  `message_agent`, groups, relay, routines, queue, or steer;
- send/interrupt event projection and Store/SSE source of truth;
- child environment/argv/log redaction and account-login versus pairing
  separation;
- recovery behavior for missing CLI, gateway/auth failure, unreadable state,
  profile rename, timeout, malformed final, and upstream error;
- explicit Wave 1 deferrals and the no-Hermes-source-change rule.

Append a concise section to `docs/v-bot-architecture.md` saying Hermes Bot Mode
is a provider/profile adapter behind the hub, not a new `VBotPrimaryEngine`, and
that V Bot Store remains the mobile transcript source of truth. Do not document
or expose a CLI fallback, raw SessionDB path, or account token.

### TDD/release steps

- [ ] **4.1 Write red fixture/documentation checks.** Add assertions that the
  fixture can be launched, no secret/path/session fields occur in captured
  output, the restart path performs a fresh title lookup, and docs mention
  `Bot Chat`, `include_hidden`, fail-closed unknown/unavailable behavior,
  pairing separation, and all explicit deferrals.

  ```bash
  pnpm vitest run server/engines/hermes-live-fixture.test.ts
  ```

  Expected: red until fixture and docs are present.

- [ ] **4.2 Implement the fixture, live test, and docs.** Keep fixture-only
  process controls behind test imports; no production env or default config
  enables Hermes Bot Mode.

- [ ] **4.3 Run the focused live fixture and full release gates.**

  ```bash
  pnpm vitest run server/engines/hermes-live-fixture.test.ts
  pnpm vitest run \
    server/engines server/index.hermes-adapter.test.ts \
    server/harness/registry.test.ts server/provider-catalog.test.ts \
    server/vbot-engine-sync.test.ts server/routines.test.ts
  pnpm typecheck
  pnpm build
  node scripts/test-floor.mjs
  cd ios && swift test
  ```

  If a baseline command fails, record the exact pre-existing failure and keep
  it separate from Hermes results; do not “fix” unrelated work in this wave.

- [ ] **4.4 Inspect the release diff and fixture evidence.** Confirm:
  - only the four planned task commits plus docs exist;
  - no Hermes checkout changed;
  - `git grep` finds no Hermes durable/runtime id, path, `HERMES_HOME`, token,
    key, prompt, or raw stderr in public JSON/error/log fixtures;
  - old config/bots decode and unknown-driver shadow behavior remain green;
  - unsupported capability flags are false;
  - no iOS/companion contract files changed;
  - live fixture proves restart/title re-resolution and interrupt.

- [ ] **4.5 Commit docs/fixture and prepare the branch for review.**

  ```bash
  git add server/testing/fake-hermes-tui-gateway.ts \
    server/engines/hermes-live-fixture.test.ts \
    docs/hermes-adapter.md docs/v-bot-architecture.md
  git commit -m "docs(vbot): document Hermes Bot Chat Wave 1 boundary"
  ```

## Final verification and push

Before reporting completion, run:

```bash
git status --short --branch
git log --oneline --decorate -6
pnpm typecheck
pnpm build
node scripts/test-floor.mjs
cd ios && swift test
cd /Users/Vincent/Github/.worktrees/vbot-hermes-adapter-0901
git diff vbot-private/main...HEAD --stat
git diff vbot-private/main...HEAD --name-only
```

Push only the plan/implementation branch to the private remote:

```bash
git push vbot-private HEAD:feat/vbot-hermes-adapter-0901
```

Do not push to `origin` or `personal`, and do not deploy production services in
Wave 1. A green test suite without the deterministic loopback fixture, restart
re-resolution, interrupt, and redaction evidence is not a release.

## Explicit deferrals after Wave 1

- Hermes `message_agent` and any V Bot/Hermes A2A protocol (sender attribution,
  recursion/budget limits, replay/ack, stale roster, title/managed-install
  defense in depth).
- Hermes groups/rooms, `bot_relay.*`, peer gateways, Desktop connection roster,
  fleet/cross-machine delivery, remote credential forwarding, and hub-to-hub
  transcript merge.
- Hermes provider login/OAuth/account setup, billing/subscription UI, provider
  secret entry, or account identifier in V Bot bindings. Login never replaces
  V Bot pairing.
- Node-hosted/remote Hermes runtimes, fleet discovery, or cloud control plane.
- Routine create/edit/pause/resume/run/cancel; human `hermes cron list` parsing;
  raw `jobs.json`/SessionDB SQLite reads from TypeScript. Read-only routines may
  be added only with a deliberately configured authenticated dashboard channel,
  schema validation, safe profile association, and unavailable-on-error state.
- Attachments/vision, computer/phone/composio/custom MCP, local VM, and any
  capability not proven through the TUI gateway.
- Queueing, steer, fork/branch, destructive rewind, replay/history mirroring
  beyond the current turn, and automatic canonical Bot Chat creation. Any
  future create path must adopt-before-mint under a profile lock after a
  successful exact lookup proves absence; lookup failure must never create.
- Making Hermes a `VBotPrimaryEngine`, changing `server/vbot-engine-sync.ts`,
  changing iOS/companion contracts, or replacing OpenMaus/Grok paths.
- Any change in `/Users/Vincent/Github/hermes-agent` during this wave. API gaps
  become a separately reviewed Hermes change proposal with versioned
  compatibility tests.

## Top implementation risks

1. **Session-id split:** Hermes durable SessionDB `id`/`resolved_id` and the
   gateway's runtime `session_id` are different namespaces. Passing the wrong
   id into `resumeCursor` would lose continuity or fork the canonical chat.
2. **Fail-closed identity:** Treating title lookup/RPC/DB failure as empty and
   then creating a chat would mint duplicate Bot Chats. Exact hidden-title lookup,
   absent-vs-unknown result types, and profile-scoped serialization are release
   blockers.
3. **Gateway/security projection:** Startup/auth/protocol failures and Hermes'
   rich env/stderr/path payload must collapse to safe typed availability and
   capability metadata; tests must cover argv, logs, activity, SSE, API, and
   errors before enabling the adapter.
