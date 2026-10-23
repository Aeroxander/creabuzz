/**
 * A board: posts people want to talk about, newest activity first.
 *
 * The page is live (replies, votes and new posts arrive without a reload) but
 * it holds still while it is read: counts and scores change in place, a post
 * does not jump because someone replied, and other people's new posts wait
 * behind a "show" button so the one under the cursor never moves. The reader's
 * own post goes straight to the top.
 *
 * This opens the board, finds the post to show if one is open, and hands the
 * rest to the list (`BoardList`) or the thread (`PostThread`). What is decided
 * (ordering, scoring, which posts are held back) is in `../lib/board-model.ts`.
 */

import {
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import type { Channel } from "@/features/channels/use-channels";
import { useCommunityPeople } from "@/features/communities/use-access";
import { usePeople } from "@/features/social/use-people";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { QueryError } from "@/shared/ui/query-error";

import {
  type BoardPost,
  buildBoard,
  keepRemovals,
  unfamiliarRemovers,
} from "../lib/board-model";
import {
  activeModerators,
  activeMutes,
  mayActAgainst,
  mayUndo,
  muteChoices,
  muteEnd,
  removedReplies,
  STANDING,
  standingOf,
} from "../lib/board-moderation";
import { canAddMembers } from "../lib/members";
import type { PostStatus } from "../lib/post-status";
import { useBoardRecords } from "../use-board";
import { useBoardActions } from "../use-board-actions";
import { useChannelRemovers, useRosterSync } from "../use-board-members";
import { useBoardReports } from "../use-board-reports";
import { useMutedSet } from "@/features/social/use-social-actions";
import {
  useBoardModerationActions,
  useBoardModerationRecords,
} from "../use-board-moderation";
import { BoardList, type BoardListModeration } from "./BoardList";
import { PostThread, type ThreadModeration } from "./PostThread";

/** What a thread about something outside the board adds to it. */
export interface PostExtras {
  /** Shown under the title: where the thing it is about stands. */
  header: ReactNode;
  /** A short fact beside a person's name, by public key. */
  badges: Record<string, string>;
}

export interface PostExtrasProps {
  post: BoardPost;
  authors: readonly string[];
  children: (extras: PostExtras) => ReactNode;
}

/** Where each proposal post's decision stands, found on demand. */
export interface ProposalStatesProps {
  posts: readonly BoardPost[];
  children: (
    statuses: ReadonlyMap<string, PostStatus>,
    ready: boolean,
  ) => ReactNode;
}

type Loadable<P> = ComponentType<P> | LazyExoticComponent<ComponentType<P>>;

const NO_EXTRAS: PostExtras = { header: null, badges: {} };
const NO_STATUSES: ReadonlyMap<string, PostStatus> = new Map();

function needAccount(action: string): boolean {
  if (existingUserPubkey() !== null) return true;
  toast.error(needAccountTo(action));
  return false;
}

export function BoardView({
  channel,
  postId,
  onOpenPost,
  proposalExtras,
  proposalStates,
  suggestPeopleFrom = null,
}: {
  channel: Channel;
  /** A channel whose speakers are offered as people to add to a private board. */
  suggestPeopleFrom?: string | null;
  /** The post that is open, if any (kept in the address so it can be linked to). */
  postId: string | undefined;
  onOpenPost: (id: string | null) => void;
  /**
   * For a post that says it is about a DAO decision: a header and a figure beside names. Passed in (and
   * loaded on demand) so a board that never has such a post does not carry the chain code.
   */
  proposalExtras?: Loadable<PostExtrasProps>;
  /** For the list: where each proposal's decision stands, to show and to order by. Loaded the same way. */
  proposalStates?: Loadable<ProposalStatesProps>;
}) {
  const records = useBoardRecords(channel.id);
  const me = existingUserPubkey();
  const actions = useBoardActions(channel.id, records.add);
  // Who may remove other people's words here: the board's owners and admins, the community's, and the board's appointed
  // moderators. A removal sent by anyone else is not applied.
  const { members, removers: rosterRemovers } = useChannelRemovers(channel.id);
  const ownsOrAdministers = canAddMembers(members, me);
  const moderationRecords = useBoardModerationRecords(channel.id);
  const moderationActions = useBoardModerationActions(channel.id);
  const community = useCommunityPeople();
  const moderators = useMemo(
    () =>
      activeModerators(moderationRecords.state, Math.floor(Date.now() / 1000)),
    [moderationRecords.state],
  );
  const removers = useMemo(
    () => new Set([...rosterRemovers, ...moderators]),
    [rosterRemovers, moderators],
  );
  const roles = useMemo(
    () => ({
      communityRoles: new Map(
        community.people.map((person) => [person.pubkey, person.role]),
      ),
      boardRoles: new Map(
        members.map((member) => [member.pubkey, member.role]),
      ),
      moderators,
    }),
    [community.people, members, moderators],
  );
  const myStanding = standingOf(me, roles);
  const canModerate = myStanding >= STANDING.moderator;
  const canManage = myStanding >= STANDING.boardAdmin;
  const mutedUntil =
    me === null
      ? null
      : (activeMutes(moderationRecords.log, Math.floor(Date.now() / 1000)).get(
          me,
        )?.until ?? null);
  const outranks = useCallback(
    (author: string) => mayActAgainst(myStanding, standingOf(author, roles)),
    [myStanding, roles],
  );
  const reports = useBoardReports(channel.id, canModerate, outranks);
  // What moderators have removed stays removed for this reader even if that moderator's role is later withdrawn.
  const removedSoFar = useRef<{ board: string; ids: ReadonlySet<string> }>({
    board: channel.id,
    ids: new Set(),
  });
  const kept = useMemo(() => {
    const previous =
      removedSoFar.current.board === channel.id
        ? removedSoFar.current.ids
        : new Set<string>();
    const ids = keepRemovals(previous, records.events, removers);
    removedSoFar.current = { board: channel.id, ids };
    return ids;
  }, [records.events, removers, channel.id]);
  const board = useMemo(
    () => buildBoard(records.events, me, removers, kept),
    [records.events, me, removers, kept],
  );
  // The reader's own mutes: posts by people they muted are left out of the list (with a count and a way to show them),
  // and their replies are folded in a thread.
  const muted = useMutedSet();
  const [showMuted, setShowMuted] = useState(false);
  const mutedPosts = useMemo(
    () =>
      board.posts.filter((post) => post.author !== me && muted.has(post.author))
        .length,
    [board.posts, muted, me],
  );
  const listBoard = useMemo(
    () =>
      showMuted || mutedPosts === 0
        ? board
        : {
            ...board,
            posts: board.posts.filter(
              (post) => post.author === me || !muted.has(post.author),
            ),
          },
    [board, showMuted, mutedPosts, muted, me],
  );
  /** May the reader undo (unlock, unpin, unmute) what `placer` did? Unknown placer: offer it and let the server decide. */
  const mayUndoBy = (placer: string | undefined) =>
    placer === undefined || mayUndo(myStanding, standingOf(placer, roles));
  const titles = useMemo(
    () => new Map(board.posts.map((post) => [post.id, post.title])),
    [board.posts],
  );
  // People to offer as moderators: the board's members and whoever has written here, below moderator and not the reader.
  const candidates = useMemo(() => {
    const people = new Set<string>(roles.boardRoles.keys());
    for (const post of board.posts) people.add(post.author);
    for (const list of board.comments.values())
      for (const comment of list) people.add(comment.author);
    return [...people].filter(
      (pubkey) => pubkey !== me && standingOf(pubkey, roles) === STANDING.none,
    );
  }, [roles, board, me]);
  const listModeration: BoardListModeration = {
    state: moderationRecords.state,
    log: moderationRecords.log,
    me,
    canModerate,
    canManage,
    mutedUntil,
    actions: moderationActions,
    mayUndoBy,
    titleOf: (id) => titles.get(id) ?? null,
    onOpenPost,
    candidates,
    reports,
  };

  // The roster is read once and goes stale: keep it current, and look again when someone not known to be an owner or admin
  // sends a removal (they may have been appointed since). Their removal is still ignored until the roster says otherwise.
  const refreshRoster = useRosterSync(channel.id);
  const unfamiliar = unfamiliarRemovers(records.events, removers).join(",");
  useEffect(() => {
    if (unfamiliar !== "") refreshRoster();
  }, [unfamiliar, refreshRoster]);

  const authors = useMemo(() => {
    const set = new Set(board.posts.map((p) => p.author));
    for (const list of board.comments.values())
      for (const c of list) set.add(c.author);
    return [...set];
  }, [board]);
  const profiles = usePeople(authors);

  const proposalPosts = useMemo(
    () => board.posts.filter((post) => post.proposal !== null),
    [board.posts],
  );
  // Once a board has had a proposal post, keep the state reader mounted, so the list does not rebuild if the
  // last one is deleted.
  const [wantStates, setWantStates] = useState(false);
  useEffect(() => {
    if (proposalPosts.length > 0) setWantStates(true);
  }, [proposalPosts.length]);

  const open = postId
    ? board.posts.find((post) => post.id === postId)
    : undefined;

  if (records.error) {
    return (
      <div className="p-4">
        <QueryError
          description={`We couldn't load #${channel.name}.`}
          error={records.error}
          onRetry={records.refetch}
          testId="board-error"
          title="Couldn't load this board"
        />
      </div>
    );
  }

  if (postId) {
    if (!open) {
      return (
        <div className="p-6 text-sm" data-testid="board-missing-post">
          {records.isLoading ? (
            <p className="text-muted-foreground" role="status">
              Loading…
            </p>
          ) : (
            <>
              <p>This post isn't here. It may have been deleted.</p>
              <Button
                className="mt-3"
                onClick={() => onOpenPost(null)}
                size="sm"
                variant="outline"
              >
                Back to the board
              </Button>
            </>
          )}
        </div>
      );
    }
    const threadModeration: ThreadModeration = {
      locked: moderationRecords.state.locked.has(open.id),
      pinned: moderationRecords.state.pinned.includes(open.id),
      canModerate,
      // Pinning is not against anyone; an undo needs at least the standing of whoever did it; a lock is against the
      // author unless it is the reader's own thread (`board_moderation.rs`).
      canTogglePin:
        canModerate &&
        (!moderationRecords.state.pinned.includes(open.id) ||
          mayUndoBy(moderationRecords.state.pinnedBy.get(open.id))),
      canToggleLock:
        canModerate &&
        (moderationRecords.state.locked.has(open.id)
          ? mayUndoBy(moderationRecords.state.lockedBy.get(open.id))
          : open.author === me || outranks(open.author)),
      rules: moderationRecords.state.rules,
      // The server lets a board's owners and admins remove anything on it, and others with standing only what someone of
      // lower standing wrote.
      canRemove: (author) =>
        ownsOrAdministers || (canModerate && outranks(author)),
      canMute: (author) => canModerate && author !== me && outranks(author),
      muteChoices: muteChoices(myStanding),
      onThread: (action, reason) =>
        moderationActions.thread(open.id, action, reason),
      onMute: async (person, days, reason) => {
        await moderationActions.mute(
          person,
          muteEnd(Date.now() / 1000, days),
          reason,
        );
        toast.success(
          myStanding === STANDING.moderator && days > 7
            ? "Muted for 7 days. Another moderator can make it longer within a day."
            : "Muted on this board.",
        );
      },
      removed: removedReplies(moderationRecords.log, open.id),
      mutedUntil,
    };
    const thread = (extras: PostExtras) => (
      <PostThread
        actions={actions}
        badges={extras.badges}
        moderation={threadModeration}
        muted={muted}
        comments={board.comments.get(open.id) ?? []}
        header={extras.header}
        key={open.id}
        me={me}
        needAccount={needAccount}
        onBack={() => onOpenPost(null)}
        post={open}
        profiles={profiles}
      />
    );
    const Extras = proposalExtras;
    return open.proposal && Extras ? (
      <Suspense fallback={thread(NO_EXTRAS)}>
        <Extras authors={authors} post={open}>
          {thread}
        </Extras>
      </Suspense>
    ) : (
      thread(NO_EXTRAS)
    );
  }

  const list = (
    statuses: ReadonlyMap<string, PostStatus>,
    statusesReady: boolean,
  ) => (
    <BoardList
      actions={actions}
      board={listBoard}
      mutedHidden={
        mutedPosts > 0 && !showMuted
          ? { count: mutedPosts, onShow: () => setShowMuted(true) }
          : null
      }
      channel={channel}
      me={me}
      moderation={listModeration}
      onOpenPost={onOpenPost}
      profiles={profiles}
      records={records}
      statuses={statuses}
      statusesReady={statusesReady}
      suggestPeopleFrom={suggestPeopleFrom}
    />
  );
  const States = proposalStates;
  return States && wantStates ? (
    <Suspense fallback={list(NO_STATUSES, false)}>
      <States posts={proposalPosts}>{list}</States>
    </Suspense>
  ) : (
    list(NO_STATUSES, true)
  );
}
