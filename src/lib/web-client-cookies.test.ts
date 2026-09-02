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
  it("stores and clears values without localStorage", () => {
    setClientCookie("vbot_test", "secret-value", 3600);
    expect(getClientCookie("vbot_test")).toBe("secret-value");
    clearClientCookie("vbot_test");
    expect(getClientCookie("vbot_test")).toBeFalsy();
  });

  it("scopes cookies to path / and SameSite=Strict", () => {
    setClientCookie("vbot_flags", "1", 60);
    expect(cookieJar).toContain("Path=/");
    expect(cookieJar).toContain("SameSite=Strict");
    clearClientCookie("vbot_flags");
  });
});
