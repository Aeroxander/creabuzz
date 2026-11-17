/**
 * What the server says about itself in its public information document (`GET /info`), read once before the app draws.
 *
 * Today that is one setting: `investing`, whether the investing and trading screens are on. The operator sets it on the
 * server (`BUZZ_INVESTING`) and the app follows it with no rebuild. A value the server gives wins; when it gives none
 * (an older server, a server whose operator set nothing, a document that could not be read) the answer is `null` and the
 * build's own switches decide, which are off unless a build turned them on (`features/launchpad/lib/investing-offered.ts`,
 * `trading-offered.ts`).
 *
 * Only a plain `true` or `false` counts: anything else (a string, a number, a null) is "says nothing", so a
 * malformed document can never switch money screens on.
 *
 * Alias-free on purpose: `server-settings.test.mjs` drives it under `node --test`.
 */

export interface ServerSettings {
  /** True or false when the server said so; null when it said nothing. */
  investing: boolean | null;
}

const NOTHING: ServerSettings = { investing: null };

let current: ServerSettings = NOTHING;

/** The settings in a server's information document; "says nothing" for anything that is not one. */
export function parseServerSettings(info: unknown): ServerSettings {
  if (!info || typeof info !== "object" || Array.isArray(info)) return NOTHING;
  const investing = (info as { investing?: unknown }).investing;
  return { investing: typeof investing === "boolean" ? investing : null };
}

/** What the server said about investing, or null when it said nothing (or has not been asked yet). */
export function serverInvesting(): boolean | null {
  return current.investing;
}

/** Keep what the server said (or nothing, for a document that could not be read). */
export function applyServerSettings(info: unknown): void {
  current = parseServerSettings(info);
}

/**
 * Ask for the settings once, before the app draws. Never throws and never waits past `fetchInfo`'s own deadline: a server
 * that does not answer leaves the settings as "says nothing", so the app opens with the build's own switches.
 */
export async function loadServerSettings(
  fetchInfo: () => Promise<unknown>,
): Promise<void> {
  try {
    applyServerSettings(await fetchInfo());
  } catch {
    applyServerSettings(null);
  }
}
