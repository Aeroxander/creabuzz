/**
 * Launch parameter rules, taken from the auction contract we deploy.
 *
 * Every constant and check here mirrors
 * `contracts/lib/continuous-clearing-auction`:
 *   - `ConstantsLib`: `MPS = 1e7`, `MIN_FLOOR_PRICE = 2^32 + 1`,
 *     `MIN_TICK_SPACING = 2`, `MAX_TOTAL_SUPPLY = 1 << 100`
 *   - `MaxBidPriceLib.maxBidPrice(totalSupply)` — the ceiling on the floor price
 *     and the tick spacing, and therefore on what any bid can pay
 *   - `TickStorage`: the floor price is the first tick, so it must sit on a tick
 *     boundary (`floorPrice % tickSpacing == 0`)
 *   - `StepStorage._validate`: every step's block delta is non-zero,
 *     `sum(mps * blockDelta) == MPS`, the deltas add up to exactly
 *     `endBlock - startBlock`, and `claimBlock >= endBlock > startBlock`
 *
 * Why duplicate them: a launch is a one-shot deployment. A bad price or schedule
 * is discovered by the constructor reverting, after the founder has written the
 * terms — and the defaults this app shipped could not be deployed at all.
 * Catching it in the form is the difference between "fix the price" and "start
 * over".
 *
 * Alias-free on purpose: `launch-params.test.mjs` drives it under `node --test`.
 */

/** Q96 fixed-point denominator. */
export const Q96 = 1n << 96n;
/** Milli-bips: `MPS` is 100%. */
export const MPS = 10_000_000n;
export const MIN_FLOOR_PRICE = (1n << 32n) + 1n;
export const MIN_TICK_SPACING = 2n;
export const MAX_TOTAL_SUPPLY = 1n << 100n;
const MAX_V4_PRICE = (1n << 160n) - 1n;
const LOWER_TOTAL_SUPPLY_THRESHOLD = 1n << 62n;
/** Base produces a block every 2 seconds. */
export const BLOCKS_PER_DAY = 43_200n;

/** The highest Q96 price a given sold supply supports (`MaxBidPriceLib`). */
export function maxBidPrice(totalSupply: bigint): bigint {
  if (totalSupply <= 0n) return 0n;
  if (totalSupply <= LOWER_TOTAL_SUPPLY_THRESHOLD) return MAX_V4_PRICE;
  const liquidityBound = ((1n << 154n) / totalSupply) ** 2n;
  const raisedBound = (1n << 222n) / totalSupply;
  return liquidityBound < raisedBound ? liquidityBound : raisedBound;
}

/** Q96 price for `whole` currency units per whole token. */
export function q96FromPrice(
  wholePrice: bigint,
  tokenDecimals = 18n,
  currencyDecimals = 6n,
): bigint {
  return (wholePrice * 10n ** currencyDecimals * Q96) / 10n ** tokenDecimals;
}

export interface AuctionStepInput {
  /** Milli-bips sold per block during this step. */
  mps: bigint;
  blockDelta: bigint;
}

export interface LaunchParamInput {
  /** Tokens for sale, in token smallest units (the auction's `TOTAL_SUPPLY`). */
  supply: bigint;
  floorPrice: bigint;
  tickSpacing: bigint;
  requiredCurrencyRaised: bigint;
  /** Monthly operating budget, currency base units; null = not committed. */
  budget?: bigint | null;
  startBlock: bigint;
  endBlock: bigint;
  claimBlock: bigint;
  steps: AuctionStepInput[];
}

