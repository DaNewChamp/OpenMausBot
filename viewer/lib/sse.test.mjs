import assert from "node:assert/strict";
import test from "node:test";

import { advanceCursor, createSseParser, parseSseBlock } from "./sse.mjs";

test("parseSseBlock reads id and JSON data", () => {
  const frame = parseSseBlock('id: abc:12\ndata: {"kind":"hello","resumed":true}\n');
  assert.equal(frame.id, "abc:12");
  assert.deepEqual(frame.payload, { kind: "hello", resumed: true });
});

test("parseSseBlock ignores keepalive comments", () => {
  assert.equal(parseSseBlock(": keepalive\n\n"), null);
});

test("createSseParser handles chunked input", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.feed('data: {"kind":"bot"'), []);
  const frames = parser.feed(',"seq":1}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.kind, "bot");
  assert.equal(frames[0].payload.seq, 1);
});

test("advanceCursor preserves stream id", () => {
  assert.equal(advanceCursor("stream1:4", 9), "stream1:9");
  assert.equal(advanceCursor(null, 9), null);
});
