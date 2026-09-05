import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Hash,
  MessageSquare,
  Pencil,
  Reply,
  Smile,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { Channel } from "../use-channels";
import {
  useChannelMessages,
  type ChannelMessages,
} from "../use-channel-messages";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  profileDisplayName,
  useProfiles,
  type Profile,
} from "@/features/profiles/use-profiles";
import { Composer, type EditTarget } from "./Composer";

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉"];

/** kind:7 events grouped by the event they react to. */
function useReactionGroups(
  messages: ChannelMessages,
): Map<string, NostrEvent[]> {
  return useMemo(() => {
    const groups = new Map<string, NostrEvent[]>();
    for (const event of messages.byId.values()) {
      if (event.kind !== 7) continue;
      const target = getTag(event, "e");
      if (!target) continue;
      const list = groups.get(target) ?? [];
      list.push(event);
      groups.set(target, list);
    }
    return groups;
  }, [messages]);
}

/** Latest kind:40003 edit content per target (author-matched), and the set of
 * targets deleted via kind:5. */
function useMessageOverlays(messages: ChannelMessages): {
  edits: Map<string, string>;
  deleted: Set<string>;
} {
  return useMemo(() => {
    const edits = new Map<string, string>();
    const deleted = new Set<string>();
    for (const event of messages.byId.values()) {
      if (event.kind === 40003) {
        const target = getTag(event, "e");
        const original = target ? messages.byId.get(target) : undefined;
        if (target && original && event.pubkey === original.pubkey) {
          const previous = edits.get(target);
          if (!previous || event.created_at > 0) {
            edits.set(
              target,
              typeof event.content === "string" ? event.content : "",
            );
          }
        }
      } else if (event.kind === 5) {
        const target = getTag(event, "e");
        const original = target ? messages.byId.get(target) : undefined;
        if (target && original && event.pubkey === original.pubkey) {
          deleted.add(target);
        }
      }
    }
    return { edits, deleted };
  }, [messages]);
}

function ReactionPills({ events }: { events: NostrEvent[] }) {
  const byEmoji = new Map<string, number>();
  for (const event of events) {
    byEmoji.set(event.content, (byEmoji.get(event.content) ?? 0) + 1);
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {[...byEmoji.entries()].map(([emoji, count]) => (
        <span
          key={emoji}
          className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white px-1.5 py-0.5 text-xs dark:border-white/10 dark:bg-white/5"
        >
          {emoji} {count}
        </span>
      ))}
    </div>
  );
}

