import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Copy,
  Hash,
  Link2,
  MessageSquare,
  Pencil,
  Reply,
  Smile,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { QueryError, errorMessage } from "@/shared/ui/query-error";

import type { Channel } from "../use-channels";
import {
  useChannelMessages,
  type ChannelMessages,
} from "../use-channel-messages";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import {
  profileDisplayName,
  useProfiles,
  type Profile,
} from "@/features/profiles/use-profiles";
import { Composer, type EditTarget } from "./Composer";
import { useAgentRoster } from "@/features/fleet/use-agent-roster";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { Bot } from "lucide-react";

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

/** Anchor id used by message permalinks. */
export function messageAnchor(eventId: string): string {
  return `message-${eventId}`;
}

/**
 * Permalink for a message.
 *
 * The web client addresses a thread by channel with `?channel=`; the message id
 * rides along so the target row can be scrolled to and highlighted.
 */
export function messagePermalink(eventId: string, channelId?: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  if (channelId) url.searchParams.set("channel", channelId);
  url.searchParams.set("message", eventId);
  return url.toString();
}

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(label);
  } catch (error) {
    toast.error("Couldn't copy", {
      description: error instanceof Error ? error.message : String(error),
    });
  }
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
  agent,
  highlighted,
  channelId,
}: {
  event: NostrEvent;
  isReply?: boolean;
  /** Channel the message belongs to; makes the permalink open this thread. */
  channelId: string;
  /** True when this row is the target of a permalink. */
  highlighted?: boolean;
  reactions: NostrEvent[];
  onReply?: (eventId: string) => void;
  onEdit?: (event: NostrEvent) => void;
  onDelete?: (eventId: string) => void;
  ownPubkey: string;
  overlayContent?: string;
  isDeleted?: boolean;
  profile?: Profile;
  agent?: { name: string };
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
      className={`group flex gap-3 py-2 transition-colors duration-500 ${isReply ? "ml-8" : ""} ${
        highlighted ? "bg-amber-300/20" : ""
      }`}
      data-highlighted={highlighted ? "true" : undefined}
      data-testid="message-row"
      id={messageAnchor(event.id)}
    >
      <div className="shrink-0">
        <UserAvatar
          avatarUrl={profile?.picture ?? null}
          displayName={agent?.name ?? profileDisplayName(profile, event.pubkey)}
          size="sm"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-black/70 dark:text-white/70">
            {agent?.name ?? profileDisplayName(profile, event.pubkey)}
          </span>
          {agent ? (
            <Bot className="h-3 w-3 self-center text-black/60 dark:text-white/60" />
          ) : null}
          <time
            className="text-xs text-black/60 dark:text-white/60"
            title={new Date(event.created_at * 1000).toLocaleString()}
          >
            {new Date(event.created_at * 1000).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          <span className="ml-auto flex items-center gap-2 text-xs text-black/60 opacity-0 transition-opacity group-hover:opacity-100 dark:text-white/60">
            {!isDeleted && (
              <>
                <button
                  type="button"
                  onClick={() => void copyText(event.content, "Message copied")}
                  className="flex items-center gap-1 hover:text-black/70 dark:hover:text-white/70"
                  aria-label="Copy message text"
                  data-testid="copy-message"
                >
                  <Copy className="h-3 w-3" /> Copy
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void copyText(
                      messagePermalink(event.id, channelId),
                      "Link copied",
                    )
                  }
                  className="flex items-center gap-1 hover:text-black/70 dark:hover:text-white/70"
                  aria-label="Copy link to message"
                  data-testid="copy-message-link"
                >
                  <Link2 className="h-3 w-3" /> Link
                </button>
              </>
            )}
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
          <p className="mt-0.5 text-sm italic text-black/60 dark:text-white/60">
            message deleted
          </p>
        ) : (
          <div className="mt-0.5 break-words text-message leading-relaxed text-black dark:text-white [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:dark:bg-white/10">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {reactions.length > 0 && <ReactionPills events={reactions} />}
        <div className="mt-1 flex items-center gap-2 text-xs text-black/60 opacity-0 transition-opacity group-hover:opacity-100 dark:text-white/60">
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
  profileByPubkey,
  agentByPubkey,
  ownPubkey,
  overlays,
  channelId,
  highlightedId,
}: {
  event: NostrEvent;
  messages: ChannelMessages;
  reactionsByTarget: Map<string, NostrEvent[]>;
  onReply: (eventId: string) => void;
  onEdit?: (event: NostrEvent) => void;
  onDelete?: (eventId: string) => void;
  depth: number;
  profileByPubkey: Map<string, Profile | undefined>;
  agentByPubkey: Map<string, { name: string }>;
  ownPubkey: string;
  overlays: { edits: Map<string, string>; deleted: Set<string> };
  channelId: string;
  highlightedId?: string | null;
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
        profile={profileByPubkey.get(event.pubkey)}
        agent={agentByPubkey.get(event.pubkey)}
        channelId={channelId}
        highlighted={event.id === highlightedId}
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
          profileByPubkey={profileByPubkey}
          agentByPubkey={agentByPubkey}
          ownPubkey={ownPubkey}
          overlays={overlays}
          channelId={channelId}
          highlightedId={highlightedId}
        />
      ))}
    </div>
  );
}

