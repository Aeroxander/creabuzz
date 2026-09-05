import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Hash, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Channel } from "../use-channels";
import {
  useChannelMessages,
  type ChannelMessages,
} from "../use-channel-messages";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { relativeTime } from "@/shared/lib/relative-time";

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function MessageRow({
  event,
  isReply,
}: {
  event: NostrEvent;
  isReply?: boolean;
}) {
  const content =
    typeof event.content === "string" ? event.content.slice(0, 4000) : "";
  return (
    <div
      className={`flex gap-3 py-2 ${isReply ? "ml-8" : ""}`}
      data-testid="message-row"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10 text-xs font-semibold text-black/60 dark:bg-white/10 dark:text-white/70">
        {event.pubkey.slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-black/70 dark:text-white/70">
            {event.pubkey.slice(0, 8)}
          </span>
          <time className="text-xs text-black/40 dark:text-white/40">
            {relativeTime(event.created_at * 1000)}
          </time>
        </div>
        <div className="mt-0.5 break-words text-[0.9375rem] leading-relaxed text-black dark:text-white [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:dark:bg-white/10">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function Thread({
  rootId,
  messages,
}: {
  rootId: string;
  messages: ChannelMessages;
}) {
  const root = messages.byId.get(rootId);
  if (!root) return null;
  const replies = messages.ordered.filter((e) => getTag(e, "e") === rootId);
  return (
    <div>
      <MessageRow event={root} />
      {replies.map((reply) => (
        <MessageRow key={reply.id} event={reply} isReply />
      ))}
    </div>
  );
}

export function ChannelTimeline({ channel }: { channel: Channel }) {
  const messages = useChannelMessages(channel.id);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

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
              <Thread key={root.id} rootId={root.id} messages={messages} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
