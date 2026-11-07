/**
 * Starting a contributor project on the weekly-sale kit (`ContributorKitV2`): the same project as the plain kit makes
 * (a DAO, its first work budget and work areas, its Shares locked), plus the weekly market for its Shares and the
 * founder's sale schedule. This file is what is different about that launch: the extra fields and their checks, the
 * one call that carries them, the prediction that includes the market, and the checks on the node's side before
 * anything is sent. Everything the plain launch does stays in `contributor-project.ts` and `contributor-flow.ts`.
 *
 * Which launch a kit takes is read from the kit itself, not guessed from the build's settings. The weekly-sale kit
 * inherits the plain kit's `launch(Params)`, and calling that on it makes a project with no market that can never get
 * one, so choosing the wrong call is not a harmless mistake. The weekly-sale kit has a `marketFactory()` getter that the
 * plain kit lacks (the call reverts there), which is the one thing that tells them apart. The build's trial switch and
 * market factory are then only checked against what the kit says, so a build that does not fit its kit refuses to
 * start rather than sending the wrong call.
 *
 * Alias-free: `weekly-sale.test.mjs` drives it under `node --test`.
 */

import {
  type AbiType,
  encodeFunctionData,
} from "@creaton/core/launchpad/evmAbi.ts";

import {
  type ChainEnv,
  secondaryMarketFactory,
  testQuoteToken,
  viteEnv,
} from "../../launchpad/chain-config.ts";
import { ActingStepError } from "../../launchpad/lib/acting-account.ts";
import { tradingOffered } from "../../launchpad/lib/trading-offered.ts";
import {
  type ContributorDraft,
  KIT_PARAMS,
  KIT_PARAMS_SIGNATURE,
  type KitLaunch,
  kitParamsValue,
  wordAddress,
} from "./contributor-project.ts";

/** What the weekly-sale fields start with: lots of 100 Shares, no wait, the founder's Shares unlocking over 180 days. */
export const SALE_DEFAULTS = {
  lot: "100",
  cliffDays: "0",
  days: "180",
} as const;

const SHARE_UNIT = 10n ** 18n;
const MAX_LOT = (1n << 128n) - 1n;
/** Ten years: a schedule longer than that is a typing slip. */
const MAX_DAYS = 3_650n;
const DAY = 86_400n;
/** One transaction may use at most this much work on the networks this app runs on (EIP-7825, 2^24). */
export const LAUNCH_GAS_CAP = 16_777_216n;
/** How long the node may take to say what the launch costs before the page stops waiting. */
const ESTIMATE_TIMEOUT_MS = 25_000;

export type SaleField = "saleLot" | "saleCliffDays" | "saleDays";

export interface WeeklySaleTerms {
  /** Shares per lot, in base units. */
  lotSize: bigint;
  cliffSeconds: bigint;
  durationSeconds: bigint;
}

/** `ContributorKitV2.launch(LaunchParams)`: the plain kit's terms, then sale start, cliff, duration, price token, lot. */
export const KIT_LAUNCH_V2_SIGNATURE = `launch((${KIT_PARAMS_SIGNATURE},uint64,uint64,uint64,address,uint256))`;

const LAUNCH_V2_PARAMS: AbiType = {
  tuple: [KIT_PARAMS, "uint64", "uint64", "uint64", "address", "uint256"],
};

const PREDICT_LAUNCH_SIGNATURE =
  "predictLaunch(address,uint256,bytes32,address,uint256)";

export const CALL_MARKET_FACTORY = encodeFunctionData(
  "marketFactory()",
  [],
  [],
);

function typed(value: string | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  return text === "" ? fallback : text;
}

/** A decimal number of Shares ("100", "0.01", "1,000") in base units, or null when it is not one. */
function sharesToUnits(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.replace(/[,_\s]/g, ""));
  if (!match) return null;
  return (
    BigInt(match[1]) * SHARE_UNIT + BigInt((match[2] ?? "").padEnd(18, "0"))
  );
}

