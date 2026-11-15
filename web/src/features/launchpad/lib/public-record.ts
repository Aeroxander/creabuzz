/**
 * A project's public record, for someone an invite-only server does not let in: the goal, the weekly updates, the
 * promises kept and missed, and the work that was accepted. Nothing else.
 *
 * Some servers let anyone read these records while everything else stays for members. The server decides: it answers
 * only the two reads below, only for a project it would also show in a link preview (listed, not removed, its founder
 * in good standing) whose record states no terms of a sale, and at most `PUBLIC_READ_LIMIT` records each. Of the
 * records about a project it gives only the founder's goals and promises, the team's updates, and the three steps of
 * work that was accepted (the task, the work handed in, the confirmation). Work still waiting or sent back, offers of
 * help and everything else stay for members, so nothing here can be worked out from them. This file names the project
 * an address is about, builds those reads, and works out what the page may state from what came back. A number whose
 * read hit the limit is null and the page leaves it out; nothing here guesses.
 *
 * Pure and alias-free: `public-record.test.mjs` drives it under `node --test`.
 */

import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "../../../shared/constants/kinds.ts";
import { isGoalRecordTags, parseGoalVersion, projectGoals } from "./goals.ts";
import { isHelpSignalTags, parseHelpSignal, teamOf } from "./help-request.ts";
import {
  launchCoordinate,
  type LaunchRecord,
  type LaunchUpdate,
  parseLaunchRecord,
  parseLaunchUpdate,
} from "../models.ts";
import { projectState } from "./project-state.ts";
import {
  type PromiseEntry,
  type PromiseState,
  promiseRecord,
  type PromiseTotals,
} from "./promises.ts";
import { parseScorecardSlug } from "./share.ts";
import { acceptedByOthers, doneAlone } from "./task-checks.ts";
import {
  isTaskRecordTags,
  parseTaskRecord,
  TASK_LABEL,
  type TaskRecord,
} from "./tasks.ts";
import { isTeamAnswerTags } from "./team.ts";

/** The most records the server answers one public read with. A read that returns this many may have been cut. */
export const PUBLIC_READ_LIMIT = 200;
/** The most accounts one read may name: the server refuses a longer list. */
const AUTHORS_READ = 50;
/** How many answered promises and accepted pieces of work the page lists. */
const PROMISES_SHOWN = 5;
const WORK_SHOWN = 5;
const BODY_CHARS = 400;
const ANSWERED: readonly PromiseState[] = ["kept", "missed", "changed"];

