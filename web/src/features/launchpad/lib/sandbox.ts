/**
 * Sandbox launch — a deterministic, simulated full raise.
 *
 * The launchpad has no real content yet (no deployed launch has ever been
 * walked); this module makes the flow *visible*: a virtual launch whose terms,
 * auction progress and graduation are computed from the current time, so the
 * directory and detail page render a living raise without a chain or a relay.
 *
 * Honesty contracts:
 * - Every figure is derived from this module, deterministically, and surfaced
 *   as `Simulated` (never as live chain data, never as "No chain data" either —
 *   it is a sandbox, not a failed read).
 * - The record is not published anywhere and cannot be bid on for real.
 */

import type { LaunchRecord, LaunchStage } from "../models";
import type { AuctionProgress } from "../chain";

export const SANDBOX_ID = "nebula-sandbox";

function hashSeed(input: string): bigint {
  let hash = 14695981039346656037n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 1099511628211n) & mask;
  }
  return hash;
}

/** The sandbox launch record — deployable terms, no live chain links. */
export function sandboxRecord(now = Date.now()): LaunchRecord {
  return {
    id: SANDBOX_ID,
    eventId: `sandbox-${SANDBOX_ID}`,
    author: "ab".repeat(32),
    createdAt: Math.floor(now / 1000),
    name: "Nebula Sandbox",
    pitch:
      "A simulated raise so the launchpad can be walked end to end. Terms are deployable; no chain is touched.",
    longPitch:
      "The sandbox exists to be played with: create, bid, watch price discovery, graduate. Nothing here is real money.",
    ipList: ["https://example.com/sandbox"],
    updateCadence: "weekly with KPIs",
    stage: fundingStage(now),
    currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    floorPrice: "792281625140000",
    tickSpacing: "79228162514",
    requiredRaised: "299999999998",
    budget: "40000000000",
    startBlock: null,
    endBlock: null,
    claimBlock: null,
    paramsHash: "0x" + "ca".repeat(32),
    website: null,
    docs: ["https://example.com/docs"],
    channels: ["sandbox-discussion"],
    projects: [],
    agent: null,
    team: [
      { pubkey: "ab".repeat(32), role: "founder" },
      { pubkey: "cd".repeat(32), role: "engineer" },
    ],
    chainId: "11155111",
    auction: null,
    token: null,
    treasury: null,
    admission: "curated",
    allocation: {
      sale: 20,
      team: 20,
      treasury: 30,
      liquidity: 15,
      milestones: 10,
      community: 5,
    },
    vesting: {
      cliffBlocks: 3110400,
      tranches: [
        { multiple: 2, percent: 20 },
        { multiple: 4, percent: 20 },
        { multiple: 8, percent: 20 },
        { multiple: 16, percent: 20 },
        { multiple: 32, percent: 20 },
      ],
      twapWindow: null,
    },
    tokenPlan: {
      mode: "mint",
      name: "Nebula Sandbox",
      symbol: "SANDBOX",
      supply: "200000000",
    },
  };
}

/** The sandbox timeline: a 7-day virtual raise, time-compressed to ~2 minutes. */
const RAISE_MS = 120_000; // 2 minutes; the virtual auction is a week
const GRADUATE_AT = RAISE_MS * 0.8;

function fundingStage(now: number): LaunchStage {
  const elapsed =
    (now - Date.parse("2026-09-14T00:00:00Z")) % (RAISE_MS + 60_000);
  if (elapsed < RAISE_MS * 0.15) return "review";
  if (elapsed >= RAISE_MS) return "graduated";
  return "funding";
}

export type SandboxProgress = AuctionProgress & {
  /** Percent of goal, 0-100+. */
  percent: number;
  /** Simulated clearing price (Q96) at this instant. */
  clearingPrice: bigint;
  source: "simulated";
};

/** Deterministic progress through the virtual auction from `now`. */
export function sandboxProgress(now = Date.now()): SandboxProgress {
  const start = Date.parse("2026-09-14T00:00:00Z");
  const elapsed = Math.max(0, (now - start) % (RAISE_MS + 60_000));
  const goal = 299_999_999_998n;
  const floor = 792_281_625_140_000n;
  const seed = hashSeed("sandbox");
  // Raised follows a saturating curve: ~18% by 15%, ~78% by 80%, 100%+ by the end.
  const t = elapsed / RAISE_MS;
  let percent = 0.18 + 0.6 * Math.min(1, t * 1.25);
  percent += Number(seed % 12n) / 100;
  percent = Math.min(1.06, percent);
  const raised = (goal * BigInt(Math.round(percent * 100))) / 100n;
  // Clearing price climbs as demand fills.
  const priceFactor = 1n + BigInt(Math.round(percent * 40)) * 10_000_000_000n;
  const graduated = elapsed >= GRADUATE_AT;
  return {
    raised,
    goal,
    percent: Math.round(percent * 100),
    graduated,
    ended: graduated,
    clearingPrice: floor + priceFactor,
    bidCount: 12 + Math.floor(percent * 90),
    source: "simulated",
  };
}
