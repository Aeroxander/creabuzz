import * as React from "react";
import { Search, FileText, Plus } from "lucide-react";

import { formatItemTimestamp } from "@/shared/lib/datetime";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { useUpdateContributionReviewMutation } from "../hooks";
import type { ContributionRecord, ReviewStatus } from "../orgModels";
import { ContributionRecordForm } from "./ContributionRecordForm";

type ContributionRecordsTableProps = {
  records: ContributionRecord[];
};

type StatusFilter = "all" | ReviewStatus;

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "appealed", label: "Appealed" },
];

const REVIEW_BADGE_CLASS: Record<ReviewStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  accepted:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-destructive/15 text-destructive",
  appealed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

function humanVsAiLabel(record: ContributionRecord): string {
  const { human, ai } = record.humanVsAi;
  const total = human + ai;
  if (total <= 0) return "—";
  const humanPct = Math.round((human / total) * 100);
  const aiPct = 100 - humanPct;
  return `${humanPct}/${aiPct}`;
}

function DimensionChip({ name, value }: { name: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-2xs">
      <span>{name}</span>
      <span className="font-mono text-muted-foreground">{value}</span>
    </span>
  );
}

function DimensionBar({ name, value }: { name: string; value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-xs">{name}</span>
      <Progress
        aria-label={`${name} dimension score`}
        className="max-w-40"
        value={clamped * 100}
      />
      <span className="font-mono text-2xs text-muted-foreground">{value}</span>
    </div>
  );
}

function ReviewActions({ record }: { record: ContributionRecord }) {
  const mutation = useUpdateContributionReviewMutation();
  const [appealNote, setAppealNote] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const run = (reviewStatus: ReviewStatus, appealNote?: string) => {
    setErrorMessage(null);
    mutation.mutate(
      { dtag: record.dtag, reviewStatus, appealNote },
      {
        onSuccess: () => setAppealNote(""),
        onError: (error) =>
          setErrorMessage(
            error instanceof Error ? error.message : "Review failed.",
          ),
      },
    );
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Review</legend>
      <p className="text-2xs text-muted-foreground">
        Reviewer authority is not verified yet — anyone can publish a review
        until the relay checks a review grant.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={mutation.isPending}
          onClick={() => run("accepted")}
          size="sm"
          type="button"
          variant="outline"
        >
          Accept
        </Button>
        <Button
          disabled={mutation.isPending}
          onClick={() => run("rejected")}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
        <Button
          className="text-amber-700 dark:text-amber-400"
          disabled={mutation.isPending || !appealNote.trim()}
          onClick={() => run("appealed", appealNote.trim())}
          size="sm"
          type="button"
          variant="outline"
        >
          Appeal with note
        </Button>
      </div>
      <div className="space-y-1">
        <label className="sr-only" htmlFor={`appeal-note-${record.dtag}`}>
          Appeal note
        </label>
        <Input
          id={`appeal-note-${record.dtag}`}
          onChange={(event) => setAppealNote(event.target.value)}
          placeholder="Appeal note (required)"
          value={appealNote}
        />
      </div>
      {errorMessage ? (
        <p className="text-xs text-destructive">{errorMessage}</p>
      ) : null}
    </fieldset>
  );
}

