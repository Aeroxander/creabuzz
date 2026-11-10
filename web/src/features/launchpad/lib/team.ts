/**
 * A project's team: who the founder added, who said yes, who said no, and who is no longer on it.
 *
 * Three kinds of signed record, each trusted only from the party entitled to sign it:
 *
 * - the founder's own project record names the team: one `["team", <account>, <role>, <invitation>]` tag per person
 *   (with a `["p", <account>]` beside it, so the person can find the projects that name them). The server counts
 *   everyone with a team tag as team from the moment the record is saved; that is said wherever someone is added;
 * - the person's own answer: an update record (kind 47003) naming the project, with `team-answer` = yes or no and the
 *   invitation it answers. Only an answer signed by the person named counts, and only for the invitation it names:
 *   someone removed and added again is asked again. A "no" for an invitation is final, whatever else was signed for
 *   it, so no order of records decides anything here;
 * - the founder's record also says who left and when: `["team-left", <account>, <when>]`, written by this app in the
 *   same save that removes them. A person's own "yes" is not taken as proof they were ever on a team: anyone can sign
 *   one for any project, and once the founder's record no longer names the invitation there is nothing to check it
 *   against. So this disclosure rests on the founder's record alone (the server keeps only its newest version).
 *
 * Only people who said yes are shown as team; people added who have not answered are shown as that, publicly, because
 * the server already lets them act for the project.
 *
 * Pure and alias-free: `team.test.mjs` drives it under `node --test`.
 */

type Tags = readonly (readonly string[])[];

/** The `l` label every team answer carries, so a project's answers are read apart from its other records. */
export const TEAM_LABEL = "creaton-team";
const TAG_ANSWER = "team-answer";
const TAG_INVITE = "team-invite";
/** The one role the Team section gives. */
const TEAM_ROLE = "member";
/** What that role may do, in plain words. */
export const TEAM_ROLE_WORDS = "Can post updates and check work";
/**
 * The most people a founder can add. A project's task records are read for at most twenty team accounts
 * (`task-reads.ts`), the founder included; a larger team would make those reads incomplete.
 */
export const MAX_TEAM_MEMBERS = 19;

const PUBKEY = /^[0-9a-f]{64}$/;

export interface TeamMember {
  pubkey: string;
  role: string;
  /** The invitation this entry is: what the person's answer names. Empty for an entry written without one. */
  invite: string;
}

export interface FormerMember {
  pubkey: string;
  /** When the founder's record says they left, in seconds; null when it does not say. */
  until: number | null;
}

