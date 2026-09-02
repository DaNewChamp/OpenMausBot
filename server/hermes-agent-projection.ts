import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { newId } from "./contracts.ts";
import { DATA_DIR } from "./config.ts";
import { Store, type BotRecord } from "./store.ts";

const PROJECTION_FILE = join(DATA_DIR, "hermes-agent-projection.json");
const SECRETISH = /token|HERMES_HOME|\/Users\/|sk-/i;

export type HermesSubagentEventType =
  | "subagent.started"
  | "subagent.updated"
  | "subagent.completed"
  | "subagent.promoted";

export type HermesSubagentEvent = {
  type: HermesSubagentEventType;
  activityId: string;
  hermesAgentId: string;
  parentBotId: string;
  title: string;
  persistent: boolean;
  botId?: string;
  transcriptThreadId: string;
  status: "started" | "updated" | "completed" | "promoted";
};

type ProjectionRecord = {
  hermesAgentId: string;
  kind: "persistent" | "temporary";
  activityId: string;
  parentBotId: string;
  parentThreadId: string;
  name: string;
  transcriptThreadId: string;
  botId?: string;
  status: "started" | "updated" | "completed" | "promoted";
  updatedAt: number;
};

type ProjectionFile = { agents: Record<string, ProjectionRecord> };

let forceUnreadable = false;

export function markHermesProjectionStoreUnreadable(): void {
  forceUnreadable = true;
}

export function resetHermesProjectionStoreForTests(): void {
  forceUnreadable = false;
}

function loadProjectionFile(): { state: "available"; value: ProjectionFile } | { state: "unavailable" } {
  if (forceUnreadable) return { state: "unavailable" };
  if (!existsSync(PROJECTION_FILE)) return { state: "available", value: { agents: {} } };
  try {
    const parsed = JSON.parse(readFileSync(PROJECTION_FILE, "utf8")) as ProjectionFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.agents || typeof parsed.agents !== "object") {
      return { state: "unavailable" };
    }
    return { state: "available", value: { agents: parsed.agents } };
  } catch {
    return { state: "unavailable" };
  }
}

function saveProjectionFile(file: ProjectionFile): void {
  const serialized = `${JSON.stringify(file)}\n`;
  if (SECRETISH.test(serialized)) {
    throw new Error("refusing to persist secret-shaped Hermes projection metadata");
  }
  writeFileAtomic(PROJECTION_FILE, serialized, { mode: 0o600 });
}

function requireStore(): ProjectionFile {
  const loaded = loadProjectionFile();
  if (loaded.state === "unavailable") {
    throw new Error("Hermes agent projection store is unavailable");
  }
  return loaded.value;
}

function eventFor(record: ProjectionRecord, type: HermesSubagentEventType): HermesSubagentEvent {
  const event: HermesSubagentEvent = {
    type,
    activityId: record.activityId,
    hermesAgentId: record.hermesAgentId,
    parentBotId: record.parentBotId,
    title: record.name,
    persistent: record.kind === "persistent" || record.status === "promoted",
    transcriptThreadId: record.transcriptThreadId,
    status: record.status,
    ...(record.botId ? { botId: record.botId } : {}),
  };
  if (SECRETISH.test(JSON.stringify(event))) {
    throw new Error("Hermes subagent event contained secret-shaped values");
  }
  return event;
}

export function isTemporaryHermesAgentMember(id: string): boolean {
  const loaded = loadProjectionFile();
  if (loaded.state === "unavailable") return false;
  return Object.values(loaded.value.agents).some(
    (record) => record.kind === "temporary" && record.status !== "promoted" && (record.activityId === id || record.hermesAgentId === id),
  );
}

export function projectHermesAgent(
  store: Store,
  input: {
    hermesAgentId: string;
    kind: "persistent" | "temporary";
    name: string;
    parentBotId: string;
    parentThreadId: string;
  },
): { botId?: string; activityId: string; transcriptThreadId: string; event: HermesSubagentEvent } {
  const file = requireStore();
  const existing = file.agents[input.hermesAgentId];
  if (existing) {
    existing.status = existing.status === "started" ? "updated" : existing.status;
    existing.name = input.name;
    existing.updatedAt = Date.now();
    saveProjectionFile(file);
    return {
      botId: existing.botId,
      activityId: existing.activityId,
      transcriptThreadId: existing.transcriptThreadId,
      event: eventFor(existing, existing.status === "promoted" ? "subagent.promoted" : "subagent.updated"),
    };
  }

  const activityId = newId();
  const record: ProjectionRecord = {
    hermesAgentId: input.hermesAgentId,
    kind: input.kind,
    activityId,
    parentBotId: input.parentBotId,
    parentThreadId: input.parentThreadId,
    name: input.name,
    transcriptThreadId: newId(),
    status: "started",
    updatedAt: Date.now(),
  };

  if (input.kind === "persistent") {
    const bot = store.createBot(
      {
        name: input.name,
        reportsToBotId: input.parentBotId,
        hermesProvenance: {
          hermesAgentId: input.hermesAgentId,
          kind: "persistent",
          parentBotId: input.parentBotId,
        },
      },
      { seedMessages: false },
    );
    record.botId = bot.id;
    record.transcriptThreadId = bot.threadId;
  }

  file.agents[input.hermesAgentId] = record;
  saveProjectionFile(file);
  return {
    botId: record.botId,
    activityId: record.activityId,
    transcriptThreadId: record.transcriptThreadId,
    event: eventFor(record, "subagent.started"),
  };
}

