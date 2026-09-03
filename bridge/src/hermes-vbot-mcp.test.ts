import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parse as parseYaml } from "yaml";
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
        "vbot": { command: "old", args: ["--socket", "/old.sock", "--bot-scope", "bot-1"] },
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
      botScope: "bot-1",
      hubDisplayName: "Mac mini",
    });
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(["vbot"]);
    expect(first.adopted).toBe(false);
    expect(second.adopted).toBe(true);
    expect(parsed.mcpServers.vbot?.args).toEqual(expect.arrayContaining(["--bot-scope", "bot-1"]));
    expect(JSON.stringify(parsed)).not.toMatch(/token|OMB_COMMS|openmaus\.posival/i);
  });

  it("rejects a second bot on the same Hermes profile instead of cross-scoping", async () => {
    const { installHermesVbotConnector } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-setup-"));
    dirs.push(dir);
    const configPath = join(dir, "mcp.json");
    installHermesVbotConnector({
      configPath,
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-1",
      profile: "default",
      hubDisplayName: "Mac mini",
    });
    expect(() => installHermesVbotConnector({
      configPath,
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      profile: "default",
      hubDisplayName: "Mac mini",
    })).toThrow(/scope|conflict|already bound/i);
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    expect(parsed.mcpServers.vbot?.args).toEqual(expect.arrayContaining(["--bot-scope", "bot-1"]));
    expect(JSON.stringify(parsed)).not.toMatch(/token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i);
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
    expect(parseInstalledHermesVbotConnector(configPath)).toEqual(expect.objectContaining({
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
    }));
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
    const tools = (listed as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }).tools;
    for (const tool of tools) {
      expect(tool.description?.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    expect(tools.find((tool) => tool.name === "list_bots")).toEqual({
      name: "list_bots",
      description:
        "List the other bots (agents) in your OpenMausBot section you can message, with their model and whether they're busy. Call this before ask_bot or delegate_bot to discover who's available.",
      inputSchema: { type: "object", properties: {} },
    });
    expect(tools.find((tool) => tool.name === "ask_bot")?.inputSchema).toEqual({
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    });
    expect(tools.find((tool) => tool.name === "configure_bot_runtime")).toMatchObject({
      name: "configure_bot_runtime",
      description: expect.stringContaining("Convert a teammate"),
      inputSchema: {
        type: "object",
        required: ["bot_id", "placement"],
        properties: {
          bot_id: { type: "string" },
          placement: { type: "string", enum: ["provider", "local", "bridge"] },
        },
      },
    });
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

  it("keeps concurrent env-executor credentials isolated without mutating process.env", async () => {
    const { createServer } = await import("node:http");
    const { createHermesVbotEnvToolExecutor } = await import("./hermes-vbot-mcp.ts");
    const previous = {
      OMB_HARNESS_URL: process.env.OMB_HARNESS_URL,
      OMB_COMMS_TOKEN: process.env.OMB_COMMS_TOKEN,
      OMB_BOT_ID: process.env.OMB_BOT_ID,
    };
    process.env.OMB_HARNESS_URL = "http://127.0.0.1:1";
    process.env.OMB_COMMS_TOKEN = "global-must-not-win";
    process.env.OMB_BOT_ID = "global-bot";

    const seen: Record<"a" | "b", { auth?: string; url?: string }> = { a: {}, b: {} };
    const listen = async (label: "a" | "b") => {
      const server = createServer((req, res) => {
        seen[label].auth = req.headers.authorization;
        seen[label].url = String(req.url);
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ bots: [{ id: `peer-${label}`, name: label, model: "x" }] }));
        }, 80);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected tcp address");
      return { server, url: `http://127.0.0.1:${address.port}` };
    };

    const a = await listen("a");
    const b = await listen("b");
    const envA = {
      OMB_HARNESS_URL: a.url,
      OMB_COMMS_TOKEN: "secret-a",
      OMB_BOT_ID: "bot-a",
    };
    const envB = {
      OMB_HARNESS_URL: b.url,
      OMB_COMMS_TOKEN: "secret-b",
      OMB_BOT_ID: "bot-b",
    };
    try {
      const execA = createHermesVbotEnvToolExecutor(envA);
      const execB = createHermesVbotEnvToolExecutor(envB);
      envA.OMB_COMMS_TOKEN = "mutated-after-factory-a";
      envB.OMB_COMMS_TOKEN = "mutated-after-factory-b";
      const [resultA, resultB] = await Promise.all([execA("list_bots", {}), execB("list_bots", {})]);
      expect(resultA.isError).not.toBe(true);
      expect(resultB.isError).not.toBe(true);
      expect(seen.a.auth).toBe("Bearer secret-a");
      expect(seen.b.auth).toBe("Bearer secret-b");
      expect(seen.a.url).toContain("self=bot-a");
      expect(seen.b.url).toContain("self=bot-b");
      expect(process.env.OMB_HARNESS_URL).toBe("http://127.0.0.1:1");
      expect(process.env.OMB_COMMS_TOKEN).toBe("global-must-not-win");
      expect(process.env.OMB_BOT_ID).toBe("global-bot");
      expect(JSON.stringify(resultA)).not.toMatch(
        /secret-a|secret-b|mutated-after-factory|global-must-not-win|OMB_COMMS_TOKEN/i,
      );
      expect(JSON.stringify(resultB)).not.toMatch(
        /secret-a|secret-b|mutated-after-factory|global-must-not-win|OMB_COMMS_TOKEN/i,
      );
    } finally {
      if (previous.OMB_HARNESS_URL === undefined) delete process.env.OMB_HARNESS_URL;
      else process.env.OMB_HARNESS_URL = previous.OMB_HARNESS_URL;
      if (previous.OMB_COMMS_TOKEN === undefined) delete process.env.OMB_COMMS_TOKEN;
      else process.env.OMB_COMMS_TOKEN = previous.OMB_COMMS_TOKEN;
      if (previous.OMB_BOT_ID === undefined) delete process.env.OMB_BOT_ID;
      else process.env.OMB_BOT_ID = previous.OMB_BOT_ID;
      await Promise.all([
        new Promise<void>((resolve, reject) => a.server.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => b.server.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });

  it("tools/list returns the real agents-proxy schema, not name-only stubs", async () => {
    const { createHermesVbotDaemonHandler, HERMES_VBOT_ALLOWED_TOOLS } = await import("./hermes-vbot-mcp.ts");
    const listed = await createHermesVbotDaemonHandler()({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
    });
    const tools = (listed.result as {
      tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...HERMES_VBOT_ALLOWED_TOOLS]);
    expect(tools).toHaveLength(HERMES_VBOT_ALLOWED_TOOLS.length);
    for (const tool of tools) {
      expect(tool.description?.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    expect(tools.find((tool) => tool.name === "list_bots")).toEqual({
      name: "list_bots",
      description:
        "List the other bots (agents) in your OpenMausBot section you can message, with their model and whether they're busy. Call this before ask_bot or delegate_bot to discover who's available.",
      inputSchema: { type: "object", properties: {} },
    });
    expect(tools.find((tool) => tool.name === "ask_bot")?.inputSchema).toEqual({
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    });
    expect(tools.find((tool) => tool.name === "configure_bot_runtime")).toEqual({
      name: "configure_bot_runtime",
      description:
        "Convert a teammate between a provider engine and a native Hermes profile on a paired computer. Autonomous calls wait for the user's approval. Never include tokens, secret paths, or session ids.",
      inputSchema: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "The teammate's id (from list_bots)." },
          placement: { type: "string", enum: ["provider", "local", "bridge"], description: "Destination runtime kind." },
          instance_id: { type: "string", description: "Provider instance id when placement is provider." },
          model: { type: "string", description: "Optional provider model id." },
          profile: { type: "string", description: "Hermes profile slug when placement is local or bridge." },
          bridge_id: { type: "string", description: "Paired computer/bridge id when placement is bridge." },
          context_mode: { type: "string", enum: ["summary", "none"], description: "Whether to send a sanitized handoff summary." },
        },
        required: ["bot_id", "placement"],
      },
    });
  });
});

describe("Hermes profile mcp_servers registration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function profileHome(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `vbot-hermes-${label}-`));
    dirs.push(dir);
    const hermesHome = join(dir, "hermes-home");
    mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
    return hermesHome;
  }

  it("writes mcp_servers into the profile config.yaml Hermes reads, not a secret-bearing sidecar-only shape", async () => {
    const {
      hermesProfileConfigPath,
      installHermesVbotConnector,
      hermesVbotMcpLaunchSpec,
    } = await import("./hermes-vbot-mcp.ts");
    const hermesHome = profileHome("yaml");
    const sidecarPath = join(hermesHome, "..", "hermes-vbot-mcp.json");
    const launch = hermesVbotMcpLaunchSpec({
      cliPath: "/opt/vbot/dist-bridge/index.js",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      execPath: "/usr/bin/node",
      execArgv: [],
    });
    writeFileSync(join(hermesHome, "config.yaml"), "model:\n  default: z-ai/glm-5.2\n");
    const result = installHermesVbotConnector({
      configPath: sidecarPath,
      hermesHome,
      profile: "default",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
      command: launch.command,
      args: launch.args,
    });
    const yamlPath = hermesProfileConfigPath(hermesHome);
    expect(yamlPath).toBe(join(hermesHome, "config.yaml"));
    expect(result.hermesConfigPath).toBe(yamlPath);
    const text = readFileSync(yamlPath, "utf8");
    const parsed = parseYaml(text) as {
      model?: { default?: string };
      mcp_servers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
      mcpServers?: unknown;
    };
    expect(parsed.model).toEqual({ default: "z-ai/glm-5.2" });
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.mcp_servers?.vbot?.command).toBe("/usr/bin/node");
    expect(parsed.mcp_servers?.vbot?.args).toEqual(expect.arrayContaining([
      "/opt/vbot/dist-bridge/index.js",
      "hermes-mcp",
      "--socket",
      "/tmp/vbot.sock",
      "--bot-scope",
      "bot-chief",
    ]));
    expect(parsed.mcp_servers?.vbot?.env).toBeUndefined();
    expect(text).not.toMatch(/mcpServers|token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i);
    expect(JSON.stringify(result)).not.toMatch(/token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i);
    expect(launch.args.join(" ")).not.toMatch(/token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i);
  });

  it("registers isolated per-profile bot scopes and rejects a bot already bound to another profile", async () => {
    const { installHermesVbotConnector, hermesProfileConfigPath } = await import("./hermes-vbot-mcp.ts");
    const root = mkdtempSync(join(tmpdir(), "vbot-hermes-profiles-"));
    dirs.push(root);
    const sidecarPath = join(root, "hermes-vbot-mcp.json");
    const defaultHome = join(root, "default");
    const coderHome = join(root, "profiles", "coder");
    mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
    mkdirSync(coderHome, { recursive: true, mode: 0o700 });
    installHermesVbotConnector({
      configPath: sidecarPath,
      hermesHome: defaultHome,
      profile: "default",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
    });
    installHermesVbotConnector({
      configPath: sidecarPath,
      hermesHome: coderHome,
      profile: "coder",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-research",
      hubDisplayName: "Mac mini",
    });
    expect(() => installHermesVbotConnector({
      configPath: sidecarPath,
      hermesHome: coderHome,
      profile: "coder",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
    })).toThrow(/scope|conflict|already bound/i);
    const defaultYaml = parseYaml(readFileSync(hermesProfileConfigPath(defaultHome), "utf8")) as {
      mcp_servers?: Record<string, { args?: string[] }>;
    };
    const coderYaml = parseYaml(readFileSync(hermesProfileConfigPath(coderHome), "utf8")) as {
      mcp_servers?: Record<string, { args?: string[] }>;
    };
    expect(defaultYaml.mcp_servers?.vbot?.args).toEqual(expect.arrayContaining(["--bot-scope", "bot-chief"]));
    expect(coderYaml.mcp_servers?.vbot?.args).toEqual(expect.arrayContaining(["--bot-scope", "bot-research"]));
  });

  it("treats an unreadable profile config as unavailable instead of empty", async () => {
    const { installHermesVbotConnector, readHermesVbotProfileConfig } = await import("./hermes-vbot-mcp.ts");
    const hermesHome = profileHome("unreadable");
    const yamlPath = join(hermesHome, "config.yaml");
    mkdirSync(yamlPath);
    const missing = readHermesVbotProfileConfig(join(hermesHome, "missing.yaml"));
    expect(missing).toEqual({ state: "empty" });
    const unreadable = readHermesVbotProfileConfig(yamlPath);
    expect(unreadable).toEqual({ state: "unavailable", code: "state_unavailable" });
    expect(JSON.stringify(unreadable)).not.toMatch(/token|OMB_COMMS|Bearer|sk-|HERMES_HOME|\/Users\//i);
    expect(() => installHermesVbotConnector({
      configPath: join(hermesHome, "..", "sidecar.json"),
      hermesHome,
      profile: "default",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
    })).toThrow(/unavailable/i);
    expect(() => readFileSync(join(hermesHome, "..", "sidecar.json"), "utf8")).toThrow();
  });

  it("does not create a sidecar or treat a missing Hermes home as an empty profile", async () => {
    const { installHermesVbotConnector, readHermesVbotProfileConfig } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-missing-home-"));
    dirs.push(dir);
    const hermesHome = join(dir, "no-such-profile");
    const sidecarPath = join(dir, "hermes-vbot-mcp.json");
    expect(readHermesVbotProfileConfig(join(hermesHome, "config.yaml"))).toEqual({ state: "empty" });
    expect(() => installHermesVbotConnector({
      configPath: sidecarPath,
      hermesHome,
      profile: "coder",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
    })).toThrow(/unavailable/i);
    expect(() => readFileSync(sidecarPath, "utf8")).toThrow();
  });

  it("keeps the legacy sidecar readable while exposing registered bot scopes without secrets", async () => {
    const {
      installHermesVbotConnector,
      parseInstalledHermesVbotConnector,
      loadHermesVbotConnectorRegistration,
    } = await import("./hermes-vbot-mcp.ts");
    const hermesHome = profileHome("legacy");
    const sidecarPath = join(hermesHome, "..", "hermes-vbot-mcp.json");
    installHermesVbotConnector({
      configPath: sidecarPath,
      hermesHome,
      profile: "default",
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      hubDisplayName: "Mac mini",
    });
    const parsed = parseInstalledHermesVbotConnector(sidecarPath);
    expect(parsed).toEqual(expect.objectContaining({
      socketPath: "/tmp/vbot.sock",
      botScope: "bot-chief",
      allowedBotScopes: ["bot-chief"],
    }));
    expect(loadHermesVbotConnectorRegistration(sidecarPath)).toEqual(expect.objectContaining({
      state: "available",
      botScopes: ["bot-chief"],
    }));
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    expect(sidecar.mcpServers?.vbot?.args).toEqual(expect.arrayContaining(["--bot-scope", "bot-chief"]));
    expect(JSON.stringify({ parsed, sidecar })).not.toMatch(/token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i);
  });

  it("does not decode an unreadable sidecar as an empty registration", async () => {
    const { loadHermesVbotConnectorRegistration, parseInstalledHermesVbotConnector } = await import("./hermes-vbot-mcp.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-sidecar-"));
    dirs.push(dir);
    const missing = join(dir, "missing.json");
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    expect(loadHermesVbotConnectorRegistration(missing)).toEqual({ state: "empty" });
    expect(parseInstalledHermesVbotConnector(missing)).toBeNull();
    expect(loadHermesVbotConnectorRegistration(broken)).toEqual({ state: "unavailable", code: "state_unavailable" });
    expect(parseInstalledHermesVbotConnector(broken)).toBeNull();
    expect(JSON.stringify(loadHermesVbotConnectorRegistration(broken))).not.toMatch(/token|sk-|HERMES_HOME/i);
  });

  it("list_bots and ask_bot through the facade keep per-connection bot scope", async () => {
    const { createHermesVbotDaemonHandler, createHermesVbotPairedToolExecutor } = await import("./hermes-vbot-mcp.ts");
    const { startHermesVbotConnector, connectHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-scope-call-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const seen: Array<{ name: string; botScope: string; args: Record<string, unknown> }> = [];
    const server = await startHermesVbotConnector({
      listen: { socketPath },
      peerCredential: "bridge-mini",
      botScope: "bot-chief",
      allowedBotScopes: ["bot-chief", "bot-research"],
      handler: (request, context) => createHermesVbotDaemonHandler({
        executeTool: async (name, args) => {
          seen.push({ name, botScope: context.botScope, args });
          if (name === "list_bots") {
            return { text: `Other bots visible to ${context.botScope}` };
          }
          if (name === "ask_bot") {
            return { text: `${context.botScope} asked ${String(args.bot_id)}` };
          }
          return { text: `fixture ${name}` };
        },
      })(request),
    });
    const chief = await connectHermesVbotConnector({
      socketPath,
      peerCredential: "bridge-mini",
      botScope: "bot-chief",
    });
    const research = await connectHermesVbotConnector({
      socketPath,
      peerCredential: "bridge-mini",
      botScope: "bot-research",
    });
    const listed = await chief.request("tools/call", { name: "list_bots", arguments: {} });
    const asked = await research.request("tools/call", {
      name: "ask_bot",
      arguments: { bot_id: "bot-chief", message: "status?" },
    });
    expect(JSON.stringify(listed)).toMatch(/bot-chief/);
    expect(JSON.stringify(asked)).toMatch(/bot-research asked bot-chief/);
    expect(seen).toEqual([
      { name: "list_bots", botScope: "bot-chief", args: {} },
      { name: "ask_bot", botScope: "bot-research", args: { bot_id: "bot-chief", message: "status?" } },
    ]);
    await expect(
      connectHermesVbotConnector({ socketPath, peerCredential: "bridge-mini", botScope: "bot-outsider" }),
    ).rejects.toMatchObject({ code: "peer_unauthenticated" });
    const paired = createHermesVbotPairedToolExecutor(
      { state: "available", url: "http://127.0.0.1:9", secret: "paired-secret" },
      { botScope: "bot-chief" },
    );
    expect(paired).toEqual(expect.any(Function));
    expect(JSON.stringify({ listed, asked, seen })).not.toMatch(/paired-secret|token|OMB_COMMS|Bearer|sk-/i);
    chief.close();
    research.close();
    await server.close();
  });
});

