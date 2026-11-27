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
import type { MoneyCall } from "./calls";
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
import { senderWords, useSender } from "./sender";
import {
  type MoneyWallet,
  type SenderKind,
  type SentCall,
  isAccountMismatch,
  senderCapabilities,
  senderKind,
  WalletStepError,
} from "./wallet";

const moneyKeys = {
  all: ["money"] as const,
  // The coordinate is part of the key: two records naming one chain key are checked each on its own, never shared.
  project: (key: string, coordinate: string) =>
    ["money", "numbers", key, coordinate] as const,
  recent: (pages: number) => ["money", "recent", pages] as const,
  // The sender is part of the key: the wallet's account and the passkey account are two accounts, never shared.
  address: (kind: SenderKind) => ["money", "address", kind] as const,
};

/** Newest first, ties broken by id. */
export function newest<T extends { created_at: number; id: string }>(
  events: T[],
) {
  return [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
  );
}

/** The chain key a project's record names, or null. */
export function chainKeyOfProject(project: Project): string | null {
  return chainKeyFromTags(project.event.tags);
}

/** How long to wait before asking for a record that is not there yet, after `waited` ms of waiting; false once it is time to stop. */
export function lookAgainEvery(waited: number): number | false {
  if (waited < 30_000) return 5_000;
  if (waited < 120_000) return 15_000;
  return false;
}

/**
 * A project's numbers: the newest record the server signed for the chain key the founder's record names, believed only
 * when it is that project's launch. Null when investing is off, the project names no launch, or nothing was read.
 */
export function useProjectNumbers(project: Project | null | undefined) {
  const chainKey = project ? chainKeyOfProject(project) : null;
  const signer = serverRelaySigner();
  const on = investingOn() && Boolean(project && chainKey && signer);
  // When this page began waiting for this project's record: a project that is linked to its launch starts a new wait.
  const watchKey = `${chainKey ?? ""}|${project?.coordinate ?? ""}`;
  const watching = useRef({ key: watchKey, at: Date.now() });
  if (watching.current.key !== watchKey)
    watching.current = { key: watchKey, at: Date.now() };
  return useQuery({
    queryKey: moneyKeys.project(chainKey ?? "", project?.coordinate ?? ""),
    enabled: on,
    staleTime: 20_000,
    // A project just launched has no record until the server has read it: look again soon, then less often, and stop after
    // a couple of minutes (a record the server will never sign must not be asked for forever; a reload asks again).
    refetchInterval: (query) =>
      query.state.data === null || query.state.data === undefined
        ? lookAgainEvery(Date.now() - watching.current.at)
        : false,
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
            rememberSendTargets([
              ...Object.values(numbers.contracts),
              // The earlier backers' claim contract, when the record names one (a passkey account may send to it).
              numbers.earlierGrants?.contract,
            ]);
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
interface RecentNumbers {
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

/** The words for the sender in use (`senderWords` of `useWallet()`): "your wallet" or "your account", and so on. */
export function useSenderWords(): ReturnType<typeof senderWords> {
  return senderWords(useWallet());
}

/** The wallet account this site may already see (no prompt), or null. Off with investing off. */
export function useWalletAddress() {
  const wallet = useWallet();
  return useQuery({
    queryKey: moneyKeys.address(senderKind(wallet)),
    enabled: investingOn() && wallet.isAvailable(),
    staleTime: 60_000,
    // An address the server got wrong (passkey account) is told once, not asked for again and again.
    retry: (count, error) => !isAccountMismatch(error) && count < 1,
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
    queryKey: ["money", "wallet-chain", senderKind(wallet), chainId ?? 0],
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
      queryClient.setQueryData(moneyKeys.address(senderKind(wallet)), address),
  });
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
      } catch (error) {
        // Which sender stopped, so the words say "your wallet" or "your passkey" rightly.
        if (error instanceof WalletStepError) error.sender = senderKind(wallet);
        throw error;
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
    /** What a sheet says of where the person agrees, for the sender sending this step. */
    words: senderWords(wallet),
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
  // A sender that sends the whole step as one operation has no "calls that landed first": what is waiting is the whole
  // step, so it is remembered as the last of its calls, and a later look at it never sends the later calls alone.
  const atomic = senderCapabilities(wallet).atomicBatch;
  const remember = (
    hash: string,
    index: number,
    sent?: Omit<SentCall, "hash">,
  ) =>
    rememberPending(key, {
      hash,
      index: atomic ? calls.length - 1 : index,
      total: calls.length,
      chainId: input.chainId,
      at: Math.floor(Date.now() / 1000),
      from: sent?.from ?? from,
      nonce: sent?.nonce ?? null,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
  let recorded = false;
  try {
    const result = await wallet.sendCalls(calls.slice(skip), input.chainId, {
      // Written the moment the operation is signed: a tab closed or a page reloaded while it is out forgets nothing.
      onSent: (sent) => {
        remember(sent.hash, skip, sent);
        recorded = true;
      },
    });
    if (recorded) forgetPending(key);
    return { ...result, detail: input.detail };
  } catch (error) {
    if (!(error instanceof WalletStepError)) {
      // An unexpected failure after it went out leaves the record: its outcome is looked up on the next press.
      throw error;
    }
    if (recorded && error.reason !== "pending") forgetPending(key);
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
      remember(shifted.hash, shifted.landed, shifted.sent);
    throw shifted;
  }
}
