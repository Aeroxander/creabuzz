import type { NostrEvent } from "@/shared/lib/nostr-client";
// Relative so this module can be exercised by `node --test` (see
// models.test.mjs); the kind numbers are plain constants with no imports.
// Extension included on purpose: this module is driven by `models.test.mjs`
// under `node --test`, which does not resolve extensionless specifiers.
import { parseAllocation, type SupplyAllocation } from "./lib/allocation.ts";
import {
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
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

export interface LaunchRecord {
  id: string;
  eventId: string;
  author: string;
  createdAt: number;
  name: string;
  pitch: string;
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
  chainId: string | null;
  auction: string | null;
  token: string | null;
  treasury: string | null;
  admission: "curated" | "community";
  /** How the supply is split. Absent on older records: the standard split. */
  allocation: SupplyAllocation;
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
  state: "open" | "passed" | "executed" | "defeated";
  title: string;
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
    team: event.tags
      .filter((t) => t[0] === "team" && t.length >= 3)
      .map((t) => ({ pubkey: t[1], role: t[2] })),
    chainId: tagValue(event, "chain"),
    auction: tagValue(event, "auction"),
    token: tagValue(event, "token"),
    treasury: tagValue(event, "treasury"),
    admission:
      tagValue(event, "admission") === "community" ? "community" : "curated",
    allocation: parseAllocation(contentObject(event).allocation),
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
  return value === "plain" || value === "futarchy-budget" || value === "signal";
}

export function parseLaunchProposal(event: NostrEvent): LaunchProposal | null {
  if (event.kind !== KIND_LAUNCH_PROPOSAL) return null;
  const ref = launchRefFrom(event);
  if (!ref) return null;
  const body = contentObject(event);
  const state =
    body.state === "passed" ||
    body.state === "executed" ||
    body.state === "defeated"
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
): Launch[] {
  const records = new Map<string, LaunchRecord>();
  const bids: LaunchBid[] = [];
  const updates: LaunchUpdate[] = [];
  const proposals: LaunchProposal[] = [];
  const receipts: LaunchReceipt[] = [];
  for (const event of events) {
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
