import type { NostrEvent } from "@/shared/lib/nostr-client";
// Relative so this module can be exercised by `node --test` (see
// models.test.mjs); the kind numbers are plain constants with no imports.
// Extension included on purpose: this module is driven by `models.test.mjs`
// under `node --test`, which does not resolve extensionless specifiers.
import { parseAllocation, type SupplyAllocation } from "./lib/allocation.ts";
import { parseWikiTag } from "./lib/draft-proposal.ts";
import { parseUnlockPlan, type UnlockPlan } from "./lib/unlock-plans.ts";
import {
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  KIND_SCORE_ROOT,
} from "../../shared/constants/kinds.ts";

export type LaunchStage =
  | "draft"
  | "review"
  | "live"
  | "funding"
  | "graduated"
  | "failed";

const STAGES: readonly string[] = [
  "draft",
  "review",
  "live",
  "funding",
  "graduated",
  "failed",
];

export function isLaunchStage(value: unknown): value is LaunchStage {
  return typeof value === "string" && STAGES.includes(value);
}

/** Strict `["hook", <0x-address>, <bucket>]` parse (NIP-LP chain addresses). */
export function parseHookTags(
  tags: string[][],
): { address: string; bucket: string }[] {
  const out: { address: string; bucket: string }[] = [];
  for (const tag of tags) {
    if (tag[0] !== "hook" || tag.length < 3) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(tag[1]) || tag[2].length === 0) continue;
    out.push({ address: tag[1], bucket: tag[2] });
  }
  return out;
}

export interface LaunchRecord {
  id: string;
  eventId: string;
  author: string;
  createdAt: number;
  name: string;
  pitch: string;
  /** The fuller story investors weigh: what exists, why now, what failure looks like. */
  longPitch: string | null;
  /** Key assets the team commits to the project (IP list: URLs / NIP-MP coords). */
  ipList: string[];
  /** Committed update cadence for investors ("monthly" etc.). */
  updateCadence: string | null;
  stage: LaunchStage;
  currency: string | null;
  floorPrice: string | null;
  /** Price granularity, in Q96. Published as a tag; must round-trip. */
  tickSpacing: string | null;
  requiredRaised: string | null;
  /** Monthly operating budget, currency base units. Investors price this. */
  budget: string | null;
  startBlock: number | null;
  endBlock: number | null;
  claimBlock: number | null;
  paramsHash: string | null;
  website: string | null;
  docs: string[];
  channels: string[];
  projects: string[];
  team: Array<{ pubkey: string; role: string }>;
  /**
   * Agent pubkey when the launch is agent-authored (`agent` tag, NIP-OA
   * provenance optional). Agents are first-class participants; the badge is
   * how an investor sees one.
   */
  agent: string | null;
  chainId: string | null;
  auction: string | null;
  token: string | null;
  treasury: string | null;
  /**
   * TrustGatedHook wiring (NIP-LP `["hook", <address>, <bucket>]`, one per
   * gated bucket): the EVM bid gate whose score root the TrustGraph view
   * shows. Strict parse — malformed entries drop, never guessed.
   */
  hooks: { address: string; bucket: string }[];
  /**
   * Tranche/royalty enforcer wiring (token-lifecycle-design.md): the launch's
   * RoyaltyDistributor and ClaimStake, set once deployed. Absent on older
   * records and pre-deploy launches — the mirror-only flow applies then.
   */
  distributor: string | null;
  claimStake: string | null;
  /** The launch's VerifierSet (the attest target for verdicts). */
  verifierSet: string | null;
  admission: "curated" | "community";
  /** How the supply is split. Absent on older records: the standard split. */
  allocation: SupplyAllocation;
  /**
   * Performance-package vesting: tranches unlock at price multiples of the
   * raise price (MetaDAO's 2x..32x ladder). Record only; the onchain enforcer
   * is deferred (plan §7.4 — verifier milestones primary, TWAP backstop).
   */
  vesting: VestingConfig | null;
  /**
   * What the project's own allocation releases against: milestone rows
   * (tracked by the kind:47005 claim/verdict id), a short dated vesting
   * window, or an explicit "nothing locks". See `lib/unlock-plans.ts` — the
   * parse refuses a malformed plan rather than showing a guessed one.
   */
  unlocks: UnlockPlan | null;
  /**
   * Whether a DAO is to be formed at graduation. Null when the record never
   * said (anything published before the wizard, or the legacy edit form).
   */
  daoAtGraduation: boolean | null;
  /**
   * Legal wrapper decision (OAv2 §4.8): "none" (explicitly fine), "dao-llc",
   * or "own-entity". Null when never stated — NOT the same as "none".
   */
  legalWrapper: string | null;
  tokenPlan: {
    mode: "mint";
    name: string;
    symbol: string;
    supply: string;
  } | null;
}

