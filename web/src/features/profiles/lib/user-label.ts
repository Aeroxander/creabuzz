/**
 * What to call a person.
 *
 * The desktop client resolves a username for every person it renders —
 * `display_name`, then the kind-0 `name`, then the NIP-05 handle, and only
 * then the pubkey. The web client grew its own version of that chain one
 * surface at a time, so the newer panels (fleet, board, launchpad, repos)
 * labelled people with raw hex while the channel timeline showed a name.
 *
 * This is the one place that decides a username. It stays free of imports so
 * `user-label.test.mjs` can drive it under `node --test`; the pubkey fallback
 * lives in `../use-profiles`, which owns the `@/` import.
 *
 * Alias-free and import-free on purpose.
 */

/** The profile fields a username can come from (kind-0 metadata). */
export interface UserNameProfile {
  name?: string;
  display_name?: string;
  nip05?: string;
}

function firstNonEmpty(
  values: Array<string | undefined | null>,
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * The username for a profile, or `null` when the person has set none.
 *
 * Order matches the desktop client: `display_name` is the human name a person
 * chose, `name` is the older kind-0 field carried by most existing profiles,
 * and `nip05` is the community username (`user@host`) that the relay keeps
 * unique per community.
 */
export function pickUserName(
  profile: UserNameProfile | undefined | null,
): string | null {
  if (!profile) return null;
  return firstNonEmpty([profile.display_name, profile.name, profile.nip05]);
}

/**
 * The `user@host` community username for a profile, or `null`.
 *
 * Surfaces that already show a display name use this as the secondary label,
 * so the unique username stays reachable without crowding the name.
 */
export function pickUserHandle(
  profile: UserNameProfile | undefined | null,
): string | null {
  if (!profile) return null;
  return firstNonEmpty([profile.nip05]);
}

/**
 * The `@local` form of a NIP-05 username (`alice@relay.example` → `@alice`).
 *
 * `null` when the value is not a handle, so a caller can fall back instead of
 * rendering a malformed `@`.
 */
export function handleToAtName(
  handle: string | null | undefined,
): string | null {
  const trimmed = handle?.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf("@");
  // A handle without a domain is malformed rather than a username; treat it as
  // absent so a caller falls back instead of rendering `@alice`.
  if (at <= 0 || at === trimmed.length - 1) return null;
  return `@${trimmed.slice(0, at)}`;
}
