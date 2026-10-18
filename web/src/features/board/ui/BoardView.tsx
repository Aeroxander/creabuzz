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
  useEffect,
  useMemo,
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

import { type BoardPost, buildBoard } from "../lib/board-model";
import { boardRemovers, canAddMembers } from "../lib/members";
import type { PostStatus } from "../lib/post-status";
import { useBoardRecords } from "../use-board";
import { useBoardActions } from "../use-board-actions";
import { useBoardMembers } from "../use-board-members";
import { BoardList } from "./BoardList";
import { PostThread } from "./PostThread";

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
  // Who may remove other people's words here: the board's owners and admins, and the community's. A removal sent by anyone
  // else is not applied.
  const { members } = useBoardMembers(channel.id, true);
  const community = useCommunityPeople();
  const removers = useMemo(() => {
    const set = new Set(boardRemovers(members));
    for (const person of community.people) {
      if (person.role === "owner" || person.role === "admin")
        set.add(person.pubkey);
    }
    return set;
  }, [members, community.people]);
  const canModerate = canAddMembers(members, me);
  const board = useMemo(
    () => buildBoard(records.events, me, removers),
    [records.events, me, removers],
  );

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
    const thread = (extras: PostExtras) => (
      <PostThread
        actions={actions}
        badges={extras.badges}
        canModerate={canModerate}
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
      board={board}
      channel={channel}
      me={me}
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
