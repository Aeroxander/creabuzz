/**
 * From the projects a person may hold to the news about them (plan sections 6.1 and 6.2): which projects, whether the person
 * holds each (the record's list of holders, or else a balance read from the network once per project per five minutes, at
 * most 20 projects), the team's words for each task (one read per project that has news, at most 20), and the alerts. The two
 * callers differ only in where the projects come from: the You page looks at the server's recent records, the dot on You at
 * a bounded set kept on this device.
 */
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useAccount } from "../../lib/account";
import { holdingHint, type ProjectNumbers } from "../money/numbers";
import { useWallet } from "../money/use-money";
import { recordFitsBuild } from "../pot/use-pot";
import type { Project } from "../project/project-record";
import { projectRef } from "../project/project-record";
import { projectTasksQuery } from "../tasks/use-tasks";
import { type AlertsResult, alertsResult } from "./alerts";
import { rememberHeld } from "./seen";

/** The most projects one derivation reads a balance or a task list for. */
export const MOST_PROJECTS = 20;

/** A project with the record the server signed for it, and what is known of whether the person holds it. */
export interface Source {
  project: Project;
  numbers: ProjectNumbers;
}

/** Whether the record's own list says the person holds the project: yes, no (the list is whole), or it cannot say (cut). */
function heldHint(
  numbers: ProjectNumbers,
  accounts: readonly string[],
): boolean | "unknown" {
  const hint = holdingHint(numbers, accounts);
  return hint.listed ? true : hint.certain ? false : "unknown";
}

/** What a read of the network says about one project: held, not held, or not read (yet, or at all). */
type Balance = boolean | "failed" | undefined;

/**
 * Whether `address` holds Shares or Team Shares in each of `items`, read from the network (the ABIs load only when the first
 * read is made). A read on another network, or one that fails, says `failed`: nothing is then said about that project.
 */
function useBalances(
  items: readonly Source[],
  address: string | null,
): Map<string, Balance> {
  const wallet = useWallet();
  const reads = useQueries({
    queries: items.map(({ numbers }) => ({
      queryKey: [
        "alerts",
        "held",
        numbers.chainId,
        numbers.contracts.shares,
        numbers.contracts.team,
        address,
      ],
      enabled:
        address !== null && wallet.isAvailable() && recordFitsBuild(numbers),
      staleTime: 5 * 60_000,
      retry: false,
      queryFn: async (): Promise<boolean> => {
        const { balanceOf } = await import("@creaton/core/pot/pot-reads.ts");
        const read = (to: string, data: string) => wallet.readCall(to, data);
        const [shares, team] = await Promise.all([
          balanceOf(read, numbers.contracts.shares, address as string),
          balanceOf(read, numbers.contracts.team, address as string),
        ]);
        return shares > 0n || team > 0n;
      },
    })),
  });
  return new Map(
    items.map(({ numbers }, i): [string, Balance] => {
      const read = reads[i];
      return [
        numbers.key,
        read?.data !== undefined
          ? read.data
          : read?.isError
            ? "failed"
            : undefined,
      ];
    }),
  );
}

/** What the derivation says. */
export interface Derived extends AlertsResult {
  /** The project's page link, by chain key. */
  refs: ReadonlyMap<string, string>;
  /** More projects needed a balance read than the limit: the rest are left to their own pages. */
  limited: boolean;
  /** Some project could not be read about (a balance), or its record is more than a day old. */
  partial: boolean;
  /** Still reading task words or balances (a list is shown only when these are done). */
  pending: boolean;
}

/**
 * The news for `sources`, for the person with `address`. `words` says whether the team's words for each task are read (the
 * list shows them; the dot only counts). Without an address there is no news.
 */
