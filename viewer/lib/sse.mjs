/** Parse one SSE event block (lines between blank-line delimiters). */
export function parseSseBlock(block) {
  const trimmed = block.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;

  let id = null;
  let data = null;
  for (const line of trimmed.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id: ")) id = line.slice(4).trim();
    else if (line.startsWith("data: ")) {
      const piece = line.slice(6);
      data = data === null ? piece : `${data}\n${piece}`;
    }
  }
  if (data === null) return null;
  try {
    return { id, payload: JSON.parse(data) };
  } catch {
    return null;
  }
}

/** Stateful SSE parser for fetch() body chunks. */
export function createSseParser() {
  let buffer = "";

  return {
    feed(chunk) {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      const frames = [];
      for (const part of parts) {
        const frame = parseSseBlock(part);
        if (frame) frames.push(frame);
      }
      return frames;
    },
    flush() {
      const frame = parseSseBlock(buffer);
      buffer = "";
      return frame ? [frame] : [];
    },
  };
}

/** Advance `<streamId>:<seq>` cursor after folding a numbered frame. */
export function advanceCursor(cursor, seq) {
  if (!cursor || seq == null) return cursor;
  const streamId = cursor.split(":")[0];
  if (!streamId) return cursor;
  return `${streamId}:${seq}`;
}