describe("Hermes daemon paired-credential wiring", () => {
  it("treats missing or unreadable paired credentials as unavailable, never empty", async () => {
    const { pairedHermesHarnessCredentials } = await import("./hermes-vbot-mcp.ts");
    expect(pairedHermesHarnessCredentials(null)).toEqual({ state: "unavailable", code: "state_unavailable" });
    expect(pairedHermesHarnessCredentials({})).toEqual({ state: "unavailable", code: "state_unavailable" });
    expect(pairedHermesHarnessCredentials({ url: "", bridgeToken: "" })).toEqual({
      state: "unavailable",
      code: "state_unavailable",
    });
    expect(pairedHermesHarnessCredentials({
      url: "https://openmaus.posival.com",
      bridgeToken: "paired-secret",
      bridgeId: "bridge-mini",
      name: "Mac mini",
    })).toEqual({ state: "unavailable", code: "state_unavailable" });
  });

  it("constructs the Hermes executor from paired url/secret rather than env-only harness vars", async () => {
    const { createServer } = await import("node:http");
    const {
      pairedHermesHarnessCredentials,
      createHermesVbotPairedToolExecutor,
      hermesDaemonCredentialSnapshot,
      createHermesDaemonToolExecutor,
    } = await import("./hermes-vbot-mcp.ts");
    const secret = "paired-bridge-secret-value";
    const seen: { auth?: string; url?: string; body?: string } = {};
    const server = createServer((req, res) => {
      seen.auth = req.headers.authorization;
      seen.url = `http://${req.headers.host}${req.url}`;
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        seen.body = data;
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/internal/agents") {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.end(JSON.stringify({ text: "No other bots in this section yet." }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    const url = `http://127.0.0.1:${address.port}`;
    const previous = {
      OMB_HARNESS_URL: process.env.OMB_HARNESS_URL,
      OMB_COMMS_TOKEN: process.env.OMB_COMMS_TOKEN,
    };
    process.env.OMB_HARNESS_URL = "http://127.0.0.1:1";
    process.env.OMB_COMMS_TOKEN = "env-only-token-must-not-win";
    try {
      const credentials = {
        url,
        bridgeId: "bridge-mini",
        bridgeToken: secret,
        name: "Mac mini",
        botScope: "bot-chief",
      };
      const parsed = pairedHermesHarnessCredentials(credentials);
      expect(parsed).toEqual({ state: "available", url, secret });
      const snapshot = hermesDaemonCredentialSnapshot(parsed);
      const argv = ["node", "index.js", "run"];
      const logs = ["bridge: Mac mini started"];
      const fleet = { bridges: [{ id: "bridge-mini", name: "Mac mini" }] };
      const config = { mcpServers: { vbot: { args: ["--socket", "/tmp/vbot.sock"] } } };
      const proof = JSON.stringify({ snapshot, argv, logs, fleet, config });
      expect(proof).not.toMatch(/paired-bridge-secret-value|env-only-token-must-not-win|OMB_COMMS_TOKEN/);
      expect(JSON.stringify(snapshot)).not.toMatch(/secret|token|Bearer/i);
      expect(snapshot).toMatchObject({ state: "available", url, loopback: true });

      const execute = createHermesDaemonToolExecutor(credentials);
      const result = await execute("list_bots", {});
      expect(result.isError).not.toBe(true);
      expect(result.text).toMatch(/No other bots/i);
      expect(seen.auth).toBe(`Bearer ${secret}`);
      expect(seen.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${address.port}/api/bridge/hermes-tools`));
      expect(seen.body).toContain("bot-chief");
      expect(seen.body).not.toMatch(/paired-bridge-secret-value|env-only-token-must-not-win|OMB_COMMS_TOKEN/);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(createHermesVbotPairedToolExecutor(parsed)).toEqual(expect.any(Function));
    } finally {
      if (previous.OMB_HARNESS_URL === undefined) delete process.env.OMB_HARNESS_URL;
      else process.env.OMB_HARNESS_URL = previous.OMB_HARNESS_URL;
      if (previous.OMB_COMMS_TOKEN === undefined) delete process.env.OMB_COMMS_TOKEN;
      else process.env.OMB_COMMS_TOKEN = previous.OMB_COMMS_TOKEN;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not fall back to env when paired credentials are unavailable", async () => {
    const { createHermesDaemonToolExecutor } = await import("./hermes-vbot-mcp.ts");
    const previous = {
      OMB_HARNESS_URL: process.env.OMB_HARNESS_URL,
      OMB_COMMS_TOKEN: process.env.OMB_COMMS_TOKEN,
    };
    process.env.OMB_HARNESS_URL = "http://127.0.0.1:8799";
    process.env.OMB_COMMS_TOKEN = "env-only-token-must-not-win";
    try {
      const execute = createHermesDaemonToolExecutor(null);
      const result = await execute("list_bots", {});
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/unavailable/i);
      expect(result.text).not.toMatch(/unconfigured/i);
      expect(JSON.stringify(result)).not.toMatch(/env-only-token-must-not-win|OMB_COMMS_TOKEN|Bearer/i);
    } finally {
      if (previous.OMB_HARNESS_URL === undefined) delete process.env.OMB_HARNESS_URL;
      else process.env.OMB_HARNESS_URL = previous.OMB_HARNESS_URL;
      if (previous.OMB_COMMS_TOKEN === undefined) delete process.env.OMB_COMMS_TOKEN;
      else process.env.OMB_COMMS_TOKEN = previous.OMB_COMMS_TOKEN;
    }
  });
});
