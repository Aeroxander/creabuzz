/**
 * A post in a conversation by someone the reader hid, or one the reader reported: one quiet line in its place, with a press to
 * look anyway. Hiding the post outright would break what is around it (an answer others replied to), and a direct link to the
 * post must still say what it is. Anything else shows as it is.
 */
import { type ReactNode, useState } from "react";
import { Button } from "../../ui/button";
import type { SignedEvent } from "../posts/use-posts";
import { HIDDEN_PERSON_LINE, REPORTED_LINE } from "./safety-words";
import { useHidden } from "./use-hidden";
import { whyHidden } from "./visible";

export function FoldedPost({
  event,
  children,
}: {
  event: SignedEvent;
  children: ReactNode;
}) {
  const hidden = useHidden();
  const [shown, setShown] = useState(false);
  const why = whyHidden(event, hidden.rules);
  // Until the hidden list has been read (or could not be), a post is not drawn: a direct link must not show a hidden person's
  // words for a moment and then take them away.
  if (!shown && !hidden.ready)
    return (
      <div
        aria-hidden="true"
        className="min-h-12 animate-pulse rounded-2xl bg-white/10"
        data-testid="folded-wait"
      />
    );
  if (shown || why === null || why === "room") return <>{children}</>;
  return (
    <div
      className="plain flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-2"
      data-testid="folded-post"
    >
      <p className="text-sm text-muted">
        {why === "muted" ? HIDDEN_PERSON_LINE : REPORTED_LINE}
      </p>
      <Button onClick={() => setShown(true)} size="sm" variant="ghost">
        Show <span className="sr-only">this post</span>
      </Button>
    </div>
  );
}
