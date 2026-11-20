/**
 * Where the news comes from (plan sections 6.2 and 6.3): the You page reads the server's recent records of numbers (three
 * pages of 100, as Your Shares does) and, besides them, the projects this device knows the person took part in; the dot on
 * You reads only that bounded set of at most 20 projects, once when the app opens and again when it is looked at, never on a
 * timer. Both end in `useDerived`.
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useAccount } from "../../lib/account";
import { read } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import { useHomeProjects } from "../home/use-home";
import type { NumbersEvent } from "../money/numbers";
import {
  matchNumbers,
  newest,
  useRecentNumbers,
  useWalletAddress,
} from "../money/use-money";
import { ownSteps } from "../pot/own-history";
import { alertsOf } from "./alerts";
import {
  type Derived,
  MOST_PROJECTS,
  type Source,
  useDerived,
} from "./pipeline";
import { heldKeys, markSeen, rememberHeld, useSeen } from "./seen";
import { holdingHint, type ProjectNumbers } from "../money/numbers";

/** The projects this device knows the person took part in: their own Backs and Take outs, then what was last found held. */
function knownKeys(address: string, pubkey: string): string[] {
  const keys = new Set<string>();
  for (const step of ownSteps(address)) keys.add(step.project);
  for (const key of heldKeys(pubkey, address)) keys.add(key);
  return [...keys].slice(0, MOST_PROJECTS);
}

/** The server's newest record for each of `keys`, one read, matched to the projects they belong to. */
function useKeyedSources(keys: readonly string[], enabled: boolean): Source[] {
  const signer = serverRelaySigner();
  const projects = useHomeProjects();
  const events = useQuery({
    queryKey: ["alerts", "numbers", keys.join(",")],
    enabled:
      enabled && keys.length > 0 && Boolean(signer) && projects.isSuccess,
    staleTime: 60_000,
    queryFn: async (): Promise<NumbersEvent[]> => {
      const found = (await read({
        kinds: [KIND_PROJECT_NUMBERS],
        authors: signer ? [signer] : [],
        "#d": [...keys],
        limit: keys.length * 2,
      })) as NumbersEvent[];
      // The newest record of each project, the way the server's recent records are kept.
      const byKey = new Map<string, NumbersEvent>();
      for (const event of newest(found)) {
        const d = event.tags.find((t) => t[0] === "d")?.[1]?.toLowerCase();
        if (d && !byKey.has(d)) byKey.set(d, event);
      }
      return [...byKey.values()];
    },
  });
  return useMemo(
    () => matchNumbers(projects.data ?? [], events.data ?? []),
    [projects.data, events.data],
  );
}

/** What the news section of You says. */
export interface News extends Derived {
  status: "off" | "loading" | "failed" | "ready";
  refetch: () => void;
}

/** The sources of the two reads, with a project found by both kept once. */
function union(...lists: Source[][]): Source[] {
  const seen = new Map<string, Source>();
  for (const list of lists)
    for (const source of list)
      if (!seen.has(source.numbers.key)) seen.set(source.numbers.key, source);
  return [...seen.values()];
}

/**
 * The full derivation, for the You page: the server's recent records and the projects this device knows, every holder's news
 * found by the record's list or, where the list was cut, by a balance read for at most 20 projects.
 */
export function useNews(): News {
  const address = useWalletAddress().data ?? null;
  const { pubkey } = useAccount();
  const on = investingOn() && address !== null && pubkey !== null;
  const recent = useRecentNumbers(on, 3);
  const projects = useHomeProjects();
  const scanned = useMemo(
    () => matchNumbers(projects.data ?? [], recent.data?.events ?? []),
    [projects.data, recent.data],
  );
  const known = on ? knownKeys(address as string, pubkey as string) : [];
  const missing = known.filter(
    (key) => !scanned.some((s) => s.numbers.key === key),
  );
  const extra = useKeyedSources(missing, on && recent.isSuccess);
  const sources = useMemo(() => union(scanned, extra), [scanned, extra]);
  const derived = useDerived(sources, on ? address : null, { words: true });
  const status = !on
    ? "off"
    : recent.isError || projects.isError
      ? "failed"
      : recent.isPending || projects.isPending || derived.pending
        ? "loading"
        : "ready";
  return {
    ...derived,
    status,
    refetch: () => {
      void recent.refetch();
      void projects.refetch();
    },
  };
}

/**
 * How many pieces of news the person has not read, for the dot on You. Bounded: only the projects this device knows the
 * person took part in (at most 20), the newest record of each, with no scan of holders and no timer. Zero without a wallet.
 */
export function useUnseenNews(): number {
  const address = useWalletAddress().data ?? null;
  const { pubkey } = useAccount();
  const on = investingOn() && address !== null && pubkey !== null;
  const keys = on ? knownKeys(address as string, pubkey as string) : [];
  const sources = useKeyedSources(keys, on);
  const derived = useDerived(sources, on ? address : null, { words: false });
  const seen = useSeen(pubkey);
  if (!on) return 0;
  return derived.alerts.filter((a) => !(a.id in seen)).length;
}

/**
 * Marks the news of the project whose page is open as read (the strips on the page are that news), and notes that the person
 * holds it when the record lists them. The page is correct with no storage.
 */
export function useMarkProjectSeen(
  numbers: ProjectNumbers | null,
  address: string | null,
): void {
  const { pubkey } = useAccount();
  const built = numbers?.builtAt ?? 0;
  const key = numbers?.key ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new record of the same project (`built`) is read again; `numbers` is its parse.
  useEffect(() => {
    if (!pubkey || !numbers) return;
    const now = Math.floor(Date.now() / 1000);
    const ids = alertsOf({
      numbers: [numbers],
      names: new Map(),
      me: address ? [address] : [],
      held: () => true,
      tasksOf: () => undefined,
      now,
    }).map((a) => a.id);
    if (ids.length > 0) markSeen(pubkey, ids, new Set(ids), now);
    if (address && holdingHint(numbers, [address]).listed)
      rememberHeld(pubkey, address, numbers.key, true, now);
  }, [pubkey, address, key, built]);
}
