/**
 * Escalated reports for the server's operators. The server says where its admin API lives (`admin_api` in its info
 * document); a signed probe there tells whether this person is one of the people who run it. Only then is the list read
 * and shown: the admin API refuses everyone else, so nobody else ever receives a row.
 *
 * An action on an escalated report reopens it, then resolves it with the action (the admin API resolves open reports
 * only). The reopen is fenced to a report that is still escalated, so one someone else has dealt with since the list
 * was read is refused, never reopened and acted on again; its row then says so and the list is read again. If the
 * resolve fails after the reopen, the report is open again, where the community's moderators can also see it; the row
 * stays (the server's escalated list no longer has it), keeps the failure, and the same button retries the resolve
 * alone, with the same retry key.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useBoundedPoll } from "@/shared/hooks/use-bounded-poll";
import { existingUserPubkey } from "@/shared/lib/identity";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { isServerTimeout, timedFetchStreamed } from "@/shared/lib/timed-fetch";
import {
  ADMIN_API_PREFIX,
  adminOriginFromInfo,
  dealtWithElsewhere,
  type DoneOutcome,
  type EscalatedEntry,
  type EscalatedReport,
  type EscalatedRow,
  escalatedAgain,
  escalatedListUrl,
  escalatedRows,
  isOperatorProbe,
  type OperatorAction,
  parseEscalatedReports,
  refusalMessage,
  refusalWords,
  reopenBody,
  reportedWords,
  resolveBody,
} from "./lib/escalatedReports";

const POLL_MS = 60_000;

class Refused extends Error {
  constructor(
    public status: number,
    public serverMessage: string | null,
  ) {
    super(refusalWords(status, serverMessage));
  }
}

async function adminFetch(
  url: string,
  method: "GET" | "POST",
  body?: Record<string, string>,
): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const auth = await makeNip98AuthHeader(url, method, { body: payload });
  const response = await timedFetchStreamed(url, {
    method,
    headers: {
      Authorization: auth,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload,
  });
  // An unreadable body is no body; one that never finished is a failed read (never an empty list or a refusal).
  const json: unknown = await response.json().catch((error: unknown) => {
    if (isServerTimeout(error)) throw error;
    return null;
  });
  if (!response.ok) throw new Refused(response.status, refusalMessage(json));
  return json;
}

/** Where the admin API is, and whether this person is an operator there. Probed once per page and signer. */
let operatorProbe: { key: string; answer: Promise<string | null> } | null =
  null;

function probeOperator(me: string): Promise<string | null> {
  const key = `${relayHttpBaseUrl()}|${me}`;
  if (operatorProbe?.key !== key) {
    const answer = (async () => {
      const info = await timedFetchStreamed(`${relayHttpBaseUrl()}/info`, {
        headers: { Accept: "application/nostr+json" },
      });
      if (!info.ok) return null;
      // A document that never finished is a failed check (asked again next time), not "no admin API here".
      const origin = adminOriginFromInfo(
        await info.json().catch((error: unknown) => {
          if (isServerTimeout(error)) throw error;
          return null;
        }),
      );
      if (!origin) return null;
      const probe = await adminFetch(
        `${origin}${ADMIN_API_PREFIX}/probe`,
        "GET",
      );
      return isOperatorProbe(probe) ? origin : null;
    })().catch((error: unknown) => {
      // A refusal is an answer; a failed check is not, so the next time the queue opens asks again.
      if (!(error instanceof Refused) && operatorProbe?.key === key)
        operatorProbe = null;
      return null;
    });
    operatorProbe = { key, answer };
  }
  return operatorProbe.answer;
}

