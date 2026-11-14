import { useCallback, useEffect, useState } from "react";

/** How long a saved change may take to show on the record read back before the page stops waiting for it. */
const SHOWN_WITHIN_MS = 30_000;

/** Why a saved change is no longer waited for without having shown. */
export type LostChange = "replaced" | "not-shown";

/** What to tell the person, by why. */
export const LOST_CHANGE_WORDS: Record<LostChange, string> = {
  replaced:
    "The project's record was saved again without this change, so it did not last. Check the page, then try again.",
  "not-shown":
    "The server took this change but has not shown it back yet. Reload the page to see what it has before trying again.",
};

interface Waiting {
  key: string;
  /**
   * When the record that carries the change was signed, once the save went through; null while it is being sent.
   * A record signed later than this, without the change, replaced it; one signed earlier is only the server being
   * slow to show the newer one.
   */
  signedAt: number | null;
  /** When the save went through, by this browser's clock: how long the page has waited for it to show. */
  savedAt: number;
}

/**
 * Changes the person just made to a record, held until the record read back agrees with each.
 *
 * A change shows at once on the page (the server can take seconds to show a record back), but what the page shows
 * must end up being what the record says. So a change stays "waiting" until the record read back shows it; if a
 * newer record arrives without it (another save replaced it), or none arrives in time, the change is dropped from
 * the page and `onLost` is told why, so the page can say so instead of showing it for ever.
 *
 * `recordAt` is when the record the page shows now was signed; `agrees(key)` says whether that record shows the change.
 */
export function useRecordAgreement(
  recordAt: number,
  agrees: (key: string) => boolean,
  onLost: (key: string, why: LostChange) => void,
) {
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const begin = useCallback(
    (key: string) =>
      setWaiting((was) => [
        ...was.filter((w) => w.key !== key),
        { key, signedAt: null, savedAt: 0 },
      ]),
    [],
  );
  /** The save went through: `signedAt` is when the record that carries the change was signed. */
  const saved = useCallback(
    (key: string, signedAt: number) =>
      setWaiting((was) =>
        was.map((w) =>
          w.key === key ? { ...w, signedAt, savedAt: Date.now() } : w,
        ),
      ),
    [],
  );
  const drop = useCallback(
    (key: string) => setWaiting((was) => was.filter((w) => w.key !== key)),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `agrees` and `onLost` read the render they were made in
  useEffect(() => {
    if (waiting.length === 0) return;
    const settle = () => {
      const lost: Array<[string, LostChange]> = [];
      const left = waiting.filter((w) => {
        if (agrees(w.key)) return false;
        if (w.signedAt === null) return true;
        // A record signed after the one that carried the change, and the change is not on it.
        if (recordAt > w.signedAt) {
          lost.push([w.key, "replaced"]);
          return false;
        }
        if (Date.now() - w.savedAt >= SHOWN_WITHIN_MS) {
          lost.push([w.key, "not-shown"]);
          return false;
        }
        return true;
      });
      if (left.length !== waiting.length) setWaiting(left);
      for (const [key, why] of lost) onLost(key, why);
    };
    settle();
    if (!waiting.some((w) => w.signedAt !== null)) return;
    const timer = window.setInterval(settle, 2_000);
    return () => window.clearInterval(timer);
  }, [waiting, recordAt]);

  return {
    /** The changes shown ahead of the record. */
    waiting: waiting.map((w) => w.key),
    begin,
    saved,
    drop,
  };
}
