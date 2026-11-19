/**
 * The seat as the chain has it, read when the Money tab shows it to a person with a wallet: who runs the money, any open offer
 * of the seat, and whether that offer is for this person on their own or as the second of a pair. An offer to a pair names
 * only the pair's address, so it is matched to people by working that address out for each (the Launcher gives it).
 */
import {
  pairAddressOf,
  readSeatState,
  type SeatState,
} from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import type { ProjectNumbers } from "../money/numbers";
import type { Ready } from "../pot/use-pot";

export interface SeatView {
  seat: SeatState;
  /** The open offer is for this account alone, for a pair this account would be the second of, or for someone else. */
  offerIsFor: "me" | "pair-with-me" | "other" | null;
  /** The team member's account a pair offer was made to, when one of the given members matches it. */
  offeredPairWith: string | null;
}

export async function readSeatView(
  numbers: ProjectNumbers,
  ready: Pick<Ready, "address" | "read">,
  memberAddresses: readonly string[],
): Promise<SeatView> {
  const seat = await readSeatState(ready.read, numbers.contracts.treasury);
  const me = ready.address.toLowerCase();
  if (!seat.offeredTo) return { seat, offerIsFor: null, offeredPairWith: null };
  if (seat.offeredTo === me)
    return { seat, offerIsFor: "me", offeredPairWith: null };
  const pairWith = async (second: string) =>
    (await pairAddressOf(
      ready.read,
      numbers.launcher,
      numbers.key,
      seat.runner,
      second,
    )) === seat.offeredTo;
  // A pair is made with the one who offered the seat as its first signer: only a runner who runs alone can offer one.
  if (!numbers.runner.isPair && me !== seat.runner && (await pairWith(me)))
    return { seat, offerIsFor: "pair-with-me", offeredPairWith: me };
  let offeredPairWith: string | null = null;
  if (!numbers.runner.isPair)
    for (const member of memberAddresses) {
      if (member === seat.runner) continue;
      if (await pairWith(member)) {
        offeredPairWith = member;
        break;
      }
    }
  return { seat, offerIsFor: "other", offeredPairWith };
}

export function useSeat(
  numbers: ProjectNumbers,
  ready: Pick<Ready, "address" | "read">,
  memberAddresses: readonly string[],
) {
  const members = [...memberAddresses].sort();
  return useQuery<SeatView>({
    queryKey: [
      "pot",
      "seat",
      numbers.contracts.treasury,
      ready.address.toLowerCase(),
      members.join(","),
    ],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readSeatView(numbers, ready, members),
  });
}
