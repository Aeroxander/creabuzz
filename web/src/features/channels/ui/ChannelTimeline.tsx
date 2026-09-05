import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Hash, MessageSquare, Reply, Smile } from "lucide-react";
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
import { signAsUser } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Composer } from "./Composer";

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
}: {
  event: NostrEvent;
  isReply?: boolean;
  reactions: NostrEvent[];
  onReply?: (eventId: string) => void;
}) {
  const content =
    typeof event.content === "string" ? event.content.slice(0, 4000) : "";

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
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10 text-xs font-semibold text-black/60 dark:bg-white/10 dark:text-white/70">
        {truncatePubkey(event.pubkey).slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-black/70 dark:text-white/70">
            {truncatePubkey(event.pubkey)}
          </span>
          <time className="text-xs text-black/40 dark:text-white/40">
            {relativeTime(event.created_at * 1000)}
          </time>
          {onReply && (
            <button
              type="button"
              onClick={() => onReply(event.id)}
              className="ml-auto flex items-center gap-1 text-xs text-black/40 opacity-0 transition-opacity hover:text-black/70 group-hover:opacity-100 dark:text-white/40 dark:hover:text-white/70"
              aria-label="Reply"
              data-testid="reply-button"
            >
              <Reply className="h-3 w-3" /> Reply
            </button>
          )}
        </div>
        <div className="mt-0.5 break-words text-[0.9375rem] leading-relaxed text-black dark:text-white [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:dark:bg-white/10">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
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
  depth,
}: {
  event: NostrEvent;
  messages: ChannelMessages;
  reactionsByTarget: Map<string, NostrEvent[]>;
  onReply: (eventId: string) => void;
  depth: number;
}) {
  const children = messages.ordered.filter((e) => getTag(e, "e") === event.id);
  return (
    <div>
      <MessageRow
        event={event}
        isReply={depth > 0}
        reactions={reactionsByTarget.get(event.id) ?? []}
        onReply={onReply}
      />
      {children.map((child) => (
        <ThreadTree
          key={child.id}
          event={child}
          messages={messages}
          reactionsByTarget={reactionsByTarget}
          onReply={onReply}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function ChannelTimeline({ channel }: { channel: Channel }) {
  const messages = useChannelMessages(channel.id);
  const reactionsByTarget = useReactionGroups(messages);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [replyTo, setReplyTo] = useState<string | null>(null);

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
                depth={0}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        channelId={channel.id}
        replyTo={replyTo}
        onPosted={() => {
          setReplyTo(null);
          setAutoScroll(true);
        }}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  );
}
