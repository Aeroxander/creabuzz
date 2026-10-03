/**
 * Supporters: people who follow a launch. Following is a bookmark (`a` tag in
 * the person's kind 10003 list), so counting is a read over those lists — no
 * extra write exists to forge, and unfollowing removes the person.
 *
 * Alias-free on purpose: `supporters.test.mjs` drives it under `node --test`.
 */

interface ListEvent {
  pubkey: string;
  created_at: number;
  tags: string[][];
}

/**
 * Unique supporters per launch coordinate. Only each person's newest list
 * counts (the list is replaceable), and a launch's own founder does not count
 * as a supporter of it.
 */
export function countSupporters(
  events: readonly ListEvent[],
  coordinates: readonly string[],
): Map<string, number> {
  const wanted = new Set(coordinates);
  const newest = new Map<string, ListEvent>();
  for (const event of events) {
    const key = event.pubkey.toLowerCase();
    const seen = newest.get(key);
    if (!seen || event.created_at > seen.created_at) newest.set(key, event);
  }
  const people = new Map<string, Set<string>>();
  for (const [person, event] of newest) {
    for (const tag of event.tags) {
      if (tag[0] !== "a" || !wanted.has(tag[1])) continue;
      // `37001:<founder>:<id>`: the founder backing their own idea is not news.
      if (tag[1].split(":")[1]?.toLowerCase() === person) continue;
      const set = people.get(tag[1]) ?? new Set<string>();
      set.add(person);
      people.set(tag[1], set);
    }
  }
  return new Map(coordinates.map((c) => [c, people.get(c)?.size ?? 0]));
}
