// Cross-thread search: a roster of bots, threads that live for weeks, and
// until now no way to find anything. A linear scan over every thread's
// messages — threads are already in memory once touched, and the store is
// small enough that an index would be premature. Pure: the server hands in
// the threads, this returns hits.
import type { Message } from "./store.ts";

export interface SearchableThread {
  /** who the thread belongs to — a bot's task or a room */
  owner: { botId: string; name: string } | { groupId: string; name: string };
  threadId: string;
  /** the task title (bots) or the room name */
  title: string;
  messages: Message[];
  /** ids on the visible branch — a hit off it needs a version switch */
  activePath: ReadonlySet<string>;
}

export interface SearchHit {
  botId?: string;
  groupId?: string;
  ownerName: string;
  threadId: string;
  taskTitle: string;
  messageId: string;
  role: Message["role"];
  kind: Message["kind"];
  /** room messages: which member said it */
  from?: string;
  at: number;
  /** ±SNIPPET_RADIUS chars around the first match, ellipsised */
  snippet: string;
  /** offset of the match inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  onActivePath: boolean;
}

const SNIPPET_RADIUS = 60;
const DEFAULT_LIMIT = 50;

/** What a message contributes to search: its text, and for activity its
 * tool name too — "which bot ran that migration" is a tool-name question. */
function haystack(m: Message): string {
  const parts = [m.text ?? ""];
  if (m.kind === "activity" && m.tool?.name) parts.unshift(m.tool.name);
  return parts.filter(Boolean).join(" ");
}

function snippetAround(text: string, at: number, length: number): { snippet: string; matchStart: number } {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const body = text.slice(start, end).replace(/\s+/g, " ");
  // whitespace folding can shift the offset; find the match again inside
  const snippet = `${head}${body}${tail}`;
  const needle = text.slice(at, at + length).replace(/\s+/g, " ").toLowerCase();
  const matchStart = snippet.toLowerCase().indexOf(needle);
  return { snippet, matchStart: matchStart < 0 ? head.length : matchStart };
}

export function searchThreads(
  threads: readonly SearchableThread[],
  opts: { q: string; botId?: string; kind?: Message["kind"]; limit?: number },
): SearchHit[] {
  const q = opts.q.trim().toLowerCase();
  if (!q) return [];
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const hits: SearchHit[] = [];
  for (const t of threads) {
    const botId = "botId" in t.owner ? t.owner.botId : undefined;
    if (opts.botId && botId !== opts.botId) continue;
    for (const m of t.messages) {
      if (opts.kind && m.kind !== opts.kind) continue;
      const text = haystack(m);
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const { snippet, matchStart } = snippetAround(text, at, q.length);
      hits.push({
        ...(botId ? { botId } : { groupId: (t.owner as { groupId: string }).groupId }),
        ownerName: t.owner.name,
        threadId: t.threadId,
        taskTitle: t.title,
        messageId: m.id,
        role: m.role,
        kind: m.kind,
        ...(m.from?.name ? { from: m.from.name } : {}),
        at: m.at,
        snippet,
        matchStart,
        matchLength: q.length,
        onActivePath: t.activePath.has(m.id),
      });
    }
  }
  hits.sort((a, b) => b.at - a.at);
  return hits.slice(0, limit);
}
