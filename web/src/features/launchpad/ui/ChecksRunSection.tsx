/**
 * "Checks run" — the reviewer's view of a claim's check-run records, rendered
 * beside the evidence in WorkTab. Three things stay three blocks here: the
 * supplied descriptions are the EvidenceBlock's text above; these executed
 * results — the publisher's own bounded runs — live here with their
 * summaries always derived from what the checks list adds up to; and any
 * model interpretation stays in its own clearly-named block at the end.
 *
 * Truthfulness rules this section holds:
 * - a record is shown only when it was verified (signature first, in
 *   `check-runs.ts`) and binds this claim's mandate, claim id and evidence
 *   hash — never a wrong-context record with a colliding id;
 * - the sandbox report is the publisher's report, never an attestation, and
 *   the publisher is named (their key, the time, the record) with no
 *   assumption that the publisher is the contributor;
 * - "nothing found" says what the page asked and that it cannot tell
 *   whether any checks were run — never "the contributor did not send";
 * - a failed read offers a real "try again" action that re-reads, and never
 *   claims the records are absent.
 *
 * The section adds no extra interactive parts beyond the retry button, so
 * every label has exactly one owner.
 */

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  CHECK_RUN_QUERY_LIMIT,
  checkRunsFor,
  checkRunsQueryFilter,
  criterionOf,
  type CheckRunRecord,
  derivedCounts,
  parseVerifiedCheckRun,
  statusLabel,
} from "../lib/check-runs";

