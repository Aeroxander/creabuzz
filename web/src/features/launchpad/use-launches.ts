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
import { launchQueryFilter } from "./lib/launch-query";
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
import {
  buildLaunches,
  launchCoordinate,
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
): Promise<{ coordinates: Set<string>; deletedIds: Set<string> }> {
  const out = { coordinates: new Set<string>(), deletedIds: new Set<string>() };
  for (let i = 0; i < coords.length; i += 100) {
    const group = coords.slice(i, i + 100);
    if (group.length === 0) continue;
    const events = await queryEvents(relayWsUrl(), {
      kinds: [5],
      "#a": group,
      limit: 200,
    });
    for (const event of events) {
      for (const tag of event.tags) {
        if (tag[0] === "a" && tag[1]) out.coordinates.add(tag[1]);
      }
    }
  }
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
      : { coordinates: new Set<string>(), deletedIds: new Set<string>() };
  return buildLaunches(events, tombstones.coordinates, tombstones.deletedIds);
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
 * The community's latest trustgraph score roots (kind 37006).
 *
 * An operator publishes the proven Merkle root per epoch; clients verify
 * individual score claims against it (`lib/trust-score.ts`). Fetching them is
 * a plain Nostr query — no trustgraphs deployment required for the read side.
 */
export async function fetchScoreRoots(): Promise<ScoreRoot[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [LAUNCHPAD_SCORE_ROOT_KIND],
    limit: 50,
  });
  return events.map(parseScoreRoot).filter((r): r is ScoreRoot => r !== null);
}

export function useScoreRoots() {
  return useQuery({
    queryKey: scoreRootsQueryKey,
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
      });
  if (!signed) throw new Error("signing failed");
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) {
    throw new Error(result.message ?? "relay rejected the event");
  }
  return signed;
}

export interface TokenPlan {
  mode: "mint";
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
  /** Cover image URL (optional). */
  image?: string;
  /** A topic; published as a lowercase `t` tag, which Discover browses by. */
  category?: string;
  stage: LaunchStage;
  chainId: string;
  currency: string;
  floorPrice: string;
  tickSpacing: string;
  requiredRaised: string;
  budget?: string;
  auction: string;
  token: string;
  treasury: string;
  /** Tranche/royalty enforcer wiring (token-lifecycle-design.md), post-deploy. */
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
}

/** Every channel the record binds: the picked ones plus the chat rooms, once each. */
export function boundChannelIds(
  input: Pick<CreateLaunchInput, "channels" | "chat">,
): string[] {
  const ids = [...input.channels];
  if (input.chat?.team) ids.push(input.chat.team);
  if (input.chat?.supporters) ids.push(input.chat.supporters);
  return [...new Set(ids)];
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
      const content: Record<string, unknown> = {
        pitch: input.pitch,
        stage: input.stage,
      };
      if (input.longPitch) content.longPitch = input.longPitch;
      if (input.ipList && input.ipList.length > 0)
        content.ipList = input.ipList;
      if (input.updateCadence) content.updateCadence = input.updateCadence;
      if (input.image) content.image = input.image;
      if (input.chat && (input.chat.team || input.chat.supporters)) {
        content.chat = input.chat;
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
      return publishMirror({ kind: KIND_LAUNCH_RECORD, tags, content });
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
    },
  });
}

export function useDeleteLaunch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (launch: Launch) =>
      publishMirror({
        kind: 5,
        tags: [["a", launchCoordinate(launch.record.author, launch.record.id)]],
        content: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: launchesQueryKey });
    },
  });
}
