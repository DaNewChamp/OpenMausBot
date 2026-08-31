import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createLocalMailFixture } from "./local-mail-fixture";

const BASE_URL = "https://auth.openmausbot.test";

describe("local OTP mail fixture", () => {
  it("captures the auth email and verifies the code without exposing an HTTP or env bypass", async () => {
    const emailFixture = createLocalMailFixture();
    const fixtureEnv = {
      ...env,
      EMAIL: emailFixture.EMAIL as unknown as Env["EMAIL"],
    };
    const ctx = createExecutionContext();
    const auth = createAuth(fixtureEnv, ctx, readConfig(fixtureEnv), crypto.randomUUID());
    const sendResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Fixture-User@example.com", type: "sign-in" }),
    }));
    await waitOnExecutionContext(ctx);

    expect(sendResponse.status).toBe(200);
    const email = "fixture-user@example.com";
    const otp = emailFixture.readLatestOtp(email);
    expect(otp).toMatch(/^\d{8}$/);

    const signInResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, otp, name: "Fixture User" }),
    }));
    expect(signInResponse.status).toBe(200);
    expect((await signInResponse.json<{ user: { email: string } }>()).user.email).toBe(email);

    emailFixture.clear();
    expect(() => emailFixture.readLatestOtp(email)).toThrow("local OTP message not found");
  });
});
