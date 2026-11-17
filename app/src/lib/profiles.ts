import { KIND_PROFILE } from "@creaton/core/kinds.ts";
import {
  indexProfiles,
  type ProfileMetadata,
} from "@creaton/core/social/profiles/index-profiles.ts";
import { personName } from "@creaton/core/social/profiles/user-label.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "./relay";

export type { ProfileMetadata };

/** At most this many people's profiles per read (the server caps `authors` too). */
const PROFILE_BATCH = 100;

const profileKeys = {
  all: ["profiles"] as const,
  many: (pubkeys: readonly string[]) => ["profiles", ...pubkeys] as const,
};

/** Profiles (kind 0) for the people on a screen, one read for all of them. */
export function useProfiles(pubkeys: readonly string[]) {
  const sorted = [...new Set(pubkeys)].sort().slice(0, PROFILE_BATCH);
  return useQuery({
    queryKey: profileKeys.many(sorted),
    enabled: sorted.length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      indexProfiles(
        await read({
          kinds: [KIND_PROFILE],
          authors: sorted,
          limit: sorted.length * 2,
        }),
      ),
  });
}

/** The name to show for a person: their chosen name, or "Someone". */
export function nameOf(
  profiles: Record<string, ProfileMetadata> | undefined,
  pubkey: string,
): string {
  return personName(profiles?.[pubkey]);
}

/** The person's picture, when it is a web address. */
export function pictureOf(
  profiles: Record<string, ProfileMetadata> | undefined,
  pubkey: string,
): string | null {
  const picture = profiles?.[pubkey]?.picture?.trim();
  return picture && /^https:\/\//.test(picture) ? picture : null;
}
