/**
 * The founder's line about cheers: "3 people cheered Nebula today." One line for each project and each day, however
 * many cheers came in, so a busy day is one quiet line and not a list.
 *
 * A cheer is the up vote the timeline already uses (kind 7, "+"), naming a project record (`k` 47003) and, since
 * cheers carry it, the project it is about (`a`). Whoever sent it counts once per project and day. A cheer is about
 * a record and never about Shares, a price or money; the line says so by saying nothing else.
 *
 * Pure and alias-free: `cheer-lines.test.mjs` drives it under `node --test`.
 */

const DAY = 86_400;
/** Today and yesterday: older cheers are no longer news. */
const SHOWN_DAYS = 2;

interface CheerEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: readonly (readonly string[])[];
}

export interface CheerLine {
  /** Unique: the project and the day. */
  id: string;
  text: string;
  /** How many people cheered. */
  count: number;
  /** When the newest of them did, in seconds. */
  at: number;
}

const tagValue = (event: CheerEvent, name: string) =>
  event.tags.find((tag) => tag[0] === name)?.[1];

/** The day an instant falls on in the reader's own calendar, as a number of days. */
function localDay(at: number): number {
  const date = new Date(at * 1000);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
      (DAY * 1000),
  );
}

/**
 * The lines for `me`'s cheers, newest first. `names` maps a project's coordinate to its name; a cheer that names no
 * project, or one with no name known, is said as "your work". `muted` leaves out people the reader muted.
 */
export function cheerLines(input: {
  reactions: readonly CheerEvent[];
  me: string;
  now: number;
  names: ReadonlyMap<string, string>;
  muted?: ReadonlySet<string>;
}): CheerLine[] {
  const today = localDay(input.now);
  const groups = new Map<
    string,
    { project: string; day: number; people: Set<string>; at: number }
  >();
  for (const event of input.reactions) {
    if (event.kind !== 7 || event.content !== "+") continue;
    if (tagValue(event, "k") !== "47003") continue;
    if (event.pubkey === input.me || input.muted?.has(event.pubkey)) continue;
    // It is addressed to the reader, who is the last person it names.
    const to = [...event.tags].reverse().find((tag) => tag[0] === "p")?.[1];
    if (to !== input.me) continue;
    if (event.created_at > input.now) continue;
    const day = localDay(event.created_at);
    if (today - day >= SHOWN_DAYS) continue;
    const project = tagValue(event, "a") ?? "";
    const key = `${project}|${day}`;
    const group = groups.get(key) ?? {
      project,
      day,
      people: new Set<string>(),
      at: 0,
    };
    group.people.add(event.pubkey);
    group.at = Math.max(group.at, event.created_at);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]): CheerLine => {
      const count = group.people.size;
      const name = group.project ? input.names.get(group.project) : undefined;
      const when = group.day === today ? "today" : "yesterday";
      return {
        id: `cheer:${key}`,
        count,
        at: group.at,
        text: `${count === 1 ? "1 person" : `${count} people`} cheered ${name ?? "your work"} ${when}.`,
      };
    })
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}