export interface LaunchBid {
  id: string;
  launchId: string;
  /** Author-qualified identity (`<pubkey>:<slug>`): two founders may share a slug. */
  launchKey: string;
  author: string;
  createdAt: number;
  bucket: string;
  budget: string | null;
  maxPrice: string | null;
  tx: string | null;
}

export interface LaunchUpdate {
  id: string;
  launchId: string;
  /** Author-qualified identity (`<pubkey>:<slug>`): two founders may share a slug. */
  launchKey: string;
  author: string;
  createdAt: number;
  title: string;
  body: string;
  links: string[];
}

export type ProposalKind = "plain" | "futarchy-budget" | "signal";

/**
 * The execution intent for majeur's `executeByVotes` (op/to/value/data/nonce)
 * — what the panel's Execute path needs (desktop parity; `lib/vote-tx.ts`'s
 * shape).
 */
import type { ProposalIntent } from "./lib/vote-tx.ts";

export type { ProposalIntent };

/**
 * A proposal's execution call in ERC-4824 `CallDataEVM` shape — majeur
 * proposals ARE call batches (`op` 0 = call, 1 = delegatecall). This is what
 * `executeByVotes` needs and what the `dao.json` projection renders
 * (`buzz-core::erc4824`).
 */
export interface ProposalCall {
  operation: "call" | "delegatecall";
  from: string;
  to: string;
  value: string;
  data: string;
}

export interface LaunchProposal {
  id: string;
  launchId: string;
  /** Author-qualified identity (`<pubkey>:<slug>`): two founders may share a slug. */
  launchKey: string;
  author: string;
  createdAt: number;
  proposalId: string | null;
  kind: ProposalKind;
  issue: string | null;
  state: "open" | "passed" | "executed" | "defeated" | "agent-draft";
  title: string;
  /**
   * The agent-draft's verbatim justification (persona-drafting-loop D3/D8):
   * a quote from the wiki block the draft was composed from — absent on
   * records without one, never paraphrased here.
   */
  evidence?: string;
  /**
   * The draft's source wiki block (`["wiki", page, anchor]`, D7/D8): the
   * dedupe key and provenance pointer. Strict parse — malformed = absent.
   */
  source?: { page: string; anchor: number };
  /**
   * Execution calls (ERC-4824 `CallDataEVM`), absent on records that predate
   * the field. Strict parse: any malformed entry drops the whole field rather
   * than being guessed at — a proposal with unparseable calls must not render
   * as though it had none it could execute.
   */
  calls?: ProposalCall[];
  /**
   * The exact `executeByVotes` intent (`content.intent`), strictly parsed —
   * absent or malformed means execution stays record-only (D8).
   */
  intent?: ProposalIntent;
}

export interface LaunchReceipt {
  id: string;
  launchId: string;
  /** Author-qualified identity (`<pubkey>:<slug>`): two founders may share a slug. */
  launchKey: string;
  author: string;
  createdAt: number;
  table: string;
  tx: string;
  payload: Record<string, unknown>;
}

export interface Launch {
  record: LaunchRecord;
  bids: LaunchBid[];
  updates: LaunchUpdate[];
  proposals: LaunchProposal[];
  receipts: LaunchReceipt[];
}

