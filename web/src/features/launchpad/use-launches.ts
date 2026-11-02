import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { getAgentPubkey } from "@/shared/lib/agent-identity";
import { signAsUser, existingUserPubkey } from "@/shared/lib/identity";
import { signLaunchpadEventAsAgent } from "./lib/agent-launchpad";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { SupplyAllocation } from "./lib/allocation";
import type { UnlockPlan } from "./lib/unlock-plans";
import type { VestingConfig } from "./models";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_CONTRIBUTION_RECORD,
  KIND_LAUNCH_BID,
  type KIND_LAUNCH_PROPOSAL,
  type KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_ORG_BUDGET,
  KIND_ORG_NODE,
  KIND_SCORE_ROOT as LAUNCHPAD_SCORE_ROOT_KIND,
  type KIND_LAUNCH_UPDATE,
} from "@/shared/constants/kinds";
import { boundChannelIds, hasChat } from "./lib/launch-chat";
import { fundingContent, type FundingStatus } from "./lib/funding";
import { type IpRecord, ipRecordContent } from "./lib/ip-record";
import { type BuiltOn, builtOnCoordinate, type RemixTerms } from "./lib/remix";
import { type RevenuePledge, revenuePledgeContent } from "./lib/revenue-pledge";
import { supersedingTime } from "./lib/record-time";
import { launchQueryFilter } from "./lib/launch-query";
import {
  acceptedPublisherPolicy,
  safeProofUrl,
  standingOf,
} from "./lib/score-root-policy";
import { viteEnv } from "./chain-config";
import { evidenceQueryKey } from "./use-evidence";
import {
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
  summarizeCommunityTrustSignals,
  type CommunityTrustRecord,
} from "./lib/trust-signals";
import {
  parseOrgBinding,
  parseOrgBudget,
  parseSpendReceipt,
  type OrgBinding,
  type OrgBudget,
  type SpendReceipt,
} from "./lib/org-money";
import { readRemovedLaunchIds } from "./lib/launch-removals";
import {
  buildLaunches,
  launchCoordinate,
  launchRemovals,
  parseScoreRoot,
  type Launch,
  type LaunchChat,
  type LaunchStage,
  type ScoreRoot,
} from "./models";

export const launchesQueryKey = ["launchpad", "launches"];

async function fetchTombstones(
  coords: string[],
  ids: string[] = [],
): Promise<{
  coordinates: Map<string, number>;
  deletedIds: Set<string>;
}> {
  const removals: NostrEvent[] = [];
  for (let i = 0; i < coords.length; i += 100) {
    const group = coords.slice(i, i + 100);
    if (group.length === 0) continue;
    removals.push(
      ...(await queryEvents(relayWsUrl(), {
        kinds: [5],
        "#a": group,
        limit: 200,
      })),
    );
  }
  // By coordinate and time, the author's own only: a record published again after its removal shows again.
  const out = {
    coordinates: launchRemovals(removals),
    deletedIds: new Set<string>(),
  };
  // NIP-09 `e`-tag tombstones hide individual mirrors — an agent-draft's
  // Reject disposal (persona-drafting-loop D5).
  for (let i = 0; i < ids.length; i += 100) {
    const group = ids.slice(i, i + 100);
    if (group.length === 0) continue;
    const events = await queryEvents(relayWsUrl(), {
      kinds: [5],
      "#e": group,
      limit: 200,
    });
    for (const event of events) {
      for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) out.deletedIds.add(tag[1]);
      }
    }
  }
  return out;
}

export async function fetchLaunches(): Promise<Launch[]> {
  const events = await queryEvents(relayWsUrl(), launchQueryFilter());
  const coords = events
    .filter((e) => e.kind === KIND_LAUNCH_RECORD)
    .map((e) => {
      const d = e.tags.find((t) => t[0] === "d")?.[1];
      return d ? launchCoordinate(e.pubkey, d) : null;
    })
    .filter((c): c is string => c !== null);
  const mirrorIds = events
    .filter((e) => e.kind !== KIND_LAUNCH_RECORD)
    .map((e) => e.id);
  const tombstones =
    coords.length + mirrorIds.length > 0
      ? await fetchTombstones(coords, mirrorIds)
      : {
          coordinates: new Map<string, number>(),
          deletedIds: new Set<string>(),
        };
  return buildLaunches(events, tombstones.coordinates, tombstones.deletedIds);
}

