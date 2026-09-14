import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { getAgentPubkey } from "@/shared/lib/agent-identity";
import { signAsUser, existingUserPubkey } from "@/shared/lib/identity";
import { signLaunchpadEventAsAgent } from "./lib/agent-launchpad";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { SupplyAllocation } from "./lib/allocation";
import type { VestingConfig } from "./models";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  KIND_LAUNCH_BID,
  type KIND_LAUNCH_PROPOSAL,
  type KIND_LAUNCH_RECEIPT,
  KIND_LAUNCH_RECORD,
  KIND_SCORE_ROOT as LAUNCHPAD_SCORE_ROOT_KIND,
  type KIND_LAUNCH_UPDATE,
  LAUNCHPAD_EVENT_KINDS,
} from "@/shared/constants/kinds";
import {
  buildLaunches,
  launchCoordinate,
  parseScoreRoot,
  type Launch,
  type LaunchStage,
  type ScoreRoot,
} from "./models";

export const launchesQueryKey = ["launchpad", "launches"];

async function fetchTombstones(coords: string[]): Promise<Set<string>> {
  const out = new Set<string>();
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
        if (tag[0] === "a" && tag[1]) out.add(tag[1]);
      }
    }
  }
  return out;
}

export async function fetchLaunches(): Promise<Launch[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [...LAUNCHPAD_EVENT_KINDS],
    limit: 500,
  });
  const coords = events
    .filter((e) => e.kind === KIND_LAUNCH_RECORD)
    .map((e) => {
      const d = e.tags.find((t) => t[0] === "d")?.[1];
      return d ? launchCoordinate(e.pubkey, d) : null;
    })
    .filter((c): c is string => c !== null);
  const tombstoned =
    coords.length > 0 ? await fetchTombstones(coords) : new Set<string>();
  return buildLaunches(events, tombstoned);
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

async function publishMirror(
  input: {
    kind: number;
    tags: string[][];
    content: Record<string, unknown>;
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
  const signed = auth
    ? await auth.signEvent({
        kind: input.kind,
        tags: input.tags,
        content: JSON.stringify(input.content),
      })
    : await signAsUser({
        kind: input.kind,
        tags: input.tags,
        content: JSON.stringify(input.content),
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
  admission: "curated" | "community";
  channels: string[];
  tokenPlan?: TokenPlan;
  allocation?: SupplyAllocation;
  vesting?: VestingConfig;
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
      if (input.chainId) tags.push(["chain", input.chainId]);
      if (input.auction) tags.push(["auction", input.auction]);
      if (input.token) tags.push(["token", input.token]);
      if (input.treasury) tags.push(["treasury", input.treasury]);
      for (const channel of input.channels)
        tags.push(["buzz-channel", channel]);
      const content: Record<string, unknown> = {
        pitch: input.pitch,
        stage: input.stage,
      };
      if (input.longPitch) content.longPitch = input.longPitch;
      if (input.ipList && input.ipList.length > 0)
        content.ipList = input.ipList;
      if (input.updateCadence) content.updateCadence = input.updateCadence;
      if (input.currency) content.currency = input.currency;
      if (input.floorPrice) content.floorPrice = input.floorPrice;
      if (input.tickSpacing) content.tickSpacing = input.tickSpacing;
      if (input.requiredRaised) content.requiredRaised = input.requiredRaised;
      if (input.budget) content.budget = input.budget;
      if (input.tokenPlan) content.tokenPlan = input.tokenPlan;
      if (input.allocation) content.allocation = input.allocation;
      if (input.vesting) content.vesting = input.vesting;
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
