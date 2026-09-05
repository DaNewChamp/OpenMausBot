import { describe, expect, it, vi } from "vitest";
import { buildKokoroBridgeCommand, createKokoroBridgeFetch, kokoroBridgeSettings } from "./bridge-kokoro.ts";

const url = "http://127.0.0.1:8880/v1";
const success = (body: string, mime = "application/json") => ({
  exitCode: 0, stdout: JSON.stringify({ status: 200, mime, body: Buffer.from(body).toString("base64") }), stderr: "", truncated: false,
});

describe("operator-pinned bridge speech", () => {
  it("does not implicitly choose a fleet machine", () => {
    expect(kokoroBridgeSettings({})).toBeNull();
    expect(kokoroBridgeSettings({ OMB_KOKORO_BRIDGE_ID: "bridge-windows" })).toEqual({ bridgeId: "bridge-windows", container: "kokoro-tts", dockerCli: "docker" });
    expect(kokoroBridgeSettings({ OMB_KOKORO_BRIDGE_ID: "../escape" })).toBeNull();
    expect(kokoroBridgeSettings({ OMB_KOKORO_BRIDGE_ID: "bridge-windows", OMB_KOKORO_DOCKER_CLI: "sh -c" })).toBeNull();
    expect(kokoroBridgeSettings({ OMB_KOKORO_BRIDGE_ID: "bridge-windows", OMB_KOKORO_DOCKER_CLI: "docker.exe" })?.dockerCli).toBe("docker.exe");
    expect(kokoroBridgeSettings({ OMB_KOKORO_BRIDGE_ID: "bridge-windows", OMB_KOKORO_CONTAINER: "--privileged" })).toBeNull();
  });
  it("encodes speech as data rather than host-shell syntax", () => {
    const text = 'Hello $(touch /tmp/never) `whoami` ; "quoted"';
    const command = buildKokoroBridgeCommand("kokoro-tts", { operation: "speech", text, voice: "af_heart" });
    expect(command).toMatch(/^docker exec kokoro-tts python -c "exec\(__import__\('base64'\)\.b64decode\('[A-Za-z0-9+/=]+'\)\)"$/);
    expect(command).not.toContain(text);
    expect(() => buildKokoroBridgeCommand("bad;whoami", { operation: "voices" })).toThrow();
  });
  it("returns the local container catalog through the existing authenticated job channel", async () => {
    const execute = vi.fn(async () => success('{"voices":[{"id":"af_heart","name":"Heart"}]}'));
    const transport = createKokoroBridgeFetch(execute, "kokoro-tts");
    const response = await transport(url + "/audio/voices", { method: "GET" });
    expect(await response.json()).toEqual({ voices: [{ id: "af_heart", name: "Heart" }] });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each([
    [url + "/audio/voices?target=other", { method: "GET" }],
    ["https://untrusted.invalid/v1/audio/voices", { method: "GET" }],
    [url + "/models", { method: "GET" }],
    [url + "/audio/voices", { method: "DELETE" }],
    [url + "/audio/speech", { method: "POST", body: JSON.stringify({ model: "kokoro", input: "Hi", voice: "af_heart", response_format: "mp3", stream: false, command: "whoami" }) }],
  ])("refuses any extension of the fixed voice surface %s", async (target, init) => {
    const execute = vi.fn(async () => success("{}"));
    await expect(createKokoroBridgeFetch(execute)(target, init)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("caches the voice catalog briefly but never reuses synthesized audio", async () => {
    const execute = vi.fn(async (command: string) => success(command ? '{"voices":["af_heart"]}' : "{}"));
    const transport = createKokoroBridgeFetch(execute);
    await transport(url + "/audio/voices");
    await transport(url + "/audio/voices");
    expect(execute).toHaveBeenCalledTimes(1);
    const speech = { method: "POST", body: JSON.stringify({ model: "kokoro", input: "Hi", voice: "af_heart", response_format: "mp3", stream: false }) };
    await transport(url + "/audio/speech", speech);
    await transport(url + "/audio/speech", speech);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("does not dispatch an already cancelled request", async () => {
    const execute = vi.fn(async () => success("{}"));
    await expect(createKokoroBridgeFetch(execute)(url + "/audio/voices", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects failed or truncated jobs without exposing host stderr", async () => {
    for (const result of [{ ...success("{}"), truncated: true }, { ...success("{}"), exitCode: 1, stderr: "PRIVATE_HOST_DETAIL" }]) {
      const error = await createKokoroBridgeFetch(async () => result)(url + "/audio/voices").catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("PRIVATE_HOST_DETAIL");
    }
  });
});
