/**
 * The open reports about one board's posts and replies, for the reader when they moderate it (D99), and closing them.
 *
 * Reads the server's report queue narrowed to the board (signed, as the community's queue is); the server lets the board's
 * moderators read it as well as the community's, and leaves out who reported each one. The reported posts and replies are
 * read from the board to show what was said and by whom, and to tell what is already gone. Removing publishes the board's
 * own removal (with its public reason) before the report is closed, so a report never says "acted on" for words still
 * there; a failure leaves the row open with the reason and the same buttons to try again.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import { buildResolveReport } from "@/features/moderation/lib/moderationEvents";
import {
  type ModerationReport,
  parseModerationReports,
} from "@/features/moderation/lib/moderationQueue";
import { useActionTracker } from "@/shared/hooks/use-action-tracker";
import { useBoundedPoll } from "@/shared/hooks/use-bounded-poll";
import { existingUserPubkey } from "@/shared/lib/identity";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { failureWords } from "@/shared/lib/readable-error";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";

import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  moderationDeletionDraft,
} from "./lib/board-events";
import {
  boardReportsUrl,
  type ReportChoices,
  type ReportedWords,
  reportChoices,
  reportedWords,
} from "./lib/board-reports";

const POLL_MS = 30_000;

export interface BoardReportRow {
  report: ModerationReport;
  /** The reported post or reply, or null once it is gone. */
  words: ReportedWords | null;
  choices: ReportChoices;
}

export interface BoardReports {
  rows: BoardReportRow[];
  loading: boolean;
  /** Why the reports could not be read, in words. */
  error: string | null;
  /** The automatic refresh has stopped; `refresh` starts it again. */
  paused: boolean;
  refresh: () => Promise<void>;
  /** In-flight work, by report id. */
  acting: ReadonlySet<string>;
  /** Why the last try on a report failed, by report id. */
  errors: ReadonlyMap<string, string>;
  /**
   * Remove the reported words with a public reason, then close the report. Each of these resolves to why it failed (also
   * kept in `errors`), or null when it went through.
   */
  remove: (row: BoardReportRow, reason: string) => Promise<string | null>;
  /** Close a report about words that are already gone. */
  close: (row: BoardReportRow) => Promise<string | null>;
  dismiss: (row: BoardReportRow) => Promise<string | null>;
}

async function fetchBoardReports(boardId: string): Promise<ModerationReport[]> {
  const url = boardReportsUrl(relayHttpBaseUrl(), boardId);
  const response = await fetch(url, {
    headers: { Authorization: await makeNip98AuthHeader(url, "GET") },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Only this board's moderators can see its reports.");
  }
  if (!response.ok) {
    throw new Error(`The server didn't send the reports (${response.status}).`);
  }
  return parseModerationReports(await response.json());
}

export function useBoardReports(
  boardId: string,
  enabled: boolean,
  outranks: (author: string) => boolean,
): BoardReports {
  const me = existingUserPubkey();
  const on = enabled && me !== null;
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [words, setWords] = useState<NostrEvent[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { acting, errors, setActingFor, clearError, failSaying } =
    useActionTracker();
  // Only the newest read writes its result (a slower older one must not put back what a newer one cleared).
  const generation = useRef(0);
  // Reports whose words this reader removed already, so a try again after a failed close does not remove them twice.
  const removedHere = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!on) return;
    const mine = ++generation.current;
    try {
      const rows = await fetchBoardReports(boardId);
      const ids = [
        ...new Set(
          rows.filter((r) => r.targetKind === "event").map((r) => r.target),
        ),
      ];
      const found =
        ids.length === 0
          ? []
          : await queryEvents(relayWsUrl(), {
              ids,
              kinds: [KIND_FORUM_POST, KIND_FORUM_COMMENT],
              "#h": [boardId],
              limit: ids.length,
            });
      if (mine !== generation.current) return;
      setReports(rows);
      setWords(found);
      setError(null);
    } catch (readError) {
      if (mine !== generation.current) return;
      // This file's own sentences (only moderators may see them) as they are; a timeout or the server's code as what to do.
      setError(
        failureWords(
          readError,
          "Couldn't read the reports. Check your connection, then refresh.",
        ).text,
      );
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [boardId, on]);

  const { paused, refresh } = useBoundedPoll(load, on, POLL_MS);

  const rows = useMemo<BoardReportRow[]>(
    () =>
      reports
        .filter((report) => !closed.has(report.id))
        .map((report) => {
          const said = reportedWords(report, words);
          return {
            report,
            words: said,
            choices: reportChoices(report, said, me, outranks),
          };
        }),
    [reports, words, closed, me, outranks],
  );

  const act = useCallback(
    async (
      row: BoardReportRow,
      work: () => Promise<void>,
    ): Promise<string | null> => {
      const key = row.report.id;
      setActingFor(key, true);
      clearError(key);
      try {
        await work();
        setClosed((current) => new Set([...current, key]));
        void refresh();
        return null;
      } catch (actError) {
        const said = failureWords(
          actError,
          "That did not go through. Try again.",
        ).text;
        failSaying(key, said);
        return said;
      } finally {
        setActingFor(key, false);
      }
    },
    [clearError, failSaying, refresh, setActingFor],
  );

  const resolve = async (row: BoardReportRow, action: "delete" | "dismiss") => {
    await publishAsUser(
      buildResolveReport({ reportEventId: row.report.reportEventId, action }),
      "The server didn't close the report.",
    );
  };

  return {
    rows,
    loading: on && loading,
    error,
    paused,
    refresh,
    acting,
    errors,
    remove: (row, reason) =>
      act(row, async () => {
        if (row.words !== null && !removedHere.current.has(row.report.id)) {
          await publishAsUser(
            moderationDeletionDraft({
              boardId,
              target: row.report.target,
              reason,
            }),
            "The server didn't remove that.",
          );
          removedHere.current.add(row.report.id);
        }
        await resolve(row, "delete");
      }),
    close: (row) => act(row, () => resolve(row, "delete")),
    dismiss: (row) => act(row, () => resolve(row, "dismiss")),
  };
}
