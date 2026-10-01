/**
 * The portfolio's reads: your bids across raises (from the chain), your
 * standing in the community's accepted work (from the server), and the
 * launches you follow. The math lives in `lib/portfolio.ts`.
 *
 * Every read is bounded, and a read that fails is reported as such — a raise
 * whose bids could not be read is never shown as "no bids" (Review-Proven
 * Rule 1).
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { orgGraphFromEvents } from "@/features/feed/lib/trust-weight";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { isAuthorityHolder } from "@/features/fleet/lib/orgAuthority";
import { getRpcEndpoint } from "@/features/launchpad/chain";
import { findOwnedBidIds, readBidView } from "@/features/launchpad/lib/my-bids";
import { SANDBOX_ID } from "@/features/launchpad/lib/sandbox";
import { launchCoordinate, type Launch } from "@/features/launchpad/models";
import { useSenderPicker } from "@/features/launchpad/ui/SenderPicker";
import { useConnectedWallet } from "@/features/launchpad/use-connected-wallet";
import { useLaunches } from "@/features/launchpad/use-launches";
import {
  KIND_CONTRIBUTION_RECORD,
  KIND_ORG_GRANT,
  KIND_ORG_NODE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type BackingSummary,
  type BidLike,
  summarizeBids,
  type WorkStanding,
  workStanding,
} from "./lib/portfolio";

/** Raises checked for your bids, newest first: bounds the chain reads. */
export const MAX_RAISES_CHECKED = 25;
/** Bids read per wallet per raise; more than this marks the raise partial. */
export const MAX_BIDS_PER_OWNER = 200;
/** Raises read at once, so a big list does not flood the chain endpoint. */
const RAISE_BATCH = 5;
const ORG_LIMIT = 1000;
const CONTRIBUTION_LIMIT = 2000;

export interface BackedRaise {
  launch: Launch;
  summary: BackingSummary;
  /** Some bids were left out by {@link MAX_BIDS_PER_OWNER}. */
  partial: boolean;
}

export interface Backing {
  raises: BackedRaise[];
  /** Raises whose bids could not be read — unknown, not empty. */
  failed: Launch[];
  /** Raises left unchecked because of {@link MAX_RAISES_CHECKED}. */
  unchecked: number;
}

async function bidsIn(
  endpoint: string,
  auction: string,
  owner: string,
): Promise<{ bids: BidLike[]; partial: boolean }> {
  const ids = await findOwnedBidIds(endpoint, auction, owner);
  const bids = await Promise.all(
    ids
      .slice(0, MAX_BIDS_PER_OWNER)
      .map((id) => readBidView(endpoint, auction, id)),
  );
  return { bids, partial: ids.length > MAX_BIDS_PER_OWNER };
}

async function readBacking(
  launches: readonly Launch[],
  owners: readonly string[],
  endpoint: string,
): Promise<Backing> {
  const live = launches
    .filter((l) => l.record.auction && l.record.id !== SANDBOX_ID)
    .sort((a, b) => b.record.createdAt - a.record.createdAt);
  const checked = live.slice(0, MAX_RAISES_CHECKED);
  const raises: BackedRaise[] = [];
  const failed: Launch[] = [];
  for (let i = 0; i < checked.length; i += RAISE_BATCH) {
    const batch = checked.slice(i, i + RAISE_BATCH);
    const results = await Promise.all(
      batch.map(async (launch) => {
        const auction = launch.record.auction as string;
        try {
          const perOwner = await Promise.all(
            owners.map((owner) => bidsIn(endpoint, auction, owner)),
          );
          return {
            launch,
            bids: perOwner.flatMap((o) => o.bids),
            partial: perOwner.some((o) => o.partial),
          };
        } catch {
          return { launch, bids: null, partial: false };
        }
      }),
    );
    for (const { launch, bids, partial } of results) {
      if (bids === null) failed.push(launch);
      else if (bids.length > 0) {
        raises.push({ launch, summary: summarizeBids(bids), partial });
      }
    }
  }
  return { raises, failed, unchecked: live.length - checked.length };
}