export interface CheckRunClaimContext {
  id: string;
  /** The mandate this claim is actually bound in; null binds nothing and shows no records. */
  mandate: string | null;
  record: { evidenceHash: string; checkHash: string };
}

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function ChecksRunSection({
  claim,
  chainId = null,
}: {
  claim: CheckRunClaimContext;
  /** The chain the claim binds on; it scopes the query key with the community, never cached across chains. */
  chainId?: string | number | null;
}) {
  // The values one read is keyed by, captured once: relay (the community),
  // chain, the actual mandate, the claim id and the evidence the claim
  // committed to. A record from another mandate or chain never answers into
  // this section's cache.
  const relay = relayWsUrl();
  const claimId = claim.id.toLowerCase();
  const evidenceHash = claim.record.evidenceHash.toLowerCase();
  const mandateBound = claim.mandate?.toLowerCase() ?? null;
  const bound = mandateBound !== null;
  const query = useQuery({
    queryKey: [
      "launchpad",
      "check-runs",
      relay,
      String(chainId === null ? "" : chainId),
      mandateBound ?? "",
      claimId,
      evidenceHash,
    ],
    queryFn: async () => {
      if (!mandateBound) return { parsed: [], coverage: "complete" as const };
      const events: NostrEvent[] = await queryEvents(
        relay,
        checkRunsQueryFilter({
          claimId,
          mandate: mandateBound,
          evidenceHash,
        }),
      );
      // The query tags name the binding; the reader-side identity still
      // checks each event before it can be attributed at all.
      const parsed = events.flatMap((event) => {
        const record = parseVerifiedCheckRun(event);
        return record ? [record] : [];
      });
      return {
        parsed,
        coverage:
          events.length >= CHECK_RUN_QUERY_LIMIT
            ? ("partial" as const)
            : ("complete" as const),
      };
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  if (query.isError) {
    return (
      <div
        className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        role="status"
        data-testid="work-check-runs-error"
      >
        <Heading>Checks run</Heading>
        <p className="mt-1 text-xs">
          Could not look for the check records just now, so none are shown. This
          does not say whether any were run.
        </p>
        <Button
          className="mt-2"
          onClick={() => void query.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try reading the check records again
        </Button>
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="mt-2" data-testid="work-check-runs">
        <Heading>Checks run</Heading>
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          Reading the check records…
        </p>
      </div>
    );
  }

  const { parsed, coverage } = query.data;
  const grouped = checkRunsFor(claim, parsed);

  if (!bound) {
    return (
      <div className="mt-2" data-testid="work-check-runs">
        <Heading>Checks run</Heading>
        <p className="mt-1 text-xs text-muted-foreground">
          This submission is not linked to a project yet, so no check records
          are shown. Showing records that only share its ID could be wrong. They
          appear once it is linked.
        </p>
      </div>
    );
  }

  if (parsed.length === 0) {
    return (
      <div className="mt-2" data-testid="work-check-runs-empty">
        <Heading>Checks run</Heading>
        <p className="mt-1 text-xs text-muted-foreground">
          No published check records match this submission. This page cannot
          tell whether the checks the contributor named were run: a published
          record is the only sign of that. You can ask the contributor to run
          them and publish the record.
        </p>
        {coverage === "partial" ? <CoverageNote /> : null}
      </div>
    );
  }
  if (grouped.current.length === 0) {
    return (
      <div className="mt-2" data-testid="work-check-runs">
        <Heading>Checks run</Heading>
        <p className="mt-1 text-xs text-muted-foreground">
          No published check record is tied to this submission: none matched its
          work area, its ID and its evidence together. Some records mention it
          without matching all three, so none is shown as its result.
        </p>
        {grouped.misattributed > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {grouped.misattributed === 1
              ? "One record"
              : `${grouped.misattributed} records`}{" "}
            carried this submission's ID under another work area (another
            project or market). It is not shown: matching on the ID alone would
            be a guess.
          </p>
        ) : null}
        {grouped.stale > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {grouped.stale === 1 ? "One record" : `${grouped.stale} records`}{" "}
            named this submission but ran against different evidence than the
            submission recorded. It is not shown with it.
          </p>
        ) : null}
        {coverage === "partial" ? <CoverageNote /> : null}
      </div>
    );
  }

  const newest = grouped.current[0] as CheckRunRecord;
  const counts = derivedCounts(newest.checks);
  const boundChecks = newest.checks.filter(
    (check) => criterionOf(check, claim) === "bound",
  );
  const extra = newest.checks.filter(
    (check) => criterionOf(check, claim) !== "bound",
  );
  return (
    <div className="mt-2" data-testid="work-check-runs">
      <Heading>Checks run</Heading>
      {/* The publisher — their key, the time, the record — is named as the
          source: the signature proves who signed, nothing about who that is
          or what was done. */}
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="work-check-runs-publisher"
      >
        Published by{" "}
        <code
          className="break-all"
          title={newest.author}
          data-testid="work-check-runs-publisher-key"
        >
          {truncatePubkey(newest.author)}
        </code>{" "}
        on {date(newest.createdAt)} · record{" "}
        <code title={newest.eventId}>{truncatePubkey(newest.eventId)}</code>.
        The signature shows who published it. The record is their word. It does
        not say which network it was made on; it is tied to the work area,
        submission ID and evidence its publisher labelled.
      </p>
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="work-check-runs-standing"
      >
        These records are the publisher's own runs of the checks, not a check by
        anyone else. Read them beside the work. They do not replace your
        verdict.
        {newest.notIndependentVerification
          ? ` The record's own sentence: “${newest.notIndependentVerification}”`
          : null}
      </p>
      <SandboxNote record={newest} />
      {newest.selfContradictions.length > 0 ? (
        <ul
          className="mt-1 list-disc pl-4 text-xs text-amber-700 dark:text-amber-200"
          data-testid="work-check-runs-contradictions"
        >
          {newest.selfContradictions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {grouped.stale > 0 ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="work-check-runs-stale"
        >
          {grouped.stale === 1
            ? "One earlier record"
            : `${grouped.stale} earlier records`}{" "}
          named this submission but ran against different evidence. It is not
          shown with this one.
        </p>
      ) : null}
      {grouped.misattributed > 0 ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="work-check-runs-misattributed"
        >
          {grouped.misattributed === 1
            ? "One other record"
            : `${grouped.misattributed} other records`}{" "}
          carried this submission's ID under another work area. It is not
          counted here.
        </p>
      ) : null}
      {coverage === "partial" ? <CoverageNote extra /> : null}
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="work-check-runs-tally"
      >
        Totals for the newest run: {counts.passed} passed · {counts.failed}{" "}
        failed · {counts.timedOut} timed out · {counts.notRun} not run ·{" "}
        {counts.auxiliary} extra · {counts.contradicted} contradicting
        themselves.{" "}
        {newest.summaryConsistent
          ? "The record's own summary agrees."
          : "The record's own summary does NOT agree. The totals above are counted from the list of checks, and the record's summary is not trusted."}
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {boundChecks.map((check) => (
          <li
            key={`${check.name}:${check.argv.join(" ")}`}
            data-testid="work-check-run"
          >
            <p className="text-sm">
              {check.name}{" "}
              <span className="text-xs text-muted-foreground">
                {check.selfContradicted
                  ? `The record says passed, but the check ended with exit code ${check.exitStatus}. Treat it as neither a pass nor evidence; it counts as contradicting itself`
                  : statusLabel(check.status)}
                {check.exitStatus !== null && !check.selfContradicted
                  ? ` · exit code ${check.exitStatus}`
                  : ""}
              </span>
            </p>
            {check.argv.length > 0 ? (
              <p className="break-words text-2xs text-muted-foreground">
                {check.argv.join(" ")}
                {check.argvCut ? " …(more than this page shows)" : ""}
              </p>
            ) : null}
            {check.notRunReason ? (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {check.notRunReason}
              </p>
            ) : null}
            {check.note ? (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {check.note}
              </p>
            ) : null}
            {check.stdout ? (
              <Excerpt text={check.stdout} cut={check.stdoutTruncated} />
            ) : null}
            {check.stderr ? (
              <Excerpt text={check.stderr} cut={check.stderrTruncated} />
            ) : null}
          </li>
        ))}
        {extra.length > 0 ? (
          <li className="mt-1" data-testid="work-check-runs-auxiliary">
            <p className="text-xs font-medium text-muted-foreground">
              Other checks (not part of what counts as done)
            </p>
            {extra.map((check) => (
              <p
                key={`${check.name}:${criterionOf(check, claim)}:${check.exitStatus ?? "x"}`}
                className="text-sm text-muted-foreground"
              >
                {check.name} · {statusLabel(check.status)} ·{" "}
                {criterionOf(check, claim) === "none"
                  ? "nothing was recorded about what it checks, anyway"
                  : "what it checks is not what this submission recorded, so it counts as extra"}
              </p>
            ))}
          </li>
        ) : null}
      </ul>
      <ModelBlock record={newest} />
      <Limitations record={newest} />
    </div>
  );
}

/** What an excerpt looks like: the cut output, visibly cut when it was. */
function Excerpt({ text, cut }: { text: string; cut: boolean }) {
  return (
    <p
      className="mt-1 break-words whitespace-pre-wrap rounded-md bg-black/5 p-1.5 text-2xs dark:bg-white/5"
      data-testid={
        cut ? "work-check-run-excerpt-cut" : "work-check-run-excerpt"
      }
    >
      {text}
      {cut ? " …output cut" : ""}
    </p>
  );
}

/** The sandbox report, as the report of the publisher it is. */
function SandboxNote({ record }: { record: CheckRunRecord }) {
  return (
    <p
      className={
        record.sandboxEnforced
          ? "mt-1 text-xs text-muted-foreground"
          : "mt-1 text-xs text-amber-700 dark:text-amber-200"
      }
      data-testid="work-check-runs-sandbox"
    >
      {record.sandboxClaim === "enforced"
        ? "The publisher says the checks ran in a protected space. That is their report, and this page cannot confirm it. It does not say the work is good: only your verdict does."
        : record.sandboxClaim === "unchecked"
          ? "The record says the checks were not confirmed to run in a protected space, so they may have run without protection, or not at all. Whatever it lists as passed is the publisher's word; read the output yourself."
          : "The record does not say whether the checks ran in a protected space, so they may have run without protection. Whatever it lists as passed is the publisher's word; read the output yourself."}
    </p>
  );
}

/** The clearly separate model interpretation, when one is recorded. */
function ModelBlock({ record }: { record: CheckRunRecord }) {
  if (!record.model) return null;
  return (
    <div
      className="mt-2 rounded-md bg-black/5 p-2 dark:bg-white/5"
      data-testid="work-check-runs-model"
    >
      <p className="text-xs font-medium text-muted-foreground">
        AI commentary: opinion only
      </p>
      <p className="mt-1 break-words whitespace-pre-wrap text-xs">
        {record.model.summary}
      </p>
      <p className="mt-1 text-2xs text-muted-foreground">
        {record.model.disclosure}
      </p>
    </div>
  );
}

/** The record's own limitations, always visible. */
function Limitations({ record }: { record: CheckRunRecord }) {
  if (record.limitations.length === 0) return null;
  return (
    <div className="mt-2" data-testid="work-check-runs-limitations">
      <p className="text-xs font-medium text-muted-foreground">Limitations</p>
      <ul className="mt-1 list-disc pl-4 text-2xs text-muted-foreground">
        {record.limitations.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** Coverage: how much of what could exist the page actually read. */
function CoverageNote({ extra = false }: { extra?: boolean }): ReactNode {
  return (
    <p
      className="mt-1 text-xs text-muted-foreground"
      data-testid="work-check-runs-incomplete"
    >
      This page read at most {CHECK_RUN_QUERY_LIMIT} records, newest first;
      {extra
        ? " older ones may exist that it did not show."
        : " anything older may not have been read."}
    </p>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <p className="text-xs font-medium text-muted-foreground">{children}</p>
  );
}
