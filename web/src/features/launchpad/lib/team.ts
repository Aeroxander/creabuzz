/**
 * A project's team: who the founder added, who said yes, who said no, and who is no longer on it.
 *
 * Three kinds of signed record, each trusted only from the party entitled to sign it:
 *
 * - the founder's own project record names the team: one `["team", <account>, <role>]` tag per person, exactly as
 *   the server requires it (three parts, no more), with `["team-invite", <account>, <invitation>]` and
 *   `["p", <account>]` beside it: the invitation the person's answer names, and the tag they find the projects that
 *   name them by. The server counts everyone with a team tag as team from the moment the record is saved; that is
 *   said wherever someone is added;
 * - the person's own answer: an update record (kind 47003) naming the project, with `team-answer` = yes or no and the
 *   invitation it answers. Only an answer signed by the person named counts, and only for the invitation it names:
 *   someone removed and added again is asked again. A "no" for an invitation is final, whatever else was signed for
 *   it, so no order of records decides anything here;
 * - the founder's record also says who left and when: `["team-left", <account>, <when>, <invitation>]`, written by
 *   this app in the same save that removes someone who had said yes. Neither record is believed alone. A founder
 *   could write that tag about anyone, so "was on the team" is said only when the person's own signed yes to that
 *   invitation is read too; and anyone can sign a yes for any project, so a yes counts only for an invitation the
 *   founder's record names. Someone added and removed without ever saying yes leaves no trace at all.
 * - an invitation's name is used once. A yes for an invitation with no name never counts, and neither does a yes for
 *   an invitation the founder's record already lists under who left: someone removed and added again is asked again,
 *   even if the old name were put back.
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
  /** When the founder's record says they left, in seconds. */
  until: number;
  /** The invitation they were on the team by: their own yes to it is what makes "was on the team" true. */
  invite: string;
}

/** The most "left the team" entries one record keeps (the newest). */
const MAX_FORMER = 64;

