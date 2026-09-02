import { explainApproval } from "../approval-explainer.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import {
  deliveryKey,
  normalizeMessageAgentBody,
  resolveLocalTarget,
  type HermesCommCandidate,
  type HermesCommPlane,
} from "./hermes-comms.ts";

export interface HermesToolEvent {
  name: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  requestId?: string;
}

export interface HermesApprovalEvent {
  requestId: string;
  tool: string;
  summary: string;
  resolved?: boolean;
  choice?: "allow" | "deny";
}

export interface HermesEventProjection {
  events: RuntimeEvent[];
  comm?: HermesCommCandidate;
  approval?: HermesApprovalEvent;
}

export interface ProjectHermesEventInput {
  type: string;
  sessionId: string;
  payload?: Record<string, unknown>;
  threadId: string;
  turnId: string;
  fromBotId: string;
  senderHandle: string;
  handleToBotId: ReadonlyMap<string, string>;
  createdAt: string;
}

function safeToolName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 120 ? value : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    ? value
    : undefined;
}

function approvalSummary(tool: string, raw: unknown): string {
  const command = typeof raw === "string" ? raw : "";
  if (/terminal|shell|bash|execute|command/i.test(tool) && command) {
    return explainApproval(tool, command).executiveSummary || "Run a command";
  }
  return "Hermes wants approval";
}

export function projectHermesMessageAgent(
  input: ProjectHermesEventInput,
  tool: HermesToolEvent,
): HermesEventProjection {
  const events: RuntimeEvent[] = [];
  const base = {
    eventId: newEventId(),
    provider: "hermesBot" as const,
    threadId: input.threadId,
    turnId: input.turnId,
    createdAt: input.createdAt,
  };
  const target = typeof tool.arguments?.target === "string" ? tool.arguments.target : "";
  const message = typeof tool.arguments?.message === "string" ? tool.arguments.message : "";
  const body = normalizeMessageAgentBody(message);
  const toBotId = resolveLocalTarget(target, input.handleToBotId);
  const selfTarget = target.toLowerCase() === input.senderHandle.toLowerCase()
    || target.toLowerCase() === input.fromBotId.toLowerCase();

  events.push({
    ...base,
    type: "item.started",
    itemType: "tool",
    title: "message_agent",
  });

  if (!body.ok || !toBotId || selfTarget || toBotId === input.fromBotId) {
    events.push({
      ...base,
      eventId: newEventId(),
      type: "item.completed",
      itemType: "tool",
      ok: false,
      title: !body.ok && body.reason === "too_long" ? "message too long" : "message_agent refused",
    });
    return { events };
  }

  const key = deliveryKey({
    fromBotId: input.fromBotId,
    toBotId,
    turnId: input.turnId,
    text: body.text,
  });

  return {
    events,
    comm: {
      plane: "hermesMessageAgent",
      fromBotId: input.fromBotId,
      toBotId,
      text: body.text,
      turnId: input.turnId,
      deliveryKey: key,
    },
  };
}

export function projectHermesApproval(
  input: ProjectHermesEventInput,
  approval: HermesApprovalEvent,
): HermesEventProjection {
  const base = {
    eventId: newEventId(),
    provider: "hermesBot" as const,
    threadId: input.threadId,
    turnId: input.turnId,
    createdAt: input.createdAt,
  };
  if (approval.resolved) {
    return {
      events: [{
        ...base,
        type: "request.resolved",
        behavior: approval.choice === "allow" ? "allow" : "deny",
        source: "user",
      }],
    };
  }
  return {
    events: [{
      ...base,
      type: "request.opened",
      requestType: "permission",
      tool: approval.tool,
      summary: approval.summary,
      requestId: approval.requestId,
    }],
    approval,
  };
}

