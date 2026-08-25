# Parity Round 3 — Auto-Review and Memory Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two judgement layers. Auto-review lets a classifier answer the
permission cards a human would obviously have approved. Memory synthesis
writes down the durable facts a bot learned but never thought to record.

**Architecture:** Both call a model, so both share one resolver for a
*helper instance* — `generateText` exists on `ProviderInstance` but only
claude, antigravity, grok, minimax and openai-compat implement it, so a bot on
codex or any ACP driver must borrow one or the feature is silently off.
Auto-review slots into the existing `request.opened` fold as one more verdict
source; synthesis writes into a fenced block inside the MEMORY.md that
`server/workspace.ts` already owns.

**Tech Stack:** TypeScript (`--experimental-strip-types`), vitest, pnpm.

**Spec:** `docs/plans/grok-parity-upgrades.md` — Round 3. Its *Working
agreement* governs how this ships.

## Global Constraints

- Everything in `docs/plans/grok-parity-upgrades.md` § Global Constraints applies unchanged.
- **Both features default OFF.** A user must switch each on per bot.
- **Both fail closed.** No helper instance, a timeout, a parse failure, or a refusal all mean "do the safe thing": card the request, or write no memory.
- Auto-review may never override the destructive guard, the sensitive guard, the unattended block, or the local-computer block. It is consulted *only* where `autoVerdict` already returned `{ approve: null, source: "no-grant" }`.
- Synthesis never takes evidence from a webhook, listener, automation, or bot-to-bot turn. `server/workspace.ts:165` already promises the user that only first-hand verified facts are recorded; that promise is load-bearing.

## Verified against `main` at 3557e74 (2026-08-25)

| Assumption | Still true |
|---|---|
| `memorySystemPrompt(botId)` owns MEMORY.md injection | Yes — `server/workspace.ts:155`, called from `index.ts:1761` and `:2035`, now alongside `skillsSystemPrompt` |
| The fold consults `autoVerdict` once | Yes — `server/index.ts:860` |
| `AutoVerdictSource` is a closed union the decision log records | Yes — `server/auto-approve.ts:81-87`, 7 members |
| `generateText` is partial | Yes — claude, antigravity, grok, minimax, openai-compat only |

---

## Task 1: The helper-instance resolver

Both features need "an instance that can answer a short text prompt". A bot's
own engine is preferred: it is the one the user chose and pays for. If it
cannot, any other enabled instance that can will do. If none can, the caller
gets `null` and the feature turns itself off for that bot rather than
pretending.

**Files:** Create `server/helper-instance.ts`, `server/helper-instance.test.ts`

**Interfaces:**
- `interface HelperCapable { instanceId: string; generateText?: (prompt: string) => Promise<string> }`
- `resolveHelper(preferredId: string | undefined, all: readonly HelperCapable[]): HelperCapable | null`
- `askHelper(helper: HelperCapable, prompt: string, timeoutMs: number): Promise<string | null>` — null on timeout, rejection, or empty output

- [ ] **Step 1:** Write the failing tests — prefers the bot's own instance; falls back to any capable one; returns null when none is capable; `askHelper` returns null on timeout rather than hanging the caller; returns null on rejection; returns null on whitespace-only output.
- [ ] **Step 2:** Run, implement, run. Commit.

---

## Task 2: Auto-review

**Files:** Create `server/auto-review.ts`, `server/auto-review.test.ts`. Modify `server/store.ts` (`autoReview` on `BotRecord`), `server/index.ts` (the fold), `src/components/SettingsPanel.tsx` (the control).

**Interfaces:**
- `type AutoReviewMode = "off" | "shadow" | "enforce"`
- `interface ReviewRequest { tool: string; summary: string; persona: string }`
- `interface ReviewVerdict { allow: boolean; reason: string }`
- `buildReviewPrompt(request: ReviewRequest): string`
- `parseReviewVerdict(raw: string | null): ReviewVerdict | null`
- `AUTO_REVIEW_TIMEOUT_MS = 8_000`

The classifier is told it is deciding whether a human would obviously have
approved a routine action, that anything touching credentials, money, sending,
publishing, or deleting is never obvious, and to answer with a single JSON
object. `parseReviewVerdict` returns `null` for anything it cannot read — and
null means card it.

Fold changes at `server/index.ts:860`, in order:

1. `autoVerdict` runs exactly as today.
2. If it granted, nothing changes.
3. If it refused for any reason other than `no-grant`, nothing changes — the guards outrank review.
4. Only on `no-grant`, and only when the bot's mode is not `off`, ask the classifier.
5. `shadow`: always card, and append a decision-log row with source `auto-review-shadow` recording what it *would* have done.
6. `enforce`: an `allow` verdict answers the request the same way an always-allow grant does, logged with source `auto-review`; anything else cards.

`AutoVerdictSource` gains `"auto-review"` and `"auto-review-shadow"`.

- [ ] **Step 1–4:** TDD `buildReviewPrompt` / `parseReviewVerdict` (pure).
- [ ] **Step 5–8:** Wire the fold; test that a destructive summary is never reviewed, that shadow always cards, and that enforce settles only on a clean allow.
- [ ] **Step 9:** Settings control, three-way, defaulting off, with copy saying shadow only measures.

---

## Task 3: Memory synthesis

**Files:** Create `server/memory-synthesis.ts`, `server/memory-synthesis.test.ts`. Modify `server/workspace.ts` (fenced-block read/write), `server/index.ts` (debounced trigger), `src/components/SettingsPanel.tsx`.

**The safety design is the fenced block.** MEMORY.md is a file the user and
the bot both edit by hand. Synthesis owns only what is between
`<!-- maus:synthesized -->` and `<!-- /maus:synthesized -->`; everything above
and below is never touched. If the markers are absent, the block is appended
at the end. If they appear more than once, synthesis refuses and logs — an
ambiguous file is not one to rewrite.

**Interfaces:**
- `SYNTHESIS_OPEN`, `SYNTHESIS_CLOSE`, `SYNTHESIS_DEBOUNCE_MS = 15_000`, `MAX_SYNTHESIZED_BYTES = 8_000`
- `readSynthesized(markdown: string): { before: string; body: string; after: string } | "missing" | "ambiguous"`
- `writeSynthesized(markdown: string, body: string): string | null` — null when ambiguous or the result would exceed the file budget
- `buildSynthesisPrompt(evidence, existing): string`
- `parseSynthesisOutput(raw: string | null): string[] | null` — bounded list of one-line facts

Trigger: on `turn.completed` for a bot with `memorySynthesis` on, debounce
15s, gather the settled user/assistant pairs since the last sweep, skip
entirely if the turn's origin was a webhook / listener / automation / peer,
ask the helper, and write. A sweep that would push MEMORY.md past
`MEMORY_MAX_BYTES` is rejected whole rather than truncated.

- [ ] **Step 1–6:** TDD the fenced-block reader/writer first — hand-edited file, no fence, two fences, fence inside a code block, oversized result.
- [ ] **Step 7–10:** Prompt/parse, then the debounced trigger, then the setting.

---

## Task 4: Round 3 gate

- [ ] `pnpm typecheck && pnpm test` green; oxlint per-file parity with `origin/main`.
- [ ] Build, launch the dev app, hand over the Round 3 row of the what-to-exercise table, **stop**. No push, no PR until asked.