function wholeDays(text: string): bigint | null {
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

/**
 * The first problem with the weekly-sale fields, or null. `founderWhole` (the founder's starting Shares) is known once
 * that field makes sense: a lot larger than it could never be offered.
 */
export function weeklySaleIssue(
  draft: Pick<ContributorDraft, SaleField>,
  founderWhole?: bigint,
): { field: SaleField; message: string } | null {
  const lot = sharesToUnits(typed(draft.saleLot, SALE_DEFAULTS.lot));
  if (lot === null || lot === 0n || lot > MAX_LOT)
    return {
      field: "saleLot",
      message:
        "Give the Shares in one lot as a number above 0, with at most 18 decimals, like 100 or 0.5.",
    };
  if (founderWhole !== undefined && lot > founderWhole * SHARE_UNIT)
    return {
      field: "saleLot",
      message:
        "One lot cannot hold more than your starting Shares: you could never offer one.",
    };
  const cliff = wholeDays(typed(draft.saleCliffDays, SALE_DEFAULTS.cliffDays));
  if (cliff === null || cliff > MAX_DAYS)
    return {
      field: "saleCliffDays",
      message:
        "Give the days before your first sale as a whole number, 0 or more.",
    };
  const days = wholeDays(typed(draft.saleDays, SALE_DEFAULTS.days));
  if (days === null || days === 0n || days > MAX_DAYS)
    return {
      field: "saleDays",
      message:
        "Give the days over which your Shares unlock as a whole number from 1 to 3650.",
    };
  if (cliff > days)
    return {
      field: "saleCliffDays",
      message:
        "The days before your first sale can be at most the days over which your Shares unlock.",
    };
  return null;
}

/** The weekly-sale fields, checked and in the units the call carries. Throws the first problem's words. */
export function weeklySaleTerms(
  draft: Pick<ContributorDraft, SaleField>,
  founderWhole?: bigint,
): WeeklySaleTerms {
  const issue = weeklySaleIssue(draft, founderWhole);
  if (issue) throw new Error(issue.message);
  return {
    lotSize: sharesToUnits(typed(draft.saleLot, SALE_DEFAULTS.lot)) as bigint,
    cliffSeconds:
      (wholeDays(
        typed(draft.saleCliffDays, SALE_DEFAULTS.cliffDays),
      ) as bigint) * DAY,
    durationSeconds:
      (wholeDays(typed(draft.saleDays, SALE_DEFAULTS.days)) as bigint) * DAY,
  };
}

export interface KitLaunchV2 extends KitLaunch {
  /** What buyers pay in: the market's price token. */
  quote: string;
  sale: WeeklySaleTerms;
}

/**
 * The one transaction that makes the project with its weekly market. The sale starts at the project's birth (the kit
 * reads a start of 0 as "now" once, for the schedule and the read-back both), so the founder's Shares begin to unlock
 * from the day the project exists.
 */
export function encodeKitLaunchV2(launch: KitLaunchV2): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(launch.quote))
    throw new Error("invalid price token address");
  return encodeFunctionData(
    KIT_LAUNCH_V2_SIGNATURE,
    [LAUNCH_V2_PARAMS],
    [
      [
        kitParamsValue(launch),
        0n,
        launch.sale.cliffSeconds,
        launch.sale.durationSeconds,
        launch.quote,
        launch.sale.lotSize,
      ],
    ],
  );
}

/** `predictLaunch(...)`: the DAO's address is its first answer, the same address `predictDao` gives. */
export function encodePredictLaunch(
  founder: string,
  founderWhole: bigint,
  salt: string,
  quote: string,
  lotSize: bigint,
): string {
  return encodeFunctionData(
    PREDICT_LAUNCH_SIGNATURE,
    ["address", "uint256", "bytes32", "address", "uint256"],
    [founder, founderWhole * SHARE_UNIT, salt, quote, lotSize],
  );
}

// ---- which launch a kit takes ---------------------------------------------------------------------

/** What starting a project on this network's kit needs, or why it cannot. */
export interface KitSale {
  /** Set for the weekly-sale kit when this build fits it; null for the plain kit, and for a kit that cannot be used. */
  weekly: { marketFactory: string; quote: string } | null;
  /** Why a weekly-sale kit cannot be used from this build, in words for the founder; null when there is none. */
  problem: string | null;
}

