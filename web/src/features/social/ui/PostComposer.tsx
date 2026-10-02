import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";

import { OnboardingDialog } from "@/features/identity/ui/OnboardingDialog";
import {
  profileDisplayName,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import {
  MAX_POST_CHARS,
  type SignedEventLike,
} from "../../feed/lib/feed-events";
import { readMirrorSetting, writeMirrorSetting } from "../../feed/lib/mirror";
import { mentionUri } from "../lib/entity";
import { buildLaunchUpdate } from "../lib/launch-update";
import {
  buildQuote,
  buildSocialPost,
  buildSocialReply,
} from "../lib/post-events";
import { useMyTeamLaunches } from "../use-launch-updates";
import { usePeople } from "../use-people";
import { useSocialPublish } from "../use-social-actions";
import { useFollowing } from "../use-social-data";

const MENTION_QUERY = /(?:^|\s)@([\p{L}\p{N}_]{0,32})$/u;

/** People you follow whose name matches the `@query` being typed. */
function useMentionSuggestions(query: string | null) {
  const me = existingUserPubkey();
  const following = useFollowing(me).data;
  const people = usePeople(following?.slice(0, 200) ?? []);
  return useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return Object.entries(people)
      .filter(([, p]) =>
        [p.name, p.display_name].some((n) => n?.toLowerCase().includes(q)),
      )
      .slice(0, 5);
  }, [people, query]);
}

/**
 * Write a post, a reply or a quote post. Mentions autocomplete from the people
 * you follow; without an identity it offers to create one.
 */
