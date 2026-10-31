import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { indexProfiles, type ProfileMetadata } from "./lib/index-profiles";
import {
  hasUserName as profileHasName,
  personName,
  personSecondaryLabel,
  pickUserHandle,
} from "./lib/user-label";

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
 * What to call a person in main copy: `display_name`, then the kind-0 `name`, then the community NIP-05 username, and
 * "Someone" when they have none (or their profile is still loading). Never a short key: a key tells a reader nothing
 * about who someone is (`profiles/lib/user-label.ts` holds the rule; post bylines use the same one).
 *
 * One chain for the whole client: a surface that renders a person imports this instead of picking its own fallback.
 * `pubkey` is the person this is for; no part of the name is ever made from it.
 */
export function resolveUserName(
  profile: ProfileMetadata | undefined,
  _pubkey: string,
): string {
  return personName(profile);
}

/** Whether the person has chosen a name. Use this to tell "no name" apart, never a comparison with a short key. */
export function hasUserName(profile: ProfileMetadata | undefined): boolean {
  return profileHasName(profile);
}

/** Their `user@host` community username, or null. */
export function resolveUserHandle(
  profile: ProfileMetadata | undefined,
): string | null {
  return pickUserHandle(profile);
}

/**
 * The plain name used for mention insert text, falling back to a truncated key.
 *
 * Deliberately NOT `resolveUserName`: a mention inserts this string literally after `@`, so it must name exactly one
 * person ("@Someone" would not), and a NIP-05 username would produce `@alice@relay.example`, a malformed mention.
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
 * The quiet secondary line for a person: their community username (`user@host`) when they have one; for someone with
 * no name, their short key, so two "Someone"s can be told apart; otherwise null. A short key is never printed beside a
 * real name as if it were a handle. Render it in a quiet style, and render nothing for null.
 */
export function resolveUserSecondaryName(
  profile: ProfileMetadata | undefined,
  pubkey: string,
): string | null {
  return personSecondaryLabel(profile, pubkey);
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