export function useDerived(
  sources: readonly Source[],
  address: string | null,
  options: { words: boolean },
): Derived {
  const { pubkey } = useAccount();
  const accounts = useMemo(() => (address ? [address] : []), [address]);
  const byKey = useMemo(
    () => new Map(sources.map((s) => [s.numbers.key, s])),
    [sources],
  );
  const hints = useMemo(
    () =>
      new Map(
        sources.map((s) => [s.numbers.key, heldHint(s.numbers, accounts)]),
      ),
    [sources, accounts],
  );
  const names = useMemo(
    () => new Map(sources.map((s) => [s.numbers.key, s.project.name])),
    [sources],
  );
  const numbers = useMemo(() => sources.map((s) => s.numbers), [sources]);
  // To the minute: the news does not change by the second, and a clock that ticked would make every render a new derivation.
  const now = Math.floor(Date.now() / 60_000) * 60;

  // First look: what the records say, to find the projects whose holding is to be read.
  const first = useMemo(
    () =>
      alertsResult({
        numbers,
        names,
        me: accounts,
        held: (key) => hints.get(key) ?? false,
        tasksOf: () => undefined,
        now,
      }),
    [numbers, names, accounts, hints, now],
  );
  const toRead = first.unknownHeld.slice(0, MOST_PROJECTS);
  const balances = useBalances(
    toRead.flatMap((key) => byKey.get(key) ?? []),
    address,
  );
  const heldOf = (key: string): boolean | "unknown" => {
    const hint = hints.get(key) ?? false;
    if (hint !== "unknown") return hint;
    const read = balances.get(key);
    return typeof read === "boolean" ? read : false;
  };
  const heldSignature = [...hints.keys()]
    .map((k) => `${k}:${heldOf(k)}`)
    .join();

  // Second look: with the holding known, which projects have news the team's words are wanted for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `heldSignature` stands for what `heldOf` answers.
  const second = useMemo(
    () =>
      alertsResult({
        numbers,
        names,
        me: accounts,
        held: heldOf,
        tasksOf: () => undefined,
        now,
      }),
    [numbers, names, accounts, heldSignature, now],
  );
  const withNews = [...new Set(second.alerts.map((a) => a.chainKey))]
    .slice(0, MOST_PROJECTS)
    .flatMap((key) => byKey.get(key)?.project ?? []);
  const taskReads = useQueries({
    queries: withNews.map((project) => ({
      ...projectTasksQuery(project),
      enabled: options.words,
    })),
  });
  const wordsPending = options.words && taskReads.some((q) => q.isPending);
  const taskData = new Map(
    withNews.map((project, i) => [
      project.coordinate,
      taskReads[i]?.data?.tasks,
    ]),
  );
  const readSignature = taskReads.map((q) => q.dataUpdatedAt).join();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `readSignature` stands for the task lists read.
  const final = useMemo(
    () =>
      alertsResult({
        numbers,
        names,
        me: accounts,
        held: heldOf,
        tasksOf: (key) => {
          const project = byKey.get(key)?.project;
          return project ? taskData.get(project.coordinate) : undefined;
        },
        now,
      }),
    [numbers, names, accounts, heldSignature, readSignature, now],
  );

  // What was found is remembered on this device: the dot reads these projects first next time.
  const heldNow = [...hints.keys()]
    .map((key) => [key, heldOf(key)] as const)
    .filter(([, held]) => typeof held === "boolean");
  const heldNote = heldNow.map(([k, h]) => `${k}:${h}`).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `heldNote` stands for `heldNow`.
  useEffect(() => {
    if (!pubkey || !address) return;
    for (const [key, held] of heldNow)
      rememberHeld(pubkey, address, key, held === true, now);
  }, [pubkey, address, heldNote, now]);

  const refs = useMemo(
    () => new Map(sources.map((s) => [s.numbers.key, projectRef(s.project)])),
    [sources],
  );
  const failed = toRead.some((key) => balances.get(key) === "failed");
  const waiting = toRead.some((key) => balances.get(key) === undefined);
  return {
    ...final,
    refs,
    limited: first.unknownHeld.length > MOST_PROJECTS,
    partial: failed || final.alerts.some((a) => a.old),
    pending: wordsPending || waiting,
  };
}
