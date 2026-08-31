import { describe, expect, it } from "vitest";

import { RUNTIME_PROFILES } from "../../../shared/runtime-profile";
import { runtimeProfileSchema, WORKER_RUNTIME_PROFILES } from "../src/fleet";

describe("Worker runtime-profile vocabulary", () => {
  it("derives the exposed list and schema in the shared order", () => {
    expect([...WORKER_RUNTIME_PROFILES]).toEqual([...RUNTIME_PROFILES]);
    expect([...runtimeProfileSchema.options]).toEqual([...RUNTIME_PROFILES]);
  });
});
