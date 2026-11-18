/**
 * Reading project numbers and acting on them. Every read here is off unless the server turns investing on: with it off
 * no record of numbers is even asked for (a smoke test holds that).
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { chainKeyFromTags } from "@creaton/core/launchpad/project-chain.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { read } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import type { Project } from "../project/project-record";
import { type MoneyCall, QUOTE_CALL_DATA } from "./calls";
import {
  type NumbersEvent,
  type ProjectNumbers,
  parseNumbers,
  type RemovedNumbers,
} from "./numbers";
import { addressFromWord, injectedWallet, type MoneyWallet } from "./wallet";

const moneyKeys = {
  all: ["money"] as const,
  project: (key: string) => ["money", "numbers", key] as const,
  recent: ["money", "recent"] as const,
  address: ["money", "address"] as const,
  quote: (rounds: string) => ["money", "quote", rounds] as const,
};

/** Newest first, ties broken by id. */
function newest<T extends { created_at: number; id: string }>(events: T[]) {
  return [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
  );
}

/** The chain key a project's record names, or null. */
export function chainKeyOfProject(project: Project): string | null {
  return chainKeyFromTags(project.event.tags);
}

/**
 * A project's numbers: the newest record the server signed for the chain key the founder's record names, believed only
 * when it is that project's launch. Null when investing is off, the project names no launch, or nothing was read.
 */
export function useProjectNumbers(project: Project | null | undefined) {
  const chainKey = project ? chainKeyOfProject(project) : null;
  const signer = serverRelaySigner();
  const on = investingOn() && Boolean(project && chainKey && signer);
  return useQuery({
    queryKey: moneyKeys.project(chainKey ?? ""),
    enabled: on,
    staleTime: 20_000,
    queryFn: async (): Promise<ProjectNumbers | RemovedNumbers | null> => {
      if (!project || !chainKey) return null;
      const events = await read({
        kinds: [KIND_PROJECT_NUMBERS],
        "#d": [chainKey],
        limit: 5,
      });
      for (const event of newest(events)) {
        const numbers = parseNumbers(event as NumbersEvent, signer, {
          coordinate: project.coordinate,
          chainKey,
        });
        if (numbers) return numbers;
      }
      return null;
    },
  });
}

/** How many recent records of numbers Home and You read. */
const RECENT_NUMBERS = 100;

/** The server's recent records of numbers, newest per chain key (still to be matched to a project before use). */
export function useRecentNumbers(enabled = true) {
  const signer = serverRelaySigner();
  return useQuery({
    queryKey: moneyKeys.recent,
    enabled: enabled && investingOn() && Boolean(signer),
    staleTime: 30_000,
    queryFn: async (): Promise<NumbersEvent[]> => {
      if (!signer) return [];
      const events = await read({
        kinds: [KIND_PROJECT_NUMBERS],
        authors: [signer],
        limit: RECENT_NUMBERS,
      });
      const byKey = new Map<string, NumbersEvent>();
      for (const event of newest(events)) {
        const d = event.tags.find((t) => t[0] === "d")?.[1]?.toLowerCase();
        if (d && !byKey.has(d)) byKey.set(d, event as NumbersEvent);
      }
      return [...byKey.values()];
    },
  });
}

/** Each project with numbers that belong to it, from a list of projects and the recent records. */
export function matchNumbers(
  projects: readonly Project[],
  events: readonly NumbersEvent[],
): { project: Project; numbers: ProjectNumbers }[] {
  const signer = serverRelaySigner();
  const byKey = new Map<string, NumbersEvent>();
  for (const event of events) {
    const d = event.tags.find((t) => t[0] === "d")?.[1]?.toLowerCase();
    if (d) byKey.set(d, event);
  }
  const out: { project: Project; numbers: ProjectNumbers }[] = [];
  for (const project of projects) {
    const chainKey = chainKeyOfProject(project);
    const event = chainKey ? byKey.get(chainKey) : undefined;
    if (!event) continue;
    const numbers = parseNumbers(event, signer, {
      coordinate: project.coordinate,
      chainKey,
    });
    if (numbers && !numbers.removed) out.push({ project, numbers });
  }
  return out;
}

/** The wallet in this browser (one per page). */
export function useWallet(): MoneyWallet {
  return useMemo(() => injectedWallet(), []);
}

/** The wallet account this site may already see (no prompt), or null. Off with investing off. */
export function useWalletAddress() {
  const wallet = useWallet();
  return useQuery({
    queryKey: moneyKeys.address,
    enabled: investingOn() && wallet.isAvailable(),
    staleTime: 60_000,
    queryFn: () => wallet.connectedAddress(),
  });
}

/** Ask the wallet to share an account with this site. */
export function useConnectWallet() {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => wallet.getAddress(),
    onSuccess: (address) =>
      queryClient.setQueryData(moneyKeys.address, address),
  });
}

/** The dollar token a project's rounds take, read from the Rounds contract (the record does not carry it). */
export async function readQuote(
  wallet: MoneyWallet,
  rounds: string,
): Promise<string> {
  const quote = addressFromWord(await wallet.readCall(rounds, QUOTE_CALL_DATA));
  if (!quote) throw new Error("The dollar token could not be read.");
  return quote;
}

/**
 * Send money calls through the wallet, then read the numbers again (the server signs new ones once the chain moved).
 * `build` runs at press time so it can read what it needs (the dollar token) from the chain first.
 */
export function useMoneySend() {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      chainId: number;
      build: (wallet: MoneyWallet) => Promise<MoneyCall[]> | MoneyCall[];
    }) => wallet.sendCalls(await input.build(wallet), input.chainId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: moneyKeys.all }),
  });
}
