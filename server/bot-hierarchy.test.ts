import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  canConfigureBot,
  canCreateBot,
  hierarchyRoster,
  isTeamLead,
  resolveCreateReportsToWithStore,
  validateNewBotReportsTo,
  validateReportsToAssignment,
  validateReportsToForBot,
} from "./bot-hierarchy.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("bot hierarchy", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("detects team leads by title and manager", () => {
    expect(isTeamLead({ title: "Chief of Investments", reportsToBotId: "chief", chiefOfStaff: false })).toBe(true);
    expect(isTeamLead({ title: "Analyst", reportsToBotId: "chief", chiefOfStaff: false })).toBe(false);
    expect(isTeamLead({ title: "Chief of Staff", chiefOfStaff: true })).toBe(false);
  });

  it("lets team leads create and configure direct reports only", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Work" }, { seedMessages: false });
    store.setChiefOfStaff(chief.id);
    const lead = store.createBot({ name: "Inv Chief", title: "Chief of Investments", section: "Work" }, { seedMessages: false });
    store.patchBot(lead.id, { reportsToBotId: chief.id });
    const analyst = store.createBot({ name: "Analyst", section: "Work" }, { seedMessages: false });
    store.patchBot(analyst.id, { reportsToBotId: lead.id });

    expect(canCreateBot(lead)).toBe(true);
    expect(canCreateBot(chief)).toBe(true);
    expect(canConfigureBot(lead, analyst)).toBe(true);
    expect(canConfigureBot(lead, chief)).toBe(false);
    expect(canConfigureBot(chief, analyst)).toBe(true);
    expect(resolveCreateReportsToWithStore(store, lead, undefined)).toEqual({ reportsToBotId: lead.id });
    expect(resolveCreateReportsToWithStore(store, lead, chief.id)).toEqual({
      error: "team leads may only create bots that report to themselves",
    });
  });

  it("builds an indented hierarchy roster", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Work" }, { seedMessages: false });
    store.setChiefOfStaff(chief.id);
    const lead = store.createBot({ name: "Inv", title: "Chief of Investments", section: "Work" }, { seedMessages: false });
    store.patchBot(lead.id, { reportsToBotId: chief.id });
    const analyst = store.createBot({ name: "Ada", section: "Work" }, { seedMessages: false });
    store.patchBot(analyst.id, { reportsToBotId: lead.id });

    const roster = hierarchyRoster(store.bots, chief.id);
    expect(roster.map((e) => [e.bot.name, e.depth])).toEqual([
      ["Inv", 0],
      ["Ada", 1],
    ]);
  });

  it("rejects cycles and cross-section reports", () => {
    const store = new Store(selection);
    const a = store.createBot({ name: "A", section: "Work" }, { seedMessages: false });
    const b = store.createBot({ name: "B", section: "Work" }, { seedMessages: false });
    store.patchBot(a.id, { reportsToBotId: b.id });
    const cycle = validateReportsToForBot(store, b.id, a.id);
    expect(cycle).toMatch(/cycle/i);

    const personal = store.createBot({ name: "Home", section: "Personal" }, { seedMessages: false });
    const cross = validateNewBotReportsTo(store, "Work", personal.id);
    expect(cross).toMatch(/same section/i);

    const apexErr = validateReportsToAssignment(store.bots, {
      section: "Work",
      chiefOfStaff: true,
      reportsToBotId: a.id,
    });
    expect(apexErr).toMatch(/Chief of Staff cannot report/i);
  });
});
