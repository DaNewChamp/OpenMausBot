import { describe, expect, it } from "vitest";

import { allowedWebClientRedirect } from "../src/web-client-auth";

describe("web client auth completion", () => {
  const allowed = new Set(["https://app.openmausbot.com", "https://accounts.openmausbot.com"]);

  it("accepts only exact allowed origins without credentials in the URL", () => {
    expect(allowedWebClientRedirect("https://app.openmausbot.com/?client=web", allowed)).toBe(true);
    expect(allowedWebClientRedirect("https://evil.example/?client=web", allowed)).toBe(false);
    expect(allowedWebClientRedirect("https://user:pass@app.openmausbot.com/", allowed)).toBe(false);
  });
});
