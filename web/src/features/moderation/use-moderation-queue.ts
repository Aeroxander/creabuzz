/**
 * Moderation queue state: report rows from the server's moderator-gated
 * reads (all, open or escalated; a page at a time, "Show older" for more),
 * the reported words and their authors read by id, and the moderator
 * actions. Enforcement publishes before the resolve decision (the
 * resolve reports "reviewed and acted on", so it must not fire first —
 * matching the desktop moderation surface), and a failed publish leaves the
 * row open with an inline retry instead of a false resolution.
 *
 * Reads are NIP-98-authenticated and the server enforces moderator
 * authorization; the UI additionally hides action affordances unless the
 * access probe succeeds, so non-moderators never see buttons they cannot
 * use.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { timedFetchStreamed } from "@/shared/lib/timed-fetch";
import { existingUserPubkey } from "@/shared/lib/identity";
import { useActionTracker } from "@/shared/hooks/use-action-tracker";
import { useBoundedPoll } from "@/shared/hooks/use-bounded-poll";
import {
  isHomePostReport,
  parseModerationReports,
  resolvableActions,
  sortQueue,
  type ModerationReport,
  type ReportStatus,
  type ResolutionAction,
} from "./lib/moderationQueue";
import {
  mayHaveOlder,
  olderLimit,
  personToAct,
  QUEUE_PAGE,
  type QueueFilter,
  queueUrl,
  REPORTED_WORD_KINDS,
  type ReportedSubject,
  reportedSubject,
  shownStatus,
  statusAfter,
  WORDS_READ_CHUNK,
  withDecided,
} from "./lib/queueRow";
import {
  buildBan,
  buildDeleteContent,
  buildResolveReport,
  buildTimeout,
  type EventTemplate,
} from "./lib/moderationEvents";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { failureWords } from "@/shared/lib/readable-error";

/** Bounded reads and polling (deadline + manual refresh as the recovery). */
const POLL_MS = 30_000;
const FAILED = "Couldn’t apply the action. Try again.";

export type ModerationAccess = "granted" | "denied" | "unknown";

async function fetchReports(
  filter: QueueFilter,
  limit: number,
): Promise<ModerationReport[]> {
  const url = queueUrl(relayHttpBaseUrl(), filter, limit);
  const auth = await makeNip98AuthHeader(url, "GET");
  const response = await timedFetchStreamed(url, {
    headers: { Authorization: auth },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("access denied");
  }
  if (!response.ok) {
    throw new Error(`The server refused the queue (${response.status}).`);
  }
  return parseModerationReports(await response.json());
}

/** The reported words still on the server, read by id in bounded chunks. Throws when any read fails. */
async function readReportedWords(
  ids: readonly string[],
): Promise<NostrEvent[]> {
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += WORDS_READ_CHUNK) {
    chunks.push(ids.slice(at, at + WORDS_READ_CHUNK));
  }
  const found = await Promise.all(
    chunks.map((chunk) =>
      queryEvents(relayWsUrl(), {
        ids: chunk,
        kinds: REPORTED_WORD_KINDS,
        limit: chunk.length,
      }),
    ),
  );
  return found.flat();
}

/** Probe once per session: only moderators pass the server's gate. */
let accessProbe: Promise<ModerationAccess> | null = null;

function probeModerationAccess(): Promise<ModerationAccess> {
  if (!accessProbe) {
    accessProbe = fetchReports("all", QUEUE_PAGE)
      .then(() => "granted" as const)
      .catch((error: unknown) =>
        error instanceof Error && error.message === "access denied"
          ? ("denied" as const)
          : ("unknown" as const),
      );
  }
  return accessProbe;
}

