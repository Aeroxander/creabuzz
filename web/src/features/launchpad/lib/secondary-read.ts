/**
 * What the trading card reads from the chain, apart from React so every reader is testable with a fake chain.
 *
 * Every reader here takes the `chain` it reads through, like `readEarlierRounds`, and a read that did not complete
 * throws: a short, garbage or zero-address answer is never turned into a wallet that "holds nothing" or a DAO that
 * "has no market" (Review-Proven Rule 1).
 */

import {
  decodeAddress,
  decodeWord,
  encodeCall0,
} from "@creaton/core/launchpad/work.ts";
import type { DescribeContext } from "@creaton/core/launchpad/daoActions.ts";
import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import {
  encodeAllowance,
  encodeBalanceOf,
} from "@creaton/core/launchpad/workBounty.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";
import {
  decodeRound,
  type EarlierRoundsRead,
  readEarlierRounds,
  readSecondaryMarket,
  SECONDARY_SIGNATURES,
  type SecondaryMarketRead,
} from "@creaton/core/launchpad/secondary.ts";

import { refreshEveryMs, UNKNOWN_QUOTE } from "./trading-copy.ts";
import type { WalletFunds } from "./trading-copy.ts";

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
  /**
   * False when the price token would not say its decimals or symbol: `quoteDecimals` and `quoteSymbol` are then the
   * base-unit placeholder, good for saying what is owed and for nothing else. No price is written, shown or taken.
   */
  quoteKnown: boolean;
}

/** Everything one read of a DAO's market answered. */
export interface SecondaryMarketView {
  /** The adapter's three-way answer: a market, genuinely none, or a read we do not have. */
  read: SecondaryMarketRead;
  /**
   * The DAO's market address once the factory named one, even when its price token could not be read and `read` is
   * `unreadable`: turning trading off needs only this, so the DAO is never left without its off switch.
   */
  market: string | null;
  /** The market's lot size and tokens, or null when there is no market to ask. */
  facts: SecondaryMarketFacts | null;
  /**
   * What the connected wallet can offer and pay with in this market: the Shares it may offer now, the Shares and quote
   * it holds, and what the quote already lets the market take. Null with no wallet or no market. A read that did not
   * complete throws, so the card says it could not read: never a wallet that "holds nothing".
   */
  funds: WalletFunds | null;
  /** The latest round's id, which every order names; null before the first round. */
  roundId: bigint | null;
  /**
   * The rounds before the latest that the connected wallet made an offer or a bid in, newest first. A finished
   * round keeps owing its orders after a newer one opens, so these are read too.
   */
  earlier: EarlierRoundsRead;
  /** The chain's clock when it was read, for the round's windows. */
  now: number;
  /**
   * The market was found, but its price token would not say its decimals or its symbol. The round, its id and what
   * earlier rounds owe are still read, because claiming needs none of the token's units; `facts.quoteKnown` is false,
   * no wallet funds are read, and no price is written or shown: a price at a guessed scale would be wrong by the
   * factor the guess is wrong by.
   */
  tokenUnreadable: boolean;
}

/** One 32-byte answer as a number, or a thrown error: a short or empty answer is a read we do not have, never zero. */
function strictWord(hex: string, what: string): bigint {
  const word = wordOf(hex);
  if (word === null) throw new Error(`${what} did not answer a number`);
  return word;
}

/**
 * What `wallet` can offer and pay with in the market: `saleCapacity` on the market's own policy, the Shares and quote
 * it holds, and the quote's allowance to the market. Every answer must be a number or the whole read throws.
 */
export async function readWalletFunds(
  chain: Pick<WorkChain, "call">,
  input: {
    market: string;
    wallet: string;
    sharesToken: string;
    quoteToken: string;
    policyHex: string;
  },
): Promise<WalletFunds> {
  const policy = decodeAddress(input.policyHex);
  if (policy === ZERO_ADDRESS) {
    throw new Error("the market did not report its sale policy");
  }
  const [capacityHex, sharesHex, quoteHex, allowanceHex] = await Promise.all([
    chain.call(
      policy,
      encodeFunctionData("saleCapacity(address)", ["address"], [input.wallet]),
    ),
    chain.call(input.sharesToken, encodeBalanceOf(input.wallet)),
    chain.call(input.quoteToken, encodeBalanceOf(input.wallet)),
    chain.call(input.quoteToken, encodeAllowance(input.wallet, input.market)),
  ]);
  return {
    saleCapacity: strictWord(capacityHex, "the sale policy"),
    shares: strictWord(sharesHex, "the Shares token"),
    quote: strictWord(quoteHex, "the price token"),
    quoteAllowance: strictWord(allowanceHex, "the price token"),
  };
}

const NO_EARLIER: EarlierRoundsRead = { rounds: [], unchecked: 0n };
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
 * The DAO's market and the units its price token says it uses, for putting a vote that names it in words. Null when
 * the DAO has none. A read that did not complete throws, so a vote is never described against a market we guessed.
 */
