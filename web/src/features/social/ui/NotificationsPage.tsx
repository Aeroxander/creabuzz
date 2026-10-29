import { YourLaunchesSection } from "@/features/launchpad/ui/YourLaunchesSection";
import { Link } from "@tanstack/react-router";
import {
  ArrowBigUp,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Quote,
  Repeat2,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import { resolveUserName } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import {
  KIND_CONTACT_LIST,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import {
  groupNotifications,
  type NotificationGroup,
  type NotificationKind,
} from "../lib/notifications";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
} from "../../board/lib/board-events";
import { KIND_BOARD_MODERATION_LOG } from "../lib/moderation-notices";
import { notificationsView } from "../lib/notifications-state";
import { launchCoordinate } from "../../feed/lib/feed-events";
import { useLaunches } from "../../launchpad/use-launches";
import { useNotificationBadge, useNotifications } from "../use-discovery";
import {
  useMutedLaunchUpdates,
  usePriorityNotifications,
} from "../use-launch-updates";
import { usePeople } from "../use-people";
import { useNotesById } from "../use-social-data";
import { PostList } from "./PostList";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";
import { TabStrip } from "./TabStrip";

type Tab = "all" | "mentions";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions" },
];

const ICON: Record<
  NotificationKind,
  { Icon: typeof ArrowBigUp; className: string }
> = {
  like: { Icon: ArrowBigUp, className: "fill-orange-500 text-orange-500" },
  "board-upvote": {
    Icon: ArrowBigUp,
    className: "fill-orange-500 text-orange-500",
  },
  "board-reply": { Icon: MessagesSquare, className: "text-sky-600" },
  repost: { Icon: Repeat2, className: "text-emerald-600" },
  quote: { Icon: Quote, className: "text-sky-600" },
  follow: { Icon: UserPlus, className: "text-sky-600" },
  reply: { Icon: MessageCircle, className: "text-sky-600" },
  mention: { Icon: MessageCircle, className: "text-sky-600" },
  moderation: { Icon: ShieldAlert, className: "text-amber-600" },
};

const VERB: Record<NotificationKind, string> = {
  like: "upvoted your post",
  "board-upvote": "upvoted your board post",
  "board-reply": "replied on a board",
  repost: "reposted your post",
  quote: "quoted your post",
  follow: "followed you",
  reply: "replied to you",
  mention: "mentioned you",
  moderation: "a moderator's notice about you",
};

/** The kinds the notifications read asks for, named when the server refuses them. */
const NOTIFICATION_KINDS = [
  KIND_TEXT_NOTE,
  KIND_REPOST,
  KIND_REACTION,
  KIND_CONTACT_LIST,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
  KIND_FORUM_VOTE,
  KIND_BOARD_MODERATION_LOG,
];

/**
 * A moderator's notice about you: what happened and why, opening the board (and for a removed reply, the conversation
 * it was in); a removed Home reply opens its Home conversation. Never grouped and never hidden by a mute.
 */
function ModerationRow({
  group,
  unread,
}: {
  group: NotificationGroup;
  unread: boolean;
}) {
  const notice = group.notice;
  if (!notice) return null;
  const { Icon, className } = ICON.moderation;
  return (
    <div
      className={cn(
        "relative flex gap-3 border-b border-black/10 px-4 py-3 transition-colors hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.03]",
        unread && "bg-sky-500/5",
      )}
      data-testid="social-notification"
      data-kind="moderation"
    >
      <Icon aria-hidden className={cn("mt-1 h-6 w-6 shrink-0", className)} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-bold text-black dark:text-white">
          {notice.title}
          <span className="font-normal text-black/60 dark:text-white/60">
            {" "}
            · {shortRelativeTime(group.at)}
          </span>
        </p>
        <p
          className="mt-1 text-black/60 dark:text-white/60"
          data-testid="social-notification-reason"
        >
          {notice.preview}
        </p>
      </div>
      {notice.boardId ? (
        <Link
          aria-label={`Open the board: ${notice.title}`}
          className="absolute inset-0"
          params={{ boardId: notice.boardId }}
          search={{ post: notice.threadId ?? undefined }}
          to="/b/$boardId"
        />
      ) : notice.threadId ? (
        <Link
          aria-label={`Open the conversation: ${notice.title}`}
          className="absolute inset-0"
          params={{ id: notice.threadId }}
          to="/social/post/$id"
        />
      ) : null}
    </div>
  );
}

