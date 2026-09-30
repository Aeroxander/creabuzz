import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { indexProfiles, type ProfileMetadata } from "./lib/index-profiles";
import { pickUserHandle, pickUserName } from "./lib/user-label";

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

/**
 * The username to show for a person: `display_name`, then the kind-0 `name`,
 * then the community NIP-05 username, and only then the truncated pubkey.
 *
 * One chain for the whole client — a surface that renders a person imports this
 * instead of picking its own fallback, which is how the fleet and launchpad
 * panels ended up showing raw hex next to people who had names.
 */
export function resolveUserName(
  profile: ProfileMetadata | undefined,
  pubkey: string,
): string {
  return pickUserName(profile) ?? truncatePubkey(pubkey);
}

/**
 * The plain name used for mention insert text, falling back to a truncated npub.
 *
 * Deliberately NOT `resolveUserName`: a mention inserts this string literally
 * after `@`, so a NIP-05 username would produce `@alice@relay.example` — a
 * malformed mention. Mentions need a bare name; every other surface wants the
 * username.
 */
export function profileDisplayName(
  profile: ProfileMetadata | undefined,
  pubkey: string,
): string {
  const raw = profile?.display_name ?? profile?.name;
  if (raw && raw.trim().length > 0) return raw;
  return truncatePubkey(pubkey);
}

/**
 * The secondary line for a person: their community username (`user@host`) when
 * they have one, otherwise the truncated pubkey.
 *
 * The pubkey is a recognition aid and never the identity proof, so it stays the
 * fallback — but a username is what a reader can actually use.
 */
export function resolveUserSecondaryName(
  profile: ProfileMetadata | undefined,
  pubkey: string,
): string {
  return pickUserHandle(profile) ?? truncatePubkey(pubkey);
}

/**
 * Usernames for the people a surface is about to render.
 *
 * Pass every pubkey the surface will show and ask the returned function for
 * each label. The whole set resolves in one batched kind-0 query, so a board
 * with twenty rows costs one request rather than twenty.
 */
export function useUserNames(pubkeys: string[]): (pubkey: string) => string {
  const { data: profiles } = useProfiles(pubkeys);
  return useCallback(
    (pubkey: string) => resolveUserName(profiles?.[pubkey], pubkey),
    [profiles],
  );
}