export function completeHermesAgent(
  store: Store,
  input: { hermesAgentId: string },
): { activityId: string; transcriptThreadId: string; event: HermesSubagentEvent } {
  void store;
  const file = requireStore();
  const record = file.agents[input.hermesAgentId];
  if (!record) throw new Error("Hermes agent projection store is unavailable");
  if (record.status !== "promoted") record.status = "completed";
  record.updatedAt = Date.now();
  saveProjectionFile(file);
  return {
    activityId: record.activityId,
    transcriptThreadId: record.transcriptThreadId,
    event: eventFor(record, "subagent.completed"),
  };
}

export function promoteHermesAgent(
  store: Store,
  input: { hermesAgentId?: string; activityId?: string },
): { botId: string; activityId: string; event: HermesSubagentEvent } {
  const file = requireStore();
  const record = input.hermesAgentId
    ? file.agents[input.hermesAgentId]
    : Object.values(file.agents).find((row) => row.activityId === input.activityId);
  if (!record) throw new Error("Hermes agent projection store is unavailable");
  if (record.botId) {
    record.status = "promoted";
    record.updatedAt = Date.now();
    saveProjectionFile(file);
    return { botId: record.botId, activityId: record.activityId, event: eventFor(record, "subagent.promoted") };
  }

  const bot = store.createBot(
    {
      name: record.name,
      reportsToBotId: record.parentBotId,
      hermesProvenance: {
        hermesAgentId: record.hermesAgentId,
        kind: "promoted",
        parentBotId: record.parentBotId,
        sourceActivityId: record.activityId,
      },
    },
    { seedMessages: false },
  );
  for (const message of store.messagesFor(record.transcriptThreadId)) {
    store.appendMessage(bot.threadId, {
      role: message.role,
      kind: message.kind,
      text: message.text,
      ...(message.card ? { card: message.card } : {}),
    });
  }
  record.botId = bot.id;
  record.status = "promoted";
  record.kind = "temporary";
  record.updatedAt = Date.now();
  saveProjectionFile(file);
  return { botId: bot.id, activityId: record.activityId, event: eventFor(record, "subagent.promoted") };
}

export function projectedHermesBot(store: Store, hermesAgentId: string): BotRecord | null {
  const loaded = loadProjectionFile();
  if (loaded.state === "unavailable") return null;
  const record = loaded.value.agents[hermesAgentId];
  if (!record?.botId) return null;
  return store.bot(record.botId);
}

export type PublicHermesSubagentActivity = {
  activityId: string;
  parentThreadId: string;
  title: string;
  status: ProjectionRecord["status"];
  transcriptThreadId: string;
  promoteEligible: boolean;
  updatedAt: number;
};

function publicActivity(record: ProjectionRecord, now = Date.now()): PublicHermesSubagentActivity {
  const activity: PublicHermesSubagentActivity = {
    activityId: record.activityId,
    parentThreadId: record.parentThreadId,
    title: record.name,
    status: record.status,
    transcriptThreadId: record.transcriptThreadId,
    promoteEligible: record.kind === "temporary" && record.status === "completed",
    updatedAt: record.updatedAt || now,
  };
  if (SECRETISH.test(JSON.stringify(activity))) {
    throw new Error("Hermes subagent event contained secret-shaped values");
  }
  return activity;
}

export function hermesSubagentBroadcastFrame(
  record: ProjectionRecord,
  now = Date.now(),
): { kind: "hermes.subagent"; activity: PublicHermesSubagentActivity } {
  return { kind: "hermes.subagent", activity: publicActivity(record, now) };
}

export function listProjectedHermesActivities(): PublicHermesSubagentActivity[] {
  const loaded = loadProjectionFile();
  if (loaded.state === "unavailable") return [];
  return Object.values(loaded.value.agents)
    .filter((record) => record.kind === "temporary" && record.status !== "promoted")
    .map((record) => publicActivity(record));
}

export function projectedHermesSubagentFrame(activityId: string): { kind: "hermes.subagent"; activity: PublicHermesSubagentActivity } | null {
  const loaded = loadProjectionFile();
  if (loaded.state === "unavailable") return null;
  const record = Object.values(loaded.value.agents).find((row) => row.activityId === activityId);
  if (!record || record.kind !== "temporary") return null;
  return hermesSubagentBroadcastFrame(record);
}

export function applyLiveHermesSubagent(
  store: Store,
  input: {
    action: "start" | "complete";
    hermesAgentId: string;
    kind: "persistent" | "temporary";
    name: string;
    parentBotId: string;
    parentThreadId: string;
    text?: string;
  },
): { activityId: string; transcriptThreadId: string } {
  const started = projectHermesAgent(store, {
    hermesAgentId: input.hermesAgentId,
    kind: input.kind,
    name: input.name,
    parentBotId: input.parentBotId,
    parentThreadId: input.parentThreadId,
  });
  if (input.action === "complete") {
    const completed = completeHermesAgent(store, { hermesAgentId: input.hermesAgentId });
    if (input.text) {
      store.appendMessage(completed.transcriptThreadId, { role: "bot", kind: "text", text: input.text });
    }
    return { activityId: completed.activityId, transcriptThreadId: completed.transcriptThreadId };
  }
  if (input.text) {
    store.appendMessage(started.transcriptThreadId, { role: "bot", kind: "text", text: input.text });
  }
  return { activityId: started.activityId, transcriptThreadId: started.transcriptThreadId };
}

export function isProjectedHermesTranscript(threadId: string): boolean {
  const loaded = loadProjectionFile();
  if (loaded.state === "unavailable") return false;
  return Object.values(loaded.value.agents).some((record) => record.transcriptThreadId === threadId);
}
