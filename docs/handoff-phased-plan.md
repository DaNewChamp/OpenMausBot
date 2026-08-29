# OpenMausBot (V Bot) — Phased Implementation Plan

**Handoff document for implementing agent (Codex)**  
Repo: `~/Github/OpenMausBot` · Fork of upstream OpenMausBot, iOS/hosted-focused · Apache-2.0  
**Last updated:** 2026-08-29 (Fable review + Cursor session)

---

## 1. Executive summary

V Bot already has the skeleton of the target architecture: a headless harness that owns all bot state, a scrubbing companion sidecar as the only client-facing surface, a native iOS thin client, a paired bridge daemon for home machines, and deploy scripts for both hub hosts (Mac mini launchd, Servarica VPS systemd). The two largest gaps are **trust** and **portability**: bridge shell execution today runs arbitrary commands with no user consent and `shell` capability granted by default, and hub migration is a collection of rsync scripts with hardcoded per-bot patches rather than a first-class export/import. This plan closes those two gaps first (Phases 1–2), then unifies the model switcher (3), grows the desktop viewer into a full companion client (4), completes bridge Local VM relay (5), adds closed-app push (6), and closes out Grok Bot interaction parity (7). Every phase has a live-verification gate against the deployed Servarica hub — a green build is never the exit criterion.

---

## 2. Current state

### Deployed today

- **Hub:** Servarica VPS — systemd `openmausbot-harness`, `openmausbot-sidecar`, `openmausbot-cloudflared`; public URL `https://openmaus.posival.com`; data `/var/lib/openmausbot`; pairing `/var/lib/openmausbot-companion`; runtime `/opt/openmausbot/runtime`.
- **Phone:** V Bot iOS **build 54** (`com.posival.openmausmobile`), paired over hosted HTTPS.
- **Bots:** 10 hosted bots; Chief Keef in **Investments** section with CIO/Scout/Crypto/Sniper reporting in; audit via `scripts/audit-vps-bots.mjs`.
- **Mac mini:** optional bridge host; see `docs/cloud-vps-hosting.md` §Cutover.
- **Engines on hub:** codex (logged in), cursor-agent, claude.

### Current architecture

```text
                      ┌──────────────────────────── Servarica VPS (hub) ────────────────────────────┐
 iPhone (V Bot b54)   │                                                                             │
   Keychain pairing ──┼─► cloudflared ─► companion sidecar ──loopback──► harness :8799              │
                      │      (tunnel)     (allowlist, scrub,             │  bots.json  messages.db  │
 Electron viewer ─────┼─►                  pairing auth)                 │  workspaces  config.json │
  (read-only)         │                                                  │  bridges.json            │
                      │                                                  ▼                          │
                      │                              engine CLIs (codex / cursor-agent / claude)    │
                      │                              docker -H ssh://openmaus-docker (VPS-local)    │
                      └──────────────────────────────────┬──────────────────────────────────────────┘
                                                         │  HTTPS /api/bridge/*
                                                         ▼
                                     Bridge daemon (Mac mini) — bridge/src/
                                     shell · ssh-forward · local-vm relay
```

### Key subsystems

| Subsystem | Paths |
|---|---|
| Harness core | `server/index.ts`, `server/store.ts`, `server/message-db.ts`, `server/config.ts` |
| Engine drivers | `server/drivers/` |
| Model switcher | `server/bot-model.ts`, `ios/App/ChatModelPickerSheet.swift` |
| Approvals | `server/auto-approve.ts`, `server/peer-approval.ts`, `server/permission-proxy.ts`, `server/decision-log.ts` |
| Bridge (harness) | `server/bridge-registry.ts`, `server/bridge-exec.ts`, `server/bridge-routes.ts`, `server/bridge-local-vm.ts` |
| Bridge (daemon) | `bridge/src/` |
| Agent tools | `server/drivers/agents-proxy.ts` |
| Companion | `companion/src/` |
| iOS | `ios/App/`, `ios/Sources/CompanionCore/` |
| Desktop viewer | `viewer/` |
| Deploy / migrate | `scripts/deploy-cloud-vps.mjs`, `deploy-vps-harness.mjs`, `sync-openmausbot-data.mjs`, `audit-vps-bots.mjs` |
| Docs | `docs/v-bot-architecture.md`, `docs/bridge-agent.md`, `docs/cloud-vps-hosting.md`, `docs/ios-grok-parity-wave35.md` |

---

## 3. Target state

