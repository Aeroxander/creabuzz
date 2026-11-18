import type { StatusTone } from "../lib/post-status";

/** Colours for a decision's state pill, matching the decision card. */
export const TONE_CLASS: Record<StatusTone, string> = {
  open: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  good: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  wait: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  bad: "bg-red-500/15 text-red-800 dark:text-red-300",
  done: "bg-muted text-muted-foreground",
};
