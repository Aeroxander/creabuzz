/**
 * LEGACY (behind the legacy-screens flag, off by default): the version 1 reads of the screens that went behind the flag.
 * The live reads are in `use-money.ts` (record version 2). No version 1 record is published any more; these exist so
 * the flagged-off screens still work when the flag is switched on against an old server.
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import type { Project } from "../project/project-record";
import { positionCallData, QUOTE_CALL_DATA } from "./calls-v1";
import {
  type NumbersEvent,
  type ProjectNumbers,
  parseNumbers,
  type RemovedNumbers,
} from "./numbers-v1";
import { rememberSendTargets } from "./send-targets";
import { chainKeyOfProject, moneyKeys, newest } from "./use-money";
import { addressFromWord, type MoneyWallet } from "./wallet";

/** The version 1 numbers of a project (see `use-money.ts` for the live version 2 read). */
export function useProjectNumbers(project: Project | null | undefined) {
  const chainKey = project ? chainKeyOfProject(project) : null;
  const signer = serverRelaySigner();
  const on = investingOn() && Boolean(project && chainKey && signer);
  return useQuery({
    queryKey: [
      "money",
      "v1",
      ...moneyKeys.project(chainKey ?? "", project?.coordinate ?? ""),
    ],
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

/** The server's recent version 1 records of numbers, up to `pages` reads of 100. */
export function useRecentNumbers(enabled = true, pages = 1) {
  const signer = serverRelaySigner();
  return useQuery({
    queryKey: ["money", "v1", ...moneyKeys.recent(pages)],
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

/** Each project with version 1 numbers that belong to it, from a list of projects and the recent records. */
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

/** The dollar token a project's rounds take, read from the Rounds contract (the record does not carry it). */
export async function readQuote(
  wallet: MoneyWallet,
  rounds: string,
): Promise<string> {
  const quote = addressFromWord(await wallet.readCall(rounds, QUOTE_CALL_DATA));
  if (!quote) throw new Error("The dollar token could not be read.");
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
