import type { NostrEvent } from "@/shared/lib/nostr-client";
// Relative so this module can be exercised by `node --test` (see
// models.test.mjs); the kind numbers are plain constants with no imports.
// Extension included on purpose: this module is driven by `models.test.mjs`
// under `node --test`, which does not resolve extensionless specifiers.
import { parseAllocation, type SupplyAllocation } from "./lib/allocation.ts";
import { parseWikiTag } from "@creaton/core/launchpad/draft-proposal.ts";
import { parseFunding, type FundingStatus } from "./lib/funding.ts";
import { type IpRecord, parseIpRecord } from "./lib/ip-record.ts";
import {
  type BuiltOn,
  isBuiltOnCoordinate,
  parseBuiltOn,
  parseRemixTerms,
  type RemixTerms,
} from "./lib/remix.ts";
import {
  parseRevenuePledge,
  type RevenuePledge,
} from "./lib/revenue-pledge.ts";
import { parseUnlockPlan, type UnlockPlan } from "./lib/unlock-plans.ts";
import { isHelpSignalTags } from "./lib/help-request.ts";
import { partsFromTags, type UpdateParts } from "./lib/weekly-update.ts";
import {
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "../../shared/constants/kinds.ts";
import {
  contentObject,
  int,
  str,
  strs,
  tagValue,
  tagValues,
} from "./lib/nostr-fields.ts";

export { launchRemovals, removedLaunchIds } from "./lib/launch-removals.ts";
export { type ScoreRoot, parseScoreRoot } from "./lib/score-root-model.ts";

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

function isLaunchStage(value: unknown): value is LaunchStage {
  return typeof value === "string" && STAGES.includes(value);
}

/** Strict `["hook", <0x-address>, <bucket>]` parse (NIP-LP chain addresses). */
function parseHookTags(
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
  /**
   * How the team's reviewers will work, in the founder's words (how quickly they respond, whether they are paid, any
   * tie to the team), written when the project launched. Null for a project launched before this was asked.
   */
  reviewerTerms: string | null;
  stage: LaunchStage;
  /**
   * The project's own word about raising, separate from `stage`: a stance a
   * founder declares (`content.funding`, plan §2) with who they want to hear
   * from. Null when the record never said — `lib/funding.ts` then resolves the
   * display stance from chain truth alone.
   */
  funding: FundingStatus | null;
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
  /** Cover image URL shown on cards and the launch page (optional). */
  image: string | null;
  /**
   * The launch's topic: its first `t` tag other than the routing marker, so it
   * is the same tag Discover's category browse queries. Null when untagged.
   */
  category: string | null;
  docs: string[];
  channels: string[];
  /**
   * Which of the bound channels are the launch's chat rooms: one private room
   * for the team and one for supporters. Both ids are also in `channels` (the
   * relay only validates the tag), so a client that ignores this still sees
   * them as bound.
   */
  chat: LaunchChat;
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
   * Tranche enforcer wiring: the launch's ClaimStake, set once deployed.
   * `distributor` is a pre-v3 RoyaltyDistributor tag, still parsed so an edit
   * keeps an old record's tag (the royalty view was removed in D150, see tag
   * pre-deprecation-2026-10-31). Absent on pre-deploy launches.
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
  /**
   * Who holds the project's IP, and the documents that say so (`lib/ip-record.ts`).
   * Null when the record never said, which is not the same as "open".
   */
  ipRecord: IpRecord | null;
  /** The team's pledge of part of what the project earns to the treasury (D78); the contracts do not enforce it. */
  revenuePledge: RevenuePledge | null;
  /**
   * The first work areas' words exactly as hashed (a contributor project publishes them with its record), so people
   * can see what finished work looks like; they count only when they hash to a work area's check on the chain.
   */
  workAreas: { name: string; check: string }[];
  /**
   * How the founder knows each reviewer of the first budget, and any tie to them, in the founder's words: a contributor
   * project publishes it at the start (funding review D1). Null when the record never said.
   */
  reviewerTies: string | null;
  /** The project this one is built on (N11), or null. */
  builtOn: BuiltOn | null;
  /** Whether this project invites projects built on it, what it asks and offers (N11), or null when it never said. */
  remixTerms: RemixTerms | null;
  tokenPlan: {
    /**
     * "mint": a reserve-backed apptoken minted before the sale. "dao": the project's own Shares, created
     * with its DAO in one launch transaction (`lib/dao-launch.ts`); the supply is still the sale tranche.
     */
    mode: "mint" | "dao";
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
  /** The weekly prompts this update answered, when it carries them (`lib/weekly-update.ts`). */
  parts?: UpdateParts;
  /** The help this update asks for, when it asks for any: shown as a card people can answer. */
  help?: UpdateParts["help"];
  /**
   * Set when this update is the evidence a contributor submitted for a work claim: the claim it is for, the work budget
   * that holds it, and the exact words of the acceptance check. Reviewers read it, and it counts only when it hashes to
   * what the claim committed to on the chain (see `lib/evidence.ts`).
   */
  claim?: { id: string; mandate: string; check: string };
  /**
   * Set when this update publishes a work area's words: the budget that holds it, its id, and the words exactly as
   * hashed. They count only when they hash to the work area's check on the chain (`lib/work-area-words.ts`).
   */
  workArea?: { mandate: string; id: string; check: string };
  /** Set when this update is a check note (`checkNote.ts` in core); only its author's own counts. */
  checkNote?: true;
}

type ProposalKind = "plain" | "futarchy-budget" | "signal";

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

export function launchCoordinate(author: string, launchId: string): string {
  return `${KIND_LAUNCH_RECORD}:${author}:${launchId}`;
}

/**
 * The rooms a launch can have; an id is null until the room exists.
 *
 * - `team`: private, the people building it.
 * - `supporters`: open to anyone who is excited about it, no money involved.
 * - `backers`: private, only people who recorded a bid (the founder admits them).
 * - `board`: the project's own board, open, where its Discussion tab lives (D156).
 */
export interface LaunchChat {
  team: string | null;
  supporters: string | null;
  backers: string | null;
  board: string | null;
}

const CHANNEL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLaunchChat(value: unknown): LaunchChat {
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const room = (candidate: unknown) =>
    typeof candidate === "string" && CHANNEL_UUID.test(candidate)
      ? candidate.toLowerCase()
      : null;
  return {
    team: room(object.team),
    supporters: room(object.supporters),
    backers: room(object.backers),
    board: room(object.board),
  };
}

/**
 * The topics the create form offers. A short closed list on purpose: a filter
 * with forty near-duplicates is no filter at all. A record tagged with a topic
 * outside the list still shows it; only the picker is closed.
 */
export const LAUNCH_CATEGORIES = [
  "Software",
  "AI agents",
  "Creative",
  "Media",
  "Games",
  "Community",
  "Hardware",
  "Other",
] as const;

function categoryFromTags(event: NostrEvent): string | null {
  for (const tag of event.tags) {
    if (tag[0] !== "t" || typeof tag[1] !== "string") continue;
    const topic = tag[1].trim();
    if (topic === "" || topic.toLowerCase() === "dao-launchpad") continue;
    const known = LAUNCH_CATEGORIES.find(
      (name) => name.toLowerCase() === topic.toLowerCase(),
    );
    return known ?? topic.charAt(0).toUpperCase() + topic.slice(1);
  }
  return null;
}

/** Only web URLs: a record is untrusted input and this one lands in `<img src>`. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
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
    // Read from anyone's record, so bounded: the founder's own form stops at 1,000 characters.
    reviewerTerms: str(body.reviewerTerms)?.slice(0, 2_000) ?? null,
    stage: isLaunchStage(body.stage) ? body.stage : "draft",
    funding: parseFunding(body.funding),
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
    image: httpUrl(body.image),
    category: categoryFromTags(event),
    docs: strs(body.docs),
    channels: tagValues(event, "buzz-channel"),
    chat: parseLaunchChat(body.chat),
    // Linked projects; a built-on link (a launch record's coordinate) is read as `builtOn` instead.
    projects: tagValues(event, "a").filter((a) => !isBuiltOnCoordinate(a)),
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
    ipRecord: parseIpRecord(body.ipRecord),
    revenuePledge: parseRevenuePledge(body.revenuePledge),
    workAreas: parseWorkAreas(body.workAreas),
    reviewerTies: str(body.reviewerTies)?.slice(0, 2_000) ?? null,
    builtOn: parseBuiltOn(body.builtOn),
    remixTerms: parseRemixTerms(body.remixTerms),
    tokenPlan: parseTokenPlan(contentObject(event).tokenPlan),
  };
}

/** The most work areas' words one record carries: the kit makes at most eight, with room for a few added later. */
const MAX_RECORD_WORK_AREAS = 32;

function parseWorkAreas(value: unknown): LaunchRecord["workAreas"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RECORD_WORK_AREAS).flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    return typeof raw.name === "string" &&
      typeof raw.check === "string" &&
      raw.name.length <= 64 &&
      raw.check.length <= 1_000
      ? [{ name: raw.name, check: raw.check }]
      : [];
  });
}

