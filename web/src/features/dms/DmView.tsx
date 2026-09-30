import { MessageSquare, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { dmConversationLabel } from "@creaton/core/dm.ts";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import type { Channel } from "@/features/channels/use-channels";
import { useUserNames } from "@/features/profiles/use-profiles";
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
 * Direct messages: the conversation list on the left, the selected
 * conversation's live timeline on the right. Messages inside a conversation
 * use the same channel timeline as community channels — a conversation is a
 * private channel whose id comes from the server's confirmation.
 */
export function DmView() {
  const { me, conversations, isLoading, error, refetch } = useDmConversations();
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
  const [openError, setOpenError] = useState<string | null>(null);

  const labelOf = useCallback(
    (participants: string[]) =>
      dmConversationLabel(participants, names, me ?? undefined),
    [names, me],
  );

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const startConversation = (pubkey: string) => {
    setOpenError(null);
    openDm.mutate([pubkey], {
      onSuccess: (channelId) => {
        setComposeOpen(false);
        setSelectedId(channelId);
      },
      onError: (failure) => {
        setOpenError(
          `Couldn't start the conversation — ${errorMessage(failure)}. Try again.`,
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

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r border-black/10 dark:border-white/10">
        <div className="flex items-center gap-2 px-4 py-3">
          <MessageSquare className="h-4 w-4 text-black/70 dark:text-white/70" />
          <h2 className="text-sm font-semibold text-black/70 dark:text-white/70">
            Direct messages
          </h2>
          <button
            type="button"
            onClick={() => {
              setOpenError(null);
              setComposeOpen(true);
            }}
            className="ml-auto rounded-md p-1.5 text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="New message"
            title="New message"
            data-testid="new-dm-open"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
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
              No conversations yet. Start one with the + button.
            </p>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error != null ? (
          <div className="p-4">
            <QueryError
              error={error}
              title="Couldn't load conversations"
              description={`The server didn't answer the conversation list, so it is not known to be empty. ${errorMessage(error)}`}
              onRetry={() => void refetch()}
              testId="dm-list-error"
            />
          </div>
        ) : isLoading ? (
          <ViewLoadingFallback label="Loading conversations…" />
        ) : selected ? (
          <ChannelTimeline
            channel={
              {
                id: selected.id,
                name: labelOf(selected.participants),
                description: "",
                visibility: "private",
                createdAt: selected.createdAt,
              } satisfies Channel
            }
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/60 dark:text-white/60">
            Select a conversation to start reading.
          </div>
        )}
      </div>

      {composeOpen ? (
        <NewDmDialog
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
