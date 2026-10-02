/**
 * The Creaton tab's ordering: recency, lifted by engagement, with likes
 * weighted by social trust — more of each as the community grows
 * (`lib/trust.ts`). Following stays strictly chronological.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  KIND_CONTACT_LIST,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";

import { lastTagValue } from "./lib/engagement";
import type { Row } from "./lib/timeline";
import {
  buildFollowGraph,
  graphNodes,
  likerWeight,
  percentiles,
  rankingStrength,
  rankScore,
  seededPageRank,
  trustBlend,
} from "./lib/trust";
import { readEvents } from "./read";
import { useLaunchUpdates } from "./use-launch-updates";
import { socialKeys } from "./use-social-data";

const GRAPH_LIMIT = 2_000;
const PROFILE_LIMIT = 2_000;
const RELATED_CHUNK = 40;
/** A viewer's own follows steer trust; the global graph keeps it honest. */
const PERSONAL_SHARE = 0.5;
/** A priority launch update ranks as if it were this much newer. */
const PRIORITY_UPDATE_BONUS_SECONDS = 6 * 60 * 60;

/** The follow graph and community size, shared by every ranked list. */
export function useTrustModel() {
  const me = existingUserPubkey();
  const lists = useQuery({
    queryKey: [...socialKeys.lists, "trust-graph"],
    staleTime: 5 * 60_000,
    queryFn: () =>
      readEvents({ kinds: [KIND_CONTACT_LIST], limit: GRAPH_LIMIT }),
  });
  const profiles = useQuery({
    queryKey: [...socialKeys.lists, "community-size"],
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (await readEvents({ kinds: [KIND_PROFILE], limit: PROFILE_LIMIT }))
        .length,
  });

  return useMemo(() => {
    if (!lists.data || profiles.data === undefined) return null;
    const graph = buildFollowGraph(lists.data);
    const size = Math.max(profiles.data, graphNodes(graph).length);
    const blend = trustBlend(size);
    const mine = me ? [...(graph.get(me) ?? [])] : [];
    const globalRank = percentiles(seededPageRank(graph, []));
    const personalRank =
      me && mine.length > 0
        ? percentiles(seededPageRank(graph, [me, ...mine]))
        : null;
    const percentile = (pubkey: string) => {
      const global = globalRank.get(pubkey) ?? 0;
      const personal = personalRank?.get(pubkey);
      return personal === undefined
        ? global
        : PERSONAL_SHARE * personal + (1 - PERSONAL_SHARE) * global;
    };
    const followed = new Set(mine);
    return {
      size,
      blend,
      strength: rankingStrength(size),
      weightOf: (pubkey: string) =>
        likerWeight(
          {
            percentile: percentile(pubkey),
            followedByViewer: followed.has(pubkey),
          },
          blend,
        ),
    };
  }, [lists.data, profiles.data, me]);
}

/**
 * `rows` ordered for the Creaton tab. Until the trust model and the engagement
 * of the loaded posts are known, the rows stay in feed order — the ranking only
 * ever refines the chronological list, so there is no empty or half-sorted state.
 */
export function useRankedRows(rows: readonly Row[], enabled: boolean): Row[] {
  const model = useTrustModel();
  const { priority } = useLaunchUpdates();
  const ids = useMemo(
    () => [...new Set(rows.map((r) => r.event.id))].sort(),
    [rows],
  );
  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += RELATED_CHUNK) {
      out.push(ids.slice(i, i + RELATED_CHUNK));
    }
    return out;
  }, [ids]);
  const { ready, events } = useQueries({
    // `combine` keeps the result referentially stable until the data changes.
    combine: (results) => ({
      ready: results.every((q) => q.isSuccess),
      events: results.flatMap((q) => q.data ?? []),
    }),
    queries: chunks.map((chunk) => ({
      queryKey: [...socialKeys.engagement, "ranking", chunk],
      enabled: enabled && model !== null,
      staleTime: 30_000,
      queryFn: () =>
        readEvents({
          kinds: [KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE],
          "#e": chunk,
          limit: 1000,
        }),
    })),
  });

  return useMemo(() => {
    if (!enabled || !model || !ready || rows.length === 0) return [...rows];
    const engagement = new Map<string, number>();
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const target = lastTagValue(event.tags, "e");
      if (!target) continue;
      if (event.kind === KIND_REACTION) {
        if (event.content !== "+" && event.content !== "") continue;
        engagement.set(
          target,
          (engagement.get(target) ?? 0) + model.weightOf(event.pubkey),
        );
      } else if (event.kind === KIND_REPOST) {
        engagement.set(
          target,
          (engagement.get(target) ?? 0) + 1.5 * model.weightOf(event.pubkey),
        );
      } else if (event.kind === KIND_TEXT_NOTE) {
        engagement.set(
          target,
          (engagement.get(target) ?? 0) + 0.5 * model.weightOf(event.pubkey),
        );
      }
    }
    const scoreOf = (row: Row) =>
      rankScore(
        {
          engagement: engagement.get(row.event.id) ?? 0,
          at:
            (row.repostedBy?.at ?? row.event.created_at) +
            (priority.has(row.event.id) ? PRIORITY_UPDATE_BONUS_SECONDS : 0),
        },
        model.strength,
      );
    return [...rows].sort((a, b) => scoreOf(b) - scoreOf(a));
  }, [enabled, model, ready, rows, events, priority]);
}
