// Paired-phone input for a bot's Local VM desktop.
//
// Narrower than the agent invoke surface: click, scroll, type, and key only.
// Every action runs through Chromium DevTools inside the container; nothing
// reaches the host Mac shell or an arbitrary exec channel.
import { browserCdpExecArgs } from "./browser-vm-image.ts";
import type { CommandRunner, Runtime } from "./container-computer.ts";
import { sanitizeLocalVmInvokeText } from "./local-vm-invoke.ts";

export type LocalVmPhoneInputAction = "click" | "scroll" | "type" | "key";

export interface LocalVmPhoneInput {
  action: LocalVmPhoneInputAction;
  x?: number;
  y?: number;
  button?: "left" | "right";
  double?: boolean;
  direction?: "up" | "down";
  clicks?: number;
  text?: string;
  keys?: string;
}

export interface LocalVmPhoneInputResult {
  text: string;
  isError: boolean;
}

async function cdpCall(
  runner: CommandRunner,
  runtime: Runtime,
  container: string,
  action: string,
  payload: object,
): Promise<string> {
  const { stdout } = await runner(
    runtime,
    browserCdpExecArgs(action, payload, { container }),
    30_000,
  );
  return stdout.trim();
}

export function validateLocalVmPhoneInput(
  body: unknown,
): { error: string } | { input: LocalVmPhoneInput } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "input requires a JSON object" };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length === 0 || keys.length > 8) {
    return { error: "input body has unsupported fields" };
  }
  const action = values.action;
  if (action !== "click" && action !== "scroll" && action !== "type" && action !== "key") {
    return { error: "action must be click, scroll, type, or key" };
  }
  if (action === "click") {
    const x = Number(values.x);
    const y = Number(values.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: "click needs numeric x and y" };
    }
    const button = values.button;
    if (button !== undefined && button !== "left" && button !== "right") {
      return { error: "button must be left or right" };
    }
    if (values.double !== undefined && typeof values.double !== "boolean") {
      return { error: "double must be a boolean" };
    }
    return {
      input: {
        action,
        x: Math.round(x),
        y: Math.round(y),
        button: button === "right" ? "right" : "left",
        double: values.double === true,
      },
    };
  }
  if (action === "scroll") {
    const direction = values.direction;
    if (direction !== undefined && direction !== "up" && direction !== "down") {
      return { error: "direction must be up or down" };
    }
    const clicksRaw = values.clicks;
    const clicks = clicksRaw === undefined ? 3 : Number(clicksRaw);
    if (!Number.isFinite(clicks) || clicks < 1 || clicks > 20) {
      return { error: "clicks must be between 1 and 20" };
    }
    const x = values.x === undefined ? undefined : Number(values.x);
    const y = values.y === undefined ? undefined : Number(values.y);
    if (x !== undefined && !Number.isFinite(x)) return { error: "x must be numeric" };
    if (y !== undefined && !Number.isFinite(y)) return { error: "y must be numeric" };
    return {
      input: {
        action,
        direction: direction === "up" ? "up" : "down",
        clicks: Math.round(clicks),
        ...(x !== undefined && Number.isFinite(x) ? { x: Math.round(x) } : {}),
        ...(y !== undefined && Number.isFinite(y) ? { y: Math.round(y) } : {}),
      },
    };
  }
  if (action === "type") {
    const text = values.text;
    if (typeof text !== "string" || !text.trim()) {
      return { error: "type needs text" };
    }
    if (text.length > 4000) {
      return { error: "text must be at most 4000 characters" };
    }
    return { input: { action, text } };
  }
  const keyChord = values.keys;
  if (typeof keyChord !== "string" || !keyChord.trim()) {
    return { error: "key needs keys" };
  }
  if (keyChord.length > 120) {
    return { error: "keys must be at most 120 characters" };
  }
  return { input: { action, keys: keyChord.trim() } };
}

export async function executeLocalVmPhoneInput(
  input: LocalVmPhoneInput,
  ctx: { runtime: Runtime; containerName: string; runner: CommandRunner },
): Promise<LocalVmPhoneInputResult> {
  try {
    if (input.action === "click") {
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "mouse", {
        x: input.x,
        y: input.y,
        button: input.button ?? "left",
        double: input.double === true,
      });
      return { text: sanitizeLocalVmInvokeText(out || "Clicked in this bot's browser."), isError: false };
    }
    if (input.action === "scroll") {
      const payload: Record<string, unknown> = {
        direction: input.direction ?? "down",
        clicks: input.clicks ?? 3,
      };
      if (input.x !== undefined) payload.x = input.x;
      if (input.y !== undefined) payload.y = input.y;
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "scroll", payload);
      return { text: sanitizeLocalVmInvokeText(out || "Scrolled in this bot's browser."), isError: false };
    }
    if (input.action === "type") {
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "type", { text: input.text });
      return { text: sanitizeLocalVmInvokeText(out || "Typed in this bot's browser."), isError: false };
    }
    const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "key", { keys: input.keys });
    return { text: sanitizeLocalVmInvokeText(out || "Pressed a key in this bot's browser."), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: sanitizeLocalVmInvokeText(message), isError: true };
  }
}
