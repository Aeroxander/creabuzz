import { useQuery } from "@tanstack/react-query";

import {
  ethBlockNumber,
  ethBlockTimestamps,
  ethCall,
  ethGetLogs,
  getRpcEndpoint,
} from "./chain";
import {
  findUnlockOffers,
  readMilestoneLock,
  type MilestoneLockView,
  type UnlockOffer,
} from "./lib/milestone-lock";
import { readHolders } from "./lib/holders-read";
import { readRecordEvents, type RecordChain } from "./lib/record-read";
import { readWork, type WorkChain, type WorkSnapshot } from "./lib/work-read";

/** The configured RPC endpoint as the reader's chain: whole-history log reads for one address and topic filter. */
export function endpointChain(endpoint: string): WorkChain {
  return {
    now: async () => {
      const head = Number(await ethBlockNumber(endpoint));
      const [sample] = await ethBlockTimestamps(endpoint, [head]);
      if (!sample) throw new Error("the chain did not report its latest block");
      return sample.timestampSeconds;
    },
    call: (to, data) => ethCall(endpoint, to, data),
    logs: (filter) =>
      ethGetLogs(endpoint, {
        address: filter.address,
        topics: [...filter.topics],
        fromBlock: "0x0",
        toBlock: "latest",
      }),
  };
}

/** The DAO's largest Shares holders, with how long they have held and what is still locked, read without a wallet. */
export function useDaoHolders(dao: string | null) {
  return useQuery({
    queryKey: ["launchpad", "holders", dao],
    enabled: dao !== null,
    queryFn: () => readHolders(endpointChain(getRpcEndpoint()), dao as string),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** A DAO's contributor work (mandates, projects, claims), read from the launch's configured RPC. */
export function useWork(dao: string | null, wallet: string | null) {
  return useQuery({
    queryKey: ["launchpad", "work", dao, wallet],
    enabled: dao !== null,
    queryFn: () =>
      readWork(endpointChain(getRpcEndpoint()), dao as string, wallet),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export interface MilestoneLockState {
  view: MilestoneLockView;
  /** For each milestone still locked, the claim that would unlock it right now, if there is one. */
  offers: UnlockOffer[];
}

/**
 * The connected wallet's locked team Shares and the claims that can unlock them, or null when it has none. It is
 * keyed under the work query so a step that re-reads the work re-reads this too.
 */
export function useMilestoneLock(
  dao: string | null,
  wallet: string | null,
  work: WorkSnapshot | undefined,
) {
  return useQuery({
    queryKey: ["launchpad", "work", dao, "lock", wallet, work?.chainTime ?? 0],
    enabled: dao !== null && wallet !== null && work !== undefined,
    queryFn: async (): Promise<MilestoneLockState | null> => {
      const chain = endpointChain(getRpcEndpoint());
      const view = await readMilestoneLock(
        chain,
        dao as string,
        wallet as string,
      );
      if (!view || view.tranches.length === 0) return null;
      const offers = await findUnlockOffers(chain, view, work as WorkSnapshot);
      return { view, offers };
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** The record's chain: the work reader's, plus the time of any block (a record without dates would be half a record). */
function recordChain(endpoint: string): RecordChain {
  return {
    ...endpointChain(endpoint),
    blockTimes: async (blocks) =>
      new Map(
        (await ethBlockTimestamps(endpoint, blocks)).map((s) => [
          s.block,
          s.timestampSeconds,
        ]),
      ),
  };
}

/**
 * What the track record adds to the work and decision reads: when claims were filed and paid, who reviewed them, and
 * the team's milestones. Read without a wallet: the record is the same for everyone.
 */
export function useRecordEvents(
  dao: string | null,
  work: WorkSnapshot | undefined,
) {
  return useQuery({
    queryKey: ["launchpad", "work", dao, "record", work?.chainTime ?? 0],
    enabled: dao !== null && work !== undefined,
    queryFn: () =>
      readRecordEvents(recordChain(getRpcEndpoint()), work as WorkSnapshot),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
