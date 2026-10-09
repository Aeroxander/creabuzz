import { useCallback, useEffect, useRef, useState } from "react";

/** Auto-refresh runs at most this long without a person asking; then it pauses. */
export const POLL_DEADLINE_MS = 15 * 60_000;

/**
 * A refresh that repeats on a timer but never forever (Review-Proven Rule 4).
 *
 * `load` fetches and writes state. While `enabled`, it runs once at once and
 * then every `intervalMs`. A timer tick does not extend the deadline: only a
 * person does, through the returned `refresh` (a Refresh button, or after an
 * action of theirs). Once the deadline passes the timer stops loading and
 * `paused` turns true, so the screen can say so and offer that button.
 */
export function useBoundedPoll(
  load: () => Promise<void>,
  enabled: boolean,
  intervalMs: number,
): { paused: boolean; refresh: () => Promise<void> } {
  const [paused, setPaused] = useState(false);
  const deadlineRef = useRef(Date.now() + POLL_DEADLINE_MS);

  const refresh = useCallback(async () => {
    deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
    setPaused(false);
    await load();
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = window.setInterval(() => {
      if (Date.now() >= deadlineRef.current) {
        setPaused(true);
        return;
      }
      void load();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, load, refresh]);

  return { paused, refresh };
}