export function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 ? tag[1] : null;
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter((t) => t[0] === name && t.length >= 2)
    .map((t) => t[1]);
}

export function launchCoordinate(author: string, launchId: string): string {
  return `${KIND_LAUNCH_RECORD}:${author}:${launchId}`;
}

function contentObject(event: NostrEvent): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(event.content);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Malformed mirrors are dropped by the caller.
  }
  return {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function strs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function parseLaunchRecord(event: NostrEvent): LaunchRecord | null {
  if (event.kind !== KIND_LAUNCH_RECORD) return null;
  const id = tagValue(event, "d");
  const name = tagValue(event, "name");
  if (!id || !name) return null;
  const body = contentObject(event);
  return {
    id,
    eventId: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    name,
    pitch: typeof body.pitch === "string" ? body.pitch : "",
    longPitch: str(body.longPitch),
    ipList: strs(body.ipList),
    updateCadence: str(body.updateCadence),
    stage: isLaunchStage(body.stage) ? body.stage : "draft",
    currency: str(body.currency),
    floorPrice: str(body.floorPrice),
    tickSpacing: str(body.tickSpacing),
    requiredRaised: str(body.requiredRaised),
    budget: str(body.budget),
    startBlock: int(body.startBlock),
    endBlock: int(body.endBlock),
    claimBlock: int(body.claimBlock),
    paramsHash: str(body.paramsHash),
    website: str(body.website),
    docs: strs(body.docs),
    channels: tagValues(event, "buzz-channel"),
    projects: tagValues(event, "a"),
    agent: tagValue(event, "agent"),
    team: event.tags
      .filter((t) => t[0] === "team" && t.length >= 3)
      .map((t) => ({ pubkey: t[1], role: t[2] })),
    chainId: tagValue(event, "chain"),
    auction: tagValue(event, "auction"),
    token: tagValue(event, "token"),
    treasury: tagValue(event, "treasury"),
    hooks: parseHookTags(event.tags),
    distributor: tagValue(event, "distributor"),
    claimStake: tagValue(event, "claim-stake"),
    verifierSet: tagValue(event, "verifier-set"),
    admission:
      tagValue(event, "admission") === "community" ? "community" : "curated",
    allocation: parseAllocation(contentObject(event).allocation),
    vesting: parseVesting(contentObject(event).vesting),
    unlocks: parseUnlockPlan(body.unlocks),
    daoAtGraduation:
      typeof body.daoAtGraduation === "boolean" ? body.daoAtGraduation : null,
    legalWrapper:
      typeof body.legalWrapper === "string" ? body.legalWrapper : null,
    tokenPlan: parseTokenPlan(contentObject(event).tokenPlan),
  };
}

function parseTokenPlan(value: unknown): LaunchRecord["tokenPlan"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const plan = value as Record<string, unknown>;
  if (
    plan.mode !== "mint" ||
    typeof plan.name !== "string" ||
    typeof plan.symbol !== "string" ||
    typeof plan.supply !== "string"
  ) {
    return null;
  }
  return {
    mode: "mint",
    name: plan.name,
    symbol: plan.symbol,
    supply: plan.supply,
  };
}

/**
 * The terms a new launch starts from.
 *
 * These are the values `standardLaunchPreset` produces for a 10M valuation over
 * a billion tokens: a fifth of the supply sold at a floor of about a cent, a
 * tick grid 1bp of it, and a 300k graduation threshold (15% of the tranche's
 * floor value). The rest of the supply is the founder's to allocate to team,
 * treasury, liquidity and milestone unlocks. The previous defaults (`floorPrice
 * 1000000`, `tickSpacing 100`) could not be deployed at all — the floor is below
 * the contract's `MIN_FLOOR_PRICE` of 2^32+1 and 100 does not divide it, so the
 * auction constructor would have reverted. See `lib/launch-params.ts`, which
 * checks every one of these rules before a founder writes the terms.
 */
export const LAUNCH_DEFAULTS = {
  chainId: "11155111",
  floorPrice: "792281625140000",
  tickSpacing: "79228162514",
  requiredRaised: "299999999998",
  supply: "200000000",
  admission: "curated",
} as const;

export function isLaunchSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.trim());
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function isWholeTokenSupply(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  try {
    return BigInt(value.trim()) > 0n;
  } catch {
    return false;
  }
}