```text
                       ┌─────────────────────────── Hub (any machine) ───────────────────────────┐
 iPhone + push (APNs)  │  harness owns: bots + messages + workspaces + devices + bridges       │
 Desktop companion     │  export/import archive = portable hub state                             │
                       └──────────────────────────────┬──────────────────────────────────────────┘
                                                      │ HTTPS /api/bridge/* (rotating tokens)
                             ┌────────────────────────┼──────────────────────────┐
                             ▼                        ▼                          ▼
                     Bridge: Mac mini          Bridge: Windows            Bridge: future
                     caps OPT-IN per host       ssh-forward                revocable from phone
                     shell ONLY after approval
                     full Local VM lifecycle on bridge
```

**Native switcher:** one engine → model → effort picker; per-bot + per-room + global defaults.  
**Hub migration:** single export/import; phone pairing and bridges survive.

---

## 4. Principles / invariants

1. **Hub owns everything** — bots, SQLite, credentials, workspaces; clients are thin.
2. **Harness loopback-only** (`127.0.0.1:8799`); companion is allowlisted + scrubbed.
3. **No internal secrets on clients** — no loopback URLs, tokens, raw engine payloads.
4. **Explicit capabilities** — unsupported = disabled with human-readable reason.
5. **Machine execution requires consent** (after Phase 1) — approval or scoped always-allow.
6. **Pairing identity durable** — survives hub migration; don't change bundle ID / URL scheme casually.
7. **Native reimplementation only** for Grok parity — no Grok/xAI assets.
8. **Verify live, not green** — exercise `https://openmaus.posival.com` and phone.
9. **Read git log + live deploy** before editing — multi-agent repo.
10. **Never print or commit secrets.**

---

## 5. Full phase plan

### Phase 1 — Bridge local-command trust boundary

**Goal:** No agent command on a bridge without explicit, revocable user consent. Bridges advertise nothing by default.  
**Dependencies:** none — do first.

**Work items:**

1. Invert capability defaults — `server/bridge-routes.ts`, `server/bridge-registry.ts`, `bridge/src/index.ts`; env `OMB_BRIDGE_SHELL=1` to opt in; update `docs/bridge-agent.md`.
2. Route `run_on_bridge` / `run_on_ssh_target` through approval broker — reuse `server/auto-approve.ts`, `server/peer-approval.ts`, `server/decision-log.ts`; gate `server/bridge-exec.ts` paths in `server/index.ts`.
3. Scoped always-allow grants `{ botId, bridgeId, capability }` (+ optional cwd prefix).
4. Decision-log every bridge execution.
5. Bridge token rotation + `DELETE /api/bridges/:id`; `bridge/src/client.ts` handles 401.
6. Companion routes `GET/DELETE /api/bridges` (scrubbed) — `companion/src/routes.ts`, `companion/src/proxy.ts`.
7. iOS Settings: Bridges list + revoke — `ios/Sources/CompanionCore/Client.swift`.
8. Truncation flag when bridge output hits 1 MB — `bridge/src/exec.ts`.
9. Tests — `server/bridge-exec.test.ts`, `server/bridge-registry.test.ts`, etc.

**Verify gate:**

```sh
pnpm typecheck && pnpm lint && node scripts/test-floor.mjs
# After deploy: pair bridge without shell; confirm run_on_bridge requires approval on phone
curl -sf https://openmaus.posival.com/api/health
```

**Exit criteria:** fresh bridge has zero caps; approval card on phone; revoke works; truncation flagged; test floor green.

---

### Phase 2 — First-class hub migration

**Goal:** One export/import; phone + bridges survive; no manual bot patching.  
**Dependencies:** after Phase 1 (grants migrate too).

**Work items:**

1. Document complete state: bots.json, messages.db, workspaces, config, devices.json, bridges.json, grants.
2. Host-relative workspace cwds — `server/bot-cwd.ts`, `server/store.ts`; eliminate Mac path rewrites.
3. Replace hardcoded Chief patches in `scripts/sync-openmausbot-data.mjs` with declarative `hostProfile`.
4. `export` / `import` commands + manifest; include companion data by default; align `scripts/backup-openmausbot-cloud.mjs`.
5. Bridge re-homing verify (URL follows hub).
6. Extend `scripts/audit-vps-bots.mjs` as post-import gate.
7. Runbook in `docs/cloud-vps-hosting.md`, `docs/vps-harness-deploy.md`.

**Exit criteria:** servarica → mini → servarica round trip; phone works without re-pair; audit passes.

---

### Phase 3 — Native switcher unification

**Goal:** One picker everywhere; room/global defaults; queued switch on busy bots.  
**Dependencies:** Phase 2 for cross-host testing.

**Work items:** Remove engine special-cases in `ChatModelPickerSheet.swift`; scoped defaults in `server/bot-model.ts`; queued busy switch; tests.

