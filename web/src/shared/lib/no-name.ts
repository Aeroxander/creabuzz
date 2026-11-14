/**
 * What the app calls a person who has not chosen a name, or whose profile is still loading: "Someone", never a short
 * key. A key tells a reader nothing about who someone is, and initials built from one ("42", "A1") look like a name
 * that isn't. Avatars show no initials for it.
 *
 * Alias-free and import-free: `profiles/lib/user-label.ts` reads it under `node --test`.
 */
export const SOMEONE = "Someone";
