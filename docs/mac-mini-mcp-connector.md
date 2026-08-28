# Mac mini MCP connector (Cloud Agents)

Cloud Agents in this repo can drive iOS builds through the **Mac Projects MCP** on Vincent's Mac mini. The mini SSH-hops to the MacBook for Xcode/device work (`scripts/install-ios-via-macbook-hop.sh`).

## Architecture

```text
Cursor Cloud Agent (this VM)
       │  HTTPS + PocketID OAuth
       ▼
https://local.posival.com/mcp   (Cloudflare tunnel)
       │
       ▼
Mac mini 127.0.0.1:7337  (mac-projects-mcp, profile=primary, auth required)
       │  SSH (run_shell / ios_* tools)
       ▼
MacBook  →  Xcode / devicectl  →  paired iPhone
```

| Host | Address | Role |
| --- | --- | --- |
| Mac mini | `vincents.mac.mini.m4.wired.lan` / `192.168.112.112`, user `vincent` | Always-on MCP server + tunnel connector |
| MacBook | `vincents.macbook.pro.lan` / `192.168.112.99`, user `vincent` | Xcode builds and device install |
| MCP source (mini) | `/Users/Vincent/Projects/mac-projects-mcp` | Standalone; not in this repo |

**Important:** Cloud Agent VMs cannot reach the mini on the LAN. Only the public tunnel URL works. SSH keys on the cloud VM are not used for the mini hop; the mini's MCP `run_shell` tool performs SSH to the MacBook.

## Repo wiring (committed)

| File | Purpose |
| --- | --- |
| [`.cursor/mcp.json`](../.cursor/mcp.json) | Declares remote MCP `Mac-Mini` → `https://local.posival.com/mcp` with OAuth scopes |
| [`.cursor/environment.json`](../.cursor/environment.json) | Allowlists the MCP URL/command for environment policy; runs `pnpm install` on boot |
| [`scripts/verify-mac-mini-mcp-tunnel.sh`](../scripts/verify-mac-mini-mcp-tunnel.sh) | Smoke test (expects HTTP 401 without auth) |
| [`scripts/install-ios-via-macbook-hop.sh`](../scripts/install-ios-via-macbook-hop.sh) | Shell script the agent can invoke via MCP `run_shell` on the mini |

## One-time setup (Vincent)

OAuth blocks unattended first connect. Do this once so future Cloud Agents can call the mini.

### 1. Register Cursor's OAuth redirect in PocketID (if not already)

Cursor Cloud Agents use:

```text
https://www.cursor.com/agents/mcp/oauth/callback
```

Ensure PocketID / `brain.posival.com` allows that redirect URI for MCP clients connecting to resource `https://local.posival.com/`.

Authorization server: `https://brain.posival.com`  
Scopes: `openid profile email`

### 2. Add the MCP server in Cursor Dashboard (recommended for Cloud Agents)

1. Open [Cursor Dashboard → Integrations & MCP](https://cursor.com/dashboard/integrations).
2. Add a **custom HTTP MCP server**:
   - **Name:** `Mac-Mini`
   - **URL:** `https://local.posival.com/mcp`
   - **Auth:** OAuth (Cursor handles dynamic client registration against PocketID)
3. When prompted, complete PocketID login (passkey). Cursor stores refresh tokens per team/user.

> Cloud Agents on Team plans inherit team MCP servers from the dashboard. Repo [`.cursor/mcp.json`](../.cursor/mcp.json) documents the same server for IDE/CLI parity; dashboard registration is what makes OAuth persist across ephemeral agent VMs.

### 3. (Optional) Environment secret for bearer-token fallback

If dashboard OAuth is unavailable, obtain a PocketID access token manually and add a Cloud Agent environment secret:

| Secret | Purpose |
| --- | --- |
| `MAC_MINI_MCP_TOKEN` | Bearer token for `Authorization: Bearer …` |

Then extend [`.cursor/mcp.json`](../.cursor/mcp.json) locally (do **not** commit the token):

```json
{
  "mcpServers": {
    "Mac-Mini": {
      "url": "https://local.posival.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MAC_MINI_MCP_TOKEN}"
      }
    }
  }
}
```

Tokens expire; prefer dashboard OAuth when possible.

### 4. Verify from a fresh Cloud Agent

```bash
./scripts/verify-mac-mini-mcp-tunnel.sh
```

In the agent MCP dropdown, confirm **Mac-Mini** is connected. Test with `system_info` or `mcp_doctor`.

## iOS build hop (agent workflow)

After MCP is connected, install to the paired iPhone on branch `cursor/build-36-local-vm-phone-a27c`:

```bash
# Via Mac-Mini MCP tool run_shell (runs ON the mini):
BRANCH=cursor/build-36-local-vm-phone-a27c \
DEVICE_UDID=00008150-001428C00247801C \
bash ~/Github/OpenMausBot/scripts/install-ios-via-macbook-hop.sh
```

Or call MCP tool `ios_device_build_run` directly when parameters match the OpenMausBot iOS project.

## Key MCP tools

| Tool | Use |
| --- | --- |
| `run_shell` | Run commands on mini; SSH to MacBook for builds |
| `ios_device_build_run` | Build + install to physical device via MacBook |
| `ios_device_list` | List connected devices |
| `mcp_doctor` | Health check for MCP + CUA subsystems |
| `system_info` | Confirm which host answered |

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| HTTP 401 from tunnel | Normal without auth; complete dashboard OAuth |
| HTTP 530 / 1033 from tunnel | Cloudflared connector down on mini — restart `com.vincent.mac-projects-mcp-tunnel` LaunchAgent |
| MCP missing in agent | Not registered in Dashboard → Integrations & MCP, or environment allowlist blocks it |
| `run_shell` SSH fails on mini | MacBook offline or stale `~/.ssh/config` Host entry; script tries MagicDNS then `192.168.112.99` |
| LAN SSH to `192.168.112.112` from Cloud Agent | Expected failure — use tunnel MCP only |

## Local IDE setup

Same [`.cursor/mcp.json`](../.cursor/mcp.json). First connect opens browser OAuth (`http://localhost:8787/callback` on desktop). Alternative stdio proxy:

```json
{
  "mcpServers": {
    "Mac-Mini": {
      "command": "npx",
      "args": [
        "-y",
        "@automattic/mcp-remote@latest",
        "https://local.posival.com/mcp",
        "--transport",
        "http-only"
      ]
    }
  }
}
```