/** The team a project record's tags name, each account once (the first entry wins), never the founder. */
export function parseTeam(tags: Tags, founder: string): TeamMember[] {
  const invites = new Map<string, string>();
  for (const tag of tags)
    if (
      tag[0] === TAG_INVITE &&
      typeof tag[2] === "string" &&
      !invites.has(tag[1])
    )
      invites.set(tag[1], tag[2]);
  const seen = new Set<string>([founder]);
  const out: TeamMember[] = [];
  for (const tag of tags) {
    if (tag[0] !== "team" || tag.length < 3) continue;
    const pubkey = tag[1];
    if (!PUBKEY.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push({ pubkey, role: tag[2], invite: invites.get(pubkey) ?? "" });
  }
  return out;
}

/** Who the founder's record says left, one entry per account and invitation. */
export function parseFormerTeam(tags: Tags): FormerMember[] {
  const out = new Map<string, FormerMember>();
  for (const tag of tags) {
    if (tag[0] !== "team-left" || !PUBKEY.test(tag[1] ?? "")) continue;
    const until = Number(tag[2]);
    if (!Number.isSafeInteger(until) || until <= 0) continue;
    const invite = typeof tag[3] === "string" ? tag[3] : "";
    const key = `${tag[1]}:${invite}`;
    const was = out.get(key);
    if (!was || until > was.until)
      out.set(key, { pubkey: tag[1], until, invite });
  }
  return [...out.values()];
}

/** The tags a project record carries for its team and for who left. */
export function teamTags(
  team: readonly TeamMember[],
  former: readonly FormerMember[],
): string[][] {
  return [
    // Three parts exactly: the server refuses a team tag of any other shape.
    ...team.map((m) => ["team", m.pubkey, m.role]),
    ...team.flatMap((m) =>
      m.invite ? [[TAG_INVITE, m.pubkey, m.invite]] : [],
    ),
    // So each person can find the projects that name them.
    ...team.map((m) => ["p", m.pubkey]),
    ...former.map((m) => ["team-left", m.pubkey, String(m.until), m.invite]),
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
  // An invitation's name is used once: an old yes must never answer a new invitation.
  if (
    invite === "" ||
    record.formerTeam.some((m) => m.pubkey === pubkey && m.invite === invite)
  )
    throw new Error("That invitation was used before. Try again.");
  return {
    team: [...record.team, { pubkey, role: TEAM_ROLE, invite }],
    // What the record says about their earlier time on the team stays: it is also what keeps old invitations spent.
    formerTeam: [...record.formerTeam],
  };
}

/**
 * The founder's record with `pubkey` removed. Null when they are not on it.
 *
 * `saidYes` is whether the person's own yes to this invitation was read just now. Only then is it written down that
 * they left and when: someone who never said yes was never on the team, and the record must not say they were. They
 * are dropped without a trace.
 */
export function withoutMember(
  record: {
    team: readonly TeamMember[];
    formerTeam: readonly FormerMember[];
  },
  pubkey: string,
  now: number,
  saidYes: boolean,
): TeamChange {
  const member = record.team.find((m) => m.pubkey === pubkey);
  if (!member) return null;
  const former = [...record.formerTeam];
  if (saidYes && member.invite !== "")
    former.push({ pubkey, until: now, invite: member.invite });
  return {
    team: record.team.filter((m) => m.pubkey !== pubkey),
    formerTeam: former.sort((x, y) => y.until - x.until).slice(0, MAX_FORMER),
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
      title: input.answer === "yes" ? "Joined the team" : "Not on the team",
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

/** `left`: they said yes and later no (they left of their own accord). `declined`: they said no and never yes. */
export type MemberState = "accepted" | "invited" | "declined" | "left";

const answersTo = (
  who: string,
  invite: string,
  coordinate: string,
  answers: readonly TeamAnswer[],
) =>
  answers.filter(
    (a) =>
      a.author === who && a.coordinate === coordinate && a.invite === invite,
  );

/**
 * Where one person stands on one invitation, from their own answers to it. Answers signed by anyone else, for another
 * project or for another invitation are not looked at. An invitation with no name, or one the founder's record lists
 * under who left (`former`), cannot be answered at all: nothing signed for it counts. No order of records decides
 * anything: a no stands whatever else was signed for the same invitation.
 */
export function memberState(
  member: TeamMember,
  coordinate: string,
  answers: readonly TeamAnswer[],
  former: readonly FormerMember[] = [],
): MemberState {
  if (
    member.invite === "" ||
    former.some((f) => f.pubkey === member.pubkey && f.invite === member.invite)
  )
    return "invited";
  const own = answersTo(member.pubkey, member.invite, coordinate, answers);
  const yes = own.some((a) => a.answer === "yes");
  if (own.some((a) => a.answer === "no")) return yes ? "left" : "declined";
  return yes ? "accepted" : "invited";
}

export interface TeamView {
  /** The people on the founder's record, with where each stands. */
  members: Array<TeamMember & { state: MemberState }>;
  /**
   * People who were on the team and are not now: the founder's record says they left, and their own signed yes to
   * that invitation was read. One entry per person, the latest.
   */
  former: FormerMember[];
}

interface TeamProject {
  author: string;
  coordinate: string;
  team: readonly TeamMember[];
  formerTeam: readonly FormerMember[];
}

/** The entries of "who left" that the person's own yes bears out. */
function verifiedFormer(
  project: TeamProject,
  answers: readonly TeamAnswer[],
): FormerMember[] {
  return project.formerTeam.filter(
    (f) =>
      f.invite !== "" &&
      answersTo(f.pubkey, f.invite, project.coordinate, answers).some(
        (a) => a.answer === "yes",
      ),
  );
}

/** The team as the page shows it. */
export function teamView(
  project: TeamProject,
  answers: readonly TeamAnswer[],
): TeamView {
  const members = project.team.map((member) => ({
    ...member,
    state: memberState(member, project.coordinate, answers, project.formerTeam),
  }));
  const current = new Set([
    project.author,
    ...project.team.map((m) => m.pubkey),
  ]);
  const former = new Map<string, FormerMember>();
  for (const f of verifiedFormer(project, answers)) {
    if (current.has(f.pubkey)) continue;
    const was = former.get(f.pubkey);
    if (!was || f.until > was.until) former.set(f.pubkey, f);
  }
  return {
    members,
    former: [...former.values()].sort(
      (x, y) => y.until - x.until || (x.pubkey < y.pubkey ? -1 : 1),
    ),
  };
}

/**
 * Whose updates speak for the project, and until when: the founder and every member who said yes, with no end; a
 * member who left of their own accord, until their own no; someone the record says left (and whose yes bears it out),
 * until that date. Someone added who has not said yes, or who said no, does not speak for the project. `null` is "no
 * end". A record signed after a person's end is not the project's.
 */
export function projectVoices(
  project: TeamProject,
  answers: readonly TeamAnswer[],
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const until = (who: string, at: number) => {
    const was = out.get(who);
    if (was === null) return;
    out.set(who, was === undefined ? at : Math.max(was, at));
  };
  for (const f of verifiedFormer(project, answers)) until(f.pubkey, f.until);
  for (const member of project.team) {
    const state = memberState(
      member,
      project.coordinate,
      answers,
      project.formerTeam,
    );
    if (state === "accepted") out.set(member.pubkey, null);
    else if (state === "left")
      until(
        member.pubkey,
        Math.min(
          ...answersTo(
            member.pubkey,
            member.invite,
            project.coordinate,
            answers,
          )
            .filter((a) => a.answer === "no")
            .map((a) => a.createdAt),
        ),
      );
  }
  out.set(project.author, null);
  return out;
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
