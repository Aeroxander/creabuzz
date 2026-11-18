import * as React from "react";

const STORAGE_PREFIX = "buzz.launchpad.followed.";

function storageKey(relayUrl: string | null | undefined): string {
  return `${STORAGE_PREFIX}${relayUrl ?? "local"}`;
}

function readFollowed(relayUrl: string | null | undefined): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(relayUrl));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** Local per-community follow set for launches. Display preference only. */
export function useFollowedLaunches(relayUrl: string | null | undefined) {
  const [followed, setFollowed] = React.useState<Set<string>>(() =>
    readFollowed(relayUrl),
  );
  React.useEffect(() => {
    setFollowed(readFollowed(relayUrl));
  }, [relayUrl]);
  const toggle = React.useCallback(
    (key: string) => {
      setFollowed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          localStorage.setItem(storageKey(relayUrl), JSON.stringify([...next]));
        } catch {
          // Storage full or unavailable — the in-memory set still applies.
        }
        return next;
      });
    },
    [relayUrl],
  );
  return { followed, toggle };
}

export function launchFollowKey(author: string, launchId: string): string {
  return `${author}:${launchId}`;
}
