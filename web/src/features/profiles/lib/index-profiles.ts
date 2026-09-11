/**
 * Index kind-0 metadata events by their author.
 *
 * The profile lookup used to return an array that every caller zipped against
 * its own author list by position, which only works when the relay answers with
 * exactly one event per requested author in the same order. In practice an
 * author without a profile shortened the array and every later author inherited
 * the previous one's name and avatar — messages attributed to the wrong person.
 *
 * Alias-free so `index-profiles.test.mjs` can drive it under `node --test`.
 */

export interface ProfileMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
}

export interface MetadataEvent {
  pubkey: string;
  created_at: number;
  content: string;
}

/** Newest metadata per pubkey, parsed; malformed content is treated as absent. */
export function indexProfiles(
  events: MetadataEvent[],
): Record<string, ProfileMetadata> {
  const newest = new Map<string, MetadataEvent>();
  for (const event of events) {
    const previous = newest.get(event.pubkey);
    if (!previous || event.created_at > previous.created_at) {
      newest.set(event.pubkey, event);
    }
  }
  const profiles: Record<string, ProfileMetadata> = {};
  for (const [pubkey, event] of newest) {
    try {
      const parsed = JSON.parse(event.content) as ProfileMetadata;
      if (parsed && typeof parsed === "object") profiles[pubkey] = parsed;
    } catch {
      // Malformed metadata — treat as absent rather than failing the batch.
    }
  }
  return profiles;
}
