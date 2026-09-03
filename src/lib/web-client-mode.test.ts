import { afterEach, describe, expect, it, vi } from "vitest";
import { isWebClientMode } from "./web-client-mode";

describe("web-client mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enables web mode on the production hostname without a query", () => {
    vi.stubGlobal("location", { hostname: "vbot.posival.com", search: "" });

    expect(isWebClientMode()).toBe(true);
  });

  it("keeps the explicit query switch available on other hosts", () => {
    vi.stubGlobal("location", { hostname: "localhost", search: "?client=web" });

    expect(isWebClientMode()).toBe(true);
  });

  it("does not enable web mode for unrelated hosts", () => {
    vi.stubGlobal("location", { hostname: "app.openmausbot.com", search: "" });

    expect(isWebClientMode()).toBe(false);
  });

  it("normalizes a trailing dot on the production hostname", () => {
    expect(isWebClientMode("", "vbot.posival.com.")).toBe(true);
  });
});
