import type { NostrEvent } from "@/shared/lib/nostr-client";

/**
 * One of the server's notes in a room ("Board Tester created this channel"): a quiet centred line with its time. It
 * has no author row and none of a message's actions — nobody wrote it to be replied to or reported.
 */
export function SystemNoteRow({
  event,
  text,
}: {
  event: NostrEvent;
  /** The note as a sentence (`systemNoteText`). */
  text: string;
}) {
  const at = new Date(event.created_at * 1000);
  return (
    <p
      className="flex flex-wrap items-baseline justify-center gap-x-2 px-2 py-1 text-center text-xs text-muted-foreground"
      data-testid="system-note"
    >
      <span>{text}</span>
      <time className="tabular-nums" title={at.toLocaleString()}>
        {at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
    </p>
  );
}
