/**
 * One post of the room, or one answer under it: who and when, the words, and three presses named with the author (Like, Reply
 * to, More actions for) so a screen reader hears whose post each belongs to. Those who may not write see the counts and the
 * More press only: the server would refuse the others, so they are not offered.
 */
import { Heart, MessageCircle } from "lucide-react";
import { useRef, useState } from "react";
import { nameOf, type ProfileMetadata } from "../../lib/profiles";
import { cn } from "../../ui/cn";
import { useToast } from "../../ui/toast";
import { Byline, PostText } from "../posts/PostCard";
import type { Engagement, SignedEvent } from "../posts/use-posts";
import { type MenuChoice, PostMenu } from "./PostMenu";
import { RoomComposer } from "./RoomComposer";
import { LIKE_FAILED, roomRefusal } from "./room-words";

/** What the viewer's tools in this room are, worked out once for the whole room. */
export interface RoomTools {
  me: string | null;
  founder: string;
  team: ReadonlySet<string>;
  /** People the team has stopped from writing now. */
  stopped: ReadonlySet<string>;
}

export function RoomPostCard({
  event,
  engagement,
  root,
  profiles,
  canWrite,
  tools,
  onLike,
  onReply,
  onChoose,
  nested = false,
  children,
}: {
  event: SignedEvent;
  engagement: Engagement;
  /** The post this one hangs under (itself for a post). */
  root: SignedEvent;
  profiles: Record<string, ProfileMetadata> | undefined;
  canWrite: boolean;
  tools: RoomTools;
  onLike: (event: SignedEvent) => Promise<unknown>;
  onReply: (
    text: string,
    root: SignedEvent,
    parent: SignedEvent,
  ) => Promise<unknown>;
  onChoose: (choice: MenuChoice, event: SignedEvent) => void;
  nested?: boolean;
  children?: React.ReactNode;
}) {
  const name = nameOf(profiles, event.pubkey);
  const [replying, setReplying] = useState(false);
  const toast = useToast();
  // A like on its way: a second press waits for it (each like counts toward the room's hourly limit).
  const liking = useRef(false);
  const liked = engagement.myVote === "+";
  const { me, founder, team } = tools;
  const mine = me === event.pubkey;
  const viewerIsTeam = me !== null && team.has(me);
  const authorIsTeam = team.has(event.pubkey);
  // The founder removes any post but their own; a team member removes only the posts of people who are not on the team.
  const teamCanRemove =
    viewerIsTeam &&
    event.pubkey !== founder &&
    (me === founder || !authorIsTeam);
  const teamCanStop = viewerIsTeam && event.pubkey !== founder && !mine;
  return (
    <article
      className={cn(
        "flex flex-col gap-2.5",
        nested ? "border-l border-white/15 pl-3" : "plain rounded-2xl p-4",
      )}
      data-testid={nested ? "room-reply" : "room-post"}
    >
      <Byline at={event.created_at} profiles={profiles} pubkey={event.pubkey} />
      <PostText text={event.content} />
      <div className="flex items-center gap-1 text-sm text-muted">
        {canWrite ? (
          <button
            aria-pressed={liked}
            className={cn(
              "btn btn-ghost btn-sm",
              liked ? "text-mint-ink" : "text-muted",
            )}
            data-testid="room-like"
            // A like is kept once given; pressing it again changes nothing.
            onClick={() => {
              if (liked || liking.current) return;
              liking.current = true;
              onLike(event)
                .catch((error: unknown) =>
                  toast(
                    roomRefusal(
                      error instanceof Error ? error.message : String(error),
                      LIKE_FAILED,
                    ).words,
                    "problem",
                  ),
                )
                .finally(() => {
                  liking.current = false;
                });
            }}
            type="button"
          >
            <Heart
              aria-hidden="true"
              fill={liked ? "currentColor" : "none"}
              size={18}
            />
            <span className="sr-only">{`Like ${name}'s post, ${engagement.ups}`}</span>
            <span aria-hidden="true" className="num">
              {engagement.ups}
            </span>
          </button>
        ) : (
          <span className="inline-flex min-h-10 items-center gap-1.5 px-2">
            <Heart aria-hidden="true" size={18} />
            <span className="sr-only">{`Likes on ${name}'s post: ${engagement.ups}`}</span>
            <span aria-hidden="true" className="num">
              {engagement.ups}
            </span>
          </span>
        )}
        {canWrite ? (
          <button
            aria-expanded={replying}
            className="btn btn-ghost btn-sm text-muted"
            data-testid="room-reply-press"
            onClick={() => setReplying((v) => !v)}
            type="button"
          >
            <MessageCircle aria-hidden="true" size={18} />
            <span className="sr-only">{`Reply to ${name}, ${engagement.replies}`}</span>
            <span aria-hidden="true" className="num">
              {engagement.replies}
            </span>
          </button>
        ) : (
          <span className="inline-flex min-h-10 items-center gap-1.5 px-2">
            <MessageCircle aria-hidden="true" size={18} />
            <span className="sr-only">{`Replies to ${name}'s post: ${engagement.replies}`}</span>
            <span aria-hidden="true" className="num">
              {engagement.replies}
            </span>
          </span>
        )}
        <PostMenu
          mine={mine}
          name={name}
          onChoose={(choice) => onChoose(choice, event)}
          stopped={tools.stopped.has(event.pubkey)}
          teamCanRemove={teamCanRemove}
          teamCanStop={teamCanStop}
        />
      </div>
      {replying ? (
        <RoomComposer
          autoFocus
          draftKey={`reply:${me ?? ""}:${event.id}`}
          label={`Reply to ${name}`}
          lines={false}
          onCancel={() => setReplying(false)}
          onDone={() => setReplying(false)}
          send={(text) => onReply(text, root, event)}
          submit="Reply"
        />
      ) : null}
      {children}
    </article>
  );
}
