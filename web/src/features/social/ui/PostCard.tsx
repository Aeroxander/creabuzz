import { Link, useNavigate } from "@tanstack/react-router";
import {
  Ban,
  Bookmark,
  Bot,
  Flag,
  Megaphone,
  MessageCircle,
  Quote,
  Repeat2,
  Rocket,
  Share,
  ShieldX,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import { ReasonDialog } from "@/features/board/ui/ReasonDialog";
import { useBanAuthor } from "@/features/communities/ui/BanAuthor";
import {
  buildDeleteContent,
  plainRefusal,
} from "@/features/moderation/lib/moderationEvents";
import { ReportDialog } from "@/features/moderation/ui/ReportDialog";
import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relativeTime, shortRelativeTime } from "@/shared/lib/relative-time";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { parseLaunchCoordinate, parseNote } from "../../feed/lib/feed-events";
import type { Engagement } from "../lib/engagement";
import { buildRepost, buildUndo } from "../lib/post-events";
import type { Row } from "../lib/timeline";
import { useSocialPublish, useToggleBookmark } from "../use-social-actions";
import { PostContent } from "./PostContent";
import { PostMoneyChip } from "./PostMoneyChip";
import { PostVotes } from "./PostVotes";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { QuoteDialog } from "./QuoteDialog";

function compact(n: number): string {
  return n === 0
    ? ""
    : new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
}

type Tone = "reply" | "repost" | "bookmark" | "share" | "delete" | "report";

const HOVER: Record<Tone, string> = {
  reply: "hover:text-sky-600 [&:hover>span:first-child]:bg-sky-500/10",
  repost: "hover:text-emerald-600 [&:hover>span:first-child]:bg-emerald-500/10",
  bookmark: "hover:text-sky-600 [&:hover>span:first-child]:bg-sky-500/10",
  share: "hover:text-sky-600 [&:hover>span:first-child]:bg-sky-500/10",
  delete: "hover:text-red-600 [&:hover>span:first-child]:bg-red-500/10",
  report: "hover:text-red-600 [&:hover>span:first-child]:bg-red-500/10",
};

const ACTIVE: Record<Tone, string> = {
  reply: "",
  repost: "text-emerald-600",
  bookmark: "text-sky-600",
  share: "",
  delete: "",
  report: "",
};

function ActionButton({
  label,
  count,
  tone,
  active = false,
  disabled = false,
  onClick,
  testId,
  children,
}: {
  label: string;
  count?: number;
  tone: Tone;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={
        tone === "bookmark" || tone === "repost" ? active : undefined
      }
      className={cn(
        "group relative z-10 flex items-center gap-0.5 text-xs text-black/60 transition-colors disabled:cursor-default dark:text-white/60",
        HOVER[tone],
        active && ACTIVE[tone],
      )}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="-m-2 flex h-9 w-9 items-center justify-center rounded-full transition-colors [&_svg]:h-[1.125rem] [&_svg]:w-[1.125rem]">
        {children}
      </span>
      <span className="min-w-4 tabular-nums">
        {count ? compact(count) : ""}
      </span>
    </button>
  );
}

/**
 * One post in a timeline: avatar column, author line, text and media, and the
 * action bar — reply, repost (or quote), up and down votes, bookmark, share. The whole card
 * opens the post through the timestamp's stretched link.
 */
