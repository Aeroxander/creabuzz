import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  LAUNCHPAD_EVENT_KINDS,
} from "@/shared/constants/kinds";

export { LAUNCHPAD_EVENT_KINDS };

export type LaunchStage =
  | "draft"
  | "review"
  | "live"
  | "funding"
  | "graduated"
  | "failed";

export const LAUNCH_STAGES: readonly LaunchStage[] = [
  "draft",
  "review",
  "live",
  "funding",
  "graduated",
  "failed",
];

export function isLaunchStage(value: unknown): value is LaunchStage {
  return (
    typeof value === "string" &&
    (LAUNCH_STAGES as readonly string[]).includes(value)
  );
}

export type LaunchRecord = {
  id: string;
  eventId: string;
  author: string;
  createdAt: number;
  name: string;
  pitch: string;
  stage: LaunchStage;
  currency: string | null;
  floorPrice: string | null;
  tickSpacing: string | null;
  requiredRaised: string | null;
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
  hooks: Array<{ address: string; bucket: string }>;
  admission: "curated" | "community";
  tokenPlan: {
    mode: "mint";
    name: string;
    symbol: string;
    supply: string;
  } | null;
};

export type LaunchBid = {
  id: string;
  launchId: string;
  author: string;
  createdAt: number;
  bucket: string;
  budget: string | null;
  maxPrice: string | null;
  tx: string | null;
};

export type LaunchUpdate = {
  id: string;
  launchId: string;
  author: string;
  createdAt: number;
  title: string;
  body: string;
  links: string[];
};

export type ProposalKind = "plain" | "futarchy-budget" | "signal";

export type LaunchProposal = {
  id: string;
  launchId: string;
  author: string;
  createdAt: number;
  proposalId: string | null;
  kind: ProposalKind;
  issue: string | null;
  state: "open" | "passed" | "executed" | "defeated";
  title: string;
};

export type LaunchReceipt = {
  id: string;
  launchId: string;
  author: string;
  createdAt: number;
  table: string;
  tx: string;
  payload: Record<string, unknown>;
};

export type Launch = {
  record: LaunchRecord;
  bids: LaunchBid[];
  updates: LaunchUpdate[];
  proposals: LaunchProposal[];
  receipts: LaunchReceipt[];
};

/** First `[name, value]` tag value, or null. Pure and side-effect free. */
export function tagValue(
  tags: string[][] | undefined,
  name: string,
): string | null {
  const tag = tags?.find((t) => t[0] === name);
  return tag && tag.length >= 2 ? tag[1] : null;
}

/** All values of `[name, value]` tags. */
export function tagValues(
  tags: string[][] | undefined,
  name: string,
): string[] {
  return (tags ?? [])
    .filter((t) => t[0] === name && t.length >= 2)
    .map((t) => t[1]);
}

/** Canonical launch coordinate: `37001:<author-hex>:<launch-id>`. */
export function launchCoordinate(author: string, launchId: string): string {
  return `${KIND_LAUNCH_RECORD}:${author}:${launchId}`;
}

/** True when an event's `a` tag references the given launch coordinate. */
export function eventForLaunch(event: RelayEvent, coordinate: string): boolean {
  return (event.tags ?? []).some(
    (t) =>
      t[0] === "a" &&
      (t[1] === coordinate ||
        t[1]?.endsWith(`:${coordinate.split(":").pop()}`)),
  );
}

