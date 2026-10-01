import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { parseEntity } from "@/shared/lib/nip19";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { useProfiles, useViewerPubkey } from "../../feed/use-feed";
import { Avatar, displayNameOf } from "../../feed/ui/Avatar";
import { FeedShell } from "../../feed/ui/FeedShell";
import { Message } from "../../feed/ui/Message";
import { TimelineSkeleton } from "../../feed/ui/Timeline";
import { useDirectMessages, useSendDirectMessage } from "../use-messages";

export function ConversationPage() {
  const { peer: param } = useParams({ from: "/messages/$peer" });
  const entity = parseEntity(param);
  const peer = entity?.type === "pubkey" ? entity.pubkey : null;
  const viewer = useViewerPubkey();
  const conversations = useDirectMessages(viewer);
  const profiles = useProfiles([...(peer ? [peer] : [])]).data;
  const send = useSendDirectMessage(viewer);
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
      <FeedShell>
        <Message
          title="Unknown recipient"
          body="Check the link and try again."
        />
      </FeedShell>
    );
  }

  const profile = profiles?.get(peer);

  function submit() {
    const content = text.trim();
    if (!content || !peer || send.isPending) return;
    setText("");
    send.mutate(
      { peer, content },
      {
        onError: (error) => {
          setText(content);
          toast.error(error.message);
        },
      },
    );
  }

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 flex h-[53px] items-center gap-4 border-b bg-background/85 px-4 backdrop-blur">
        <Link
          to="/messages"
          aria-label="Back to messages"
          className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-foreground/10"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Link
          to="/p/$id"
          params={{ id: peer }}
          className="flex min-w-0 items-center gap-3"
        >
          <Avatar pubkey={peer} profile={profile} className="h-8 w-8" />
          <h1 className="truncate text-xl font-bold">
            {displayNameOf(peer, profile)}
          </h1>
        </Link>
      </div>

      <div className="flex min-h-[calc(100dvh-53px-130px)] flex-col gap-1 px-4 py-4">
        {conversations.isLoading ? (
          <TimelineSkeleton />
        ) : messages.length === 0 ? (
          <p className="py-16 text-center text-[15px] text-muted-foreground">
            No messages yet. Say hello — messages are end-to-end encrypted.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.from === viewer;
            return (
              <div
                key={m.id}
                className={cn(
                  "flex flex-col",
                  mine ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2 text-[15px] leading-5",
                    mine
                      ? "rounded-br-md bg-primary text-primary-foreground"
                      : "rounded-bl-md bg-muted",
                  )}
                >
                  {m.content}
                </div>
                <span className="mt-0.5 px-1 text-[12px] text-muted-foreground">
                  {shortRelativeTime(m.at)}
                </span>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="sticky bottom-14 z-10 flex items-end gap-2 border-t bg-background/95 p-3 backdrop-blur sm:bottom-0"
      >
        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Start a new message"
          aria-label="Message"
          className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl bg-muted/60 px-4 py-2 text-[15px] outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
        />
        <Button
          type="submit"
          className="rounded-full px-5 font-bold"
          disabled={!text.trim() || send.isPending || !viewer}
        >
          Send
        </Button>
      </form>
    </FeedShell>
  );
}
