/**
 * Kind-0 profile publishing for the browser identity.
 */

import {
  mergeProfileContent,
  type ProfileContent,
  type ProfilePatch,
} from "./merge-profile";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { readRememberedProfile, rememberProfile } from "./remembered-profile";

export type { ProfilePatch };

/**
 * Publish a kind:0 metadata event signed with the durable identity.
 *
 * `current` is the profile as it exists now (the parsed content of the latest
 * kind-0 event, including fields this client does not know about). It is merged
 * in so an edit here does not delete a picture, NIP-05 handle or payment
 * address set somewhere else — kind 0 is replaceable, so whatever the newest
 * event omits is gone.
 *
 * What was saved is remembered on this device, to follow the person into a community that has no profile for them.
 */
export async function publishProfile(
  patch: ProfilePatch,
  current?: ProfileContent | null,
): Promise<void> {
  const content = mergeProfileContent(current, patch);
  await publishAsUser(
    {
      kind: 0,
      tags: [],
      content: JSON.stringify(content),
    },
    "profile publish rejected",
  );
  rememberOwnProfile(content);
}

/** Remember the signed-in account's profile (what it was saved as, or what a community says it is). */
export function rememberOwnProfile(content: Record<string, unknown>): void {
  const pubkey = existingUserPubkey();
  const name = content.display_name ?? content.name;
  if (!pubkey || typeof name !== "string") return;
  rememberProfile(window.localStorage, {
    pubkey,
    name,
    about: typeof content.about === "string" ? content.about : undefined,
    picture: typeof content.picture === "string" ? content.picture : undefined,
  });
}

/**
 * Save a name typed at sign-up. The account exists whether or not this works (making one needs no server), so a failure
 * is not the account's: the name is remembered on this device and saved by [`publishRememberedProfile`] the first time
 * a community answers. Never throws; true when it was saved now.
 */
export async function saveNewProfile(patch: {
  name: string;
  about?: string | undefined;
}): Promise<boolean> {
  const pubkey = existingUserPubkey();
  if (pubkey) rememberProfile(window.localStorage, { pubkey, ...patch });
  try {
    await publishProfile(patch);
    return true;
  } catch {
    return false;
  }
}

let publishing: Promise<boolean> | null = null;

/**
 * Give the community now connected the profile this account last had, if that community has none for it. A profile a
 * community already has is the person's own there and is never replaced. Safe to call on every load: one run at a time,
 * nothing to do without a remembered profile, and a failure leaves it remembered for the next call. True when a
 * profile was published.
 */
export function publishRememberedProfile(): Promise<boolean> {
  publishing ??= (async () => {
    const pubkey = existingUserPubkey();
    if (!pubkey) return false;
    const remembered = readRememberedProfile(window.localStorage, pubkey);
    if (!remembered) return false;
    try {
      const existing = await queryEvents(relayWsUrl(), {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      });
      if (existing.length > 0) return false;
      await publishProfile({
        name: remembered.name,
        about: remembered.about,
        picture: remembered.picture,
      });
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    publishing = null;
  });
  return publishing;
}
