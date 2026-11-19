/**
 * Reading project numbers and acting on them. Every read here is off unless the server turns investing on: with it off
 * no record of numbers is even asked for (a smoke test holds that).
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { chainKeyFromTags } from "@creaton/core/launchpad/project-chain.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { read } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import type { Project } from "../project/project-record";
import { type MoneyCall, positionCallData, QUOTE_CALL_DATA } from "./calls";
import {
  type NumbersEvent,
  type ProjectNumbers,
  parseNumbers,
  type RemovedNumbers,
} from "./numbers";
import {
  forgetPending,
  type PendingSend,
  pendingSend,
  rememberPending,
  sendKey,
} from "./pending-sends";
import { rememberSendTargets } from "./send-targets";
import { useSender } from "./sender";
import { addressFromWord, type MoneyWallet, WalletStepError } from "./wallet";

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
        if (numbers) {
          // The contracts a passkey send may go to: the ones this project's numbers name.
          if (!numbers.removed)
            rememberSendTargets(Object.values(numbers.contracts));
          return numbers;
        }
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

/** What sends this person's steps: the wallet in this browser, or their passkey account (`sender.ts` picks). */
export function useWallet(): MoneyWallet {
  return useSender();
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

/**
 * Whether the wallet is on the network a project lives on: true, false, or undefined while unknown. A wallet on another
 * network answers every read about the project with that network's blocks and nothing, so project reads wait for true.
 */
export function useWalletOnChain(chainId: number | undefined) {
  const wallet = useWallet();
  return useQuery({
    queryKey: ["money", "wallet-chain", chainId ?? 0],
    enabled: investingOn() && wallet.isAvailable() && chainId !== undefined,
    staleTime: 5_000,
    queryFn: async () => (await wallet.chainId()) === chainId,
  }).data;
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
  // A passkey send may go to the dollar token the project's rounds take.
  rememberSendTargets([quote]);
  return quote;
}

/** Dollars `backer` has asked for in round `round` so far (`Rounds.positionOf(round, backer).ask`). */
export async function readAsked(
  wallet: MoneyWallet,
  rounds: string,
  round: number,
  backer: string,
): Promise<bigint> {
  const word = (
    await wallet.readCall(rounds, positionCallData(round, backer))
  ).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}/.test(word))
    throw new Error("The backing could not be read.");
  return BigInt(`0x${word.slice(0, 64)}`);
}

export interface MoneySendInput {
  chainId: number;
  /** The calls, built at press time (after the wallet is on the right network) so it can read what it needs first. */
  build: (wallet: MoneyWallet) => Promise<MoneyCall[]> | MoneyCall[];
  /** What this press is for when the action alone does not say (a Back's amount), kept with a call still waiting. */
  detail?: string;
  /**
   * Whether the step's last call took effect after all, read from the contract. Asked when that call's hash is gone
   * but its nonce was used (the wallet sped it up or cancelled it): true sends nothing again. Without it such a step
   * is never sent again on a guess; the person is told to look in the wallet.
   */
  confirm?: (
    wallet: MoneyWallet,
    from: string,
    earlier: PendingSend,
  ) => Promise<boolean>;
}

type SendResult = {
  txHash: string;
  status: "confirmed";
  /** The `detail` of what landed: an earlier press's, when it was that press's call that was found. */
  detail?: string;
};

/**
 * Send money calls through the wallet, then read the numbers again (the server signs new ones once the chain moved).
 *
 * `action` names the step ("back:<rounds>:<round>"): one step runs at a time, and a step whose call went out but has
 * not landed is remembered under it and the sending account. Pressing again then looks that call up instead of sending
 * a second one, and only a call the network says reverted or never saw (nor any other call in its place) lets the step
 * be sent afresh.
 */
export function useMoneySend(action: string) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const address = useWalletAddress().data ?? null;
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
    /**
     * The call of this step that went out earlier from the account the wallet shows and has not landed, or null: the
     * next press looks it up (read on every render).
     */
    waiting: address ? pendingSend(sendKey(action, address)) : null,
  };
}

async function sendStep(
  wallet: MoneyWallet,
  action: string,
  input: MoneySendInput,
): Promise<SendResult> {
  // The account sending now names the step: another account's waiting call is never taken for this one's.
  const from = await wallet.getAddress();
  const key = sendKey(action, from);
  let skip = 0;
  const earlier = pendingSend(key);
  if (earlier) {
    const stillPending = (cause?: unknown) =>
      new WalletStepError("pending", earlier.index, cause, earlier.hash);
    await wallet.ensureChain(earlier.chainId);
    let outcome: Awaited<ReturnType<MoneyWallet["outcomeOf"]>>;
    try {
      outcome = await wallet.outcomeOf(earlier);
    } catch (error) {
      throw stillPending(error);
    }
    if (outcome === "waiting") throw stillPending();
    const last = earlier.index + 1 >= earlier.total;
    if (outcome === "replaced" && last) {
      // Its place was taken: it may have landed under another hash. Never sent again on a guess.
      if (!input.confirm) {
        forgetPending(key);
        throw new WalletStepError("replaced", earlier.index);
      }
      let found: boolean;
      try {
        found = await input.confirm(wallet, from, earlier);
      } catch (error) {
        throw stillPending(error);
      }
      if (found) {
        forgetPending(key);
        return {
          txHash: earlier.hash,
          status: "confirmed",
          detail: earlier.detail,
        };
      }
    }
    // Landed, reverted, dropped, or (an earlier call of the step) replaced: the later calls never went out.
    forgetPending(key);
    if (outcome === "landed") {
      if (last)
        return {
          txHash: earlier.hash,
          status: "confirmed",
          detail: earlier.detail,
        };
      // The calls up to it landed; send the rest, unless they were for something else (an approval of another amount).
      if (earlier.detail === input.detail) skip = earlier.index + 1;
    }
  }
  // On the project's network before anything is read for the calls: a read on another network answers nothing.
  await wallet.ensureChain(input.chainId);
  const calls = await input.build(wallet);
  try {
    const result = await wallet.sendCalls(calls.slice(skip), input.chainId);
    return { ...result, detail: input.detail };
  } catch (error) {
    if (!(error instanceof WalletStepError)) throw error;
    const shifted =
      skip === 0
        ? error
        : new WalletStepError(
            error.reason,
            error.landed + skip,
            error.cause,
            error.hash,
            error.sent,
          );
    if (shifted.reason === "pending" && shifted.hash)
      rememberPending(key, {
        hash: shifted.hash,
        index: shifted.landed,
        total: calls.length,
        chainId: input.chainId,
        at: Math.floor(Date.now() / 1000),
        from: shifted.sent?.from ?? from,
        nonce: shifted.sent?.nonce ?? null,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      });
    throw shifted;
  }
}
