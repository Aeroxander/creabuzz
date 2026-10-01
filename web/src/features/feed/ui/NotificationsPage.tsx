import { Link } from "@tanstack/react-router";
import { Heart, MessageCircle, Repeat2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import type { NotificationGroup } from "../notifications";
import { groupNotifications } from "../notifications";
import { useNotificationBadge, useNotifications } from "../use-discover";
import { usePostsByIds, useProfiles, useViewerPubkey } from "../use-feed";
import { Avatar, displayNameOf } from "./Avatar";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { PostRow } from "./PostRow";
import { TimelineSkeleton } from "./Timeline";
import { TabBar } from "./TabBar";

type Tab = "all" | "mentions";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions" },
];

const ICON = {
  like: { Icon: Heart, className: "fill-rose-500 text-rose-500" },
  repost: { Icon: Repeat2, className: "text-emerald-500" },
  follow: { Icon: UserPlus, className: "text-sky-500" },
  reply: { Icon: MessageCircle, className: "text-sky-500" },
  mention: { Icon: MessageCircle, className: "text-sky-500" },
} as const;

const VERB = {
  like: "liked your post",
  repost: "reposted your post",
  follow: "followed you",
  reply: "replied to you",
  mention: "mentioned you",
} as const;

function ActorSummary({
  actors,
  profiles,
}: {
  actors: string[];
  profiles?: Map<string, import("../feed-model").Profile>;
}) {
  const first = actors[0];
  const name = displayNameOf(first, profiles?.get(first));
  const others = actors.length - 1;
  return (
    <>
      <Link
        to="/p/$id"
        params={{ id: first }}
        className="relative z-10 font-bold hover:underline"
      >
        {name}
      </Link>
      {others > 0 && ` and ${others} ${others === 1 ? "other" : "others"}`}
    </>
  );
}

function ReactionRow({
  group,
  unread,
  profiles,
  targetText,
}: {
  group: NotificationGroup;
  unread: boolean;
  profiles?: Map<string, import("../feed-model").Profile>;
  targetText?: string;
}) {
  const { Icon, className } = ICON[group.kind];
  const href = group.targetId
    ? { to: "/feed/$noteId" as const, params: { noteId: group.targetId } }
    : { to: "/p/$id" as const, params: { id: group.actors[0] } };
  return (
    <div
      className={cn(
        "relative flex gap-3 border-b px-4 py-3 transition-colors hover:bg-foreground/[0.03]",
        unread && "bg-primary/5",
      )}
    >
      <Icon className={cn("mt-1 h-7 w-7 shrink-0", className)} />
      <div className="min-w-0 flex-1 text-[15px] leading-5">
        <div className="flex gap-1.5">
          {group.actors.slice(0, 5).map((a) => (
            <Avatar
              key={a}
              pubkey={a}
              profile={profiles?.get(a)}
              className="h-8 w-8"
            />
          ))}
        </div>
        <p className="mt-2">
          <ActorSummary actors={group.actors} profiles={profiles} />{" "}
          {VERB[group.kind]}
          <span className="text-muted-foreground">
            {" "}
            · {shortRelativeTime(group.at)}
          </span>
        </p>
        {targetText && (
          <p className="mt-1 line-clamp-2 text-muted-foreground">
            {targetText}
          </p>
        )}
      </div>
      <Link
        {...href}
        aria-label={`Open: ${VERB[group.kind]}`}
        className="absolute inset-0"
      />
    </div>
  );
}

export function NotificationsPage() {
  const viewer = useViewerPubkey();
  const notifications = useNotifications(viewer);
  const { seenAt, markSeen } = useNotificationBadge(viewer);
  const [tab, setTab] = useState<Tab>("all");

  // Keep the pre-visit "seen" time so unread rows stay highlighted for this visit.
  const visitSeenAt = useRef<number | null>(null);
  if (visitSeenAt.current === null && notifications.data) {
    visitSeenAt.current = seenAt;
  }
  useEffect(() => {
    if (notifications.data) markSeen();
  }, [notifications.data, markSeen]);

  const groups = groupNotifications(
    (notifications.data ?? []).filter(
      (n) => tab === "all" || n.kind === "reply" || n.kind === "mention",
    ),
  );
  const reactionGroups = groups.filter((g) => g.noteId === null);
  const noteGroups = groups.filter((g) => g.noteId !== null);

  const targets = usePostsByIds([
    ...new Set(reactionGroups.flatMap((g) => (g.targetId ? [g.targetId] : []))),
  ]).data;
  const notePosts = usePostsByIds(
    noteGroups.flatMap((g) => (g.noteId ? [g.noteId] : [])),
  ).data;
  const profiles = useProfiles(groups.flatMap((g) => g.actors)).data;

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <h1 className="px-4 pt-3 text-xl font-bold">Notifications</h1>
        <TabBar tabs={TABS} value={tab} onChange={setTab} />
      </div>
      {!viewer ? (
        <Message
          title="Sign in to see notifications"
          body="Likes, reposts, replies and follows show up here."
        />
      ) : notifications.isLoading ? (
        <TimelineSkeleton />
      ) : notifications.isError ? (
        <Message
          title="Something went wrong"
          body={notifications.error.message}
        />
      ) : groups.length === 0 ? (
        <Message
          title={tab === "all" ? "Nothing yet" : "No mentions yet"}
          body="When someone interacts with you, you’ll see it here."
        />
      ) : (
        groups.map((group) =>
          group.noteId === null ? (
            <ReactionRow
              key={group.key}
              group={group}
              unread={group.at > (visitSeenAt.current ?? 0)}
              profiles={profiles}
              targetText={
                group.targetId
                  ? targets?.find((t) => t.event.id === group.targetId)?.event
                      .content
                  : undefined
              }
            />
          ) : (
            <NotePost
              key={group.key}
              noteId={group.noteId}
              viewer={viewer}
              posts={notePosts}
            />
          ),
        )
      )}
    </FeedShell>
  );
}

function NotePost({
  noteId,
  viewer,
  posts,
}: {
  noteId: string;
  viewer: string | null;
  posts?: import("../feed-model").Post[];
}) {
  const post = posts?.find((p) => p.event.id === noteId);
  const profile = useProfiles(post ? [post.event.pubkey] : []).data?.get(
    post?.event.pubkey ?? "",
  );
  if (!post) return null;
  return <PostRow post={post} profile={profile} viewer={viewer} />;
}