**Exit criteria:** switch codex/cursor/claude from phone on live hub; no engine names in iOS picker.

---

### Phase 4 — Desktop companion parity

**Goal:** Viewer = full peer client (send, steer, approve, rooms, VM, bridges).  
**Dependencies:** Phase 1 + 3.

**Work items:** Composer, rooms, Computer panel, bridge mgmt, shared picker in `viewer/`.

**Exit criteria:** daily session from viewer alone against Servarica.

---

### Phase 5 — Bridge Local VM completeness

**Goal:** Bridge pulls VM image; create/recreate works from VPS hub.  
**Dependencies:** Phase 1.

**Work items:** `bridge/src/local-vm.ts` image pull; relay progress in `server/bridge-local-vm.ts`.

**Exit criteria:** phone creates VM on mini bridge when image absent.

---

### Phase 6 — Closed-app push (APNs)

**Goal:** Approvals reach locked phone.  
**Dependencies:** Phase 1; Phase 2 for token migration.

**Work items:** per `docs/ios-push-apns.md`; sidecar sender; iOS registration + deep link.

**Exit criteria:** bridge approval push on locked phone works.

---

### Phase 7 — Grok parity closeout

**Goal:** Close `docs/ios-grok-parity-wave35.md`; freeze or extend reconstructed engine.  
**Dependencies:** Phase 3.

**Work items:** Wave §A routes; document reconstructed ceiling in `docs/grok-reconstructed.md`.

**Exit criteria:** checklist shipped or waived in docs.

---

## 6. Cross-phase dependencies

```text
Phase 1 ──┬──► Phase 4, 5, 6
Phase 2 ──────► Phase 6 (push tokens in archive)
Phase 3 ──────► Phase 4, 7
Phase 7 last
```

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Phase 1 breaks live mini bridge | Re-pair with explicit flags; verify before cutover |
| Approvals block overnight routines | Pre-grant scoped always-allow for known routines |
| Migration corrupts messages.db | WAL checkpoint; pre-restore copy; harness stopped during export |
| Concurrent agent deploys | git log + systemctl before deploy; phase branches |
| Bridge rotation bricks remote bridge | Heartbeat-carried token replacement |

---

## 8. Open decisions for Vincent

1. **Consent granularity** — per (bot, bridge) always-allow + optional cwd prefix (recommended).
2. **Grandfather existing bridge shell?** — recommend force re-pair (one bridge today).
3. **Hub identity** — keep `openmaus.posival.com` as permanent URL (recommended).
4. **Grok Reconstructed** — freeze as legacy; invest in native drivers (recommended).
5. **Token rotation** — heartbeat-carried replacement (recommended).
6. **Push payload** — bot name + kind only; no command text (recommended).

---

## 9. Codex session 1 scope

**Phase 1 items 1, 8, 9 + gitignore sweep** (no iOS yet):

1. Gitignore build debris.
2. Flip bridge capability defaults + docs.
3. Truncation flag end-to-end.
4. Tests + `node scripts/test-floor.mjs`.
5. Deploy Servarica; re-pair mini with `OMB_BRIDGE_SHELL=1 OMB_BRIDGE_LOCAL_VM=1`.

Session 2: approval broker + grants (items 2–4).  
Session 3: rotation/revoke + companion routes + iOS Bridges list (items 5–7).

---

## 10. Files to read first (in order)

1. `docs/v-bot-architecture.md`
2. `docs/ios-companion.md`
3. `docs/bridge-agent.md`
4. `server/bridge-routes.ts`, `server/bridge-registry.ts`, `server/bridge-exec.ts`
5. `bridge/src/index.ts`, `bridge/src/exec.ts`, `bridge/src/client.ts`
6. `server/drivers/agents-proxy.ts`
7. `server/auto-approve.ts`, `server/decision-log.ts`
8. `docs/cloud-vps-hosting.md`, `docs/vps-harness-deploy.md`
9. `scripts/sync-openmausbot-data.mjs`, `scripts/audit-vps-bots.mjs`
10. `server/bot-model.ts`, `ios/App/ChatModelPickerSheet.swift`
11. `docs/ios-grok-parity-wave35.md`
12. `companion/src/routes.ts`, `companion/src/proxy.ts`

---

## Live state (2026-08-29)

- Branch: `cursor/vps-turn-ready-cache-08ea` (deployed to Servarica)
- Chief Keef + Investments desk section fix applied on VPS
- Turn-ready VPS cache shipped (`server/vps-computer.ts`)
- iOS build 54 (model picker backdrop fix)
- Do not touch Oracle firewall; do not commit secrets
