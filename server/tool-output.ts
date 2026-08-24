// Bounding what a harness-owned MCP server hands back to an agent.
//
// CLI drivers run their own tools, so the harness never sees that output —
// this only covers the servers WE own (computer-proxy, agents-proxy,
// phone-proxy), which is where the bloat actually is: semantic browser
// snapshots, computer_exec stdout, ask_bot replies. A 400 KB tool result is
// not information, it is a context window spent, and the agent cannot
// un-spend it.
//
// The head is always kept: the beginning of an output is where the answer
// usually is, and a caller that loses it has to run the tool again.
export const SPILL_THRESHOLD_BYTES = 20_000;
export const SPILL_HEAD_BYTES = 2_000;

function headSlice(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= SPILL_HEAD_BYTES) return text;
  // a multi-byte character sliced in half decodes as U+FFFD — drop it
  return buf.subarray(0, SPILL_HEAD_BYTES).toString("utf8").replace(/�+$/, "");
}

export function boundToolText(text: string): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= SPILL_THRESHOLD_BYTES) return text;
  const head = headSlice(text);
  const shown = Buffer.byteLength(head, "utf8");
  return `${head}\n\n[Output truncated: ${total} bytes total, first ${shown} shown. Re-run narrowed (grep/head/a tighter selector) if you need the rest.]`;
}
