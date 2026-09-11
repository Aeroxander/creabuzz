import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { indexProfiles, type ProfileMetadata } from "./lib/index-profiles";

export type { ProfileMetadata as Profile };

/** Profiles keyed by author pubkey — never by position in a query result. */
export type ProfilesByPubkey = Record<string, ProfileMetadata>;

const KIND_METADATA = 0;

async function fetchProfiles(authors: string[]): Promise<ProfilesByPubkey> {
  if (authors.length === 0) return {};
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_METADATA],
    authors,
    limit: authors.length,
  });
  return indexProfiles(events);
}

/** Resolve display names/avatars for the visible author set (capped). */
export function useProfiles(authors: string[]) {
  const bounded = authors.slice(0, 60);
  return useQuery({
    queryKey: ["profiles", [...bounded].sort().join(",")],
    queryFn: () => fetchProfiles(bounded),
    enabled: bounded.length > 0,
    staleTime: 5 * 60_000,
  });
}

/** Title-case-ish display name for a profile, falling back to truncated npub. */
export function profileDisplayName(
  profile: ProfileMetadata | undefined,
  pubkey: string,
): string {
  const raw = profile?.display_name ?? profile?.name;
  if (raw && raw.trim().length > 0) return raw;
  return truncatePubkey(pubkey);
}