function RecordDetailSheet({
  record,
  onOpenChange,
}: {
  record: ContributionRecord | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={record !== null}>
      <SheetContent className="overflow-y-auto sm:max-w-sm">
        <SheetHeader>
          <SheetTitle className="break-words">
            {record?.action || record?.dtag || "Contribution record"}
          </SheetTitle>
          <SheetDescription>
            {record
              ? `Record ${record.dtag} · ${formatItemTimestamp(record.createdAt, { withTime: true })}`
              : ""}
          </SheetDescription>
        </SheetHeader>
        {record ? (
          <div className="mt-2 space-y-4 pb-6">
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-2xs font-medium capitalize ${REVIEW_BADGE_CLASS[record.reviewStatus]}`}
              >
                {record.reviewStatus}
              </span>
              <span className="text-2xs text-muted-foreground">
                human/AI {humanVsAiLabel(record)}
              </span>
            </div>

            <section className="space-y-1.5">
              <h4 className="text-sm font-medium">Dimensions</h4>
              {Object.entries(record.dimensions).length === 0 ? (
                <p className="text-2xs text-muted-foreground">None recorded</p>
              ) : (
                Object.entries(record.dimensions).map(([name, value]) => (
                  <DimensionBar key={name} name={name} value={value} />
                ))
              )}
            </section>

            <section className="space-y-1.5">
              <h4 className="text-sm font-medium">Evidence</h4>
              {record.evidence.length === 0 ? (
                <p className="text-2xs text-muted-foreground">None</p>
              ) : (
                <ul className="space-y-0.5">
                  {record.evidence.map((id) => (
                    <li
                      className="break-all font-mono text-2xs text-muted-foreground"
                      key={id}
                    >
                      {id}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-1.5">
              <h4 className="text-sm font-medium">Informed by</h4>
              {record.informedBy.length === 0 ? (
                <p className="text-2xs text-muted-foreground">Nothing</p>
              ) : (
                <ul className="space-y-0.5">
                  {record.informedBy.map((ref) => (
                    <li
                      className="break-all font-mono text-2xs text-muted-foreground"
                      key={ref}
                    >
                      {ref}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {record.outcome &&
            (record.outcome.effect || record.outcome.harm) ? (
              <section className="space-y-1">
                <h4 className="text-sm font-medium">Outcome</h4>
                {record.outcome.effect ? (
                  <p className="text-xs">{record.outcome.effect}</p>
                ) : null}
                {record.outcome.harm ? (
                  <p className="text-xs text-destructive">
                    {record.outcome.harm}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-1.5">
              <h4 className="text-sm font-medium">Appeal history</h4>
              {record.appealHistory.length === 0 ? (
                <p className="text-2xs text-muted-foreground">None</p>
              ) : (
                <ol className="space-y-1">
                  {record.appealHistory.map((entry) => (
                    <li
                      className="text-2xs text-muted-foreground"
                      key={`${entry.at}-${entry.status}`}
                    >
                      {new Date(entry.at * 1000).toLocaleString()} —{" "}
                      {entry.status}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <ReviewActions record={record} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Phase 3 contribution records table: filterable, searchable, with a detail
 * drawer carrying the review workflow (kind:37013 LWW republish).
 */
export function ContributionRecordsTable({
  records,
}: ContributionRecordsTableProps) {
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [search, setSearch] = React.useState("");
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(
    null,
  );
  const [createOpen, setCreateOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return records.filter((record) => {
      if (statusFilter !== "all" && record.reviewStatus !== statusFilter) {
        return false;
      }
      if (
        needle &&
        !record.action.toLowerCase().includes(needle) &&
        !record.dtag.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
  }, [records, statusFilter, search]);

  const selected = selectedEventId
    ? (records.find((r) => r.eventId === selectedEventId) ?? null)
    : null;

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Contribution Records</h2>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search contribution records"
              className="h-7 w-40 pl-7 text-xs"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search records"
              value={search}
            />
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            variant="outline"
          >
            <Plus className="mr-1 h-3 w-3" />
            Record
          </Button>
        </div>
      </div>

      <nav aria-label="Filter by review status" className="mb-2 flex gap-1.5">
        {STATUS_FILTERS.map((option) => (
          <Button
            aria-pressed={statusFilter === option.value}
            key={option.value}
            onClick={() => setStatusFilter(option.value)}
            size="sm"
            variant={statusFilter === option.value ? "secondary" : "ghost"}
          >
            {option.label}
          </Button>
        ))}
      </nav>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
          <FileText aria-hidden="true" className="h-5 w-5" />
          <p>
            {records.length === 0
              ? "No contribution records yet."
              : "No records match the current filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5 font-medium" scope="col">
                  Action
                </th>
                <th className="px-2 py-1.5 font-medium" scope="col">
                  Dimensions
                </th>
                <th className="px-2 py-1.5 font-medium" scope="col">
                  Human/AI
                </th>
                <th className="px-2 py-1.5 font-medium" scope="col">
                  Status
                </th>
                <th className="px-2 py-1.5 font-medium" scope="col">
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => (
                <tr
                  className="cursor-pointer border-b last:border-b-0 hover:bg-muted/50"
                  data-testid="contribution-row"
                  key={record.eventId}
                  onClick={() => setSelectedEventId(record.eventId)}
                >
                  <td className="max-w-48 truncate px-2 py-1.5">
                    {record.action || record.dtag}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {Object.entries(record.dimensions)
                        .slice(0, 3)
                        .map(([name, value]) => (
                          <DimensionChip key={name} name={name} value={value} />
                        ))}
                      {Object.keys(record.dimensions).length === 0 ? "—" : null}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs">
                    {humanVsAiLabel(record)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-2xs font-medium capitalize ${REVIEW_BADGE_CLASS[record.reviewStatus]}`}
                    >
                      {record.reviewStatus}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-2xs text-muted-foreground">
                    {formatItemTimestamp(record.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RecordDetailSheet
        onOpenChange={(open) => {
          if (!open) setSelectedEventId(null);
        }}
        record={selected}
      />
      <ContributionRecordForm onOpenChange={setCreateOpen} open={createOpen} />
    </div>
  );
}
