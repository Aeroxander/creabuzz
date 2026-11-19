/** The shapes of a version 2 record once it is read (`numbers.ts` parses it, `numbers-read.ts` reads it strictly). */

/** Where a project is, in the words of the record: checked in, quiet, dormant, open to wind down, wound down. */
export type QuietState =
  | "active"
  | "quiet"
  | "dormant"
  | "may_wind_down"
  | "wound_down";
export interface GrantNumbers {
  id: number;
  member: string;
  /** A protected grant vests on calendar time, has no cliff and cannot be given up. */
  kind: "normal" | "protected";
  state: "live" | "announced" | "closed";
  granted: bigint;
  keeps: bigint;
  claimed: bigint;
  vested: bigint;
  claimable: bigint;
  startActive: number;
  /** Live, normal grants only. `endsAtIfActive` is not a promise: vesting runs on active time. */
  cliff: { passed: boolean; endsAtIfActive: number | null } | null;
  fullyVestedAtIfActive: number | null;
  /** Set only while the grant is announced: the part that burns, and when anyone may run the burn. */
  forfeit: { amount: bigint; burnAt: number; byMember: boolean } | null;
}

export interface AgentNumbers {
  agent: string;
  live: boolean;
  usdCap: bigint;
  teamCap: bigint;
  usdUsed: bigint;
  teamUsed: bigint;
}

export interface HolderNumbers {
  account: string;
  shares: bigint;
  teamShares: bigint;
}

export interface ProjectNumbers {
  removed: false;
  version: 2;
  key: string;
  projectId: string;
  founder: string;
  chainId: number;
  launcher: string;
  launchedAt: number;
  /** True when the dollar is play money. A record that does not say, or says something else, counts as true. */
  playMoney: boolean;
  contracts: {
    treasury: string;
    shares: string;
    team: string;
    vester: string;
    dollar: string;
    /** The Pair, once a second person took the seat. */
    pair: string | null;
  };
  /** The time unit in seconds (7 days on a real network); a "day" in every rate is a seventh of it. */
  unit: number;
  /** The platform's fee on money going in, in ten-thousandths. */
  feeBps: number;
  asOf: { block: number; time: number };
  /** When the server signed the record: the age of the server's work. */
  builtAt: number;
  /** How often the server promises a fresh record, in seconds. */
  refreshEverySecs: number;
  money: {
    pot: bigint;
    paidIn: bigint;
    arriving: bigint;
    arrivalEnd: number | null;
    feesOwed: bigint;
    locked: bigint;
    notesOwed: bigint;
    held: bigint;
  };
  shares: { backers: bigint; teamCounted: bigint; announcedBurn: bigint };
  /** What one whole Share would pay now, in dollar units: for lists. A person's own figure is a quote from the chain. */
  value: { leaveValue: bigint; teamValue: bigint };
  allowance: {
    ratePpm: number;
    pending: {
      ratePpm: number;
      proposedAt: number;
      applicableAt: number;
    } | null;
    box: bigint;
    boxCap: bigint;
    drawnLastDay: bigint;
  };
  clock: {
    lastCheckIn: number;
    lastRecordHash: string | null;
    activeUntil: number | null;
    activeSeconds: number;
  };
  door: { switchOn: boolean; openNow: boolean; shutsAt: number | null };
  quiet: {
    state: QuietState;
    since: number;
    quietFrom: number | null;
    dormantFrom: number | null;
    windableFrom: number | null;
    next: { state: QuietState; at: number } | null;
  };
  windDown: { kind: 1 | 2; at: number } | null;
  runner: {
    address: string;
    isPair: boolean;
    signers: [string, string] | null;
  };
  team: {
    pool: bigint;
    inHands: bigint;
    inVester: bigint;
    promised: bigint;
    ungranted: bigint;
    grantCount: number;
    grants: GrantNumbers[];
  };
  agents: AgentNumbers[];
  limits: {
    minJoin: bigint;
    minOutsidePayment: bigint;
    maxRatePpm: number;
    checkInWindowUnits: number;
    windDownUnits: number;
    cliffUnits: number;
    vestUnits: number;
    minGrant: bigint;
    maxGrantsPerMember: number;
    agentUsdPerDay: bigint;
    agentTeamPerDay: bigint;
  };
  totals: {
    joined: bigint;
    fees: bigint;
    tookOut: bigint;
    drawn: bigint;
    outside: bigint;
  };
  /** When the project's first Back landed, or null before. */
  firstBackedAt: number | null;
  holders: HolderNumbers[];
  holderCount: number;
  teamHolderCount: number;
  /** A list was cut at its cap: "none" is never said about a cut list. */
  truncated: boolean;
}

/** A launch that later left the chain: nothing about money is shown for it. */
export interface RemovedNumbers {
  removed: true;
  key: string;
}

export interface NumbersEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}
