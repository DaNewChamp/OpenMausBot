# First-party V Bot connector for Hermes

This connector lets a local Hermes profile call approved V Bot tools through the paired bridge. Traffic stays on a Unix socket or `127.0.0.1`. Hermes never receives the hub device token, provider credentials, or Docker/socket access.

Hermes discovers tools from `mcp_servers` in that profile's `config.yaml`. The installer writes that first-party key. It does not rely on a JSON `mcpServers` sidecar as the Hermes config surface.

## One-click setup

On the paired computer, after the V Bot bridge is running with Hermes enabled:

```sh
node dist-bridge/index.js hermes-connector-install --hub "Mac mini" --bot-scope <bot-id> --profile default
```

Named profiles use `--profile <slug>` (Hermes home `profiles/<slug>`) or `--profile-home <dir>` for an explicit profile directory. Re-running the same bot and profile updates the existing `vbot` entry. Binding a second bot to the same profile, or the same bot to a second profile, is rejected.

The installer writes only:

- socket path
- bot scope
- hub display name
- profile slug

It does not write tokens, `HERMES_HOME`, or hostnames of production hubs. After install, reload Hermes MCP (`/reload-mcp` or restart that profile) so it picks up `mcp_servers.vbot`.

## Manual fallback

If you need to register the stdio facade yourself, add this to the profile `config.yaml` Hermes actually reads:

```yaml
mcp_servers:
  vbot:
    command: node
    args:
      - dist-bridge/index.js
      - hermes-mcp
      - --socket
      - /path/to/vbot.sock
      - --bot-scope
      - <bot-id>
```

Or run the facade directly:

```sh
node dist-bridge/index.js hermes-mcp --socket /path/to/vbot.sock --bot-scope <bot-id>
```

Do not put a hub URL, bearer token, or provider key in argv, env, or config. Do not use a JSON `mcpServers` file as the Hermes config path.

The facade proxies only the tools already exposed by V Bot's agents proxy: roster, messaging, delegation, runtime conversion, rooms, routines, skills, and scoped computer commands. Unsupported Hermes features stay unavailable.
