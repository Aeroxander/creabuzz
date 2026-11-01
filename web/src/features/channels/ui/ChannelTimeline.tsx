import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Ban,
  Copy,
  Flag,
  Hash,
  Link2,
  Lock,
  MessageSquare,
  Pencil,
  Reply,
  Smile,
  Trash2,
  ListChecks,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { TechnicalDetails } from "@/shared/ui/technical-details";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";

import type { Channel } from "../use-channels";
import {
  isServerNote,
  parseSystemNote,
  repeatedCreationNotes,
  systemNoteText,
} from "../lib/system-notes";
import { useModeratorRemovals } from "../use-moderator-removals";
import {
  isOverlayKind,
  useChannelMessages,
  type ChannelMessages,
} from "../use-channel-messages";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey } from "@/shared/lib/identity";
import { liveRefusalText } from "@/shared/lib/refusal-text";
import {
  resolveUserName,
  useProfiles,
  type Profile,
} from "@/features/profiles/use-profiles";
import { Composer, type EditTarget } from "./Composer";
import { useAgentRoster } from "@/features/fleet/use-agent-roster";
import { PresenceStrip } from "@/features/presence/ui/PresenceStrip";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { Bot } from "lucide-react";
import { getTag } from "@/shared/lib/event-fields";
import { DecisionEmbeds } from "@/features/launchpad/ui/DecisionEmbeds";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { useBanAuthor } from "@/features/communities/ui/BanAuthor";
import { ReportDialog } from "@/features/moderation/ui/ReportDialog";
import { MutedLine } from "@/features/social/ui/MutedLine";
import { useMutedSet } from "@/features/social/use-social-actions";
import { BoardPeople } from "@/features/board/ui/BoardPeople";
import { EditRoomButton } from "./EditChannelDialog";
import { RoomInviteCards } from "./RoomInviteCards";
import { SystemNoteRow } from "./SystemNoteRow";
import { failureWords, readFailureWords } from "@/shared/lib/readable-error";

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
function messageAnchor(eventId: string): string {
  return `message-${eventId}`;
}

/**
 * Permalink for a message.
 *
 * The web client addresses a thread by channel with `?channel=`; the message id
 * rides along so the target row can be scrolled to and highlighted.
 */