function parseTokenPlan(value: unknown): LaunchRecord["tokenPlan"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const plan = value as Record<string, unknown>;
  if (
    (plan.mode !== "mint" && plan.mode !== "dao") ||
    typeof plan.name !== "string" ||
    typeof plan.symbol !== "string" ||
    typeof plan.supply !== "string"
  ) {
    return null;
  }
  return {
    mode: plan.mode,
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
  // The sale tranche: 30 million Shares at a cent raise the default 300,000 when all of them sell, which is what a
  // sale must do (D74: it sells out or refunds).
  supply: "30000000",
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

function parseLaunchBid(event: NostrEvent): LaunchBid | null {
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
  const parts = partsFromTags(event.tags);
  return {
    id: event.id,
    launchId: ref.launchId,
    launchKey: ref.launchKey,
    author: event.pubkey,
    createdAt: event.created_at,
    title: typeof body.title === "string" ? body.title : "Update",
    body: typeof body.body === "string" ? body.body : "",
    links: strs(body.links),
    ...(parts ? { parts, help: parts.help } : {}),
    claim: parseUpdateClaim(body.claim),
    workArea: parseUpdateClaim(body.workArea),
    ...(isCheckNote(body.check) ? { checkNote: true as const } : {}),
  };
}

/** A check note's `check` object, as far as a list needs to know: its version is one this app reads. */
function isCheckNote(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === 1
  );
}

const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The claim an evidence update is for, or undefined when it names none or names it badly. */
function parseUpdateClaim(value: unknown): LaunchUpdate["claim"] {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !WORD_RE.test(raw.id) ||
    typeof raw.mandate !== "string" ||
    !ADDRESS_RE.test(raw.mandate) ||
    typeof raw.check !== "string"
  ) {
    return undefined;
  }
  return {
    id: raw.id.toLowerCase(),
    mandate: raw.mandate.toLowerCase(),
    check: raw.check,
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

/**
 * Whether a removal hides this record. A set hides every version; a map of coordinate to removal time hides only the
 * versions published no later than the removal (NIP-09), so a record published again afterwards shows.
 */
function removedRecord(
  tombstoned: ReadonlySet<string> | ReadonlyMap<string, number>,
  coordinate: string,
  createdAt: number,
): boolean {
  if (tombstoned instanceof Map) {
    const at = tombstoned.get(coordinate);
    return at !== undefined && createdAt <= at;
  }
  return tombstoned.has(coordinate);
}

/** Latest record per (author, d) wins; records a removal hides are dropped. */
export function buildLaunches(
  events: NostrEvent[],
  tombstoned: ReadonlySet<string> | ReadonlyMap<string, number> = new Set(),
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
      if (
        removedRecord(
          tombstoned,
          launchCoordinate(event.pubkey, record.id),
          record.createdAt,
        )
      )
        continue;
      const key = `${event.pubkey}:${record.id}`;
      const prev = records.get(key);
      if (!prev || record.createdAt >= prev.createdAt) records.set(key, record);
    } else if (event.kind === KIND_LAUNCH_BID) {
      const bid = parseLaunchBid(event);
      if (bid) bids.push(bid);
    } else if (event.kind === KIND_LAUNCH_UPDATE) {
      // An offer to help, a reply to one or "Help found" answers an update; it is not one. They are read for one
      // project at a time (`use-help-requests.ts`), never kept from this list, which is cut at a fixed size.
      if (isHelpSignalTags(event.tags)) continue;
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

interface VestingTranche {
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
