/**
 * Kind-0 profile publishing for the browser identity.
 */

import {
  mergeProfileContent,
  type ProfileContent,
  type ProfilePatch,
} from "./merge-profile";
import { publishAsUser } from "@/shared/lib/publish-as-user";

export type { ProfilePatch };

/**
 * Publish a kind:0 metadata event signed with the durable identity.
 *
 * `current` is the profile as it exists now (the parsed content of the latest
 * kind-0 event, including fields this client does not know about). It is merged
 * in so an edit here does not delete a picture, NIP-05 handle or payment
 * address set somewhere else — kind 0 is replaceable, so whatever the newest
 * event omits is gone.
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
}
