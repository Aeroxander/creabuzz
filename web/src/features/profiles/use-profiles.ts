import { useQuery } from "@tanstack/react-query";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";

/** Nostr profile (kind 0 metadata content). */
export interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
}

const KIND_METADATA = 0;

async function fetchProfiles(authors: string[]): Promise<Profile[]> {
  if (authors.length === 0) return [];
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_METADATA],
    authors,
    limit: authors.length,
  });
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    const previous = latest.get(event.pubkey);
    if (!previous || event.created_at > previous.created_at) {
      latest.set(event.pubkey, event);
    }
  }
  const profiles: Profile[] = [];
  for (const event of latest.values()) {
    try {
      const parsed = JSON.parse(event.content) as Profile;
      profiles.push(parsed);
    } catch {
      // malformed metadata — treated as absent
    }
  }
  return profiles;
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
  profile: Profile | undefined,
  pubkey: string,
): string {
  const raw = profile?.display_name ?? profile?.name;
  if (raw && raw.trim().length > 0) return raw;
  return truncatePubkey(pubkey);
}
