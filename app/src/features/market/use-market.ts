/**
 * The market's live reads, through the person's wallet: the floor as it stands (the record does not carry the melting
 * floor), the pool's price and the liquidity in range (its depth), this wallet's bids, and where the sale is. Every read
 * is off unless the server turns investing on and the browser has a wallet.
 */
import {
  encodeParameters,
  keccak256Hex,
} from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { useQuery } from "@tanstack/react-query";
import { investingOn } from "../../lib/server";
import type { ProjectNumbers } from "../money/numbers";
import { useWallet, useWalletOnChain } from "../money/use-money";
import { addressFromWord, type MoneyWallet } from "../money/wallet";
import { TREASURY_READS } from "../team/team-calls";
import type { MoneyCall } from "../money/calls";
import { readAddress, readWord } from "../team/use-team";
import {
  finishCall,
  finishSteps,
  MARKET_READS,
  type PoolKey,
} from "./market-calls";
import type { FloorNow } from "./market-math";

const words = (hex: string) =>
  (hex.replace(/^0x/, "").match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));

/** The floor as it stands now: what the Treasury holds for holders to hand back against, and the Shares in hands. */
export function useFloor(numbers: ProjectNumbers | null) {
  const wallet = useWallet();
  const treasury = numbers?.contracts.treasury ?? null;
  const shares = numbers?.contracts.shares ?? null;
  const settled = Boolean(numbers?.market.sale?.settled);
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: ["market", "floor", numbers?.chainId ?? 0, treasury ?? ""],
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(treasury && shares) &&
      settled,
    staleTime: 30_000,
    queryFn: async (): Promise<FloorNow & { saleClosed: boolean }> => {
      if (!treasury || !shares) throw new Error("No Treasury.");
      const [
        melting,
        meltRemaining,
        permanentFloor,
        countingSupply,
        totalSupply,
        closed,
      ] = await Promise.all([
        readWord(wallet, treasury, TREASURY_READS.melting),
        readWord(wallet, treasury, TREASURY_READS.meltRemaining),
        readWord(wallet, treasury, TREASURY_READS.permanentFloor),
        readWord(wallet, treasury, TREASURY_READS.countingSupply),
        readWord(wallet, shares, MARKET_READS.totalSupply),
        readWord(wallet, treasury, TREASURY_READS.saleClosed),
      ]);
      return {
        melting,
        meltRemaining,
        permanentFloor,
        countingSupply,
        totalSupply,
        saleClosed: closed !== 0n,
      };
    },
  });
}

export interface PoolNow {
  key: PoolKey;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  sharesAreCurrency0: boolean;
}

const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;

/** The pool's id and the storage slot its state starts at (`PoolRead` in `contracts/next/src/Pinned.sol`). */
export function poolSlots(key: PoolKey): {
  id: string;
  slot0: string;
  liquidity: string;
} {
  const id = keccak256Hex(
    encodeParameters(
      ["address", "address", "uint24", "int24", "address"],
      [
        key.currency0,
        key.currency1,
        BigInt(key.fee),
        BigInt(key.tickSpacing),
        key.hooks,
      ],
    ),
  );
  const slot0 = keccak256Hex(
    encodeParameters(["bytes32", "uint256"], [id, POOLS_SLOT]),
  );
  const liquidity = `0x${(BigInt(slot0) + LIQUIDITY_OFFSET).toString(16).padStart(64, "0")}`;
  return { id, slot0, liquidity };
}