/**
 * The ids of `author`'s launch records that were ever taken off the list. `useLaunches` drops them, so a new project
 * named like a removed one would otherwise get the removed one's id, and with it the removed project's DAO address.
 * Read in pages (`readRemovedLaunchIds`), so the author's other deletions never hide an old removal.
 */
export async function fetchRemovedLaunchIds(author: string): Promise<string[]> {
  return readRemovedLaunchIds(author, (filter) =>
    queryEvents(relayWsUrl(), { ...filter }),
  );
}

export function useRemovedLaunchIds(author: string | null) {
  return useQuery({
    queryKey: [...launchesQueryKey, "removed", author],
    queryFn: () => fetchRemovedLaunchIds(author as string),
    enabled: author !== null,
    staleTime: 30_000,
    // A project removed in another tab or on another device is seen when this one comes back into view.
    refetchOnWindowFocus: true,
  });
}

export function useLaunches() {
  return useQuery({
    queryKey: launchesQueryKey,
    queryFn: fetchLaunches,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

const scoreRootsQueryKey = ["launchpad", "score-roots"];

/**
 * The community's trustgraph score roots (kind 37006).
 *
 * A scoring operator publishes the proven Merkle root per epoch; clients
 * verify individual score claims against it (`lib/trust-score.ts`). Who may
 * publish one this community calls its own is a policy, not a guess: with
 * `lib/score-root-policy.ts` configured, the Nostr query asks only for the
 * accepted publishers' records *and* every returned record is filtered again,
 * so a server that ignores the author filter cannot reshape the list. Without
 * a policy nothing is dropped silently — every readable root comes back
 * labelled as its publisher's own claim, and the screens say so instead of
 * presenting it as the community's reputation.
 */
export async function fetchScoreRoots(): Promise<ScoreRoot[]> {
  const policy = acceptedPublisherPolicy({
    relayUrl: relayWsUrl(),
    env: viteEnv(),
  });
  const filter: Parameters<typeof queryEvents>[1] = {
    kinds: [LAUNCHPAD_SCORE_ROOT_KIND],
    limit: 50,
  };
  // The query itself is filtered: the server only has to answer for the
  // publishers the community accepted.
  if (policy) filter.authors = [...policy.publishers];
  const events = await queryEvents(relayWsUrl(), filter);
  const roots: ScoreRoot[] = [];
  for (const event of events) {
    const root = parseScoreRoot(event);
    if (!root) continue;
    // Returned records filtered too — and claims the policy does not accept
    // are kept only so they can say they are a claim; with a policy the query
    // already named the accepted publishers, so anything else is dropped.
    root.standing = standingOf(root, policy);
    if (policy && root.standing !== "accepted") continue;
    root.proofUrl = safeProofUrl(root.indexerUrl);
    roots.push(root);
  }
  // Stable "latest": newest first, ties by lowest id. No reliance on what
  // order the server happened to answer in.
  roots.sort(
    (a, b) =>
      b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return roots;
}

export function useScoreRoots() {
  const policy = acceptedPublisherPolicy({
    relayUrl: relayWsUrl(),
    env: viteEnv(),
  });
  // The cache is scoped by community and policy: another community's roots —
  // or roots accepted under a different policy — never stand in for this one's.
  const scope = `${new URL(relayWsUrl()).host}:${
    policy
      ? `${policy.publishers.join(",")}|${policy.programs.join(",")}`
      : "no-policy"
  }`;
  return useQuery({
    queryKey: [...scoreRootsQueryKey, scope],
    queryFn: fetchScoreRoots,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

const orgMoneyQueryKey = ["launchpad", "org-money"];

/** What `fetchOrgMoney` reads off the relay in one pass. */
export interface OrgMoney {
  bindings: OrgBinding[];
  budgets: OrgBudget[];
  spends: SpendReceipt[];
}

/**
 * The community's org money plane — bound DAO roots (37010 carrying
 * `content.onchain`), budgets (37012), and spend receipts (37014) — read
 * through the same relay query surface as `fetchScoreRoots`. Parsing and the
 * binding/allowance semantics live in `lib/org-money.ts` (cited there).
 */
export async function fetchOrgMoney(): Promise<OrgMoney> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_ORG_NODE, KIND_ORG_BUDGET, KIND_BUDGET_SPEND_RECEIPT],
    limit: 500,
  });
  const bindings: OrgBinding[] = [];
  const budgets: OrgBudget[] = [];
  const spends: SpendReceipt[] = [];
  for (const event of events) {
    const binding = parseOrgBinding(event);
    if (binding) {
      bindings.push(binding);
      continue;
    }
    const budget = parseOrgBudget(event);
    if (budget) {
      budgets.push(budget);
      continue;
    }
    const spend = parseSpendReceipt(event);
    if (spend) spends.push(spend);
  }
  budgets.sort((a, b) => b.createdAt - a.createdAt);
  spends.sort((a, b) => b.createdAt - a.createdAt);
  return { bindings, budgets, spends };
}

export function useOrgMoney() {
  return useQuery({
    queryKey: orgMoneyQueryKey,
    queryFn: fetchOrgMoney,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

const trustSignalsQueryKey = ["launchpad", "trust-signals"];

/**
 * The community's contribution reviews (kind 37013) and workflow approval
 * outcomes (kinds 46030/46031) — the community half of the trust surface.
 *
 * Bounded and explicitly kinded (the relay's p-gate) exactly like
 * `fetchOrgMoney`/`fetchScoreRoots`; the parsing, NIP-ORG canonical
 * resolution and approval linking live in `lib/trust-signals.ts`. A failed
 * read rejects here so the card can say "unavailable" instead of rendering an
 * empty ledger (Review-Proven Rule 1).
 */
export async function fetchTrustSignals(): Promise<CommunityTrustRecord> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_CONTRIBUTION_RECORD, KIND_APPROVAL_GRANT, KIND_APPROVAL_DENY],
    limit: 300,
  });
  return summarizeCommunityTrustSignals(events);
}

export function useTrustSignals() {
  return useQuery({
    queryKey: trustSignalsQueryKey,
    queryFn: fetchTrustSignals,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useLaunch(
  launchId: string | undefined,
  author: string | undefined,
) {
  const query = useLaunches();
  const launch = useMemo(
    () =>
      launchId === undefined
        ? undefined
        : query.data?.find(
            (l) =>
              l.record.id === launchId &&
              (author === undefined || l.record.author === author),
          ),
    [query.data, launchId, author],
  );
  return { ...query, launch };
}

export function useIsFounder(launch: Launch | undefined): boolean {
  const pubkey = existingUserPubkey();
  return Boolean(launch && pubkey && launch.record.author === pubkey);
}

export async function publishMirror(
  input: {
    kind: number;
    tags: string[][];
    content: Record<string, unknown> | string;
    /** Overrides "now" (user-signed records only), to supersede a record. */
    createdAt?: number;
  },
  auth?: {
    signEvent: (template: {
      kind: number;
      tags: string[][];
      content: string;
    }) => Promise<SignedNostrEvent | null>;
    pubkey: string;
  },
): Promise<NostrEvent> {
  const content =
    typeof input.content === "string"
      ? input.content
      : JSON.stringify(input.content);
  const signed = auth
    ? await auth.signEvent({
        kind: input.kind,
        tags: input.tags,
        content,
      })
    : await signAsUser({
        kind: input.kind,
        tags: input.tags,
        content,
        ...(input.createdAt === undefined
          ? {}
          : { created_at: input.createdAt }),
      });
  if (!signed) throw new Error("signing failed");
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) {
    throw new Error(result.message ?? "Server rejected the event");
  }
  return signed;
}

export interface TokenPlan {
  mode: "mint" | "dao";
  name: string;
  symbol: string;
  supply: string;
}

export interface CreateLaunchInput {
  /** Publish as the browser agent (NIP-OA attested when possible). */
  asAgent?: boolean;
  id: string;
  name: string;
  pitch: string;
  longPitch?: string;
  ipList?: string[];
  updateCadence?: string;
  /** How the team's reviewers will work, in the founder's words (see `LaunchRecord.reviewerTerms`). */
  reviewerTerms?: string;
  /** Cover image URL (optional). */
  image?: string;
  /** A topic; published as a lowercase `t` tag, which Discover browses by. */
  category?: string;
  stage: LaunchStage;
  /**
   * The project's funding stance and who it wants to hear from
   * (`lib/funding.ts`, plan §2). Optional: a record written before this
   * existed simply declares nothing.
   */
  funding?: FundingStatus;
  chainId: string;
  currency: string;
  floorPrice: string;
  tickSpacing: string;
  requiredRaised: string;
  budget?: string;
  auction: string;
  token: string;
  treasury: string;
  /** Tranche enforcer wiring, post-deploy (`distributor`: pre-v3 tag, kept on edits). */
  distributor?: string;
  claimStake?: string;
  verifierSet?: string;
  admission: "curated" | "community";
  channels: string[];
  /** The launch's chat rooms; their ids are published as bound channels too. */
  chat?: LaunchChat;
  tokenPlan?: TokenPlan;
  allocation?: SupplyAllocation;
  vesting?: VestingConfig;
  /**
   * The sale window, derived from the founder's dates at publish time
   * (`lib/time-blocks.ts`). Optional: the legacy form never wrote one, and a
   * chain that could not be read leaves it unset rather than guessed.
   */
  startBlock?: number;
  endBlock?: number;
  claimBlock?: number;
  /** What the project's allocation unlocks against (`lib/unlock-plans.ts`). */
  unlocks?: UnlockPlan;
  /** Whether a DAO is to be formed at graduation. */
  daoAtGraduation?: boolean;
  /** Legal wrapper decision (OAv2 §4.8): "none" | "dao-llc" | "own-entity". */
  legalWrapper?: string;
  /** Who holds the project's IP and the documents that say so. */
  ipRecord?: IpRecord;
  /** The team's revenue pledge (D78). */
  revenuePledge?: RevenuePledge;
  /** The first work areas' words, exactly as hashed, so people can see what finished work looks like. */
  workAreas?: { name: string; check: string }[];
  /** How the founder knows each reviewer, in their words (see `LaunchRecord.reviewerTies`). */
  reviewerTies?: string;
  /** The project this one is built on (N11). */
  builtOn?: BuiltOn;
  /** Whether others may build on this project, and on what terms (N11). */
  remixTerms?: RemixTerms;
}

export function useCreateLaunch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLaunchInput) => {
      const tags: string[][] = [
        ["d", input.id],
        ["name", input.name],
        ["t", "dao-launchpad"],
        ["admission", input.admission],
      ];
      if (input.category?.trim()) {
        tags.push(["t", input.category.trim().toLowerCase()]);
      }
      if (input.chainId) tags.push(["chain", input.chainId]);
      if (input.auction) tags.push(["auction", input.auction]);
      if (input.token) tags.push(["token", input.token]);
      if (input.treasury) tags.push(["treasury", input.treasury]);
      if (input.distributor) tags.push(["distributor", input.distributor]);
      if (input.claimStake) tags.push(["claim-stake", input.claimStake]);
      if (input.verifierSet) tags.push(["verifier-set", input.verifierSet]);
      for (const channel of boundChannelIds(input))
        tags.push(["buzz-channel", channel]);
      // The parent's record, so a parent finds the projects built on it with one query (N11).
      if (input.builtOn)
        tags.push(["a", builtOnCoordinate(input.builtOn), "", "built-on"]);
      const content: Record<string, unknown> = {
        pitch: input.pitch,
        stage: input.stage,
      };
      if (input.funding) content.funding = fundingContent(input.funding);
      if (input.longPitch) content.longPitch = input.longPitch;
      if (input.ipList && input.ipList.length > 0)
        content.ipList = input.ipList;
      if (input.updateCadence) content.updateCadence = input.updateCadence;
      if (input.reviewerTerms) content.reviewerTerms = input.reviewerTerms;
      if (input.image) content.image = input.image;
      if (input.chat && (hasChat(input.chat) || input.chat.board)) {
        // Only the rooms that exist: a null would read as a promise.
        content.chat = Object.fromEntries(
          Object.entries(input.chat).filter(([, id]) => id !== null),
        );
      }
      if (input.currency) content.currency = input.currency;
      if (input.floorPrice) content.floorPrice = input.floorPrice;
      if (input.tickSpacing) content.tickSpacing = input.tickSpacing;
      if (input.requiredRaised) content.requiredRaised = input.requiredRaised;
      if (input.budget) content.budget = input.budget;
      if (input.tokenPlan) content.tokenPlan = input.tokenPlan;
      if (input.allocation) content.allocation = input.allocation;
      if (input.vesting) content.vesting = input.vesting;
      if (input.startBlock !== undefined) content.startBlock = input.startBlock;
      if (input.endBlock !== undefined) content.endBlock = input.endBlock;
      if (input.claimBlock !== undefined) content.claimBlock = input.claimBlock;
      if (input.unlocks) content.unlocks = input.unlocks;
      if (input.daoAtGraduation !== undefined)
        content.daoAtGraduation = input.daoAtGraduation;
      if (input.legalWrapper) content.legalWrapper = input.legalWrapper;
      if (input.ipRecord) content.ipRecord = ipRecordContent(input.ipRecord);
      if (input.revenuePledge)
        content.revenuePledge = revenuePledgeContent(input.revenuePledge);
      if (input.workAreas && input.workAreas.length > 0)
        content.workAreas = input.workAreas.map((area) => ({
          name: area.name,
          check: area.check,
        }));
      if (input.reviewerTies) content.reviewerTies = input.reviewerTies;
      if (input.builtOn) content.builtOn = input.builtOn;
      if (input.remixTerms) content.remixTerms = input.remixTerms;
      if (input.asAgent) {
        return publishMirror(
          { kind: KIND_LAUNCH_RECORD, tags, content },
          {
            signEvent: (t) =>
              signLaunchpadEventAsAgent(t, {
                conditions: `kind=${KIND_LAUNCH_RECORD}`,
              }),
            pubkey: getAgentPubkey(),
          },
        );
      }
      // A record replaces the one with the same id only if it is newer. Two
      // saves in the same second (a link, then a click) would tie, and the
      // relay may keep the older one, silently dropping the later save.
      const me = existingUserPubkey();
      const current = queryClient
        .getQueryData<Launch[]>(launchesQueryKey)
        ?.find(
          (launch) =>
            launch.record.id === input.id && launch.record.author === me,
        );
      return publishMirror({
        kind: KIND_LAUNCH_RECORD,
        tags,
        content,
        createdAt: supersedingTime(
          Math.floor(Date.now() / 1000),
          current?.record.createdAt,
        ),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: launchesQueryKey });
    },
  });
}

