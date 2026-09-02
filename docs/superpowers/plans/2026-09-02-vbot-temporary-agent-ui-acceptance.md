# V Bot Temporary-Agent UI Acceptance Addendum

**Date:** 2026-09-02

**Applies to:** Wave 1, Tasks 4–6 of `2026-09-02-vbot-hermes-chief-platform.md`
**Owner:** V Bot iOS/client implementation

This addendum translates the latest ChatGPT agent-progress reference into V Bot
terms. It is an acceptance contract for the existing Hermes connector,
capability/event projection, and iOS projection tasks; it does not create a
second agent/activity model.

## Product intent

Temporary Hermes MoA/subagents are useful work attached to the current V Bot
conversation, not extra bots or mandatory channels. V Bot owns presentation,
history, unread state, and approvals while Hermes remains the runtime. A
completed temporary run must still be discoverable from the parent conversation.

Use V Bot typography, surfaces, avatars, accent colors, and copy. The reference
is an interaction pattern only; do not reproduce ChatGPT labels, branding, or
layout verbatim.

## Acceptance behavior

### Compact activity pill

- Render one compact pill immediately above the composer when the existing
  activity projection contains active, queued, needs-attention, or recently
  finished work.
- The compact copy must be useful at a glance: an agent count and the most
  relevant available status/name. Do not show a generic spinner with no
  identity. Use the fields already exposed by the activity/event projection;
  omit model or effort when the source did not provide them.
- When the projection is quiet, render no pill, no reserved bottom rail, and no
  placeholder copy. Keep the current `HomeActivityRailLayoutPolicy` quiet
  behavior.
- Keep the collapsed control content-hugging and accessible at Dynamic Type
  sizes. It may grow enough for honest text, but must not make the composer
  jump horizontally.

### Expansion and rows

- Tapping the pill expands a vertical stack **upward only**. The stack is
  placed above the compact pill and composer; it never fans left/right and
  never overlays an unrelated roster row.
- Each row exposes the most useful available identity and state: agent name,
  runtime/model and effort when supplied, plus status such as working, queued,
  waiting for approval, failed, or complete. Do not invent model/effort values
  or imply support for an unavailable capability.
- Text may widen inside the row/detail surface for readability. Controls,
  avatars, and row positions stay in the vertical rail.
- Selecting a row opens the focused detail/transcript surface through the
  existing chat navigation path. The user can inspect the temporary run without
  losing the parent chat position.
- A completed temporary transcript remains anchored to the parent history and
  can be reopened after the pill disappears. If the event is not retained or
  the source reports it unavailable, show the existing honest unavailable state
  rather than an empty transcript.
- Show `Promote to Bot` only when the projected agent is eligible and the
  existing runtime/approval contract allows it. Promotion preserves transcript,
  provenance, and parent relationship; it does not create a duplicate agent.

### Motion, input, and accessibility

- Use a short, calm expansion/collapse animation that moves the rail vertically.
  Respect `accessibilityReduceMotion` by disabling movement and retaining the
  same final layout.
- Pill, rows, and promotion have explicit accessibility labels, values, and
  hints. VoiceOver users can reach every row, status, transcript, and eligible
  promotion action in logical order.
- The interaction must remain usable with large Dynamic Type, narrow devices,
  and keyboard/composer changes. Do not rely on a fixed single-line string for
  essential status.
- Selection and dismissal use the app's existing lightweight haptic policy;
  haptics are not required for accessibility.

## Test-driven acceptance

Add or extend tests at the existing task touchpoints; keep the server event and
runtime contracts from Tasks 4–5 as the source of truth.

### Core policy tests

`ios/Tests/CompanionCoreTests/HomeActivityPresentationTests.swift`

- active/queued/attention/finished work produces an honest compact summary;
- quiet produces no rail/pill and no reserved height;
- missing model/effort/status fields do not create fabricated copy;
- retained completion remains addressable by its parent thread/activity ID.

`ios/Tests/CompanionCoreTests/HomeActivityRailLayoutPolicyTests.swift`

- collapsed control hugs content;
- expanded layout is above the pill and vertical-only;
- no horizontal fan/outward layout is permitted;
- accessibility sizing keeps a readable, testable minimum height.

`ios/Tests/CompanionCoreTests/HermesSetupTests.swift` and the existing
runtime/capability tests:

- promotion is offered only when eligible and approved;
- promotion preserves identity/provenance and is idempotent;
- unsupported capability or unavailable transcript stays visibly unavailable.

### View/integration checks

`ios/App/HomeActivityPill.swift`, `ios/App/ActivityRunChip.swift`,
`ios/App/AgentProfileView.swift`, and `ios/App/ChatListView.swift` should be
covered by the existing Swift package/view test harness or deterministic preview
fixtures. Verify that:

1. a single active temporary agent shows one compact pill;
2. several agents show a count and expand into rows stacked upward;
3. tapping a row opens its focused transcript and returns to the same parent
   conversation anchor;
4. completion remains reopenable from parent history after the live pill is
   gone;
5. quiet removes the pill entirely;
6. reduced motion and accessibility-size captures preserve the same semantics;
7. eligible promotion preserves the run and produces one persistent V Bot.

Run the focused activity/Hermes filters first, then the full
`swift test --package-path ios` gate required by Wave 1.

## Explicit non-goals

- Do not add a new backend event schema, transcript store, or polling loop.
- Do not make channels/rooms a prerequisite for temporary-agent work.
- Do not expose secrets, provider session IDs, or raw tool output in a pill,
  row, accessibility value, transcript preview, or log.
- Do not implement Wave 2 native learning/skills/routines parity, Wave 3 fleet/
  VM tools, Wave 4 web parity, or Wave 5 voice work in this addendum.
- Do not redesign the entire chat composer, model picker, or approval sheet.
- Do not duplicate Tasks 4–6 implementations. Apply these requirements to the
  existing connector/capability/projection work and coordinate through the
  files already named in the main plan.

## Coordination boundary

The Grok worker may use this document as the acceptance checklist while finishing
Tasks 4–6. Task 4 remains responsible for the loopback connector/MCP facade;
Task 5 remains responsible for capability manifests and idempotent temporary vs
persistent projection; Task 6 remains responsible for the iOS presentation and
navigation. Any contract change needed to satisfy this addendum must be made in
the owning task's existing files and tests, with no parallel replacement model.