export function suggestSymbol(name: string): string {
  return name
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 4);
}

/** Exact CLI mint command for a mint-mode plan (copy-paste handoff). */
export function mintCommandForPlan(input: {
  tokenName: string;
  symbol: string;
  supply: string;
  treasury: string;
}): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "buzz launchpad mint-token",
    `--name ${quote(input.tokenName)}`,
    `--symbol ${input.symbol}`,
    `--supply ${input.supply}`,
    `--treasury ${input.treasury}`,
  ].join(" ");
}

/**
 * Split a mirror's `a` tag into its author-qualified identity.
 *
 * NIP-LP requires exactly one canonical `37001:<hex-author>:<slug>`. The author
 * is part of the identity: two founders may both publish a launch called
 * "nebula", and a mirror must attach to the one that published it rather than
 * to whichever came first.
 */
function launchRefFrom(
  event: NostrEvent,
): { launchId: string; launchKey: string } | null {
  const coord = tagValue(event, "a");
  if (!coord) return null;
  const parts = coord.split(":");
  if (parts.length < 3 || parts[0] !== String(KIND_LAUNCH_RECORD)) return null;
  const author = parts[1];
  const id = parts.slice(2).join(":");
  if (author.length === 0 || id.length === 0) return null;
  return { launchId: id, launchKey: `${author}:${id}` };
}

export function parseLaunchBid(event: NostrEvent): LaunchBid | null {
  if (event.kind !== KIND_LAUNCH_BID) return null;
  const ref = launchRefFrom(event);
  if (!ref) return null;
  const body = contentObject(event);
  return {
    id: event.id,
    launchId: ref.launchId,
    launchKey: ref.launchKey,
    author: event.pubkey,
    createdAt: event.created_at,
    bucket: tagValue(event, "m") ?? "",
    budget: str(body.budget),
    maxPrice: str(body.maxPrice),
    tx: str(body.tx),
  };
}

export function parseLaunchUpdate(event: NostrEvent): LaunchUpdate | null {
  if (event.kind !== KIND_LAUNCH_UPDATE) return null;
  const ref = launchRefFrom(event);
  if (!ref) return null;
  const body = contentObject(event);
  return {
    id: event.id,
    launchId: ref.launchId,
    launchKey: ref.launchKey,
    author: event.pubkey,
    createdAt: event.created_at,
    title: typeof body.title === "string" ? body.title : "Update",
    body: typeof body.body === "string" ? body.body : "",
    links: strs(body.links),
  };
}

function isProposalKind(value: unknown): value is ProposalKind {
  return (
    value === "plain" ||
    value === "futarchy-budget" ||
    value === "signal" ||
    value === "return-capital"
  );
}

/**
 * Strict `content.intent` parse (desktop's `parseProposalIntent` rules,
 * byte-compatible): anything malformed returns null — a record without a
 * valid intent stays record-only for execution (D8), never guessed at.
 */
export function parseProposalIntent(value: unknown): ProposalIntent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.to !== "string" || typeof raw.nonce !== "string") return null;
  if (typeof raw.data !== "string") return null;
  if (raw.op !== 0 && raw.op !== 1) return null;
  const valueField = raw.value;
  if (typeof valueField !== "bigint" && typeof valueField !== "string") {
    return null;
  }
  return {
    op: raw.op,
    to: raw.to,
    value: valueField,
    data: raw.data,
    nonce: raw.nonce,
  };
}

export function parseProposalCalls(value: unknown): ProposalCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ProposalCall[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as Record<string, unknown>;
    if (e.operation !== "call" && e.operation !== "delegatecall")
      return undefined;
    const row: ProposalCall = {
      operation: e.operation,
      from: "",
      to: "",
      value: "",
      data: "",
    };
    for (const field of ["from", "to", "value", "data"] as const) {
      if (typeof e[field] !== "string") return undefined;
      row[field] = e[field] as string;
    }
    out.push(row);
  }
  return out.length > 0 ? out : undefined;
}

