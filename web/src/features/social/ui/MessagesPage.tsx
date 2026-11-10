import { Link, useNavigate } from "@tanstack/react-router";
import { PenLine } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useCommunityAccess } from "@/features/communities/use-access";
import { resolveUserName } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { countOf } from "@/shared/lib/count-of";
import { failureWords } from "@/shared/lib/readable-error";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import {
  QueryError,
  errorMessage,
  readableError,
} from "@/shared/ui/query-error";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { newestIncomingOf } from "../lib/messages-seen";
import {
  useConversations,
  useHasDmRelayList,
  usePublishDmRelayList,
} from "../use-messages";
import { useMessagesSeen } from "../use-messages-seen";
import { usePeople } from "../use-people";
import { useMutedPeople } from "../use-social-actions";
import { PersonSearch } from "./PersonSearch";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

function NewMessage({ me }: { me: string }) {
  const navigate = useNavigate();
  return (
    <div
      className="border-b border-black/10 p-4 dark:border-white/10"
      data-testid="social-new-message"
    >
      <PersonSearch
        inputId="social-dm-recipient"
        inputTestId="social-dm-recipient"
        me={me}
        onPick={(pubkey) =>
          void navigate({
            to: "/social/messages/$peer",
            params: { peer: pubkey },
          })
        }
      />
    </div>
  );
}

function ReceiveFromOtherAppsBanner() {
  const has = useHasDmRelayList();
  const publish = usePublishDmRelayList();
  // An invite-only server takes nothing from people outside it, so there is nothing to turn on. Not offered until the
  // server has said which it is.
  const access = useCommunityAccess();
  if (access.isPending || access.data === "invite_only") return null;
  if (has.isLoading || has.data !== false) return null;
  return (
    <div
      className="flex items-center gap-3 border-b border-black/10 bg-sky-500/5 px-4 py-3 dark:border-white/10"
      data-testid="social-dm-relay-banner"
    >
      <p className="flex-1 text-sm text-black dark:text-white">
        Let people using other apps message you here. This posts a public note
        saying where to reach you.
      </p>
      <Button
        className="rounded-full px-4 font-semibold"
        disabled={publish.isPending}
        onClick={() =>
          publish.mutate(undefined, {
            onSuccess: () => toast.success("Other apps can now reach you here"),
            onError: (error) =>
              toast.error(
                failureWords(
                  error,
                  "The server did not save where other apps can reach you. Try again.",
                ).text,
              ),
          })
        }
        size="sm"
        type="button"
      >
        Turn on
      </Button>
    </div>
  );
}

/** Your private conversations: end-to-end encrypted, readable by other Nostr apps. */
export function MessagesPage() {
  const me = existingUserPubkey();
  const conversations = useConversations({ open: true });
  const people = usePeople((conversations.data ?? []).map((c) => c.peer));
  const [composing, setComposing] = useState(false);
  // Conversations with people you muted stay out of the inbox; their profile is where you unmute them.
  const muted = useMutedPeople().data;
  const shown = (conversations.data ?? []).filter(
    (conversation) => !muted?.has(conversation.peer),
  );
  const hidden = (conversations.data?.length ?? 0) - shown.length;

  // The list's previews show the newest message of each conversation: once on screen, the nav's dot is answered.
  const { markListSeen } = useMessagesSeen();
  const newestShown = newestIncomingOf(shown);
  useEffect(() => {
    if (newestShown > 0) markListSeen(newestShown);
  }, [newestShown, markListSeen]);

  return (
    <SocialShell>
      <PageBar title="Messages">
        {me ? (
          <button
            aria-label="New message"
            aria-pressed={composing}
            className="absolute right-3 top-1.5 flex h-9 w-9 items-center justify-center rounded-full text-black hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
            data-testid="social-new-message-button"
            onClick={() => setComposing((v) => !v)}
            type="button"
          >
            <PenLine aria-hidden className="h-5 w-5" />
          </button>
        ) : null}
      </PageBar>
      {!me ? (
        <EmptyState title="Sign in to send messages">
          Only you and the person you write to can read your messages.
        </EmptyState>
      ) : (
        <>
          <ReceiveFromOtherAppsBanner />
          {composing ? <NewMessage me={me} /> : null}
          {conversations.isLoading ? (
            <TimelineSkeleton />
          ) : conversations.isError ? (
            <div className="p-4">
              <QueryError
                description={readableError(conversations.error)}
                error={conversations.error}
                message={errorMessage(conversations.error)}
                onRetry={() => void conversations.refetch()}
                testId="social-messages-error"
                title="Couldn't load your messages"
              />
            </div>
          ) : shown.length === 0 ? (
            <EmptyState testId="social-messages-empty" title="No messages yet">
              Only you and the person you write to can read your messages. Start
              one with the pencil above.
            </EmptyState>
          ) : (
            shown.map((c) => {
              const profile = people[c.peer];
              const name = resolveUserName(profile, c.peer);
              return (
                <Link
                  className="flex gap-3 border-b border-black/10 px-4 py-3 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]"
                  data-testid="social-conversation"
                  key={c.peer}
                  params={{ peer: c.peer }}
                  to="/social/messages/$peer"
                >
                  <UserAvatar
                    avatarUrl={profile?.picture ?? null}
                    className="h-10 w-10"
                    displayName={name}
                  />
                  <span className="min-w-0 flex-1 text-sm leading-5">
                    <span className="flex items-baseline gap-1">
                      <span className="truncate font-bold text-black dark:text-white">
                        {name}
                      </span>
                      <span className="text-black/60 dark:text-white/60">
                        · {shortRelativeTime(c.last.at)}
                      </span>
                    </span>
                    <span className="block truncate text-black/60 dark:text-white/60">
                      {c.last.from === me ? "You: " : ""}
                      {c.last.content}
                    </span>
                  </span>
                </Link>
              );
            })
          )}
          {hidden > 0 ? (
            <p
              className="px-4 py-3 text-xs text-black/60 dark:text-white/60"
              data-testid="social-muted-hidden"
            >
              Hidden: {countOf(hidden, "conversation", "conversations")} with
              people you muted. Unmute someone from their profile to see their
              messages again.
            </p>
          ) : null}
        </>
      )}
    </SocialShell>
  );
}