const TRADING_OFF_PROBLEM =
  "Starting a project here needs trading switched on for this site, and it is not. Tell whoever runs this site.";
const FACTORY_DISAGREES_PROBLEM =
  "This site and the network do not agree on where trading lives, so a project started now could not be traded. Tell whoever runs this site.";
const NO_TOKEN_PROBLEM =
  "This site has no trade token set for this network, so a project cannot be started with trading yet. Tell whoever runs this site.";

/**
 * Whether `kit` is the weekly-sale kit (it names a market factory) or the plain one (the call reverts or answers
 * nothing). A node that did not answer is neither: the error stands, so a founder is never sent down the wrong launch.
 */
export async function readKitSale(
  call: (to: string, data: string) => Promise<string>,
  kit: string,
  chainId: string | number,
  env: ChainEnv | undefined = viteEnv(),
): Promise<KitSale> {
  let answer: string;
  try {
    answer = await call(kit, CALL_MARKET_FACTORY);
  } catch (error) {
    if (error instanceof Error && /revert/i.test(error.message))
      return { weekly: null, problem: null };
    throw error;
  }
  if (answer === "0x" || answer === "") return { weekly: null, problem: null };
  const marketFactory = wordAddress(answer);
  if (/^0x0{40}$/.test(marketFactory))
    throw new Error(
      "The network's project maker did not name a market, so projects cannot be started here yet.",
    );
  if (!tradingOffered(env))
    return { weekly: null, problem: TRADING_OFF_PROBLEM };
  if (marketFactory !== secondaryMarketFactory(chainId, env))
    return { weekly: null, problem: FACTORY_DISAGREES_PROBLEM };
  const quote = testQuoteToken(chainId, env);
  if (quote === null) return { weekly: null, problem: NO_TOKEN_PROBLEM };
  return { weekly: { marketFactory, quote }, problem: null };
}

// ---- the node's say before anything is sent -------------------------------------------------------

const TOO_BIG_MESSAGE =
  "Starting this project needs more than the network allows in one step, so nothing was sent. Tell whoever runs this site.";
const WOULD_REFUSE_MESSAGE =
  "The network would refuse this project as it is set up, so nothing was sent. If you started another project a moment ago, wait a minute and press Try again; otherwise tell whoever runs this site.";
const NO_ESTIMATE_MESSAGE =
  "The network did not say what this step would cost, so nothing was sent. Wait a minute, then press Try again.";

/**
 * Asks the node what the launch needs, live, and lets it through only when that fits what one step may use. The weekly
 * launch is a large one (about 10.8 million, against a limit of 16.8 million), so it is asked about rather than assumed.
 * A node that refuses the launch, answers with too much, or does not answer within `timeoutMs` ends in plain words and
 * nothing is sent; the node's own text is kept for "Technical details". Never waits without end.
 */
export async function assertLaunchFits(
  estimate: () => Promise<bigint>,
  timeoutMs = ESTIMATE_TIMEOUT_MS,
): Promise<bigint> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needed: bigint;
  try {
    needed = await Promise.race([
      estimate(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The node did not answer in time.")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // A node that turns a launch down for its size says "exceeds allowance" or "gas limit too high" rather than
    // "revert": that is permanent, so it gets the too-big words, not "try again". A real revert stays a refusal.
    const reply = /revert/i.test(text)
      ? WOULD_REFUSE_MESSAGE
      : /exceeds|allowance|gas limit|\bcap\b/i.test(text)
        ? TOO_BIG_MESSAGE
        : /invalid|not applied|setup/i.test(text)
          ? WOULD_REFUSE_MESSAGE
          : NO_ESTIMATE_MESSAGE;
    throw new ActingStepError(reply, text);
  } finally {
    clearTimeout(timer);
  }
  if (needed > LAUNCH_GAS_CAP)
    throw new ActingStepError(
      TOO_BIG_MESSAGE,
      `estimated ${needed}, most for one step ${LAUNCH_GAS_CAP}`,
    );
  return needed;
}
