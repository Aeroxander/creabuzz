/**
 * Escalated reports for the people who run the server (its operators): the reports a community's moderators passed on,
 * read from the server's admin API, and what an operator can do about each. The admin API checks every request itself,
 * so someone who is not an operator is refused and never sees a row; this module only shapes what an operator reads.
 *
 * Pure and alias-free; `escalatedReports.test.mjs` drives it under `node --test`.
 */

import { type ReportType, reportTypeLabel } from "./moderationQueue.ts";

/** Where the admin API lives under the origin the server advertises (`admin_api` in its info document). */
export const ADMIN_API_PREFIX = "/api/admin/v1";

/** One read of escalated reports, newest first. The pilot's servers have a handful; this is the cap. */
const ESCALATED_PAGE = 25;

/** The admin origin the server advertises in its info document, or null when it runs no admin API. */
export function adminOriginFromInfo(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  const origin = (info as { admin_api?: unknown }).admin_api;
  if (typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether the probe's answer makes this person an operator here: a signed, named member of the server's staff who may
 * act. A server whose admin API checks no identity (`disabled`) never counts, so its reports are never shown in a page.
 */
export function isOperatorProbe(probe: unknown): boolean {
  if (typeof probe !== "object" || probe === null) return false;
  const { authMode, canAct } = probe as {
    authMode?: unknown;
    canAct?: unknown;
  };
  return authMode === "nip98" && canAct === true;
}

export type EscalatedReport = {
  id: string;
  communityHost: string;
  reporterPubkey: string;
  targetKind: "event" | "pubkey" | "blob";
  target: string;
  /** Who wrote the reported words, when the report is about a post or message. */
  targetAuthor: string | null;
  /** The room or board, or null for a Home post. */
  channelId: string | null;
  reportType: ReportType;
  note: string | null;
  /** When it was passed on: the decision time, or when it was made for a report that arrived escalated. */
  escalatedAt: string;
};

const REPORT_TYPES: readonly string[] = [
  "illegal",
  "nudity",
  "malware",
  "spam",
  "impersonation",
  "profanity",
  "other",
];

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseRow(raw: unknown): EscalatedReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = text(row.id);
  const communityHost = text(row.communityHost);
  const reporterPubkey = text(row.reporterPubkey);
  const target = text(row.target);
  const createdAt = text(row.createdAt);
  // The list is of escalated reports; anything else in the answer is not one.
  if (
    !id ||
    !communityHost ||
    !reporterPubkey ||
    !target ||
    !createdAt ||
    row.status !== "escalated"
  )
    return null;
  const kind = text(row.targetKind);
  const type = text(row.reportType);
  return {
    id,
    communityHost,
    reporterPubkey,
    targetKind: kind === "pubkey" || kind === "blob" ? kind : "event",
    target,
    targetAuthor: text(row.targetAuthorPubkey),
    channelId: text(row.channelId),
    reportType: (type && REPORT_TYPES.includes(type)
      ? type
      : "other") as ReportType,
    note: text(row.note),
    escalatedAt: text(row.resolvedAt) ?? createdAt,
  };
}

/** Parse the admin API's report list (camelCase rows). */
export function parseEscalatedReports(json: unknown): EscalatedReport[] {
  if (!Array.isArray(json)) return [];
  return json
    .map(parseRow)
    .filter((row): row is EscalatedReport => row !== null);
}

/** The reported words, from the admin API's report detail, or null when it holds none. */
export function reportedWords(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const message = (detail as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  return text((message as { content?: unknown }).content);
}

/** The escalated-reports read. */
export function escalatedListUrl(adminOrigin: string): string {
  return `${adminOrigin}${ADMIN_API_PREFIX}/reports?status=escalated&limit=${ESCALATED_PAGE}`;
}

/** What an operator can do with an escalated report. */
export type OperatorAction = "delete" | "ban" | "dismiss";

/**
 * The actions a row carries: remove the reported post or message, ban whoever wrote it (or the reported person), or
 * close it with nothing done. A report about a file can only be closed.
 */
export function operatorActions(report: EscalatedReport): OperatorAction[] {
  const actions: OperatorAction[] = [];
  if (report.targetKind === "event") actions.push("delete");
  if (personOf(report)) actions.push("ban");
  actions.push("dismiss");
  return actions;
}

/** Whom a ban from this row is against. */
export function personOf(report: EscalatedReport): string | null {
  if (report.targetKind === "pubkey") return report.target;
  if (report.targetKind === "event") return report.targetAuthor;
  return null;
}

/** What the report is about, as the row's heading says it. */
export function aboutLine(report: EscalatedReport): string {
  const about =
    report.targetKind === "pubkey"
      ? "a member"
      : report.targetKind === "blob"
        ? "a file"
        : report.channelId === null
          ? "a post on Home"
          : "a message or board post";
  return `${reportTypeLabel(report.reportType)} · about ${about}`;
}

/**
 * The body an action sends to resolve the report. Removal and bans carry an idempotency key (`requestId`), kept for
 * retries of the same action so a retry never acts twice.
 */
export function resolveBody(
  action: OperatorAction,
  requestId: string,
  reason: string | undefined,
): Record<string, string> {
  const body: Record<string, string> = { action };
  if (action !== "dismiss") body.requestId = requestId;
  if (reason) body.reason = reason;
  return body;
}

/** How a row ended for this operator: their action went through, or someone else had already dealt with it. */
export type DoneOutcome = OperatorAction | "elsewhere";

/** A report as the operator's list holds it: the report and, when the server still has them, the reported words. */
export type EscalatedEntry = { report: EscalatedReport; words: string | null };

export type EscalatedRow = EscalatedEntry & {
  /** How it ended for this operator: what they did, or that someone else had already dealt with it. */
  done: DoneOutcome | null;
};

/**
 * The rows the operator sees: the server's escalated list, then reports settled here, then reports this operator
 * reopened whose resolve has not gone through. Those are open again, so the server's list no longer has them, but each
 * keeps its row, with its error and the button that retries the resolve, until it settles.
 */
export function escalatedRows(
  listed: readonly EscalatedEntry[],
  done: ReadonlyMap<string, EscalatedEntry & { action: DoneOutcome }>,
  reopened: ReadonlyMap<string, EscalatedEntry>,
): EscalatedRow[] {
  const shown = new Set(listed.map((entry) => entry.report.id));
  const rows: EscalatedRow[] = listed.map((entry) => ({
    ...entry,
    done: done.get(entry.report.id)?.action ?? null,
  }));
  for (const entry of done.values()) {
    if (shown.has(entry.report.id)) continue;
    shown.add(entry.report.id);
    rows.push({ report: entry.report, words: entry.words, done: entry.action });
  }
  for (const entry of reopened.values()) {
    if (shown.has(entry.report.id)) continue;
    rows.push({ ...entry, done: null });
  }
  return rows;
}

/** What a row says once it is settled. */
export function doneLine(outcome: DoneOutcome): string {
  if (outcome === "delete") return "Removed, and the report closed.";
  if (outcome === "ban") return "Banned, and the report closed.";
  if (outcome === "elsewhere")
    return "Someone has already dealt with this report.";
  return "Closed with nothing done.";
}

/**
 * Whether a refusal means the report is no longer where the operator's list showed it: the reopen was refused because
 * it is not escalated any more, or the resolve because it is not open. Nothing was done, and the row is settled.
 */
export function dealtWithElsewhere(
  status: number,
  message: string | null,
): boolean {
  return (
    status === 409 && !!message && /not open|not reopenable/i.test(message)
  );
}

/**
 * The body that takes up an escalated report. It reopens the report only while it is still escalated: the operator's
 * list may be a minute old, or open in another tab, and a report someone has dealt with since must be refused, never
 * reopened and acted on again. The retry key names this reopen, so a retried request still succeeds.
 */
export function reopenBody(requestId: string): Record<string, string> {
  return {
    requestId,
    reason: "Taken up by the server’s owner",
    expectStatus: "escalated",
  };
}

/**
 * Whether a report this operator settled is back on the server's list because it was escalated again since (a
 * community's moderators reopened it and sent it on again). Its settled row then gives way to the listed one.
 */
export function escalatedAgain(
  settled: EscalatedReport,
  listed: EscalatedReport,
): boolean {
  const before = Date.parse(settled.escalatedAt);
  const now = Date.parse(listed.escalatedAt);
  return Number.isFinite(before) && Number.isFinite(now) && now > before;
}

/** A refusal from the admin API, in words for the operator. */
export function refusalWords(status: number, message: string | null): string {
  if (dealtWithElsewhere(status, message)) {
    return "Someone has already dealt with this report. Refresh to see where it stands.";
  }
  if (status === 401 || status === 403) {
    return "The server didn’t accept you as one of the people who run it. Sign in with that key and try again.";
  }
  return "Couldn’t apply the action. Try again.";
}

/** The status line a community's moderators see on a report they escalated: who has it, and that it waits on them. */
export const ESCALATED_STATUS_LINE =
  "Sent to the server’s owner. They haven’t acted on it yet.";

/** The message in an admin API refusal (`{ error: { message } }`), or null. */
export function refusalMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  return text((error as { message?: unknown }).message);
}
