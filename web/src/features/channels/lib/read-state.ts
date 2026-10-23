/**
 * Unread rooms and boards, from the server's private read-state API (`docs/buzz-v1-read-state.md`), D101.
 *
 * The server counts, per room or board the reader has joined, the messages and posts that arrived after the point they
 * last read through, and remembers that point across reloads and devices. A count is exact, a lower bound, or unknown;
 * only an exact zero means nothing is unread, and a server that does not offer the API shows no marker at all rather than
 * a zero. Reading is told to the server as fixed anchors ("read this room through this message"), kept until the server
 * has answered for each, and never replaced by a later anchor before then.
 *
 * Alias-free; `read-state.test.mjs` drives it under `node --test`.
 */

export type ReadCount =
  | { status: "exact"; value: number }
  | { status: "at_least"; value: number }
  | { status: "unknown" };

export interface ChannelUnread {
  channelId: string;
  unread: ReadCount;
  /** The subset with a reason: a mention, a reply in the reader's conversation, a direct message, a broadcast. */
  attention: ReadCount;
  /** The anchor that reads the whole room (the last counted message to arrive), when there is one. */
  latest: string | null;
}

/** The API's base path from the server's information document, or null when it does not offer one. */
export function readStateBase(info: unknown): string | null {
  const v1 = (info as { buzz_v1?: { base_path?: unknown } } | null)?.buzz_v1;
  const base = v1?.base_path;
  return typeof base === "string" && base.startsWith("/") ? base : null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseCount(raw: unknown): ReadCount {
  const count = raw as { status?: unknown; value?: unknown } | null;
  const value = count?.value;
  if (
    (count?.status === "exact" || count?.status === "at_least") &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    return { status: count.status, value };
  }
  return { status: "unknown" };
}

/** One page of `GET …/me/sidebar`: the rooms and boards it lists, and the cursor for the next page. */
export function parseSidebarPage(json: unknown): {
  rows: ChannelUnread[];
  nextCursor: string | null;
} {
  const page = json as { channels?: unknown; next_cursor?: unknown } | null;
  const rows: ChannelUnread[] = [];
  for (const raw of Array.isArray(page?.channels) ? page.channels : []) {
    const row = raw as {
      channel_id?: unknown;
      unread?: unknown;
      attention?: unknown;
      latest_message_id?: unknown;
    };
    if (typeof row.channel_id !== "string" || row.channel_id === "") continue;
    rows.push({
      channelId: row.channel_id,
      unread: parseCount(row.unread),
      attention: parseCount(row.attention),
      latest:
        typeof row.latest_message_id === "string" &&
        HEX64.test(row.latest_message_id)
          ? row.latest_message_id
          : null,
    });
  }
  const next = page?.next_cursor;
  return {
    rows,
    nextCursor: typeof next === "string" && next !== "" ? next : null,
  };
}

/** What the sidebar shows for a room or board: nothing, a dot, or a number (with "+" when it is a lower bound). */
export function unreadMarker(
  row: ChannelUnread | undefined,
): { label: string | null; attention: boolean; words: string } | null {
  if (!row) return null;
  const { unread, attention } = row;
  if (unread.status === "exact" && unread.value === 0) return null;
  const someAttention = attention.status !== "unknown" && attention.value > 0;
  if (unread.status === "unknown") {
    return { label: null, attention: someAttention, words: "unread messages" };
  }
  const label =
    unread.status === "at_least" ? `${unread.value}+` : String(unread.value);
  return {
    label,
    attention: someAttention,
    words: `${label} unread${someAttention ? ", some for you" : ""}`,
  };
}

/** "Read this room through this message." */
export interface MarkRead {
  type: "mark_channel_read";
  channel_id: string;
  message_id: string;
}

/**
 * At most this many marks wait to be sent. A full queue refuses the next mark rather than dropping one it holds: nobody
 * outside the server can tell which of two anchors reads further, so every unsent mark is kept until the server answers.
 */
export const MAX_PENDING_MARKS = 100;

/** One mark's identity: the same room read through the same message. */
export function markKey(mark: MarkRead): string {
  return `${mark.channel_id}:${mark.message_id}`;
}

/**
 * The marks waiting to be sent, with one more. The same mark twice is kept once. When the queue is full the new mark is
 * refused (`accepted: false`) and nothing already waiting is dropped.
 */
export function withMark(
  pending: readonly MarkRead[],
  mark: MarkRead,
): { marks: MarkRead[]; accepted: boolean } {
  const key = markKey(mark);
  if (pending.some((p) => markKey(p) === key))
    return { marks: [...pending], accepted: true };
  if (pending.length >= MAX_PENDING_MARKS)
    return { marks: [...pending], accepted: false };
  return { marks: [...pending, mark], accepted: true };
}

/**
 * The marks of a sent batch the server settled (applied, blocked or invalid), by identity. A mark whose outcome is
 * unknown (or missing) is not settled and is sent again with the same operands.
 */
export function settledMarks(
  sent: readonly MarkRead[],
  json: unknown,
): ReadonlySet<string> {
  const outcomes = (json as { outcomes?: unknown } | null)?.outcomes;
  const list = Array.isArray(outcomes) ? outcomes : [];
  const settled = new Set<string>();
  sent.forEach((mark, index) => {
    const status = (list[index] as { status?: unknown } | undefined)?.status;
    if (status === "applied" || status === "blocked" || status === "invalid")
      settled.add(markKey(mark));
  });
  return settled;
}

/**
 * The queue after an answer: only the marks the server settled go, matched by identity, so a mark added while the batch
 * was in flight (or one that was never sent) stays wherever it is in the queue.
 */
export function withoutSettled(
  pending: readonly MarkRead[],
  settled: ReadonlySet<string>,
): MarkRead[] {
  return pending.filter((mark) => !settled.has(markKey(mark)));
}

/** Pending marks read back from the browser, ignoring anything that is not one. */
export function parsePendingMarks(raw: string | null): MarkRead[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (m): m is MarkRead =>
          (m as MarkRead)?.type === "mark_channel_read" &&
          typeof (m as MarkRead).channel_id === "string" &&
          HEX64.test(String((m as MarkRead).message_id)),
      )
      .slice(0, MAX_PENDING_MARKS);
  } catch {
    return [];
  }
}
