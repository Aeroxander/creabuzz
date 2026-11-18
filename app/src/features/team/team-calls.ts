/**
 * The chain calls behind Team (the second signer, the Pair's two-signer calls, the hand-over, Give Shares, wind down)
 * and behind putting a project on the chain, built as plain data for the person's wallet to send. Pure: the calldata is
 * pinned in `team-calls.test.ts` against `cast calldata`. The contracts (`contracts/next/src`: Launcher, Treasury, Pair)
 * are the source of truth for every signature here.
 */
import {
  type AbiType,
  type AbiValue,
  encodeFunctionData,
} from "@creaton/core/launchpad/evmAbi.ts";
import type { MoneyCall } from "../money/calls";

/** A call's data: the signature's selector and its arguments. */
export function callData(
  signature: string,
  types: readonly AbiType[] = [],
  values: readonly AbiValue[] = [],
): string {
  return encodeFunctionData(signature, types, values);
}

const call = (to: string, data: string): MoneyCall => ({
  to: to.toLowerCase(),
  data,
  value: "0x0",
});

// --- Launcher ------------------------------------------------------------------------------------------------------

/** Put a project on the chain: its Shares, Treasury, Vester, Rounds and Finisher. The caller becomes its founder. */
export function launchCall(input: {
  launcher: string;
  projectId: string;
  name: string;
  symbol: string;
  settingsHash: string;
}): MoneyCall {
  return call(
    input.launcher,
    callData(
      "launch(bytes32,string,string,bytes32)",
      ["bytes32", "string", "string", "bytes32"],
      [input.projectId, input.name, input.symbol, input.settingsHash],
    ),
  );
}

/** Accept the second seat: the caller and `first` become the project's Pair. */
export function makePairCall(
  launcher: string,
  key: string,
  first: string,
): MoneyCall {
  return call(
    launcher,
    callData("makePair(bytes32,address)", ["bytes32", "address"], [key, first]),
  );
}

/** The data of `windDown(key)`: payments stop for good. */
export function windDownData(key: string): string {
  return callData("windDown(bytes32)", ["bytes32"], [key]);
}

/** The data of `openRound(key, sharesPerRawDollar)`, for a Pair to propose. */
export function openRoundData(key: string, sharesPerRawDollar: bigint): string {
  return callData(
    "openRound(bytes32,uint256)",
    ["bytes32", "uint256"],
    [key, sharesPerRawDollar],
  );
}

/** The data of `openAuction(key, startQ96)`, for a Pair to propose. */
export function openAuctionData(key: string, startQ96: bigint): string {
  return callData(
    "openAuction(bytes32,uint256)",
    ["bytes32", "uint256"],
    [key, startQ96],
  );
}

/** Reads on the Launcher. */
export const LAUNCHER_READS = {
  launchHash: (key: string) =>
    callData("launchHash(bytes32)", ["bytes32"], [key]),
  projectByKey: (key: string) =>
    callData("projectByKey(bytes32)", ["bytes32"], [key]),
  pairAddress: (key: string, first: string, second: string) =>
    callData(
      "pairAddress(bytes32,address,address)",
      ["bytes32", "address", "address"],
      [key, first, second],
    ),
  salePrices: () => callData("salePrices()"),
} as const;

// --- Treasury ------------------------------------------------------------------------------------------------------

/** The data of `handOver(next, founderLeaves)`: offer the runner seat to `next`. */
export function handOverData(next: string, founderLeaves: boolean): string {
  return callData(
    "handOver(address,bool)",
    ["address", "bool"],
    [next, founderLeaves],
  );
}

/** Take the runner seat that was offered to the caller. */
export function takeSeatCall(treasury: string): MoneyCall {
  return call(treasury, callData("takeSeat()"));
}

/** The data of `giveShares(to, amount)`: Shares from the work pot to a person. */
export function giveSharesData(to: string, amount: bigint): string {
  return callData(
    "giveShares(address,uint256)",
    ["address", "uint256"],
    [to, amount],
  );
}