export function PostComposer({
  replyTo,
  quote,
  placeholder = "What's happening?",
  autoFocus = false,
  onPosted,
  testId = "social-composer",
}: {
  replyTo?: { root: SignedEventLike; parent: SignedEventLike } | null;
  quote?: SignedEventLike | null;
  placeholder?: string;
  autoFocus?: boolean;
  onPosted?: () => void;
  testId?: string;
}) {
  const me = existingUserPubkey();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [mirror, setMirror] = useState(readMirrorSetting);
  const [onboarding, setOnboarding] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const publish = useSocialPublish();
  const myProfile = usePeople(me ? [me] : [])[me ?? ""];
  // Launch mode: a post that is an official update for one of your launches.
  const teamLaunches = useMyTeamLaunches();
  const [launchMode, setLaunchMode] = useState(false);
  const [launchKey, setLaunchKey] = useState("");
  const canLaunchMode = !quote && !replyTo && teamLaunches.length > 0;
  const chosenLaunch =
    teamLaunches.find((l) => `${l.author}:${l.id}` === launchKey) ??
    teamLaunches[0];

  const mention = MENTION_QUERY.exec(text.slice(0, caret));
  const suggestions = useMentionSuggestions(mention ? mention[1] : null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  if (!me) {
    return (
      <div className="border-b border-black/10 px-4 py-4 text-sm text-black/70 dark:border-white/10 dark:text-white/70">
        <button
          className="font-semibold underline underline-offset-2"
          data-testid={`${testId}-sign-in`}
          onClick={() => setOnboarding(true)}
          type="button"
        >
          Create your identity
        </button>{" "}
        to post, reply, like and follow. Reading needs no account.
        {onboarding ? (
          <OnboardingDialog
            onDone={() => window.location.reload()}
            onPasskeyDone={() => window.location.reload()}
          />
        ) : null}
      </div>
    );
  }

  const remaining = MAX_POST_CHARS - [...text].length;

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const insertMention = (pubkey: string) => {
    if (!mention) return;
    const start = caret - mention[1].length - 1;
    const uri = `${mentionUri(pubkey)} `;
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
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    let template: ReturnType<typeof buildSocialPost>;
    try {
      template = quote
        ? buildQuote({ text, quoted: quote })
        : replyTo
          ? buildSocialReply({
              text,
              root: replyTo.root,
              parent: replyTo.parent,
            })
          : launchMode && canLaunchMode && chosenLaunch
            ? buildLaunchUpdate({
                text,
                launch: { pubkey: chosenLaunch.author, id: chosenLaunch.id },
              })
            : buildSocialPost(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not post.");
      return;
    }
    writeMirrorSetting(mirror);
    publish.mutate(template, {
      onSuccess: () => {
        setText("");
        setLaunchMode(false);
        if (ref.current) ref.current.style.height = "auto";
        onPosted?.();
      },
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : "Could not post."),
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention((suggestions[active] ?? suggestions[0])[0]);
        return;
      }
      if (e.key === "Escape") {
        setCaret(0);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  };

  const inputId = `${testId}-input`;
  return (
    <form
      className="flex gap-3 border-b border-black/10 px-4 pb-2 pt-3 dark:border-white/10"
      data-testid={testId}
      onSubmit={submit}
    >
      <UserAvatar
        avatarUrl={myProfile?.picture ?? null}
        className="h-10 w-10"
        displayName={resolveUserName(myProfile, me)}
      />
      <div className="relative min-w-0 flex-1">
        <label className="sr-only" htmlFor={inputId}>
          {quote ? "Your comment" : replyTo ? "Your reply" : "Your post"}
        </label>
        <textarea
          className="min-h-12 w-full resize-none bg-transparent pt-2 text-lg text-black outline-none placeholder:text-black/50 dark:text-white dark:placeholder:text-white/40"
          data-testid={inputId}
          id={inputId}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            resize(e.target);
          }}
          onKeyDown={onKeyDown}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          placeholder={placeholder}
          ref={ref}
          rows={1}
          value={text}
        />
        {suggestions.length > 0 ? (
          <div
            aria-label="Mention suggestions"
            className="absolute left-0 top-14 z-30 w-72 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-neutral-900"
            role="listbox"
          >
            {suggestions.map(([pubkey, profile], i) => (
              <button
                aria-selected={i === active}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10",
                  i === active && "bg-black/5 dark:bg-white/10",
                )}
                key={pubkey}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(pubkey);
                }}
                role="option"
                type="button"
              >
                <UserAvatar
                  avatarUrl={profile.picture ?? null}
                  displayName={resolveUserName(profile, pubkey)}
                  size="sm"
                />
                <span className="truncate font-semibold text-black dark:text-white">
                  {profileDisplayName(profile, pubkey)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/10 py-2 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {canLaunchMode ? (
              <span className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-2 font-semibold text-primary-ink">
                  <input
                    checked={launchMode}
                    data-testid={`${testId}-launch-mode`}
                    onChange={(e) => setLaunchMode(e.target.checked)}
                    type="checkbox"
                  />
                  <Megaphone aria-hidden className="h-3.5 w-3.5" />
                  Launch update
                </label>
                {launchMode && teamLaunches.length > 1 ? (
                  <select
                    aria-label="Which launch"
                    className="rounded-md border border-border bg-transparent px-1.5 py-0.5 text-xs"
                    data-testid={`${testId}-launch-pick`}
                    onChange={(e) => setLaunchKey(e.target.value)}
                    value={`${chosenLaunch?.author}:${chosenLaunch?.id}`}
                  >
                    {teamLaunches.map((l) => (
                      <option
                        key={`${l.author}:${l.id}`}
                        value={`${l.author}:${l.id}`}
                      >
                        {l.name}
                      </option>
                    ))}
                  </select>
                ) : launchMode && chosenLaunch ? (
                  <span className="text-muted-foreground">
                    for {chosenLaunch.name}
                  </span>
                ) : null}
              </span>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
              <input
                checked={mirror}
                data-testid={`${testId}-mirror`}
                onChange={(e) => setMirror(e.target.checked)}
                type="checkbox"
              />
              Also share on public Nostr
            </label>
          </div>
          <span className="flex items-center gap-3">
            {remaining < 200 ? (
              <span
                className={cn(
                  "text-xs tabular-nums",
                  remaining < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-black/60 dark:text-white/60",
                )}
              >
                {remaining}
              </span>
            ) : null}
            <Button
              className="rounded-full px-5 font-semibold"
              data-testid={`${testId}-submit`}
              disabled={
                publish.isPending || text.trim() === "" || remaining < 0
              }
              size="sm"
              type="submit"
            >
              {publish.isPending
                ? "Posting…"
                : quote
                  ? "Post"
                  : replyTo
                    ? "Reply"
                    : "Post"}
            </Button>
          </span>
        </div>
      </div>
    </form>
  );
}