export function ChannelTimeline({
  channel,
  onShowFleet,
  onShowWork,
  highlightedId,
}: {
  channel: Channel;
  onShowFleet?: () => void;
  onShowWork?: () => void;
  /** Message id from a permalink: scrolled to and highlighted by the shell. */
  highlightedId?: string | null;
}) {
  const messages = useChannelMessages(channel.id);
  // Bring a permalinked message into view once it has rendered — the history
  // page may still be arriving, so re-run as the message set changes.
  useEffect(() => {
    if (!highlightedId) return;
    // Scroll only once the target row is actually in the loaded history.
    const loaded = messages.ordered.some((e) => e.id === highlightedId);
    if (!loaded) return;
    document
      .getElementById(messageAnchor(highlightedId))
      ?.scrollIntoView({ block: "center" });
  }, [highlightedId, messages]);
  const reactionsByTarget = useReactionGroups(messages);
  const overlays = useMessageOverlays(messages);
  const authors = useMemo(
    () => [...new Set(messages.ordered.map((e) => e.pubkey))],
    [messages.ordered],
  );
  const { data: profiles } = useProfiles(authors);
  const { agents: rosterAgents } = useAgentRoster();
  const agentsOnline = rosterAgents.filter((a) => a.alive).length;
  // Keyed by pubkey: an author without a profile must not shift the others.
  const profileByPubkey = useMemo(
    () => new Map(Object.entries(profiles ?? {})),
    [profiles],
  );
  const agentByPubkey = useMemo(
    () => new Map(rosterAgents.map((a) => [a.pubkey, { name: a.name }])),
    [rosterAgents],
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  /** Message awaiting delete confirmation; the app's dialog, not `confirm()`. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
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
        <Hash className="h-4 w-4 text-black/60 dark:text-white/60" />
        <h2 className="text-sm font-semibold text-black dark:text-white">
          {channel.name}
        </h2>
        {channel.description && (
          <span className="truncate text-xs text-black/60 dark:text-white/60">
            — {channel.description}
          </span>
        )}
        {messages.liveStatus && messages.liveStatus !== "open" ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-300"
            data-testid="live-status-chip"
            role="status"
            title="Live updates from the relay have stopped; the client keeps retrying."
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            {messages.liveStatus === "connecting"
              ? "Connecting…"
              : "Reconnecting…"}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {agentsOnline > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white px-2 py-1 text-xs font-medium text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white/60"
              title="Fleet agents online in this community"
              data-testid="agents-online-chip"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {agentsOnline} {agentsOnline === 1 ? "agent" : "agents"} online
            </span>
          )}
          <button
            type="button"
            onClick={() => onShowWork?.()}
            className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-medium text-black/70 shadow-xs hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
          >
            New work
          </button>
          <button
            type="button"
            onClick={() => onShowFleet?.()}
            className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-medium text-black/70 shadow-xs hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
          >
            Add an agent here.
          </button>
          <button
            type="button"
            onClick={() => {
              const url = window.location.href;
              if (navigator.clipboard) {
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast.success("Invite link copied"))
                  .catch(() => toast.error("Couldn't copy invite link"));
              } else {
                toast.error("Couldn't copy invite link");
              }
            }}
            className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-medium text-black/70 shadow-xs hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
          >
            Invite members.
          </button>
        </span>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
        }}
      >
        {messages.error && roots.length > 0 ? (
          <p
            className="mb-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="timeline-history-warning"
            role="status"
          >
            Showing live messages only — the relay did not answer the history
            query for this channel.
          </p>
        ) : null}
        {messages.isLoading ? (
          <div className="space-y-4 py-4">
            {["a", "b", "c", "d"].map((key) => (
              <div
                key={key}
                className="h-12 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
              />
            ))}
          </div>
        ) : roots.length === 0 && messages.error ? (
          <QueryError
            description={`The relay did not answer the history query for #${channel.name}, so this channel is not known to be empty.`}
            message={errorMessage(messages.error)}
            onRetry={messages.refetch}
            testId="timeline-load-error"
            title="Couldn't load messages"
          />
        ) : roots.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <MessageSquare className="h-7 w-7 text-black/60 dark:text-white/60" />
            <p className="mt-2 text-sm text-black/60 dark:text-white/60">
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
                onDelete={(id) => setPendingDelete(id)}
                depth={0}
                profileByPubkey={profileByPubkey}
                agentByPubkey={agentByPubkey}
                ownPubkey={ownPubkey}
                overlays={overlays}
                channelId={channel.id}
                highlightedId={highlightedId}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        channelId={channel.id}
        channelName={channel.name}
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

      <ConfirmDialog
        confirmLabel="Delete message"
        description="The message is replaced with a deletion marker for everyone in this channel."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void deleteMessage(target);
        }}
        open={pendingDelete !== null}
        title="Delete this message?"
      />
    </div>
  );
}
