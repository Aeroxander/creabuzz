/**
 * A public moderation log entry about the reader, as a notification: on a board (D99), their post or reply removed or a
 * mute on that board; on Home (an entry with no board `h` tag), their post or reply removed by one of the community's
 * owners or admins. The server writes these entries itself (it refuses one written by anyone else) and names the person
 * they are about, so the reader's own entries can be asked for by their key. Anything else is not a notification.
 *
 * Alias-free; `moderation-items.test.mjs` drives it under `node --test`.
 */

/** The board's log entry kind (kind 45004, `KIND_BOARD_MODERATION_LOG` on the server). */
export const KIND_BOARD_MODERATION_LOG = 45004;

interface LogEvent {
  kind: number;
  content: string;
  tags: string[][];
}

const tagOf = (tags: readonly string[][], name: string) =>
  tags.find((tag) => tag[0] === name)?.[1] ?? null;

function dateWords(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function moderationItem(
  event: LogEvent,
  me: string,
): { title: string; preview: string } | null {
  if (event.kind !== KIND_BOARD_MODERATION_LOG) return null;
  if (tagOf(event.tags, "p") !== me) return null;
  const reason = event.content.trim();
  const why = reason
    ? `Reason: ${reason}${/[.!?]$/.test(reason) ? "" : "."}`
    : "No reason was given.";
  const onHome = tagOf(event.tags, "h") === null;
  switch (tagOf(event.tags, "action")) {
    case "remove": {
      const what = tagOf(event.tags, "thread") ? "reply" : "post";
      return onHome
        ? { title: `A moderator removed your ${what} from Home`, preview: why }
        : {
            title: `A moderator removed your ${what}`,
            preview: `${why} It is in the board's moderation log.`,
          };
    }
    case "mute": {
      // A longer mute still waiting for a second moderator has not changed anything yet.
      if (tagOf(event.tags, "status") === "awaiting_second_moderator")
        return null;
      const until = Number(tagOf(event.tags, "until"));
      return {
        title: "You were muted on a board",
        preview: `${Number.isFinite(until) && until > 0 ? `Until ${dateWords(until)}. ` : ""}${why}`,
      };
    }
    default:
      return null;
  }
}
