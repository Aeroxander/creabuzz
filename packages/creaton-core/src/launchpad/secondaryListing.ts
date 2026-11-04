/**
 * The vote that publishes a DAO's secondary-market listing, and its words
 * (`docs/v3-review/SECONDARY-LISTING-SPEC.md`).
 *
 * `SecondaryMarket.configureListing` is `onlyDAO` (`contracts/src/SecondaryMarket.sol`), so a
 * listing is never a button: the DAO opens a decision whose one call is that function. The calldata
 * is `secondary.ts`'s own `encodeConfigureListing`, which already refuses the contract's
 * `InvalidTerms` cases, so nothing here encodes a call by hand — this module only decides what a
 * voter is being asked, refuses terms the contract would reject as a reverted vote, and puts the
 * terms in words both when the vote is composed and when somebody else's vote is read back.
 *
 * Units: a price is quote base units per whole lot, and a lot is the market's own `lotSize` Shares
 * base units. Nothing here scales an amount by decimals; the caller says what the quote token's
 * decimals are, and `lotSize` is only used to say what one price buys.
 *
 * Pure: `daoActions.test.mjs` pins the calldata to `cast calldata`.
 */

import {
  type ActionDescription,
  type DecisionDraft,
  DecisionInputError,
  type DescribeContext,
  formatUnits,
} from "./daoActions.ts";
import { decodeParameters, selectorOf } from "./evmAbi.ts";
import { encodeConfigureListing, SECONDARY_SIGNATURES } from "./secondary.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const U128_MAX = (1n << 128n) - 1n;
/** `SecondaryMarket.MAX_LEVELS`: the most price steps a listing may set. */
const MAX_LEVELS = 64;
/** Shares carry 18 decimals everywhere in the kit, so a lot size is read with them. */
const SHARES_DECIMALS = 18;

/** A listing's terms: whether it exists, and the per-lot price grid it runs on. */
interface SecondaryListingTerms {
  enabled: boolean;
  /** The lowest price per whole lot, in the quote token's base units (0 when disabled). */
  minPrice: bigint;
  /** The highest price per whole lot, in the quote token's base units (0 when disabled). */
  maxPrice: bigint;
  /** How many price steps the range is cut into: the step is `(maxPrice - minPrice) / levels` (0 when disabled). */
  levels: number;
}

/** What the vote is composed from: the terms, the market it aims at, and how to say the prices. */
export interface SecondaryListingInput extends SecondaryListingTerms {
  /** The DAO's own market, as `SecondaryMarketFactory.marketOf(dao)` answers it. */
  market: string;
  /**
   * The quote token's decimals, so a price reads as money rather than base units. Needed to open or change a listing;
   * turning one off carries no prices, so it is composed without them.
   */
  quoteDecimals?: number;
  /** The quote token's name, as the vote says it ("USDC"). */
  quoteSymbol?: string;
  /**
   * Shares in one lot (18 decimals), so the vote says what one price buys. Left out, the words say
   * "per lot" instead of a number nobody read.
   */
  lotSize?: bigint;
}

function marketAddress(value: string): string {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed)) {
    throw new DecisionInputError("market", "The market is not an address.");
  }
  return trimmed.toLowerCase();
}

/**
 * The first thing wrong with the terms, as the field to fix and a sentence an operator can act on;
 * null when the contract would accept them. The same rule in one place, so the vote's own preview
 * and a vote read back can never disagree about what the market would take (`InvalidTerms`).
 */
function termsProblem(
  terms: SecondaryListingTerms,
): { field: string; message: string } | null {
  if (!terms.enabled) {
    // The contract ignores the terms when it disables a listing and writes zeros; passing others
    // would put numbers in the calldata that mean nothing to anybody reading the vote.
    if (terms.minPrice !== 0n || terms.maxPrice !== 0n || terms.levels !== 0) {
      return {
        field: "enabled",
        message:
          "A market turned off carries no terms: clear the prices and steps, or leave it on.",
      };
    }
    return null;
  }
  if (terms.minPrice === 0n) {
    return {
      field: "minPrice",
      message: "The lowest price must be above zero.",
    };
  }
  if (terms.minPrice > U128_MAX) {
    return { field: "minPrice", message: "That price is too large." };
  }
  if (terms.maxPrice > U128_MAX) {
    return { field: "maxPrice", message: "That price is too large." };
  }
  if (terms.maxPrice <= terms.minPrice) {
    return {
      field: "maxPrice",
      message: "The highest price must be above the lowest.",
    };
  }
  if (
    !Number.isInteger(terms.levels) ||
    terms.levels < 1 ||
    terms.levels > MAX_LEVELS
  ) {
    return {
      field: "levels",
      message: `Price steps: a whole number from 1 to ${MAX_LEVELS}.`,
    };
  }
  if ((terms.maxPrice - terms.minPrice) % BigInt(terms.levels) !== 0n) {
    return {
      field: "levels",
      message:
        "The range from the lowest price to the highest must divide into whole steps: pick a number of steps that divides it evenly.",
    };
  }
  return null;
}