function messagePermalink(eventId: string, channelId?: string): string {
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
      description: failureWords(error).text,
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
  onRemove,
  ownPubkey,
  overlayContent,
  isDeleted,
  removedByModerator,
  profile,
  agent,
  highlighted,
  channelId,
  muted = false,
}: {
  event: NostrEvent;
  isReply?: boolean;
  /** Written by someone the reader muted: folded to one line until they choose to look. */
  muted?: boolean;
  /** Channel the message belongs to; makes the permalink open this thread. */
  channelId: string;
  /** True when this row is the target of a permalink. */
  highlighted?: boolean;
  reactions: NostrEvent[];
  onReply?: (eventId: string) => void;
  onEdit?: (event: NostrEvent) => void;
  onDelete?: (eventId: string) => void;
  /** Given only to a reader who owns or administers the room: remove someone else's message. */
  onRemove?: (eventId: string) => void;
  ownPubkey: string;
  overlayContent?: string;
  isDeleted?: boolean;
  /** The message was removed by a moderator, not deleted by its author. */
  removedByModerator?: boolean;
  profile?: Profile;
  agent?: { name: string };
}) {
  const isOwn = event.pubkey === ownPubkey;
  const [reporting, setReporting] = useState(false);
  const [shownAnyway, setShownAnyway] = useState(false);
  const ban = useBanAuthor(
    event.pubkey,
    resolveUserName(profile, event.pubkey),
  );
  if (muted && !isOwn && !shownAnyway) {
    return (
      <div className={isReply ? "ml-8 px-2" : "px-2"}>
        <MutedLine onShow={() => setShownAnyway(true)} what="A message" />
      </div>
    );
  }
  const content = isDeleted
    ? ""
    : (overlayContent ??
      (typeof event.content === "string" ? event.content.slice(0, 4000) : ""));

  const react = async (emoji: string) => {
    try {
      await publishAsUser(
        {
          kind: 7,
          tags: [
            ["e", event.id],
            ["p", event.pubkey],
          ],
          content: emoji,
        },
        "Server rejected the reaction",
      );
    } catch (error) {
      console.error("[react]", error);
      toast.error("Couldn't add reaction", {
        description: failureWords(error).text,
      });
    }
  };

  return (
    <div
      className={`group flex gap-3 rounded-2xl px-2 py-conversation-row transition-colors ${isReply ? "ml-8" : "hover:bg-muted/50"} ${
        highlighted ? "bg-amber-300/20" : ""
      }`}
      data-highlighted={highlighted ? "true" : undefined}
      data-testid="message-row"
      id={messageAnchor(event.id)}
    >
      <div className="shrink-0">
        <UserAvatar
          avatarUrl={profile?.picture ?? null}
          displayName={agent?.name ?? resolveUserName(profile, event.pubkey)}
          size="md"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold leading-message-author text-foreground">
            {agent?.name ?? resolveUserName(profile, event.pubkey)}
          </span>
          {agent ? (
            <Bot className="h-3 w-3 self-center text-black/60 dark:text-white/60" />
          ) : null}
          <time
            className="text-message-timestamp font-normal text-muted-foreground tabular-nums"
            title={new Date(event.created_at * 1000).toLocaleString()}
          >
            {new Date(event.created_at * 1000).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          {/* Shown on hover or focus; a touch screen has no hover, so there they are always shown. */}
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-black/60 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 dark:text-white/60">
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
            {!isOwn && !isDeleted && (
              <button
                type="button"
                onClick={() => setReporting(true)}
                className="flex items-center gap-1 hover:text-red-500"
                aria-label="Report message"
                data-testid="report-button"
              >
                <Flag className="h-3 w-3" /> Report
              </button>
            )}
            {!isOwn && !isDeleted && ban.allowed && (
              <button
                type="button"
                onClick={ban.start}
                className="flex items-center gap-1 hover:text-red-500"
                aria-label="Ban the person who wrote this"
                data-testid="ban-author-button"
              >
                <Ban className="h-3 w-3" /> Ban
              </button>
            )}
            {!isOwn && !isDeleted && onRemove && (
              <button
                type="button"
                onClick={() => onRemove(event.id)}
                className="flex items-center gap-1 hover:text-red-500"
                aria-label="Remove message"
                data-testid="remove-button"
              >
                <Trash2 className="h-3 w-3" /> Remove
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
            {removedByModerator
              ? "message removed by a moderator"
              : "message deleted"}
          </p>
        ) : (
          <div className="mt-0.5 break-words text-message leading-relaxed text-black dark:text-white [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:dark:bg-white/10">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            <DecisionEmbeds text={content} />
          </div>
        )}
        {reactions.length > 0 && <ReactionPills events={reactions} />}
        <div className="mt-1 flex items-center gap-2 text-xs text-black/60 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 dark:text-white/60">
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
      {reporting ? (
        <ReportDialog
          onClose={() => setReporting(false)}
          target={{
            kind: "message",
            eventId: event.id,
            authorPubkey: event.pubkey,
          }}
          what="this message"
        />
      ) : null}
      {ban.dialog}
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
  onRemove,
  depth,
  profileByPubkey,
  agentByPubkey,
  ownPubkey,
  overlays,
  channelId,
  highlightedId,
  muted,
}: {
  event: NostrEvent;
  messages: ChannelMessages;
  /** People the reader muted. */
  muted: ReadonlySet<string>;
  reactionsByTarget: Map<string, NostrEvent[]>;
  onReply: (eventId: string) => void;
  onEdit?: (event: NostrEvent) => void;
  onDelete?: (eventId: string) => void;
  onRemove?: (eventId: string) => void;
  depth: number;
  profileByPubkey: Map<string, Profile | undefined>;
  agentByPubkey: Map<string, { name: string }>;
  ownPubkey: string;
  overlays: {
    edits: Map<string, string>;
    deleted: ReadonlySet<string>;
    removed: ReadonlySet<string>;
  };
  channelId: string;
  highlightedId?: string | null;
}) {
  // Overlay kinds carry an `e` tag too, but they are not replies: they are
  // rendered on the message they target (pill, replaced text, deletion marker).
  const children = messages.ordered.filter(
    (e) => getTag(e, "e") === event.id && !isOverlayKind(e.kind),
  );
  return (
    <div>
      <MessageRow
        event={event}
        isReply={depth > 0}
        reactions={reactionsByTarget.get(event.id) ?? []}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        onRemove={onRemove}
        ownPubkey={ownPubkey}
        overlayContent={overlays.edits.get(event.id)}
        isDeleted={overlays.deleted.has(event.id)}
        removedByModerator={overlays.removed.has(event.id)}
        profile={profileByPubkey.get(event.pubkey)}
        agent={agentByPubkey.get(event.pubkey)}
        channelId={channelId}
        highlighted={event.id === highlightedId}
        muted={muted.has(event.pubkey.toLowerCase())}
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
          onRemove={onRemove}
          depth={depth + 1}
          profileByPubkey={profileByPubkey}
          agentByPubkey={agentByPubkey}
          ownPubkey={ownPubkey}
          overlays={overlays}
          channelId={channelId}
          highlightedId={highlightedId}
          muted={muted}
        />
      ))}
    </div>
  );
}

