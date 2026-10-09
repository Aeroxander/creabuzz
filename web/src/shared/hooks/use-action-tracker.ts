import { useCallback, useState } from "react";

/**
 * Which actions are in flight and which failed, by key.
 *
 * A row's buttons are disabled while its key is in `acting`, and show the
 * `errors` entry (kept until the next attempt on that key) so the same button
 * retries.
 */
export function useActionTracker() {
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const setActingFor = useCallback((key: string, on: boolean) => {
    setActing((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const clearError = useCallback((key: string) => {
    setErrors((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  const failWith = useCallback(
    (key: string, error: unknown, fallback: string) => {
      setErrors((current) =>
        new Map(current).set(
          key,
          error instanceof Error && error.message ? error.message : fallback,
        ),
      );
    },
    [],
  );

  return { acting, errors, setActingFor, clearError, failWith };
}