/** The data of `spend(to, amount)` (the Treasury's, and a Pair signer's alone, which has the same shape). */
export function spendData(to: string, amount: bigint): string {
  return callData(
    "spend(address,uint256)",
    ["address", "uint256"],
    [to, amount],
  );
}

/** Reads on the Treasury (each a view with no arguments). */
export const TREASURY_READS = {
  pendingRunner: callData("pendingRunner()"),
  workPot: callData("workPot()"),
  melting: callData("melting()"),
  meltRemaining: callData("meltRemaining()"),
  permanentFloor: callData("permanentFloor()"),
  countingSupply: callData("countingSupply()"),
  activeEnd: callData("activeEnd()"),
  settled: callData("settled()"),
  saleClosed: callData("saleClosed()"),
  woundDown: callData("woundDown()"),
  poolOpen: callData("poolOpen()"),
  giftsUsed: callData("giftsUsed()"),
} as const;

// --- Pair ----------------------------------------------------------------------------------------------------------

/** A signer's check-in for the project (either signer alone). */
export function pairCheckInCall(pair: string): MoneyCall {
  return call(pair, callData("checkIn()"));
}

/** Spend alone: at most 500 dollars in any 7 days for each signer. */
export function pairSpendCall(
  pair: string,
  to: string,
  amount: bigint,
): MoneyCall {
  return call(pair, spendData(to, amount));
}

/** Propose a call to the Treasury or the Launcher; it runs when the other signer confirms the same call. */
export function pairProposeCall(
  pair: string,
  target: string,
  data: string,
): MoneyCall {
  return call(
    pair,
    callData("propose(address,bytes)", ["address", "bytes"], [target, data]),
  );
}

/** Confirm the other signer's proposal (the exact target, data and nonce it was proposed with) and run it. */
export function pairConfirmCall(
  pair: string,
  target: string,
  data: string,
  nonce: bigint,
): MoneyCall {
  return call(
    pair,
    callData(
      "confirm(address,bytes,uint256)",
      ["address", "bytes", "uint256"],
      [target, data, nonce],
    ),
  );
}

/** Withdraw a call you proposed. */
export function pairCancelCall(pair: string, id: string): MoneyCall {
  return call(pair, callData("cancel(bytes32)", ["bytes32"], [id]));
}

/** Reads on a Pair. */
export const PAIR_READS = {
  first: callData("first()"),
  second: callData("second()"),
  nonce: callData("nonce()"),
  proposer: (id: string) => callData("proposer(bytes32)", ["bytes32"], [id]),
  spentAlone: (signer: string) =>
    callData("spentAlone(address)", ["address"], [signer]),
} as const;

/**
 * What the runner seat does with `inner` (a call to the Treasury or the Launcher): sent straight there by a single runner,
 * proposed through the Pair by one of its signers (the other confirms it). Null when this wallet may not ask at all.
 */
export function asRunner(input: {
  runner: string | null;
  pair: { address: string; first: string; second: string } | null;
  me: string | null;
  target: string;
  data: string;
}): { call: MoneyCall; through: "alone" | "pair" } | null {
  const me = input.me?.toLowerCase() ?? null;
  const runner = input.runner?.toLowerCase() ?? null;
  if (!me || !runner) return null;
  if (runner === me)
    return { call: call(input.target, input.data), through: "alone" };
  const pair = input.pair;
  if (
    pair &&
    pair.address.toLowerCase() === runner &&
    (pair.first.toLowerCase() === me || pair.second.toLowerCase() === me)
  )
    return {
      call: pairProposeCall(pair.address, input.target, input.data),
      through: "pair",
    };
  return null;
}

/** The same call, wrapped for sending straight to `to` (the Treasury or the Launcher). */
export function directCall(to: string, data: string): MoneyCall {
  return call(to, data);
}