export function usePublishMirror() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      kind:
        | typeof KIND_LAUNCH_BID
        | typeof KIND_LAUNCH_UPDATE
        | typeof KIND_LAUNCH_PROPOSAL
        | typeof KIND_LAUNCH_RECEIPT;
      author: string;
      launchId: string;
      bucket?: string;
      extraTags?: string[][];
      asAgent?: boolean;
      content: Record<string, unknown>;
    }) => {
      const tags: string[][] = [
        ["a", launchCoordinate(input.author, input.launchId)],
      ];
      if (input.kind === KIND_LAUNCH_BID && input.bucket) {
        tags.push(["m", input.bucket]);
      }
      if (input.extraTags) tags.push(...input.extraTags);
      if (input.asAgent) {
        return publishMirror(
          { kind: input.kind, tags, content: input.content },
          {
            signEvent: (t) =>
              signLaunchpadEventAsAgent(t, {
                conditions: `kind=${input.kind}`,
              }),
            pubkey: getAgentPubkey(),
          },
        );
      }
      return publishMirror({ kind: input.kind, tags, content: input.content });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: launchesQueryKey });
      void queryClient.invalidateQueries({ queryKey: evidenceQueryKey });
    },
  });
}

export function useDeleteLaunch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (launch: Launch) =>
      publishMirror({
        kind: 5,
        // NIP-09's `k` names the kind removed. The list is not read by it (removals made before it existed lack it).
        tags: [
          ["a", launchCoordinate(launch.record.author, launch.record.id)],
          ["k", String(KIND_LAUNCH_RECORD)],
        ],
        content: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: launchesQueryKey });
    },
  });
}
