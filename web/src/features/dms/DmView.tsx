import { Link } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { dmConversationLabel } from "@creaton/core/dm.ts";
import { notContributorOnlyBuild } from "@/app/lib/build-gates";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import type { Channel } from "@/features/channels/use-channels";
import { useUserNames } from "@/features/profiles/use-profiles";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

import { NewDmDialog } from "./NewDmDialog";
import {
  dmLastReadAt,
  markDmRead,
  useDmActivity,
  useDmConversations,
  useOpenDm,
} from "./use-dms";

/**
 * This community's notices and messages: the server's moderation notices to the reader (D104) and conversations
 * started inside the community. The conversation list on the left, the selected conversation's live timeline on the
 * right; on a phone one at a time, with Back to the list. Messages inside a conversation use the same channel timeline
 * as community channels — a conversation is a private channel whose id comes from the server's confirmation. Private
 * messages between people are a different inbox, under Messages on Home, and the panel says so.
 */
export function DmView() {
  const { me, conversations, isLoading, error, refetch } = useDmConversations();
  // A contributor-only build has one private inbox, Messages on Home: here are only the community's notices to the
  // reader, to read. Other builds also start private chats inside the community.
  const startsChats = notContributorOnlyBuild();
  const dmIds = useMemo(() => conversations.map((c) => c.id), [conversations]);
  const activity = useDmActivity(dmIds);
  const names = useUserNames(
    useMemo(
      () => conversations.flatMap((c) => c.participants),
      [conversations],
    ),
  );
  const openDm = useOpenDm();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [openError, setOpenError] = useState<FailureWords | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // The conversation Back returns from, so focus lands on its row instead of on nothing.
  const [returnTo, setReturnTo] = useState<string | null>(null);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const shownId = selected?.id ?? null;

  // On a phone the list hides once a conversation opens: the focused row goes with it, so focus moves to Back. Keyed
  // on the conversation actually shown: one just started may reach the list after it was selected.
  useEffect(() => {
    if (shownId && backRef.current?.offsetParent) backRef.current.focus();
  }, [shownId]);
  useEffect(() => {
    if (selectedId || !returnTo) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-testid="dm-${returnTo.slice(0, 8)}"]`)
      ?.focus();
    setReturnTo(null);
  }, [selectedId, returnTo]);

  const labelOf = useCallback(
    (participants: string[]) =>
      dmConversationLabel(participants, names, me ?? undefined),
    [names, me],
  );

  const startConversation = (pubkey: string) => {
    setOpenError(null);
    openDm.mutate([pubkey], {
      onSuccess: (channelId) => {
        setComposeOpen(false);
        setSelectedId(channelId);
      },
      onError: (failure) => {
        // A refusal with plain words already says what to do next (wait, or open the invite link); anything else is
        // said plainly, the server's own words kept under Technical details.
        const fallback = "Couldn't start the conversation. Try again.";
        const words = failureWords(failure, fallback);
        setOpenError(
          words.text === fallback
            ? words
            : {
                ...words,
                text: `Couldn't start the conversation. ${words.text}`,
              },
        );
      },
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    // The conversation is on screen: its new messages are read from now on.
    markDmRead("default", id, Math.floor(Date.now() / 1000));
    setOpenError(null);
  };

  const rows = useMemo(
    () =>
      [...conversations]
        .sort(
          (a, b) =>
            (activity.get(b.id) ?? b.createdAt) -
            (activity.get(a.id) ?? a.createdAt),
        )
        .map((conversation) => ({
          conversation,
          label: labelOf(conversation.participants),
          lastActivity: activity.get(conversation.id) ?? conversation.createdAt,
        })),
    [conversations, activity, labelOf],
  );

  // On a phone: the list, or the open conversation. Loading and errors show under the list there.
  const status = error != null || isLoading;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col md:flex-row"
      data-testid="dm-view"
      ref={rootRef}
    >
      <aside
        className={`${selected ? "hidden md:flex" : "flex"} ${status ? "shrink-0" : "min-h-0 flex-1"} w-full flex-col md:w-60 md:flex-none md:shrink-0 md:border-r md:border-black/10 md:dark:border-white/10`}
        data-testid="dm-list"
      >
        <div className="flex items-start gap-2 px-4 pt-3">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-black/70 dark:text-white/70" />
          <h2 className="text-sm font-semibold text-black/70 dark:text-white/70">
            {startsChats
              ? "Private chats in this community"
              : "Notices from this community"}
          </h2>
          {startsChats ? (
            <button
              type="button"
              onClick={() => {
                setOpenError(null);
                setComposeOpen(true);
              }}
              className="ml-auto rounded-md p-1.5 text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label="New chat"
              title="New chat"
              data-testid="new-dm-open"
            >
              <Plus className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <p className="px-4 pb-3 pt-1 text-xs text-black/60 dark:text-white/60">
          {startsChats
            ? "Only the people in a chat can see it. Your other private messages are under "
            : "Only you can see these. To write to someone, use "}
          <Link
            className="font-medium text-black underline dark:text-white"
            data-testid="dm-home-messages"
            to="/social/messages"
          >
            Messages on Home
          </Link>
          .
        </p>
        <nav
          aria-label="Conversations"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
        >
          {rows.map(({ conversation, label, lastActivity }) => {
            const unread =
              lastActivity > dmLastReadAt("default", conversation.id);
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => select(conversation.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  conversation.id === selectedId
                    ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                    : unread
                      ? "font-medium text-black hover:bg-black/5 dark:text-white dark:hover:bg-white/5"
                      : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
                }`}
                data-testid={`dm-${conversation.id.slice(0, 8)}`}
              >
                <span className="truncate">{label}</span>
                {unread ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="ml-auto h-2 w-2 shrink-0 rounded-full bg-primary"
                    />
                    <span className="sr-only">unread messages</span>
                  </>
                ) : null}
              </button>
            );
          })}
          {!isLoading && error == null && rows.length === 0 ? (
            <p className="px-2 py-1 text-xs text-black/60 dark:text-white/60">
              {startsChats ? "No chats yet." : "No notices."}
            </p>
          ) : null}
        </nav>
      </aside>

      <div
        className={`${selected || status ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}
      >
        {error != null ? (
          <div className="p-4">
            <QueryError
              error={error}
              title="Couldn't load conversations"
              description="The server didn't answer, so we can't tell whether you have any conversations."
              message={errorMessage(error)}
              onRetry={() => void refetch()}
              testId="dm-list-error"
            />
          </div>
        ) : isLoading ? (
          <ViewLoadingFallback label="Loading conversations…" />
        ) : selected ? (
          <>
            <div className="flex items-center border-b border-black/10 px-2 py-1 md:hidden dark:border-white/10">
              <button
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                data-testid="dm-back"
                onClick={() => {
                  setReturnTo(selected.id);
                  setSelectedId(null);
                }}
                ref={backRef}
                type="button"
              >
                <ArrowLeft aria-hidden className="h-4 w-4" />
                All conversations
              </button>
            </div>
            <ChannelTimeline
              channel={
                {
                  id: selected.id,
                  name: labelOf(selected.participants),
                  description: "",
                  visibility: "private",
                  type: "stream",
                  direct: true,
                  createdAt: selected.createdAt,
                  serverKey: selected.serverKey,
                } satisfies Channel
              }
              readOnlyNote={
                startsChats
                  ? undefined
                  : "Only the people who run this community write here. To answer, use Messages on Home."
              }
            />
          </>
        ) : rows.length === 0 && startsChats ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-black/60 dark:text-white/60">
            <p>No private chats yet.</p>
            <button
              className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
              data-testid="dm-empty-start"
              onClick={() => {
                setOpenError(null);
                setComposeOpen(true);
              }}
              type="button"
            >
              Start a private chat
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-black/60 dark:text-white/60">
            {rows.length === 0
              ? "Nothing here yet."
              : startsChats
                ? "Select a conversation to start reading."
                : "Select a notice to read it."}
          </div>
        )}
      </div>

      {composeOpen && startsChats ? (
        <NewDmDialog
          me={me ?? ""}
          pending={openDm.isPending}
          error={openError}
          onStart={startConversation}
          onClose={() => {
            setComposeOpen(false);
            setOpenError(null);
          }}
        />
      ) : null}
    </div>
  );
}