/** The team a project record's tags name, each account once (the first entry wins), never the founder. */
export function parseTeam(tags: Tags, founder: string): TeamMember[] {
  const seen = new Set<string>([founder]);
  const out: TeamMember[] = [];
  for (const tag of tags) {
    if (tag[0] !== "team" || tag.length < 3) continue;
    const pubkey = tag[1];
    if (!PUBKEY.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push({ pubkey, role: tag[2], invite: tag[3] ?? "" });
  }
  return out;
}

/** Who the founder's record says left, each account once (the latest date wins). */
export function parseFormerTeam(tags: Tags): FormerMember[] {
  const out = new Map<string, number>();
  for (const tag of tags) {
    if (tag[0] !== "team-left" || !PUBKEY.test(tag[1] ?? "")) continue;
    const until = Number(tag[2]);
    if (!Number.isSafeInteger(until) || until <= 0) continue;
    out.set(tag[1], Math.max(out.get(tag[1]) ?? 0, until));
  }
  return [...out].map(([pubkey, until]) => ({ pubkey, until }));
}

/** The tags a project record carries for its team and for who left. */
export function teamTags(
  team: readonly TeamMember[],
  former: readonly FormerMember[],
): string[][] {
  return [
    ...team.map((m) => ["team", m.pubkey, m.role, m.invite]),
    // So each person can find the projects that name them.
    ...team.map((m) => ["p", m.pubkey]),
    ...former.flatMap((m) =>
      m.until === null ? [] : [["team-left", m.pubkey, String(m.until)]],
    ),
  ];
}

/** A fresh invitation name. */
export function newInvite(random: () => number = Math.random): string {
  return Array.from({ length: 12 }, () =>
    Math.floor(random() * 36).toString(36),
  ).join("");
}

export type TeamChange =
  | { team: TeamMember[]; formerTeam: FormerMember[] }
  /** The record already says so: nothing to send. */
  | null;

/**
 * The founder's record with `pubkey` added. Null when they are already on it: pressing Add again after an answer was
 * lost finds them there and sends nothing, so nobody is invited twice. Throws when the team is full or the account is
 * the founder's own.
 */
export function withMember(
  record: {
    author: string;
    team: readonly TeamMember[];
    formerTeam: readonly FormerMember[];
  },
  pubkey: string,
  invite: string,
): TeamChange {
  if (!PUBKEY.test(pubkey)) throw new Error("That is not an account.");
  if (pubkey === record.author)
    throw new Error("You are the founder: you are on the team already.");
  if (record.team.some((m) => m.pubkey === pubkey)) return null;
  if (record.team.length >= MAX_TEAM_MEMBERS)
    throw new Error(
      `A team can have ${MAX_TEAM_MEMBERS} people besides the founder. Remove someone first.`,
    );
  return {
    team: [...record.team, { pubkey, role: TEAM_ROLE, invite }],
    // Back on the team: no longer someone who left.
    formerTeam: record.formerTeam.filter((m) => m.pubkey !== pubkey),
  };
}

/** The founder's record with `pubkey` removed and written down as having left at `now`. Null when they are not on it. */
export function withoutMember(
  record: {
    team: readonly TeamMember[];
    formerTeam: readonly FormerMember[];
  },
  pubkey: string,
  now: number,
): TeamChange {
  if (!record.team.some((m) => m.pubkey === pubkey)) return null;
  return {
    team: record.team.filter((m) => m.pubkey !== pubkey),
    formerTeam: [
      ...record.formerTeam.filter((m) => m.pubkey !== pubkey),
      { pubkey, until: now },
    ],
  };
}

export type TeamAnswerWord = "yes" | "no";

export interface TeamAnswer {
  id: string;
  author: string;
  coordinate: string;
  answer: TeamAnswerWord;
  invite: string;
  createdAt: number;
}

/** Whether a record's tags mark it as a team answer (so it is never listed as an update). */
export function isTeamAnswerTags(tags: Tags): boolean {
  return tags.some((tag) => tag[0] === TAG_ANSWER);
}

/** The content and extra tags of an answer to an invitation. */
export function teamAnswerEvent(input: {
  answer: TeamAnswerWord;
  invite: string;
}): { content: { title: string; body: string }; tags: string[][] } {
  return {
    content: {
      title: input.answer === "yes" ? "Joined the team" : "Said no to the team",
      body: "",
    },
    tags: [
      ["l", TEAM_LABEL],
      [TAG_ANSWER, input.answer],
      [TAG_INVITE, input.invite],
    ],
  };
}

/** A team answer read from a record, or null when it is not one (or cannot be read as one). */
export function parseTeamAnswer(event: {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: Tags;
}): TeamAnswer | null {
  if (event.kind !== 47003) return null;
  const first = (name: string) =>
    event.tags.find((tag) => tag[0] === name)?.[1];
  const answer = first(TAG_ANSWER);
  const coordinate = first("a");
  if ((answer !== "yes" && answer !== "no") || !coordinate) return null;
  return {
    id: event.id,
    author: event.pubkey,
    coordinate,
    answer,
    invite: first(TAG_INVITE) ?? "",
    createdAt: event.created_at,
  };
}

export type MemberState = "accepted" | "invited" | "declined";

/**
 * Where one person stands on one invitation, from their own answers to it. A "no" is final for that invitation;
 * otherwise a "yes" is a yes; otherwise they have not answered. Answers signed by anyone else, for another project
 * or for another invitation are not looked at.
 */
export function memberState(
  member: TeamMember,
  coordinate: string,
  answers: readonly TeamAnswer[],
): MemberState {
  const own = answers.filter(
    (a) =>
      a.author === member.pubkey &&
      a.coordinate === coordinate &&
      a.invite === member.invite,
  );
  if (own.some((a) => a.answer === "no")) return "declined";
  return own.some((a) => a.answer === "yes") ? "accepted" : "invited";
}

export interface TeamView {
  /** The people on the founder's record, with where each stands. */
  members: Array<TeamMember & { state: MemberState }>;
  /** People who were on the team and are not now, as the founder's record says. */
  former: FormerMember[];
}

/** The team as the page shows it. */
export function teamView(
  project: {
    author: string;
    coordinate: string;
    team: readonly TeamMember[];
    formerTeam: readonly FormerMember[];
  },
  answers: readonly TeamAnswer[],
): TeamView {
  const members = project.team.map((member) => ({
    ...member,
    state: memberState(member, project.coordinate, answers),
  }));
  const current = new Set([
    project.author,
    ...project.team.map((m) => m.pubkey),
  ]);
  const former = new Map<string, number | null>();
  for (const m of project.formerTeam)
    if (!current.has(m.pubkey)) former.set(m.pubkey, m.until);
  return {
    members,
    former: [...former]
      .map(([pubkey, until]) => ({ pubkey, until }))
      .sort(
        (x, y) =>
          (y.until ?? 0) - (x.until ?? 0) || (x.pubkey < y.pubkey ? -1 : 1),
      ),
  };
}

/** Who may post for the project from this app: the founder, and a member who said yes. */
export function actsForProject(
  view: TeamView,
  founder: string,
  who: string | null,
): boolean {
  if (who === null) return false;
  return (
    who === founder ||
    view.members.some((m) => m.pubkey === who && m.state === "accepted")
  );
}
