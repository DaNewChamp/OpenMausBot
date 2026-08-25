# iOS Agent-to-Agent Experience Enhancements

**Date:** 2026-08-25  
**Status:** Approved direction; implementation pending written-spec review

## Goal

Turn OpenMausMobile into a clean, professional agent-to-agent control app. The phone should make conversations, delegation, steering, stopping work, and reaching an agent's computer feel native to iOS rather than exposing desktop-oriented receipts or raw server state.

The supplied Grok Bot screenshots are visual references: compact agent identity, restrained activity labels, clear conversation hierarchy, and a persistent composer. They are not implementation instructions and do not override this specification.

## Scope

This batch includes:

1. A single polished agent-to-agent activity row with the peer agent's real avatar.
2. Removal of duplicate and permanently-running communication receipts.
3. Stable chat-header avatar sizing during navigation.
4. Small, Standard, and Large conversation text settings.
5. Synchronized pinning for individual-agent and room conversations.
6. Standard iOS left-edge interactive back navigation.
7. Inline Stop, Steer, and Queue controls for active conversations.
8. Focused animation and visual-polish improvements supporting those interactions.
9. Accurate presentation of existing computer/VM functionality without implying unsupported control.

This batch does not add local VM provisioning or unrestricted remote computer control from a paired phone.

## Mobile Reference Translation

The supplied Grok Bot mobile screenshots refine the visual direction:

- Pinned conversations form a compact favorite-agent shelf above the normal recency list, using larger avatars and short names. The shelf must remain useful with one item and horizontally scroll when it grows.
- Regular chat rows retain dense native list spacing, a clear unread dot, subdued timestamps, and room-avatar stacks.
- The conversation header uses a small peer avatar beside the title rather than a large decorative portrait. Back and computer actions keep stable circular seats.
- Agent and room settings use calm grouped cards, clear section labels, and compact member/avatar rows. Existing OpenMaus controls are reorganized only where this batch touches them; it does not clone Grok-only character or subscription features.
- Composer secondary actions belong behind the existing plus button in a native menu rather than occupying permanent chat space.
- Computer screens distinguish `Starting`, `Unavailable`, and `Viewing` states. Existing secure viewers remain the capability source; the visual treatment must not imply touch control where only watching is supported.

These references guide hierarchy, density, and motion. OpenMaus keeps its own mascot, materials, colors, and security boundaries.

## Agent-to-Agent Activity

Communication activity renders through a dedicated row before generic tool rendering.

- Resolve the peer using `Message.comm.withBotId`; use `Message.from.botId` when rendering incoming room activity.
- Display the peer's authenticated profile image through `BotAvatarView`, with the existing mascot fallback.
- Render one compact line: avatar, direction-aware text such as `Messaged @CIO` or `Message from @Chief`, and a chevron when the related room can be opened.
- Tapping the row navigates to the related room or peer conversation when the destination exists.
- Do not also render the generic communication label.
- Do not show `Running` for a communication chip whose server record has no settlement state. A future explicit delivery state may be shown, but missing state is neutral.
- Preserve generic tool disclosures for non-communication activity.

## Chat Header and Navigation

- The selected agent avatar occupies a stable 60-point header seat.
- Conversation pushes and switches must not replay the large island-intro animation.
- Remove the per-conversation expansion to the 132-point face.
- Keep subtle state animation within the fixed frame; layout size must not change.
- Restore native interactive-pop behavior so a left-edge swipe returns to the chat list.
- Keep the custom visual header while allowing the navigation controller's standard back gesture. If hiding the system bar prevents this, use a small navigation-controller bridge that only restores the gesture and does not implement a competing drag gesture.

## Conversation Typography

Settings gains a `Conversation text size` picker:

- Small
- Standard (default)
- Large

The value is stored locally with `AppStorage` and applies to message prose, Markdown headings/body, tool summaries/details, composer text, and predictive/action chips. Navigation chrome, avatars, and system controls continue following normal Dynamic Type rather than being multiplied twice. Values are bounded and mapped through one shared chat-typography model so individual views do not invent independent scale factors.

## Pinned Conversations

Pinning is server-backed and therefore follows the user across paired phones.

