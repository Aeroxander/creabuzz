/**
 * The profile this account last had, kept on this device so it can follow the person into a community that has none.
 *
 * A profile is a record in a community, so a person's name lives in the communities they have saved it to. Making an
 * account needs no community (and one cannot be made without an account), and joining a second community starts that
 * community with nothing about them: they would appear there as a bare key. So the name and about text are remembered
 * here, whenever they are saved or read, and published to a community that has no profile for this account yet. A
 * profile a community already has is the person's own there and is never replaced.
 *
 * Alias-free; `remembered-profile.test.mjs` drives it under `node --test`.
 */

export interface RememberedProfile {
  /** Whose profile this is: another account on the same browser must never publish it. */
  pubkey: string;
  name: string;
  about?: string;
  picture?: string;
}

export const REMEMBERED_PROFILE_KEY = "buzz.profile.remembered";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const clean = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export function rememberProfile(
  store: Store,
  profile: RememberedProfile,
): void {
  const name = clean(profile.name);
  if (!name || !/^[0-9a-f]{64}$/.test(profile.pubkey)) return;
  const about = clean(profile.about);
  const picture = clean(profile.picture);
  try {
    store.setItem(
      REMEMBERED_PROFILE_KEY,
      JSON.stringify({
        pubkey: profile.pubkey,
        name,
        ...(about ? { about } : {}),
        ...(picture ? { picture } : {}),
      }),
    );
  } catch {
    // Storage is unavailable: nothing is remembered, and the account still works.
  }
}

/** The remembered profile for `pubkey`, or null: nothing kept, someone else's, or not something this wrote. */
export function readRememberedProfile(
  store: Store,
  pubkey: string,
): RememberedProfile | null {
  try {
    const raw = store.getItem(REMEMBERED_PROFILE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const name = clean(value.name);
    if (value.pubkey !== pubkey || !name) return null;
    const about = clean(value.about);
    const picture = clean(value.picture);
    return {
      pubkey,
      name,
      ...(about ? { about } : {}),
      ...(picture ? { picture } : {}),
    };
  } catch {
    return null;
  }
}
