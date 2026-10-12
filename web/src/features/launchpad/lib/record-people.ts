/**
 * Putting names to the wallets on a DAO's track record.
 *
 * The chain knows wallets, not people. This server also knows which wallets people bound to their account (the
 * server checks a binding when it is published) and what they call themselves. So a wallet that exactly one person on
 * this server has bound is shown by that name, always beside the start and end of the address: a name is what a
 * person chose, the address is what the chain says, and a reader should see both.
 *
 * A wallet that two different people claim, or nobody has bound, stays an address: a name is never guessed.
 * Alias-free for `node --test`.
 */

import type { RecordEvents } from "./record-read.ts";
import type { WorkSnapshot } from "./work-read.ts";

export interface PersonWallet {
  /** The person's key on this server. */
  pubkey: string;
  /** The wallet they bound. */
  address: string;
}

/** The start and end of an address, enough to recognise it and to tell two apart. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Every wallet the record names: contributors, reviewers and the team's Shares holders. Lower-case, each once. */
export function addressesInRecord(
  work: WorkSnapshot,
  events: Pick<RecordEvents, "promises" | "verdicts">,
): string[] {
  const found = new Set<string>();
  for (const mandate of work.mandates) {
    for (const claim of mandate.claims) {
      found.add(claim.record.contributor.toLowerCase());
    }
  }
  for (const verdicts of events.verdicts.values()) {
    for (const verdict of verdicts) found.add(verdict.reviewer.toLowerCase());
  }
  for (const person of events.promises) found.add(person.holder.toLowerCase());
  return [...found];
}

/**
 * The people whose names are worth looking up: those with a wallet the record names, at most `limit` of them (a name
 * lookup is one batched query, and bounded).
 */
export function pubkeysToName(
  people: readonly PersonWallet[],
  addresses: readonly string[],
  limit = 60,
): string[] {
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  return [
    ...new Set(
      people
        .filter((p) => wanted.has(p.address.toLowerCase()))
        .map((p) => p.pubkey),
    ),
  ].slice(0, limit);
}

/**
 * How the page writes a wallet: `Name (0xabcd…1234)` when exactly one person bound it and has a name, otherwise just
 * `0xabcd…1234`. `nameOf` gives a person's chosen name, or null when they have none.
 */
export function personLabeler(
  people: readonly PersonWallet[],
  nameOf: (pubkey: string) => string | null,
): (address: string) => string {
  const owners = new Map<string, Set<string>>();
  for (const person of people) {
    const key = person.address.toLowerCase();
    const set = owners.get(key) ?? new Set<string>();
    set.add(person.pubkey);
    owners.set(key, set);
  }
  return (address) => {
    const short = shortAddress(address.toLowerCase());
    const set = owners.get(address.toLowerCase());
    if (set?.size !== 1) return short;
    const [pubkey] = [...set];
    const name = nameOf(pubkey)?.trim();
    return name ? `${name} (${short})` : short;
  };
}
