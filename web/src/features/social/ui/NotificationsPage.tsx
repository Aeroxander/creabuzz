import { Link } from "@tanstack/react-router";
import { Heart, MessageCircle, Quote, Repeat2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import { resolveUserName } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import {
  groupNotifications,
  type NotificationGroup,
  type NotificationKind,
} from "../lib/notifications";
import { useNotificationBadge, useNotifications } from "../use-discovery";
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
  { Icon: typeof Heart; className: string }
> = {
  like: { Icon: Heart, className: "fill-rose-500 text-rose-500" },
  repost: { Icon: Repeat2, className: "text-emerald-600" },
  quote: { Icon: Quote, className: "text-sky-600" },
  follow: { Icon: UserPlus, className: "text-sky-600" },
  reply: { Icon: MessageCircle, className: "text-sky-600" },
  mention: { Icon: MessageCircle, className: "text-sky-600" },
};

const VERB: Record<NotificationKind, string> = {
  like: "liked your post",
  repost: "reposted your post",
  quote: "quoted your post",
  follow: "followed you",
  reply: "replied to you",
  mention: "mentioned you",
};

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
      {group.targetId ? (
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

/** Likes, reposts, quotes, replies, mentions and new followers. */
export function NotificationsPage() {
  const me = existingUserPubkey();
  const notifications = useNotifications();
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
        n.kind === "mention" ||
        n.kind === "quote",
    ),
  );
  const reactions = groups.filter(
    (g) => g.kind === "like" || g.kind === "repost" || g.kind === "follow",
  );
  const posts = groups.filter((g) => g.noteId !== null);

  const targets = useNotesById([
    ...new Set(reactions.flatMap((g) => (g.targetId ? [g.targetId] : []))),
  ]).data;
  const postRows = useNotesById(
    posts.flatMap((g) => (g.noteId ? [g.noteId] : [])),
  ).data;
  const people = usePeople(groups.flatMap((g) => g.actors));

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
      {!me ? (
        <EmptyState title="Sign in to see notifications">
          Likes, reposts, replies and new followers show up here.
        </EmptyState>
      ) : notifications.isLoading ? (
        <TimelineSkeleton />
      ) : groups.length === 0 ? (
        <EmptyState
          testId="social-notifications-empty"
          title={tab === "all" ? "Nothing yet" : "No mentions yet"}
        >
          When someone interacts with you, you'll see it here.
        </EmptyState>
      ) : (
        groups.map((group) =>
          group.noteId === null ? (
            <ReactionRow
              group={group}
              key={group.key}
              people={people}
              targetText={
                group.targetId
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
