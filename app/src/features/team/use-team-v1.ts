/**
 * Team's reads from the chain, through the person's wallet: the record of numbers does not carry the Pair's two signers,
 * its waiting calls or an offered seat. Every read is off unless the server turns investing on and the browser has a
 * wallet. Teammates' linked wallets are in `use-wallets.ts`.
 */
import { useQuery } from "@tanstack/react-query";
import { investingOn } from "../../lib/server";
import type { ProjectNumbers } from "../money/numbers-v1";
import { useWallet, useWalletOnChain } from "../money/use-money";
import {
  addressFromWord,
  type MoneyWallet,
  readLogsBack,
} from "../money/wallet";
import { PROPOSED_TOPIC, type Proposal, proposalOf } from "./pair";
import { LAUNCHER_READS, PAIR_READS, TREASURY_READS } from "./team-calls";

const ZERO = `0x${"0".repeat(40)}`;

/** A 32-byte answer as a number. */
export async function readWord(
  wallet: Pick<MoneyWallet, "readCall">,
  to: string,
  data: string,
): Promise<bigint> {
  const hex = (await wallet.readCall(to, data)).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}/.test(hex))
    throw new Error("The network gave no answer.");
  return BigInt(`0x${hex.slice(0, 64)}`);
}

/** A 32-byte answer as an address (lower case); throws when it is not one. */
export async function readAddress(
  wallet: Pick<MoneyWallet, "readCall">,
  to: string,
  data: string,
): Promise<string> {
  const address = addressFromWord(
    (await wallet.readCall(to, data)).slice(0, 66),
  );
  if (!address) throw new Error("The network gave no address.");
  return address;
}

const teamKeys = {
  pair: (chainId: number, pair: string) =>
    ["team", "pair", chainId, pair] as const,
  waiting: (chainId: number, pair: string) =>
    ["team", "waiting", chainId, pair] as const,
  seat: (chainId: number, treasury: string, me: string) =>
    ["team", "seat", chainId, treasury, me] as const,
};

export interface PairState {
  address: string;
  first: string;
  second: string;
}

/** The project's Pair and its two signers, when the Pair runs it; null otherwise. */
export function usePair(numbers: ProjectNumbers | null) {
  const wallet = useWallet();
  const pair = numbers?.market.pair ?? null;
  const runsIt = Boolean(pair && numbers?.runner === pair);
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: teamKeys.pair(numbers?.chainId ?? 0, pair ?? ""),
    enabled:
      investingOn() && wallet.isAvailable() && onChain === true && runsIt,
    staleTime: 60_000,
    queryFn: async (): Promise<PairState | null> => {
      if (!pair) return null;
      const [first, second] = await Promise.all([
        readAddress(wallet, pair, PAIR_READS.first),
        readAddress(wallet, pair, PAIR_READS.second),
      ]);
      return { address: pair, first, second };
    },
  });
}

/** Whether `me` signs for `pair`. */
export function signsFor(
  pair: PairState | null | undefined,
  me: string | null,
) {
  if (!pair || !me) return false;
  const who = me.toLowerCase();
  return pair.first === who || pair.second === who;
}

/** How far back a Pair's waiting calls are looked for: about a week of blocks, in pieces a wallet's node accepts. */
const WAITING_WINDOW = 50_000;

/**
 * A Pair's calls still waiting for the other signer: each `Proposed` log in the window whose proposer is still on record
 * (`proposer(id) != 0`: not confirmed, not withdrawn). `complete` is false when older blocks were not read.
 */
export function usePairWaiting(
  numbers: ProjectNumbers | null,
  pair: PairState | null,
) {
  const wallet = useWallet();
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: teamKeys.waiting(numbers?.chainId ?? 0, pair?.address ?? ""),
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(pair),
    staleTime: 15_000,
    queryFn: async (): Promise<{ waiting: Proposal[]; complete: boolean }> => {
      if (!pair) return { waiting: [], complete: true };
      const to = await wallet.blockNumber();
      const read = await readLogsBack(
        wallet,
        { address: pair.address, topics: [PROPOSED_TOPIC] },
        { from: Math.max(0, to - WAITING_WINDOW), to },
      );
      const proposals = read.logs
        .map((log) => proposalOf(log, pair.address))
        .filter((p): p is Proposal => p !== null);
      const still = await Promise.all(
        proposals.map(async (p) => {
          const by = await readAddress(
            wallet,
            pair.address,
            PAIR_READS.proposer(p.id),
          );
          return by !== ZERO ? p : null;
        }),
      );
      return {
        waiting: still.filter((p): p is Proposal => p !== null),
        complete: read.complete,
      };
    },
  });
}

/**
 * The runner seat offered to this wallet, read from the Treasury: to it directly (a successor takes the seat), or to the
 * Pair of (runner, this wallet), which this wallet makes by accepting the second seat. Null when nothing is offered to it.
 */
export function useSeatOffer(
  numbers: ProjectNumbers | null,
  me: string | null,
) {
  const wallet = useWallet();
  const treasury = numbers?.contracts.treasury ?? null;
  const runner = numbers?.runner ?? null;
  const single = Boolean(runner && runner !== numbers?.market.pair);
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: teamKeys.seat(numbers?.chainId ?? 0, treasury ?? "", me ?? ""),
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(numbers && treasury && me && runner && runner !== me),
    staleTime: 30_000,
    queryFn: async (): Promise<
      { kind: "seat" } | { kind: "second"; first: string } | null
    > => {
      if (!numbers || !treasury || !runner || !me) return null;
      const pending = await readAddress(
        wallet,
        treasury,
        TREASURY_READS.pendingRunner,
      );
      if (pending === me.toLowerCase()) return { kind: "seat" };
      if (!single || pending === ZERO) return null;
      const pair = await readAddress(
        wallet,
        numbers.launcher,
        LAUNCHER_READS.pairAddress(numbers.key, runner, me),
      );
      return pending === pair ? { kind: "second", first: runner } : null;
    },
  });
}

/** Where this wallet's check-in goes: the Treasury when it runs the project, its Pair when it signs for it, else null. */
export function checkInTarget(
  numbers: ProjectNumbers,
  me: string | null,
  pair: PairState | null | undefined,
): string | null {
  const treasury = numbers.contracts.treasury;
  if (!treasury || numbers.clock.woundDown || !me) return null;
  if (numbers.runner === me.toLowerCase()) return treasury;
  if (pair && numbers.runner === pair.address && signsFor(pair, me))
    return pair.address;
  return null;
}