export function projectHermesGatewayToolEvent(input: ProjectHermesEventInput): HermesEventProjection | null {
  const payload = input.payload;
  if (!payload) return null;
  const name = safeToolName(payload.name ?? payload.tool);
  if (!name) return null;
  if (name === "message_agent") {
    if (input.type !== "tool.start" && input.type !== "tool.call") return null;
    return projectHermesMessageAgent(input, {
      name,
      arguments: payload.arguments as Record<string, unknown> | undefined,
      ok: payload.ok === true || payload.status === "complete",
    });
  }
  const title = safeToolName(payload.title) ?? name;
  const base = {
    eventId: newEventId(),
    provider: "hermesBot" as const,
    threadId: input.threadId,
    turnId: input.turnId,
    createdAt: input.createdAt,
  };
  if (input.type === "tool.start" || input.type === "tool.call") {
    return { events: [{ ...base, type: "item.started", itemType: "tool", title }] };
  }
  if (input.type === "tool.complete" || input.type === "tool.result") {
    return {
      events: [{
        ...base,
        type: "item.completed",
        itemType: "tool",
        ok: payload.ok !== false && payload.status !== "error",
        title,
      }],
    };
  }
  return null;
}

export function projectHermesGatewayApprovalEvent(input: ProjectHermesEventInput): HermesEventProjection | null {
  const payload = input.payload;
  if (!payload) return null;
  const requestId = safeRequestId(payload.request_id ?? payload.id);
  if (!requestId) return null;
  const tool = safeToolName(payload.tool ?? payload.name) ?? "tool";
  if (input.type === "approval.resolved" || input.type === "approval.received") {
    const choice = payload.choice === "once" || payload.choice === "allow" ? "allow" : "deny";
    return projectHermesApproval(input, { requestId, tool, summary: "", resolved: true, choice });
  }
  if (input.type === "approval.pending" || input.type === "approval.ask") {
    const summary = approvalSummary(tool, payload.summary ?? payload.command ?? payload.message);
    return projectHermesApproval(input, { requestId, tool, summary });
  }
  return null;
}

export function commPlaneForMirror(plane: HermesCommPlane): HermesCommPlane {
  return plane;
}

const SPAWN_TOOLS = /^(?:spawn_agent|delegate_task|task|subagent)$/i;

export type HermesSubagentGatewayProjection = {
  action: "start" | "complete";
  hermesAgentId: string;
  kind: "persistent" | "temporary";
  name: string;
  text?: string;
};

function safeAgentId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
    ? value
    : undefined;
}

function safeAgentName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120 ? value.trim() : fallback;
}

function agentKind(payload: Record<string, unknown> | undefined): "persistent" | "temporary" {
  if (payload?.persistent === true || payload?.kind === "persistent" || payload?.named === true) {
    return "persistent";
  }
  return "temporary";
}

export function projectHermesSubagentGatewayEvent(input: ProjectHermesEventInput): HermesSubagentGatewayProjection | null {
  const payload = input.payload ?? {};
  const type = input.type;
  const toolName = safeToolName(payload.name ?? payload.tool);
  const spawnTool = Boolean(toolName && SPAWN_TOOLS.test(toolName));
  const args = (payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments)
    ? payload.arguments
    : payload) as Record<string, unknown>;
  const hermesAgentId = safeAgentId(
    args.id ?? args.agent_id ?? args.agentId ?? payload.id ?? payload.agent_id ?? payload.agentId,
  );
  if (!hermesAgentId) return null;

  const name = safeAgentName(
    args.name ?? args.title ?? payload.title ?? (spawnTool ? undefined : payload.name),
    "Hermes agent",
  );
  const text = eventTextish(args.text ?? payload.text ?? payload.message);

  if (
    type === "agent.completed"
    || type === "agent.complete"
    || type === "subagent.completed"
    || type === "subagent.complete"
    || type === "agent.failed"
    || type === "subagent.failed"
  ) {
    return { action: "complete", hermesAgentId, kind: agentKind(payload), name, ...(text ? { text } : {}) };
  }

  if (
    type === "agent.started"
    || type === "agent.start"
    || type === "subagent.started"
    || type === "subagent.start"
    || ((type === "tool.start" || type === "tool.call") && spawnTool)
  ) {
    return { action: "start", hermesAgentId, kind: agentKind({ ...payload, ...args }), name };
  }
  return null;
}

function eventTextish(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}
