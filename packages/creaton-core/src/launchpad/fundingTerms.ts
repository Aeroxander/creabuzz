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
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import { decodeAddress, decodeWord, encodeCall0 } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;
const UNIT = 10n ** 18n;
const MAX_U128 = (1n << 128n) - 1n;

/** How long after terms are published, or widened, before anything under them sells. */
export const FUNDING_NOTICE = 30 * DAY;

export const FUNDING_SIGNATURES = {
  publish: "publish(bool,uint128)",
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
const money = (u: bigint) => {
  const int = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${frac ? `${int}.${frac}` : int} USDC`;
};

// ---- the votes -----------------------------------------------------------------------------------

/** Publish funding terms: the instrument and the most that can ever be sold. Nothing sells for 30 days after it runs. */
export function publishFundingDecision(input: {
  terms: string;
  asShares: boolean;
  cap: bigint;
  /** Units that exist now (all Shares and Loot), to say what the cap is as a share of them; null when unknown. */
  unitsNow: bigint | null;
}): DecisionDraft {
  const cap = units128(input.cap, "cap", "The most that can be sold");
  const share =
    input.unitsNow && input.unitsNow > 0n
      ? ` (${((cap * 1000n) / input.unitsNow / 10n).toString()}% of the ${whole(input.unitsNow)} units there are now)`
      : "";
  return {
    to: contract(input.terms),
    data: encodeFunctionData(
      FUNDING_SIGNATURES.publish,
      ["bool", "uint128"],
      [input.asShares, cap],
    ),
    lane: "unrestricted",
    title: `Let the project sell up to ${whole(cap)} new ${input.asShares ? "Shares" : "Loot"}`,
    lines: [
      `At most ${whole(cap)} new units can ever be sold for money for the project${share}. Raising that later needs another vote and another 30 days.`,
      input.asShares
        ? "Buyers get Shares, with a vote."
        : "Buyers get Loot: the same part of the treasury and of payouts as a Share, but no vote.",
      "Nothing is sold until 30 days after this runs, so anyone who disagrees can leave first. Each sale then needs its own vote, with a quantity, a least price and an end date.",
    ],
  };
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
      "Every payment goes to the treasury. Nothing sells below what leaving pays, plus 2%.",
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
    title: `Lower the most the project can sell to ${whole(cap)}`,
    lines: ["This takes effect at once and can only be raised with notice."],
  };
}

// ---- reads -----------------------------------------------------------------------------------------

export interface FundingTermsView {
  /** The funding-terms contract the DAO's summoner uses. */
  contract: string;
  published: boolean;
  asShares: boolean;
  /** When sales under the terms may start (unix seconds); 0 before any terms. */
  activeFrom: number;
  cap: bigint;
  sold: bigint;
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
  const [t, tr, reserved] = await Promise.all([
    chain.call(at, of(FUNDING_SIGNATURES.terms)),
    chain.call(at, of(FUNDING_SIGNATURES.tranches)),
    chain.call(at, of(FUNDING_SIGNATURES.reserved)).then(decodeWord),
  ]);
  const [published, asShares, activeFrom, cap, sold] = words(t);
  const [quantity, taken, leastPrice, expiry] = words(tr);
  return {
    contract: at,
    published: published !== 0n,
    asShares: asShares !== 0n,
    activeFrom: Number(activeFrom ?? 0n),
    cap: cap ?? 0n,
    sold: sold ?? 0n,
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
          unitsNow: null,
        }),
      );
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
    if (sel === selectorOf(FUNDING_SIGNATURES.lowerCap)) {
      return asDraft(lowerCapDecision({ terms: action.to, cap: word(0) }));
    }
  } catch {
    return null;
  }
  return null;
}
