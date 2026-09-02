// @ts-expect-error shared runtime module has no generated types
import { createSseParser } from "../../viewer/lib/sse.mjs";

export interface AuthorizedEventStreamOptions {
  url: string;
  token: string;
  onOpen?: () => void;
  onError?: () => void;
  onFrame: (frame: unknown) => void;
}

export function openAuthorizedEventStream(options: AuthorizedEventStreamOptions): () => void {
  const controller = new AbortController();
  let alive = true;

  void (async () => {
    try {
      const response = await fetch(options.url, {
        headers: { authorization: `Bearer ${options.token}`, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      options.onOpen?.();
      const parser = createSseParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (alive) {
        const { done, value } = await reader.read();
        if (done) break;
        const frames = parser.feed(decoder.decode(value, { stream: true }));
        for (const frame of frames) {
          try {
            options.onFrame(JSON.parse(frame.payload));
          } catch {
            /* ignore malformed frames */
          }
        }
      }
      for (const frame of parser.flush()) {
        try {
          options.onFrame(JSON.parse(frame.payload));
        } catch {
          /* ignore malformed frames */
        }
      }
    } catch {
      if (alive) options.onError?.();
    }
  })();

  return () => {
    alive = false;
    controller.abort();
  };
}
