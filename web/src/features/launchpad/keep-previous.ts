import type { Query } from "@tanstack/react-query";

/**
 * Keep showing the last answer while the next one loads, but only for the same thing.
 *
 * A read keyed by the connected wallet starts over when the wallet connects (its key goes from "nobody" to an address),
 * and a read keyed by the chain's clock starts over after every action. With no data during that gap the screen falls
 * back to "Reading…", the forms inside it are torn down, and whatever a person had typed into them is gone. Keeping the
 * previous answer on screen until the new one arrives avoids that. `position` is where in the query key the thing that
 * must not change sits (the DAO): an answer about another DAO is never shown in its place.
 */
export function keepIfSame(position: number, value: unknown) {
  return <T>(
    previous: T | undefined,
    previousQuery: Query<T> | undefined,
  ): T | undefined =>
    previousQuery && previousQuery.queryKey[position] === value
      ? previous
      : undefined;
}