- Add narrow paired-safe pin routes for bots and rooms. Each accepts only a Boolean pinned value and rejects unrelated fields.
- Keep broad bot/room patch routes blocked from the companion.
- Extend the room wire model with `pinned` using the same semantics already present for bots.
- Sort pinned chats first, preserving the existing unread and recency ordering within pinned and unpinned sections.
- Present pinned chats in a favorite-agent shelf above the normal list, echoing the supplied mobile reference while retaining OpenMaus avatar rendering.
- Expose Pin/Unpin through chat-row swipe actions and a context menu.
- Show a restrained pin glyph without replacing unread/busy indicators.

## Stop, Steer, and Queue

### Composer behavior

- Idle conversation, empty draft: existing microphone/send behavior.
- Active conversation, empty draft: replace Send with a Stop button.
- Active conversation, non-empty draft: show Send; a normal tap uses **Steer**.
- Long-press Send presents `Steer now` and `Queue after current work`.
- Settings exposes `While agent is working` with Steer as the default and Queue as the alternative.
- The selected default changes normal-tap behavior; both explicit long-press choices remain available.

### API contract

- Extend message submission with an explicit delivery mode: `auto`, `steer`, or `queue`.
- `steer` must target the active turn immediately when the engine supports it and return a clear error when it cannot.
- `queue` must persist behind the active turn and return its queue identifier.
- Existing callers that omit the field retain current `auto` behavior.
- Return a typed response describing whether the message started, steered, or queued.
- Add paired-safe room interrupt support alongside the existing bot interrupt route.
- iOS tracks queued acknowledgements sufficiently to label them and reconcile when the server later drains them; it does not invent optimistic completion.

### Error handling

- Stop is idempotent from the user's perspective.
- A failed steer or queue keeps the draft and presents the server error.
- A successful steer or queue clears the draft only after acknowledgement.
- Prevent duplicate submissions while the request is in flight.

## Visual Polish

- Use short spring or ease-out transitions for disclosure, Stop/Send substitution, and pin reordering.
- Avoid large scaling effects, bouncing layout, persistent glowing states, or animation that obscures live text.
- Activity rows use compact spacing, secondary text, and authentic agent color/avatar rather than raw command styling.
- Continue using system materials, semantic colors, and accessibility labels.
- Respect Reduce Motion.

## Computer and VM Truthfulness

Current mobile functionality remains explicit:

- Live screen watching is available when screen frames are enabled.
- Supported cloud computers may open the existing protected browser viewer.
- Server-side `vm` agents may work, but iOS cannot currently provision, start, stop, remove, or interactively control local VMs.
- The UI must not offer controls that silently do nothing or imply VM control exists.
- Computer surfaces use explicit Starting, Unavailable, and Viewing states, with the compact avatar/title header shown in the supplied reference.

A later VM-control batch requires a separate threat model, per-device capabilities, narrow lifecycle routes, audit logging, and an interaction design suited to touch.

## Testing and Verification

Required automated coverage:

- Communication activity renders once, resolves the correct peer, and never infers Running from missing state.
- Pin routes reject extra fields and companion access remains narrow.
- Bot and room pin state round-trips and sorting is deterministic.
- Explicit `steer` and `queue` modes exercise supported, unsupported, busy, retry, and acknowledgement paths.
- Bot and room interrupt routes remain paired-safe.
- Typography setting default, persistence, and bounds.
- Composer state matrix and draft-retention behavior where separable from SwiftUI.
- Existing tool-disclosure, model-switching, server, companion, and Swift suites remain green.

Required device/simulator checks:

- Peer avatar and single communication row match the supplied reference intent.
- New conversation never enlarges the header avatar.
- Left-edge back swipe works from a conversation.
- Small/Standard/Large remain readable without clipping.
- Pinning immediately reorders the chat list.
- Stop, Steer, and Queue work for both a bot and a room.
- Reduce Motion removes nonessential transitions.

## Release Boundary

Implementation is complete only after focused tests, full relevant suites, TypeScript builds, Swift tests, simulator build, and visual interaction checks pass. A TestFlight upload is a separate release action and requires explicit authorization after the batch is green.
