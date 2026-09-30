/**
 * Moderation queue state: report rows from the server's moderator-gated
 * reads, the reported authors recovered from the report events, and the
 * moderator actions. Enforcement publishes before the resolve decision (the
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

import { queryEvents } from "@/shared/lib/nostr-client";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import {
  parseModerationReports,
  resolvableActions,
  sortQueue,
  type ModerationReport,
  type ResolutionAction,
} from "./lib/moderationQueue";
import {
  buildBan,
  buildDeleteContent,
  buildResolveReport,
  buildTimeout,
  type EventTemplate,
} from "./lib/moderationEvents";

/** Bounded reads and polling (deadline + manual refresh as the recovery). */
const REPORTS_LIMIT = 30;
const REPORT_EVENTS_LIMIT = 50;
const POLL_MS = 30_000;
const POLL_DEADLINE_MS = 15 * 60_000;

export type ModerationAccess = "granted" | "denied" | "unknown";

async function fetchReports(): Promise<ModerationReport[]> {
  const url = `${relayHttpBaseUrl()}/moderation/reports?limit=${REPORTS_LIMIT}`;
  const auth = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, { headers: { Authorization: auth } });
  if (response.status === 401 || response.status === 403) {
    throw new Error("access denied");
  }
  if (!response.ok) {
    throw new Error(`The server refused the queue (${response.status}).`);
  }
  return parseModerationReports(await response.json());
}

/** Probe once per session: only moderators pass the server's gate. */
let accessProbe: Promise<ModerationAccess> | null = null;

function probeModerationAccess(): Promise<ModerationAccess> {
  if (!accessProbe) {
    accessProbe = fetchReports()
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
  /** Reported message signer, when resolvable from the report event. */
  authorPubkey: string | null;
  actions: ResolutionAction[];
  /** Resolution published by this session (never resurrects the row). */
  locallyResolved: boolean;
};

export type ModerationQueueState = {
  rows: ModerationRow[];
  loading: boolean;
  error: string | null;
  pollPaused: boolean;
  /** In-flight action keys ("<report id>:<action>"). */
  acting: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  perform: (
    report: ModerationReport,
    action: ResolutionAction,
    options?: { expiresAt?: number; reason?: string },
  ) => Promise<void>;
  refresh: () => Promise<void>;
};

export function useModerationQueue(): ModerationQueueState {
  const me = existingUserPubkey();
  const { access } = useModerationAccess();
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [authors, setAuthors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [localResolved, setLocalResolved] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const generationRef = useRef(0);
  const deadlineRef = useRef(Date.now() + POLL_DEADLINE_MS);

  const refresh = useCallback(async () => {
    if (!me || access !== "granted") return;
    const generation = ++generationRef.current;
    deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
    setPollPaused(false);
    try {
      const rows = await fetchReports();
      if (generation !== generationRef.current) return;
      setReports(rows);
      // The queue row drops the reported author at ingest; the report event
      // still carries it in its `p` tag. A failed author read degrades to
      // fewer actions rather than failing the queue.
      try {
        const reportEvents = await queryEvents(relayWsUrl(), {
          kinds: [1984],
          limit: REPORT_EVENTS_LIMIT,
        });
        if (generation !== generationRef.current) return;
        const map = new Map<string, string>();
        for (const event of reportEvents) {
          const author = event.tags.find((tag) => tag[0] === "p")?.[1];
          if (author) map.set(event.id, author.toLowerCase());
        }
        setAuthors(map);
      } catch {
        // Keep the last known authors.
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
  }, [access, me]);

  useEffect(() => {
    if (access !== "granted") {
      setLoading(false);
      return;
    }
    void refresh();
    const id = window.setInterval(() => {
      if (Date.now() >= deadlineRef.current) {
        setPollPaused(true);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [access, refresh]);

  const rows = useMemo<ModerationRow[]>(
    () =>
      sortQueue(reports).map((report) => ({
        report,
        authorPubkey:
          report.targetKind === "pubkey"
            ? report.target
            : (authors.get(report.reportEventId) ?? null),
        actions: resolvableActions(
          report,
          authors.get(report.reportEventId) ?? null,
        ),
        locallyResolved: localResolved.has(report.id),
      })),
    [reports, authors, localResolved],
  );

  const setActingFor = useCallback((key: string, on: boolean) => {
    setActing((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const publishTemplate = useCallback(async (template: EventTemplate) => {
    const event = await signAsUser(template);
    const result = await publishEvent(relayWsUrl(), event, {
      signAuth: signAsUser,
    });
    if (!result.accepted) {
      throw new Error(result.message || "The server rejected the action.");
    }
  }, []);

  /**
   * One moderator decision: enforcement first (delete/timeout/ban), then the
   * resolve-report decision. A failure anywhere keeps the row open with an
   * inline error — the same buttons retry.
   */
  const perform = useCallback(
    async (
      report: ModerationReport,
      action: ResolutionAction,
      options?: { expiresAt?: number; reason?: string },
    ) => {
      const key = `${report.id}:${action}`;
      setActingFor(key, true);
      setErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      try {
        const author = authors.get(report.reportEventId) ?? null;
        const target = report.targetKind === "pubkey" ? report.target : author;
        if (action === "delete") {
          if (!report.channelId) {
            throw new Error("This report has no channel to delete from.");
          }
          await publishTemplate(
            buildDeleteContent({
              channelId: report.channelId,
              eventId: report.target,
            }),
          );
        } else if (action === "timeout") {
          if (!target || !options?.expiresAt) {
            throw new Error("Couldn’t resolve who to time out.");
          }
          await publishTemplate(
            buildTimeout({ pubkey: target, expiresAt: options.expiresAt }),
          );
        } else if (action === "ban") {
          if (!target) {
            throw new Error("Couldn’t resolve who to ban.");
          }
          await publishTemplate(buildBan({ pubkey: target }));
        }
        await publishTemplate(
          buildResolveReport({
            reportEventId: report.reportEventId,
            action,
            reason: options?.reason,
          }),
        );
        setLocalResolved((current) => {
          const next = new Set(current);
          next.add(report.id);
          return next;
        });
        void refresh();
      } catch (error) {
        setErrors((current) =>
          new Map(current).set(
            key,
            error instanceof Error && error.message
              ? error.message
              : "Couldn’t apply the action. Try again.",
          ),
        );
      } finally {
        setActingFor(key, false);
      }
    },
    [authors, publishTemplate, refresh, setActingFor],
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
  };
}
