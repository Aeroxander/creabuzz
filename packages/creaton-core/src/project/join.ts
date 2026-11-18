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

import { newInvite, TAG_JOIN_DECLINE, TEAM_LABEL } from "./team.ts";

type Tags = readonly (readonly string[])[];

/** The `l` label every ask to join carries, so a project's asks are read apart from its other records. */
export const JOIN_LABEL = "creaton-join";
const TAG_JOIN = "join-ask";
const PUBKEY = /^[0-9a-f]{64}$/;

/** The most pending asks a founder is shown for one project. */
export const MAX_PENDING_ASKS = 50;

/**
 * Said beside the button once the ask is sent (and every time the page is opened after). It says only what is true:
 * nobody is pushed a message, the ask waits where the founder looks at the project's team and at Notifications.
 */
export const ASKED_WORDS =
  "Asked to join. It shows on the founder's Team card and in their Notifications.";

export interface JoinAsk {
  id: string;
  /** The person asking. */
  author: string;
  coordinate: string;
  /** The name the founder's record will list the person under, and the person's yes names. */
  invite: string;
  createdAt: number;
}

/** A founder turning one person's ask away. The person is not told, and may ask again (a few times). */
export interface JoinDecline {
  id: string;
  /** Who signed it: counts only when it is the project's founder. */
  author: string;
  coordinate: string;
  /** The person turned away. */
  asker: string;
  createdAt: number;
}

/** Where an ask waiting for an account is kept: session storage (sign-up may reload the page). */
type SignUpStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const AFTER_SIGN_UP_KEY = "creaton.join.after-sign-up";
/** How long an Ask pressed while signed out stays good once the account exists: after that the person presses again. */
const AFTER_SIGN_UP_MS = 10 * 60_000;

/**
 * Remember that Ask to join was pressed on this project while signed out, so the ask is sent as soon as the account
 * exists, with no second press. It names the project: it never sends an ask for another one, and it is used up once.
 */
export function markAskAfterSignUp(
  store: SignUpStore | null | undefined,
  coordinate: string,
  now: number = Date.now(),
): void {
  try {
    store?.setItem(AFTER_SIGN_UP_KEY, `${now}|${coordinate}`);
  } catch {
    // Storage refused: the person presses Ask to join again once signed up.
  }
}

/** Whether an Ask pressed for this project is waiting for an account, without using it up. */
export function askAfterSignUpWaiting(
  store: SignUpStore | null | undefined,
  coordinate: string,
  now: number = Date.now(),
): boolean {
  try {
    const [at, waitingFor] = (store?.getItem(AFTER_SIGN_UP_KEY) ?? "").split(
      "|",
    );
    const when = Number(at);
    return (
      waitingFor === coordinate &&
      Number.isFinite(when) &&
      when > 0 &&
      now - when <= AFTER_SIGN_UP_MS
    );
  } catch {
    return false;
  }
}

/** Whether an Ask was waiting for this project, and forget it: true once per press, however often the page redraws. */
export function takeAskAfterSignUp(
  store: SignUpStore | null | undefined,
  coordinate: string,
  now: number = Date.now(),
): boolean {
  const waiting = askAfterSignUpWaiting(store, coordinate, now);
  clearAskAfterSignUp(store);
  return waiting;
}

/** Forget a waiting Ask (the person pressed it themselves, or asked another way). */
export function clearAskAfterSignUp(
  store: SignUpStore | null | undefined,
): void {
  try {
    store?.removeItem(AFTER_SIGN_UP_KEY);
  } catch {
    // Storage refused: nothing to forget.
  }
}

/** The content and extra tags of a founder turning `asker`'s ask away. */
export function joinDeclineEvent(input: { asker: string }): {
  content: { title: string; body: string };
  tags: string[][];
} {
  return {
    content: { title: "Turned an ask away", body: "" },
    tags: [
      ["l", JOIN_LABEL],
      [TAG_JOIN_DECLINE, input.asker],
    ],
  };
}

/** A decline read from a record, or null when it is not one. */
export function parseJoinDecline(event: {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: Tags;
}): JoinDecline | null {
  if (event.kind !== 47003) return null;
  const first = (name: string) =>
    event.tags.find((tag) => tag[0] === name)?.[1];
  const asker = first(TAG_JOIN_DECLINE);
  const coordinate = first("a");
  if (
    !asker ||
    !PUBKEY.test(asker) ||
    !coordinate ||
    !PUBKEY.test(event.pubkey)
  )
    return null;
  return {
    id: event.id,
    author: event.pubkey,
    coordinate,
    asker,
    createdAt: event.created_at,
  };
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
 * Every ask the founder can still accept: for this project, each person's newest, leaving out the founder, anyone
 * already on the record, any ask whose name the record already lists under who left (a name is used once), and any
 * ask the founder turned away (a decline signed by the founder, as new as the ask or newer). Oldest first, so the
 * person who asked first is at the top. Not cut: {@link pendingAsks} shows the first {@link MAX_PENDING_ASKS}.
 */
export function waitingAsks(
  asks: readonly JoinAsk[],
  project: JoinProject,
  declines: readonly JoinDecline[] = [],
): JoinAsk[] {
  const onTeam = new Set([
    project.author,
    ...project.team.map((m) => m.pubkey),
  ]);
  // Only the founder's own word turns anyone away, and only for this project.
  const turnedAway = new Map<string, number>();
  for (const decline of declines) {
    if (decline.author !== project.author) continue;
    if (decline.coordinate !== project.coordinate) continue;
    turnedAway.set(
      decline.asker,
      Math.max(turnedAway.get(decline.asker) ?? 0, decline.createdAt),
    );
  }
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
    .filter((ask) => (turnedAway.get(ask.author) ?? -1) < ask.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** The first {@link MAX_PENDING_ASKS} of {@link waitingAsks}: what one list shows. */
export function pendingAsks(
  asks: readonly JoinAsk[],
  project: JoinProject,
  declines: readonly JoinDecline[] = [],
): JoinAsk[] {
  return waitingAsks(asks, project, declines).slice(0, MAX_PENDING_ASKS);
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
