/**
 * Reading and sending help: "I can help" on an update that asks for it, taking an offer back, the team's reply, "Help
 * found" and reopening. Each is one signed record (`lib/help-request.ts`).
 *
 * Help records are read on their own, never from the list of every project (which is cut at a fixed number of records):
 * - a project's card reads that project's records a page at a time, and says when it could not read them all;
 * - Notifications reads the records that name the viewer;
 * - Home's side panel reads what answers the few requests it may show.
 * Every read is bounded, and one that hit its bound is treated as "not known", never as "nothing there".
 *
 * No state is kept outside React and the query cache: nothing here outlives a change of community.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { LAUNCH_UPDATE_LABEL } from "@/features/social/lib/launch-update";
import { KIND_LAUNCH_UPDATE, KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  readAuthorUpdates,
  readEvidenceEvents,
  readPaged,
} from "./lib/evidence-query";
import {
  deletionsFilter,
  type RemovedRecords,
  removedRecords,
} from "./lib/removed-records";
import {
  type GoalVersion,
  isGoalRecordTags,
  parseGoalVersion,
} from "./lib/goals";
import { removeEach } from "./lib/removals";
import { isTaskRecordTags } from "./lib/tasks";
import { isTeamAnswerTags } from "./lib/team";
import {
  foundEvent,
  type HelpNotice,
  helpNotices,
  type HelpSignal,
  isHelpSignalTags,
  offerEvent,
  type OpenHelpRequest,
  parseHelpSignal,
  replyEvent,
  stillOpen,
} from "./lib/help-request";
import {
  launchCoordinate,
  type Launch,
  type LaunchUpdate,
  parseLaunchUpdate,
} from "./models";
import { publishMirror, useLaunches } from "./use-launches";

type Project = Pick<Launch["record"], "author" | "id">;

/** Every help read is cached under this, so one send refreshes the cards, the notifications and the side panel. */
export const helpQueryKey = ["launchpad", "help"] as const;

/** How many posts marked as updates are read for one project. */
const MARKED_POSTS_LIMIT = 200;
/** How many help records that name the viewer, and how many of the viewer's own, Notifications reads. */
const NOTICE_READ_LIMIT = 200;
/** How many records answering the side panel's requests are read. */
const RAIL_READ_LIMIT = 200;

function signalsOf(events: readonly NostrEvent[]): HelpSignal[] {
  return events.flatMap((event) => {
    const signal = parseHelpSignal(event);
    return signal ? [signal] : [];
  });
}

export interface ProjectUpdatesRead {
  /** The project's update records (not help records), as read: anyone's, newest first. */
  updates: LaunchUpdate[];
  /** Offers, replies and "Help found" marks on this project. */
  signals: HelpSignal[];
  /**
   * The founder's own records about this project, read by author: its goals and the updates that make and answer
   * promises. Read apart from everyone else's records, so nobody can post enough of their own to cut this read short.
   */
  founder: {
    updates: LaunchUpdate[];
    goals: GoalVersion[];
    /** The founder's records were read to the end. */
    complete: boolean;
    /** The update records the founder has deleted (`lib/removed-records.ts`). */
    removed: RemovedRecords;
  };
  /** The records were read to the end. False when the project has more than the bound. */
  complete: boolean;
  /** Posts about this project marked as updates (the other form an update takes). */
  posts: NostrEvent[];
  /** The read of those posts was cut at its limit. */
  postsCut: boolean;
}

/**
 * One project's update and help records, read for that project alone (its `a` tag), a page at a time up to a bound,
 * with the posts marked as its updates. `data.complete` and `data.postsCut` say whether anything was left unread.
 */
