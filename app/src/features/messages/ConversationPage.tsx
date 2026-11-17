import { shortRelativeTime } from "@creaton/core/client/relative-time.ts";
import { useEffect, useRef, useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { nameOf, useProfiles } from "../../lib/profiles";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { EmptyState } from "../../ui/empty-state";
import { useToast } from "../../ui/toast";
import { useConversations, useSendMessage } from "./use-messages";

/** One conversation: the messages, oldest at the top, and a box to write at the foot. */
export function ConversationPage({ peer }: { peer: string }) {
  const { pubkey, locked } = useAccount();
  const conversations = useConversations({ open: true });
  const conversation = conversations.data?.find((c) => c.peer === peer);
  const profiles = useProfiles([peer]).data;
  const name = nameOf(profiles, peer);
  const send = useSendMessage();
  const toast = useToast();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement | null>(null);
  const count = conversation?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever one arrives.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  if (!pubkey || locked)
    return (
      <main className="screen mx-auto flex max-w-lg flex-col gap-4">
        <BackHeader title={name} />
        <EmptyState
          title={
            pubkey ? "Unlock to read your messages" : "Sign up to send messages"
          }
        />
      </main>
    );
  return (
    <main className="screen mx-auto flex min-h-dvh max-w-lg flex-col gap-3">
      <BackHeader title={name} />
      <ol
        aria-label={`Messages with ${name}`}
        className="flex flex-1 flex-col gap-2"
        data-testid="messages"
      >
        {(conversation?.messages ?? []).map((message) => {
          const mine = message.from === pubkey;
          return (
            <li
              className={cn(
                "max-w-[80%] rounded-2xl px-3.5 py-2.5",
                mine ? "self-end bg-mint text-on-mint" : "plain self-start",
              )}
              data-testid="message"
              key={message.id}
            >
              <span className="sr-only">{mine ? "You" : name}: </span>
              <p className="whitespace-pre-wrap break-words">
                {message.content}
              </p>
              <p
                className={cn(
                  "num mt-1 text-2xs",
                  mine ? "text-on-mint/70" : "text-muted",
                )}
              >
                {shortRelativeTime(message.at)}
              </p>
            </li>
          );
        })}
        {count === 0 && !conversations.isPending ? (
          <li className="text-center text-sm text-muted">
            Say hello. Only the two of you can read this.
          </li>
        ) : null}
      </ol>
      <div ref={end} />
      <form
        className="sticky flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const content = text.trim();
          if (!content) return;
          setText("");
          send.mutate(
            { peer, content },
            {
              onError: (error) => {
                setText(content);
                toast(error.message, "problem");
              },
            },
          );
        }}
        style={{
          bottom: "calc(var(--tabbar-height) + var(--safe-bottom) + 8px)",
        }}
      >
        <label className="sr-only" htmlFor="message-text">
          Message
        </label>
        <textarea
          className="field glass min-h-12 flex-1 py-3"
          data-testid="message-text"
          id="message-text"
          onChange={(e) => setText(e.target.value)}
          placeholder="Message"
          rows={1}
          value={text}
        />
        <Button
          data-testid="message-send"
          disabled={!text.trim()}
          type="submit"
        >
          Send
        </Button>
      </form>
    </main>
  );
}