export function PostCard({
  row,
  author,
  reposter,
  engagement,
  bookmarked,
  launchName,
  launchUpdate = false,
  onReply,
}: {
  row: Row;
  author?: ProfileMetadata;
  reposter?: ProfileMetadata;
  engagement: Engagement;
  bookmarked: boolean;
  launchName: (coord: string) => string | null;
  /** The team's official update for a launch (verified by the caller). */
  launchUpdate?: boolean;
  /** In a thread: Reply opens a box under this post instead of going to its page. */
  onReply?: () => void;
}) {
  const note = row.event;
  const me = existingUserPubkey();
  const navigate = useNavigate();
  const publish = useSocialPublish();
  const bookmark = useToggleBookmark();
  const [menuOpen, setMenuOpen] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const name = resolveUserName(author, note.pubkey);
  const ban = useBanAuthor(note.pubkey, name);
  const handle = resolveUserSecondaryName(author, note.pubkey);
  const isReposted = engagement.viewerRepostId !== null;
  const parsed = parseNote(note);
  const launches = parsed?.launches ?? [];

  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "That didn't work.");

  const repost = () => {
    setMenuOpen(false);
    publish.mutate(
      engagement.viewerRepostId
        ? buildUndo(engagement.viewerRepostId, 6)
        : buildRepost(note),
      { onError: fail },
    );
  };

  const share = () => {
    const url = `${window.location.origin}/social/post/${note.id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  const isMine = me !== null && note.pubkey === me;
  const remove = () => {
    setConfirmDelete(false);
    // Hidden at once; put back if the relay refuses.
    setDeleted(true);
    publish.mutate(buildUndo(note.id, note.kind), {
      onSuccess: () => toast.success("Post deleted"),
      onError: (error) => {
        setDeleted(false);
        fail(error);
      },
    });
  };

  // A community owner or admin takes someone else's post off Home (the same
  // people, by the same rank rule, who are offered Ban). The server decides
  // again, closes the reports about it and tells the author.
  const moderatorRemove = async (reason: string) => {
    try {
      await publishAsUser(
        buildDeleteContent({ channelId: null, eventId: note.id, reason }),
        "The server did not remove the post. Try again.",
      );
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message
          ? plainRefusal(error.message)
          : "The server did not remove the post. Try again.",
      );
    }
    setDeleted(true);
    toast.success(`Post removed. ${name} is told.`);
  };

  if (deleted) return null;

  return (
    <article
      aria-label={`Post by ${name}`}
      className={cn(
        "relative border-b border-black/10 px-4 pb-1 pt-3 transition-colors hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.03]",
        launchUpdate && "border-l-[3px] border-l-primary bg-primary/[0.06]",
      )}
      data-launch-update={launchUpdate ? "true" : undefined}
      data-testid="social-post"
    >
      {launchUpdate ? (
        <p
          className="mb-1 flex items-center gap-1.5 pl-12 text-xs font-bold text-primary-ink"
          data-testid="social-launch-update"
        >
          <Megaphone aria-hidden className="h-3.5 w-3.5" /> Launch update
        </p>
      ) : null}
      {row.repostedBy ? (
        <p
          className="mb-1 flex items-center gap-2 pl-12 text-xs font-semibold text-black/60 dark:text-white/60"
          data-testid="social-reposted-by"
        >
          <Repeat2 aria-hidden className="h-4 w-4" />
          <Link
            className="relative z-10 truncate hover:underline"
            params={{ pubkey: row.repostedBy.pubkey }}
            to="/u/$pubkey"
          >
            {row.repostedBy.pubkey === me
              ? "You"
              : resolveUserName(reposter, row.repostedBy.pubkey)}{" "}
            reposted
          </Link>
        </p>
      ) : null}
      <div className="flex gap-3">
        <Link
          aria-label={`${name}'s profile`}
          className="relative z-10 h-fit shrink-0"
          params={{ pubkey: note.pubkey }}
          to="/u/$pubkey"
        >
          <UserAvatar
            avatarUrl={author?.picture ?? null}
            className="h-11 w-11"
            displayName={name}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1 text-sm">
            <Link
              className="relative z-10 truncate font-bold text-black hover:underline dark:text-white"
              params={{ pubkey: note.pubkey }}
              to="/u/$pubkey"
            >
              {name}
            </Link>
            {parsed?.byAgent ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 self-center rounded-full bg-sky-500/15 px-1.5 text-2xs font-medium text-sky-800 dark:text-sky-200"
                title="Posted by an agent on its owner's behalf"
              >
                <Bot aria-hidden className="h-3 w-3" /> Agent
              </span>
            ) : null}
            <span className="truncate text-black/60 dark:text-white/60">
              {handle}
            </span>
            <span className="text-black/60 dark:text-white/60">·</span>
            <Link
              aria-label={`Open post from ${relativeTime(note.created_at)}`}
              className="shrink-0 text-black/60 after:absolute after:inset-0 hover:underline dark:text-white/60"
              params={{ id: note.id }}
              title={new Date(note.created_at * 1000).toLocaleString()}
              to="/social/post/$id"
            >
              {shortRelativeTime(note.created_at)}
            </Link>
          </p>
          <div className="mt-0.5">
            <PostContent text={note.content} />
          </div>
          {launches.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {launches.map((coord) => {
                const ref = parseLaunchCoordinate(coord);
                if (!ref) return null;
                return (
                  <Link
                    className="relative z-10 inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-500/10 dark:text-violet-200"
                    key={coord}
                    params={{ launchId: ref.id }}
                    search={{ author: ref.pubkey, action: undefined }}
                    to="/launchpad/$launchId"
                  >
                    <Rocket aria-hidden className="h-3.5 w-3.5" />
                    {launchName(coord) ?? ref.id}
                  </Link>
                );
              })}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
            <PostMoneyChip post={note.id} />
          </div>
          <div className="mt-1 flex max-w-md items-center justify-between">
            <ActionButton
              count={engagement.replies}
              label="Reply"
              onClick={
                onReply ??
                (() =>
                  void navigate({
                    to: "/social/post/$id",
                    params: { id: note.id },
                  }))
              }
              testId="social-reply"
              tone="reply"
            >
              <MessageCircle aria-hidden />
            </ActionButton>
            <div className="relative">
              <ActionButton
                active={isReposted}
                count={engagement.reposts + engagement.quotes}
                disabled={!me}
                label={isReposted ? "Reposted" : "Repost"}
                onClick={() => setMenuOpen((open) => !open)}
                testId="social-repost"
                tone="repost"
              >
                <Repeat2 aria-hidden />
              </ActionButton>
              {menuOpen ? (
                <>
                  <button
                    aria-label="Close menu"
                    className="fixed inset-0 z-20 cursor-default"
                    onClick={() => setMenuOpen(false)}
                    type="button"
                  />
                  <div
                    className="absolute bottom-full left-0 z-30 mb-1 w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-neutral-900"
                    role="menu"
                  >
                    <button
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-black hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
                      data-testid="social-repost-confirm"
                      onClick={repost}
                      role="menuitem"
                      type="button"
                    >
                      <Repeat2 aria-hidden className="h-4 w-4" />
                      {isReposted ? "Undo repost" : "Repost"}
                    </button>
                    <button
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-black hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
                      data-testid="social-quote"
                      onClick={() => {
                        setMenuOpen(false);
                        setQuoting(true);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Quote aria-hidden className="h-4 w-4" />
                      Quote
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <PostVotes
              engagement={engagement}
              label={`post by ${name}`}
              target={note}
            />
            <ActionButton
              active={bookmarked}
              disabled={!me}
              label={bookmarked ? "Remove bookmark" : "Bookmark"}
              onClick={() =>
                bookmark.mutate(
                  { id: note.id, saved: !bookmarked },
                  { onError: fail },
                )
              }
              testId="social-bookmark"
              tone="bookmark"
            >
              <Bookmark
                aria-hidden
                className={cn(bookmarked && "fill-current")}
              />
            </ActionButton>
            <ActionButton
              label="Copy link"
              onClick={share}
              testId="social-share"
              tone="share"
            >
              <Share aria-hidden />
            </ActionButton>
            {!isMine && me !== null ? (
              <ActionButton
                label="Report post"
                onClick={() => setReporting(true)}
                testId="social-report"
                tone="report"
              >
                <Flag aria-hidden />
              </ActionButton>
            ) : null}
            {!isMine && me !== null && ban.allowed ? (
              <ActionButton
                label="Remove post"
                onClick={() => setModerating(true)}
                testId="social-moderator-remove"
                tone="delete"
              >
                <ShieldX aria-hidden />
              </ActionButton>
            ) : null}
            {!isMine && me !== null && ban.allowed ? (
              <ActionButton
                label={`Ban ${name}`}
                onClick={ban.start}
                testId="social-ban"
                tone="report"
              >
                <Ban aria-hidden />
              </ActionButton>
            ) : null}
            {isMine ? (
              <ActionButton
                label="Delete post"
                onClick={() => setConfirmDelete(true)}
                testId="social-delete"
                tone="delete"
              >
                <Trash2 aria-hidden />
              </ActionButton>
            ) : null}
          </div>
        </div>
      </div>
      {reporting ? (
        <ReportDialog
          onClose={() => setReporting(false)}
          target={{
            kind: "message",
            eventId: note.id,
            authorPubkey: note.pubkey,
          }}
          what="this post"
        />
      ) : null}
      {ban.dialog}
      {moderating ? (
        <ReasonDialog
          confirmLabel="Remove"
          description={`This post by ${name} will be removed from Home for everyone, and any reports about it closed. ${name} is told, with your reason.`}
          destructive
          onClose={() => setModerating(false)}
          onConfirm={moderatorRemove}
          testId="social-moderator-remove-dialog"
          title="Remove this post?"
        />
      ) : null}
      <ConfirmDialog
        confirmLabel="Delete"
        description="This removes your post for everyone. Reposts and quotes that already copied it may still show it elsewhere."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
        open={confirmDelete}
        title="Delete this post?"
      />
      <QuoteDialog
        note={note}
        onClose={() => setQuoting(false)}
        open={quoting}
      />
    </article>
  );
}
