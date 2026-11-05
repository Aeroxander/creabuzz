import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { resolveUserName } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";
import { failureWords } from "@/shared/lib/readable-error";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import {
  QueryError,
  errorMessage,
  readableError,
} from "@/shared/ui/query-error";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { parseEntity } from "../lib/entity";
import { newestIncoming } from "../lib/messages-seen";
import { useConversations, useSendMessage } from "../use-messages";
import { useMessagesSeen } from "../use-messages-seen";
import { usePeople } from "../use-people";
import { MutePersonButton, ReportPersonButton } from "./PersonSafety";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

/** One private conversation: bubbles, newest at the bottom, and a message box. */
export function ConversationPage() {
  const { peer: param } = useParams({ from: "/social/messages/$peer" });
  const entity = parseEntity(param);
  const peer = entity?.type === "pubkey" ? entity.pubkey : null;
  const me = existingUserPubkey();
  const conversations = useConversations({ open: true });
  const people = usePeople(peer ? [peer] : []);
  const send = useSendMessage();
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const conversation = conversations.data?.find((c) => c.peer === peer);
  const messages = conversation?.messages ?? [];
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (lastId) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  // What is on screen here is read, including what arrives while it is open.
  const { markConversationSeen } = useMessagesSeen();
  const newestFromThem = conversation ? newestIncoming(conversation) : 0;
  useEffect(() => {
    if (peer && newestFromThem > 0) markConversationSeen(peer, newestFromThem);
  }, [peer, newestFromThem, markConversationSeen]);

  if (!peer) {
    return (
      <SocialShell rail={false}>
        <PageBar title="Message" />
        <EmptyState title="Unknown recipient">
          Check the link and try again.
        </EmptyState>
      </SocialShell>
    );
  }

  const name = resolveUserName(people[peer], peer);
  const submit = () => {
    const content = text.trim();
    if (!content || send.isPending) return;
    setText("");
    send.mutate(
      { peer, content },
      {
        onError: (error) => {
          setText(content);
          // The words are back in the box, so trying again is one tap.
          toast.error(
            failureWords(
              error,
              "Your message was not sent. It is back in the box. Try again.",
            ).text,
          );
        },
      },
    );
  };

  return (
    <SocialShell rail={false}>
      <PageBar
        actions={
          me && peer !== me ? (
            <>
              <MutePersonButton pubkey={peer} testId="conversation-mute" />
              <ReportPersonButton
                name={name}
                pubkey={peer}
                setting="conversation"
                testId="conversation-report"
              />
            </>
          ) : null
        }
        back={
          <Link
            aria-label="Back to messages"
            className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            to="/social/messages"
          >
            <ArrowLeft aria-hidden className="h-5 w-5" />
          </Link>
        }
        title={
          <Link
            className="flex items-center gap-2"
            params={{ pubkey: peer }}
            to="/u/$pubkey"
          >
            <UserAvatar
              avatarUrl={people[peer]?.picture ?? null}
              displayName={name}
              size="sm"
            />
            {name}
          </Link>
        }
      />
      <div
        className="flex min-h-[calc(100dvh-14rem)] flex-col gap-1 px-4 py-4"
        data-testid="social-thread-messages"
      >
        {!me ? (
          <EmptyState title="Sign in to send messages">
            Only you and the person you write to can read your messages.
          </EmptyState>
        ) : conversations.isLoading ? (
          <TimelineSkeleton />
        ) : conversations.isError && !conversations.data ? (
          // Not read is not empty: say why, rather than "No messages yet".
          <QueryError
            description={readableError(conversations.error)}
            error={conversations.error}
            message={errorMessage(conversations.error)}
            onRetry={() => void conversations.refetch()}
            testId="social-conversation-error"
            title="Couldn't load this conversation"
          />
        ) : messages.length === 0 ? (
          <p className="py-16 text-center text-sm text-black/60 dark:text-white/60">
            No messages yet. Say hello. Only you and the person you write to can
            read your messages.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.from === me;
            return (
              <div
                className={cn(
                  "flex flex-col",
                  mine ? "items-end" : "items-start",
                )}
                key={m.id}
              >
                <div
                  className={cn(
                    "max-w-[80%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2 text-sm",
                    mine
                      ? "rounded-br-md bg-primary text-primary-foreground"
                      : "rounded-bl-md bg-black/10 text-black dark:bg-white/15 dark:text-white",
                  )}
                  data-testid="social-message"
                >
                  {m.content}
                </div>
                <span className="mt-0.5 px-1 text-2xs text-black/60 dark:text-white/60">
                  {shortRelativeTime(m.at)}
                </span>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
      {me ? (
        <form
          className="sticky bottom-0 z-10 flex items-end gap-2 border-t border-border/60 bg-background/50 p-3 backdrop-blur-xl"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="sr-only" htmlFor="social-message-input">
            Message
          </label>
          <textarea
            className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl bg-black/5 px-4 py-2 text-sm text-black outline-none placeholder:text-black/50 focus:ring-1 focus:ring-primary dark:bg-white/10 dark:text-white dark:placeholder:text-white/50"
            data-testid="social-message-input"
            id="social-message-input"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Start a new message"
            rows={1}
            value={text}
          />
          <Button
            className="rounded-full px-5 font-semibold"
            data-testid="social-message-send"
            disabled={!text.trim() || send.isPending}
            type="submit"
          >
            Send
          </Button>
        </form>
      ) : null}
    </SocialShell>
  );
}
