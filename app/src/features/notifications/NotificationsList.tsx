import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useEffect } from "react";
import { nameOf, pictureOf, useProfiles } from "../../lib/profiles";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { projectRefFromCoordinate } from "./coordinates";
import {
  type NotificationGroup,
  useMarkSeen,
  useNotifications,
} from "./use-notifications";

const WORDS: Partial<Record<NotificationGroup["kind"], string>> = {
  like: "liked your post",
  repost: "shared your post",
  quote: "quoted your post",
  reply: "replied to you",
  mention: "mentioned you",
  follow: "followed you",
};

interface Row {
  key: string;
  at: number;
  actors: string[];
  text: string;
  projectRef: string | null;
  postId: string | null;
}

function who(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "Someone";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** The person's notifications, newest first. Opening them marks them seen. */
export function NotificationsList() {
  const read = useNotifications();
  const markSeen = useMarkSeen();
  const data = read.data;
  const profiles = useProfiles([
    ...(data?.groups.flatMap((g) => g.actors.slice(0, 3)) ?? []),
    ...(data?.asks.map((a) => a.author) ?? []),
  ]).data;
  useEffect(() => {
    if (data) markSeen(data.newestAt);
  }, [data, markSeen]);

  if (read.isPending)
    return <Card className="h-24 animate-pulse" tone="plain" />;
  if (read.isError)
    return (
      <EmptyState
        action={
          <Button onClick={() => void read.refetch()} variant="secondary">
            Try again
          </Button>
        }
        title="Notifications could not be read"
      >
        {readFailureWords(read.error).text}
      </EmptyState>
    );
  const rows: Row[] = [
    ...(data?.asks ?? []).map((ask) => ({
      key: ask.id,
      at: ask.createdAt,
      actors: [ask.author],
      text: "asked to join your project",
      projectRef: projectRefFromCoordinate(ask.coordinate),
      postId: null,
    })),
    ...(data?.groups ?? []).flatMap((g) => {
      const text = WORDS[g.kind];
      return text
        ? [
            {
              key: g.key,
              at: g.at,
              actors: g.actors,
              text,
              projectRef: null,
              postId: g.noteId ?? g.targetId,
            },
          ]
        : [];
    }),
  ].sort((a, b) => b.at - a.at);
  if (rows.length === 0)
    return (
      <EmptyState
        icon={<Bell size={28} />}
        testId="notifications-empty"
        title="Nothing new"
      >
        Replies, likes, follows and asks to join your projects show here.
      </EmptyState>
    );
  return (
    <ul className="flex flex-col gap-2" data-testid="notifications">
      {rows.map((row) => {
        const names = row.actors.map((p) => nameOf(profiles, p));
        const body = (
          <>
            <Avatar
              name={names[0]}
              picture={pictureOf(profiles, row.actors[0])}
              pubkey={row.actors[0]}
              size="sm"
            />
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">{who(names)}</span> {row.text}
            </span>
            <span className="shrink-0 text-xs text-muted">
              {relativeTime(row.at)}
            </span>
          </>
        );
        const className =
          "plain flex items-center gap-3 rounded-xl px-3 py-3 hover:brightness-110";
        return (
          <li data-testid="notification" key={row.key}>
            {row.projectRef ? (
              <Link
                className={className}
                params={{ ref: row.projectRef }}
                to="/p/$ref"
              >
                {body}
              </Link>
            ) : row.postId ? (
              <Link
                className={className}
                params={{ id: row.postId }}
                to="/post/$id"
              >
                {body}
              </Link>
            ) : (
              <div className={className}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
