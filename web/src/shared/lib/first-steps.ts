/**
 * Things a person has done in this browser that the Start page can tick off
 * honestly: finishing a project from a template, for one.
 *
 * Kept in this browser's storage, so a step is ticked only for what happened
 * here; a new device simply asks again. Alias free; `first-steps.test.mjs` drives it under `node --test`.
 */

/** The step names. A new one is added here, then recorded where it happens. */
export type FirstStep = "project";

const KEY = "creaton.first-steps";

/** The part of `Storage` this needs, so tests can pass a plain object. */
export interface StepStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(storage: StepStorage): Set<string> {
  try {
    const raw = storage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Has this step happened in this browser? A broken or missing store says no. */
export function hasFirstStep(storage: StepStorage, step: FirstStep): boolean {
  return read(storage).has(step);
}

/** Remember a step. Storage that refuses is ignored: the page just asks again. */
export function markFirstStep(storage: StepStorage, step: FirstStep): void {
  try {
    const steps = read(storage);
    if (steps.has(step)) return;
    steps.add(step);
    storage.setItem(KEY, JSON.stringify([...steps]));
  } catch {
    // Not remembered; the step shows as not done next time.
  }
}
