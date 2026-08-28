# Cursor as a bot engine

## Short answer

**Yes — Cursor is already supported** as a first-class engine on the paired Mac/desktop harness. V Bot on iOS does not talk to Cursor directly; it selects whatever engines the computer advertises via `GET /api/instances`.

You can use **Auto**, **Composer**, and models such as **Grok 4.6** when they appear in your Cursor account's model list — there is no separate "Cursor API" integration to build on the phone.

## How it works today

| Layer | Status |
|-------|--------|
| **Server driver** | `server/drivers/acp/cursor.ts` — `cursor-agent acp` over ACP stdio |
| **Built-in registration** | Listed in `server/drivers/builtIn.ts` as `CursorAgentDriver` |
| **Desktop UI** | `ModelPicker` + `ProviderMark` with official Cursor mark |
| **iOS** | Per-bot model picker reads `/api/instances`; Settings → Desktop engine exposes Cursor when Grok Reconstructed is active |

### OpenMaus mode (default)

1. Install and sign in to the Cursor CLI on the Mac: `cursor-agent login` (or set `CURSOR_API_KEY`).
2. Enable the **Cursor** engine in desktop V Bot / OpenMaus → Settings → Engines.
3. Assign a bot to the Cursor instance in the agent profile model picker.

Models come from `cursor-agent models` at runtime. Static fallbacks include `auto`, Composer variants, and Codex — live catalogs may also include Grok slugs when your subscription allows them.

### Grok Reconstructed mode

When the Mac runs Grok Bot 0.18 Reconstructed as the primary engine, host-wide routing includes providers: `cursor`, `claude-code`, `codex`, `openrouter`. Only **Cursor** models are selectable from the phone (Settings → Desktop engine → Host provider). This path is how Reconstructed exposes Cursor Auto / Grok model IDs such as `grok-4.5` and `grok-4.6`.

## What is *not* implemented

- **No standalone Cursor Cloud Agent API** on the phone — all turns run through the paired computer's CLI/ACP harness.
- **No Cursor IDE embedding** inside the iOS app.
- **No per-bot Cursor picker in Reconstructed mode** — provider/model is host-wide by design in the Reconstructed gateway.

## If Cursor does not appear

1. Confirm `cursor-agent` is installed (`curl https://cursor.com/install -fsS | bash`).
2. Run `cursor-agent login` or configure `CURSOR_API_KEY` on the Mac.
3. Add/enable the Cursor engine in desktop Settings → Engines.
4. Refresh instances (open the agent profile model section or restart the harness).

## Related files

- `server/drivers/acp/cursor.ts` — driver, model catalog, auth probe
- `server/drivers/acp/core.ts` — shared ACP runtime
- `server/drivers/grok-reconstructed.ts` — host router with Cursor provider
- `src/components/ProviderIcons.tsx` — desktop brand marks (source for iOS marks)
- `ios/App/ProviderMarks.swift` — iOS engine icons
- `ios/App/ModelPickerView.swift` — premium model picker UI
