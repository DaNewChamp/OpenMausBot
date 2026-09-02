import { describe, expect, it, vi } from "vitest";

import {
  parseHermesSignInInput,
  projectHermesSignInHandoff,
  startHermesSignIn,
  type HermesSignInLaunch,
} from "./hermes-signin.ts";

describe("Hermes sign-in handoff", () => {
  it("starts Hermes setup on the selected computer without capturing output", async () => {
    const launches: HermesSignInLaunch[] = [];
    const handoff = await startHermesSignIn({
      placement: { kind: "local", profile: "default" },
      localComputerName: "Studio",
      launch: async (command) => {
        launches.push(command);
        return { ok: true, kind: "terminal" };
      },
    });
    expect(handoff).toEqual({
      kind: "terminal",
      computerName: "Studio",
      message: "Complete sign-in on Studio, then try again.",
    });
    expect(launches).toEqual([expect.objectContaining({
      kind: "terminal",
      argv: ["setup"],
    })]);
    expect(JSON.stringify({ handoff, launches })).not.toMatch(/sk-|Bearer |HERMES_HOME|token|secret|\/Users\//i);
  });

  it("surfaces a browser handoff when Hermes opens sign-in on that computer", async () => {
    const handoff = await startHermesSignIn({
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
      launch: async () => ({ ok: true, kind: "browser" }),
    });
    expect(handoff).toEqual({
      kind: "browser",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
    });
  });

  it("fails closed without leaking diagnostics when launch is unavailable", async () => {
    await expect(startHermesSignIn({
      placement: { kind: "local", profile: "default" },
      launch: async () => ({ ok: false }),
    })).rejects.toMatchObject({ code: "gateway_unavailable" });
  });

  it("projects only safe handoff fields", () => {
    const projected = projectHermesSignInHandoff({
      kind: "terminal",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
      stdout: "token=sk-secret HERMES_HOME=/Users/Vincent/.hermes",
    });
    expect(projected).toEqual({
      kind: "terminal",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
    });
    expect(JSON.stringify(projected)).not.toMatch(/sk-|HERMES_HOME|\/Users\/|token/i);
  });

  it("accepts only a placement for sign-in and never extra secret fields", () => {
    expect(parseHermesSignInInput({
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
    })).toEqual({
      ok: true,
      placement: { kind: "bridge", bridge: "mac mini", profile: "default" },
    });
    expect(parseHermesSignInInput({ token: "sk-secret" })).toMatchObject({ ok: false });
    expect(parseHermesSignInInput({
      placement: { kind: "local", profile: "default" },
      stdout: "token=sk-secret",
    })).toMatchObject({ ok: false });
  });
});
