import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
