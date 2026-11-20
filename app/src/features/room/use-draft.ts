/**
 * An unsent post kept while the person looks at another tab, so switching away does not lose it. Per project, in this
 * browser's session only (it is gone when the tab is closed), every access inside `try`: with no storage it simply is not kept.
 */
import { useCallback, useState } from "react";

const PREFIX = "creaton.room.draft.";

function load(key: string): string {
  if (key === "") return "";
  try {
    return sessionStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function useDraft(key: string): [string, (text: string) => void] {
  const [text, setText] = useState(() => load(key));
  const set = useCallback(
    (next: string) => {
      setText(next);
      // An empty key is a box whose text is kept in the box only (an answer).
      if (key === "") return;
      try {
        if (next) sessionStorage.setItem(PREFIX + key, next);
        else sessionStorage.removeItem(PREFIX + key);
      } catch {
        // Not kept: the text is still in the box.
      }
    },
    [key],
  );
  return [text, set];
}

/** Drops every unsent room post this tab kept, so the next person to sign in on it never sees the last one's words. */
export function forgetRoomDrafts(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // No storage: nothing was kept.
  }
}
