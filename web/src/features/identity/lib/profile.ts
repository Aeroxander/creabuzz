/**
 * Kind-0 profile publishing for the browser identity.
 */

import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";

export interface ProfileInput {
  name?: string;
  about?: string;
  picture?: string | null;
}

/** Publish a kind:0 metadata event signed with the durable identity. */
export async function publishProfile(input: ProfileInput): Promise<void> {
  const signed = await signAsUser({
    kind: 0,
    tags: [],
    content: JSON.stringify({
      name: input.name?.trim() || undefined,
      display_name: input.name?.trim() || undefined,
      about: input.about?.trim() || undefined,
      picture: input.picture ?? undefined,
    }),
  });
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) {
    throw new Error(result.message ?? "profile publish rejected");
  }
}
