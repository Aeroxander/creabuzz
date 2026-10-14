/**
 * Ideas from the boards, on the Work board.
 *
 * Two small lists under one heading. The first is for the team: the posts on
 * the community's boards that have not become tasks yet, best-liked first, each
 * with a "Make a task" button that can also offer the person who wrote it a
 * finder's credit. The second is for anyone whose own post became a task: how
 * it is going, and a button to claim the credit once it is done. The rules
 * (who may do what) are in `../lib/task-source.ts`; boards are only read while
 * the section is open.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { buildBoard } from "@/features/board/lib/board-model";
import { useBoardRecords } from "@/features/board/use-board";
import type { Channel } from "@/features/channels/use-channels";
import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { usePeople } from "@/features/social/use-people";
import { existingUserPubkey } from "@/shared/lib/identity";
import { errorMessage } from "@/shared/ui/query-error";

import { escalatePost } from "../escalate-post";
import { canEscalatePost, defaultFinderReward } from "../lib/task-source";
import type { TaskPlanning } from "../use-task-planning";
import type { WorkItem } from "../use-work-board";

/** Posts offered per board; the team opens the board itself for more. */
const IDEAS_PER_BOARD = 8;

const INPUT =
  "w-24 rounded-md border border-black/10 bg-white px-2 py-1 text-sm outline-none dark:border-white/10 dark:bg-white/5";
const BUTTON =
  "rounded-full bg-black px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black";

