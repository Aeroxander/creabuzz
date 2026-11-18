/**
 * What a community is called on screen, and the address shown under it.
 *
 * Communities have no display name of their own on the server yet (its directory and info document send none), so the
 * name comes from what is known: a community someone started here is the name they picked (`acme` in
 * `acme.creaton.example`), and the server's own main community carries the product's name. Anything else keeps its
 * address as its name. The address is shown under the name whenever the two differ.
 *
 * Alias-free; `community-label.test.mjs` drives it under `node --test`.
 */

export interface CommunityLabel {
  name: string;
  /** The address, when it is not already the name. */
  address: string | null;
}

/**
 * `host` is the community's address; `domain` is where this server makes new communities (null when it makes none);
 * `appName` names the server's main community.
 */
export function communityLabel(
  host: string,
  domain: string | null,
  appName: string,
): CommunityLabel {
  const address = host.trim();
  const lower = address.toLowerCase();
  const base = domain?.trim().toLowerCase() ?? "";
  let name = address;
  if (base !== "" && lower === base) {
    name = appName;
  } else if (base !== "" && lower.endsWith(`.${base}`)) {
    const picked = lower.slice(0, -(base.length + 1));
    if (picked !== "" && !picked.includes(".")) name = picked;
  }
  return { name, address: name === address ? null : address };
}

/**
 * The communities worth listing to someone browsing: not the one already shown as connected, and not empty ones (no
 * members at all: an address the server answers to that nobody has started).
 */
export function listedCommunities<
  E extends { host: string; member_count: number },
>(entries: readonly E[], connectedHost: string): E[] {
  return entries.filter(
    (entry) => entry.host !== connectedHost && entry.member_count > 0,
  );
}

/**
 * Where the main nav's Communities goes: straight into the connected community when it is the only place there is (the
 * server makes no new ones and lists no others), so a one-card directory is not an extra stop. Null means the
 * directory, which is also the answer while either read is still out or has failed.
 */
export function onlyCommunityHost(
  selfServeEnabled: boolean | undefined,
  listed: readonly { host: string; member_count: number }[] | undefined,
  connectedHost: string,
): string | null {
  if (selfServeEnabled !== false || listed === undefined) return null;
  return listedCommunities(listed, connectedHost).length === 0
    ? connectedHost
    : null;
}
