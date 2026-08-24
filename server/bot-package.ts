import { z } from "zod";

import { schemaIssue, type JsonValue } from "./schema.ts";
import type { MausColor } from "./store.ts";
import type { TeamManifestMember } from "./team-manifest.ts";

export const BOT_PACKAGE_FORMAT = "openmaus.package" as const;
export const BOT_PACKAGE_VERSION = 1 as const;

const COLORS = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
] as const satisfies readonly MausColor[];

const requiredText = (max: number) =>
  z.string({ error: "must be text" }).trim().min(1, { message: "is required" }).max(max, { message: "is too long" });

const optionalText = (max: number) =>
  z
    .union([z.string({ error: "must be text" }), z.null(), z.undefined()])
    .transform((value) => value?.trim() || undefined)
    .refine((value) => value === undefined || value.length <= max, { message: "is too long" })
    .optional();

const key = requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
  message: "may only contain lowercase letters, numbers, - and _",
});

const packageSchema = z.object({
  format: z.literal(BOT_PACKAGE_FORMAT, { error: "This is not an OpenMaus package" }),
  version: z.literal(BOT_PACKAGE_VERSION, { error: "Package version is not supported" }),
  package: z.object({
    id: requiredText(80).regex(/^[a-z0-9][a-z0-9-]*$/, { message: "must be a lowercase slug" }),
    release: requiredText(30).regex(/^\d+\.\d+\.\d+$/, { message: "must be semantic versioning" }),
    name: requiredText(100),
    tagline: requiredText(160),
    summary: requiredText(2_000),
    category: requiredText(80),
    author: z.object({ name: requiredText(100), url: optionalText(500) }),
    license: requiredText(80),
    featured: z.boolean().optional(),
    tags: z.array(requiredText(80)).max(30).optional(),
    outcomes: z.array(requiredText(240)).min(1).max(12),
    setupMinutes: z.number().int().min(1).max(240),
    requirements: z.object({
      apps: z.array(z.object({
        slug: key,
        label: requiredText(100),
        reason: requiredText(240),
        optional: z.boolean().optional(),
      })).max(30),
      capabilities: z.array(requiredText(80)).max(20),
      platforms: z.array(requiredText(80)).max(10).optional(),
    }),
    agents: z.array(z.object({
      key,
      name: requiredText(100),
      title: optionalText(200),
      description: optionalText(4_000),
      appearance: z.object({
        color: z.enum(COLORS, { error: "is not supported" }),
        mascotExpression: optionalText(80),
      }),
      playbooks: z.array(key).max(40).optional(),
    })).min(1).max(200),
    chiefOfStaff: key.optional(),
    rooms: z.array(z.object({
      key,
      name: requiredText(100),
      members: z.array(key).min(1).max(200),
      bulletin: optionalText(12_000),
      defaultResponder: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("agent"), agent: key }),
        z.object({ kind: z.literal("everyone") }),
        z.object({ kind: z.literal("mentions") }),
      ]),
    })).max(30).optional(),
    routines: z.array(z.object({
      key,
      name: requiredText(80),
      agent: key,
      prompt: requiredText(20_000),
      runOn: z.enum(["maus", "cloud"]),
      schedule: z.discriminatedUnion("type", [
        z.object({ type: z.literal("once"), at: z.number().int() }),
        z.object({
          type: z.literal("daily"),
          time: requiredText(5).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "must use HH:MM" }),
          weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        }),
      ]),
      durationMinutes: z.number().int().min(15).max(240),
      enabledAfterInstall: z.literal(false),
    })).max(50).optional(),
    playbooks: z.array(z.object({
      key,
      name: requiredText(100),
      summary: requiredText(300),
      triggers: z.array(requiredText(100)).min(1).max(30),
      instructions: requiredText(24_000),
    })).max(80).optional(),
    examples: z.array(z.object({
      title: requiredText(120),
      input: requiredText(4_000),
      output: requiredText(8_000),
    })).max(12).optional(),
  }),
});

export type ParsedBotPackage = z.infer<typeof packageSchema>;
export type BotPackageDefinition = ParsedBotPackage["package"];
export type BotPackageAgent = BotPackageDefinition["agents"][number];
export type BotPackagePlaybook = NonNullable<BotPackageDefinition["playbooks"]>[number];

export function isBotPackage(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (value as { format?: unknown }).format === BOT_PACKAGE_FORMAT;
}

/** Parse and cross-reference one complete, portable package. Unknown fields
 * are stripped; ids, grants, credentials, paths, model selections, and
 * runtime state therefore cannot ride through the package boundary. */
export function parseBotPackage(value: JsonValue | ParsedBotPackage): ParsedBotPackage {
  const parsed = packageSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "This is not a bot package"));
  const pkg = parsed.data.package;

  const unique = (values: string[], label: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) throw new Error(`Duplicate ${label} key: ${value}`);
      seen.add(value);
    }
    return seen;
  };
  const agents = unique(pkg.agents.map((agent) => agent.key), "agent");
  const playbooks = unique((pkg.playbooks ?? []).map((playbook) => playbook.key), "playbook");
  unique((pkg.rooms ?? []).map((room) => room.key), "room");
  unique((pkg.routines ?? []).map((routine) => routine.key), "routine");

  if (pkg.chiefOfStaff && !agents.has(pkg.chiefOfStaff)) {
    throw new Error(`Unknown Chief of Staff: ${pkg.chiefOfStaff}`);
  }
  for (const agent of pkg.agents) {
    for (const playbook of agent.playbooks ?? []) {
      if (!playbooks.has(playbook)) throw new Error(`Agent ${agent.key} references unknown playbook: ${playbook}`);
    }
  }
  for (const room of pkg.rooms ?? []) {
    const members = unique(room.members, `member in room ${room.key}`);
    for (const member of members) {
      if (!agents.has(member)) throw new Error(`Room ${room.key} references unknown agent: ${member}`);
    }
    if (room.defaultResponder.kind === "agent" && !members.has(room.defaultResponder.agent)) {
      throw new Error(`Room ${room.key} has an unknown default responder`);
    }
  }
  for (const routine of pkg.routines ?? []) {
    if (!agents.has(routine.agent)) throw new Error(`Routine ${routine.key} references unknown agent: ${routine.agent}`);
  }
  return parsed.data;
}

export function packageAgentAsMember(agent: BotPackageAgent): TeamManifestMember {
  return {
    key: agent.key,
    name: agent.name,
    title: agent.title ?? "",
    description: agent.description ?? "",
    appearance: {
      color: agent.appearance.color,
      ...(agent.appearance.mascotExpression ? { mascotExpression: agent.appearance.mascotExpression } : {}),
    },
  };
}
