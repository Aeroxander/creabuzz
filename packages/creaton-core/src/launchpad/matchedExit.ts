/**
 * Matched exits (N5, `contracts/src/MatchedExit.sol`): a holder who wants out signs an offer to sell some Shares at a
 * price they choose, and someone who wants in fills it. The seller keeps the Shares until the fill; the fill pays the
 * seller and moves the Shares in one transaction, and the project's treasury is not touched.
 *
 * While a DAO's Shares are locked, only the exchange the DAO named by vote passes the lock: a vote announces it
 * (`announceExitExchange`), anyone switches it on 30 days later (`activateExitExchange`), and a vote turns it off at once
 * (`clearExitExchange`). Every other check of the Shares still applies, so Shares a lock still holds cannot be sold.
 *
 * An offer travels as a signed record (kind 47009) tagged with the DAO's Shares. The chain is the authority: an offer is
 * shown only while the exchange says it is open and the seller still holds and has approved the Shares.
 *
 * Pure apart from the readers, whose chain is injected (`matchedExit.test.mjs` runs them against a fake one). The
 * selectors are pinned to `cast sig` and the digest to the contract's `digestOf` in the same test.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { KIND_EXIT_OFFER } from "../kinds.generated.ts";
import {
  type ActionDescription,
  type DecisionDraft,
  DecisionInputError,
  type DescribeContext,
} from "./daoActions.ts";
import { encodeFunctionData, encodeParameters, selectorOf } from "./evmAbi.ts";
import { UNLOCK_NOTICE } from "./tradingActions.ts";
import { decodeAddress, decodeBool, decodeWord, encodeCall0 } from "./work.ts";
import { encodeAllowance, encodeBalanceOf } from "./workBounty.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,77})$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The EIP-712 domain the exchange signs in. */
export const EXIT_DOMAIN_NAME = "Creaton matched exit";
export const EXIT_DOMAIN_VERSION = "1";
/** The most offer records read for one DAO; older ones are not looked at. */
export const MAX_EXIT_OFFERS = 50;
/** The largest offer record, in bytes (the server refuses larger). */
export const MAX_EXIT_OFFER_BYTES = 2000;

const OFFER_TUPLE = "(address,address,uint256,uint256,uint64,uint256)";
const OFFER_TYPE = {
  tuple: ["address", "address", "uint256", "uint256", "uint64", "uint256"],
} as const;

export const MATCHED_EXIT_SIGNATURES = {
  fill: `fill(${OFFER_TUPLE},bytes)`,
  cancel: `cancel(${OFFER_TUPLE})`,
  cancelBelow: "cancelBelow(uint256)",
  isOpen: `isOpen(${OFFER_TUPLE},bytes)`,
  minNonce: "minNonce(address)",
  currency: "currency()",
} as const;

/** The Shares' side: naming the exchange, switching it on, turning it off, and reading where that stands. */
export const EXIT_EXCHANGE_SIGNATURES = {
  announce: "announceExitExchange(address)",
  activate: "activateExitExchange()",
  clear: "clearExitExchange()",
  exchange: "exitExchange()",
  pending: "pendingExitExchange()",
  announcedAt: "exitExchangeAnnouncedAt()",
  transfersLocked: "transfersLocked()",
} as const;

/** An offer as the seller signs it: `amount` Shares for `price` of the exchange's currency in all, until `expiry`. */
export interface ExitOfferTerms {
  chainId: number;
  /** The `MatchedExit` contract the offer is signed for. */
  exchange: string;
  shares: string;
  seller: string;
  /** Shares, in base units (18 decimals). */
  amount: bigint;
  /** The whole price, in the currency's base units. */
  price: bigint;
  /** Unix seconds; the offer fills strictly before it. */
  expiry: number;
  nonce: bigint;
}

export interface ExitOffer extends ExitOfferTerms {
  signature: string;
}

function assertAddress(value: string, what: string): string {
  if (!ADDRESS_RE.test(value)) throw new Error(`${what} is not an address`);
  return value.toLowerCase();
}

