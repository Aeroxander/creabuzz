import { useQuery } from "@tanstack/react-query";
import { type HeldSince, readHeldSince } from "./held-since";
import type { MoneyTarget } from "./target";
import type { Ready } from "./use-pot";

/**
 * How long the connected account has held this project's Shares, read from its own transfer logs on the network
 * (`held-since.ts`). `data` is null when it cannot be said, and the caller then draws nothing. `holds` is whether the account
 * holds any now: with none there is nothing to read. Kept a minute, never retried in a loop.
 */
export function useHeldSince(
  ready: Ready,
  target: Pick<MoneyTarget, "shares" | "treasury">,
  holds: bigint,
  /** The project's pause contract when it has one: what is parked there still counts as held. */
  pause: string | null = null,
) {
  return useQuery<HeldSince | null>({
    queryKey: [
      "pot",
      "held-since",
      target.treasury,
      ready.address.toLowerCase(),
      holds.toString(),
      pause ?? "",
    ],
    enabled: holds > 0n,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      readHeldSince(ready.wallet, ready.read, {
        account: ready.address,
        shares: target.shares,
        treasury: target.treasury,
        pause,
      }),
  });
}
