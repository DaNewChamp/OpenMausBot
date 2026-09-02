import { describe, expect, it } from "vitest";

import { createFakeHermesBridgeRuntime, runHermesBridgeJob, runHermesSignInJob } from "./hermes.ts";
import { parseHermesBridgeResult } from "../../shared/bridge-hermes-contract.ts";

describe("bridge Hermes job handler", () => {
  it("returns scrubbed stdout envelopes and never stderr secrets", async () => {
    const result = await runHermesBridgeJob(
      { kind: "hermes-discover", payload: {} },
      createFakeHermesBridgeRuntime({
        discover: {
          state: "available",
          capabilities: {
            roster: true,
            canonicalChat: true,
            send: true,
            finalResponse: true,
            events: true,
            stop: true,
            routinesRead: false,
            messageAgent: false,
            groups: false,
            crossMachine: false,
            queueing: false,
            steer: false,
            attachments: false,
          },
          profiles: [],
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const wire = parseHermesBridgeResult(result.stdout);
    expect(wire.kind).toBe("hermes-discover");
    expect(JSON.stringify(wire)).not.toMatch(/jsonrpc|session_id|HERMES_HOME/i);
  });

  it("honours cancellation signals for send jobs", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runHermesBridgeJob(
      {
        kind: "hermes-send",
        payload: {
          profile: "default",
          text: "hello",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
      createFakeHermesBridgeRuntime({}),
      controller.signal,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("cancelled");
    expect(result.stdout).toBe("");
  });

  it("aborts in-flight send jobs and returns cancelled instead of success stdout", async () => {
    const controller = new AbortController();
    const factory = createFakeHermesBridgeRuntime({
      send: {
        ok: true,
        turnId: "turn-1",
        events: [],
      },
    });
    const originalCreate = factory.create;
    factory.create = async () => {
      const runtime = await originalCreate();
      return {
        ...runtime,
        send: async (payload, signal) => {
          signal?.addEventListener("abort", () => {}, { once: true });
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (signal?.aborted) {
            return { ok: false, reason: "upstream_error", turnId: payload.turnId, events: [] };
          }
          return { ok: true, turnId: payload.turnId, events: [] };
        },
        interrupt: async () => ({ ok: true }),
      };
    };
    const promise = runHermesBridgeJob(
      {
        kind: "hermes-send",
        payload: {
          profile: "default",
          text: "hello",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
      factory,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("cancelled");
    expect(result.stdout).toBe("");
  });

  it("launches Hermes setup without capturing output", async () => {
    const launches: Array<{ kind: string; argv: readonly string[] }> = [];
    const result = await runHermesSignInJob(
      { kind: "hermes-signin", payload: { argv: ["setup"] } },
      async (command) => {
        launches.push(command);
        return { ok: true, kind: "terminal" };
      },
    );
    expect(launches).toEqual([{ kind: "terminal", argv: ["setup"] }]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseHermesBridgeResult(result.stdout)).toEqual({
      kind: "hermes-signin",
      body: { kind: "terminal" },
    });
    expect(JSON.stringify({ launches, result })).not.toMatch(/sk-|Bearer |HERMES_HOME|token|secret|\/Users\//i);
  });

  it("fails closed when Hermes setup cannot start", async () => {
    const result = await runHermesSignInJob(
      { kind: "hermes-signin", payload: { argv: ["setup"] } },
      async () => ({ ok: false }),
    );
    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "hermes setup handoff failed",
    });
    expect(result.stderr).not.toMatch(/sk-|HERMES_HOME|\/Users\/|token|secret/i);
  });
});
