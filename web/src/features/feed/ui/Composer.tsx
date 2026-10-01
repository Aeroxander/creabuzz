import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { neventOf, toNpub } from "@/shared/lib/nip19";
import { hasNip07Provider } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";
import type { Profile } from "../feed-model";
import {
  type QuoteTarget,
  type ReplyTarget,
  isFeedPreview,
  usePublishNote,
  useProfiles,
} from "../use-feed";
import { useContacts } from "./../use-social";
import { Avatar, displayNameOf } from "./Avatar";

const SOFT_LIMIT = 280;
const MENTION_QUERY = /(?:^|\s)@([\p{L}\p{N}_]{0,32})$/u;

/** People you follow whose name matches the `@query` being typed. */
function useMentionSuggestions(viewer: string | null, query: string | null) {
  const contacts = useContacts(viewer).data ?? [];
  const profiles = useProfiles(contacts.slice(0, 200)).data;
  return useMemo(() => {
    if (query === null || !profiles) return [];
    const q = query.toLowerCase();
    return [...profiles.values()]
      .filter((p) =>
        [p.name, p.displayName].some((n) => n?.toLowerCase().includes(q)),
      )
      .slice(0, 5);
  }, [profiles, query]);
}

export function Composer({
  viewer,
  profile,
  replyTo,
  quote,
  onSent,
  placeholder = "What's happening?",
  autoFocus = false,
}: {
  viewer: string | null;
  profile?: Profile;
  replyTo?: ReplyTarget;
  /** Quote-post: the note is referenced with a `q` tag and a `nostr:nevent` link. */
  quote?: QuoteTarget;
  onSent?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const publish = usePublishNote();
  const canSign = hasNip07Provider() || isFeedPreview();
  const trimmed = text.trim();
  const over = text.length - SOFT_LIMIT;

  const mention = MENTION_QUERY.exec(text.slice(0, caret));
  const suggestions = useMentionSuggestions(
    viewer,
    mention ? mention[1] : null,
  );

  function resize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function insertMention(pick: Profile) {
    if (!mention) return;
    const start = caret - mention[1].length - 1;
    const uri = `nostr:${toNpub(pick.pubkey)} `;
    const next = text.slice(0, start) + uri + text.slice(caret);
    setText(next);
    setActive(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const pos = start + uri.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
      resize(el);
    });
  }

  function submit() {
    if (!trimmed || publish.isPending) return;
    const content = quote
      ? `${trimmed}\n\nnostr:${neventOf(quote.id, quote.author)}`
      : trimmed;
    publish.mutate(
      { content, replyTo, quote },
      {
        onSuccess: () => {
          setText("");
          onSent?.();
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
        Sign in to post. You can still read everything here.
      </div>
    );
  }

  return (
    <div className="flex gap-3 border-b px-4 pt-3 pb-2">
      <Avatar pubkey={viewer ?? "0"} profile={profile} />
      <div className="relative min-w-0 flex-1">
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
            setCaret(e.target.selectionStart);
            resize(e.target);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive(
                  (i) => (i + step + suggestions.length) % suggestions.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(suggestions[active] ?? suggestions[0]);
                return;
              }
              if (e.key === "Escape") {
                setCaret(0);
                return;
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          className="min-h-12 w-full resize-none bg-transparent pt-2 text-xl leading-6 outline-hidden placeholder:text-muted-foreground"
        />
        {suggestions.length > 0 && (
          <div
            role="listbox"
            aria-label="Mention suggestions"
            className="absolute top-14 left-0 z-30 w-72 overflow-hidden rounded-xl border bg-popover py-1 shadow-lg"
          >
            {suggestions.map((s, i) => (
              <button
                key={s.pubkey}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(s);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[15px] hover:bg-foreground/5",
                  i === active && "bg-foreground/5",
                )}
              >
                <Avatar pubkey={s.pubkey} profile={s} className="h-8 w-8" />
                <span className="min-w-0">
                  <span className="block truncate font-bold leading-4">
                    {displayNameOf(s.pubkey, s)}
                  </span>
                  {s.name && (
                    <span className="block truncate text-sm leading-4 text-muted-foreground">
                      @{s.name}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
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
