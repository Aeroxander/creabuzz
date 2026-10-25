import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { KIND_FORECAST } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { getRpcEndpoint } from "./chain";
import { defaultChainPreset, openBounty, workBounty } from "./chain-config";
import {
  accuracy,
  countingForecasts,
  type Forecast,
  forecastTemplate,
  parseForecast,
  parseQuestion,
  readPostBountyQuestion,
  readWorkBountyQuestion,
} from "./lib/forecast";
import { endpointChain } from "./use-work";

/** At most this many forecasts are read for one question, and this many questions for one person's record. */
const MAX_FORECASTS = 500;
const MAX_QUESTIONS = 30;

/** Every forecast on one question (N3), and a way to publish yours. */
export function useForecasts(question: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["forecasts", question],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<Forecast[]> => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_FORECAST],
        "#t": [question],
        limit: MAX_FORECASTS,
      });
      return events.flatMap((event) => {
        const parsed = parseForecast(event);
        return parsed && parsed.question === question ? [parsed] : [];
      });
    },
  });
  const publish = useCallback(
    async (percent: number, reason: string) => {
      await publishAsUser(
        forecastTemplate(question, percent, reason),
        "The server did not take your forecast.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["forecasts", question],
      });
    },
    [question, queryClient],
  );
  return { query, publish };
}

/**
 * A person's forecasting record (N3): accuracy over the bounties that settled, computed in this browser from their
 * public forecasts and the chain. Only bounties on this build's own contracts count, so nobody can point a forecast at a
 * contract that reports whatever they like.
 */
export function useForecastRecord(pubkey: string) {
  return useQuery({
    queryKey: ["forecast-record", pubkey],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_FORECAST],
        authors: [pubkey],
        limit: MAX_FORECASTS,
      });
      const mine = events.flatMap((event) => {
        const parsed = parseForecast(event);
        return parsed && parsed.author === pubkey ? [parsed] : [];
      });
      const chainId = defaultChainPreset().chainId;
      const trusted = {
        postbounty: openBounty(chainId),
        workbounty: workBounty(chainId),
      };
      const byQuestion = new Map<string, Forecast[]>();
      for (const f of mine) {
        const q = parseQuestion(f.question);
        if (!q || q.chainId !== chainId || trusted[q.kind] !== q.contract) {
          continue;
        }
        byQuestion.set(f.question, [...(byQuestion.get(f.question) ?? []), f]);
      }
      const newest = [...byQuestion.entries()]
        .sort(
          (a, b) =>
            Math.max(...b[1].map((f) => f.createdAt)) -
            Math.max(...a[1].map((f) => f.createdAt)),
        )
        .slice(0, MAX_QUESTIONS);
      const chain = endpointChain(getRpcEndpoint());
      const settled = (
        await Promise.all(
          newest.map(async ([question, forecasts]) => {
            const q = parseQuestion(question);
            if (!q) return [];
            const state = await (q.kind === "postbounty"
              ? readPostBountyQuestion(chain, q.contract, q.id)
              : readWorkBountyQuestion(chain, q.contract, q.id)
            ).catch(() => null);
            const [counted] = state
              ? countingForecasts(forecasts, state.cutoff)
              : [];
            return state?.outcome && counted
              ? [{ percent: counted.percent, done: state.outcome === "done" }]
              : [];
          }),
        )
      ).flat();
      return {
        forecasts: byQuestion.size,
        settled: settled.length,
        score: accuracy(settled),
      };
    },
  });
}
