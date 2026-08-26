import { z } from "zod";

const chatPinSchema = z
  .object({
    pinned: z.boolean({ error: "pinned must be true or false" }),
  })
  .strict();

export type ChatPinResult =
  | { ok: true; pinned: boolean }
  | { ok: false; error: string };

/** The paired-device pin contract owns exactly one field. */
export function parseChatPin(input: unknown): ChatPinResult {
  const parsed = chatPinSchema.safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unsupported?.code === "unrecognized_keys") {
      return { ok: false, error: `unsupported pin field: ${unsupported.keys[0] ?? "unknown"}` };
    }
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid pin patch" };
  }
  return { ok: true, pinned: parsed.data.pinned };
}
