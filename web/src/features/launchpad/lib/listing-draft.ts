/**
 * What the listing form puts to a vote, worked out from what it has read and typed.
 *
 * Apart from the form so the rule that matters is testable: stopping new rounds needs only the market's address, never
 * the price token's units, so a token that stops answering `decimals()` cannot take the off switch away from the DAO.
 */

import {
  DecisionInputError,
  type DecisionDraft,
  parseUnits,
} from "@creaton/core/launchpad/daoActions.ts";
import type { SecondaryMarketRead } from "@creaton/core/launchpad/secondary.ts";
import { secondaryListingDecision } from "@creaton/core/launchpad/secondaryListing.ts";

/** A vote ready to open, or the sentence that says what is missing. */
export type ListingFormResult = { draft: DecisionDraft } | { problem: string };

/** What the form has: the read of the market, its address, the price token's units and the lot size. */
export interface ListingFormInput {
  /** Whether this build names a market factory on the project's network. */
  factoryKnown: boolean;
  /** The read of the market failed outright, with nothing to show for it. */
  failed: boolean;
  read: SecondaryMarketRead | null;
  /** The DAO's market, even when its price token could not be read; null when there is none or it is not known. */
  market: string | null;
  /** The market's own price token units, or null when it would not say them. */
  quote: { decimals: number; symbol: string } | null;
  lotSize: bigint | null;
  enabled: "on" | "off";
  minText: string;
  maxText: string;
  levelsText: string;
}

/** The form's draft: a refusal is the sentence to show, anything else is a bug and is thrown. */
export function listingFormDraft(input: ListingFormInput): ListingFormResult {
  const { read, market, quote } = input;
  if (!input.factoryKnown) {
    return {
      problem: "This build knows no secondary market on this network.",
    };
  }
  if (!read) {
    return {
      problem: input.failed
        ? "The market could not be read. Reload to try again."
        : "Reading the market…",
    };
  }
  try {
    // Turning the listing off carries no terms and never touches the token, so it needs only the market's address.
    if (input.enabled === "off" && market !== null) {
      return {
        draft: secondaryListingDecision({
          market,
          enabled: false,
          minPrice: 0n,
          maxPrice: 0n,
          levels: 0,
          quoteDecimals: quote?.decimals,
          quoteSymbol: quote?.symbol,
        }),
      };
    }
    if (read.kind === "absent") {
      return {
        problem:
          "This project has no secondary market to publish a listing in.",
      };
    }
    if (read.kind === "unreadable") {
      return {
        problem: `The market could not be read (${read.reason}). Reload to try again.`,
      };
    }
    if (quote === null) {
      return {
        problem: "The market's price token could not be read just now.",
      };
    }
    return {
      draft: secondaryListingDecision({
        market: read.market,
        enabled: true,
        minPrice: parseUnits(
          input.minText,
          quote.decimals,
          "minPrice",
          "The lowest price",
        ),
        maxPrice: parseUnits(
          input.maxText,
          quote.decimals,
          "maxPrice",
          "The highest price",
        ),
        levels: input.levelsText.trim() === "" ? 0 : Number(input.levelsText),
        quoteDecimals: quote.decimals,
        quoteSymbol: quote.symbol,
        lotSize: input.lotSize ?? undefined,
      }),
    };
  } catch (error) {
    if (error instanceof DecisionInputError) return { problem: error.message };
    throw error;
  }
}
