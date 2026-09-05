# V Bot Product Readiness Design

## Goal

Close the remaining mobile, fleet, approval-explanation, and hosted-web gaps so V Bot behaves as a model-agnostic Grok Bot/OpenMausBot alternative: one hub, a fleet of connected computers, optional shared/private lightweight VMs, bot and room calls, clear tool approvals, and the same product language on iOS and web.

## Product model

The user-facing architecture is `client -> hub -> fleet -> selected execution target -> agent runtime`. The hub owns bots, rooms, transcripts, credentials, permissions, routines, calls, and routing. A bot owns model/provider selection, computer policy, workspace/VM policy, connected apps, permissions, voice, and instructions. Provider-specific details remain hidden unless a capability genuinely requires them.

Computers are presented as a fleet. The phone is paired to one hub, while Mac mini/Windows/VPS nodes are computers available through that hub. Do not call bridges additional phone pairings. Advanced diagnostics may still say bridge.

Bot computer choices are Auto, a specific computer, or Isolated VM. VM allocation supports Shared and Private under Advanced. Headless Chromium is the normal browser runtime; full GUI/noVNC is exceptional.

## iOS readiness

1. The VM keyboard cannot trap the user. Opening it exposes one visible input bar above the system keyboard and a persistent Done/dismiss affordance. Keyboard button, Done, Back, and leaving Computer all clear focus.
2. Fleet Local VM interaction prefers the lightweight screenshot/CDP path. A blank or failed full viewer must not replace a usable screenshot/CDP session. Full streamed viewer remains for supported backends.
3. Settings says `1 hub · N connected computers` rather than `N computers paired`; the fleet screen uses Hub and Available computers language.
4. Public settings do not expose the internal term House Style. Users get Global style and per-bot style/personality only.
5. Approval explanation UI exposes one choice: Explain tool requests -> Off / When unclear / Always. Provider/model plumbing is hidden from normal settings. Deterministic local explanation remains authoritative; optional model text is advisory only.
6. Tool approval cards lead with plain English: actor, action, machine, change/no-change, then expandable details. Raw commands remain available under Details.
7. Existing voice and team call semantics remain provider/model agnostic.

## Fleet/runtime correctness

Native tool execution must honor the selected fleet machine and never silently execute on the hub or another machine when a specific target is pinned. Existing authenticated native relay ownership, takeover, stop, and job-generation guards remain intact.

House-style storage remains backward compatible, but shipped UI treats it as global style. The internal default may remain the fallback. Per-bot instructions remain authoritative and can opt out/override without exposing implementation markers.

Approval reviewer selection becomes an implementation detail. A fast model may be selected automatically from configured available models, with existing deterministic fallback and bounded timeout. No model-generated summary can alter risk, permission scope, or approval decisions.

## Web parity

Use the already-built V Bot web-polish work as the behavioral/visual base where compatible. Web must match iOS terminology and semantics for fleet, models, approvals, global style, bot settings, calls, rooms, routines, connected apps, and VM status. Remove raw House Style from normal settings. Keep responsive Grok-style hierarchy and avoid desktop-implementation terminology in the hosted client.

## Validation

- Swift package tests and iOS simulator build must pass.
- Focused VM keyboard, fleet terminology, style, approval, and selected-host tests must demonstrate red/green behavior.
- TypeScript typechecks, relevant Vitest suites, Vite build, server/companion/bridge builds, and built bridge imports must pass.
- Full repository test floor runs before deployment; unrelated flakes must be isolated rather than papered over.
- Physical iPhone acceptance covers keyboard dismissal and Computer interaction before TestFlight promotion.
- Hosted web is verified at mobile and desktop widths after deployment.
- No production VM/container recreation, fleet reassignment, credential mutation, or destructive cleanup is part of this design.
