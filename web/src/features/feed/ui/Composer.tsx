import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { OnboardingDialog } from "@/features/identity/ui/OnboardingDialog";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import {
  buildPost,
  buildReply,
  type LaunchRef,
  MAX_POST_CHARS,
  type SignedEventLike,
} from "../lib/feed-events";
import { readMirrorSetting, writeMirrorSetting } from "../lib/mirror";
import { usePublishFeedEvent } from "../use-feed";

/**
 * Write a post (optionally about a launch) or a reply in a thread. Without an
 * identity it offers to create one instead of a dead button.
 */
export function Composer({
  launch,
  replyTo,
  placeholder = "What are you building or backing?",
  onPosted,
  testId = "composer",
}: {
  launch?: LaunchRef | null;
  /** When set, the composer writes a reply in this thread. */
  replyTo?: { root: SignedEventLike; parent: SignedEventLike } | null;
  placeholder?: string;
  onPosted?: () => void;
  testId?: string;
}) {
  const [text, setText] = useState("");
  const [mirror, setMirror] = useState(readMirrorSetting);
  const [onboarding, setOnboarding] = useState(false);
  const publish = usePublishFeedEvent();
  const signedIn = existingUserPubkey() !== null;

  if (!signedIn) {
    return (
      <div className="rounded-xl border border-dashed border-black/20 p-3 text-sm text-black/70 dark:border-white/20 dark:text-white/70">
        <button
          className="font-medium underline underline-offset-2"
          data-testid={`${testId}-sign-in`}
          onClick={() => setOnboarding(true)}
          type="button"
        >
          Create your identity
        </button>{" "}
        to post, reply and vote.
        {onboarding ? (
          <OnboardingDialog
            onDone={() => window.location.reload()}
            onPasskeyDone={() => window.location.reload()}
          />
        ) : null}
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let template: ReturnType<typeof buildPost>;
    try {
      template = replyTo
        ? buildReply({ text, root: replyTo.root, parent: replyTo.parent })
        : buildPost({ text, launch });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not post.");
      return;
    }
    writeMirrorSetting(mirror);
    publish.mutate(template, {
      onSuccess: () => {
        setText("");
        onPosted?.();
      },
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : "Could not post."),
    });
  };

  const inputId = `${testId}-input`;
  const remaining = MAX_POST_CHARS - [...text].length;
  return (
    <form
      className="glass rounded-xl border p-3"
      data-testid={testId}
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor={inputId}>
        {replyTo ? "Your reply" : "Your post"}
      </label>
      <textarea
        className="min-h-20 w-full resize-y bg-transparent text-sm text-black outline-none placeholder:text-black/50 dark:text-white dark:placeholder:text-white/40"
        data-testid={inputId}
        id={inputId}
        maxLength={MAX_POST_CHARS * 2}
        onChange={(e) => setText(e.target.value)}
        placeholder={replyTo ? "Write a reply" : placeholder}
        value={text}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <input
            checked={mirror}
            data-testid={`${testId}-mirror`}
            onChange={(e) => setMirror(e.target.checked)}
            type="checkbox"
          />
          Also share on public Nostr
        </label>
        <span className="flex items-center gap-2">
          {remaining < 200 ? (
            <span
              className={`text-xs tabular-nums ${
                remaining < 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-black/60 dark:text-white/60"
              }`}
            >
              {remaining}
            </span>
          ) : null}
          <Button
            data-testid={`${testId}-submit`}
            disabled={publish.isPending || text.trim() === "" || remaining < 0}
            size="sm"
            type="submit"
          >
            {publish.isPending ? "Posting…" : replyTo ? "Reply" : "Post"}
          </Button>
        </span>
      </div>
    </form>
  );
}
