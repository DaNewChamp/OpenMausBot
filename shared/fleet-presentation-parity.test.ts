import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  friendlyNameFromHost,
  presentBridgeRoster,
  resolveHubDisplayName,
  type BridgeRosterEntryLike,
  type HubDisplayInput,
} from "./fleet-presentation.ts";

interface HubParityCase {
  id: string;
  input: HubDisplayInput;
  expected: string;
}

interface FriendlyHostCase {
  id: string;
  host: string;
  expected: string;
}

interface BridgeRosterParityCase {
  id: string;
  bridges: BridgeRosterEntryLike[];
  expectedIds: string[];
  expectedStale: boolean[];
  expectedDisplayNames: string[];
}

interface ParityFixture {
  hubDisplay: HubParityCase[];
  friendlyHost: FriendlyHostCase[];
  bridgeRoster: BridgeRosterParityCase[];
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fleet-presentation-parity.json",
);
const parity = JSON.parse(readFileSync(fixturePath, "utf8")) as ParityFixture;

describe("fleet presentation Swift/TS parity matrix", () => {
  it.each(parity.hubDisplay)("hub display: $id", ({ input, expected }) => {
    expect(resolveHubDisplayName(input)).toBe(expected);
  });

  it.each(parity.friendlyHost)("friendly host: $id", ({ host, expected }) => {
    expect(friendlyNameFromHost(host)).toBe(expected);
  });

  it.each(parity.bridgeRoster)("bridge roster: $id", ({
    bridges,
    expectedIds,
    expectedStale,
    expectedDisplayNames,
  }) => {
    const presented = presentBridgeRoster(bridges);
    expect(presented.map((row) => row.entry.id)).toEqual(expectedIds);
    expect(presented.map((row) => row.stale)).toEqual(expectedStale);
    expect(presented.map((row) => row.displayName)).toEqual(expectedDisplayNames);
  });
});
