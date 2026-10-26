/**
 * Payouts to a DAO's holders (N10, `contracts/src/Payouts.sol`, docs/v3-review/PAYOUTS.md): the two votes that start
 * them and pay from the treasury, their words, and the reader for a project's Funds tab.
 *
 * Revenue is only money sent to the payout module's address; anyone distributes it, `splitBps` to holders and the rest
 * to the treasury. Holders count by the Shares and Loot they hold outside the DAO's own, from the moment they hold them,
 * and each withdraws their own.
 *
 * Pure apart from the reader, whose chain is injected (`payouts.test.mjs` runs it against a fake one). Selectors are
 * pinned to `cast` in the same test.
 */

import {
  type ActionDescription,
  type DecisionDraft,
  DecisionInputError,
  type DescribeContext,
  decodeBatch,
  encodeBatch,
  formatUnits,
} from "./daoActions.ts";
import { decodeParameters, encodeFunctionData, selectorOf } from "./evmAbi.ts";
import { decodeAddress, decodeWord, encodeCall0 } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
/** How long a new split waits before it can take effect. */
export const SPLIT_NOTICE = 30 * 86_400;

export const PAYOUTS_SIGNATURES = {
  distribute: "distribute()",
  declare: "declare(uint256)",
  withdraw: "withdraw(address)",
  owed: "owed(address)",
  splitBps: "splitBps()",
  reserved: "reserved()",
  counting: "counting()",
  announceSplit: "announceSplit(uint16)",
  applySplit: "applySplit()",
  pendingSplitBps: "pendingSplitBps()",
  splitAnnouncedAt: "splitAnnouncedAt()",
  currency: "currency()",
  create: "create(address,address,uint16)",
  predict: "predict(address,address,uint16)",
  daoPayouts: "payouts()",
  setPayouts: "setPayouts(address)",
  approve: "approve(address,uint256)",
} as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function address(value: string, field: string, what: string): string {
  if (!ADDRESS_RE.test(value.trim())) {
    throw new DecisionInputError(field, `${what} is not an address.`);
  }
  return value.trim().toLowerCase();
}

// ---- calls ---------------------------------------------------------------------------------------

export const encodeDistribute = (): string =>
  encodeCall0(PAYOUTS_SIGNATURES.distribute);
export const encodeApplySplit = (): string =>
  encodeCall0(PAYOUTS_SIGNATURES.applySplit);

export function encodeWithdrawPayout(who: string): string {
  if (!ADDRESS_RE.test(who)) throw new Error("not an address");
  return encodeFunctionData(PAYOUTS_SIGNATURES.withdraw, ["address"], [who]);
}

export function encodePredictPayouts(
  dao: string,
  currency: string,
  splitBps: number,
): string {
  return encodeFunctionData(
    PAYOUTS_SIGNATURES.predict,
    ["address", "address", "uint16"],
    [dao, currency, BigInt(splitBps)],
  );
}

// ---- decisions ------------------------------------------------------------------------------------

function assertSplit(splitBps: number): void {
  if (!Number.isInteger(splitBps) || splitBps < 1 || splitBps > 10_000) {
    throw new DecisionInputError(
      "splitBps",
      "Say what share of revenue goes to holders, from 0.01% to 100%.",
    );
  }
}

const percent = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/**
 * The vote that starts payouts: one batch makes the DAO's payout module (at `predicted`, the factory's own prediction)
 * and names it. Revenue sent to it is then split, `splitBps` to holders.
 */
export function startPayoutsDecision(input: {
  dao: string;
  factory: string;
  predicted: string;
  currency: string;
  splitBps: number;
}): DecisionDraft {
  assertSplit(input.splitBps);
  const dao = address(input.dao, "dao", "The DAO");
  const factory = address(input.factory, "factory", "Payouts");
  const predicted = address(input.predicted, "predicted", "The module");
  const currency = address(input.currency, "currency", "The currency");
  return {
    to: dao,
    data: encodeBatch([
      {
        to: factory,
        data: encodeFunctionData(
          PAYOUTS_SIGNATURES.create,
          ["address", "address", "uint16"],
          [dao, currency, BigInt(input.splitBps)],
        ),
      },
      {
        to: dao,
        data: encodeFunctionData(
          PAYOUTS_SIGNATURES.setPayouts,
          ["address"],
          [predicted],
        ),
      },
    ]),
    lane: "unrestricted",
    title: `Pay holders ${percent(input.splitBps)} of revenue`,
    lines: [
      `Money sent to the project's revenue address is split: ${percent(input.splitBps)} to everyone holding Shares or Loot, by how many they hold, and the rest to the treasury.`,
      "Holders count from when they hold, keep what was paid to them after they sell or leave, and collect it themselves.",
      "This can be chosen once. Changing the split later takes a vote and 30 days' notice.",
    ],
  };
}

/** The vote that pays holders `amount` from the treasury, all of it, through the payout module: a batch the DAO runs. */
export function declarePayoutDecision(input: {
  dao: string;
  payouts: string;
  currency: string;
  amount: bigint;
  decimals: number;
  symbol: string;
}): DecisionDraft {
  if (input.amount <= 0n) {
    throw new DecisionInputError("amount", "Say how much to pay out.");
  }
  const dao = address(input.dao, "dao", "The DAO");
  const payouts = address(input.payouts, "payouts", "The payout module");
  const currency = address(input.currency, "currency", "The currency");
  const shown = `${formatUnits(input.amount, input.decimals)} ${input.symbol}`;
  return {
    to: dao,
    data: encodeBatch([
      {
        to: currency,
        data: encodeFunctionData(
          PAYOUTS_SIGNATURES.approve,
          ["address", "uint256"],
          [payouts, input.amount],
        ),
      },
      {
        to: payouts,
        data: encodeFunctionData(
          PAYOUTS_SIGNATURES.declare,
          ["uint256"],
          [input.amount],
        ),
      },
    ]),
    lane: "unrestricted",
    title: `Pay holders ${shown} from the treasury`,
    lines: [
      `${shown} leaves the treasury for everyone holding Shares or Loot now, by how many they hold.`,
      "Leaving pays from what is left: this money cannot be paid twice.",
    ],
  };
}

