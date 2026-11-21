/**
 * The earlier backers' claim page exists only where the build is given all three of its settings (`VITE_CREATON_EARLIER_CONTRACT`,
 * `VITE_CREATON_EARLIER_TEXT_HASH` and `VITE_CREATON_EARLIER_TEXT_URL`, `app/.env.example`). Without them the route is not in the
 * router at all and no code of the page loads. Everything here ends up in the page every visitor downloads: an address, a
 * fingerprint and a link to a text, never a row of the list and never a key.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** What the build was given, checked and in lower case where it is hex. */
export interface EarlierGrantSettings {
  /** The claim contract (`EarlierGrants`). */
  contract: string;
  /** The fingerprint of the text a claimant accepts. */
  textHash: string;
  /** Where the text can be read: an http or https address with no name or password in it. */
  textUrl: string;
}

/** The three settings, or null when any is missing or is not what it must be (then there is no claim page). */
export function earlierGrantSettings(
  env: Readonly<Record<string, unknown>> = import.meta.env,
): EarlierGrantSettings | null {
  const contract = env.VITE_CREATON_EARLIER_CONTRACT;
  const textHash = env.VITE_CREATON_EARLIER_TEXT_HASH;
  const textUrl = env.VITE_CREATON_EARLIER_TEXT_URL;
  if (typeof contract !== "string" || !ADDRESS.test(contract)) return null;
  if (typeof textHash !== "string" || !HASH.test(textHash)) return null;
  if (typeof textUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(textUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return {
    contract: contract.toLowerCase(),
    textHash: textHash.toLowerCase(),
    textUrl: url.toString(),
  };
}
