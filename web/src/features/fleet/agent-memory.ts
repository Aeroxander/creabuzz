/**
 * Browser-agent memory (v1).
 *
 * A lightweight persistent store (localStorage) keyed by work context so the
 * tab agent carries prior decisions into follow-ups: tasks key by task id,
 * mentions key by channel. Survives reloads; purely agent-private.
 */

const MEMORY_PREFIX = "buzz.agent.memory.";
const MAX_ENTRY_CHARS = 800; // keep each entry compact for prompt budgets

export interface AgentMemoryEntry {
  taskId?: string;
  channelId?: string;
  instruction: string;
  outcome: string;
  createdAt: number;
}

function keyFor(opts: { taskId?: string; channelId?: string }): string {
  if (opts.taskId) return `${MEMORY_PREFIX}task:${opts.taskId}`;
  return `${MEMORY_PREFIX}channel:${opts.channelId ?? "global"}`;
}

export function readMemory(opts: {
  taskId?: string;
  channelId?: string;
}): AgentMemoryEntry | null {
  try {
    const raw = localStorage.getItem(keyFor(opts));
    return raw ? (JSON.parse(raw) as AgentMemoryEntry) : null;
  } catch {
    return null;
  }
}

export function writeMemory(opts: {
  taskId?: string;
  channelId?: string;
  instruction: string;
  outcome: string;
}): void {
  try {
    const entry: AgentMemoryEntry = {
      ...opts,
      outcome: opts.outcome.slice(0, MAX_ENTRY_CHARS),
      createdAt: Date.now(),
    };
    localStorage.setItem(keyFor(opts), JSON.stringify(entry));
  } catch {
    // storage full or unavailable — memory is best-effort
  }
}

/** Recent channel turns (last 8) as compact context lines. */
export function recentChannelMemory(channelId: string): string[] {
  try {
    const raw = localStorage.getItem(`${MEMORY_PREFIX}channel:${channelId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { history?: { i: string; o: string }[] };
    return (parsed.history ?? []).slice(-8).map((h) => `- ${h.i} => ${h.o}`);
  } catch {
    return [];
  }
}

export function appendChannelMemory(
  channelId: string,
  instruction: string,
  outcome: string,
): void {
  try {
    const raw = localStorage.getItem(`${MEMORY_PREFIX}channel:${channelId}`);
    const existing = raw
      ? (JSON.parse(raw) as { history?: { i: string; o: string }[] })
      : {};
    const history = [
      ...(existing.history ?? []),
      { i: instruction, o: outcome },
    ].slice(-16);
    localStorage.setItem(
      `${MEMORY_PREFIX}channel:${channelId}`,
      JSON.stringify({ history }),
    );
  } catch {
    // best-effort
  }
}
