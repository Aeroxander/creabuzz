/**
 * The news about a person's projects, made from the signed record the app already reads (plan section 6, C10): no event,
 * no server write, nothing a teammate can forge. An alert is a property of the record's rows, not something that passes, so
 * a holder who opens the app a week later still finds a planned task before its date. Pure: the same inputs give the same
 * alerts, and the only clock is the one handed in (lifted to the record's own time by the one clock rule of 1.6).
 *
 * One row gives at most one alert at a time: a plan not yet taken is `planned`, a taken task is `taken`, one past its deadline
 * that nobody settled is `ran-out`, a task that ended and moved money is `ended`; a row that lists the person as owed money adds a
 * `claim`. A plan that was withdrawn or lapsed moved nothing and makes none. A project the person does not hold makes none
 * (but what they are owed still shows: a leaver holds no Shares).
 *
 * Two more kinds come from the record's vote and from nothing else (`COUNCIL-PLAN.md` 6.7): `vote` while a ballot is live,
 * urgent until it ends, and `moved` once its frozen result changes the runner or the seats, urgent until the change takes
 * effect. Both are derived, so they show at `voteEnd` even if nobody has recorded the result. **They are read from the
 * record's own `step.vote` here, not through the lazy milestone 9 parser**: this module is in the first download, and
 * loading that parser here would make it larger (plan 6.8). The slice read is strict: a value that cannot be believed gives
 * no vote news, and the rest of the record's news stands.
 */
import {
  freshnessOf,
  type ProjectNumbers,
  type Freshness,
} from "../money/numbers";
import {
  COUNT_LIMIT,
  isObject,
  obj,
  oneOf,
  time,
  timeOrNull,
  whole,
} from "../money/numbers-strict";
import type { ProjectTask } from "../tasks/task-record";
import { nowOf, phaseOf, recordWordsOf, tieOf } from "../tasks/chain/state";
import type { ChainTask } from "../tasks/chain/types";
import {
  type AlertAge,
  ageSuffix,
  claimWords,
  endedWords,
  movedWords,
  plainName,
  plannedWords,
  ranOutWords,
  takenWords,
  voteOpenWords,
  withProject,
} from "./alert-words";

/** What an alert is about. */
type AlertKind =
  | "planned"
  | "taken"
  | "ran-out"
  | "ended"
  | "claim"
  | "vote"
  | "moved";

/** One piece of news about a task or a vote, for one project. */
export interface TaskAlert {
  /** `${chainKey}:${serial}:${kind}`: a changed state is a new id, so it is unseen again. A vote's id names its ballot. */
  id: string;
  kind: AlertKind;
  chainKey: string;
  projectName: string | null;
  /** The task's number; 0 for a vote, which has none. */
  serial: bigint;
  /** When it happened: announced, taken, ended (a lapsed plan: when it ran out), or the task's end for a claim. */
  at: number;
  /** A plan still in its notice: the person can take their money out before the date. */
  urgent: boolean;
  /** The day the money may first move, for an urgent alert. */
  before: number | null;
  /** The record is past three refresh periods old: the sentence says "(as of {time})". */
  stale: boolean;
  /** The record is more than a day old: the sentence says it may be out of date. */
  old: boolean;
  /** The sentence with its project in front: "Lantern: the team plans to pay up to ...". */
  words: string;
  /** The sentence without its project (the list draws the project as a link in front of it). */
  said: string;
}

/** What `alertsOf` is given. */
export interface AlertsInput {
  /** The newest record of each project, signed and checked as the project's own. */
  numbers: readonly ProjectNumbers[];
  /** Project names by chain key (`numbers.key`). */
  names: ReadonlyMap<string, string>;
  /** The person's accounts (wallet or passkey account), any case. */
  me: readonly string[];
  /** Whether the person holds the project: true, false, or "unknown" (the list of holders was cut and nothing else says). */
  held: (chainKey: string) => boolean | "unknown";
  /** The project's team records (for the words of a task); undefined reads "a task". */
  tasksOf: (chainKey: string) => readonly ProjectTask[] | undefined;
  /** The device's clock, in seconds; each project's own clock is lifted to its record's time. */
  now: number;
}

/** The ended tasks of a project that were left out of the list after the first three. */
interface MoreEnded {
  chainKey: string;
  projectName: string | null;
  count: number;
}

export interface AlertsResult {
  alerts: TaskAlert[];
  moreEnded: MoreEnded[];
  /** Projects with news to give that would be given if the person holds them: their balance is to be read, newest news first. */
  unknownHeld: string[];
}

/** The most ended alerts one project gives, so a flood of cheap tasks cannot push a real notice off the page. */
export const MOST_ENDED_PER_PROJECT = 3;

/** How long an ended task is news when the record does not say how long it keeps them. */
const ENDED_WITHIN_FALLBACK = 28 * 86_400;

const ageOf = (freshness: Freshness): AlertAge =>
  freshness.level === "stale"
    ? "old"
    : freshness.level === "as-of"
      ? "as-of"
      : "fresh";

