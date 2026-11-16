/**
 * Asking to join a project, and the founder's one press that accepts.
 *
 * Anyone signed in may ask: one signed record (kind 47003) that names the project (`a`) and the founder (`p`), with the
 * label `creaton-join` and a `join-ask` tag holding a short name. The same record carries the person's own yes to
 * that name, as a team answer (`lib/team.ts`) does: `team-answer` = yes and `team-invite` = the name. So when the
 * founder presses Accept, the app adds the person to the project record under that same name (`withMember`), and the
 * person is on the team at once, shown as having said yes, with nothing more for them to press. A yes counts only for a
 * name the founder's record lists, so an ask that is never accepted joins nobody.
 *
 * The server holds the rules (`launch_update_authority.rs`): anyone not already on the team may sign an ask, it
 * carries nothing else, an account may ask one project three times and twenty projects a day, an agent account may ask
 * but cannot accept. This file only builds and reads the records.
 *
 * Pure and alias-free: `join.test.mjs` drives it under `node --test`.
 */

import { newInvite, TEAM_LABEL } from "./team.ts";

type Tags = readonly (readonly string[])[];

/** The `l` label every ask to join carries, so a project's asks are read apart from its other records. */
export const JOIN_LABEL = "creaton-join";
const TAG_JOIN = "join-ask";
const PUBKEY = /^[0-9a-f]{64}$/;

/** The most pending asks a founder is shown for one project. */
export const MAX_PENDING_ASKS = 50;

/** Said beside the button once the ask is sent (and every time the page is opened after). */
export const ASKED_WORDS = "Asked to join. The founder has been told.";

export interface JoinAsk {
  id: string;
  /** The person asking. */
  author: string;
  coordinate: string;
  /** The name the founder's record will list the person under, and the person's yes names. */
  invite: string;
  createdAt: number;
}

/** The content and extra tags of an ask to join the project whose founder is `founder`. */
export function joinAskEvent(input: { founder: string; invite?: string }): {
  content: { title: string; body: string };
  tags: string[][];
} {
  const invite = input.invite ?? newInvite();
  return {
    content: { title: "Asked to join", body: "" },
    tags: [
      ["l", JOIN_LABEL],
      [TAG_JOIN, invite],
      // The person's own yes to that name: it counts once the founder lists them under it.
      ["l", TEAM_LABEL],
      ["team-answer", "yes"],
      ["team-invite", invite],
      // So the founder finds it among what names them (Notifications).
      ["p", input.founder],
    ],
  };
}

/** Whether a record's tags mark it as an ask to join (so it is never listed as an update). */
export function isJoinAskTags(tags: Tags): boolean {
  return tags.some((tag) => tag[0] === TAG_JOIN);
}

/** An ask to join read from a record, or null when it is not one (or cannot be read as one). */
export function parseJoinAsk(event: {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: Tags;
}): JoinAsk | null {
  if (event.kind !== 47003) return null;
  const first = (name: string) =>
    event.tags.find((tag) => tag[0] === name)?.[1];
  const invite = first(TAG_JOIN);
  const coordinate = first("a");
  if (!invite || !coordinate || !PUBKEY.test(event.pubkey)) return null;
  return {
    id: event.id,
    author: event.pubkey,
    coordinate,
    invite,
    createdAt: event.created_at,
  };
}

interface JoinProject {
  author: string;
  coordinate: string;
  team: readonly { pubkey: string }[];
  formerTeam: readonly { pubkey: string; invite: string }[];
}

/**
 * The asks the founder can still accept: for this project, each person's newest, leaving out the founder, anyone
 * already on the record, and any ask whose name the record already lists under who left (a name is used once). Oldest
 * first, so the person who asked first is at the top; at most {@link MAX_PENDING_ASKS}.
 */
export function pendingAsks(
  asks: readonly JoinAsk[],
  project: JoinProject,
): JoinAsk[] {
  const onTeam = new Set([
    project.author,
    ...project.team.map((m) => m.pubkey),
  ]);
  const newest = new Map<string, JoinAsk>();
  for (const ask of asks) {
    if (ask.coordinate !== project.coordinate || onTeam.has(ask.author))
      continue;
    if (
      project.formerTeam.some(
        (f) => f.pubkey === ask.author && f.invite === ask.invite,
      )
    )
      continue;
    const was = newest.get(ask.author);
    if (
      !was ||
      ask.createdAt > was.createdAt ||
      (ask.createdAt === was.createdAt && ask.id > was.id)
    )
      newest.set(ask.author, ask);
  }
  return [...newest.values()]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_PENDING_ASKS);
}

/** Whether `me` has an ask on this project that is still waiting: they asked and are not on the record. */
export function hasWaitingAsk(
  asks: readonly JoinAsk[],
  me: string,
  project: JoinProject,
): boolean {
  return pendingAsks(
    asks.filter((a) => a.author === me),
    project,
  ).some((a) => a.author === me);
}
