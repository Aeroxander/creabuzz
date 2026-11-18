import { useMemo } from "react";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";

import { typingSummaryLabel, type TypingEntry } from "../lib/typing";

/**
 * The typing line above the composer: "X is typing…". Always mounted so the
 * polite live region exists before the text changes (screen readers announce
 * updates, not late-attached regions); empty content collapses to the
 * reserved one-line height so the composer never jumps.
 */
export function TypingIndicator({
  entries,
}: {
  entries: readonly TypingEntry[];
}) {
  const pubkeys = useMemo(
    () => entries.map((entry) => entry.pubkey),
    [entries],
  );
  const profiles = useProfiles(pubkeys);
  const label = typingSummaryLabel(
    entries.map((entry) =>
      resolveUserName(profiles.data?.[entry.pubkey], entry.pubkey),
    ),
  );

  return (
    <div
      aria-live="polite"
      className="h-4 text-2xs text-muted-foreground"
      data-testid="typing-indicator"
    >
      {label}
    </div>
  );
}
