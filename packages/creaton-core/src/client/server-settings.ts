/**
 * What the server says about itself in its public information document (`GET /info`), read once before the app draws.
 *
 * Today that is one setting and one key. The setting is `investing`, whether the investing and trading screens are on. The operator sets it on the
 * server (`BUZZ_INVESTING`) and the app follows it with no rebuild. A value the server gives wins; when it gives none
 * (an older server, a server whose operator set nothing, a document that could not be read) the answer is `null` and the
 * build's own switches decide, which are off unless a build turned them on (`features/launchpad/lib/investing-offered.ts`,
 * `trading-offered.ts`).
 *
 * The key is `self`, the key the server signs its own records with (the project numbers), read by `serverRelaySigner()`.
 *
 * The second setting is `trading`: whether buying and selling Shares in a project's pool is offered. No server sends it
 * yet (an operator switch is server work), so it stays off; it counts only where `investing` is on too.
 *
 * Only a plain `true` or `false` counts: anything else (a string, a number, a null) is "says nothing", so a
 * malformed document can never switch money screens on.
 *
 * Alias-free on purpose: `server-settings.test.mjs` drives it under `node --test`.
 */

export interface ServerSettings {
  /** True or false when the server said so; null when it said nothing. */
  investing: boolean | null;
  /** Whether trading in a project's pool is offered; null when the server said nothing (then it is off). */
  trading: boolean | null;
}

const NOTHING: ServerSettings = { investing: null, trading: null };

let current: ServerSettings = NOTHING;

/** The server's own signing key from the same document (its `self` field), or null. */
let currentSigner: string | null = null;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The key the server signs its own records with (the information document's `self` field): the only key whose project
 * numbers the apps believe. Only 64 lower-case hex characters count; anything else is "says nothing".
 */
export function relaySignerFromInfo(info: unknown): string | null {
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const self = (info as { self?: unknown }).self;
  return typeof self === "string" && HEX64.test(self) ? self : null;
}

/** The server's own signing key, or null when it said none (or has not been asked yet). */
export function serverRelaySigner(): string | null {
  return currentSigner;
}

/** The settings in a server's information document; "says nothing" for anything that is not one. */
export function parseServerSettings(info: unknown): ServerSettings {
  if (!info || typeof info !== "object" || Array.isArray(info)) return NOTHING;
  const { investing, trading } = info as {
    investing?: unknown;
    trading?: unknown;
  };
  return {
    investing: typeof investing === "boolean" ? investing : null,
    trading: typeof trading === "boolean" ? trading : null,
  };
}

/** What the server said about investing, or null when it said nothing (or has not been asked yet). */
export function serverInvesting(): boolean | null {
  return current.investing;
}

/** What the server said about trading in the pool, or null when it said nothing (or has not been asked yet). */
export function serverTrading(): boolean | null {
  return current.trading;
}

/** Keep what the server said (or nothing, for a document that could not be read). */
export function applyServerSettings(info: unknown): void {
  current = parseServerSettings(info);
  currentSigner = relaySignerFromInfo(info);
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