function MessageRow({
  event,
  isReply,
  reactions,
  onReply,
  onEdit,
  onDelete,
  ownPubkey,
  overlayContent,
  isDeleted,
  profile,
}: {
  event: NostrEvent;
  isReply?: boolean;
  reactions: NostrEvent[];
  onReply?: (eventId: string) => void;
  onEdit?: (event: NostrEvent) => void;
  onDelete?: (eventId: string) => void;
  ownPubkey: string;
  overlayContent?: string;
  isDeleted?: boolean;
  profile?: Profile;
}) {
  const isOwn = event.pubkey === ownPubkey;
  const content = isDeleted
    ? ""
    : (overlayContent ??
      (typeof event.content === "string" ? event.content.slice(0, 4000) : ""));

  const react = async (emoji: string) => {
    try {
      const signed = await signAsUser({
        kind: 7,
        tags: [
          ["e", event.id],
          ["p", event.pubkey],
        ],
        content: emoji,
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "relay rejected the reaction");
      }
    } catch (error) {
      console.error("[react]", error);
      toast.error("Couldn't add reaction", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div
      className={`group flex gap-3 py-2 ${isReply ? "ml-8" : ""}`}
      data-testid="message-row"
    >
      {profile?.picture ? (
        <img
          alt=""
          src={profile.picture}
          className="h-8 w-8 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10 text-xs font-semibold text-black/60 dark:bg-white/10 dark:text-white/70">
          {truncatePubkey(event.pubkey).slice(0, 2)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-black/70 dark:text-white/70">
            {profileDisplayName(profile, event.pubkey)}
          </span>
          <time className="text-xs text-black/40 dark:text-white/40">
            {relativeTime(event.created_at * 1000)}
          </time>
          <span className="ml-auto flex items-center gap-2 text-xs text-black/40 opacity-0 transition-opacity group-hover:opacity-100 dark:text-white/40">
            {onReply && !isDeleted && (
              <button
                type="button"
                onClick={() => onReply(event.id)}
                className="flex items-center gap-1 hover:text-black/70 dark:hover:text-white/70"
                aria-label="Reply"
                data-testid="reply-button"
              >
                <Reply className="h-3 w-3" /> Reply
              </button>
            )}
            {isOwn && onEdit && !isDeleted && (
              <button
                type="button"
                onClick={() => onEdit(event)}
                className="flex items-center gap-1 hover:text-black/70 dark:hover:text-white/70"
                aria-label="Edit message"
                data-testid="edit-button"
              >
                <Pencil className="h-3 w-3" /> Edit
              </button>
            )}
            {isOwn && onDelete && (
              <button
                type="button"
                onClick={() => onDelete(event.id)}
                className="flex items-center gap-1 hover:text-red-500"
                aria-label="Delete message"
                data-testid="delete-button"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            )}
          </span>
        </div>
        {isDeleted ? (
          <p className="mt-0.5 text-sm italic text-black/40 dark:text-white/40">
            message deleted
          </p>
        ) : (
          <div className="mt-0.5 break-words text-[0.9375rem] leading-relaxed text-black dark:text-white [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:dark:bg-white/10">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {reactions.length > 0 && <ReactionPills events={reactions} />}
        <div className="mt-1 flex items-center gap-2 text-xs text-black/45 opacity-0 transition-opacity group-hover:opacity-100 dark:text-white/45">
          <Smile className="h-3.5 w-3.5" />
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => void react(emoji)}
              className="hover:scale-125"
              data-testid={`quick-react-${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadTree({
  event,
  messages,
  reactionsByTarget,
  onReply,
  onEdit,
  onDelete,
  depth,
  profile,
  ownPubkey,
  overlays,
}: {
  event: NostrEvent;
  messages: ChannelMessages;
  reactionsByTarget: Map<string, NostrEvent[]>;
  onReply: (eventId: string) => void;
  onEdit?: (event: NostrEvent) => void;
  onDelete?: (eventId: string) => void;
  depth: number;
  profile?: Profile;
  ownPubkey: string;
  overlays: { edits: Map<string, string>; deleted: Set<string> };
}) {
  const children = messages.ordered.filter((e) => getTag(e, "e") === event.id);
  return (
    <div>
      <MessageRow
        event={event}
        isReply={depth > 0}
        reactions={reactionsByTarget.get(event.id) ?? []}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        ownPubkey={ownPubkey}
        overlayContent={overlays.edits.get(event.id)}
        isDeleted={overlays.deleted.has(event.id)}
        profile={profile}
      />
      {children.map((child) => (
        <ThreadTree
          key={child.id}
          event={child}
          messages={messages}
          reactionsByTarget={reactionsByTarget}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          depth={depth + 1}
          profile={profile}
          ownPubkey={ownPubkey}
          overlays={overlays}
        />
      ))}
    </div>
  );
}

export function ChannelTimeline({ channel }: { channel: Channel }) {
  const messages = useChannelMessages(channel.id);
  const reactionsByTarget = useReactionGroups(messages);
  const overlays = useMessageOverlays(messages);
  const authors = useMemo(
    () => [...new Set(messages.ordered.map((e) => e.pubkey))],
    [messages.ordered],
  );
  const { data: profiles } = useProfiles(authors);
  const profileByPubkey = useMemo(
    () => new Map((profiles ?? []).map((p, i) => [authors[i], p])),
    [profiles, authors],
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const ownPubkey = userPubkey();

  const startEdit = (event: NostrEvent) => {
    setReplyTo(null);
    setEditTarget({
      eventId: event.id,
      content:
        overlays.edits.get(event.id) ??
        (typeof event.content === "string" ? event.content : ""),
    });
  };

  const deleteMessage = async (eventId: string) => {
    if (!window.confirm("Delete this message?")) return;
    try {
      const signed = await signAsUser({
        kind: 5,
        tags: [
          ["h", channel.id],
          ["e", eventId],
        ],
        content: "",
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "relay rejected the deletion");
      }
    } catch (error) {
      console.error("[delete]", error);
      toast.error("Couldn't delete message", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Message count is an intentional scroll trigger: new live messages pull
  // the viewport to the bottom when the user hasn't scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: count is read by design
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.ordered.length, autoScroll]);

  const roots = messages.ordered.filter((e) => !getTag(e, "e"));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <Hash className="h-4 w-4 text-black/50 dark:text-white/50" />
        <h2 className="text-sm font-semibold text-black dark:text-white">
          {channel.name}
        </h2>
        {channel.description && (
          <span className="truncate text-xs text-black/45 dark:text-white/45">
            — {channel.description}
          </span>
        )}
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
        }}
      >
        {messages.isLoading ? (
          <div className="space-y-4 py-4">
            {["a", "b", "c", "d"].map((key) => (
              <div
                key={key}
                className="h-12 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
              />
            ))}
          </div>
        ) : roots.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <MessageSquare className="h-7 w-7 text-black/30 dark:text-white/30" />
            <p className="mt-2 text-sm text-black/50 dark:text-white/50">
              No messages yet in {channel.name}.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-black/5 dark:divide-white/5">
            {roots.map((root) => (
              <ThreadTree
                key={root.id}
                event={root}
                messages={messages}
                reactionsByTarget={reactionsByTarget}
                onReply={(id) => setReplyTo(id)}
                onEdit={(event) => startEdit(event)}
                onDelete={(id) => {
                  void deleteMessage(id);
                }}
                depth={0}
                profile={profileByPubkey.get(root.pubkey)}
                ownPubkey={ownPubkey}
                overlays={overlays}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        channelId={channel.id}
        replyTo={replyTo}
        editTarget={editTarget}
        onPosted={() => {
          setReplyTo(null);
          setEditTarget(null);
          setAutoScroll(true);
        }}
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditTarget(null)}
      />
    </div>
  );
}
