import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

describe("Hermes V Bot MCP facade", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stdio argv includes only the socket location and bot scope", async () => {
    const { mcpFacadeArgv, parseMcpFacadeArgv, HERMES_VBOT_ALLOWED_TOOLS } = await import("./hermes-vbot-mcp.ts");
    const argv = mcpFacadeArgv({ socketPath: "/tmp/vbot.sock", botScope: "bot-1" });
    expect(argv).toEqual(expect.arrayContaining(["--socket", "/tmp/vbot.sock", "--bot-scope", "bot-1"]));
    expect(argv.join(" ")).not.toMatch(/token|OMB_COMMS|Bearer/i);
    expect(parseMcpFacadeArgv(argv)).toEqual({ socketPath: "/tmp/vbot.sock", botScope: "bot-1" });
    expect(() => parseMcpFacadeArgv(["--socket", "/tmp/vbot.sock", "--bot-scope", "bot-1", "--token", "secret"])).toThrow(/hub credentials/i);
    expect(HERMES_VBOT_ALLOWED_TOOLS).toContain("configure_bot_runtime");
    expect(HERMES_VBOT_ALLOWED_TOOLS).not.toContain("docker");
    expect(HERMES_VBOT_ALLOWED_TOOLS).not.toContain("computer");
  });

  it("adopts an existing Hermes connector entry instead of duplicating it", async () => {
    const { installHermesVbotConnector } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-setup-"));
    dirs.push(dir);
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "vbot": { command: "old", args: ["--socket", "/old.sock"] },
      },
    }));
    const first = installHermesVbotConnector({
      configPath,
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-1",
      hubDisplayName: "Mac mini",
    });
    const second = installHermesVbotConnector({
      configPath,
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
    });
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(["vbot"]);
    expect(first.adopted).toBe(false);
    expect(second.adopted).toBe(true);
    expect(parsed.mcpServers.vbot?.args).toEqual(expect.arrayContaining(["--bot-scope", "bot-chief"]));
    expect(JSON.stringify(parsed)).not.toMatch(/token|OMB_COMMS|openmaus\.posival/i);
  });

  it("redacts secrets from facade stdout", async () => {
    const { formatMcpLog } = await import("./hermes-vbot-mcp.ts");
    const line = formatMcpLog("connected token=sk-ant-secret-value-123456 HERMES_HOME=/Users/vincent/.hermes");
    expect(line).not.toMatch(/sk-ant-secret-value-123456|\/Users\/vincent/i);
  });

  it("installs a real node CLI instead of a missing vbot-hermes-mcp binary", async () => {
    const { installHermesVbotConnector, hermesVbotMcpLaunchSpec } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-setup-"));
    dirs.push(dir);
    const configPath = join(dir, "mcp.json");
    const socketPath = join("/Users", "vincent", ".openmausbot-bridge", "vbot.sock");
    const launch = hermesVbotMcpLaunchSpec({
      cliPath: "/opt/vbot/dist-bridge/index.js",
      socketPath,
      botScope: "bot-chief",
      execPath: "/usr/bin/node",
      execArgv: [],
    });
    const result = installHermesVbotConnector({
      configPath,
      socketPath,
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
      command: launch.command,
      args: launch.args,
    });
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    expect(result.adopted).toBe(false);
    expect(parsed.mcpServers.vbot?.command).toBe("/usr/bin/node");
    expect(parsed.mcpServers.vbot?.command).not.toBe("vbot-hermes-mcp");
    expect(parsed.mcpServers.vbot?.args).toEqual(expect.arrayContaining([
      "/opt/vbot/dist-bridge/index.js",
      "hermes-mcp",
      "--socket",
      socketPath,
      "--bot-scope",
      "bot-chief",
    ]));
    expect(JSON.stringify(parsed)).not.toMatch(/token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i);
    expect(parsed.mcpServers.vbot?.env).toBeUndefined();
  });

  it("refuses secret-shaped installer argv and config while allowing a Unix home socket", async () => {
    const { installHermesVbotConnector } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-setup-"));
    dirs.push(dir);
    expect(() => installHermesVbotConnector({
      configPath: join(dir, "ok.json"),
      socketPath: join("/Users", "vincent", ".openmausbot-bridge", "vbot.sock"),
      botScope: "bot-1",
      hubDisplayName: "Mac mini",
    })).not.toThrow();
    expect(() => installHermesVbotConnector({
      configPath: join(dir, "token.json"),
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-1",
      hubDisplayName: "token-hub",
    })).toThrow(/secret-shaped/i);
    expect(() => installHermesVbotConnector({
      configPath: join(dir, "home.json"),
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-1",
      hubDisplayName: "Mac mini",
      args: ["--socket", "/tmp/vbot.sock", "--token", "secret"],
    })).toThrow(/secret-shaped|hub credentials/i);
    expect(() => installHermesVbotConnector({
      configPath: join(dir, "key.json"),
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-1",
      hubDisplayName: "Mac mini",
      args: ["--socket", "/tmp/vbot.sock", "--bot-scope", "sk-ant-secret-value-123456"],
    })).toThrow(/secret-shaped/i);
  });

  it("loads the peer credential from the bridge identity file rather than argv", async () => {
    const { peerCredentialFromBridgeIdentity, parseInstalledHermesVbotConnector } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-setup-"));
    dirs.push(dir);
    const credentialsPath = join(dir, "credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({
      url: "http://127.0.0.1:8799",
      bridgeId: "bridge-mini",
      bridgeToken: "bridge-token-secret",
      name: "Mac mini",
    }));
    expect(peerCredentialFromBridgeIdentity(credentialsPath)).toBe("bridge-mini");
    const configPath = join(dir, "hermes-vbot-mcp.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        vbot: {
          command: "/usr/bin/node",
          args: ["index.js", "hermes-mcp", "--socket", "/tmp/vbot.sock", "--bot-scope", "bot-chief"],
          metadata: { hub: "Mac mini", profile: "vbot" },
        },
      },
    }));
    expect(parseInstalledHermesVbotConnector(configPath)).toEqual({
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
    });
  });

  it("executes tools/call through the approved facade instead of a blanket tool unavailable stub", async () => {
    const { createHermesVbotDaemonHandler, HERMES_VBOT_ALLOWED_TOOLS } = await import("./hermes-vbot-mcp.ts");
    const { startHermesVbotConnector, connectHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-mcp-call-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const server = await startHermesVbotConnector({
      listen: { socketPath },
      peerCredential: "bridge-mini",
      botScope: "bot-chief",
      handler: createHermesVbotDaemonHandler({
        executeTool: async (name, args) => {
          if (name === "list_bots") {
            return { text: `Other bots you can message with ask_bot:\n- Chief [id: bot-chief]` };
          }
          return { text: `fixture saw ${name} ${JSON.stringify(args)}` };
        },
      }),
    });
    const client = await connectHermesVbotConnector({
      socketPath,
      peerCredential: "bridge-mini",
      botScope: "bot-chief",
    });
    const listed = await client.request("tools/list");
    expect(JSON.stringify(listed)).toMatch(/list_bots/);
    expect(listed).not.toHaveProperty("result");
    expect((listed as { tools?: unknown[] }).tools).toHaveLength(HERMES_VBOT_ALLOWED_TOOLS.length);
    const called = await client.request("tools/call", { name: "list_bots", arguments: {} });
    const calledText = JSON.stringify(called);
    expect(calledText).not.toMatch(/tool unavailable/i);
    expect(calledText).toMatch(/Chief \[id: bot-chief\]/);
    const unknown = await client.request("tools/call", { name: "docker", arguments: {} });
    const unknownText = JSON.stringify(unknown);
    expect(unknownText).not.toMatch(/tool unavailable/i);
    expect(unknownText).toMatch(/Unknown tool: docker/);
    client.close();
    await server.close();
  });

  it("proves the stdio facade reaches a live connector and returns registered tool results", async () => {
    const { createHermesVbotDaemonHandler, runHermesVbotMcpStdio } = await import("./hermes-vbot-mcp.ts");
    const { startHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-mcp-stdio-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const credentialsPath = join(dir, "credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ bridgeId: "bridge-mini", bridgeToken: "fixture-only" }));
    const server = await startHermesVbotConnector({
      listen: { socketPath },
      peerCredential: "bridge-mini",
      botScope: "bot-chief",
      handler: createHermesVbotDaemonHandler({
        executeTool: async (name) => ({ text: `fixture result for ${name}` }),
      }),
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const output: string[] = [];
    stdout.on("data", (chunk) => output.push(String(chunk)));
    const run = runHermesVbotMcpStdio({
      argv: ["--socket", socketPath, "--bot-scope", "bot-chief"],
      credentialsPath,
      stdin,
      stdout,
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } })}\n`);
    const deadline = Date.now() + 5_000;
    while (!output.join("").includes("fixture result for list_bots") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stdin.end();
    await run;
    await server.close();
    const text = output.join("");
    expect(text).toMatch(/"id":2/);
    expect(text).toMatch(/list_bots/);
    expect(text).toMatch(/fixture result for list_bots/);
    expect(text).not.toMatch(/tool unavailable/i);
  });

  it("fails closed honestly when the approved facade is unconfigured", async () => {
    const { createHermesVbotDaemonHandler } = await import("./hermes-vbot-mcp.ts");
    const handler = createHermesVbotDaemonHandler();
    const result = await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "list_bots", arguments: {} },
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/tool unavailable/i);
    expect(text).toMatch(/unconfigured/i);
    expect(text).toMatch(/list_bots|tool facade/i);
  });

  it("fails closed honestly when hub credentials are absent from the env executor", async () => {
    const { createHermesVbotEnvToolExecutor } = await import("./hermes-vbot-mcp.ts");
    const execute = createHermesVbotEnvToolExecutor({ PATH: "/usr/bin" });
    const result = await execute("list_bots", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unconfigured/i);
    expect(result.text).not.toMatch(/tool unavailable/i);
    expect(JSON.stringify(result)).not.toMatch(/token|OMB_COMMS|Bearer|sk-/i);
  });
});