/** The key of a project's pool, as its Finisher gives it. */
async function readPoolKey(
  wallet: Pick<MoneyWallet, "readCall">,
  finisher: string,
): Promise<PoolKey> {
  const keyWords = words(await wallet.readCall(finisher, MARKET_READS.poolKey));
  if (keyWords.length < 5) throw new Error("The pool could not be read.");
  const hex = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}`;
  const tick =
    keyWords[3] >= 2n ** 255n ? keyWords[3] - 2n ** 256n : keyWords[3];
  return {
    currency0: hex(keyWords[0]),
    currency1: hex(keyWords[1]),
    fee: Number(keyWords[2]),
    tickSpacing: Number(tick),
    hooks: hex(keyWords[4]),
  };
}

/**
 * The finish calls an ended sale still needs, read at the moment of the press: whether the pool step ran (the pool
 * strategy keeps the pool's id for the auction until it does) and, once it ran, whether the auction reached its minimum.
 */
export async function readFinishCalls(
  wallet: Pick<MoneyWallet, "readCall">,
  finisher: string,
  auction: string,
  reachedByRecord: boolean,
): Promise<MoneyCall[]> {
  const [key, strategy] = await Promise.all([
    readPoolKey(wallet, finisher),
    readAddress(wallet, finisher, MARKET_READS.strategy),
  ]);
  const holder = await readAddress(
    wallet,
    strategy,
    MARKET_READS.registeredPoolId(poolSlots(key).id),
  );
  const stepPending = holder === auction.toLowerCase();
  const graduated = stepPending
    ? false
    : (await readWord(wallet, auction, MARKET_READS.isGraduated)) !== 0n;
  return finishSteps({ stepPending, graduated, reachedByRecord }).map((step) =>
    finishCall(finisher, step),
  );
}

/** Read the pool of a project's sale: its key from the Finisher, its price and liquidity from the pool manager. */
export async function readPool(
  wallet: Pick<MoneyWallet, "readCall">,
  finisher: string,
  shares: string,
): Promise<PoolNow> {
  const key = await readPoolKey(wallet, finisher);
  const manager = addressFromWord(
    (await wallet.readCall(finisher, MARKET_READS.poolManager)).slice(0, 66),
  );
  if (!manager) throw new Error("The pool could not be read.");
  const slots = poolSlots(key);
  const [state, liquidity] = await Promise.all([
    readWord(wallet, manager, MARKET_READS.extsload(slots.slot0)),
    readWord(wallet, manager, MARKET_READS.extsload(slots.liquidity)),
  ]);
  return {
    key,
    sqrtPriceX96: state & ((1n << 160n) - 1n),
    liquidity: liquidity & ((1n << 128n) - 1n),
    sharesAreCurrency0: key.currency0 === shares.toLowerCase(),
  };
}

export function usePool(numbers: ProjectNumbers | null) {
  const wallet = useWallet();
  const finisher = numbers?.market.finisher ?? null;
  const shares = numbers?.contracts.shares ?? null;
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: ["market", "pool", numbers?.chainId ?? 0, finisher ?? ""],
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(finisher && shares && numbers?.market.sale?.pool),
    staleTime: 15_000,
    queryFn: () => readPool(wallet, finisher as string, shares as string),
  });
}

/** The network's newest block, for where the auction is (taking bids, closed to bids, ended). */
export function useBlock(numbers: ProjectNumbers | null) {
  const wallet = useWallet();
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: ["market", "block", numbers?.chainId ?? 0],
    // A wallet on another network has its own block numbers: never read as this project's.
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(numbers?.market.sale),
    staleTime: 12_000,
    queryFn: () => wallet.blockNumber(),
  });
}

/** `Finisher.Stage` as the contract numbers it. */
export const SALE_STAGE = {
  idle: 0,
  open: 1,
  done: 2,
  failed: 3,
  abandoned: 4,
} as const;

export interface SaleStage {
  stage: number;
  /** The block from which a failed sale's place may be taken by a new one (0 when none failed). */
  retryBlock: number;
}

/**
 * Where the project's sale stands on the chain (`Finisher.stage()`), which the record cannot say for a sale that failed
 * (it keeps it as the one sale) or finished a moment ago. Undefined until read.
 */
export function useSaleStage(numbers: ProjectNumbers | null) {
  const wallet = useWallet();
  const finisher = numbers?.market.finisher ?? null;
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: ["market", "stage", numbers?.chainId ?? 0, finisher ?? ""],
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(finisher && numbers?.market.sale),
    staleTime: 12_000,
    queryFn: async (): Promise<SaleStage> => {
      if (!finisher) throw new Error("No Finisher.");
      const [stage, retry] = await Promise.all([
        readWord(wallet, finisher, MARKET_READS.stage),
        readWord(wallet, finisher, MARKET_READS.retryBlock),
      ]);
      return {
        stage: Number(stage),
        retryBlock: retry > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(retry),
      };
    },
  });
}

export const BID_SUBMITTED = topicOf(
  "BidSubmitted(uint256,address,uint256,uint128)",
);

export interface MyBid {
  id: bigint;
  amount: bigint;
  maxPriceQ96: bigint;
  exited: boolean;
  tokensFilled: bigint;
}

/**
 * This wallet's bids in the sale: `BidSubmitted` logs with it as owner over the sale's 7,200 blocks (one window a
 * wallet's node accepts), each read back from the auction for whether it was settled and what it bought.
 */
export function useMyBids(numbers: ProjectNumbers | null, me: string | null) {
  const wallet = useWallet();
  const sale = numbers?.market.sale ?? null;
  const onChain = useWalletOnChain(numbers?.chainId);
  return useQuery({
    queryKey: [
      "market",
      "bids",
      numbers?.chainId ?? 0,
      sale?.auction ?? "",
      me ?? "",
    ],
    enabled:
      investingOn() &&
      wallet.isAvailable() &&
      onChain === true &&
      Boolean(sale && me),
    staleTime: 20_000,
    queryFn: async () => {
      if (!sale || !me)
        return {
          bids: [],
          graduated: false,
          claimBlock: 0n,
          clearingQ96: 0n,
          head: 0,
        };
      const head = await wallet.blockNumber();
      const logs = await wallet.getLogs({
        address: sale.auction,
        topics: [
          BID_SUBMITTED,
          null,
          `0x${me.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`,
        ],
        from: sale.startBlock,
        to: Math.min(head, sale.endBlock),
      });
      const ids = [...new Set(logs.map((l) => l.topics[1]))].slice(0, 50);
      const bids: MyBid[] = await Promise.all(
        ids.map(async (topic) => {
          const id = BigInt(topic);
          const w = words(
            await wallet.readCall(sale.auction, MARKET_READS.bid(id)),
          );
          const log = logs.find((l) => l.topics[1] === topic);
          const amount = log ? (words(log.data)[1] ?? 0n) : 0n;
          return {
            id,
            amount,
            maxPriceQ96: w[3] ?? 0n,
            exited: (w[2] ?? 0n) !== 0n,
            tokensFilled: w[6] ?? 0n,
          };
        }),
      );
      const [graduated, claimBlock, clearingQ96] = await Promise.all([
        readWord(wallet, sale.auction, MARKET_READS.isGraduated),
        readWord(wallet, sale.auction, MARKET_READS.claimBlock),
        readWord(wallet, sale.auction, MARKET_READS.clearingPrice),
      ]);
      return {
        bids,
        graduated: graduated !== 0n,
        claimBlock,
        clearingQ96,
        head,
      };
    },
  });
}
