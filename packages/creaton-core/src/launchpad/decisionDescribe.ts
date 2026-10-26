/**
 * Describe any decision the app knows how to compose, in plain words: the single-call actions (`daoActions.ts`) and the
 * market batch (`marketActions.ts`). A batch only counts as a market if every call in it points where a market's calls
 * point; a batch that merely looks like one is described as the list of steps it is, so the words never say more than the
 * calls do.
 */

import { decodeParameters, selectorOf } from "./evmAbi.ts";
import {
  type ActionDescription,
  decodeBatch,
  type DescribeContext,
  describeAction,
  formatUnits,
} from "./daoActions.ts";
import { MARKET_SIGNATURES } from "./marketActions.ts";
import { describeExitSales } from "./matchedExit.ts";
import { describePayouts } from "./payouts.ts";
import { describeTrading } from "./tradingActions.ts";

const sel = (key: keyof typeof MARKET_SIGNATURES) =>
  selectorOf(MARKET_SIGNATURES[key]).toLowerCase();
const args = (data: string) => `0x${data.slice(10)}`;
const lower = (s: string) => s.toLowerCase();

interface Call {
  to: string;
  value: bigint;
  data: string;
}

function marketOf(
  calls: Call[],
  ctx: DescribeContext,
): ActionDescription | null {
  if (calls.length !== 6) return null;
  const [exclude, ammSettings, hookSettings, approve, create, liquidity] =
    calls;
  if (
    !exclude.data.toLowerCase().startsWith(sel("setExcluded")) ||
    !ammSettings.data.toLowerCase().startsWith(sel("ammSetToken")) ||
    !hookSettings.data.toLowerCase().startsWith(sel("hookSetToken")) ||
    !approve.data.toLowerCase().startsWith(sel("approve")) ||
    !create.data.toLowerCase().startsWith(sel("createPool")) ||
    !liquidity.data.toLowerCase().startsWith(sel("addLiquidity"))
  ) {
    return null;
  }
  try {
    const amm = lower(ammSettings.to);
    if (ctx.amm && amm !== lower(ctx.amm)) return null;
    const shares = lower(approve.to);
    const [excluded, on] = decodeParameters(
      ["address", "bool"],
      args(exclude.data),
    ) as [string, boolean];
    const [token, hook] = decodeParameters(
      ["address", "address", "uint32"],
      args(ammSettings.data),
    ) as [string, string, bigint];
    const [spender, amount] = decodeParameters(
      ["address", "uint256"],
      args(approve.data),
    ) as [string, bigint];
    const [hookToken, settings, , , , , hooks] = decodeParameters(
      [
        "address",
        {
          tuple: [
            "bool",
            "bool",
            "bool",
            "bool",
            "uint16",
            "uint16",
            "uint16",
            "uint16",
            "uint16",
            "uint16",
            "uint56",
            "uint56",
            "uint56",
          ],
        },
        { array: "bytes32" },
        { array: "bytes" },
        { array: "bytes32" },
        { array: "bytes32" },
        { array: "address" },
      ],
      args(hookSettings.data),
    ) as [
      string,
      bigint[] & unknown[],
      unknown,
      unknown,
      unknown,
      unknown,
      string[],
    ];
    const [details] = decodeParameters(
      [
        {
          tuple: [
            "address",
            "uint16",
            "address",
            "address",
            "address",
            "bytes",
          ],
        },
        "bytes",
        "bytes",
        "bytes",
        "bytes",
      ],
      args(create.data),
    ) as [[string, bigint, string, string, string, string]];
    const [, poolFee, token0, token1, , params] = details;
    // Every call must point at the same exchange, the same Shares and the same hook, or this is not the market it looks like.
    if (
      !on ||
      lower(excluded) !== amm ||
      lower(spender) !== amm ||
      lower(token) !== shares ||
      lower(hookToken) !== shares ||
      lower(create.to) !== amm ||
      lower(liquidity.to) !== amm ||
      hooks.length !== 1 ||
      lower(hooks[0]) !== lower(hook) ||
      (lower(token0) !== shares && lower(token1) !== shares)
    ) {
      return null;
    }
    const sharesAreToken0 = lower(token0) === shares;
    const [, sqrt] = decodeParameters(["int24", "uint160"], params) as [
      bigint,
      bigint,
    ];
    const poolPrice = (Number(sqrt) / 2 ** 96) ** 2;
    const perShareRaw = sharesAreToken0 ? poolPrice : 1 / poolPrice;
    const tax = Number((settings as unknown[])[6]);
    const lines = [
      ctx.currencyDecimals === undefined
        ? "Starting price set by the pool"
        : `Starting price about ${formatUnits(BigInt(Math.round(perShareRaw * 1e18)), ctx.currencyDecimals, 4)} per Share, rising as people buy`,
      `A ${tax / 100}% fee on every trade goes to the DAO`,
      `The pool takes a ${Number(poolFee) / 100}% fee for those who provide the Shares`,
      "The Shares come from the DAO's own balance; it needs no money to start",
    ];
    return {
      kind: "market",
      title: `Put ${formatUnits(amount, 18)} Shares on the market`,
      lines,
    };
  } catch {
    return null;
  }
}

/** Describe a proposal's action: a market, one of the single-call actions, a list of steps, or what it is not known to be. */
export function describeDecision(
  action: { to: string; data: string },
  ctx: DescribeContext = {},
): ActionDescription {
  const batch = decodeBatch(action.data);
  if (batch) {
    const market = marketOf(batch, ctx);
    if (market) return market;
  }
  const trading = describeTrading(action, ctx);
  if (trading) return trading;
  const sales = describeExitSales(action, ctx);
  if (sales) return sales;
  const payouts = describePayouts(action, ctx);
  if (payouts) return payouts;
  return describeAction(action, ctx);
}
