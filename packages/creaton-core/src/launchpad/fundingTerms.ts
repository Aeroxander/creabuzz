/**
 * Funding terms (D133, `contracts/src/FundingTerms.sol`, docs/v3-review/FUNDING-TERMS.md): the votes that publish them
 * and open tranches, a DAO's terms as the chain sees them, where they stand, and those votes in words.
 *
 * Units and prices: units have 18 decimals; a least price is in the round's currency per whole unit. Pure apart from the
 * reader, whose chain is injected (`fundingTerms.test.mjs` runs it against a fake one); selectors are pinned to `cast` in
 * the same test.
 */

import type {
  ActionDescription,
  DecisionDraft,
  DescribeContext,
} from "./daoActions.ts";
import { DecisionInputError } from "./daoActions.ts";
import { decodeParameters, encodeFunctionData, selectorOf } from "./evmAbi.ts";
import { decodeAddress, decodeWord, encodeCall0 } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;
const UNIT = 10n ** 18n;
const MAX_U128 = (1n << 128n) - 1n;

/** How long after terms are published, or widened, before anything under them sells. */
export const FUNDING_NOTICE = 30 * DAY;
/** The highest exit fee terms can set (D135), in basis points. */
export const MAX_EXIT_FEE_BPS = 500;

export const FUNDING_SIGNATURES = {
  publish: "publish(bool,uint128,address,uint16)",
  lowerExitFee: "lowerExitFee(uint16)",
  exitFeeOf: "exitFeeOf(address)",
  watch: "watch(address[])",
  /** Any holder: stop sales while the treasury holds a token (D136). */
  flag: "flag(address,address)",
  accept: "accept(address[],bool)",
  watchedOf: "watchedOf(address)",
  lowerCap: "lowerCap(uint128)",
  openTranche: "openTranche(uint128,uint128,uint64)",
  closeTranche: "closeTranche()",
  terms: "terms(address)",
  tranches: "tranches(address)",
  reserved: "reserved(address)",
  /** On the work budget factory: the funding-terms contract of its summoner. */
  fundingTerms: "fundingTerms()",
  /** On the weekly rounds contract. */
  openFunding: "openFunding(address)",
  lastFunding: "lastFunding(address)",
} as const;

function contract(value: string): string {
  if (!ADDRESS_RE.test(value.trim())) {
    throw new DecisionInputError(
      "terms",
      "Funding terms are not set up on this network.",
    );
  }
  return value.trim().toLowerCase();
}

function units128(value: bigint, field: string, what: string): bigint {
  if (value <= 0n || value > MAX_U128) {
    throw new DecisionInputError(field, `${what} must be above zero.`);
  }
  return value;
}

const whole = (u: bigint) => {
  const int = u / UNIT;
  const frac = (u % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac.slice(0, 4)}` : int.toString();
};
/** Basis points as a percentage: 200 → "2%", 250 → "2.5%". */
export function feePercent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function exitFee(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_EXIT_FEE_BPS) {
    throw new DecisionInputError(
      "exitFee",
      `The exit fee must be between 0% and ${feePercent(MAX_EXIT_FEE_BPS)}.`,
    );
  }
  return value;
}

const money = (u: bigint) => {
  const int = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${frac ? `${int}.${frac}` : int} USDC`;
};

// ---- the votes -----------------------------------------------------------------------------------

/**
 * Publish funding terms: what buyers get, the current authorised funding limit, the one rounds contract that may sell
 * under them, and the exit fee (D135). Nothing sells, and no fee is charged, for 30 days after it runs. Raising the limit
 * later is the same call, with the same fee and new notice.
 */
