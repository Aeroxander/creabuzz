import { useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { hasNip07Provider } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";
import type { Profile } from "../feed-model";
import { isFeedPreview, usePublishNote } from "../use-feed";
import { Avatar } from "./Avatar";

const SOFT_LIMIT = 280;

export function Composer({
  viewer,
  profile,
  replyTo,
  placeholder = "What's happening?",
  autoFocus = false,
}: {
  viewer: string | null;
  profile?: Profile;
  replyTo?: { id: string; author: string };
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const publish = usePublishNote();
  const canSign = hasNip07Provider() || isFeedPreview();
  const trimmed = text.trim();
  const over = text.length - SOFT_LIMIT;

  function resize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function submit() {
    if (!trimmed || publish.isPending) return;
    publish.mutate(
      { content: trimmed, replyTo },
      {
        onSuccess: () => {
          setText("");
          if (ref.current) ref.current.style.height = "auto";
          toast.success(replyTo ? "Your reply was sent" : "Your post was sent");
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  if (!canSign) {
    return (
      <div className="border-b px-4 py-4 text-[15px] text-muted-foreground">
        Install a Nostr browser extension (NIP-07) to post. You can still read
        everything here.
      </div>
    );
  }

  return (
    <div className="flex gap-3 border-b px-4 pt-3 pb-2">
      <Avatar pubkey={viewer ?? "0"} profile={profile} />
      <div className="min-w-0 flex-1">
        <textarea
          id="composer"
          ref={ref}
          value={text}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: opted in by the thread reply box
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            resize(e.target);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          className="min-h-12 w-full resize-none bg-transparent pt-2 text-xl leading-6 outline-hidden placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-end gap-3 border-t py-2">
          {text.length > 0 && (
            <span
              className={cn(
                "text-sm tabular-nums text-muted-foreground",
                over > 0 && "text-destructive",
              )}
            >
              {over > 0 ? `-${over}` : SOFT_LIMIT - text.length}
            </span>
          )}
          <Button
            size="sm"
            className="rounded-full px-5 font-bold"
            disabled={!trimmed || publish.isPending}
            onClick={submit}
          >
            {replyTo ? "Reply" : "Post"}
          </Button>
        </div>
      </div>
    </div>
  );
}
