import { useQuery } from "@tanstack/react-query";

import {
  decodeAddress,
  decodeWord,
  encodeCall0,
} from "@creaton/core/launchpad/work.ts";
import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";
import {
  decodeRound,
  readSecondaryMarket,
  SECONDARY_SIGNATURES,
  type SecondaryMarketRead,
} from "@creaton/core/launchpad/secondary.ts";

import { getRpcEndpoint } from "./chain";
import { secondaryMarketFactory } from "./chain-config";
import { refreshEveryMs } from "./lib/trading-copy";
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
  /** The quote token's own decimals: the scale every price is written at. */
  quoteDecimals: number;
  /** The quote token's own symbol, as the token names itself. */
  quoteSymbol: string;
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
  /**
   * The market was found, but its price token would not say its decimals or its
   * symbol. `read` is then `unreadable` and there are no `facts`: a price written
   * at a guessed scale would be wrong by the factor the guess is wrong by.
   */
  tokenUnreadable: boolean;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** The most decimals a price scale may have: `decimals()` is a uint8, and no token in use goes near this. */
const MAX_QUOTE_DECIMALS = 36;
/** The most characters a token symbol may be, so a token cannot write a paragraph where a unit goes. */
const MAX_SYMBOL = 32;

/** One 32-byte word, or null when the answer is not exactly one. */
function wordOf(hex: string): bigint | null {
  const body = typeof hex === "string" ? hex.replace(/^0x/, "") : "";
  return /^[0-9a-fA-F]{64}$/.test(body) ? BigInt(`0x${body}`) : null;
}

/** The token's `decimals()`, or null when it did not answer a scale a price can be written at. */
function decodeDecimals(hex: string): number | null {
  const word = wordOf(hex);
  if (word === null || word > BigInt(MAX_QUOTE_DECIMALS)) return null;
  return Number(word);
}

/** Printable ASCII, cut at the first zero byte; null when it is not a symbol a person could read. */
function textOf(hexBytes: string): string | null {
  let text = "";
  for (const byte of hexBytes.match(/.{2}/g) ?? []) {
    const code = Number.parseInt(byte, 16);
    if (code === 0) break;
    if (code < 0x20 || code > 0x7e) return null;
    text += String.fromCharCode(code);
  }
  return text.length > 0 && text.length <= MAX_SYMBOL ? text : null;
}

/** The token's `symbol()`, as the standard string or a `bytes32`, or null when it did not answer one. */
function decodeSymbol(hex: string): string | null {
  const body = typeof hex === "string" ? hex.replace(/^0x/, "") : "";
  if (body.length === 0 || body.length % 64 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(body)) return null;
  const words = body.match(/.{64}/g) ?? [];
  // The standard string shape: the offset of the bytes, their length, then the bytes right-padded.
  if (words.length >= 3 && BigInt(`0x${words[0]}`) === 32n) {
    const length = Number(BigInt(`0x${words[1]}`));
    if (length === 0 || length > MAX_SYMBOL) return null;
    return textOf(body.slice(128, 128 + length * 2));
  }
  // A token whose `symbol()` is a `bytes32` answers one right-padded word.
  return words.length === 1 ? textOf(words[0]) : null;
}

/**
 * The market's price token's own units, or null when it would not say them.
 *
 * A token that does not implement `decimals()`/`symbol()`, or answers something
 * that is not a scale and a symbol, gives us no scale to write a price at. That
 * is a read we do not have — never 6 and "USDC", which would misprint every
 * price of a token with other decimals (Review-Proven Rule 1).
 */
async function readQuoteUnits(
  chain: Pick<WorkChain, "call">,
  quoteToken: string,
): Promise<{ decimals: number; symbol: string } | null> {
  try {
    const [decimalsHex, symbolHex] = await Promise.all([
      chain.call(quoteToken, encodeCall0("decimals()")),
      chain.call(quoteToken, encodeCall0("symbol()")),
    ]);
    const decimals = decodeDecimals(decimalsHex);
    const symbol = decodeSymbol(symbolHex);
    return decimals === null || symbol === null ? null : { decimals, symbol };
  } catch {
    // A token that does not implement them refuses the call: the same "no answer" as a nonsense one.
    return null;
  }
}

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
    // A round closes and times out by the clock, with no one acting, so a card left open re-reads
    // while one is live and shows "Settle the round" the moment bidding ends.
    refetchInterval: (q) => refreshEveryMs(q.state.data?.read),
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
        return {
          read,
          facts: null,
          roundId: null,
          now,
          tokenUnreadable: false,
        };
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
      // Half of every price is the quote token's own scale, so the token is read
      // for it: a token that will not say its decimals or its symbol leaves no
      // price to show, and that is a read we do not have rather than a guess.
      const quote = await readQuoteUnits(chain, quoteToken);
      if (quote === null) {
        return {
          read: {
            kind: "unreadable",
            reason:
              "the market's price token did not say its decimals and its symbol",
          },
          facts: null,
          roundId: null,
          now,
          tokenUnreadable: true,
        };
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
        facts: {
          lotSize,
          sharesToken,
          quoteToken,
          quoteDecimals: quote.decimals,
          quoteSymbol: quote.symbol,
        },
        roundId,
        now,
        tokenUnreadable: false,
      };
    },
  });
  return { factory, query };
}
