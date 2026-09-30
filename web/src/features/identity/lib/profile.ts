/**
 * Kind-0 profile publishing for the browser identity.
 */

import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";

import {
  mergeProfileContent,
  type ProfileContent,
  type ProfilePatch,
} from "./merge-profile";

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
  const signed = await signAsUser({
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
  });
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) {
    throw new Error(result.message ?? "profile publish rejected");
  }
}