export interface LaunchParamIssue {
  field: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * Everything the constructor would reject, plus the few things it accepts but a
 * founder almost never means.
 */
export function validateLaunchParams(
  input: LaunchParamInput,
): LaunchParamIssue[] {
  const issues: LaunchParamIssue[] = [];
  const error = (field: string, message: string) =>
    issues.push({ field, severity: "error" as const, message });
  const warn = (field: string, message: string) =>
    issues.push({ field, severity: "warning" as const, message });

  if (input.supply <= 0n) {
    error("supply", "The sale needs a supply greater than zero.");
  } else if (input.supply > MAX_TOTAL_SUPPLY) {
    error(
      "supply",
      "Supply is above the auction's ceiling (2^100 units), which the clearing price cannot support.",
    );
  }

  if (input.tickSpacing < MIN_TICK_SPACING) {
    error(
      "tickSpacing",
      `Tick spacing must be at least ${MIN_TICK_SPACING}: spacing 1 lets rounding move the price off an initialized tick.`,
    );
  }
  if (input.floorPrice === 0n) {
    error("floorPrice", "The floor price cannot be zero.");
  } else if (input.floorPrice < MIN_FLOOR_PRICE) {
    error(
      "floorPrice",
      "The floor price is too low for the auction to price anything. Raise it.",
    );
  }

  if (input.supply > 0n) {
    const ceiling = maxBidPrice(input.supply);
    if (input.tickSpacing > ceiling) {
      error(
        "tickSpacing",
        "Tick spacing is above the maximum this supply supports; the auction cannot be deployed.",
      );
    } else if (input.floorPrice + input.tickSpacing > ceiling) {
      error(
        "floorPrice",
        "Floor price plus tick spacing is above the maximum this supply supports; the auction cannot be deployed.",
      );
    }
  }

  if (input.tickSpacing > 0n && input.floorPrice % input.tickSpacing !== 0n) {
    error(
      "floorPrice",
      `Floor price must be a multiple of the tick spacing (${input.tickSpacing}); the floor is the first tick.`,
    );
  }

  // MetaDAO's discipline: a monthly budget above 1/6th of the minimum raise
  // means the treasury can be drained faster than the raise can refill it.
  // 1/6th of the min raise is the most a twelve-month runway would cost, so a
  // founder at the cap has a year's runway committed before anything else.
  if (
    input.budget != null &&
    input.budget > 0n &&
    input.requiredCurrencyRaised > 0n
  ) {
    if (input.budget * 6n > input.requiredCurrencyRaised) {
      warn(
        "budget",
        "Monthly budget — above a sixth of the graduation threshold; at the cap the auction refills the treasury every six months.",
      );
    }
  }
  if (input.startBlock >= input.endBlock) {
    error("endBlock", "The auction must end after it starts.");
  }
  if (input.endBlock > input.startBlock && input.claimBlock < input.endBlock) {
    error("claimBlock", "Claims cannot open before the auction ends.");
  }

  if (input.steps.length === 0) {
    error("steps", "An auction needs at least one issuance step.");
  }
  let sumMps = 0n;
  let sumDelta = 0n;
  input.steps.forEach((step, index) => {
    if (step.blockDelta === 0n) {
      error(`steps[${index}]`, "A step cannot last zero blocks.");
    }
    if (step.mps === 0n) {
      error(`steps[${index}]`, "A step must sell something every block.");
    }
    sumMps += step.mps * step.blockDelta;
    sumDelta += step.blockDelta;
  });
  if (input.steps.length > 0 && sumMps !== MPS) {
    error(
      "steps",
      `Issuance must add up to 100%: the steps sum to ${sumMps} of ${MPS} milli-bips.`,
    );
  }
  if (
    input.steps.length > 0 &&
    input.startBlock + sumDelta !== input.endBlock
  ) {
    error(
      "endBlock",
      `The steps span ${sumDelta} blocks, ending at ${input.startBlock + sumDelta} rather than ${input.endBlock}.`,
    );
  }
  const last = input.steps[input.steps.length - 1];
  if (last && last.mps * last.blockDelta < MPS / 100n) {
    warn(
      "steps",
      "The final step sells under 1% of the supply, so almost all of it clears before the auction ends.",
    );
  }

  if (input.requiredCurrencyRaised === 0n) {
    warn(
      "requiredCurrencyRaised",
      "With no graduation threshold the auction graduates however little it raises.",
    );
  } else if (input.supply > 0n) {
    const maxRaised = (input.supply * maxBidPrice(input.supply)) / Q96;
    if (input.requiredCurrencyRaised > maxRaised) {
      error(
        "requiredCurrencyRaised",
        "The threshold is above the most this supply could ever raise, so the auction can never graduate.",
      );
    } else {
      const floorRaised = (input.supply * input.floorPrice) / Q96;
      if (input.requiredCurrencyRaised > floorRaised) {
        warn(
          "requiredCurrencyRaised",
          "The threshold is above what selling the whole supply at the floor price would raise, so it needs bids well above the floor.",
        );
      }
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: LaunchParamIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

/** One line per issue, for a toast or an inline list. */
export function describeIssues(issues: LaunchParamIssue[]): string[] {
  return issues.map((issue) => `${issue.field}: ${issue.message}`);
}

/**
 * A three-step issuance schedule that adds up *exactly*.
 *
 * The contract requires `sum(mps * blockDelta) == MPS` and
 * `sum(blockDelta) == endBlock - startBlock` with integer rates, so a naive
 * "60/30/10 of the window" split does not deploy: rounding leaves a residue and
 * the constructor reverts. The targets are 60/30/10; the final stretch absorbs
 * whatever is left with a short segment one unit above, which keeps both sums
 * exact.
 */
export function buildSchedule(
  startBlock: bigint,
  endBlock: bigint,
): AuctionStepInput[] {
  const span = endBlock - startBlock;
  if (span < 30n) return [];
  const first = span / 3n;
  const second = span / 3n;
  const third = span - first - second;
  const rate = (target: bigint, delta: bigint) => {
    const exact = (target * MPS) / (10n * delta);
    return exact > 0n ? exact : 1n;
  };
  const mps1 = rate(6n, first);
  const mps2 = rate(3n, second);
  const remaining = MPS - mps1 * first - mps2 * second;
  if (remaining <= 0n) return [];

  const steps: AuctionStepInput[] = [
    { mps: mps1, blockDelta: first },
    { mps: mps2, blockDelta: second },
  ];
  const base = remaining / third;
  if (base >= 1n) {
    const shortBlocks = remaining - base * third;
    steps.push({ mps: base, blockDelta: third - shortBlocks });
    if (shortBlocks > 0n) {
      steps.push({ mps: base + 1n, blockDelta: shortBlocks });
    }
  } else {
    // One milli-bip per block covers the last stretch; the leftover blocks go to
    // the middle step, which keeps the total window unchanged.
    steps.push({ mps: 1n, blockDelta: remaining });
    const leftovers = third - remaining;
    if (leftovers > 0n)
      steps[1] = { mps: mps2, blockDelta: second + leftovers };
  }
  return steps.filter((step) => step.blockDelta > 0n);
}

/**
 * A price grid for a given floor, without searching for divisors.
 *
 * One basis point of the floor is the finest sane spacing; the floor is snapped
 * down onto that grid (`snapFloorToGrid`), which satisfies the boundary rule by
 * construction rather than by trial division.
 */
export function tickSpacingFor(floorPrice: bigint): bigint {
  const basisPoint = floorPrice / 10_000n;
  return basisPoint < MIN_TICK_SPACING ? MIN_TICK_SPACING : basisPoint;
}

/** The nearest deployable floor at or below `floorPrice` on the given grid. */
export function snapFloorToGrid(
  floorPrice: bigint,
  tickSpacing: bigint,
): bigint {
  if (tickSpacing <= 0n) return floorPrice;
  let snapped = floorPrice - (floorPrice % tickSpacing);
  if (snapped < MIN_FLOOR_PRICE) {
    const gaps = (MIN_FLOOR_PRICE - snapped + tickSpacing - 1n) / tickSpacing;
    snapped += gaps * tickSpacing;
  }
  return snapped;
}

/**
 * Price of a whole token implied by a Q96 floor, in currency **smallest units**
 * (so 10_000 with USDC's 6 decimals is $0.01 per token). No decimals are
 * assumed beyond the token's own scale.
 */
export function floorPricePerToken(
  floorPriceQ96: bigint,
  tokenDecimals = 18n,
): bigint {
  return (floorPriceQ96 * 10n ** tokenDecimals) / Q96;
}

export interface StandardPresetOptions {
  startBlock: bigint;
  /** Total token supply (all of it), not just the tranche being sold. */
  totalSupply?: bigint;
  /** Whole-currency target valuation, e.g. USD. */
  targetFdv?: bigint;
  /** Share of supply sold, in tenths of a percent (200 = 20%). */
  saleShareTenths?: bigint;
  days?: bigint;
  blocksPerDay?: bigint;
  tokenDecimals?: bigint;
  currencyDecimals?: bigint;
  /** Share of the floor value that must be raised to graduate, in percent. */
  thresholdPercent?: bigint;
}

export interface StandardPreset extends LaunchParamInput {
  /** Tokens not sold here: team, treasury, LP reserve, milestone unlocks. */
  retainedSupply: bigint;
  /** Whole-currency price per whole token implied by the floor. */
  floorPricePerToken: bigint;
  /** Whole-currency value the sale raises if everything clears at the floor. */
  floorRaise: bigint;
}

/**
 * The preset a project starts from.
 *
 * A fifth of supply sold over five days, priced from the valuation the founder
 * is aiming at, graduating only if it raises 15% of the sale's floor value, with
 * half a day between the end of the auction and claims so the graduation rails
 * can seed liquidity first. The plan argues for this shape in
 * `docs/dao-launchpad-plan.md` §7; the numbers are defaults, not rules.
 */
export function standardLaunchPreset(
  options: StandardPresetOptions,
): StandardPreset {
  const totalSupply = options.totalSupply ?? 10n ** 18n * 1_000_000_000n;
  const targetFdv = options.targetFdv ?? 10_000_000n;
  const saleTenths = options.saleShareTenths ?? 200n;
  const days = options.days ?? 5n;
  const blocksPerDay = options.blocksPerDay ?? BLOCKS_PER_DAY;
  const tokenDecimals = options.tokenDecimals ?? 18n;
  const currencyDecimals = options.currencyDecimals ?? 6n;
  const thresholdPercent = options.thresholdPercent ?? 15n;

  const saleTokens = (totalSupply * saleTenths) / 1000n;
  const wholeTokens = totalSupply / 10n ** tokenDecimals;
  // One step, in smallest units: dividing a valuation by a token count truncates
  // to zero for sub-cent prices (10M over 1e9 tokens is a cent).
  const rawFloor =
    (targetFdv * 10n ** currencyDecimals * Q96) /
    (wholeTokens * 10n ** tokenDecimals);
  const floorPrice = snapFloorToGrid(rawFloor, tickSpacingFor(rawFloor));

  const startBlock = options.startBlock;
  const endBlock = startBlock + days * blocksPerDay;
  const claimBlock = endBlock + blocksPerDay / 2n;
  const steps = buildSchedule(startBlock, endBlock);
  const floorRaise = (saleTokens * floorPrice) / Q96;

  return {
    supply: saleTokens,
    floorPrice,
    tickSpacing: tickSpacingFor(floorPrice),
    requiredCurrencyRaised: (floorRaise * thresholdPercent) / 100n,
    startBlock,
    endBlock,
    claimBlock,
    steps,
    retainedSupply: totalSupply - saleTokens,
    floorPricePerToken: floorPricePerToken(floorPrice, tokenDecimals),
    floorRaise,
  };
}