function ReactionRow({
  group,
  unread,
  people,
  targetText,
}: {
  group: NotificationGroup;
  unread: boolean;
  people: Record<string, ProfileMetadata>;
  targetText?: string;
}) {
  const { Icon, className } = ICON[group.kind];
  const first = group.actors[0];
  const others = group.actors.length - 1;
  return (
    <div
      className={cn(
        "relative flex gap-3 border-b border-black/10 px-4 py-3 transition-colors hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.03]",
        unread && "bg-sky-500/5",
      )}
      data-testid="social-notification"
      data-kind={group.kind}
    >
      <Icon aria-hidden className={cn("mt-1 h-6 w-6 shrink-0", className)} />
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex gap-1.5">
          {group.actors.slice(0, 5).map((pubkey) => (
            <UserAvatar
              avatarUrl={people[pubkey]?.picture ?? null}
              displayName={resolveUserName(people[pubkey], pubkey)}
              key={pubkey}
              size="sm"
            />
          ))}
        </div>
        <p className="mt-2 text-black dark:text-white">
          <Link
            className="relative z-10 font-bold hover:underline"
            params={{ pubkey: first }}
            to="/u/$pubkey"
          >
            {resolveUserName(people[first], first)}
          </Link>
          {others > 0
            ? ` and ${others} ${others === 1 ? "other" : "others"}`
            : ""}{" "}
          {VERB[group.kind]}
          <span className="text-black/60 dark:text-white/60">
            {" "}
            · {shortRelativeTime(group.at)}
          </span>
        </p>
        {targetText ? (
          <p className="mt-1 line-clamp-2 text-black/60 dark:text-white/60">
            {targetText}
          </p>
        ) : null}
      </div>
      {group.board ? (
        <Link
          aria-label={`Open: ${VERB[group.kind]}`}
          className="absolute inset-0"
          params={{ boardId: group.board.boardId }}
          search={{ post: group.board.postId }}
          to="/b/$boardId"
        />
      ) : group.targetId ? (
        <Link
          aria-label={`Open: ${VERB[group.kind]}`}
          className="absolute inset-0"
          params={{ id: group.targetId }}
          to="/social/post/$id"
        />
      ) : (
        <Link
          aria-label={`Open ${resolveUserName(people[first], first)}'s profile`}
          className="absolute inset-0"
          params={{ pubkey: first }}
          to="/u/$pubkey"
        />
      )}
    </div>
  );
}

/**
 * Priority updates from launches you follow, above everything else. Each one
 * can be turned off for that launch without unfollowing it.
 */
