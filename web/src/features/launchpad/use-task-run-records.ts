/**
 * The run records a helper signed for the pieces of work handed in on one task (`buzz launchpad work-checks --task`).
 *
 * One read per task: the check-run kind only, by the single `#c` value each piece's record carries
 * (`taskRunQueryFilter`). Every event is verified before it is read (`parseVerifiedCheckRun`), and a record counts under
 * a piece only when it names that task and piece and was signed by the task's helper (`taskRunRecordsFor`). A read that
 * failed says so; it is never shown as "no run record".
 *
 * The cache key starts with the tasks' own, so a send that refreshes the tasks refreshes this too.
 */

import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  CHECK_RUN_QUERY_LIMIT,
  type CheckRunRecord,
  parseVerifiedCheckRun,
  TASK_RUN_PIECES_LOOKED_UP,
  taskRunQueryFilter,
  taskRunRecordsFor,
} from "./lib/check-runs";

export interface TaskRunRecords {
  /** Reading, failed, or answered. */
  status: "loading" | "failed" | "ready";
  /** Try the read again. */
  retry: () => void;
  /** The records that belong under one piece, and how many other signers' records named the same ids. */
  forPiece: (pieceId: string) => { current: CheckRunRecord[]; others: number };
  /** A record by its id, when it is bound to one of this task's pieces and signed by its helper. */
  byId: (recordId: string) => CheckRunRecord | null;
  /** The read hit its bound: older records may exist that it did not bring. */
  partial: boolean;
}

const NONE = { current: [], others: 0 };

export function useTaskRunRecords(task: {
  id: string;
  helper: string;
  evidence: readonly { id: string }[];
}): TaskRunRecords {
  const relay = relayWsUrl();
  const looked = task.evidence
    .slice(0, TASK_RUN_PIECES_LOOKED_UP)
    .map((piece) => piece.id);
  const query = useQuery({
    queryKey: [
      "launchpad",
      "tasks",
      "run-records",
      relay,
      task.id,
      task.helper,
      looked.join(","),
    ],
    enabled: looked.length > 0,
    queryFn: async () => {
      const events = await queryEvents(
        relay,
        taskRunQueryFilter(task.id, looked),
      );
      return {
        records: events.flatMap((event) => {
          const record = parseVerifiedCheckRun(event);
          return record ? [record] : [];
        }),
        partial: events.length >= CHECK_RUN_QUERY_LIMIT,
      };
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const records = query.data?.records ?? [];
  return {
    status: query.isError ? "failed" : query.data ? "ready" : "loading",
    retry: () => void query.refetch(),
    forPiece: (pieceId) =>
      looked.includes(pieceId)
        ? taskRunRecordsFor(records, task, pieceId)
        : NONE,
    byId: (recordId) => {
      const record = records.find((r) => r.eventId === recordId);
      if (!record) return null;
      const piece = record.evidenceHash.slice(2);
      return taskRunRecordsFor(records, task, piece).current.includes(record)
        ? record
        : null;
    },
    partial: query.data?.partial ?? false,
  };
}
