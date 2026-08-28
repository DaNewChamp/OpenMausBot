// Paired-phone input for a bot's Local VM desktop. The harness validates and
// forwards Cua actions; phones never receive host paths or viewer secrets.
import type { Runtime } from "./container-computer.ts";
import { cuaExecArgs } from "./container-computer.ts";
import { executeLocalVmInvokeTool } from "./local-vm-invoke.ts";

export type LocalVmPhoneInputAction = "click" | "scroll" | "type" | "key";

export interface LocalVmPhoneInputBody {
  action: LocalVmPhoneInputAction;
  x?: number;
  y?: number;
  button?: "left" | "right";
  double?: boolean;
  direction?: "up" | "down";
  amount?: number;
  text?: string;
  keys?: string;
}

export type LocalVmPhoneInputResult =
  | { ok: true; image?: string }
  | { ok: false; status: number; error: string };

type Runner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

const CUA_SOCKET = "/tmp/cua-driver.sock";

function cuaJson(payload: object): string {
  return JSON.stringify(payload);
}

async function cuaCall(
  runner: Runner,
  runtime: Runtime,
  container: string,
  tool: string,
  payload: object,
): Promise<string> {
  const { stdout } = await runner(
    runtime,
    cuaExecArgs(["call", tool, cuaJson(payload), "--socket", CUA_SOCKET], { container }),
    30_000,
  );
  return stdout.trim();
}

function parseBody(raw: unknown): LocalVmPhoneInputBody | { error: string; status: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "input requires a JSON object", status: 400 };
  }
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (action !== "click" && action !== "scroll" && action !== "type" && action !== "key") {
    return { error: "action must be click, scroll, type, or key", status: 400 };
  }
  const allowed = new Set(["action", "x", "y", "button", "double", "direction", "amount", "text", "keys"]);
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra) return { error: `unsupported input field: ${extra}`, status: 400 };
  return body as LocalVmPhoneInputBody;
}

export async function executeLocalVmPhoneInput(
  raw: unknown,
  ctx: { runtime: Runtime; containerName: string; runner: Runner },
): Promise<LocalVmPhoneInputResult> {
  const parsed = parseBody(raw);
  if ("error" in parsed) return { ok: false, status: parsed.status, error: parsed.error };

  try {
    if (parsed.action === "click") {
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, status: 400, error: "click needs numeric x and y" };
      }
      const result = await executeLocalVmInvokeTool(
        "click",
        {
          x: Math.round(x),
          y: Math.round(y),
          button: parsed.button === "right" ? "right" : "left",
          double: parsed.double === true,
        },
        ctx,
      );
      if (result.isError) return { ok: false, status: 502, error: result.text };
      const shot = await executeLocalVmInvokeTool("screenshot", {}, ctx);
      return { ok: true, image: shot.image };
    }

    if (parsed.action === "scroll") {
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, status: 400, error: "scroll needs numeric x and y" };
      }
      const direction = parsed.direction === "up" ? "up" : "down";
      const amount = Math.min(Math.max(Math.round(Number(parsed.amount) || 3), 1), 20);
      await cuaCall(ctx.runner, ctx.runtime, ctx.containerName, "scroll", {
        x: Math.round(x),
        y: Math.round(y),
        direction,
        amount,
        by: "line",
        scope: "desktop",
      });
      const shot = await executeLocalVmInvokeTool("screenshot", {}, ctx);
      return { ok: true, image: shot.image };
    }

    if (parsed.action === "type") {
      const text = typeof parsed.text === "string" ? parsed.text : "";
      if (!text) return { ok: false, status: 400, error: "type needs text" };
      const result = await executeLocalVmInvokeTool("type_text", { text }, ctx);
      if (result.isError) return { ok: false, status: 502, error: result.text };
      return { ok: true, image: result.image };
    }

    const keys = typeof parsed.keys === "string" ? parsed.keys.trim() : "";
    if (!keys) return { ok: false, status: 400, error: "key needs keys" };
    const result = await executeLocalVmInvokeTool("press_key", { keys }, ctx);
    if (result.isError) return { ok: false, status: 502, error: result.text };
    const shot = await executeLocalVmInvokeTool("screenshot", {}, ctx);
    return { ok: true, image: shot.image };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, error: message };
  }
}
