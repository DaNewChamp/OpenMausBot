// Memory synthesis writes into a file the USER owns.
//
// MEMORY.md is plain markdown the person can open, edit, or delete — that is
// the whole point of it being a file. So the only thing synthesis is allowed
// to touch is what sits between its own markers, and everything above and
// below has to come back byte-identical. These tests are mostly about the
// cases where that could go wrong: a hand-edited file, no markers, two sets
// of markers, markers that appear inside a code block.
import { describe, expect, it } from "vitest";

import {
  MAX_SYNTHESIZED_BYTES,
  SYNTHESIS_CLOSE,
  SYNTHESIS_OPEN,
  buildSynthesisPrompt,
  parseSynthesisOutput,
  readSynthesized,
  writeSynthesized,
} from "./memory-synthesis.ts";

const hand = "# Memory\n\nOmkar prefers short replies.\n";
const withBlock = `${hand}\n${SYNTHESIS_OPEN}\n- learned a thing\n${SYNTHESIS_CLOSE}\n\nA note I added after.\n`;

describe("readSynthesized", () => {
  it("splits a file that has the block", () => {
    const read = readSynthesized(withBlock);
    expect(read).not.toBe("missing");
    expect(read).not.toBe("ambiguous");
    if (read === "missing" || read === "ambiguous") return;
    expect(read.body).toBe("- learned a thing");
    expect(read.before).toContain("Omkar prefers short replies.");
    expect(read.after).toContain("A note I added after.");
  });

  it("reports missing for a file with no block", () => {
    expect(readSynthesized(hand)).toBe("missing");
  });

  it("refuses a file with two blocks rather than guessing which is ours", () => {
    expect(readSynthesized(`${withBlock}\n${SYNTHESIS_OPEN}\n- another\n${SYNTHESIS_CLOSE}\n`)).toBe("ambiguous");
  });

  it("refuses a half-open block", () => {
    expect(readSynthesized(`${hand}\n${SYNTHESIS_OPEN}\n- unterminated\n`)).toBe("ambiguous");
  });

  it("refuses a close that comes before its open", () => {
    expect(readSynthesized(`${hand}\n${SYNTHESIS_CLOSE}\n- backwards\n${SYNTHESIS_OPEN}\n`)).toBe("ambiguous");
  });
});

describe("writeSynthesized", () => {
  it("replaces only the block, leaving hand-written text either side untouched", () => {
    const next = writeSynthesized(withBlock, "- a newer thing");
    expect(next).not.toBeNull();
    expect(next).toContain("Omkar prefers short replies.");
    expect(next).toContain("A note I added after.");
    expect(next).toContain("- a newer thing");
    expect(next).not.toContain("- learned a thing");
  });

  it("appends a block to a file that has none, without disturbing what is there", () => {
    const next = writeSynthesized(hand, "- first fact");
    expect(next?.startsWith(hand)).toBe(true);
    expect(next).toContain(SYNTHESIS_OPEN);
    expect(next).toContain("- first fact");
  });

  it("refuses an ambiguous file rather than rewriting it", () => {
    expect(writeSynthesized(`${withBlock}${SYNTHESIS_OPEN}\nx\n${SYNTHESIS_CLOSE}\n`, "- nope")).toBeNull();
  });

  it("refuses a body that would blow the budget", () => {
    expect(writeSynthesized(hand, "x".repeat(MAX_SYNTHESIZED_BYTES + 1))).toBeNull();
  });

  it("round-trips: what it writes is what readSynthesized reads back", () => {
    const next = writeSynthesized(hand, "- round trip");
    const read = next === null ? "missing" : readSynthesized(next);
    if (read === "missing" || read === "ambiguous") throw new Error("expected a block");
    expect(read.body).toBe("- round trip");
  });

  it("strips a marker out of the body so a fact cannot forge a second block", () => {
    const next = writeSynthesized(hand, `- sneaky ${SYNTHESIS_CLOSE} more`);
    expect(next).not.toBeNull();
    if (next === null) return;
    expect(next.split(SYNTHESIS_CLOSE).length - 1).toBe(1);
    expect(readSynthesized(next)).not.toBe("ambiguous");
  });
});

describe("parseSynthesisOutput", () => {
  it("reads a JSON array of one-line facts", () => {
    expect(parseSynthesisOutput('["Omkar ships on Fridays", "The repo is milind-soni/OpenMausBot"]')).toEqual([
      "Omkar ships on Fridays",
      "The repo is milind-soni/OpenMausBot",
    ]);
  });

  it("finds the array inside chatter", () => {
    expect(parseSynthesisOutput('Here you go:\n```json\n["one fact"]\n```')).toEqual(["one fact"]);
  });

  it("returns an empty list for an empty array — nothing learned is a valid answer", () => {
    expect(parseSynthesisOutput("[]")).toEqual([]);
  });

  it("returns null for null, prose, or broken JSON", () => {
    expect(parseSynthesisOutput(null)).toBeNull();
    expect(parseSynthesisOutput("I did not find anything worth keeping.")).toBeNull();
    expect(parseSynthesisOutput('["unterminated')).toBeNull();
  });

  it("drops non-strings and blanks rather than writing them down", () => {
    expect(parseSynthesisOutput('["good", 42, "", "   ", null, "also good"]')).toEqual(["good", "also good"]);
  });

  it("flattens newlines so one fact stays one line", () => {
    expect(parseSynthesisOutput('["a fact\\nwith a newline"]')).toEqual(["a fact with a newline"]);
  });
});

describe("buildSynthesisPrompt", () => {
  const prompt = buildSynthesisPrompt(
    [{ user: "I always deploy on Friday", assistant: "Noted." }],
    "- Omkar uses pnpm",
  );

  it("carries the evidence and what is already known", () => {
    expect(prompt).toContain("deploy on Friday");
    expect(prompt).toContain("Omkar uses pnpm");
  });

  it("fences the conversation as data", () => {
    expect(prompt).toContain("[BEGIN CONVERSATION]");
    expect(prompt).toContain("[END CONVERSATION]");
  });

  it("asks for durable facts only, and for a JSON array", () => {
    expect(prompt.toLowerCase()).toContain("durable");
    expect(prompt).toContain("JSON");
  });
});
