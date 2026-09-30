/**
 * Moderation queue domain logic: mapping the server's report rows (the same
 * wire contract the desktop moderation surface reads) plus the triage math
 * the queue panel dispatches on. Pure and hook-free so it is unit-testable
 * without a connection.
 *
 * Privacy invariant: `reporterPubkey` is moderator-only. Nothing in this
 * module may feed a surface the reported author can see.
 */

/** NIP-56 report categories accepted at ingest. */
export type ReportType =
  | "illegal"
  | "nudity"
  | "malware"
  | "spam"
  | "impersonation"
  | "profanity"
  | "other";

export type ReportStatus = "open" | "resolved" | "dismissed" | "escalated";

export type ReportTargetKind = "event" | "pubkey" | "blob";

/** A moderator's disposition of a queued report (resolve-report command). */
export type ResolutionAction =
  | "delete"
  | "timeout"
  | "ban"
  | "dismiss"
  | "escalate";

export type ModerationReport = {
  id: string;
  /** Event id of the kind:1984 report — the resolve command's reference. */
  reportEventId: string;
  reporterPubkey: string;
  targetKind: ReportTargetKind;
  target: string;
  channelId: string | null;
  reportType: ReportType;
  note: string | null;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const REPORT_TYPES: readonly string[] = [
  "illegal",
  "nudity",
  "malware",
  "spam",
  "impersonation",
  "profanity",
  "other",
];

const REPORT_STATUSES: readonly string[] = [
  "open",
  "resolved",
  "dismissed",
  "escalated",
];

const TARGET_KINDS: readonly string[] = ["event", "pubkey", "blob"];

function parseReport(raw: unknown): ModerationReport | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = asString(row.id);
  const reportEventId = asString(row.report_event_id);
  const reporterPubkey = asString(row.reporter_pubkey);
  const target = asString(row.target);
  if (!id || !reportEventId || !reporterPubkey || !target) return null;
  const targetKind = asString(row.target_kind);
  const reportType = asString(row.report_type);
  const status = asString(row.status);
  return {
    id,
    reportEventId,
    reporterPubkey,
    targetKind: (targetKind && TARGET_KINDS.includes(targetKind)
      ? targetKind
      : "event") as ReportTargetKind,
    target,
    channelId: asString(row.channel_id),
    reportType: (reportType && REPORT_TYPES.includes(reportType)
      ? reportType
      : "other") as ReportType,
    note: asString(row.note),
    status: (status && REPORT_STATUSES.includes(status)
      ? status
      : "open") as ReportStatus,
    resolvedBy: asString(row.resolved_by),
    resolvedAt: asString(row.resolved_at),
    createdAt: asString(row.created_at) ?? "",
  };
}

/** Parse a `GET /moderation/reports` body (array of snake_case rows). */
export function parseModerationReports(json: unknown): ModerationReport[] {
  if (!Array.isArray(json)) return [];
  return json
    .map(parseReport)
    .filter((row): row is ModerationReport => row !== null);
}

const SEVERITY_RANK: Record<ReportType, number> = {
  illegal: 6,
  malware: 5,
  impersonation: 4,
  nudity: 3,
  spam: 2,
  profanity: 1,
  other: 0,
};

export function reportSeverity(reportType: ReportType): number {
  return SEVERITY_RANK[reportType] ?? 0;
}

/** Open actionable rows first (severity, then newest); closed rows last. */
export function sortQueue(
  rows: readonly ModerationReport[],
): ModerationReport[] {
  return [...rows].sort((a, b) => {
    const aOpen = a.status === "open" ? 1 : 0;
    const bOpen = b.status === "open" ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    const bySeverity =
      reportSeverity(b.reportType) - reportSeverity(a.reportType);
    if (bySeverity !== 0) return bySeverity;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  illegal: "Illegal content",
  nudity: "Nudity",
  malware: "Malware",
  spam: "Spam",
  impersonation: "Impersonation",
  profanity: "Profanity",
  other: "Other",
};

export function reportTypeLabel(reportType: ReportType): string {
  return REPORT_TYPE_LABEL[reportType] ?? "Other";
}

const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
  escalated: "Escalated",
};

export function reportStatusLabel(status: ReportStatus): string {
  return REPORT_STATUS_LABEL[status] ?? "Open";
}

const TARGET_LABEL: Record<ReportTargetKind, string> = {
  event: "a message",
  pubkey: "a member",
  blob: "a file",
};

export function reportTargetLabel(targetKind: ReportTargetKind): string {
  return TARGET_LABEL[targetKind] ?? "content";
}

/**
 * Which moderator actions this row can carry right now. Delete needs an
 * event target in a channel; ban and timeout need a resolvable author
 * (a member target, or the reported message's signer). Dismiss and escalate
 * are pure decisions and always available on open rows.
 */
export function resolvableActions(
  report: ModerationReport,
  authorPubkey: string | null,
): ResolutionAction[] {
  if (report.status !== "open") return [];
  const actions: ResolutionAction[] = [];
  if (report.targetKind === "event" && report.channelId) {
    actions.push("delete");
  }
  if (report.targetKind === "pubkey" || authorPubkey) {
    actions.push("timeout", "ban");
  }
  actions.push("dismiss", "escalate");
  return actions;
}

/** The enforcement target for ban/timeout: the member, or the message signer. */
export function enforcementTarget(
  report: ModerationReport,
  authorByReport: ReadonlyMap<string, string>,
): string | null {
  if (report.targetKind === "pubkey") return report.target;
  return authorByReport.get(report.reportEventId) ?? null;
}