function assertTerms(terms: ExitOfferTerms): void {
  if (!Number.isSafeInteger(terms.chainId) || terms.chainId <= 0) {
    throw new Error("not a network id");
  }
  assertAddress(terms.exchange, "the exchange");
  assertAddress(terms.shares, "the Shares");
  assertAddress(terms.seller, "the seller");
  if (terms.amount <= 0n || terms.amount >= 1n << 256n) {
    throw new Error("the amount must be above zero");
  }
  if (terms.price <= 0n || terms.price >= 1n << 256n) {
    throw new Error("the price must be above zero");
  }
  if (!Number.isSafeInteger(terms.expiry) || terms.expiry <= 0) {
    throw new Error("not an expiry time");
  }
  if (terms.nonce < 0n || terms.nonce >= 1n << 256n) {
    throw new Error("not an offer number");
  }
}

// ---- signing ----------------------------------------------------------------------------------

/** What `eth_signTypedData_v4` signs for `terms`. */
export function exitOfferTypedData(terms: ExitOfferTerms) {
  assertTerms(terms);
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Offer: [
        { name: "shares", type: "address" },
        { name: "seller", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "price", type: "uint256" },
        { name: "expiry", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "Offer" as const,
    domain: {
      name: EXIT_DOMAIN_NAME,
      version: EXIT_DOMAIN_VERSION,
      chainId: terms.chainId,
      verifyingContract: terms.exchange.toLowerCase(),
    },
    message: {
      shares: terms.shares.toLowerCase(),
      seller: terms.seller.toLowerCase(),
      amount: terms.amount.toString(),
      price: terms.price.toString(),
      expiry: terms.expiry.toString(),
      nonce: terms.nonce.toString(),
    },
  };
}

const keccak = (hex: string): string =>
  `0x${bytesToHex(keccak_256(hexToBytes(hex.slice(2))))}`;
const keccakText = (text: string): string =>
  `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** The EIP-712 digest of `terms`, as the exchange's `digestOf` computes it: one offer, counted once. */
export function exitOfferDigest(terms: ExitOfferTerms): string {
  assertTerms(terms);
  const domain = encodeParameters(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      keccakText(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      ),
      keccakText(EXIT_DOMAIN_NAME),
      keccakText(EXIT_DOMAIN_VERSION),
      BigInt(terms.chainId),
      terms.exchange.toLowerCase(),
    ],
  );
  const struct = encodeParameters(
    [
      "bytes32",
      "address",
      "address",
      "uint256",
      "uint256",
      "uint64",
      "uint256",
    ],
    [
      keccakText(
        "Offer(address shares,address seller,uint256 amount,uint256 price,uint64 expiry,uint256 nonce)",
      ),
      terms.shares.toLowerCase(),
      terms.seller.toLowerCase(),
      terms.amount,
      terms.price,
      BigInt(terms.expiry),
      terms.nonce,
    ],
  );
  return keccak(`0x1901${keccak(domain).slice(2)}${keccak(struct).slice(2)}`);
}

// ---- the record (kind 47009) ---------------------------------------------------------------------

/** The `t` tag a DAO's offers carry. */
export function exitTopic(chainId: number, shares: string): string {
  return `exit:${chainId}:${assertAddress(shares, "the Shares")}`;
}

/** The record that carries a signed offer, in the shape the server checks. */
export function exitOfferTemplate(offer: ExitOffer): {
  kind: number;
  tags: string[][];
  content: string;
} {
  assertTerms(offer);
  if (!HEX_RE.test(offer.signature)) throw new Error("not a signature");
  const content = JSON.stringify({
    chainId: offer.chainId,
    exchange: offer.exchange.toLowerCase(),
    shares: offer.shares.toLowerCase(),
    seller: offer.seller.toLowerCase(),
    amount: offer.amount.toString(),
    price: offer.price.toString(),
    expiry: offer.expiry,
    nonce: offer.nonce.toString(),
    signature: offer.signature.toLowerCase(),
  });
  if (utf8ToBytes(content).length > MAX_EXIT_OFFER_BYTES) {
    throw new Error("the signature is too long to publish");
  }
  return {
    kind: KIND_EXIT_OFFER,
    tags: [["t", exitTopic(offer.chainId, offer.shares)]],
    content,
  };
}

interface EventLike {
  kind: number;
  tags: string[][];
  content: string;
}

/** An offer record read back, or null for anything the server would refuse or the exchange could not fill. */
export function parseExitOffer(event: EventLike): ExitOffer | null {
  if (event.kind !== KIND_EXIT_OFFER) return null;
  const topics = event.tags.filter((t) => t[0] === "t");
  if (topics.length !== 1) return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (key: string) =>
    typeof body[key] === "string" ? (body[key] as string) : "";
  const { chainId, expiry } = body;
  if (typeof chainId !== "number" || typeof expiry !== "number") return null;
  for (const key of ["exchange", "shares", "seller"]) {
    if (!ADDRESS_RE.test(text(key))) return null;
  }
  for (const key of ["amount", "price", "nonce"]) {
    if (!DECIMAL_RE.test(text(key))) return null;
  }
  if (!HEX_RE.test(text("signature"))) return null;
  const offer: ExitOffer = {
    chainId,
    exchange: text("exchange").toLowerCase(),
    shares: text("shares").toLowerCase(),
    seller: text("seller").toLowerCase(),
    amount: BigInt(text("amount")),
    price: BigInt(text("price")),
    expiry,
    nonce: BigInt(text("nonce")),
    signature: text("signature").toLowerCase(),
  };
  try {
    assertTerms(offer);
    if (topics[0][1] !== exitTopic(chainId, offer.shares)) return null;
  } catch {
    return null;
  }
  return offer;
}

// ---- calls ------------------------------------------------------------------------------------

const offerTuple = (o: ExitOfferTerms) => [
  o.shares.toLowerCase(),
  o.seller.toLowerCase(),
  o.amount,
  o.price,
  BigInt(o.expiry),
  o.nonce,
];

export function encodeFill(offer: ExitOffer): string {
  assertTerms(offer);
  return encodeFunctionData(
    MATCHED_EXIT_SIGNATURES.fill,
    [OFFER_TYPE, "bytes"],
    [offerTuple(offer), offer.signature],
  );
}

export function encodeIsOpen(offer: ExitOffer): string {
  assertTerms(offer);
  return encodeFunctionData(
    MATCHED_EXIT_SIGNATURES.isOpen,
    [OFFER_TYPE, "bytes"],
    [offerTuple(offer), offer.signature],
  );
}

export function encodeCancelOffer(offer: ExitOfferTerms): string {
  assertTerms(offer);
  return encodeFunctionData(
    MATCHED_EXIT_SIGNATURES.cancel,
    [OFFER_TYPE],
    [offerTuple(offer)],
  );
}

/** Cancel every offer of the caller numbered below `nonce`. */
export function encodeCancelBelow(nonce: bigint): string {
  if (nonce <= 0n || nonce >= 1n << 256n)
    throw new Error("not an offer number");
  return encodeFunctionData(
    MATCHED_EXIT_SIGNATURES.cancelBelow,
    ["uint256"],
    [nonce],
  );
}

export const encodeActivateExitExchange = (): string =>
  encodeCall0(EXIT_EXCHANGE_SIGNATURES.activate);

// ---- decisions ----------------------------------------------------------------------------------

function sharesAddress(value: string): string {
  if (!ADDRESS_RE.test(value.trim())) {
    throw new DecisionInputError(
      "sharesToken",
      "The project's Shares are not an address.",
    );
  }
  return value.trim().toLowerCase();
}

/** The vote that names the exchange: sales between members can be switched on 30 days after it runs, not before. */
export function allowExitSalesDecision(input: {
  sharesToken: string;
  exchange: string;
}): DecisionDraft {
  if (!ADDRESS_RE.test(input.exchange.trim())) {
    throw new DecisionInputError(
      "exchange",
      "Sales between members are not set up on this network.",
    );
  }
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeFunctionData(
      EXIT_EXCHANGE_SIGNATURES.announce,
      ["address"],
      [input.exchange.trim().toLowerCase()],
    ),
    lane: "unrestricted",
    title: "Allow sales between members in 30 days",
    lines: [
      "A member who wants out can then offer Shares at a price they choose, and someone who wants in can buy them. The money goes to the seller, not the project.",
      "Sales can be switched on 30 days after this runs, and not before. The contracts enforce the wait.",
      "Shares still locked to work can't be sold, and a later vote can turn sales off at once.",
    ],
  };
}

/**
 * The vote that names weekly rounds (D131) as the exchange: members who want out are matched with new buyers once a week
 * at one price. The same 30-day route as matched offers; a DAO has one exchange or the other.
 */
export function allowRoundsDecision(input: {
  sharesToken: string;
  exchange: string;
}): DecisionDraft {
  if (!ADDRESS_RE.test(input.exchange.trim())) {
    throw new DecisionInputError(
      "exchange",
      "Weekly rounds are not set up on this network.",
    );
  }
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeFunctionData(
      EXIT_EXCHANGE_SIGNATURES.announce,
      ["address"],
      [input.exchange.trim().toLowerCase()],
    ),
    lane: "unrestricted",
    title: "Start weekly rounds in 30 days",
    lines: [
      "Once a week, members who want out are matched with people who want in, at one price, never below what leaving pays. The treasury keeps its money, and a fifth of a seller's gain above that goes to it.",
      "Rounds can be switched on 30 days after this runs, and not before. The contracts enforce the wait.",
      "Shares still locked to work can't be sold, anyone can still leave, and a later vote can turn rounds off at once.",
    ],
  };
}

/** The vote that turns sales between members off: at once, and turning them on again needs another 30 days. */
export function stopExitSalesDecision(input: {
  sharesToken: string;
}): DecisionDraft {
  return {
    to: sharesAddress(input.sharesToken),
    data: encodeCall0(EXIT_EXCHANGE_SIGNATURES.clear),
    lane: "unrestricted",
    title: "Turn off sales between members",
    lines: [
      "Offers can no longer be filled. Members can still leave with their part of the treasury.",
      "Turning sales on again needs a new vote and another 30 days.",
    ],
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A matched-sales decision in words, or null when the action is not one aimed at this project's Shares. */
export function describeExitSales(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  if (!ctx.projectToken || !same(action.to, ctx.projectToken)) return null;
  const data = action.data.toLowerCase();
  const sel = data.slice(0, 10);
  if (
    sel === selectorOf(EXIT_EXCHANGE_SIGNATURES.clear) &&
    data.length === 10
  ) {
    const draft = stopExitSalesDecision({ sharesToken: action.to });
    return { kind: "trading", title: draft.title, lines: draft.lines };
  }
  if (
    sel === selectorOf(EXIT_EXCHANGE_SIGNATURES.announce) &&
    data.length === 74 &&
    /^0{24}/.test(data.slice(10, 34))
  ) {
    const exchange = `0x${data.slice(34, 74)}`;
    if (ctx.weeklyRounds && same(exchange, ctx.weeklyRounds)) {
      const draft = allowRoundsDecision({ sharesToken: action.to, exchange });
      return { kind: "trading", title: draft.title, lines: draft.lines };
    }
    const known = ctx.matchedExit ? same(exchange, ctx.matchedExit) : false;
    if (known) {
      const draft = allowExitSalesDecision({
        sharesToken: action.to,
        exchange,
      });
      return { kind: "trading", title: draft.title, lines: draft.lines };
    }
    const named = ctx.label ? ctx.label(exchange) : exchange;
    return {
      kind: "trading",
      title: "Let another contract move Shares in 30 days",
      lines: [
        `This names ${named} as the exchange, and it is not the one this app knows. It could move the Shares of anyone who allows it to.`,
        "It can be switched on 30 days after this runs, and a later vote can turn it off at once.",
      ],
    };
  }
  return null;
}

// ---- reads ---------------------------------------------------------------------------------------

/** Where sales between members stand for a DAO's Shares. */
export interface ExitExchangeRead {
  transfersLocked: boolean;
  /** The exchange that passes the lock, or null. */
  exchange: string | null;
  /** An exchange voted in and waiting for its 30 days, or null. */
  pending: string | null;
  /** When the pending exchange was announced (unix seconds), or 0. */
  announcedAt: number;
}

export async function readExitExchange(
  chain: Pick<WorkChain, "call">,
  shares: string,
): Promise<ExitExchangeRead> {
  const to = assertAddress(shares, "the Shares");
  const [locked, exchange, pending, announcedAt] = await Promise.all([
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.transfersLocked)),
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.exchange)),
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.pending)),
    chain.call(to, encodeCall0(EXIT_EXCHANGE_SIGNATURES.announcedAt)),
  ]);
  const addressOrNull = (hex: string) => {
    const a = decodeAddress(hex);
    return a === ZERO ? null : a;
  };
  return {
    transfersLocked: decodeBool(locked),
    exchange: addressOrNull(exchange),
    pending: addressOrNull(pending),
    announcedAt: Number(decodeWord(announcedAt)),
  };
}

export type ExitSalesPhase =
  /** Shares are not locked: they trade anywhere, and this exchange adds nothing. */
  | "unlocked"
  | "off"
  /** Voted in, waiting for the 30 days. */
  | "announced"
  /** The 30 days are over: anyone can switch it on. */
  | "ready"
  | "on"
  /** The named or pending exchange is not the one this app knows. */
  | "other";

export function exitSalesState(
  read: ExitExchangeRead,
  known: string | null,
  now: number,
): { phase: ExitSalesPhase; opensAt: number | null } {
  if (!read.transfersLocked) return { phase: "unlocked", opensAt: null };
  const ours = (a: string | null) =>
    a !== null && known !== null && same(a, known);
  if (read.exchange !== null) {
    return { phase: ours(read.exchange) ? "on" : "other", opensAt: null };
  }
  if (read.pending === null) return { phase: "off", opensAt: null };
  if (!ours(read.pending)) return { phase: "other", opensAt: null };
  const opensAt = read.announcedAt + UNLOCK_NOTICE;
  return { phase: now >= opensAt ? "ready" : "announced", opensAt };
}

/** One offer as the chain sees it now. */
export interface OfferStatus {
  digest: string;
  /** Signed, unexpired, not cancelled or filled, as the exchange says. */
  open: boolean;
  sellerBalance: bigint;
  allowance: bigint;
  /** Whether a fill would go through as far as can be told before trying: open, held and allowed. */
  fillable: boolean;
}

export async function readOfferStatus(
  chain: Pick<WorkChain, "call">,
  offer: ExitOffer,
): Promise<OfferStatus> {
  const [open, balance, allowance] = await Promise.all([
    chain.call(offer.exchange, encodeIsOpen(offer)),
    chain.call(offer.shares, encodeBalanceOf(offer.seller)),
    chain.call(offer.shares, encodeAllowance(offer.seller, offer.exchange)),
  ]);
  const isOpen = decodeBool(open);
  const sellerBalance = decodeWord(balance);
  const allowed = decodeWord(allowance);
  return {
    digest: exitOfferDigest(offer),
    open: isOpen,
    sellerBalance,
    allowance: allowed,
    fillable:
      isOpen && sellerBalance >= offer.amount && allowed >= offer.amount,
  };
}

/** The lowest offer number a seller can still use (`cancelBelow` raises it). */
export async function readMinNonce(
  chain: Pick<WorkChain, "call">,
  exchange: string,
  seller: string,
): Promise<bigint> {
  return decodeWord(
    await chain.call(
      assertAddress(exchange, "the exchange"),
      encodeFunctionData(
        MATCHED_EXIT_SIGNATURES.minNonce,
        ["address"],
        [assertAddress(seller, "the seller")],
      ),
    ),
  );
}

/**
 * The offers worth showing from a DAO's records: for this chain, exchange and Shares, unexpired at `now`, each offer once
 * however many records repeat it, cheapest per Share first.
 */
export function distinctOffers(
  offers: readonly ExitOffer[],
  scope: { chainId: number; exchange: string; shares: string },
  now: number,
): ExitOffer[] {
  const seen = new Set<string>();
  const kept: ExitOffer[] = [];
  for (const offer of offers) {
    if (
      offer.chainId !== scope.chainId ||
      !same(offer.exchange, scope.exchange) ||
      !same(offer.shares, scope.shares) ||
      now >= offer.expiry
    ) {
      continue;
    }
    const digest = exitOfferDigest(offer);
    if (seen.has(digest)) continue;
    seen.add(digest);
    kept.push(offer);
  }
  // Price per Share, compared without rounding: a/b < c/d ⇔ a·d < c·b.
  return kept.sort((a, b) => {
    const left = a.price * b.amount;
    const right = b.price * a.amount;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
