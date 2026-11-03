import { useQuery } from "@tanstack/react-query";

import {
  decodeAddress,
  decodeWord,
  encodeCall0,
} from "@creaton/core/launchpad/work.ts";
import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import {
  decodeRound,
  readSecondaryMarket,
  SECONDARY_SIGNATURES,
  type SecondaryMarketRead,
} from "@creaton/core/launchpad/secondary.ts";

import { getRpcEndpoint } from "./chain";
import { secondaryMarketFactory } from "./chain-config";
import { endpointChain } from "./use-work";

/** Where every query about the secondary market lives, so a step sent from one re-reads it. */
export const SECONDARY_QUERY = ["launchpad", "secondary"] as const;

/** The market's own constants a price cannot be read without. */
export interface SecondaryMarketFacts {
  /** Shares base units in one lot: what every price is quoted per. */
  lotSize: bigint;
  /** The token a seller escrows, lowercased. */
  sharesToken: string;
  /** The token a buyer pays with, lowercased. */
  quoteToken: string;
}

/** Everything one read of a DAO's market answered. */
export interface SecondaryMarketView {
  /** The adapter's three-way answer: a market, genuinely none, or a read we do not have. */
  read: SecondaryMarketRead;
  /** The market's lot size and tokens, or null when there is no market to ask. */
  facts: SecondaryMarketFacts | null;
  /** The latest round's id, which every order names; null before the first round. */
  roundId: bigint | null;
  /** The chain's clock when it was read, for the round's windows. */
  now: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The DAO's secondary market (docs/v3-review/SECONDARY-LISTING-SPEC.md), when
 * this build names its factory on the project's network: its listing terms, its
 * latest round, the connected wallet's orders in it, and the market's own lot
 * size and tokens so a price can be shown as money and an order approved.
 *
 * A factory this build does not name is not an absent market: the read is not
 * attempted and the card says trading is not set up here. A read that did not
 * complete is `unreadable` — never "this DAO has no market".
 */
export function useSecondary(input: {
  chainId: string | number | null;
  dao: string;
  wallet: string | null;
}) {
  const factory = secondaryMarketFactory(input.chainId);
  const query = useQuery({
    queryKey: [...SECONDARY_QUERY, input.dao, input.wallet, factory],
    enabled: factory !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<SecondaryMarketView> => {
      const chain = endpointChain(getRpcEndpoint());
      const now = await chain.now();
      const read = await readSecondaryMarket(chain, {
        factory: factory as string,
        dao: input.dao,
        wallet: input.wallet,
        now,
      });
      // No market to ask: the listing, the round and the wallet's orders are all the read has to say.
      if (read.kind !== "present") {
        return { read, facts: null, roundId: null, now };
      }
      // The market's three constants, without which a lot has no size and an
      // approval no target. A zero answer is a read we do not have, not a market
      // that trades nothing (Review-Proven Rule 1).
      const [lotHex, sharesHex, quoteHex, countHex] = await Promise.all([
        chain.call(read.market, encodeCall0("lotSize()")),
        chain.call(read.market, encodeCall0("sharesToken()")),
        chain.call(read.market, encodeCall0("quote()")),
        chain.call(read.market, encodeCall0(SECONDARY_SIGNATURES.roundCount)),
      ]);
      const lotSize = decodeWord(lotHex);
      const sharesToken = decodeAddress(sharesHex);
      const quoteToken = decodeAddress(quoteHex);
      if (lotSize === 0n) {
        throw new Error("the market did not report how many Shares one lot is");
      }
      if (sharesToken === ZERO_ADDRESS || quoteToken === ZERO_ADDRESS) {
        throw new Error("the market did not report its tokens");
      }
      // The adapter returns the latest round without its id, and every order
      // names one. `roundCount` is that id (ids start at 1), but it is read
      // after the round, so a round opening in between would name the wrong one:
      // the id counts only if it still opens when the round we hold opened.
      let roundId: bigint | null = null;
      if (read.round !== null) {
        const count = decodeWord(countHex);
        const at = decodeRound(
          await chain.call(
            read.market,
            encodeFunctionData(
              SECONDARY_SIGNATURES.rounds,
              ["uint256"],
              [count],
            ),
          ),
        );
        if (at.opensAt !== read.round.opensAt) {
          throw new Error("the market opened a round while it was being read");
        }
        roundId = count;
      }
      return {
        read,
        facts: { lotSize, sharesToken, quoteToken },
        roundId,
        now,
      };
    },
  });
  return { factory, query };
}
