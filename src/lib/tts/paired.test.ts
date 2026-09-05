import { afterEach, describe, expect, it, vi } from "vitest";
import { setHubApiBase, setHubDeviceToken } from "../web-client-session";
import { Speaker } from "./index";

afterEach(() => { setHubApiBase(""); setHubDeviceToken(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("paired browser speech transport", () => {
  it("sends preparation and audio to the paired hub with its device credential", async () => {
    vi.stubGlobal("location", { hostname: "vbot.posival.com", search: "" });
    setHubApiBase("https://hub.fixture.invalid"); setHubDeviceToken("fixture-device-token");
    let end: (() => void) | undefined;
    vi.stubGlobal("Audio", class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play() { end = () => this.onended?.(); return Promise.resolve(); }
      pause() {}
      removeAttribute() {}
      load() {}
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/prepare")
      ? Response.json({ ready: true, utterances: ["Neutral voice test."] })
      : new Response(new Blob(["fixture audio"], { type: "audio/mpeg" })));
    vi.stubGlobal("fetch", fetcher);
    const speaker = new Speaker();
    const pending = speaker.speak("Neutral voice test.");
    await vi.waitFor(() => expect(end).toBeTypeOf("function"));
    end?.(); await pending;
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://hub.fixture.invalid/api/tts/prepare", "https://hub.fixture.invalid/api/tts/speak"]);
    for (const call of fetcher.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-device-token");
    }
  });
  it("fails before fetching when no hub device is paired", async () => {
    vi.stubGlobal("location", { hostname: "vbot.posival.com", search: "" });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const speaker = new Speaker(); await speaker.speak("Neutral test.");
    expect(fetcher).not.toHaveBeenCalled();
    expect(speaker.state.error).toMatch(/pair/i);
  });
});
