/**
 * Reading project numbers and acting on them. Every read here is off unless the server turns investing on: with it off
 * no record of numbers is even asked for (a smoke test holds that).
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { chainKeyFromTags } from "@creaton/core/launchpad/project-chain.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
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
import { forgetPending, pendingSend, rememberPending } from "./pending-sends";
import {
  addressFromWord,
  injectedWallet,
  type MoneyWallet,
  WalletStepError,
} from "./wallet";

const moneyKeys = {
  all: ["money"] as const,
  // The coordinate is part of the key: two records naming one chain key are checked each on its own, never shared.
  project: (key: string, coordinate: string) =>
    ["money", "numbers", key, coordinate] as const,
  recent: (pages: number) => ["money", "recent", pages] as const,
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
    queryKey: moneyKeys.project(chainKey ?? "", project?.coordinate ?? ""),
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

/** How many records of numbers one read asks for. */
const NUMBERS_PAGE = 100;

/** The server's newest records of numbers, `newestRecords` read at a time. */
export interface RecentNumbers {
  /** Newest per chain key (still to be matched to a project before use). */
  events: NumbersEvent[];
  /** False when older records were left unread: then "none" is never said about what was not found. */
  complete: boolean;
}

/**
 * The server's recent records of numbers, up to `pages` reads of 100 (Home needs only the newest; You reads further back
 * so a quiet project's receipts still show). Bounded: what lies past the last page is reported as not read.
 */
export function useRecentNumbers(enabled = true, pages = 1) {
  const signer = serverRelaySigner();
  return useQuery({
    queryKey: moneyKeys.recent(pages),
    enabled: enabled && investingOn() && Boolean(signer),
    staleTime: 30_000,
    queryFn: async (): Promise<RecentNumbers> => {
      if (!signer) return { events: [], complete: true };
      const seen = new Map<string, NumbersEvent>();
      let until: number | undefined;
      let complete = false;
      for (let page = 0; page < pages; page += 1) {
        const events = (await read({
          kinds: [KIND_PROJECT_NUMBERS],
          authors: [signer],
          limit: NUMBERS_PAGE,
          ...(until === undefined ? {} : { until }),
        })) as NumbersEvent[];
        let added = 0;
        for (const event of events)
          if (!seen.has(event.id)) {
            seen.set(event.id, event);
            added += 1;
          }
        if (events.length < NUMBERS_PAGE) {
          complete = true;
          break;
        }
        // Older than the oldest so far; `until` is inclusive, so records sharing that second are read again and skipped.
        if (added === 0) break;
        until = Math.min(...events.map((e) => e.created_at));
      }
      const byKey = new Map<string, NumbersEvent>();
      for (const event of newest([...seen.values()])) {
        const d = event.tags.find((t) => t[0] === "d")?.[1]?.toLowerCase();
        if (d && !byKey.has(d)) byKey.set(d, event);
      }
      return { events: [...byKey.values()], complete };
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

export interface MoneySendInput {
  chainId: number;
  /** The calls, built at press time (after the wallet is on the right network) so it can read what it needs first. */
  build: (wallet: MoneyWallet) => Promise<MoneyCall[]> | MoneyCall[];
}

type SendResult = { txHash: string; status: "confirmed" };

/**
 * Send money calls through the wallet, then read the numbers again (the server signs new ones once the chain moved).
 *
 * `action` names the step ("back:<rounds>:<round>"): one step runs at a time, and a step whose call went out but has
 * not landed is remembered under it. Pressing again then looks that call up instead of sending a second one, and only
 * a call the network says reverted or never saw lets the step be sent afresh.
 */
export function useMoneySend(action: string) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const running = useRef(false);
  const mutation = useMutation({
    mutationFn: async (input: MoneySendInput): Promise<SendResult> => {
      try {
        return await sendStep(wallet, action, input);
      } finally {
        running.current = false;
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: moneyKeys.all }),
  });
  const { mutate, mutateAsync } = mutation;
  /** Send, unless this step is already running (a second press before the button shows it is busy does nothing). */
  const send = useCallback(
    (
      input: MoneySendInput,
      options?: {
        onSuccess?: (result: SendResult) => void;
        onError?: (error: unknown) => void;
      },
    ) => {
      if (running.current) return;
      running.current = true;
      mutate(input, options);
    },
    [mutate],
  );
  /** `send` as a promise; a press while the step runs is refused. */
  const sendAsync = useCallback(
    (input: MoneySendInput): Promise<SendResult> => {
      if (running.current)
        return Promise.reject(new Error("This step is already running."));
      running.current = true;
      return mutateAsync(input);
    },
    [mutateAsync],
  );
  return {
    send,
    sendAsync,
    isPending: mutation.isPending,
    /** A call of this step went out earlier and has not landed: the next press looks it up (read on every render). */
    waiting: pendingSend(action) !== null,
  };
}

async function sendStep(
  wallet: MoneyWallet,
  action: string,
  input: MoneySendInput,
): Promise<SendResult> {
  let skip = 0;
  const earlier = pendingSend(action);
  if (earlier) {
    await wallet.ensureChain(earlier.chainId);
    let outcome: Awaited<ReturnType<MoneyWallet["outcomeOf"]>>;
    try {
      outcome = await wallet.outcomeOf(earlier.hash);
    } catch (error) {
      throw new WalletStepError("pending", earlier.index, error, earlier.hash);
    }
    if (outcome === "waiting")
      throw new WalletStepError(
        "pending",
        earlier.index,
        undefined,
        earlier.hash,
      );
    forgetPending(action);
    if (outcome === "landed") {
      if (earlier.index + 1 >= earlier.total)
        return { txHash: earlier.hash, status: "confirmed" };
      skip = earlier.index + 1; // the calls up to it landed; send the rest
    }
  }
  // On the project's network before anything is read for the calls: a read on another network answers nothing.
  await wallet.ensureChain(input.chainId);
  const calls = await input.build(wallet);
  try {
    return await wallet.sendCalls(calls.slice(skip), input.chainId);
  } catch (error) {
    if (!(error instanceof WalletStepError) || skip === 0) {
      if (error instanceof WalletStepError && error.reason === "pending")
        remember(action, error, input.chainId, calls.length);
      throw error;
    }
    const shifted = new WalletStepError(
      error.reason,
      error.landed + skip,
      error.cause,
      error.hash,
    );
    if (shifted.reason === "pending")
      remember(action, shifted, input.chainId, calls.length);
    throw shifted;
  }
}

function remember(
  action: string,
  error: WalletStepError,
  chainId: number,
  total: number,
) {
  if (!error.hash) return;
  rememberPending(action, {
    hash: error.hash,
    index: error.landed,
    total,
    chainId,
    at: Math.floor(Date.now() / 1000),
  });
}