/** The team's record a row was planned for, when there is one here: its id is the row's `what`. */
function recordOf(
  row: ChainTask,
  records: readonly ProjectTask[] | undefined,
): ProjectTask | null {
  return records?.find((t) => `0x${t.id.toLowerCase()}` === row.what) ?? null;
}

/** The team's words for a plan that ties to its record (a planned or running task), else null. */
function tiedOnly(row: ChainTask, task: ProjectTask | null): string | null {
  return task !== null && tieOf(row, task).ok ? task.what : null;
}

const byAtDescending = (a: TaskAlert, b: TaskAlert) =>
  b.at - a.at || (a.serial < b.serial ? 1 : a.serial > b.serial ? -1 : 0);

/**
 * The live news in the order it matters: a plan still in its notice comes first, the one whose notice ends soonest at the very
 * top (the holder can still take their money out before that day), then the rest, newest first. A list that is cut after
 * some rows therefore never cuts a notice that is about to end.
 */
const byUrgency = (a: TaskAlert, b: TaskAlert) => {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  if (a.urgent && b.urgent && a.before !== b.before)
    return (a.before ?? 0) - (b.before ?? 0);
  return byAtDescending(a, b);
};

/** The two vote kinds' records, before they are given a project's words. */
type VoteNews =
  | { kind: "vote"; at: number; endsAt: number; id: string }
  | {
      kind: "moved";
      at: number;
      effectiveAt: number;
      seated: boolean;
      id: string;
    };

const VOTE_OUTCOMES = [
  "short",
  "kept",
  "moved",
  "seated",
  "unchanged",
] as const;

/**
 * The news a record's own ballot gives (plan 6.7), from the slice of `step.vote` this screen needs: a ballot live now is
 * `vote` (urgent until it ends), and a ballot whose frozen result moves the runner or seats is `moved` (urgent until it
 * takes effect, and not once it has been carried out). Nothing for a ballot that ended without changing anything, and
 * nothing that a value which cannot be believed claims: a hostile or missing vote gives null here and the task news stands.
 *
 * This is deliberately a small reader of its own rather than the milestone 9 parser: that parser is loaded only by the lazy
 * money screens, and this module is in the first download. It reads only the fields the two sentences need; the vote card
 * itself reads the whole key through the lazy parser.
 */
export function voteNewsOf(
  numbers: ProjectNumbers,
  now: number,
): VoteNews | null {
  const step = numbers.step;
  if (!isObject(step) || !("vote" in step)) return null;
  if (step.vote === null) return null;
  try {
    const vote = obj(step.vote, "vote");
    const open = obj(vote.open, "vote.open");
    const id = whole(open.id, "vote.open.id", COUNT_LIMIT);
    const openedAt = time(open.openedAt, "vote.open.openedAt");
    const voteEnd = time(open.voteEnd, "vote.open.voteEnd");
    const effectiveAt = time(open.effectiveAt, "vote.open.effectiveAt");
    const carriedOutAt = timeOrNull(
      open.carriedOutAt,
      "vote.open.carriedOutAt",
    );
    if (now < voteEnd)
      return {
        kind: "vote",
        at: openedAt,
        endsAt: voteEnd,
        id: `${numbers.key}:vote:${id}`,
      };
    if (carriedOutAt !== null || now >= effectiveAt) return null;
    if (open.result === null) return null;
    const result = obj(open.result, "vote.open.result");
    const outcome = oneOf(result.outcome, VOTE_OUTCOMES, "vote.open.result");
    if (outcome !== "moved" && outcome !== "seated") return null;
    return {
      kind: "moved",
      at: voteEnd,
      effectiveAt,
      seated: outcome === "seated",
      // The kind is in the id, and the ballot it belongs to: a new state is unseen again, and two ballots never share one.
      id: `${numbers.key}:moved:${id}`,
    };
  } catch {
    // A vote key that cannot be believed says nothing here; the task news of the same record is unaffected.
    return null;
  }
}

/**
 * The news for these projects, in the order it shows: planned and taken first (a plan in its notice, soonest end first, then the
 * rest newest first), then claims, then ended, each newest first
 * (at most three ended alerts per project, the rest counted in `moreEnded`). Every alert comes from a row of a record the app
 * believes; the team's own records only ever supply the task's words, and only where they are the record the plan names.
 */