/** The admin origin when the signed-in person runs this server, else null (also while it is being checked). */
export function useOperatorOrigin(): string | null {
  const me = existingUserPubkey();
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    void probeOperator(me).then((answer) => {
      if (!cancelled) setOrigin(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [me]);
  return origin;
}

export type EscalatedReportsState = {
  rows: EscalatedRow[];
  loading: boolean;
  error: string | null;
  acting: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  /** Resolves to null when it went through, else what went wrong. */
  perform: (
    report: EscalatedReport,
    action: OperatorAction,
    reason?: string,
  ) => Promise<string | null>;
  refresh: () => Promise<void>;
};

export function useEscalatedReports(
  origin: string | null,
): EscalatedReportsState {
  const [listed, setListed] = useState<EscalatedEntry[]>([]);
  // Done here: kept on screen with what was done after the server's list no longer has them.
  const [done, setDone] = useState<
    ReadonlyMap<string, EscalatedEntry & { action: DoneOutcome }>
  >(() => new Map());
  // Reopened here and not yet resolved: kept on screen, with their error and retry, though the server lists them no more.
  const [reopenedRows, setReopenedRows] = useState<
    ReadonlyMap<string, EscalatedEntry>
  >(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const generation = useRef(0);
  // Reports this operator reopened whose resolve has not gone through: a retry resolves without reopening again.
  const reopened = useRef(new Set<string>());
  // One retry key per report and action, so a retried removal or ban never acts twice.
  const requestIds = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    if (!origin) return;
    const mine = ++generation.current;
    try {
      const reports = parseEscalatedReports(
        await adminFetch(escalatedListUrl(origin), "GET"),
      );
      // The words are in each report's detail; a failed read leaves the row without them, never the list.
      const words = await Promise.all(
        reports.map((report) =>
          report.targetKind === "event"
            ? adminFetch(
                `${origin}${ADMIN_API_PREFIX}/reports/${report.id}`,
                "GET",
              )
                .then(reportedWords)
                .catch(() => null)
            : Promise.resolve(null),
        ),
      );
      if (mine !== generation.current) return;
      // A settled report escalated again since is listed afresh, with its actions.
      setDone((current) => {
        let next: Map<string, EscalatedEntry & { action: DoneOutcome }> | null =
          null;
        for (const report of reports) {
          const settled = current.get(report.id);
          if (settled && escalatedAgain(settled.report, report)) {
            next ??= new Map(current);
            next.delete(report.id);
          }
        }
        return next ?? current;
      });
      setListed(
        reports.map((report, at) => ({ report, words: words[at] ?? null })),
      );
      setError(null);
    } catch {
      if (mine !== generation.current) return;
      setError(
        "Couldn’t load the escalated reports. Check your connection, then refresh.",
      );
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [origin]);

  const { refresh } = useBoundedPoll(load, origin !== null, POLL_MS);

  // A settled report: its retry keys go, so the same report escalated again later is reopened and acted on afresh.
  const settle = useCallback(
    (report: EscalatedReport, outcome: DoneOutcome) => {
      reopened.current.delete(report.id);
      setReopenedRows((current) => {
        if (!current.has(report.id)) return current;
        const next = new Map(current);
        next.delete(report.id);
        return next;
      });
      for (const key of [...requestIds.current.keys()])
        if (key.startsWith(`${report.id}:`)) requestIds.current.delete(key);
      setErrors((current) => {
        const next = new Map(current);
        for (const key of current.keys())
          if (key.startsWith(`${report.id}:`)) next.delete(key);
        return next;
      });
      const words =
        listed.find((entry) => entry.report.id === report.id)?.words ?? null;
      setDone((current) =>
        new Map(current).set(report.id, { report, words, action: outcome }),
      );
    },
    [listed],
  );

  const perform = useCallback(
    async (
      report: EscalatedReport,
      action: OperatorAction,
      reason?: string,
    ) => {
      if (!origin) return "Couldn’t apply the action. Try again.";
      const key = `${report.id}:${action}`;
      setActing((current) => new Set(current).add(key));
      setErrors((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      let requestId = requestIds.current.get(key);
      if (!requestId) {
        requestId = crypto.randomUUID();
        requestIds.current.set(key, requestId);
      }
      const base = `${origin}${ADMIN_API_PREFIX}/reports/${report.id}`;
      try {
        if (!reopened.current.has(report.id)) {
          let reopenId = requestIds.current.get(`${report.id}:reopen`);
          if (!reopenId) {
            reopenId = crypto.randomUUID();
            requestIds.current.set(`${report.id}:reopen`, reopenId);
          }
          await adminFetch(`${base}/reopen`, "POST", reopenBody(reopenId));
          reopened.current.add(report.id);
          const words =
            listed.find((entry) => entry.report.id === report.id)?.words ??
            null;
          setReopenedRows((current) =>
            new Map(current).set(report.id, { report, words }),
          );
        }
        await adminFetch(
          `${base}/resolve`,
          "POST",
          resolveBody(action, requestId, reason),
        );
        settle(report, action);
        void refresh();
        return null;
      } catch (actionError) {
        if (
          actionError instanceof Refused &&
          dealtWithElsewhere(actionError.status, actionError.serverMessage)
        ) {
          // Nothing was done here: the row says someone else dealt with it, and the list is read again.
          settle(report, "elsewhere");
          void refresh();
          return null;
        }
        const said =
          actionError instanceof Refused
            ? actionError.message
            : "Couldn’t apply the action. Check your connection, then try again.";
        setErrors((current) => new Map(current).set(key, said));
        return said;
      } finally {
        setActing((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [origin, refresh, settle, listed],
  );

  const rows = escalatedRows(listed, done, reopenedRows);

  return { rows, loading, error, acting, errors, perform, refresh };
}