export function parseLaunchProposal(event: NostrEvent): LaunchProposal | null {
  if (event.kind !== KIND_LAUNCH_PROPOSAL) return null;
  const ref = launchRefFrom(event);
  if (!ref) return null;
  const body = contentObject(event);
  const state =
    body.state === "passed" ||
    body.state === "executed" ||
    body.state === "defeated" ||
    body.state === "agent-draft"
      ? body.state
      : "open";
  return {
    id: event.id,
    launchId: ref.launchId,
    launchKey: ref.launchKey,
    author: event.pubkey,
    createdAt: event.created_at,
    proposalId: str(body.proposalId),
    kind: isProposalKind(body.kind) ? body.kind : "plain",
    issue: str(body.issue),
    state,
    title: typeof body.title === "string" ? body.title : "Proposal",
    evidence:
      typeof body.evidence === "string" && body.evidence.length > 0
        ? body.evidence
        : undefined,
    source: parseWikiTag(event.tags) ?? undefined,
    calls: parseProposalCalls(body.calls),
    intent: parseProposalIntent(body.intent) ?? undefined,
  };
}

export function parseLaunchReceipt(event: NostrEvent): LaunchReceipt | null {
  if (event.kind !== KIND_LAUNCH_RECEIPT) return null;
  const ref = launchRefFrom(event);
  const tx = tagValue(event, "tx");
  if (!ref || !tx) return null;
  return {
    id: event.id,
    launchId: ref.launchId,
    launchKey: ref.launchKey,
    author: event.pubkey,
    createdAt: event.created_at,
    table: tagValue(event, "kind") ?? "unknown",
    tx,
    payload: contentObject(event),
  };
}

/** Latest record per (author, d) wins; tombstoned coordinates are dropped. */
export function buildLaunches(
  events: NostrEvent[],
  tombstoned: ReadonlySet<string> = new Set(),
  deletedIds: ReadonlySet<string> = new Set(),
): Launch[] {
  const records = new Map<string, LaunchRecord>();
  const bids: LaunchBid[] = [];
  const updates: LaunchUpdate[] = [];
  const proposals: LaunchProposal[] = [];
  const receipts: LaunchReceipt[] = [];
  for (const event of events) {
    // NIP-09 `e`-tag tombstones hide individual mirrors (an agent-draft's
    // Reject disposal, D5) — the hash chain keeps the audit.
    if (deletedIds.has(event.id)) continue;
    if (event.kind === KIND_LAUNCH_RECORD) {
      const record = parseLaunchRecord(event);
      if (!record) continue;
      if (tombstoned.has(launchCoordinate(event.pubkey, record.id))) continue;
      const key = `${event.pubkey}:${record.id}`;
      const prev = records.get(key);
      if (!prev || record.createdAt >= prev.createdAt) records.set(key, record);
    } else if (event.kind === KIND_LAUNCH_BID) {
      const bid = parseLaunchBid(event);
      if (bid) bids.push(bid);
    } else if (event.kind === KIND_LAUNCH_UPDATE) {
      const update = parseLaunchUpdate(event);
      if (update) updates.push(update);
    } else if (event.kind === KIND_LAUNCH_PROPOSAL) {
      const proposal = parseLaunchProposal(event);
      if (proposal) proposals.push(proposal);
    } else if (event.kind === KIND_LAUNCH_RECEIPT) {
      const receipt = parseLaunchReceipt(event);
      if (receipt) receipts.push(receipt);
    }
  }
  const launches = new Map<string, Launch>();
  for (const record of records.values()) {
    launches.set(`${record.author}:${record.id}`, {
      record,
      bids: [],
      updates: [],
      proposals: [],
      receipts: [],
    });
  }
  // One lookup per mirror, keyed by the author-qualified identity. Keying on
  // the slug alone attached a mirror to whichever launch with that slug came
  // first, so two founders using the same name saw each other's bids — and it
  // scanned every launch for every mirror.
  const ownerOf = (launchKey: string): Launch | undefined =>
    launches.get(launchKey);
  for (const bid of bids) ownerOf(bid.launchKey)?.bids.push(bid);
  for (const update of updates) ownerOf(update.launchKey)?.updates.push(update);
  for (const proposal of proposals)
    ownerOf(proposal.launchKey)?.proposals.push(proposal);
  for (const receipt of receipts)
    ownerOf(receipt.launchKey)?.receipts.push(receipt);
  const out = [...launches.values()];
  for (const launch of out) {
    launch.updates.sort((a, b) => b.createdAt - a.createdAt);
    launch.proposals.sort((a, b) => b.createdAt - a.createdAt);
    launch.receipts.sort((a, b) => a.createdAt - b.createdAt);
  }
  out.sort((a, b) => b.record.createdAt - a.record.createdAt);
  return out;
}

