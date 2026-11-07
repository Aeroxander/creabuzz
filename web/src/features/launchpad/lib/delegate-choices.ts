/**
 * Who a contributor can hand their votes to, from the list (D144): the people on this server who hold the project's
 * Shares. A holder is offered only when exactly one person bound that address and has a name, so a contract (a work
 * budget, a reviewer's bond, the DAO itself) or an address nobody claims is never a choice; typing an address stays
 * possible. Alias-free for `node --test`.
 */

import { shortAddress, type PersonWallet } from "./record-people.ts";

export interface DelegateChoice {
  value: string;
  label: string;
}

export function delegateChoices(input: {
  /** Addresses that hold Shares, lower-case. */
  holders: readonly string[];
  people: readonly PersonWallet[];
  /** A person's chosen name, or null when they have none. */
  nameOf: (pubkey: string) => string | null;
  /** Never offered: the DAO, and the account choosing. */
  exclude: readonly (string | null)[];
  /** At most this many choices. */
  limit?: number;
}): DelegateChoice[] {
  const skip = new Set(
    input.exclude.filter((a): a is string => !!a).map((a) => a.toLowerCase()),
  );
  const owners = new Map<string, Set<string>>();
  for (const person of input.people) {
    const key = person.address.toLowerCase();
    const set = owners.get(key) ?? new Set<string>();
    set.add(person.pubkey);
    owners.set(key, set);
  }
  const choices: DelegateChoice[] = [];
  for (const raw of input.holders) {
    const address = raw.toLowerCase();
    if (skip.has(address)) continue;
    const set = owners.get(address);
    if (set?.size !== 1) continue;
    const [pubkey] = [...set];
    const name = input.nameOf(pubkey)?.trim();
    if (!name) continue;
    choices.push({
      value: address,
      label: `${name} (${shortAddress(address)})`,
    });
    if (choices.length >= (input.limit ?? 20)) break;
  }
  return choices;
}
