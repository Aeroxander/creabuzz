/**
 * Which tab a profile opens on. Someone who founded a project or has work on a record opens on "Record", because that is
 * what a visitor came to read; everyone else opens on "Posts". The choice waits for the record read: until it has
 * finished nothing is guessed, and a read that failed keeps "Posts" and says so. A tab named in the address, or one the
 * reader already pressed, always wins.
 *
 * Pure and alias-free: `profile-tab.test.mjs` drives it under `node --test`.
 */

export type ProfileTab =
  | "posts"
  | "replies"
  | "media"
  | "likes"
  | "launches"
  | "record";

const TABS: readonly ProfileTab[] = [
  "posts",
  "replies",
  "media",
  "likes",
  "launches",
  "record",
];

/** How the record read stands. */
export type RecordRead = "pending" | "failed" | "done";

/** The tab an address names (`/u/<person>#record`), or null when it names none. */
export function tabFromHash(hash: string): ProfileTab | null {
  const name = hash.replace(/^#/, "");
  return (TABS as readonly string[]).includes(name)
    ? (name as ProfileTab)
    : null;
}

/**
 * The tab to open on, or "pending" while the record is still being read (the page then waits rather than showing
 * "Posts" and moving the reader to "Record" a moment later).
 */
export function defaultProfileTab(input: {
  read: RecordRead;
  /** The person founded a project. */
  foundedProject: boolean;
  /** The person has work on a record: finished, checked or in progress. */
  hasWork: boolean;
}): ProfileTab | "pending" {
  if (input.read === "pending") return "pending";
  if (input.read === "failed") return "posts";
  return input.foundedProject || input.hasWork ? "record" : "posts";
}