export function useModerationAccess(): {
  access: ModerationAccess;
  loading: boolean;
} {
  const [access, setAccess] = useState<ModerationAccess | null>(null);
  useEffect(() => {
    let cancelled = false;
    void probeModerationAccess().then((result) => {
      if (!cancelled) setAccess(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { access: access ?? "unknown", loading: access === null };
}

export type ModerationRow = {
  report: ModerationReport;
  /** What it is about: the reported words and their author, the reported person, or why neither is shown. */
  subject: ReportedSubject;
  /** Whom a ban or timeout from this row is against, when known. */
  person: string | null;
  actions: ResolutionAction[];
  /** The status shown: the server's, or what this reader just decided. */
  status: ReportStatus;
};

export type ModerationQueueState = {
  rows: ModerationRow[];
  loading: boolean;
  error: string | null;
  pollPaused: boolean;
  /** In-flight action keys ("<report id>:<action>"). */
  acting: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  /** Resolves to null when it went through, else what went wrong. */
  perform: (
    row: ModerationRow,
    action: ResolutionAction,
    options?: { expiresAt?: number; reason?: string },
  ) => Promise<string | null>;
  refresh: () => Promise<void>;
  filter: QueueFilter;
  setFilter: (filter: QueueFilter) => void;
  /** The server filled the page: there may be older reports. */
  hasOlder: boolean;
  /** A read with a bigger page is on its way. */
  loadingOlder: boolean;
  showOlder: () => void;
};

/** `roomPath` is the community page a reported room message opens on. */
export function useModerationQueue(roomPath: string): ModerationQueueState {
  const me = existingUserPubkey();
  const { access } = useModerationAccess();
  const [filter, setFilterState] = useState<QueueFilter>("all");
  const [limit, setLimit] = useState(QUEUE_PAGE);
  const [page, setPage] = useState<{
    reports: ModerationReport[];
    limit: number;
  }>({ reports: [], limit: 0 });
  const [words, setWords] = useState<{
    events: ReadonlyMap<string, NostrEvent>;
    read: ReadonlySet<string>;
  }>(() => ({ events: new Map(), read: new Set() }));
  // Reports this reader decided since the filter was chosen, with the status the decision left them in.
  const [decided, setDecided] = useState<
    ReadonlyMap<string, { report: ModerationReport; status: ReportStatus }>
  >(() => new Map());
  const { acting, errors, setActingFor, clearError, failSaying } =
    useActionTracker();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  // Bumped when the filter changes: a decision still on its way must not land in the new filter's list.
  const filterGenerationRef = useRef(0);
  // The reads below also cover the reports decided here that the page may no longer have.
  const decidedRef = useRef(decided);
  decidedRef.current = decided;

  const load = useCallback(async () => {
    if (!me || access !== "granted") return;
    const generation = ++generationRef.current;
    try {
      const reports = await fetchReports(filter, limit);
      // The report row names its target, not what it said or who said it: read the reported words by id. A failed read
      // leaves those rows saying the words could not be read, never that they are gone.
      const listed = withDecided(
        reports,
        [...decidedRef.current.values()].map((entry) => entry.report),
      );
      const ids = [
        ...new Set(
          listed.filter((r) => r.targetKind === "event").map((r) => r.target),
        ),
      ];
      let found: NostrEvent[] | null = null;
      try {
        found = ids.length === 0 ? [] : await readReportedWords(ids);
      } catch {
        found = null;
      }
      if (generation !== generationRef.current) return;
      setPage({ reports, limit });
      if (found !== null) {
        const events = new Map(found.map((event) => [event.id, event]));
        setWords({ events, read: new Set(ids) });
      } else {
        setWords((current) => ({ events: current.events, read: new Set() }));
      }
      setError(null);
    } catch (fetchError) {
      if (generation !== generationRef.current) return;
      setError(
        fetchError instanceof Error && fetchError.message === "access denied"
          ? "Only community moderators can review reports."
          : "Couldn’t load the report queue. Check your connection, then refresh.",
      );
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [access, me, filter, limit]);

  const { paused: pollPaused, refresh } = useBoundedPoll(
    load,
    access === "granted",
    POLL_MS,
  );

  useEffect(() => {
    if (access !== "granted") setLoading(false);
  }, [access]);

  const setFilter = useCallback((next: QueueFilter) => {
    // A read for the old filter still on its way must not land in the new one.
    generationRef.current += 1;
    filterGenerationRef.current += 1;
    setFilterState(next);
    setLimit(QUEUE_PAGE);
    setDecided(new Map());
    setPage({ reports: [], limit: 0 });
    setLoading(true);
  }, []);

  const rows = useMemo<ModerationRow[]>(
    () =>
      sortQueue(
        withDecided(
          page.reports,
          [...decided.values()].map((entry) => entry.report),
        ),
      ).map((report) => {
        const subject = reportedSubject(
          report,
          words.events,
          words.read,
          roomPath,
        );
        const person = personToAct(subject);
        const status = shownStatus(report, decided.get(report.id)?.status);
        return {
          report,
          subject,
          person,
          status,
          actions: status === "open" ? resolvableActions(report, person) : [],
        };
      }),
    [page.reports, words, decided, roomPath],
  );

  // A refusal arrives as `publishAsUser` says it (a restriction in plain words, any other reason as the server gave
  // it); `perform` puts it in words for people, so the server's internal failures never reach the row.
  const publishTemplate = useCallback(async (template: EventTemplate) => {
    await publishAsUser(
      template,
      "The server did not accept the action. Try again.",
    );
  }, []);

  /**
   * One moderator decision: enforcement first (delete/timeout/ban), then the
   * resolve-report decision. A failure anywhere keeps the row open with an
   * inline error — the same buttons retry.
   */
  const perform = useCallback(
    async (
      row: ModerationRow,
      action: ResolutionAction,
      options?: { expiresAt?: number; reason?: string },
    ): Promise<string | null> => {
      const { report, person } = row;
      const key = `${report.id}:${action}`;
      const filterGeneration = filterGenerationRef.current;
      setActingFor(key, true);
      clearError(key);
      try {
        if (action === "delete") {
          // A Home post has no room: its removal closes the open reports
          // about it on the server, in the same commit.
          await publishTemplate(
            buildDeleteContent({
              channelId: report.channelId,
              eventId: report.target,
              reason: options?.reason,
            }),
          );
        } else if (action === "timeout") {
          if (!person || !options?.expiresAt) {
            throw new Error(
              "Couldn’t tell who wrote this, so they can’t be muted here. The report is still open.",
            );
          }
          await publishTemplate(
            buildTimeout({ pubkey: person, expiresAt: options.expiresAt }),
          );
        } else if (action === "ban") {
          if (!person) {
            throw new Error(
              "Couldn’t tell who wrote this, so they can’t be banned here. The report is still open.",
            );
          }
          await publishTemplate(buildBan({ pubkey: person }));
        }
        try {
          await publishTemplate(
            buildResolveReport({
              reportEventId: report.reportEventId,
              action,
              reason: options?.reason,
            }),
          );
        } catch (resolveError) {
          // A Home removal already closed this report; resolving it again is
          // refused as not open. Still sent, for a post that was gone before
          // (that removal closed nothing).
          if (
            !(
              action === "delete" &&
              isHomePostReport(report) &&
              resolveError instanceof Error &&
              /report is not open/i.test(resolveError.message)
            )
          )
            throw resolveError;
        }
        if (filterGeneration === filterGenerationRef.current) {
          setDecided((current) =>
            new Map(current).set(report.id, {
              report,
              status: statusAfter(action),
            }),
          );
        }
        void refresh();
        return null;
      } catch (error) {
        const said = failureWords(error, FAILED).text;
        failSaying(key, said);
        return said;
      } finally {
        setActingFor(key, false);
      }
    },
    [clearError, failSaying, publishTemplate, refresh, setActingFor],
  );

  return {
    rows,
    loading,
    error,
    pollPaused,
    acting,
    errors,
    perform,
    refresh,
    filter,
    setFilter,
    hasOlder: mayHaveOlder(page.reports.length, page.limit),
    loadingOlder: page.limit > 0 && page.limit < limit,
    showOlder: () => setLimit((current) => olderLimit(current)),
  };
}
