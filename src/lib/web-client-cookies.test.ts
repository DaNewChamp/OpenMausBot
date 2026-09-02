import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearClientCookie, getClientCookie, setClientCookie } from "./web-client-cookies";

let cookieJar = "";

beforeEach(() => {
  cookieJar = "";
  vi.stubGlobal("document", {
    get cookie() {
      return cookieJar;
    },
    set cookie(value: string) {
      cookieJar = value;
    },
  });
  vi.stubGlobal("location", { protocol: "https:" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web client cookies", () => {
  it("stores non-secret UI hints without localStorage", () => {
    setClientCookie("vbot_w_hub", "https://hub.example", 3600);
    expect(getClientCookie("vbot_w_hub")).toBe("https://hub.example");
    clearClientCookie("vbot_w_hub");
    expect(getClientCookie("vbot_w_hub")).toBeFalsy();
  });

  it("scopes cookies to path / and SameSite=Strict", () => {
    setClientCookie("vbot_flags", "1", 60);
    expect(cookieJar).toContain("Path=/");
    expect(cookieJar).toContain("SameSite=Strict");
    clearClientCookie("vbot_flags");
  });
});
