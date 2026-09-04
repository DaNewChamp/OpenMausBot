import { describe, expect, it } from "vitest";

import { parseComputerHostId } from "./computer-host.ts";

describe("parseComputerHostId", () => {
  it("accepts a paired machine id, and treats null as a clear", () => {
    expect(parseComputerHostId("d029c24b-aaaa-bbbb-cccc-ddddeeeeffff")).toEqual({
      ok: true,
      computerHostId: "d029c24b-aaaa-bbbb-cccc-ddddeeeeffff",
    });
    expect(parseComputerHostId(null)).toEqual({ ok: true, computerHostId: null });
    expect(parseComputerHostId("")).toEqual({ ok: true, computerHostId: null });
    expect(parseComputerHostId(undefined)).toEqual({ ok: true });
  });

  it("rejects values that are not paired machine ids", () => {
    expect(parseComputerHostId("../etc")).toMatchObject({ ok: false });
    expect(parseComputerHostId("host with spaces")).toMatchObject({ ok: false });
    expect(parseComputerHostId(1)).toMatchObject({ ok: false });
  });
});
