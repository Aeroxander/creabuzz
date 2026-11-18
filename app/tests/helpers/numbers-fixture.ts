/**
 * A project-numbers record (kind 39009) in the shape milestone 5's chain reader signs, for the unit tests and the
 * Playwright specs. Built around anvil's well-known accounts and made-up contract addresses; the founder's chain key and
 * id follow the app's rule (`@creaton/core/launchpad/project-chain.ts`), so the record belongs to the given project.
 */
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";

/** Anvil's second account: the founder's wallet. */
export const FOUNDER_EVM = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
/** Anvil's third account: a backer's wallet. */
export const BACKER_EVM = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
export const CONTRACTS = {
  launcher: "0x0165878a594ca255338adfa4d48449f69242eb8f",
  shares: "0xaf19000000000000000000000000000000007695",
  treasury: "0x20b6000000000000000000000000000000000906",
  vester: "0x2787000000000000000000000000000000ccb78b",
  finisher: "0x0593000000000000000000000000000000ccab17",
  rounds: "0x39920000000000000000000000000000000c9ba0",
  quote: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
};

export function chainIdentity(coordinate: string, founderEvm = FOUNDER_EVM) {
  const projectId = projectIdOf(coordinate);
  return { projectId, key: chainKeyOf(founderEvm, projectId) };
}

export interface NumbersOptions {
  coordinate: string;
  /** Unix seconds the record is "as of". */
  now: number;
  /** A round open now (opened `openedAgo` seconds ago), or none. */
  openRound?: { openedAgo: number; asked?: string; backers?: number } | null;
  /** The backer's receipt in round 1 and what they can take back now. */
  backed?: boolean;
  stage?: "solo" | "backed" | "team";
  runner?: string;
}

/** The record's content (JSON-ready). */
export function numbersContent(o: NumbersOptions): Record<string, unknown> {
  const { projectId, key } = chainIdentity(o.coordinate);
  const day = 86_400;
  const launchedAt = o.now - 45 * day;
  const backed = o.backed ?? true;
  const rounds: Record<string, unknown>[] = [];
  if (backed)
    rounds.push({
      round: 1,
      size: "10000000000",
      cap: "10000000000",
      raisedBefore: "0",
      sharesPerRawDollar: "3000000000000000",
      projectPrice: "333333.33",
      opensAt: launchedAt,
      closesAt: launchedAt + day,
      backers: 2,
      asked: "2500000000",
      closed: true,
      closedAt: launchedAt + day,
      accepted: "2500000000",
      acceptedPercent: null,
      activeAtClose: day,
      settled: 2,
      released: "0",
    });
  if (o.openRound) {
    const opensAt = o.now - o.openRound.openedAgo;
    rounds.push({
      round: rounds.length + 1,
      size: backed ? "7500000000" : "10000000000",
      cap: "10000000000",
      raisedBefore: backed ? "2500000000" : "0",
      sharesPerRawDollar: "3000000000000000",
      projectPrice: "333333.33",
      opensAt,
      closesAt: opensAt + day,
      backers: o.openRound.backers ?? 0,
      asked: o.openRound.asked ?? "0",
      closed: false,
      closedAt: null,
      accepted: null,
      acceptedPercent: null,
    });
  }
  const total = backed ? "2500000000" : "0";
  return {
    version: 1,
    chainId: 31337,
    launcher: CONTRACTS.launcher,
    key,
    projectId,
    founder: FOUNDER_EVM,
    launchedAt,
    projectZero: false,
    contracts: {
      shares: CONTRACTS.shares,
      treasury: CONTRACTS.treasury,
      vester: CONTRACTS.vester,
      finisher: CONTRACTS.finisher,
      rounds: CONTRACTS.rounds,
      pair: null,
    },
    stage: {
      name: o.stage ?? (backed ? "backed" : "solo"),
      since: backed ? launchedAt + day : launchedAt,
      openAt: null,
    },
    eligible: { for: backed ? "team" : "backed", since: launchedAt + day },
    raised: {
      total,
      cap: "10000000000",
      left: (10_000_000_000n - BigInt(total)).toString(),
    },
    averagePrice: backed
      ? { sharesPerRawDollar: "3000000000000000", projectPrice: "333333.33" }
      : null,
    rounds,
    clock: {
      lastCheckIn: o.now - 3 * day,
      runsUntil: o.now + 11 * day,
      paused: false,
      woundDown: false,
    },
    receipts: backed
      ? [
          {
            round: 1,
            backer: BACKER_EVM,
            accepted: "100000000",
            returned: "0",
            shares: "300000000000000000000000",
            heldMoney: "82000000",
            sharesHeld: "300000000000000000000000",
            refunded: null,
          },
        ]
      : [],
    receiptCount: backed ? 1 : 0,
    holders: [
      {
        account: FOUNDER_EVM,
        held: "200000000000000000000000000",
        free: "0",
      },
      ...(backed
        ? [
            {
              account: BACKER_EVM,
              held: "300000000000000000000000",
              free: "0",
            },
          ]
        : []),
    ],
    holderCount: backed ? 2 : 1,
    truncated: false,
    treasury: {
      toppedUp: backed ? "375000000" : "0",
      handedBackCount: 0,
      runner: o.runner ?? FOUNDER_EVM,
    },
    sale: null,
    reserveSales: [],
    asOf: { block: 26, time: o.now },
    now: {
      stage: o.stage ?? (backed ? "backed" : "solo"),
      activeSeconds: 45 * day,
      quietSince: null,
      refunds: backed
        ? [
            {
              round: 1,
              backer: BACKER_EVM,
              refundable: "58639010",
              per100: "58.64",
            },
          ]
        : [],
    },
  };
}