export function publishFundingDecision(input: {
  terms: string;
  asShares: boolean;
  cap: bigint;
  /** The weekly rounds contract that will sell (this app's), named in the vote and fixed for good. */
  rounds: string;
  /** The part of what leaving pays that stays in the treasury, in basis points; fixed when first published. */
  exitFeeBps: number;
  /** Units that exist now (all Shares and Loot), to say what the limit is as a share of them; null when unknown. */
  unitsNow: bigint | null;
  /** Raising the limit of terms already published. */
  raising?: boolean;
}): DecisionDraft {
  const cap = units128(input.cap, "cap", "The funding limit");
  const fee = exitFee(input.exitFeeBps);
  if (!ADDRESS_RE.test(input.rounds.trim())) {
    throw new DecisionInputError(
      "rounds",
      "Weekly rounds are not set up on this network.",
    );
  }
  const share =
    input.unitsNow && input.unitsNow > 0n
      ? ` (${((cap * 1000n) / input.unitsNow / 10n).toString()}% of the ${whole(input.unitsNow)} units there are now)`
      : "";
  return {
    to: contract(input.terms),
    data: encodeFunctionData(
      FUNDING_SIGNATURES.publish,
      ["bool", "uint128", "address", "uint16"],
      [input.asShares, cap, input.rounds.trim().toLowerCase(), BigInt(fee)],
    ),
    lane: "unrestricted",
    title: input.raising
      ? `Raise the funding limit to ${whole(cap)} new units`
      : `Set a funding limit of ${whole(cap)} new ${input.asShares ? "Shares" : "Loot"}`,
    lines: [
      `Up to ${whole(cap)} new units may be sold for money for the project${share}. This is the current limit: a later vote can raise it, with another 30 days' notice.`,
      input.asShares
        ? "Buyers get Shares, with a vote."
        : "Buyers get Loot: the same part of the treasury and of payouts as a Share, but no vote.",
      `Only the weekly rounds at ${input.rounds.trim().toLowerCase()} may sell them, and nothing is sold until 30 days after this runs, so anyone who disagrees can leave first. Each sale then needs its own vote.`,
      fee === 0
        ? "No exit fee: leaving pays a whole share."
        : `Exit fee ${feePercent(fee)}: that part of what leaving pays stays in the treasury, for those who stay. It is not charged during the 30 days' notice, and a vote can lower it but never raise it.`,
    ],
  };
}

/** The most tokens checked for one DAO. */
export const MAX_WATCHED = 16;

function tokenList(tokens: readonly string[]): string[] {
  if (tokens.length === 0) {
    throw new DecisionInputError("tokens", "Name at least one token.");
  }
  if (tokens.length > MAX_WATCHED) {
    throw new DecisionInputError(
      "tokens",
      `Name at most ${MAX_WATCHED} tokens.`,
    );
  }
  for (const t of tokens) {
    if (!ADDRESS_RE.test(t)) {
      throw new DecisionInputError("tokens", `${t} is not an address.`);
    }
  }
  return tokens.map((t) => t.toLowerCase());
}

/**
 * Stop sales while the treasury holds any of these tokens (besides the round's currency; ETH always stops them): a
 * price set in one asset would otherwise give buyers part of the others for nothing. It only adds to the list (D136).
 */
export function watchAssetsDecision(input: {
  terms: string;
  tokens: readonly string[];
}): DecisionDraft {
  const tokens = tokenList(input.tokens);
  return {
    to: contract(input.terms),
    data: encodeFunctionData(
      FUNDING_SIGNATURES.watch,
      [{ array: "address" }],
      [tokens],
    ),
    lane: "unrestricted",
    title: `Stop sales while the treasury holds ${tokens.length === 1 ? "this token" : `any of ${tokens.length} tokens`}`,
    lines: [
      `Sales stop while the treasury holds ETH or any of: ${tokens.join(", ")}. A token stays on the list until the treasury no longer holds it, or a vote lets sales go ahead anyway.`,
    ],
  };
}

/**
 * Let sales go ahead while the treasury holds these tokens (`yes`), or stop them again (D136). Going ahead means buyers
 * get part of those tokens too, without paying for it: the vote is how holders agree to that.
 */
export function acceptTokensDecision(input: {
  terms: string;
  tokens: readonly string[];
  yes: boolean;
}): DecisionDraft {
  const tokens = tokenList(input.tokens);
  const which =
    tokens.length === 1 ? "this token" : `any of ${tokens.length} tokens`;
  return {
    to: contract(input.terms),
    data: encodeFunctionData(
      FUNDING_SIGNATURES.accept,
      [{ array: "address" }, "bool"],
      [tokens, input.yes],
    ),
    lane: "unrestricted",
    title: input.yes
      ? `Sell even while the treasury holds ${which}`
      : `Stop sales again while the treasury holds ${which}`,
    lines: input.yes
      ? [
          `Sales go ahead although the treasury holds ${tokens.join(", ")}. Sale prices count only the round's currency, so buyers get part of these tokens too without paying for it: those who hold now give that up.`,
        ]
      : [
          `Sales stop again while the treasury holds ${tokens.join(", ")}, and any holder can stop them over these tokens again.`,
        ],
  };
}

/** A holder's own call, not a vote: stop `dao`'s sales while its treasury holds `token` (D136). */
export function encodeFlagToken(dao: string, token: string): string {
  for (const a of [dao, token]) {
    if (!ADDRESS_RE.test(a.trim())) {
      throw new DecisionInputError("token", `${a} is not an address.`);
    }
  }
  return encodeFunctionData(
    FUNDING_SIGNATURES.flag,
    ["address", "address"],
    [dao.trim().toLowerCase(), token.trim().toLowerCase()],
  );
}

