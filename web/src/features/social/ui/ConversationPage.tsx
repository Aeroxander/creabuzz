import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { resolveUserName } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { parseEntity } from "../lib/entity";
import { useConversations, useSendMessage } from "../use-messages";
import { usePeople } from "../use-people";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

/** One private conversation: bubbles, newest at the bottom, and a message box. */
export function ConversationPage() {
  const { peer: param } = useParams({ from: "/social/messages/$peer" });
  const entity = parseEntity(param);
  const peer = entity?.type === "pubkey" ? entity.pubkey : null;
  const me = existingUserPubkey();
  const conversations = useConversations();
  const people = usePeople(peer ? [peer] : []);
  const send = useSendMessage();
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const messages =
    conversations.data?.find((c) => c.peer === peer)?.messages ?? [];
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (lastId) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

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
          toast.error(
            error instanceof Error ? error.message : "Couldn't send that.",
          );
        },
      },
    );
  };

  return (
    <SocialShell rail={false}>
      <PageBar
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
            Messages are end-to-end encrypted with your key.
          </EmptyState>
        ) : conversations.isLoading ? (
          <TimelineSkeleton />
        ) : messages.length === 0 ? (
          <p className="py-16 text-center text-sm text-black/60 dark:text-white/60">
            No messages yet. Say hello — messages are end-to-end encrypted.
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
          className="sticky bottom-0 z-10 flex items-end gap-2 border-t border-black/10 bg-white/95 p-3 backdrop-blur dark:border-white/10 dark:bg-black/90"
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
