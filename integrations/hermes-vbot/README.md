# First-party V Bot connector for Hermes

This connector lets a local Hermes profile call approved V Bot tools through the paired bridge. Traffic stays on a Unix socket or `127.0.0.1`. Hermes never receives the hub device token, provider credentials, or Docker/socket access.

## One-click setup

On the paired computer, after the V Bot bridge is running with Hermes enabled:

```sh
node dist-bridge/index.js hermes-connector-install --hub "Mac mini" --bot-scope <bot-id>
```

Re-running updates the existing `vbot` MCP entry. It does not create a second one.

The installer writes only:

- socket path
- bot scope
- hub display name

It does not write tokens, `HERMES_HOME`, or hostnames of production hubs.

## Manual fallback

If you need to register the stdio facade yourself, point Hermes at the compiled bridge CLI with socket and scope only:

```sh
node dist-bridge/index.js hermes-mcp --socket /path/to/vbot.sock --bot-scope <bot-id>
```

Do not put a hub URL, bearer token, or provider key in argv, env, or `mcp.json`.

The facade proxies only the tools already exposed by V Bot's agents proxy: roster, messaging, delegation, runtime conversion, rooms, routines, skills, and scoped computer commands. Unsupported Hermes features stay unavailable.
