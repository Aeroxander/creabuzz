import { useSyncExternalStore } from "react";
import { parseSeenProgress, rememberProgress } from "./lib/project-progress";

const STORAGE = "creaton.progress-seen.v1";
const CHANGED = "creaton-progress-seen";
const snapshot = () => {
  try {
    return localStorage.getItem(STORAGE);
  } catch {
    return null;
  }
};
const subscribe = (listener: () => void) => {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGED, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGED, listener);
  };
};

/** Reading state is local and scoped to both the relay and the signed-in identity. */
export function progressScope(
  relay: string,
  account: string | null,
  coordinate: string,
): string {
  return JSON.stringify([relay, account ?? "guest", coordinate]);
}

function markProgress(key: string, ids: readonly string[]): boolean {
  return markProgressBatch([[key, ids]]);
}

function markProgressBatch(
  groups: readonly (readonly [string, readonly string[]])[],
): boolean {
  try {
    let next = parseSeenProgress(snapshot());
    const now = Date.now();
    for (const [key, ids] of groups)
      next = rememberProgress(next, key, ids, now);
    // Marking the shown reports is one user action, even across projects.
    localStorage.setItem(STORAGE, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGED));
    return true;
  } catch {
    return false;
  }
}

/** Browser-local reading snapshots, with one atomic persist per catch-up action. */
export function useProgressSeen() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  return {
    seen: parseSeenProgress(raw),
    mark: markProgress,
    markBatch: markProgressBatch,
  };
}