function LaunchUpdatesSection({ visitSeenAt }: { visitSeenAt: number }) {
  const updates = usePriorityNotifications();
  const rows = useNotesById(updates.slice(0, 20).map((u) => u.id)).data;
  const launches = useLaunches().data;
  const { toggle } = useMutedLaunchUpdates();
  if (updates.length === 0 || !rows || rows.length === 0) return null;
  const nameOf = (coord: string) =>
    launches?.find(
      (l) =>
        launchCoordinate({ pubkey: l.record.author, id: l.record.id }) ===
        coord,
    )?.record.name ?? "this launch";
  return (
    <section
      aria-label="Launch updates"
      className="border-b border-primary/30 bg-primary/[0.04]"
      data-testid="social-launch-updates"
    >
      <h2 className="flex items-center gap-2 px-4 pt-3 text-sm font-bold text-primary-ink">
        <Megaphone aria-hidden className="h-4 w-4" /> Launch updates
      </h2>
      {updates.slice(0, 20).map((update) => {
        const row = rows.find((r) => r.event.id === update.id);
        if (!row) return null;
        return (
          <div
            data-testid="social-launch-update-item"
            data-unread={update.at > visitSeenAt ? "true" : undefined}
            key={update.id}
          >
            <PostList rows={[row]} />
            <div className="flex justify-end px-4 pb-2">
              <button
                className="text-xs text-muted-foreground underline hover:text-foreground"
                data-testid="social-launch-update-mute"
                onClick={() => toggle(update.coord)}
                type="button"
              >
                Turn off priority updates from {nameOf(update.coord)}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Up votes, reposts, quotes, replies, mentions, new followers, board replies and up votes, and moderators' notices. */
export function NotificationsPage() {
  const me = existingUserPubkey();
  const notifications = useNotifications();
  const hasLaunchUpdates = usePriorityNotifications().length > 0;
  const { seenAt, markSeen } = useNotificationBadge();
  const [tab, setTab] = useState<Tab>("all");

  // Keep the time you last looked, so unread rows stay marked for this visit.
  const visitSeenAt = useRef<number | null>(null);
  if (visitSeenAt.current === null && notifications.data) {
    visitSeenAt.current = seenAt;
  }
  useEffect(() => {
    if (notifications.data) markSeen();
  }, [notifications.data, markSeen]);

  const groups = groupNotifications(
    (notifications.data ?? []).filter(
      (n) =>
        tab === "all" ||
        n.kind === "reply" ||
        n.kind === "board-reply" ||
        n.kind === "mention" ||
        n.kind === "quote",
    ),
  );
  const reactions = groups.filter(
    (g) =>
      (g.kind === "like" || g.kind === "repost" || g.kind === "follow") &&
      !g.board,
  );
  const posts = groups.filter((g) => g.noteId !== null);

  const targets = useNotesById([
    ...new Set(reactions.flatMap((g) => (g.targetId ? [g.targetId] : []))),
  ]).data;
  const postRows = useNotesById(
    posts.flatMap((g) => (g.noteId ? [g.noteId] : [])),
  ).data;
  // A moderator's notice is signed by the server, not a person to show.
  const people = usePeople(
    groups.flatMap((g) => (g.kind === "moderation" ? [] : g.actors)),
  );
  const view = notificationsView(notifications);
  const retry = () => void notifications.refetch();

  return (
    <SocialShell>
      <PageBar title="Notifications">
        <TabStrip
          label="Notifications"
          onChange={setTab}
          tabs={TABS}
          value={tab}
        />
      </PageBar>
      {me && tab === "all" ? <YourLaunchesSection /> : null}
      {me && tab === "all" ? (
        <LaunchUpdatesSection visitSeenAt={visitSeenAt.current ?? 0} />
      ) : null}
      {me && notifications.error && notifications.data ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-black/10 bg-amber-500/10 px-4 py-2 text-sm text-black dark:border-white/10 dark:text-white"
          data-testid="social-notifications-stale"
          role="status"
        >
          <span>
            Couldn't check for new notifications. Showing what loaded before.
          </span>
          <button
            className="shrink-0 font-semibold underline"
            data-testid="social-notifications-stale-retry"
            onClick={retry}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      {!me ? (
        <EmptyState title="Sign in to see notifications">
          Votes, replies, reposts and new followers show up here.
        </EmptyState>
      ) : view === "loading" ? (
        <TimelineSkeleton />
      ) : view === "error" ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer, so your notifications can't be shown. Nothing was lost."
            error={notifications.error}
            kinds={NOTIFICATION_KINDS}
            onRetry={retry}
            relayUrl={relayWsUrl()}
            testId="social-notifications-error"
            title="Couldn't load your notifications"
          />
        </div>
      ) : groups.length === 0 &&
        tab === "all" &&
        hasLaunchUpdates ? null : groups.length === 0 ? (
        <EmptyState
          testId="social-notifications-empty"
          title={tab === "all" ? "Nothing yet" : "No mentions yet"}
        >
          When someone interacts with you, you'll see it here.
        </EmptyState>
      ) : (
        groups.map((group) =>
          group.kind === "moderation" ? (
            <ModerationRow
              group={group}
              key={group.key}
              unread={group.at > (visitSeenAt.current ?? 0)}
            />
          ) : group.noteId === null ? (
            <ReactionRow
              group={group}
              key={group.key}
              people={people}
              targetText={
                group.board
                  ? group.board.text
                  : group.targetId
                    ? targets?.find((t) => t.event.id === group.targetId)?.event
                        .content
                    : undefined
              }
              unread={group.at > (visitSeenAt.current ?? 0)}
            />
          ) : (
            <NoteNotification
              group={group}
              key={group.key}
              rows={postRows}
              unread={group.at > (visitSeenAt.current ?? 0)}
            />
          ),
        )
      )}
    </SocialShell>
  );
}

function NoteNotification({
  group,
  rows,
  unread,
}: {
  group: NotificationGroup;
  rows?: ReturnType<typeof useNotesById>["data"];
  unread: boolean;
}) {
  const row = rows?.find((r) => r.event.id === group.noteId);
  if (!row) return null;
  return (
    <div
      className={cn(unread && "bg-sky-500/5")}
      data-testid="social-notification"
      data-kind={group.kind}
    >
      <p className="px-4 pt-2 text-xs font-semibold text-black/60 dark:text-white/60">
        {VERB[group.kind]}
      </p>
      <PostList rows={[row]} />
    </div>
  );
}
