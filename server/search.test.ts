import { describe, expect, it } from "vitest";

import { searchThreads, type SearchableThread } from "./search.ts";
import type { Message } from "./store.ts";

const msg = (id: string, over: Partial<Message> & { at: number }): Message =>
  ({ id, role: "user", kind: "text", parentId: null, ...over }) as Message;

// one bot with two tasks (one branched), one room
const threads: SearchableThread[] = [
  {
    owner: { botId: "b1", name: "Brody" },
    threadId: "t1",
    title: "startups list",
    messages: [
      msg("m1", { at: 100, text: "make me a list of all the startups on this website" }),
      msg("m2", { at: 200, role: "bot", text: "Done — 977 rows after cleaning.", parentId: "m1" }),
      msg("m3", { at: 300, role: "bot", kind: "activity", tool: { name: "Bash", ok: true }, text: "ran the migration script", parentId: "m2" }),
      // an edited version of m1 — a sibling branch, not on the active path
      msg("m1b", { at: 400, text: "make me a list of the Bangalore startups", parentId: null }),
      msg("m4", { at: 500, role: "bot", text: "Here is the Bangalore list.", parentId: "m1b" }),
    ],
    activePath: new Set(["m1b", "m4"]),
  },
  {
    owner: { botId: "b1", name: "Brody" },
    threadId: "t2",
    title: "dog",
    messages: [msg("m5", { at: 600, text: "my dogs name is Yin" }), msg("m6", { at: 700, role: "bot", text: "Noted: Yin.", parentId: "m5" })],
    activePath: new Set(["m5", "m6"]),
  },
  {
    owner: { groupId: "g1", name: "Ops room" },
    threadId: "t3",
    title: "Ops room",
    messages: [msg("m7", { at: 800, role: "bot", text: "The Bangalore deploy is done", from: { botId: "b2", name: "GitScout", color: "green" } })],
    activePath: new Set(["m7"]),
  },
];

describe("searchThreads", () => {
  it("finds text case-insensitively across bots and rooms, newest first", () => {
    const hits = searchThreads(threads, { q: "bangalore" });
    expect(hits.map((h) => h.messageId)).toEqual(["m7", "m4", "m1b"]);
    expect(hits[0]).toMatchObject({ groupId: "g1", threadId: "t3", from: "GitScout" });
    expect(hits[1]).toMatchObject({ botId: "b1", threadId: "t1", taskTitle: "startups list" });
  });

  it("marks hits on the visible branch, so a click knows whether to switch versions", () => {
    const hits = searchThreads(threads, { q: "list" });
    const byId = Object.fromEntries(hits.map((h) => [h.messageId, h.onActivePath]));
    expect(byId.m1b).toBe(true);
    expect(byId.m1).toBe(false); // the abandoned original
  });

  it("searches activity by tool name and text, so 'which bot ran that migration' is answerable", () => {
    expect(searchThreads(threads, { q: "migration" }).map((h) => h.messageId)).toEqual(["m3"]);
    expect(searchThreads(threads, { q: "bash" }).map((h) => h.messageId)).toEqual(["m3"]);
    expect(searchThreads(threads, { q: "bash", kind: "text" })).toEqual([]);
  });

  it("filters by bot and caps results", () => {
    expect(searchThreads(threads, { q: "bangalore", botId: "b1" }).map((h) => h.messageId)).toEqual(["m4", "m1b"]);
    expect(searchThreads(threads, { q: "bangalore", limit: 1 }).map((h) => h.messageId)).toEqual(["m7"]);
  });

  it("returns a snippet windowed around the match", () => {
    const [hit] = searchThreads(threads, { q: "startups on" });
    expect(hit.snippet).toContain("startups on");
    expect(hit.matchStart).toBe(hit.snippet.toLowerCase().indexOf("startups on"));
    const long = searchThreads(
      [{ ...threads[0], messages: [msg("x", { at: 1, text: `${"a".repeat(200)} needle ${"b".repeat(200)}` })], activePath: new Set(["x"]) }],
      { q: "needle" },
    )[0];
    expect(long.snippet.length).toBeLessThan(160);
    expect(long.snippet).toMatch(/^…a+ needle b+…$/);
  });

  it("ignores an empty or whitespace query", () => {
    expect(searchThreads(threads, { q: "  " })).toEqual([]);
  });
});
