/**
 * What the app asks the chain at the moment of a sheet (`docs/next-version/RECORD-V2.md`, section 5): the quotes, the door,
 * a person's balances and a grant's claim. Each read builds its call from the generated ABI, sends it through the
 * sender's `readCall` and decodes the answer strictly: an answer that is too short, or not hex, throws. A sheet that gets
 * a throw says so and does not guess; it never falls back to the server's record.
 */
import { decodeParameters, selectorOf } from "../launchpad/evmAbi.ts";
import {
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";
import { type Abi, decodeReturn, encodeCall } from "./abi-codec.ts";

/** A read-only call: the node's raw answer as hex. The sender's `readCall` has this shape. */
export type ReadCall = (to: string, data: string) => Promise<string>;

async function ask(
  read: ReadCall,
  abi: Abi,
  to: string,
  name: string,
  args: readonly (bigint | boolean | string)[],
) {
  const answer = await read(to, encodeCall(abi, name, args));
  if (typeof answer !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(answer))
    throw new Error("The network gave an answer that is not readable.");
  return decodeReturn(abi, name, answer, args.length);
}

const asBigint = (value: unknown): bigint => {
  if (typeof value !== "bigint") throw new Error("A number was expected.");
  return value;
};

/** What backing with an amount would do right now (`Treasury.quoteBack`). */
export interface BackQuote {
  /** Shares the amount would buy (18 decimals). */
  shares: bigint;
  /** What taking those Shares out at once would pay, in dollar units: "what you would get if you took out now". */
  takeOutNow: bigint;
  /** Money set aside for tasks (always zero until step 2). */
  locked: bigint;
  /** Outside money still arriving, which a leaver is not paid on yet. */
  arriving: bigint;
}

/** `quoteBack(amount)` at the chain's latest block. */
export async function quoteBack(
  read: ReadCall,
  treasury: string,
  amount: bigint,
): Promise<BackQuote> {
  const [shares, takeOutNow, locked, arriving] = await ask(
    read,
    TREASURY_ABI,
    treasury,
    "quoteBack",
    [amount],
  );
  return {
    shares: asBigint(shares),
    takeOutNow: asBigint(takeOutNow),
    locked: asBigint(locked),
    arriving: asBigint(arriving),
  };
}

/** The platform's part of `amount` (`Treasury.feeFor`), in dollar units. */
export async function feeFor(
  read: ReadCall,
  treasury: string,
  amount: bigint,
): Promise<bigint> {
  const [fee] = await ask(read, TREASURY_ABI, treasury, "feeFor", [amount]);
  return asBigint(fee);
}

/** Whether a join would be accepted at the chain's latest block (`Treasury.doorOpenNow`). */
export async function doorOpenNow(
  read: ReadCall,
  treasury: string,
): Promise<boolean> {
  const [open] = await ask(read, TREASURY_ABI, treasury, "doorOpenNow", []);
  if (typeof open !== "boolean") throw new Error("A yes or no was expected.");
  return open;
}

/** What taking `n` Shares out would pay `holder` now (`Treasury.quoteTakeOut`). */
export interface TakeOutQuote {
  /** Cash, in dollar units, from the pot only. Zero when `n` is zero or more than the holder has. */
  cashNow: bigint;
  /** An exit note (always zero until step 2). */
  note: bigint;
  /** Outside money still arriving that a take-out now leaves behind. */
  arrivingLeftBehind: bigint;
}

/** `quoteTakeOut(holder, n)` at the chain's latest block. */
export async function quoteTakeOut(
  read: ReadCall,
  treasury: string,
  holder: string,
  n: bigint,
): Promise<TakeOutQuote> {
  const [cashNow, note, arrivingLeftBehind] = await ask(
    read,
    TREASURY_ABI,
    treasury,
    "quoteTakeOut",
    [holder, n],
  );
  return {
    cashNow: asBigint(cashNow),
    note: asBigint(note),
    arrivingLeftBehind: asBigint(arrivingLeftBehind),
  };
}

/** What one whole Team Share would pay now, in dollar units per 1e18 (`Treasury.teamValue`): an estimate, never exact. */
export async function teamValue(
  read: ReadCall,
  treasury: string,
): Promise<bigint> {
  const [value] = await ask(read, TREASURY_ABI, treasury, "teamValue", []);
  return asBigint(value);
}

/** A token balance (Shares, Team Shares or the dollar). */
export async function balanceOf(
  read: ReadCall,
  token: string,
  holder: string,
): Promise<bigint> {
  const [balance] = await ask(read, SHARE_TOKEN_ABI, token, "balanceOf", [
    holder,
  ]);
  return asBigint(balance);
}

/** How many dollars `spender` may take from `owner` (`allowance`). */
export async function allowanceOf(
  read: ReadCall,
  dollar: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const [value] = await ask(read, PLAY_DOLLAR_ABI, dollar, "allowance", [
    owner,
    spender,
  ]);
  return asBigint(value);
}

/** The ids of the grants made to `member` (`Vester.idsOf`). */
export async function grantIdsOf(
  read: ReadCall,
  vester: string,
  member: string,
): Promise<bigint[]> {
  const [ids] = await ask(read, VESTER_ABI, vester, "idsOf", [member]);
  if (!Array.isArray(ids)) throw new Error("A list was expected.");
  return ids.map(asBigint);
}

/** What a grant has unlocked and not yet sent to its member (`Vester.claimable`), in Team Share units. */
export async function claimableOf(
  read: ReadCall,
  vester: string,
  id: bigint,
): Promise<bigint> {
  const [value] = await ask(read, VESTER_ABI, vester, "claimable", [id]);
  return asBigint(value);
}

/** What a grant has unlocked so far, sent or not (`Vester.vestedOf`). */
export async function vestedOf(
  read: ReadCall,
  vester: string,
  id: bigint,
): Promise<bigint> {
  const [value] = await ask(read, VESTER_ABI, vester, "vestedOf", [id]);
  return asBigint(value);
}

/** The ERC-1363 interface id: a dollar that answers yes to it has `transferAndCall`. */
const ERC1363_INTERFACE_ID = "b0202a11";

/**
 * Whether the dollar can pay and call in one signature (ERC-165 `supportsInterface` for ERC-1363). A dollar that does not
 * answer, or answers no, gets the two-step Back (approve, then join): the safe default.
 */
export async function dollarHasPayAndCall(
  read: ReadCall,
  dollar: string,
): Promise<boolean> {
  try {
    const data = `${selectorOf("supportsInterface(bytes4)")}${ERC1363_INTERFACE_ID.padEnd(64, "0")}`;
    const answer = await read(dollar, data);
    const [yes] = decodeParameters(["bool"], answer);
    return yes === true;
  } catch {
    return false;
  }
}