export function useProjectUpdates(project: Project) {
  const coordinate = launchCoordinate(project.author, project.id);
  const relay = relayWsUrl();
  return useQuery({
    queryKey: [...helpQueryKey, "project", relay, coordinate],
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ProjectUpdatesRead> => {
      const [records, own, deletions, posts] = await Promise.all([
        readEvidenceEvents((filter) => queryEvents(relay, filter), coordinate),
        readAuthorUpdates(
          (filter) => queryEvents(relay, filter),
          project.author,
        ),
        // The founder's deletions, by author, page by page: deletions of other things cannot push these out.
        readPaged(
          (filter) => queryEvents(relay, filter),
          () => deletionsFilter(project.author),
        ),
        queryEvents(relay, {
          kinds: [KIND_TEXT_NOTE],
          "#a": [coordinate],
          "#l": [LAUNCH_UPDATE_LABEL],
          limit: MARKED_POSTS_LIMIT,
        }),
      ]);
      // The founder signs records about all their projects: only this project's, and only theirs, are kept.
      const mine = own.events.filter(
        (event) =>
          event.pubkey === project.author &&
          event.tags.some((tag) => tag[0] === "a" && tag[1] === coordinate),
      );
      return {
        updates: records.events
          .flatMap((event) => {
            if (isHelpSignalTags(event.tags)) return [];
            if (isGoalRecordTags(event.tags)) return [];
            if (isTaskRecordTags(event.tags)) return [];
            if (isTeamAnswerTags(event.tags)) return [];
            const update = parseLaunchUpdate(event);
            return update ? [update] : [];
          })
          .sort((a, b) => b.createdAt - a.createdAt),
        signals: signalsOf(records.events),
        founder: {
          updates: mine
            .flatMap((event) => {
              if (isHelpSignalTags(event.tags)) return [];
              if (isGoalRecordTags(event.tags)) return [];
              if (isTaskRecordTags(event.tags)) return [];
              if (isTeamAnswerTags(event.tags)) return [];
              const update = parseLaunchUpdate(event);
              return update ? [update] : [];
            })
            .sort((a, b) => b.createdAt - a.createdAt),
          goals: mine.flatMap((event) => {
            const goal = parseGoalVersion(event);
            return goal ? [goal] : [];
          }),
          complete: own.complete,
          removed: removedRecords(
            deletions.events,
            project.author,
            deletions.complete,
          ),
        },
        complete: records.complete,
        posts,
        postsCut: posts.length >= MARKED_POSTS_LIMIT,
      };
    },
  });
}

function sendSignal(
  project: Project,
  signal: { content: Record<string, unknown>; tags: string[][] },
) {
  return publishMirror({
    kind: KIND_LAUNCH_UPDATE,
    tags: [["a", launchCoordinate(project.author, project.id)], ...signal.tags],
    content: signal.content,
  });
}

/** Deletes the sender's own update records, one signed removal each (`lib/removals.ts`). */
function removeOwn(ids: readonly string[]) {
  return removeEach(ids, (id) =>
    publishMirror({
      kind: 5,
      // `k` names the kind removed, and the server checks it against the record: these are update records.
      tags: [
        ["e", id],
        ["k", String(KIND_LAUNCH_UPDATE)],
      ],
      content: {},
    }),
  );
}

/** Thrown when the offer a reply was written to is no longer on the server. */
export class OfferWithdrawnError extends Error {
  constructor() {
    super("offer withdrawn");
    this.name = "OfferWithdrawnError";
  }
}