/** The wallets your bids could be in: a connected wallet and your passkey account. */
function useBidOwners(walletAddress: string | null) {
  const { sponsoredSender, sponsoredStatus } = useSenderPicker();
  const passkey = useQuery({
    // Keyed by identity: the passkey account belongs to whoever is signed in.
    queryKey: ["portfolio", "passkey-account", existingUserPubkey()],
    queryFn: () => sponsoredSender.getAddress(),
    enabled: sponsoredStatus.available,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const owners = useMemo(() => {
    const all = new Set<string>();
    if (walletAddress) all.add(walletAddress.toLowerCase());
    if (passkey.data) all.add(passkey.data.toLowerCase());
    return [...all].sort();
  }, [walletAddress, passkey.data]);
  return {
    owners,
    ready: !sponsoredStatus.available || !passkey.isLoading,
    /** The passkey account exists but its address could not be worked out. */
    passkeyFailed: passkey.isError,
    retryPasskey: passkey.refetch,
  };
}

export function useBacking() {
  const launches = useLaunches();
  const wallet = useConnectedWallet();
  const { owners, ready, passkeyFailed, retryPasskey } = useBidOwners(
    wallet.address,
  );
  const endpoint = getRpcEndpoint();
  const query = useQuery({
    queryKey: [
      "portfolio",
      "backing",
      endpoint,
      owners.join(","),
      (launches.data ?? []).map((l) => l.record.eventId).join(","),
    ],
    queryFn: () => readBacking(launches.data ?? [], owners, endpoint),
    enabled: ready && owners.length > 0 && launches.isSuccess,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { refetch: refetchLaunches } = launches;
  const { refetch: refetchBacking } = query;
  return {
    owners,
    /** True while we still work out which wallets to look in. */
    findingWallets: !ready,
    passkeyFailed,
    wallet,
    /** Undefined until read; with no error, that means still on its way. */
    data: query.data,
    error: launches.error ?? query.error,
    /** Retry whichever read failed: the launch list, the passkey, or the bids. */
    retry: () => {
      if (launches.isError) void refetchLaunches();
      else if (passkeyFailed) void retryPasskey();
      else void refetchBacking();
    },
  };
}

/** Your standing among the accepted work on this server. */
export function useWorkStanding() {
  const me = existingUserPubkey();
  return useQuery<WorkStanding & { partial: boolean }>({
    queryKey: ["portfolio", "work", me],
    enabled: me !== null,
    queryFn: async () => {
      const [org, records] = await Promise.all([
        queryEvents(relayWsUrl(), {
          kinds: [KIND_ORG_NODE, KIND_ORG_GRANT],
          limit: ORG_LIMIT,
        }),
        queryEvents(relayWsUrl(), {
          kinds: [KIND_CONTRIBUTION_RECORD],
          limit: CONTRIBUTION_LIMIT,
        }),
      ]);
      const graph = orgGraphFromEvents(org);
      const standing = workStanding(
        records,
        (pubkey) => isAuthorityHolder(graph, pubkey),
        me as string,
        Math.floor(Date.now() / 1000),
      );
      return {
        ...standing,
        // At the limit, older records may be missing from the totals.
        partial:
          records.length >= CONTRIBUTION_LIMIT || org.length >= ORG_LIMIT,
      };
    },
    staleTime: 120_000,
  });
}

/** The launches you follow, newest first. */
export function useFollowedLaunches() {
  const launches = useLaunches();
  const follows = useLaunchFollows();
  const followed = useMemo(
    () =>
      (launches.data ?? [])
        .filter((l) =>
          follows.followed.has(launchCoordinate(l.record.author, l.record.id)),
        )
        .sort((a, b) => b.record.createdAt - a.record.createdAt),
    [launches.data, follows.followed],
  );
  return {
    followed,
    loading: launches.isLoading || !follows.ready,
    error: launches.error,
  };
}
