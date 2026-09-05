import { describe, expect, it } from "vitest";
import { isLocalVmPhoneSurface, isLocalVmControl, validateLocalVmActionBody } from "../src/routes.ts";
import { isBrowserSafeCompanionRoute } from "../src/web-client-cors.ts";

const path = "/api/bots/bot-one/local-computer/control";
describe("paired Local VM control boundary", () => {
  it("shares the existing per-device Local VM gate for read and mutation", () => {
    for (const method of ["GET", "POST"]) {
      expect(isLocalVmControl(method, path)).toBe(true);
      expect(isLocalVmPhoneSurface(method, path)).toBe(true);
      expect(isBrowserSafeCompanionRoute(method, path, true)).toBe(true);
      expect(isBrowserSafeCompanionRoute(method, path, false)).toBe(false);
    }
    expect(isLocalVmControl("DELETE", path)).toBe(false);
    expect(isLocalVmControl("GET", path+"/extra")).toBe(false);
    expect(isBrowserSafeCompanionRoute("GET", "/api/bots/bot-one/computer/control", true)).toBe(false);
  });
  it.each(["take", "release", "dismiss-help"])("accepts only the existing %s operation", (action) => {
    expect(validateLocalVmActionBody("POST", path, { action })).toBeNull();
  });
  it.each([null, {}, [], { action: "run" }, { action: "take", command: "whoami" }, { action: "release", botId: "other" }, { action: "take", url: "https://other.invalid" }])("rejects extra capabilities %j", (body) => {
    expect(validateLocalVmActionBody("POST", path, body)?.status).toBe(400);
  });
});