/** A whole number of points from a text box, or null when it is empty or not one. */
function points(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function BoardIdeasList({
  board,
  escalated,
}: {
  board: Channel;
  /** Posts that already have a task, by event id. */
  escalated: ReadonlySet<string>;
}) {
  const me = existingUserPubkey();
  const records = useBoardRecords(board.id);
  const posts = useMemo(
    () =>
      buildBoard(records.events, me)
        .posts.filter(
          (post) =>
            post.proposal === null &&
            !escalated.has(post.id) &&
            canEscalatePost(post.author, me),
        )
        .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
        .slice(0, IDEAS_PER_BOARD),
    [records.events, escalated, me],
  );
  const profiles: Record<string, Profile> | undefined = usePeople(
    useMemo(() => posts.map((post) => post.author), [posts]),
  );
  const [open, setOpen] = useState<string | null>(null);
  const [reward, setReward] = useState("");
  const [finder, setFinder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (id: string | null) => {
    setOpen(id);
    setReward("");
    setFinder(null);
  };

  if (records.isLoading) {
    return <p className="text-xs text-black/60 dark:text-white/60">Loading…</p>;
  }
  if (records.error) {
    return (
      <p className="text-xs text-destructive" role="alert">
        Couldn't load #{board.name}.
      </p>
    );
  }
  if (posts.length === 0) {
    return (
      <p className="text-xs text-black/60 dark:text-white/60">
        Nothing waiting on #{board.name}.
      </p>
    );
  }

  const submit = async (post: (typeof posts)[number]) => {
    const rewardPoints = points(reward);
    const finderPoints =
      finder === null ? defaultFinderReward(rewardPoints) : points(finder);
    setBusy(true);
    try {
      const { noted } = await escalatePost({
        post,
        board: board.id,
        reward: rewardPoints,
        finderReward: finderPoints,
      });
      choose(null);
      toast.success("Made into a task", {
        description: noted
          ? "The person who wrote it can see that on the post."
          : "The note under the post could not be sent.",
      });
    } catch (error) {
      toast.error("Couldn't make that a task", {
        description: errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ul className="flex flex-col gap-1.5">
      {posts.map((post) => {
        const rewardPoints = points(reward);
        const suggested = defaultFinderReward(rewardPoints);
        return (
          <li
            key={post.id}
            className="rounded-md border border-black/10 p-2 dark:border-white/10"
            data-testid="idea-row"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{post.title}</p>
                <p className="text-2xs text-black/60 dark:text-white/60">
                  #{board.name} · by{" "}
                  {resolveUserName(profiles?.[post.author], post.author)} ·{" "}
                  {post.score} {Math.abs(post.score) === 1 ? "vote" : "votes"} ·{" "}
                  {post.commentCount}{" "}
                  {post.commentCount === 1 ? "reply" : "replies"}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
                data-testid="idea-make-task"
                onClick={() => choose(open === post.id ? null : post.id)}
              >
                Make a task
              </button>
            </div>
            {open === post.id ? (
              <form
                className="mt-2 flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(post);
                }}
              >
                <label className="flex flex-col gap-1 text-2xs">
                  Reward (points)
                  <input
                    className={INPUT}
                    data-testid="idea-reward"
                    inputMode="numeric"
                    onChange={(event) => setReward(event.target.value)}
                    placeholder="None"
                    value={reward}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs">
                  Credit for the person who wrote it
                  <input
                    className={INPUT}
                    data-testid="idea-finder"
                    inputMode="numeric"
                    onChange={(event) => setFinder(event.target.value)}
                    placeholder={
                      suggested === null ? "None" : String(suggested)
                    }
                    value={finder ?? ""}
                  />
                </label>
                <button
                  className={BUTTON}
                  data-testid="idea-submit"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? "Making…" : "Make task"}
                </button>
                <p className="basis-full text-2xs text-black/60 dark:text-white/60">
                  They can claim the credit once the task is done, and a
                  reviewer accepts it. Leave it empty for the usual tenth of the
                  reward.
                </p>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** What a person is told about a task that began as their own post. */
function suggestionStatus(item: WorkItem): string {
  if (item.status === "done") return "Done";
  if (item.status === "cancelled") return "Closed";
  if (item.status === "needs_approval") return "Waiting for review";
  if (item.status === "in_progress") return "Being worked on";
  return "Made into a task";
}

function YourSuggestions({
  tasks,
  planning,
}: {
  tasks: readonly WorkItem[];
  planning: TaskPlanning;
}) {
  const me = existingUserPubkey();
  const [filed, setFiled] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const claim = async (item: WorkItem) => {
    setBusy(item.key);
    try {
      await planning.claimFinderCredit(item);
      setFiled((prev) => new Set(prev).add(item.key));
    } catch (error) {
      toast.error("Couldn't claim that", { description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="flex flex-col gap-1.5" data-testid="your-suggestions">
      {tasks.map((item) => {
        const credit = item.source?.finderReward ?? null;
        const done = item.doneRowId !== null && me !== null;
        return (
          <li
            key={item.key}
            data-testid="suggestion-row"
            className="flex items-center gap-2 rounded-md border border-black/10 p-2 dark:border-white/10"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="text-2xs text-black/60 dark:text-white/60">
                {suggestionStatus(item)}
                {credit !== null
                  ? ` · ${credit} ${credit === 1 ? "point" : "points"} for you`
                  : ""}
              </p>
            </div>
            {filed.has(item.key) ? (
              <span className="text-2xs" data-testid="suggestion-filed">
                Claimed. A reviewer will look at it.
              </span>
            ) : done && credit !== null ? (
              <button
                type="button"
                className={BUTTON}
                data-testid="suggestion-claim"
                disabled={busy === item.key}
                onClick={() => void claim(item)}
              >
                Claim {credit} {credit === 1 ? "point" : "points"}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function BoardIdeas({
  channels,
  items,
  planning,
}: {
  channels: readonly Channel[];
  items: readonly WorkItem[];
  planning: TaskPlanning;
}) {
  const me = existingUserPubkey();
  const [open, setOpen] = useState(false);
  const boards = useMemo(
    () => channels.filter((channel) => channel.type === "forum"),
    [channels],
  );
  const escalated = useMemo(
    () =>
      new Set(items.flatMap((item) => (item.source ? [item.source.post] : []))),
    [items],
  );
  const mine = useMemo(
    () =>
      me === null
        ? []
        : items.filter((item) => item.source?.author === me.toLowerCase()),
    [items, me],
  );

  if (boards.length === 0 && mine.length === 0) return null;

  return (
    <section
      aria-label="Ideas from the boards"
      className="rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-white/5"
      data-testid="board-ideas"
    >
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left text-sm font-medium"
        data-testid="board-ideas-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        Ideas from the boards
        <span className="text-2xs font-normal text-black/60 dark:text-white/60">
          {mine.length > 0 ? `${mine.length} of yours became tasks · ` : ""}
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-3">
          {mine.length > 0 ? (
            <div>
              <h3 className="mb-1 text-xs font-semibold">Your suggestions</h3>
              <YourSuggestions planning={planning} tasks={mine} />
            </div>
          ) : null}
          {boards.map((board) => (
            <div key={board.id}>
              <h3 className="mb-1 text-xs font-semibold">#{board.name}</h3>
              <BoardIdeasList board={board} escalated={escalated} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
