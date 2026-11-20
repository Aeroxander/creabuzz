import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import {
  KIND_LAUNCH_RECORD,
  KIND_PROJECT_NUMBERS,
} from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { read, readMulti } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import { chainKeyOfProject } from "../money/use-money";
import { latestProjects, type Project } from "../project/project-record";
import {
  type ExploreEntry,
  entryHolds,
  type IndexEvent,
  parseIndex,
  RANK_RECORDS_READ,
  RANK_ROWS_SHOWN,
  rankedEntries,
  splitCoordinate,
} from "./ranking";

export interface RankedProject {
  project: Project;
  entry: ExploreEntry;
}

/** What Home shows for the ranking: nothing known (no index, an old one, one not from the server), or the rows. */
export type Ranking =
  | { status: "none" }
  | {
      status: "ready";
      rows: RankedProject[];
      /** How long money had to stay, in seconds, from the entries the index named (null when it named none). */
      windowSecs: number | null;
    };

/**
 * The ranking of Home: one read for the server's index, then one read for the records of the first ten projects it names (not
 * sixty browsing records). Off unless the server offers investing and says whose key signs its records.
 */
export function useRanking() {
  const signer = serverRelaySigner();
  return useQuery({
    queryKey: ["home", "ranking"],
    enabled: investingOn() && Boolean(signer),
    staleTime: 60_000,
    queryFn: async (): Promise<Ranking> => {
      if (!signer) return { status: "none" };
      const now = Math.floor(Date.now() / 1000);
      const events = (await read({
        kinds: [KIND_PROJECT_NUMBERS],
        authors: [signer],
        "#d": ["explore"],
        limit: 5,
      })) as IndexEvent[];
      // The newest the server signed that can be believed.
      const newest = [...events].sort(
        (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
      );
      const index = newest
        .map((event) => parseIndex(event, signer, now))
        .find((parsed) => parsed !== null);
      if (!index) return { status: "none" };
      const windowSecs = index.entries[0]?.windowSecs ?? null;
      const first = rankedEntries(index).slice(0, RANK_RECORDS_READ);
      const named = first.flatMap((entry) => {
        const who = splitCoordinate(entry.a);
        return who ? [{ entry, ...who }] : [];
      });
      const found = await readMulti(
        named.map((n) => ({
          kinds: [KIND_LAUNCH_RECORD],
          authors: [n.founder],
          "#d": [n.id],
          limit: 5,
        })),
      );
      const rows: RankedProject[] = [];
      named.forEach((n, i) => {
        const project = latestProjects(found[i] ?? []).find(
          (p) => p.coordinate === n.entry.a,
        );
        if (entryHolds(n.entry, project, chainKeyOfProject) && project)
          rows.push({ project, entry: n.entry });
      });
      return {
        status: "ready",
        rows: rows.slice(0, RANK_ROWS_SHOWN),
        windowSecs,
      };
    },
  });
}