/** A payouts decision in words, or null when the action is not one of these two shapes aimed at this DAO. */
export function describePayouts(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  const calls = decodeBatch(action.data);
  if (!calls || calls.length !== 2) return null;
  const [first, second] = calls;
  const s = (sig: string) => selectorOf(sig).toLowerCase();
  const of = (draft: DecisionDraft): ActionDescription => ({
    kind: "payouts",
    title: draft.title,
    lines: draft.lines,
  });
  try {
    if (
      ctx.dao &&
      ctx.payoutsFactory &&
      same(action.to, ctx.dao) &&
      same(first.to, ctx.payoutsFactory) &&
      first.data.toLowerCase().startsWith(s(PAYOUTS_SIGNATURES.create)) &&
      same(second.to, ctx.dao) &&
      second.data.toLowerCase().startsWith(s(PAYOUTS_SIGNATURES.setPayouts))
    ) {
      const [dao, currency, split] = decodeParameters(
        ["address", "address", "uint16"],
        `0x${first.data.slice(10)}`,
      ) as [string, string, bigint];
      const [predicted] = decodeParameters(
        ["address"],
        `0x${second.data.slice(10)}`,
      ) as [string];
      if (!same(dao, ctx.dao)) return null;
      return of(
        startPayoutsDecision({
          dao,
          factory: first.to,
          predicted,
          currency,
          splitBps: Number(split),
        }),
      );
    }
    if (
      ctx.dao &&
      same(action.to, ctx.dao) &&
      first.data.toLowerCase().startsWith(s(PAYOUTS_SIGNATURES.approve)) &&
      second.data.toLowerCase().startsWith(s(PAYOUTS_SIGNATURES.declare))
    ) {
      const [spender, approved] = decodeParameters(
        ["address", "uint256"],
        `0x${first.data.slice(10)}`,
      ) as [string, bigint];
      const [amount] = decodeParameters(
        ["uint256"],
        `0x${second.data.slice(10)}`,
      ) as [bigint];
      if (!same(spender, second.to) || approved !== amount) return null;
      const known = ctx.currency ? same(first.to, ctx.currency) : false;
      return of(
        declarePayoutDecision({
          dao: action.to,
          payouts: second.to,
          currency: first.to,
          amount,
          decimals:
            known && ctx.currencyDecimals !== undefined
              ? ctx.currencyDecimals
              : 0,
          symbol: known ? (ctx.currencySymbol ?? "") : "base units",
        }),
      );
    }
  } catch {
    return null;
  }
  return null;
}

// ---- reads ---------------------------------------------------------------------------------------

export interface PayoutsView {
  module: string;
  currency: string;
  splitBps: number;
  /** A split announced and waiting, or null. */
  pending: { splitBps: number; from: number } | null;
  /** Revenue that arrived and is not distributed yet. */
  waiting: bigint;
  /** What the connected wallet can collect, or null without one. */
  owed: bigint | null;
}

/** A DAO's payout module, or null when it has none. */
export async function readPayouts(
  chain: Pick<WorkChain, "call">,
  dao: string,
  wallet: string | null,
): Promise<PayoutsView | null> {
  let module: string;
  try {
    module = decodeAddress(
      await chain.call(dao, encodeCall0(PAYOUTS_SIGNATURES.daoPayouts)),
    );
  } catch (error) {
    // A DAO made before payouts has no `payouts()`: the call reverts. A network failure is not that, and is passed on.
    if (
      /revert/i.test(error instanceof Error ? error.message : String(error))
    ) {
      return null;
    }
    throw error;
  }
  if (module === ZERO) return null;
  const read = (sig: string) => chain.call(module, encodeCall0(sig));
  const [currencyHex, split, pending, announcedAt, reserved] =
    await Promise.all([
      read(PAYOUTS_SIGNATURES.currency),
      read(PAYOUTS_SIGNATURES.splitBps).then(decodeWord),
      read(PAYOUTS_SIGNATURES.pendingSplitBps).then(decodeWord),
      read(PAYOUTS_SIGNATURES.splitAnnouncedAt).then(decodeWord),
      read(PAYOUTS_SIGNATURES.reserved).then(decodeWord),
    ]);
  const currency = decodeAddress(currencyHex);
  const [balance, owed] = await Promise.all([
    chain
      .call(
        currency,
        encodeFunctionData("balanceOf(address)", ["address"], [module]),
      )
      .then(decodeWord),
    wallet
      ? chain
          .call(
            module,
            encodeFunctionData(PAYOUTS_SIGNATURES.owed, ["address"], [wallet]),
          )
          .then(decodeWord)
      : Promise.resolve(null),
  ]);
  return {
    module,
    currency,
    splitBps: Number(split),
    pending:
      announcedAt === 0n
        ? null
        : {
            splitBps: Number(pending),
            from: Number(announcedAt) + SPLIT_NOTICE,
          },
    waiting: balance > reserved ? balance - reserved : 0n,
    owed,
  };
}