/** Open a tranche within the terms: sold in funding rounds, at no less than `leastPrice` a unit, until `expiry`. */
export function openTrancheDecision(input: {
  terms: string;
  quantity: bigint;
  leastPrice: bigint;
  expiry: number;
}): DecisionDraft {
  const quantity = units128(input.quantity, "quantity", "How many units");
  const least = units128(input.leastPrice, "leastPrice", "The least price");
  if (!Number.isInteger(input.expiry) || input.expiry <= 0) {
    throw new DecisionInputError("expiry", "Choose when the sale ends.");
  }
  const date = new Date(input.expiry * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return {
    to: contract(input.terms),
    data: encodeFunctionData(
      FUNDING_SIGNATURES.openTranche,
      ["uint128", "uint128", "uint64"],
      [quantity, least, BigInt(input.expiry)],
    ),
    lane: "unrestricted",
    title: `Sell up to ${whole(quantity)} new units for the project`,
    lines: [
      `Offered in weekly funding rounds at ${money(least)} a unit or more, until ${date}. Bids set the price above that.`,
      "Every payment goes to the treasury. Nothing sells below a unit's share of the treasury, plus 2%.",
    ],
  };
}

export function closeTrancheDecision(input: { terms: string }): DecisionDraft {
  return {
    to: contract(input.terms),
    data: encodeCall0(FUNDING_SIGNATURES.closeTranche),
    lane: "unrestricted",
    title: "Stop selling for the project",
    lines: [
      "What is left of the current sale is no longer offered. What was sold stays sold.",
    ],
  };
}

/** Lower the most that can ever be sold, at once. */
export function lowerCapDecision(input: {
  terms: string;
  cap: bigint;
}): DecisionDraft {
  const cap = units128(input.cap, "cap", "The new most");
  return {
    to: contract(input.terms),
    data: encodeFunctionData(FUNDING_SIGNATURES.lowerCap, ["uint128"], [cap]),
    lane: "unrestricted",
    title: `Lower the funding limit to ${whole(cap)} new units`,
    lines: [
      "This takes effect at once. Raising it again needs a vote and 30 days' notice.",
    ],
  };
}

/** Lower the exit fee, at once (D135); it can never be raised again. */
export function lowerExitFeeDecision(input: {
  terms: string;
  exitFeeBps: number;
}): DecisionDraft {
  const fee = exitFee(input.exitFeeBps);
  return {
    to: contract(input.terms),
    data: encodeFunctionData(
      FUNDING_SIGNATURES.lowerExitFee,
      ["uint16"],
      [BigInt(fee)],
    ),
    lane: "unrestricted",
    title:
      fee === 0
        ? "Remove the exit fee"
        : `Lower the exit fee to ${feePercent(fee)}`,
    lines: [
      "This takes effect at once, for everyone who leaves after it. No vote can raise it again.",
    ],
  };
}

// ---- reads -----------------------------------------------------------------------------------------

export interface FundingTermsView {
  /** The funding-terms contract the DAO's summoner uses. */
  contract: string;
  published: boolean;
  /** The one rounds contract that may sell under the terms, or null before any. */
  rounds: string | null;
  /** Tokens whose presence in the treasury stops sales (ETH always does). */
  watched: string[];
  asShares: boolean;
  /** When sales under the terms may start (unix seconds); 0 before any terms. */
  activeFrom: number;
  cap: bigint;
  sold: bigint;
  /** The exit fee the terms set, in basis points; charged only once they are past their notice. */
  exitFeeBps: number;
  tranche: {
    quantity: bigint;
    taken: bigint;
    leastPrice: bigint;
    expiry: number;
  } | null;
  /** Units an open funding round holds. */
  reserved: bigint;
}

export type FundingPhase =
  /** No terms: nothing new can be sold. */
  | "none"
  /** Published, within the 30 days' notice. */
  | "notice"
  /** Active, no sale open. */
  | "ready"
  /** A sale is open with units left. */
  | "selling";

/** Units of the open tranche not yet sold: what an open funding round holds counts as still on sale. */
export function unsoldOfTranche(view: FundingTermsView): bigint {
  const t = view.tranche;
  if (!t) return 0n;
  return t.quantity - (t.taken - view.reserved);
}

export function fundingPhase(
  view: FundingTermsView,
  now: number,
): FundingPhase {
  if (!view.published) return "none";
  if (now < view.activeFrom) return "notice";
  const t = view.tranche;
  if (
    t &&
    now < t.expiry &&
    unsoldOfTranche(view) > 0n &&
    view.sold < view.cap
  ) {
    return "selling";
  }
  return "ready";
}

/** The funding-terms contract of a DAO, read from its work budget factory; null where the factory predates it. */
export async function readFundingContract(
  chain: Pick<WorkChain, "call">,
  factory: string,
): Promise<string | null> {
  try {
    const at = decodeAddress(
      await chain.call(factory, encodeCall0(FUNDING_SIGNATURES.fundingTerms)),
    );
    return /^0x0{40}$/.test(at) ? null : at;
  } catch {
    return null;
  }
}

const words = (hex: string): bigint[] => {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return out;
};

export async function readFundingTerms(
  chain: Pick<WorkChain, "call">,
  terms: string,
  dao: string,
): Promise<FundingTermsView> {
  const at = contract(terms);
  const of = (sig: string) =>
    encodeFunctionData(sig, ["address"], [dao.toLowerCase()]);
  const [t, tr, reserved, watchedHex] = await Promise.all([
    chain.call(at, of(FUNDING_SIGNATURES.terms)),
    chain.call(at, of(FUNDING_SIGNATURES.tranches)),
    chain.call(at, of(FUNDING_SIGNATURES.reserved)).then(decodeWord),
    chain.call(at, of(FUNDING_SIGNATURES.watchedOf)),
  ]);
  const [published, asShares, activeFrom, cap, sold, rounds, fee] = words(t);
  const [watched] = decodeParameters([{ array: "address" }], watchedHex) as [
    string[],
  ];
  const [quantity, taken, leastPrice, expiry] = words(tr);
  return {
    contract: at,
    published: published !== 0n,
    rounds:
      rounds && rounds !== 0n
        ? `0x${rounds.toString(16).padStart(40, "0")}`
        : null,
    watched: watched.map((a) => a.toLowerCase()),
    asShares: asShares !== 0n,
    activeFrom: Number(activeFrom ?? 0n),
    cap: cap ?? 0n,
    sold: sold ?? 0n,
    exitFeeBps: Number(fee ?? 0n),
    tranche:
      quantity && quantity > 0n
        ? {
            quantity,
            taken: taken ?? 0n,
            leastPrice: leastPrice ?? 0n,
            expiry: Number(expiry ?? 0n),
          }
        : null,
    reserved,
  };
}

// ---- words for a vote ------------------------------------------------------------------------------

/** A funding-terms vote in words, or null when the action is not aimed at this DAO's funding-terms contract. */
export function describeFunding(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  if (
    !ctx.fundingTerms ||
    action.to.toLowerCase() !== ctx.fundingTerms.toLowerCase()
  ) {
    return null;
  }
  const data = action.data.toLowerCase();
  const sel = data.slice(0, 10);
  const word = (i: number) =>
    BigInt(`0x${data.slice(10 + i * 64, 74 + i * 64)}`);
  const asDraft = (draft: DecisionDraft): ActionDescription => ({
    kind: "trading",
    title: draft.title,
    lines: draft.lines,
  });
  try {
    if (sel === selectorOf(FUNDING_SIGNATURES.publish)) {
      return asDraft(
        publishFundingDecision({
          terms: action.to,
          asShares: word(0) !== 0n,
          cap: word(1),
          rounds: `0x${word(2).toString(16).padStart(40, "0")}`,
          exitFeeBps: Number(word(3)),
          unitsNow: null,
        }),
      );
    }
    if (sel === selectorOf(FUNDING_SIGNATURES.watch)) {
      const [tokens] = decodeParameters(
        [{ array: "address" }],
        `0x${data.slice(10)}`,
      ) as [string[]];
      return asDraft(watchAssetsDecision({ terms: action.to, tokens }));
    }
    if (sel === selectorOf(FUNDING_SIGNATURES.accept)) {
      const [tokens, yes] = decodeParameters(
        [{ array: "address" }, "bool"],
        `0x${data.slice(10)}`,
      ) as [string[], boolean];
      return asDraft(acceptTokensDecision({ terms: action.to, tokens, yes }));
    }
    if (sel === selectorOf(FUNDING_SIGNATURES.openTranche)) {
      return asDraft(
        openTrancheDecision({
          terms: action.to,
          quantity: word(0),
          leastPrice: word(1),
          expiry: Number(word(2)),
        }),
      );
    }
    if (sel === selectorOf(FUNDING_SIGNATURES.closeTranche)) {
      return asDraft(closeTrancheDecision({ terms: action.to }));
    }
    if (sel === selectorOf(FUNDING_SIGNATURES.lowerExitFee)) {
      return asDraft(
        lowerExitFeeDecision({ terms: action.to, exitFeeBps: Number(word(0)) }),
      );
    }
    if (sel === selectorOf(FUNDING_SIGNATURES.lowerCap)) {
      return asDraft(lowerCapDecision({ terms: action.to, cap: word(0) }));
    }
  } catch {
    return null;
  }
  return null;
}
