/**
 * What a post calls its author while their profile loads, or when they never chose a name: "Someone", never a short
 * key. The rule is the app's one rule for naming people (`profiles/lib/user-label.ts`, which `resolveUserName` uses
 * too); these are the byline names for it. The person's page still has their full key for anyone who needs it.
 *
 * Alias-free for `node --test`.
 */

import {
  personName,
  pickUserHandle,
  pickUserName,
  SOMEONE,
  type UserNameProfile,
} from "../../profiles/lib/user-label.ts";

/** The byline for someone with no name (yet). */
export { SOMEONE };

/** A person's name for a byline: the name they chose, or "Someone". */
export function bylineName(
  profile: UserNameProfile | undefined | null,
): string {
  return personName(profile);
}

/** Their `user@host` username, shown beside the name, or null when they have none. */
export function bylineHandle(
  profile: UserNameProfile | undefined | null,
): string | null {
  return pickUserHandle(profile);
}

/** What an avatar builds its initials from: the chosen name, or nothing, so no initials come from a key. */
export function avatarName(
  profile: UserNameProfile | undefined | null,
): string {
  return pickUserName(profile) ?? "";
}
