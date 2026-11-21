/**
 * Where the pause stands for the people who run the project: from the record when the sheet opens, upgraded to the chain's
 * own answer once it has been read (the record can be minutes old and a pause starts and ends by the clock). A project with
 * no pause (the record names none) has none here: nothing is read and nothing is said. A read that fails keeps the record's
 * numbers and says nothing more than they do.
 */
import {
  pauseGateOf,
  pauseState,
  type ReadCall,
} from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import type { ProjectNumbers } from "../money/numbers";
import { type PauseStage, pauseStage } from "./pause-words";

export interface TeamPause {
  stage: PauseStage;
  /** The line is one this-many-th of the backers' Shares. */
  divisor: number;
  pausesFrom: number | null;
  since: number | null;
}

export function useTeamPause(
  numbers: ProjectNumbers,
  read: ReadCall | null,
  enabled = true,
): TeamPause | null {
  const record = numbers.pause ?? null;
  const has = Boolean(record && numbers.contracts.pause);
  const live = useQuery({
    queryKey: ["pot", "team-pause", numbers.contracts.treasury],
    enabled: enabled && has && read !== null,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      if (!read) return null;
      const gate = await pauseGateOf(read, numbers.contracts.treasury);
      return gate ? await pauseState(read, gate) : null;
    },
  });
  if (!record || !has) return null;
  const now = live.data;
  if (now) {
    const stage: PauseStage = now.paused
      ? "paused"
      : now.armedAt > 0
        ? "armed"
        : "under";
    return {
      stage,
      divisor: record.lineDivisor,
      pausesFrom: now.pausesFrom > 0 ? now.pausesFrom : null,
      since: now.paused ? now.pausesFrom : null,
    };
  }
  return {
    stage: pauseStage(record),
    divisor: record.lineDivisor,
    pausesFrom: record.pausesFrom,
    since: record.since,
  };
}