export function alertsResult(input: AlertsInput): AlertsResult {
  const me = new Set(input.me.map((a) => a.toLowerCase()));
  const live: TaskAlert[] = [];
  const claims: TaskAlert[] = [];
  const ended: TaskAlert[] = [];
  const moreEnded: MoreEnded[] = [];
  const unknownHeld: { key: string; at: number }[] = [];
  for (const numbers of input.numbers) {
    const key = numbers.key;
    const projectName = input.names.get(key) ?? null;
    const project = plainName(projectName);
    const now = nowOf(numbers.asOf.time, input.now);
    const freshness = freshnessOf(numbers, now);
    const age = ageOf(freshness);
    const suffix = ageSuffix(age, numbers.asOf.time);
    const held = input.held(key);
    const queue =
      typeof numbers.tasks === "object" && numbers.tasks ? numbers.tasks : null;
    const mine: TaskAlert[] = [];
    let newest = 0;
    // A ballot's own news comes from the record's vote, whether or not the record carries a task queue.
    const voteNews = voteNewsOf(numbers, now);
    if (voteNews) {
      const said =
        voteNews.kind === "vote"
          ? voteOpenWords(voteNews.endsAt)
          : movedWords({
              effectiveAt: voteNews.effectiveAt,
              seated: voteNews.seated,
            });
      const alert: TaskAlert = {
        id: voteNews.id,
        kind: voteNews.kind,
        chainKey: key,
        projectName,
        serial: 0n,
        at: voteNews.at,
        urgent: true,
        before:
          voteNews.kind === "vote" ? voteNews.endsAt : voteNews.effectiveAt,
        stale: age !== "fresh",
        old: age === "old",
        words: withProject(project, `${said}${suffix}`),
        said: `${said}${suffix}`,
      };
      mine.push(alert);
      newest = alert.at;
    }
    if (queue) {
      const records = input.tasksOf(key);
      const windDownAt = numbers.windDown?.at ?? null;
      const endedWithin = queue.cut.endedWithinSecs || ENDED_WITHIN_FALLBACK;
      const make = (
        row: ChainTask,
        kind: AlertKind,
        at: number,
        said: string,
        extra: { urgent?: boolean; before?: number | null } = {},
      ): TaskAlert => ({
        id: `${key}:${row.serial}:${kind}`,
        kind,
        chainKey: key,
        projectName,
        serial: row.serial,
        at,
        urgent: extra.urgent ?? false,
        before: extra.before ?? null,
        stale: age !== "fresh",
        old: age === "old",
        words: withProject(project, `${said}${suffix}`),
        said: `${said}${suffix}`,
      });
      for (const row of queue.list) {
        const task = recordOf(row, records);
        const phase = phaseOf(row, now, windDownAt);
        // What the person is owed is theirs whether or not they hold Shares: a leaver holds none.
        const owed = row.notes?.holders.find(
          (h) => me.has(h.account.toLowerCase()) && h.claimable > 0n,
        );
        if (owed) {
          const at = row.resolvedAt ?? row.takenAt ?? row.announcedAt;
          claims.push(
            make(
              row,
              "claim",
              at,
              claimWords({
                what: recordWordsOf(row, task),
                claimable: owed.claimable,
              }),
            ),
          );
        }
        let alert: TaskAlert | null = null;
        if (phase === "notice" || phase === "open") {
          const notice = phase === "notice";
          alert = make(
            row,
            "planned",
            row.announcedAt,
            plannedWords({
              max: row.maxDollars,
              what: tiedOnly(row, task),
              from: notice ? row.noticeEnd : null,
              until: row.expiresAt,
            }),
            { urgent: notice, before: notice ? row.noticeEnd : null },
          );
        } else if (phase === "working") {
          alert = make(
            row,
            "taken",
            row.takenAt ?? row.announcedAt,
            takenWords({
              what: tiedOnly(row, task),
              setAside: row.setAside,
              deadline: row.deadline ?? row.expiresAt,
            }),
          );
        } else if (phase === "overdue") {
          // Its own kind, so its own id: a holder who read "was taken" is told again when it ran out.
          alert = make(
            row,
            "ran-out",
            row.deadline ?? row.expiresAt,
            ranOutWords(tiedOnly(row, task)),
          );
        } else if (
          phase === "paid" ||
          phase === "sent-back" ||
          phase === "ran-out" ||
          (phase === "wound-down" && row.setAside > 0n)
        ) {
          const at = row.resolvedAt ?? row.takenAt ?? row.announcedAt;
          // Old news is not news: a task that ended before the record's own window is left to the Tasks tab.
          if (at >= now - endedWithin)
            alert = make(
              row,
              "ended",
              at,
              endedWords({
                what: recordWordsOf(row, task),
                paid: phase === "paid",
                pay: row.pay,
                setAside: row.setAside,
              }),
            );
        }
        if (alert) {
          mine.push(alert);
          newest = Math.max(newest, alert.at);
        }
      }
    }
    if (held === "unknown" && mine.length > 0)
      unknownHeld.push({ key, at: newest });
    // A project the person does not hold gives no news about its tasks.
    if (held !== true) continue;
    live.push(...mine.filter((a) => a.kind !== "ended"));
    const own = mine.filter((a) => a.kind === "ended").sort(byAtDescending);
    ended.push(...own.slice(0, MOST_ENDED_PER_PROJECT));
    if (own.length > MOST_ENDED_PER_PROJECT)
      moreEnded.push({
        chainKey: key,
        projectName,
        count: own.length - MOST_ENDED_PER_PROJECT,
      });
  }
  return {
    alerts: [
      ...live.sort(byUrgency),
      ...claims.sort(byAtDescending),
      ...ended.sort(byAtDescending),
    ],
    moreEnded,
    unknownHeld: unknownHeld.sort((a, b) => b.at - a.at).map((u) => u.key),
  };
}

/** The alerts alone (see `alertsResult` for the ended tasks it left out and the projects whose balance is to be read). */
export function alertsOf(input: AlertsInput): TaskAlert[] {
  return alertsResult(input).alerts;
}