function parseContentObject(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function parseLaunchRecordEvent(event: RelayEvent): LaunchRecord | null {
  if (event.kind !== KIND_LAUNCH_RECORD) return null;
  const id = tagValue(event.tags, "d");
  const name = tagValue(event.tags, "name");
  if (!id || !name) return null;
  const body = parseContentObject(event.content) ?? {};
  const stage = isLaunchStage(body.stage) ? body.stage : "draft";
  const admission =
    tagValue(event.tags, "admission") === "community" ? "community" : "curated";
  const team = (event.tags ?? [])
    .filter((t) => t[0] === "team" && t.length >= 3)
    .map((t) => ({ pubkey: t[1], role: t[2] }));
  const hooks = (event.tags ?? [])
    .filter((t) => t[0] === "hook" && t.length >= 3)
    .map((t) => ({ address: t[1], bucket: t[2] }));
  return {
    id,
    eventId: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    name,
    pitch: typeof body.pitch === "string" ? body.pitch : "",
    stage,
    currency: stringOrNull(body.currency),
    floorPrice: stringOrNull(body.floorPrice),
    tickSpacing: stringOrNull(body.tickSpacing),
    requiredRaised: stringOrNull(body.requiredRaised),
    startBlock: numberOrNull(body.startBlock),
    endBlock: numberOrNull(body.endBlock),
    claimBlock: numberOrNull(body.claimBlock),
    paramsHash: stringOrNull(body.paramsHash),
    website: stringOrNull(body.website),
    docs: stringArray(body.docs),
    channels: tagValues(event.tags, "buzz-channel"),
    projects: tagValues(event.tags, "a"),
    team,
    chainId: tagValue(event.tags, "chain"),
    auction: tagValue(event.tags, "auction"),
    token: tagValue(event.tags, "token"),
    treasury: tagValue(event.tags, "treasury"),
    hooks,
    admission,
    tokenPlan: parseTokenPlan(body.tokenPlan),
  };
}

function parseTokenPlan(value: unknown): LaunchRecord["tokenPlan"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const plan = value as Record<string, unknown>;
  if (plan.mode !== "mint") return null;
  if (
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

function launchIdFromCoordinate(coordinate: string | null): string | null {
  if (!coordinate) return null;
  const parts = coordinate.split(":");
  if (parts.length < 3 || parts[0] !== String(KIND_LAUNCH_RECORD)) return null;
  const id = parts.slice(2).join(":");
  return id.length > 0 ? id : null;
}

export function parseLaunchBidEvent(event: RelayEvent): LaunchBid | null {
  if (event.kind !== KIND_LAUNCH_BID) return null;
  const launchId = launchIdFromCoordinate(tagValue(event.tags, "a"));
  if (!launchId) return null;
  const body = parseContentObject(event.content) ?? {};
  return {
    id: event.id,
    launchId,
    author: event.pubkey,
    createdAt: event.created_at,
    bucket: tagValue(event.tags, "m") ?? "",
    budget: stringOrNull(body.budget),
    maxPrice: stringOrNull(body.maxPrice),
    tx: stringOrNull(body.tx),
  };
}

export function parseLaunchUpdateEvent(event: RelayEvent): LaunchUpdate | null {
  if (event.kind !== KIND_LAUNCH_UPDATE) return null;
  const launchId = launchIdFromCoordinate(tagValue(event.tags, "a"));
  if (!launchId) return null;
  const body = parseContentObject(event.content) ?? {};
  return {
    id: event.id,
    launchId,
    author: event.pubkey,
    createdAt: event.created_at,
    title: typeof body.title === "string" ? body.title : "Update",
    body: typeof body.body === "string" ? body.body : "",
    links: stringArray(body.links),
  };
}

function isProposalKind(value: unknown): value is ProposalKind {
  return value === "plain" || value === "futarchy-budget" || value === "signal";
}

export function parseLaunchProposalEvent(
  event: RelayEvent,
): LaunchProposal | null {
  if (event.kind !== KIND_LAUNCH_PROPOSAL) return null;
  const launchId = launchIdFromCoordinate(tagValue(event.tags, "a"));
  if (!launchId) return null;
  const body = parseContentObject(event.content) ?? {};
  const state =
    body.state === "passed" ||
    body.state === "executed" ||
    body.state === "defeated"
      ? body.state
      : "open";
  return {
    id: event.id,
    launchId,
    author: event.pubkey,
    createdAt: event.created_at,
    proposalId: stringOrNull(body.proposalId),
    kind: isProposalKind(body.kind) ? body.kind : "plain",
    issue: stringOrNull(body.issue),
    state,
    title: typeof body.title === "string" ? body.title : "Proposal",
  };
}

export function parseLaunchReceiptEvent(
  event: RelayEvent,
): LaunchReceipt | null {
  if (event.kind !== KIND_LAUNCH_RECEIPT) return null;
  const launchId = launchIdFromCoordinate(tagValue(event.tags, "a"));
  const tx = tagValue(event.tags, "tx");
  if (!launchId || !tx) return null;
  return {
    id: event.id,
    launchId,
    author: event.pubkey,
    createdAt: event.created_at,
    table: tagValue(event.tags, "kind") ?? "unknown",
    tx,
    payload: parseContentObject(event.content) ?? {},
  };
}

/**
 * Reduce raw launchpad events into per-launch read models. Latest record per
 * (author, d) wins by created_at (the relay already applies NIP-33 LWW; this
 * is the defensive client-side reduction). Tombstoned records (kind:5 `a`
 * coordinate) and their mirrors are dropped.
 */
export function buildLaunchesFromEvents(
  events: RelayEvent[],
  tombstonedCoordinates: ReadonlySet<string> = new Set(),
): Launch[] {
  const records = new Map<string, LaunchRecord>();
  const bids: LaunchBid[] = [];
  const updates: LaunchUpdate[] = [];
  const proposals: LaunchProposal[] = [];
  const receipts: LaunchReceipt[] = [];
  for (const event of events) {
    switch (event.kind) {
      case KIND_LAUNCH_RECORD: {
        const record = parseLaunchRecordEvent(event);
        if (!record) break;
        const key = `${event.pubkey}:${record.id}`;
        const coordinate = launchCoordinate(event.pubkey, record.id);
        if (tombstonedCoordinates.has(coordinate)) break;
        const prev = records.get(key);
        if (!prev || record.createdAt >= prev.createdAt)
          records.set(key, record);
        break;
      }
      case KIND_LAUNCH_BID: {
        const bid = parseLaunchBidEvent(event);
        if (bid) bids.push(bid);
        break;
      }
      case KIND_LAUNCH_UPDATE: {
        const update = parseLaunchUpdateEvent(event);
        if (update) updates.push(update);
        break;
      }
      case KIND_LAUNCH_PROPOSAL: {
        const proposal = parseLaunchProposalEvent(event);
        if (proposal) proposals.push(proposal);
        break;
      }
      case KIND_LAUNCH_RECEIPT: {
        const receipt = parseLaunchReceiptEvent(event);
        if (receipt) receipts.push(receipt);
        break;
      }
      default:
        break;
    }
  }
  const byAuthorAndId = new Map<string, Launch>();
  for (const record of records.values()) {
    byAuthorAndId.set(`${record.author}:${record.id}`, {
      record,
      bids: [],
      updates: [],
      proposals: [],
      receipts: [],
    });
  }
  const ownerOf = (launchId: string): Launch | null => {
    for (const launch of byAuthorAndId.values()) {
      if (launch.record.id === launchId) return launch;
    }
    return null;
  };
  for (const bid of bids) ownerOf(bid.launchId)?.bids.push(bid);
  for (const update of updates) ownerOf(update.launchId)?.updates.push(update);
  for (const proposal of proposals)
    ownerOf(proposal.launchId)?.proposals.push(proposal);
  for (const receipt of receipts)
    ownerOf(receipt.launchId)?.receipts.push(receipt);
  const launches = [...byAuthorAndId.values()];
  for (const launch of launches) {
    launch.bids.sort((a, b) => a.createdAt - b.createdAt);
    launch.updates.sort((a, b) => b.createdAt - a.createdAt);
    launch.proposals.sort((a, b) => b.createdAt - a.createdAt);
    launch.receipts.sort((a, b) => a.createdAt - b.createdAt);
  }
  launches.sort((a, b) => b.record.createdAt - a.record.createdAt);
  return launches;
}