/** What a help card can send. Each is its own mutation, so one failing or pending never hides another. */
export function useHelpActions(project: Project) {
  const queryClient = useQueryClient();
  const onSuccess = () =>
    queryClient.invalidateQueries({ queryKey: helpQueryKey });

  const offer = useMutation({
    mutationFn: (input: {
      updateId: string;
      updateAuthor: string;
      note: string;
    }) => sendSignal(project, offerEvent(input)),
    onSuccess,
  });
  const reply = useMutation({
    mutationFn: async (input: {
      offerId: string;
      offerAuthor: string;
      note: string;
    }) => {
      // The offer may have been taken back since the list was read: a reply to nothing is not sent.
      const still = await queryEvents(relayWsUrl(), {
        kinds: [KIND_LAUNCH_UPDATE],
        ids: [input.offerId],
        limit: 1,
      });
      if (!still.some((event) => event.id === input.offerId))
        throw new OfferWithdrawnError();
      return sendSignal(project, replyEvent(input));
    },
    onSuccess,
    // Withdrawn or not sent, the list is read again so the card shows what the server has.
    onError: onSuccess,
  });
  const found = useMutation({
    mutationFn: (input: { updateId: string }) =>
      sendSignal(project, foundEvent(input)),
    onSuccess,
  });
  /** Reopens a request: the viewer's own "Help found" marks are deleted. */
  const reopen = useMutation({
    mutationFn: (input: { foundIds: readonly string[] }) =>
      removeOwn(input.foundIds),
    onSuccess,
    // Some may have gone: the list is read again so what is left shows, and Try again removes it.
    onError: onSuccess,
  });
  /** Takes an offer back: every offer record the person has on the update is deleted, so none comes back. */
  const withdraw = useMutation({
    mutationFn: (input: { offerIds: readonly string[] }) =>
      removeOwn(input.offerIds),
    onSuccess,
    onError: onSuccess,
  });
  return { offer, reply, found, reopen, withdraw };
}

const NO_NOTICES: HelpNotice[] = [];

/**
 * Offers to help on updates the viewer wrote and replies to offers the viewer made, newest first: the help records
 * that name the viewer, read on their own. People in `muted` are left out before the list is cut.
 */
export function useHelpNotices(muted?: ReadonlySet<string>): HelpNotice[] {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const launches = useLaunches().data;
  const read = useQuery({
    queryKey: [...helpQueryKey, "notices", relay, me],
    enabled: me !== null,
    staleTime: 30_000,
    // The server does not push records by who they name, so polling is how these arrive.
    refetchInterval: 60_000,
    queryFn: async () => {
      const [naming, mine] = await Promise.all([
        queryEvents(relay, {
          kinds: [KIND_LAUNCH_UPDATE],
          "#p": [me as string],
          limit: NOTICE_READ_LIMIT,
        }),
        queryEvents(relay, {
          kinds: [KIND_LAUNCH_UPDATE],
          authors: [me as string],
          limit: NOTICE_READ_LIMIT,
        }),
      ]);
      return {
        naming: naming.flatMap((event) => {
          const signal = parseHelpSignal(event);
          const coordinate = event.tags.find((t) => t[0] === "a")?.[1];
          return signal && coordinate ? [{ signal, coordinate }] : [];
        }),
        mine: signalsOf(mine).filter((s) => s.kind === "offer"),
      };
    },
  }).data;
  return useMemo(
    () =>
      me && launches && read
        ? helpNotices({ ...read, launches, viewer: me, muted })
        : NO_NOTICES,
    [me, launches, read, muted],
  );
}

/**
 * Which of `candidates` (the requests a side panel may show) are still open: one read of what answers them. `known` is
 * false until the read answers, and stays false when it hit its limit: an unread "Help found" would show a closed
 * request as open.
 */
export function useStillOpen(
  candidates: readonly OpenHelpRequest[],
  limit: number,
): {
  requests: OpenHelpRequest[];
  known: boolean;
  failed: boolean;
  retry: () => void;
} {
  const relay = relayWsUrl();
  const ids = useMemo(() => candidates.map((c) => c.updateId), [candidates]);
  const read = useQuery({
    queryKey: [...helpQueryKey, "open", relay, ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const events = await queryEvents(relay, {
        kinds: [KIND_LAUNCH_UPDATE],
        "#e": ids,
        limit: RAIL_READ_LIMIT,
      });
      return {
        signals: signalsOf(events),
        cut: events.length >= RAIL_READ_LIMIT,
      };
    },
  });
  const requests = useMemo(
    () =>
      read.data && !read.data.cut
        ? stillOpen(candidates, read.data.signals, limit)
        : [],
    [candidates, read.data, limit],
  );
  const { refetch } = read;
  return {
    requests,
    known: Boolean(read.data && !read.data.cut),
    failed: read.isError && !read.data,
    retry: () => void refetch(),
  };
}