/** A price per whole lot: at least two decimals, and every decimal the quote token uses beyond that. */
export function listingPrice(
  value: bigint,
  decimals: number | undefined,
): string {
  if (decimals === undefined) return `${value.toString()} base units`;
  const text = formatUnits(value, decimals, Math.max(decimals, 2));
  if (decimals < 2) return text;
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * The vote's title and the facts a voter needs, from terms the contract would take. Disabling says
 * what stops and what does not: the contract freezes terms per round, so no later change can reach
 * settlement, refunds, returns or claims.
 */
function words(input: {
  terms: SecondaryListingTerms;
  quoteDecimals?: number;
  quoteSymbol?: string;
  lotSize?: bigint;
}): { title: string; lines: string[] } {
  const { terms } = input;
  if (!terms.enabled) {
    return {
      title: "Stop new trading rounds (settlement and claims continue)",
      lines: [
        "No round opens and no new offer or bid is taken, until a later vote publishes terms again.",
        "Rounds already open or settled carry on: settlement, refunds, returns and claims all still work.",
      ],
    };
  }
  const symbol = input.quoteSymbol ? ` ${input.quoteSymbol}` : "";
  const lot = input.lotSize
    ? ` for ${formatUnits(input.lotSize, SHARES_DECIMALS)} Shares`
    : "";
  const step = (terms.maxPrice - terms.minPrice) / BigInt(terms.levels);
  return {
    title: `Open a market${lot} between ${listingPrice(terms.minPrice, input.quoteDecimals)} and ${listingPrice(terms.maxPrice, input.quoteDecimals)}${symbol}, in ${terms.levels} price steps`,
    lines: [
      `Each step is ${listingPrice(step, input.quoteDecimals)}${symbol}: the grid runs from the lowest price to the highest, and nothing sells outside it.`,
      "A round opens when anyone asks, at least a week after the last one, and keeps the terms it opened with: a later change never reaches a round already open.",
      "Buyers pay into the market, and sellers' Shares are held by it until the round settles or goes void; claims then pay each side what it is owed.",
      "The DAO itself never sells in it.",
    ],
  };
}

/**
 * The vote that publishes the DAO's listing, or turns it off: exactly one call to the market, with
 * `encodeConfigureListing`'s calldata. Terms the contract would refuse as `InvalidTerms` are refused
 * here, with the field to fix, rather than as a vote that reverts when it runs.
 */
export function secondaryListingDecision(
  input: SecondaryListingInput,
): DecisionDraft {
  const market = marketAddress(input.market);
  // Prices are only scaled on the way on. Turning the listing off carries none, and the contract never touches the
  // token for it, so a token that would not say its units must not stop the DAO from stopping new rounds.
  const decimals = input.quoteDecimals;
  if (
    input.enabled &&
    (decimals === undefined ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 36)
  ) {
    throw new DecisionInputError(
      "quoteDecimals",
      "The sale currency's decimals are not known.",
    );
  }
  const problem = termsProblem(input);
  if (problem) throw new DecisionInputError(problem.field, problem.message);
  const terms: SecondaryListingTerms = input.enabled
    ? {
        enabled: true,
        minPrice: input.minPrice,
        maxPrice: input.maxPrice,
        levels: input.levels,
      }
    : { enabled: false, minPrice: 0n, maxPrice: 0n, levels: 0 };
  return {
    to: market,
    data: encodeConfigureListing({ market, ...terms }),
    // It changes what every holder may do in the market, so it takes the full vote.
    lane: "unrestricted",
    ...words({
      terms,
      quoteDecimals: decimals,
      quoteSymbol: input.quoteSymbol,
      lotSize: input.lotSize,
    }),
  };
}

/**
 * A listing vote in words, or null when the action is not `configureListing` on the DAO's own market.
 * Any contract can carry that selector, so the call is only a listing when it is aimed at the market
 * the context names; with no market named, or another one, it stays unknown. Prices are written in
 * that market's own quote units, and in base units when the market's token did not say them. The
 * calldata carries every term, so nothing is claimed beyond what the call says; a call whose terms
 * the contract would refuse is not dressed up as one it would take, and stays unknown.
 */
export function describeSecondaryListing(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  const market = ctx.secondaryMarket;
  if (!market || action.to.toLowerCase() !== market.address.toLowerCase())
    return null;
  const data = action.data.toLowerCase();
  if (!data.startsWith(selectorOf(SECONDARY_SIGNATURES.configureListing)))
    return null;
  // Four words and nothing else: a shorter or longer call is not this function.
  if (data.length !== 10 + 4 * 64) return null;
  try {
    const [enabled, minPrice, maxPrice, levels] = decodeParameters(
      ["bool", "uint128", "uint128", "uint32"],
      `0x${data.slice(10)}`,
    ) as [boolean, bigint, bigint, bigint];
    const terms: SecondaryListingTerms = {
      enabled,
      minPrice,
      maxPrice,
      levels: Number(levels),
    };
    // A call that turns the listing off needs no terms: the contract writes zeros and ignores them, so only a call
    // that turns it on is checked against the rules it would have to pass.
    if (enabled && termsProblem(terms)) return null;
    return {
      kind: "secondary-listing",
      ...words({
        terms,
        // A symbol without the scale it goes with would label base units as money.
        quoteDecimals: market.quoteDecimals,
        quoteSymbol:
          market.quoteDecimals === undefined ? undefined : market.quoteSymbol,
      }),
    };
  } catch {
    return null;
  }
}
