#!/usr/bin/env node
// Deterministic loopback Hermes TUI gateway fixture for Wave 1 adapter tests.
// Implements only the tag-pinned v2026.8.31 line protocol: gateway.ready
// handshake (no initialize), profiles.list, session.list, session.resume,
// prompt.submit, and session.interrupt. Never reads a real home, account, key,
// or profile path.
//
//   FAKE_HERMES_MODE        happy (default) | hang | malformed-final |
//                           rpc-timeout | crash | protocol-fail |
//                           malformed-envelope | missing-profile |
//                           renamed-profile | renamed-named-profile |
//                           named-profile | state-unavailable |
//                           subagent | missing-cli | auth-fail
//   FAKE_HERMES_DELTAS      set to 1 to emit message.delta frames
//   FAKE_HERMES_DUMP        write { argv, env, pid } JSON for test assertions
//   FAKE_HERMES_RPC_LOG     append one JSON object per RPC method call
//
// Deterministic ids: default profile, session-root, session-tip, runtime-gen-N.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const defaultMode = process.env.FAKE_HERMES_MODE ?? "happy";
const protocol = process.env.FAKE_HERMES_PROTOCOL ?? "modern";
const emitDeltas = process.env.FAKE_HERMES_DELTAS === "1";
const PROFILE = "default";
const NAMED_PROFILE = "work";
const SESSION_ROOT = "session-root";
const SESSION_TIP = "session-tip";
const FIXTURE_REPLY = "fixture Hermes wave1 reply";
const FIXTURE_DELTA_PREFIX = "wave1-";
const HERMES_HOME = process.env.HERMES_HOME ?? "";

function readHomeMode(): string | undefined {
  if (!HERMES_HOME) return undefined;
  const modeFile = `${HERMES_HOME}/fixture-mode`;
  if (!existsSync(modeFile)) return undefined;
  const next = readFileSync(modeFile, "utf8").trim();
  return next || undefined;
}

function readHomeDeltas(): boolean {
  if (!HERMES_HOME) return emitDeltas;
  return emitDeltas || existsSync(`${HERMES_HOME}/fixture-deltas`);
}

function activeProtocol() {
  return process.env.FAKE_HERMES_PROTOCOL?.trim() || protocol;
}

function isLegacyProtocol() {
  return activeProtocol() === "legacy";
}

function activeMode() {
  const control = process.env.FAKE_HERMES_CONTROL_FILE
    ?? (HERMES_HOME ? `${HERMES_HOME}/mode-control.txt` : undefined);
  if (control && existsSync(control)) {
    const next = readFileSync(control, "utf8").trim();
    if (next) return next;
  }
  return readHomeMode() ?? defaultMode;
}

function startupMode() {
  return activeMode();
}

function profileForMode(mode: string): { name: string; isDefault: boolean } {
  if (mode === "named-profile") return { name: NAMED_PROFILE, isDefault: false };
  if (mode === "renamed-named-profile") return { name: "work-renamed", isDefault: false };
  if (mode === "renamed-profile") return { name: "profile-renamed", isDefault: true };
  return { name: PROFILE, isDefault: true };
}

function shouldEmitDeltas() {
  return readHomeDeltas();
}

const argv = process.argv.slice(2);
const allowedEnvKeys = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HERMES_HOME",
  "HERMES_PYTHON",
  "HERMES_PYTHON_SRC_ROOT",
  "HERMES_CWD",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "FAKE_HERMES_MODE",
  "FAKE_HERMES_DELTAS",
  "FAKE_HERMES_DUMP",
  "FAKE_HERMES_RPC_LOG",
  "FAKE_HERMES_CONTROL_FILE",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
];
const dumpEnv = Object.fromEntries(
  allowedEnvKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
const dumpPath = process.env.FAKE_HERMES_DUMP ?? (HERMES_HOME ? `${HERMES_HOME}/spawn-dump.json` : undefined);
const rpcLogPath = process.env.FAKE_HERMES_RPC_LOG ?? (HERMES_HOME ? `${HERMES_HOME}/rpc.ndjson` : undefined);

const isGatewayModule = argv.length === 0 || (argv[0] === "-m" && argv[1] === "tui_gateway.entry");
const isLegacyTui = argv[0] === "--tui";
const dumpArgv = isGatewayModule
  ? (argv.length === 0 ? ["-m", "tui_gateway.entry"] : argv)
  : argv;

if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify({ argv: dumpArgv, env: dumpEnv, pid: process.pid }, null, 2));
}

if (argv.includes("--version")) {
  process.stdout.write("2026.8.31-fixture\n");
  process.exit(0);
}


if (!isGatewayModule && !isLegacyTui) {
  process.exit(2);
}

const initialMode = startupMode();
if (initialMode === "missing-cli") {
  process.exit(127);
}

if (initialMode === "crash") {
  process.stderr.write("fixture crash before ready\n");
  process.exit(3);
}

