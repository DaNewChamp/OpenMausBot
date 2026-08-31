import { describe, expect, it } from "vitest";

import { WIRE_PLATFORMS } from "../../../shared/runtime-platform";
import { RUNTIME_PROFILES } from "../../../shared/runtime-profile";
import {
  runtimeProfileSchema,
  WORKER_RUNTIME_PROFILES,
  WORKER_WIRE_PLATFORMS,
} from "../src/fleet";

describe("Worker runtime-profile vocabulary", () => {
  it("derives the exposed list and schema in the shared order", () => {
    expect([...WORKER_RUNTIME_PROFILES]).toEqual([...RUNTIME_PROFILES]);
    expect([...runtimeProfileSchema.options]).toEqual([...RUNTIME_PROFILES]);
    expect([...WORKER_WIRE_PLATFORMS]).toEqual([...WIRE_PLATFORMS]);
  });
});