export async function readMarketForWords(
  chain: Pick<WorkChain, "call">,
  input: { factory: string; dao: string },
): Promise<DescribeContext["secondaryMarket"] | null> {
  // An empty or malformed answer is a read we do not have, never "this DAO has no market" (Review-Proven Rule 1).
  const word = wordOf(
    await chain.call(
      input.factory,
      encodeFunctionData(
        SECONDARY_SIGNATURES.marketOf,
        ["address"],
        [input.dao],
      ),
    ),
  );
  if (word === null || word >= 1n << 160n) {
    throw new Error("the factory did not answer an address");
  }
  if (word === 0n) return null;
  const answer = `0x${word.toString(16).padStart(40, "0")}`;
  const quoteToken = decodeAddress(
    await chain.call(answer, encodeCall0("quote()")),
  );
  if (quoteToken === ZERO_ADDRESS) {
    throw new Error("the market did not report its price token");
  }
  const units = await readQuoteUnits(chain, quoteToken);
  // A token that would not say its units leaves the market's prices in base units: never a guessed currency.
  return {
    address: answer,
    quoteDecimals: units?.decimals,
    quoteSymbol: units?.symbol,
  };
}

/**
 * One read of a DAO's market for the card: the listing, the latest round, the market's constants, and what the
 * connected wallet can offer, pay with and still collect.
 */
export async function readSecondaryView(
  chain: Pick<WorkChain, "call" | "now">,
  input: { factory: string; dao: string; wallet: string | null },
): Promise<SecondaryMarketView> {
  const now = await chain.now();
  const read = await readSecondaryMarket(chain, {
    factory: input.factory,
    dao: input.dao,
    wallet: input.wallet,
    now,
  });
  // A read that did not complete throws, so the query retries, keeps polling and keeps the last good view: resolving
  // it as a value would replace that view with an apology (Review-Proven Rules 1 and 6).
  if (read.kind === "unreadable") throw new Error(read.reason);
  // No market to ask: the listing, the round and the wallet's orders are all the read has to say.
  if (read.kind !== "present") {
    return {
      read,
      market: null,
      facts: null,
      funds: null,
      roundId: null,
      earlier: NO_EARLIER,
      now,
      tokenUnreadable: false,
    };
  }
  const [lotHex, sharesHex, quoteHex, countHex, policyHex] = await Promise.all([
    chain.call(read.market, encodeCall0("lotSize()")),
    chain.call(read.market, encodeCall0("sharesToken()")),
    chain.call(read.market, encodeCall0("quote()")),
    chain.call(read.market, encodeCall0(SECONDARY_SIGNATURES.roundCount)),
    chain.call(read.market, encodeCall0("policy()")),
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
  // Half of every price is the quote token's own scale, so the token is read for it. A token that will not say it
  // leaves no price to show, but claiming needs none of it: the round, its id and the earlier rounds are still read
  // below, and Settle, Cancel and Collect stay.
  const quote = await readQuoteUnits(chain, quoteToken);
  let roundId: bigint | null = null;
  if (read.round !== null) {
    const count = decodeWord(countHex);
    const at = decodeRound(
      await chain.call(
        read.market,
        encodeFunctionData(SECONDARY_SIGNATURES.rounds, ["uint256"], [count]),
      ),
    );
    if (at.opensAt !== read.round.opensAt) {
      throw new Error("the market opened a round while it was being read");
    }
    roundId = count;
  }
  // What this wallet can offer and pay with only matters to the order forms, which a blind price token closes.
  const funds =
    input.wallet && quote !== null
      ? await readWalletFunds(chain, {
          market: read.market,
          wallet: input.wallet,
          sharesToken,
          quoteToken,
          policyHex,
        })
      : null;
  const earlier =
    roundId !== null && input.wallet
      ? await readEarlierRounds(chain, {
          market: read.market,
          wallet: input.wallet,
          latest: roundId,
          now,
        })
      : NO_EARLIER;
  return {
    read,
    market: read.market,
    facts: {
      lotSize,
      sharesToken,
      quoteToken,
      quoteDecimals: quote?.decimals ?? UNKNOWN_QUOTE.quoteDecimals,
      quoteSymbol: quote?.symbol ?? UNKNOWN_QUOTE.quoteSymbol,
      quoteKnown: quote !== null,
    },
    funds,
    roundId,
    earlier,
    now,
    tokenUnreadable: quote === null,
  };
}

/** The part of a React Query query the card's polling looks at. */
export interface PolledQuery {
  queryHash: string;
  state: {
    status: "pending" | "error" | "success";
    data: SecondaryMarketView | undefined;
    errorUpdateCount: number;
  };
}

/**
 * How long before the card's query reads again, or false: `refreshEveryMs` over what the query holds. A failed read
 * keeps the last good view (the query still has its data) and is looked at again, slower for each failure in a row.
 * `calm` remembers, per query, how many errors it had when it last succeeded, since React Query's own count never
 * goes back down.
 */
export function pollSecondary(
  query: PolledQuery,
  calm: Map<string, number>,
): number | false {
  const { status, data, errorUpdateCount } = query.state;
  if (status === "success") calm.set(query.queryHash, errorUpdateCount);
  const failures =
    status === "error"
      ? Math.max(errorUpdateCount - (calm.get(query.queryHash) ?? 0), 1)
      : 0;
  return refreshEveryMs(data?.read, data?.now, failures);
}