export function effectiveStage(launch: Launch): LaunchStage {
  const tables = new Set(launch.receipts.map((r) => r.table));
  if (tables.has("summon") || tables.has("graduate")) return "graduated";
  if (tables.has("refund-open") || tables.has("failed")) return "failed";
  return launch.record.stage;
}

/**
 * The founder commitments a launch needs before it leaves `review` for `live`.
 *
 * Numeric terms make a deployable auction; these make an investor able to
 * judge the person running it. Pure so `models.test.mjs` can pin the rule.
 */
export function hasFounderCommitments(record: LaunchRecord): boolean {
  return (
    Boolean(record.longPitch) &&
    record.channels.length >= 1 &&
    Boolean(record.budget) &&
    Boolean(record.updateCadence)
  );
}

export interface ScoreRoot {
  id: string;
  author: string;
  createdAt: number;
  program: string;
  root: string;
  epoch: string;
  indexerUrl: string | null;
  anchorBlock: number | null;
}

/**
 * Parse a score-root record (kind 37006, d = program:epoch).
 *
 * A trustgraph operator publishes the proven Merkle root of a community's
 * scores each epoch; clients verify individual score claims against it with
 * `lib/trust-score.ts` (no prover needed). Malformed records are refused
 * rather than shown as authoritative.
 */
export function parseScoreRoot(event: NostrEvent): ScoreRoot | null {
  if (event.kind !== KIND_SCORE_ROOT) return null;
  const id = tagValue(event, "d");
  if (!id) return null;
  const body = contentObject(event);
  const program = str(body.program);
  const root = str(body.root);
  const epoch = str(body.epoch);
  if (!program || !root || !/^0x[0-9a-fA-F]{64}$/.test(root)) return null;
  return {
    id,
    author: event.pubkey,
    createdAt: event.created_at,
    program,
    root,
    epoch: epoch || id,
    indexerUrl: str(body.indexerUrl),
    anchorBlock: int(body.anchorBlock),
  };
}

export interface VestingTranche {
  /** Unlocks when the token price reaches this multiple of the floor. */
  multiple: number;
  /** Tranche size in percent of the unlocked pool (sums to 100). */
  percent: number;
}

export interface VestingConfig {
  /** Blocks before the first tranche can unlock. */
  cliffBlocks: number;
  /** Price-multiple tranches, ascending. */
  tranches: VestingTranche[];
  /** TWAP window used to observe the price (blocks). */
  twapWindow: number | null;
}

export function parseVesting(value: unknown): VestingConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.cliffBlocks !== "number" || !Array.isArray(v.tranches)) {
    return null;
  }
  const tranches: VestingTranche[] = [];
  for (const raw of v.tranches) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.multiple !== "number" || typeof t.percent !== "number") {
      return null;
    }
    tranches.push({ multiple: t.multiple, percent: t.percent });
  }
  if (tranches.length === 0) return null;
  return {
    cliffBlocks: v.cliffBlocks,
    tranches,
    twapWindow: typeof v.twapWindow === "number" ? v.twapWindow : null,
  };
}
