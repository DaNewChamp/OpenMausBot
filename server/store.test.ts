// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { peerAllowKey } from "./peer-approval-key.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("createBot seeds a greeting and an onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(messages[1].kind).toBe("options");
    expect(messages[1].card?.options.length).toBeGreaterThan(1);
    expect(bot.modelSelection).toEqual(selection());
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("defaults a room to its first member and repairs the lead when membership changes", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Team", [first.id, second.id]);

    expect(group.defaultResponder).toEqual({ kind: "member", botId: first.id });
    store.patchGroup(group.id, { memberIds: [second.id] });
    expect(group.defaultResponder).toEqual({ kind: "member", botId: second.id });

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
  });

  it("migrates old rooms without routing to their first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Legacy team", [first.id, second.id]);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    delete saved[0].defaultResponder;
    writeFileSync(groupsFile, JSON.stringify(saved));

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("migrates unambiguous legacy peer grants without guessing duplicate names", () => {
    const store = new Store(selection);
    const requester = store.createBot();
    const helper = store.patchBot(store.createBot().id, { name: "Helper" })!;
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(requester.id, {
      alwaysAllow: ["ask_bot:@Helper", "delegate_bot:@Twin", "Bash:git status"],
    });

    const reloaded = new Store(selection);
    expect(reloaded.bot(requester.id)?.alwaysAllow).toEqual([
      peerAllowKey("ask_bot", helper.id),
      "delegate_bot:@Twin",
      "Bash:git status",
    ]);

    const persisted: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((bot) => bot.id === requester.id)?.alwaysAllow).toEqual(
      reloaded.bot(requester.id)?.alwaysAllow,
    );
  });

  it("persists a bot's effort level across a restart, defaulting to unset", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.modelSelection.effort).toBeUndefined();

    store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, effort: "high" } });

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.modelSelection.effort).toBe("high");
  });

  it("keeps exactly one persisted Chief of Staff and supports handoff", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();

    expect(store.setChiefOfStaff(first.id)?.map((bot) => bot.id)).toEqual([first.id]);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(true);

    const changed = store.setChiefOfStaff(second.id)!;
    expect(changed.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.setChiefOfStaff(null)?.map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.bots.some((bot) => bot.chiefOfStaff)).toBe(false);
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[1];

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });

  it("deleteBot removes the bot and its transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const file = join(DATA_DIR, `messages-${bot.threadId}.json`);
    expect(existsSync(file)).toBe(true);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(store.deleteBot(bot.id)).toBe(false);
  });

  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("seedIfEmpty creates exactly one starter bot, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);

    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(1);
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[1].id); // follows the onboarding card
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId); // sibling, not child
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    // the abandoned branch still exists in the tree
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    // back to the original branch: the leaf is v1's reply, not v1 itself
    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });

  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
});

describe("Store compaction records", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const seed = (store: Store, threadId: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(store.appendMessage(threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `m${i}` }).id);
    }
    return ids;
  };

  it("modelContext is the whole active path when nothing was compacted", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 4);
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBeUndefined();
    // the seeded greeting + card + 4 messages: everything on the path
    expect(ctx.messages.length).toBe(store.activePath(bot.threadId).length);
  });

  it("a compaction record lives in the tree, keeps everything behind it, and modelContext starts at firstKeptId", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const ids = seed(store, bot.threadId, 6);
    const record = store.appendCompaction(bot.threadId, { summary: "they discussed m0..m2", firstKeptId: ids[3], tokensBefore: 999 });
    expect(record.kind).toBe("compaction");
    expect(record.compaction).toEqual({ summary: "they discussed m0..m2", firstKeptId: ids[3], tokensBefore: 999 });
    // nothing deleted: the display path still reaches message one
    expect(store.activePath(bot.threadId).some((m) => m.text === "m0")).toBe(true);
    // the model-facing view: summary + kept tail (m3..m5), no record itself
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBe("they discussed m0..m2");
    expect(ctx.messages.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
    // and later messages descend from the record
    const later = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "m6" });
    expect(later.parentId).toBe(record.id);
    expect(store.modelContext(bot.threadId).messages.map((m) => m.text)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("the latest compaction wins, and a rewind to before it ignores it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const ids = seed(store, bot.threadId, 6);
    store.appendCompaction(bot.threadId, { summary: "first", firstKeptId: ids[2], tokensBefore: 1 });
    seed(store, bot.threadId, 2); // m6, m7 after the first record
    const second = store.appendCompaction(bot.threadId, { summary: "second", firstKeptId: ids[5], tokensBefore: 2 });
    expect(store.modelContext(bot.threadId).summary).toBe("second");
    // rewind: switch the branch back to m3 — the records are downstream and no longer apply
    store.setActiveLeaf(bot.threadId, ids[3]);
    // setActiveLeaf descends to the newest leaf, which is past both records; branch instead
    const fork = store.branchMessage(bot.threadId, ids[4], "edited m4")!;
    expect(fork).toBeTruthy();
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBeUndefined();
    expect(ctx.messages.map((m) => m.text)).toContain("edited m4");
    expect(second.kind).toBe("compaction");
  });
});