interface PublicEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** One filter of a public read: the two shapes the server answers, and nothing wider. */
export interface PublicFilter {
  kinds: number[];
  authors?: string[];
  /** The start of the founder's account id, as a scorecard address carries it: the server looks for that founder alone. */
  founder_start?: string;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

/** The project a shared address names. */
export interface PublicAddress {
  id: string;
  /** The founder's whole account id, when the address carries it (a project page link). */
  author: string | null;
  /** The first characters of the founder's account id, when the address carries those (a scorecard link). */
  founderStart: string | null;
}

/**
 * The project an address is about: `/p/<id>-<start of the founder's id>` (its scorecard) or `/launchpad/<id>` with an
 * optional `?author=`. Null for any other address. These are the two addresses a project is shared by.
 */
export function projectAtAddress(
  pathname: string,
  search: string,
): PublicAddress | null {
  const decode = (part: string): string | null => {
    try {
      return decodeURIComponent(part);
    } catch {
      return null;
    }
  };
  const path = pathname.replace(/\/+$/, "");
  if (path.startsWith("/p/")) {
    const slug = decode(path.slice("/p/".length));
    const named = slug === null ? null : parseScorecardSlug(slug);
    return named
      ? { id: named.id, author: null, founderStart: named.founderStart }
      : null;
  }
  if (path.startsWith("/launchpad/")) {
    const id = decode(path.slice("/launchpad/".length));
    if (!id || id.includes("/")) return null;
    const author = new URLSearchParams(search).get("author")?.toLowerCase();
    return {
      id,
      author: author && /^[0-9a-f]{64}$/.test(author) ? author : null,
      founderStart: null,
    };
  }
  return null;
}

/**
 * The read for the project's own record. It names the founder whenever the address does (the whole account id, or
 * its start): anyone on the server's list can start a project under an id that is taken, and a read by id alone
 * could be answered with their projects and not the one the address means.
 */
export function recordFilters(address: PublicAddress): PublicFilter[] {
  return [
    {
      kinds: [KIND_LAUNCH_RECORD],
      "#d": [address.id],
      ...(address.author
        ? { authors: [address.author] }
        : address.founderStart
          ? { founder_start: address.founderStart }
          : {}),
    },
  ];
}

/**
 * The one project record the address names, from what the server answered: the founder the address names, and only
 * when exactly one project fits. Several founders under one id, with nothing in the address to choose by, is null: the
 * page does not pick for the reader.
 */
export function recordNamed(
  address: PublicAddress,
  events: readonly PublicEvent[],
): LaunchRecord | null {
  const newest = new Map<string, LaunchRecord>();
  for (const event of events) {
    const record = parseLaunchRecord(event);
    if (!record || record.id !== address.id) continue;
    if (address.author && record.author !== address.author) continue;
    if (address.founderStart && !record.author.startsWith(address.founderStart))
      continue;
    const was = newest.get(record.author);
    if (!was || record.createdAt >= was.createdAt)
      newest.set(record.author, record);
  }
  return newest.size === 1 ? ([...newest.values()][0] ?? null) : null;
}

/** The read for what the project's own team signed about it. */
export function teamFilters(record: LaunchRecord): PublicFilter[] {
  return [
    {
      kinds: [KIND_LAUNCH_UPDATE],
      "#a": [launchCoordinate(record.author, record.id)],
      authors: [...teamOf(record)].slice(0, AUTHORS_READ),
      limit: PUBLIC_READ_LIMIT,
    },
  ];
}

const tasksOf = (events: readonly PublicEvent[]): TaskRecord[] =>
  events.flatMap((event) => {
    if (event.kind !== KIND_LAUNCH_UPDATE) return [];
    const task = parseTaskRecord(event);
    return task ? [task] : [];
  });

/** The helpers the team's tasks name who are not on the team: their own steps are a second read. */
export function helpersNamed(
  record: LaunchRecord,
  teamEvents: readonly PublicEvent[],
): string[] {
  const team = teamOf(record);
  return [
    ...new Set(
      tasksOf(teamEvents.filter((event) => team.has(event.pubkey))).flatMap(
        (task) =>
          task.part === "task" && task.helper && !team.has(task.helper)
            ? [task.helper]
            : [],
      ),
    ),
  ].sort();
}

/** The read for the steps those helpers signed on this project's tasks, or null when there is nobody to read. */
export function helperFilters(
  record: LaunchRecord,
  helpers: readonly string[],
): PublicFilter[] | null {
  if (helpers.length === 0) return null;
  return [
    {
      kinds: [KIND_LAUNCH_UPDATE],
      "#a": [launchCoordinate(record.author, record.id)],
      authors: helpers.slice(0, AUTHORS_READ),
      "#l": [TASK_LABEL],
      limit: PUBLIC_READ_LIMIT,
    },
  ];
}

/** What the page shows of a project to someone who is not on the server's list. */
export interface PublicRecordView {
  name: string;
  image: string | null;
  /** The founder's main goal, or the project's one-liner when no goal was read. May be empty. */
  goal: string;
  /** How everyone will know the goal was reached, when the goal says. */
  goalHow: string;
  /** Weeks in a row with a weekly update; null when not all of the team's records were read. */
  streak: number | null;
  /** The founder's promises, totalled; null when not all of the team's records were read. */
  promises: PromiseTotals | null;
  /** The newest answered promises, newest answer first. */
  answered: PromiseEntry[];
  /** How many pieces of work someone other than the person who did them accepted; null when that cannot be said. */
  accepted: number | null;
  /** How many pieces the founder did alone and checked themself: counted apart; null when that cannot be said. */
  doneAlone: number | null;
  /** The newest finished pieces: what was asked for, when, and whether only the founder checked their own work. */
  work: Array<{
    id: string;
    what: string;
    acceptedAt: number;
    selfChecked: boolean;
  }>;
  /** The team's newest update, or null when there is none. */
  latest: { title: string; body: string; at: number } | null;
  /** Every number above rests on a read that reached its end. */
  complete: boolean;
}

/**
 * The public record of `record`, from the team's own records about it (`teamEvents`) and the steps of the helpers its
 * tasks name (`helperEvents`, null when that read was not made because no helper is named). What came back is checked
 * again here: only this project's records, only from the people each read was for.
 */
export function publicRecordView(input: {
  record: LaunchRecord;
  teamEvents: readonly PublicEvent[];
  helperEvents: readonly PublicEvent[] | null;
  /** Now, in seconds. */
  now: number;
}): PublicRecordView {
  const { record, now } = input;
  const coordinate = launchCoordinate(record.author, record.id);
  const team = teamOf(record);
  const about = (event: PublicEvent) =>
    event.kind === KIND_LAUNCH_UPDATE &&
    event.tags.some((tag) => tag[0] === "a" && tag[1] === coordinate);
  const own = input.teamEvents.filter(
    (event) => about(event) && team.has(event.pubkey),
  );
  const helpers = helpersNamed(record, own);
  const helperSteps = (input.helperEvents ?? []).filter(
    (event) => about(event) && helpers.includes(event.pubkey),
  );

  const updates: LaunchUpdate[] = own.flatMap((event) => {
    if (
      isHelpSignalTags(event.tags) ||
      isGoalRecordTags(event.tags) ||
      isTaskRecordTags(event.tags) ||
      isTeamAnswerTags(event.tags)
    )
      return [];
    const update = parseLaunchUpdate(event);
    return update ? [update] : [];
  });
  const goals = projectGoals(
    own.flatMap((event) => {
      const goal = parseGoalVersion(event);
      return goal ? [goal] : [];
    }),
    record.author,
  );
  const teamComplete =
    input.teamEvents.length < PUBLIC_READ_LIMIT && team.size <= AUTHORS_READ;
  const helpersComplete =
    helpers.length === 0 ||
    (input.helperEvents !== null &&
      input.helperEvents.length < PUBLIC_READ_LIMIT &&
      helpers.length <= AUTHORS_READ);
  const shown = updates
    .filter((update) => update.createdAt <= now)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  const latest = shown[0] ?? null;

  const state = projectState({
    coordinate,
    founder: record.author,
    team,
    updates,
    latestAt: latest?.createdAt ?? null,
    signals: own.flatMap((event) => {
      const signal = parseHelpSignal(event);
      return signal ? [signal] : [];
    }),
    tasks: [...tasksOf(own), ...tasksOf(helperSteps)],
    // Offers of help and posts on Home are not part of the public record, and nothing shown here rests on them.
    complete: {
      team: teamComplete,
      offers: false,
      helpers: helpersComplete,
      posts: true,
    },
    viewer: null,
    now,
  });

  const accepted = state.tasks
    .filter((task) => task.state === "confirmed" && task.accepted)
    .sort(
      (a, b) =>
        Math.min(b.accepted?.confirmedAt ?? 0, now) -
          Math.min(a.accepted?.confirmedAt ?? 0, now) || (a.id < b.id ? -1 : 1),
    );
  const body = latest?.body ?? "";
  return {
    name: record.name,
    image: record.image ?? null,
    goal: goals.primary?.text || record.pitch || "",
    goalHow: goals.primary?.how ?? "",
    streak: state.streak,
    promises: state.promises,
    answered: promiseRecord(
      updates.filter((update) => update.author === record.author),
      record.author,
    )
      .filter((promise) => ANSWERED.includes(promise.state))
      .sort(
        (a, b) =>
          Math.min(b.answeredAt ?? 0, now) - Math.min(a.answeredAt ?? 0, now) ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, PROMISES_SHOWN),
    accepted: state.tasksKnown ? acceptedByOthers(state.tasks).length : null,
    doneAlone: state.tasksKnown ? doneAlone(state.tasks).length : null,
    work: accepted.slice(0, WORK_SHOWN).map((task) => ({
      id: task.id,
      what: task.what,
      acceptedAt: task.accepted?.confirmedAt ?? 0,
      selfChecked: task.selfChecked,
    })),
    latest: latest
      ? {
          title: latest.title,
          body:
            body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}…` : body,
          at: latest.createdAt,
        }
      : null,
    complete: teamComplete && helpersComplete,
  };
}
