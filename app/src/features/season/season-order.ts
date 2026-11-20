/**
 * The order of the projects on demo day (plan section 5.3): the same for everyone, and not money, not a price, not the time
 * a project entered, and nothing a project can change after the season began. It is a hash of the season's number and the
 * project's address, so nobody has top billing for good: a new season shuffles the list. Pure.
 *
 * The hash is for spreading, not for secrecy: a founder could grind project names to land first on one page of one season.
 * That buys one position on a page that carries no money rule, so it is not defended against beyond this (said in the report).
 */

/** A 53-bit string hash (cyrb53): fast, well spread, the same in every browser. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The place a project takes in a season's order: lower is earlier. */
export function orderValue(number: number, coordinate: string): number {
  return hash53(`season-${number}|${coordinate}`);
}

/** The projects in the season's order (a copy; ties, which a 53-bit hash makes unlikely, are broken by address). */
export function inSeasonOrder(
  number: number,
  coordinates: readonly string[],
): string[] {
  return [...coordinates].sort(
    (a, b) => orderValue(number, a) - orderValue(number, b) || (a < b ? -1 : 1),
  );
}