const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const methodNotFound = (id: number) => {
  out({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
};
const logRpc = (method: string, params: unknown) => {
  if (!rpcLogPath) return;
  appendFileSync(rpcLogPath, `${JSON.stringify({ method, params, pid: process.pid })}\n`);
};

let runtimeCounter = 0;
let promptCounter = 0;
let interrupted = false;
let mintedCanonical = false;

function readMessageAgentTarget(): string {
  if (!HERMES_HOME) return "work";
  const path = `${HERMES_HOME}/fixture-message-agent-target`;
  if (!existsSync(path)) return "work";
  const next = readFileSync(path, "utf8").trim();
  return next || "work";
}

function dualProfileEnabled(): boolean {
  if (!HERMES_HOME) return false;
  return existsSync(`${HERMES_HOME}/fixture-dual-profile`);
}

setTimeout(() => {
  const mode = activeMode();
  if (mode === "protocol-fail") {
    process.stdout.write("{not-jsonrpc\n");
    return;
  }
  if (mode === "malformed-envelope") {
    out({ jsonrpc: "1.0", method: "event", params: { type: "gateway.ready", payload: { version: "2026.8.31-fixture" } } });
    return;
  }
  out({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { version: "2026.8.31-fixture" } } });
  out({ jsonrpc: "2.0", method: "event", params: { type: "status.update", session_id: "", payload: { text: "fixture-ready" } } });
}, 15);

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let request: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (!request.method || request.id === undefined) continue;
    logRpc(request.method, request.params ?? {});
    const mode = activeMode();

    if (mode === "rpc-timeout") {
      return;
    }

    if (request.method === "gateway.capabilities") {
      if (isLegacyProtocol()) {
        methodNotFound(request.id);
        return;
      }
      out({ jsonrpc: "2.0", id: request.id, result: { per_session_exclusive_submit: true } });
      return;
    }

    if (request.method === "groups.capabilities") {
      if (isLegacyProtocol()) {
        methodNotFound(request.id);
        return;
      }
      out({ jsonrpc: "2.0", id: request.id, result: { authority_epoch: 1, replicas: 1 } });
      return;
    }

    if (request.method === "setup.status") {
      if (mode === "auth-fail") {
        out({ jsonrpc: "2.0", id: request.id, result: { provider_configured: false } });
        return;
      }
      out({ jsonrpc: "2.0", id: request.id, result: { provider_configured: true } });
      return;
    }

    if (request.method === "cli.exec") {
      const argv = request.params?.argv;
      if (Array.isArray(argv) && argv[0] === "--version") {
        out({ jsonrpc: "2.0", id: request.id, result: { blocked: false, code: 0, output: "2026.8.31-fixture\n" } });
        return;
      }
      out({ jsonrpc: "2.0", id: request.id, result: { blocked: true, code: -1, output: "" } });
      return;
    }

    if (request.method === "profiles.list") {
      if (isLegacyProtocol()) {
        methodNotFound(request.id);
        return;
      }
      if (mode === "auth-fail") {
        out({ jsonrpc: "2.0", id: request.id, error: { code: 401, message: "token=/fixture/secret" } });
        return;
      }
      if (mode === "missing-profile") {
        out({ jsonrpc: "2.0", id: request.id, result: { profiles: [] } });
        return;
      }
      if (mode === "state-unavailable") {
        out({ jsonrpc: "2.0", id: request.id, result: { ok: false, profiles: [] } });
        return;
      }
      const { name: profileName, isDefault } = profileForMode(mode);
      const profiles = dualProfileEnabled()
        ? [
          {
            name: PROFILE,
            is_default: true,
            display_name: "Fixture Hermes",
            description: "Wave 2 default profile",
            model: "fixture-model",
            provider: "fixture-provider",
            path: "/must-not-leak/profile-path",
            ui_meta: { secret: "must-not-leak" },
          },
          {
            name: NAMED_PROFILE,
            is_default: false,
            display_name: "Fixture Work",
            description: "Wave 2 named profile",
            model: "fixture-model",
            provider: "fixture-provider",
            path: "/must-not-leak/work-profile-path",
            ui_meta: { secret: "must-not-leak" },
          },
        ]
        : [{
          name: profileName,
          is_default: isDefault,
          display_name: "Fixture Hermes",
          description: "Wave 1 deterministic profile",
          model: "fixture-model",
          provider: "fixture-provider",
          path: "/must-not-leak/profile-path",
          ui_meta: { secret: "must-not-leak" },
        }];
      out({
        jsonrpc: "2.0",
        id: request.id,
        result: { profiles },
      });
      return;
    }

    if (request.method === "session.list") {
      const params = request.params ?? {};
      if (isLegacyProtocol()) {
        if (params.limit !== undefined && params.limit !== 200) {
          out({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid lookup" } });
          return;
        }
      } else if (params.title !== "Bot Chat" || params.include_hidden !== true || params.limit !== 200) {
        out({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid lookup" } });
        return;
      }
      if (mode === "protocol-fail") {
        out({ jsonrpc: "2.0", id: request.id, error: { code: 500, message: "state.db unreadable at /fixture/state.db" } });
        return;
      }
      if (mode === "mint-on-absent" && !mintedCanonical) {
        out({ jsonrpc: "2.0", id: request.id, result: { sessions: [] } });
        return;
      }
      out({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          sessions: [{
            id: SESSION_ROOT,
            resolved_id: SESSION_TIP,
            title: "Bot Chat",
            hidden: true,
            source: "tui",
            message_count: 3,
            preview: "fixture preview",
          }],
        },
      });
      return;
    }

    if (request.method === "session.create") {
      mintedCanonical = true;
      if (isLegacyProtocol()) {
        out({ jsonrpc: "2.0", id: request.id, result: { session_id: "runtime-minted", info: { model: "fixture-model" } } });
        return;
      }
      out({ jsonrpc: "2.0", id: request.id, result: { session_id: "runtime-minted" } });
      return;
    }

    if (request.method === "session.title") {
      out({ jsonrpc: "2.0", id: request.id, result: { title: request.params?.title ?? "", session_key: SESSION_ROOT } });
      return;
    }

    if (request.method === "session.close") {
      out({ jsonrpc: "2.0", id: request.id, result: { closed: true } });
      return;
    }

    if (request.method === "session.resume") {
      runtimeCounter += 1;
      const runtimeId = `runtime-gen-${runtimeCounter}`;
      out({ jsonrpc: "2.0", id: request.id, result: { session_id: runtimeId, session_key: "must-not-use" } });
      return;
    }

    if (request.method === "prompt.submit") {
      promptCounter += 1;
      out({ jsonrpc: "2.0", id: request.id, result: { accepted: true } });
      if (mode === "hang") {
        return;
      }
      if (mode === "crash-mid-turn") {
        setTimeout(() => {
          process.stderr.write("fixture crash mid-turn\n");
          process.exit(4);
        }, 10);
        return;
      }
      const runtimeId = `runtime-gen-${runtimeCounter}`;
      setTimeout(() => {
        out({ jsonrpc: "2.0", method: "event", params: { type: "message.start", session_id: runtimeId } });
        if (shouldEmitDeltas()) {
          out({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: runtimeId, payload: { text: `${FIXTURE_DELTA_PREFIX}hel` } } });
        }
        if (mode === "message-agent") {
          out({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "tool.start",
              session_id: runtimeId,
              payload: {
                name: "message_agent",
                arguments: {
                  target: readMessageAgentTarget(),
                  message: "fixture teammate ping",
                },
              },
            },
          });
          out({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "tool.complete",
              session_id: runtimeId,
              payload: {
                name: "message_agent",
                arguments: {
                  target: readMessageAgentTarget(),
                  message: "fixture teammate ping",
                },
                ok: true,
                status: "complete",
              },
            },
          });
        }
        if (mode === "subagent") {
          out({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "agent.started",
              session_id: runtimeId,
              payload: {
                id: "moa-temp-live-fixture",
                name: "Fixture reviewer",
                kind: "temporary",
              },
            },
          });
        }
        if (mode === "approval-ask") {
          out({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "approval.pending",
              session_id: runtimeId,
              payload: {
                request_id: "req-fixture-1",
                tool: "shell",
                summary: "Run a command",
              },
            },
          });
          return;
        }
        if (mode === "malformed-final") {
          out({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: runtimeId, payload: { status: "complete" } } });
          return;
        }
        const text = interrupted ? "interrupted" : FIXTURE_REPLY;
        out({
          jsonrpc: "2.0",
          method: "event",
          params: {
            type: "message.complete",
            session_id: runtimeId,
            payload: {
              text,
              status: interrupted ? "interrupted" : "complete",
              usage: { input: 4, output: 2 },
            },
          },
        });
      }, shouldEmitDeltas() ? 35 : 25);
      return;
    }

    if (request.method === "session.interrupt") {
      interrupted = true;
      out({ jsonrpc: "2.0", id: request.id, result: { status: "interrupted" } });
      const runtimeId = `runtime-gen-${runtimeCounter}`;
      setTimeout(() => {
        out({
          jsonrpc: "2.0",
          method: "event",
          params: {
            type: "message.complete",
            session_id: runtimeId,
            payload: { text: "interrupted", status: "interrupted" },
          },
        });
      }, 10);
      return;
    }

    if (request.method === "approval.respond") {
      out({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      if (activeMode() === "approval-ask") {
        const runtimeId = `runtime-gen-${runtimeCounter}`;
        setTimeout(() => {
          out({
            jsonrpc: "2.0",
            method: "event",
            params: {
              type: "message.complete",
              session_id: runtimeId,
              payload: {
                text: FIXTURE_REPLY,
                status: "complete",
                usage: { input: 4, output: 2 },
              },
            },
          });
        }, 10);
      }
      return;
    }
  }
});