export function ChannelTimeline({
  channel,
  onShowFleet,
  onShowWork,
  onShowPeople,
  runsCommunity = false,
  highlightedId,
  suggestPeopleFrom = null,
  readOnlyNote,
}: {
  channel: Channel;
  /** Shown in place of the composer: a thread the reader can read but not write in (the server's notices to them). */
  readOnlyNote?: string;
  onShowFleet?: () => void;
  onShowWork?: () => void;
  /** Opens the community's People page, where its invite links are made. */
  onShowPeople?: () => void;
  /** The reader runs this community (owner, admin or moderator): AI helpers, tasks and invites are theirs to add. */
  runsCommunity?: boolean;
  /** Message id from a permalink: scrolled to and highlighted by the shell. */
  highlightedId?: string | null;
  /** For a private room: a channel whose speakers are offered as people to add. */
  suggestPeopleFrom?: string | null;
}) {
  const messages = useChannelMessages(channel.id);
  const muted = useMutedSet();
  // A direct-message thread is private too, but nobody is added to or taken off it.
  const privateRoom = channel.visibility === "private" && !channel.direct;
  // A private room's people: who can read it, adding someone, and taking someone off it.
  const [showingPeople, setShowingPeople] = useState(false);
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
  const authorOverlays = useMessageOverlays(messages);
  const moderation = useModeratorRemovals(channel.id, messages.ordered);
  // What the author deleted and what a moderator removed both read as gone; the marker says which.
  const overlays = useMemo(
    () => ({
      edits: authorOverlays.edits,
      deleted: new Set([...authorOverlays.deleted, ...moderation.removed]),
      removed: moderation.removed,
    }),
    [authorOverlays, moderation.removed],
  );
  // The server's notes are read as sentences about people, so their names are looked up instead of the server's.
  const serverKey = channel.serverKey;
  const notes = useMemo(
    () =>
      new Map(
        messages.ordered
          .filter((e) => isServerNote(e, serverKey))
          .map((e) => [e.id, parseSystemNote(e.content)]),
      ),
    [messages.ordered, serverKey],
  );
  const authors = useMemo(() => {
    const people = new Set<string>();
    for (const event of messages.ordered) {
      const note = notes.get(event.id);
      if (!note) {
        people.add(event.pubkey);
        continue;
      }
      if (note.actor) people.add(note.actor);
      if (note.target) people.add(note.target);
    }
    return [...people];
  }, [messages.ordered, notes]);
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
  /** Message a moderator is about to remove, awaiting confirmation. */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  // Read-only: a visitor reading a room has no key and must not be given one by opening it ("" matches no author).
  const ownPubkey = existingUserPubkey() ?? "";
  const nameOf = (pubkey: string) =>
    agentByPubkey.get(pubkey)?.name ??
    resolveUserName(profileByPubkey.get(pubkey), pubkey);

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
      await publishAsUser(
        {
          kind: 5,
          tags: [
            ["h", channel.id],
            ["e", eventId],
          ],
          content: "",
        },
        "Server rejected the deletion",
      );
    } catch (error) {
      console.error("[delete]", error);
      toast.error("Couldn't delete message", {
        description: failureWords(error).text,
      });
    }
  };

  const removeMessage = async (eventId: string) => {
    try {
      await moderation.remove(eventId);
    } catch (error) {
      toast.error("Couldn't remove message", {
        description: failureWords(error).text,
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

  // A room is created once: a second "created" note is left out (see `repeatedCreationNotes`).
  const repeatedNotes = useMemo(
    () => repeatedCreationNotes(messages.ordered, notes),
    [messages.ordered, notes],
  );
  const roots = messages.ordered.filter(
    (e) => !getTag(e, "e") && !repeatedNotes.has(e.id),
  );
  // Visitors read; the invitation cards are for people who can act on them, and a direct thread's people are fixed.
  const signedIn = ownPubkey !== "";
  const showInviteCards = signedIn && !channel.direct;

  // Who is here: recent participants plus the viewer, bounded. There is no
  // member registry to read, so the timeline's authors are the honest set.
  const memberPubkeys = useMemo(() => {
    const seen = new Set<string>();
    for (const event of messages.ordered) {
      if (seen.size >= 24) break;
      if (notes.has(event.id)) continue;
      seen.add(event.pubkey.toLowerCase());
    }
    // Not signed in: presence for the viewer is unavailable, fine.
    const self = existingUserPubkey();
    if (self) seen.add(self.toLowerCase());
    return [...seen];
  }, [messages.ordered, notes]);
  // A failed page of older messages in plain words; the server's or browser's own under Technical details.
  const olderFailure = messages.olderError
    ? readFailureWords(messages.olderError)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
        {/* The sidebar's mark: a lock for a private room, # for an open one. */}
        {channel.visibility === "private" ? (
          <Lock
            aria-hidden
            className="h-4 w-4 shrink-0 text-black/60 dark:text-white/60"
            data-testid="channel-header-private"
          />
        ) : (
          <Hash className="h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
        )}
        <h2 className="min-w-0 truncate text-sm font-semibold text-black dark:text-white">
          {channel.name}
        </h2>
        {channel.description && (
          <span className="truncate text-xs text-black/60 dark:text-white/60">
            · {channel.description}
          </span>
        )}
        {messages.liveStatus && messages.liveStatus !== "open" ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-300"
            data-testid="live-status-chip"
            role={messages.liveStatus === "refused" ? undefined : "status"}
            title={
              messages.liveStatus === "refused"
                ? liveRefusalText(messages.liveRefusal)
                : "Live updates from the server have stopped; the client keeps retrying."
            }
          >
            {messages.liveStatus === "refused" ? (
              // Stopped for good: no pulse, a short label, and the reason in full in the line under the header.
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            ) : (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            )}
            {messages.liveStatus === "refused"
              ? "Live updates stopped"
              : messages.liveStatus === "connecting"
                ? "Connecting…"
                : "Reconnecting…"}
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <PresenceStrip memberPubkeys={memberPubkeys} />
          {channel.direct ? null : <EditRoomButton channel={channel} />}
          {privateRoom ? (
            <button
              aria-expanded={showingPeople}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              data-testid="room-people-toggle"
              onClick={() => setShowingPeople((value) => !value)}
              type="button"
            >
              <Users className="h-3.5 w-3.5" />
              People
            </button>
          ) : null}
          {agentsOnline > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white px-2 py-1 text-xs font-medium text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white/60"
              title="AI helpers online in this community"
              data-testid="agents-online-chip"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {agentsOnline} {agentsOnline === 1 ? "AI helper" : "AI helpers"}{" "}
              online
            </span>
          )}
          {signedIn && runsCommunity && onShowWork ? (
            <button
              type="button"
              onClick={onShowWork}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              data-testid="channel-new-work"
            >
              <ListChecks className="h-3.5 w-3.5" />
              New task
            </button>
          ) : null}
        </span>
      </header>
      {messages.liveStatus === "refused" ? (
        <p
          className="border-b border-black/10 px-4 py-2 text-xs text-amber-800 dark:border-white/10 dark:text-amber-300"
          data-testid="live-refusal"
          role="status"
        >
          {liveRefusalText(messages.liveRefusal)}
        </p>
      ) : null}
      {privateRoom && showingPeople ? (
        <BoardPeople
          boardId={channel.id}
          place="room"
          suggestFromChannelId={suggestPeopleFrom}
        />
      ) : null}

      {/* The People panel has its own way to add someone; one is enough on screen. */}
      {showInviteCards && !(privateRoom && showingPeople) ? (
        <RoomInviteCards
          onShowFleet={runsCommunity ? onShowFleet : undefined}
          onShowPeople={runsCommunity ? onShowPeople : undefined}
          onShowRoomPeople={
            privateRoom ? () => setShowingPeople(true) : undefined
          }
        />
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
        }}
      >
        {roots.length > 0 &&
        (messages.hasOlder || messages.loadingOlder || messages.olderError) ? (
          <div className="flex flex-col items-center gap-1 py-2">
            {messages.olderError ? (
              <>
                <p
                  className="text-xs text-amber-700 dark:text-amber-300"
                  data-testid="older-messages-error"
                  role="alert"
                >
                  Couldn't load older messages. {olderFailure?.text}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void messages.loadOlder()}
                  >
                    Try again
                  </button>
                </p>
                <TechnicalDetails
                  detail={olderFailure?.detail ?? null}
                  testId="older-messages-error-details"
                />
              </>
            ) : (
              <button
                type="button"
                className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white/70"
                data-testid="load-older-messages"
                disabled={messages.loadingOlder}
                onClick={() => void messages.loadOlder()}
              >
                {messages.loadingOlder
                  ? "Loading older messages…"
                  : "Load older messages"}
              </button>
            )}
          </div>
        ) : null}
        {messages.error && roots.length > 0 ? (
          <p
            className="mb-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="timeline-history-warning"
            role="status"
          >
            Showing live messages only. The server didn't answer the history
            request for this room.
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
            description={`The server did not answer the history query for #${channel.name}, so this room is not known to be empty.`}
            error={messages.error}
            message={errorMessage(messages.error)}
            onRetry={messages.refetch}
            recovery={(onUnlocked) => (
              <SignRecovery
                autoResume
                onUnlocked={onUnlocked}
                showHeadline={false}
              />
            )}
            relayUrl={relayWsUrl()}
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
          <div className="space-y-conversation-list">
            {roots.map((root) => {
              const note = notes.get(root.id);
              if (note) {
                return (
                  <SystemNoteRow
                    event={root}
                    key={root.id}
                    text={systemNoteText(note, { nameOf, self: ownPubkey })}
                  />
                );
              }
              return (
                <ThreadTree
                  key={root.id}
                  event={root}
                  messages={messages}
                  reactionsByTarget={reactionsByTarget}
                  onReply={(id) => setReplyTo(id)}
                  onEdit={(event) => startEdit(event)}
                  onDelete={(id) => setPendingDelete(id)}
                  onRemove={
                    moderation.canRemove
                      ? (id) => setPendingRemove(id)
                      : undefined
                  }
                  depth={0}
                  muted={muted}
                  profileByPubkey={profileByPubkey}
                  agentByPubkey={agentByPubkey}
                  ownPubkey={ownPubkey}
                  overlays={overlays}
                  channelId={channel.id}
                  highlightedId={highlightedId}
                />
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {readOnlyNote ? (
        <p
          className="border-t border-black/10 px-4 py-3 text-xs text-black/60 dark:border-white/10 dark:text-white/60"
          data-testid="timeline-read-only"
        >
          {readOnlyNote}
        </p>
      ) : (
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
      )}

      <ConfirmDialog
        confirmLabel="Delete message"
        description="The message is replaced with a deletion marker for everyone in this room."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void deleteMessage(target);
        }}
        open={pendingDelete !== null}
        title="Delete this message?"
      />

      <ConfirmDialog
        confirmLabel="Remove message"
        description="It is taken away for everyone in this room. The person stays; to keep them out, use Ban."
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const target = pendingRemove;
          setPendingRemove(null);
          if (target) void removeMessage(target);
        }}
        open={pendingRemove !== null}
        title="Remove this message?"
      />
    </div>
  );
}
