/**
 * The Org diagnostic card (OA.md Phase 4) — the UI home of the
 * differentiated instrument. The numbers come from `../lib/org-diag`, the
 * exact twin of `buzz-core::org_diag`, so `buzz diag` in the CLI renders the
 * same report for the same window.
 *
 * Honesty in the copy, as designed: readings are patterns not verdicts,
 * insufficient data says so (never zeroed scores), raw counts sit next to
 * every rate.
 */
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/shared/ui/card";
import { modeCopy, readingCopy, statusWord } from "../lib/org-diag-copy";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  DIAG_KINDS,
  diagEventFromNostr,
  diagnose,
  type DiagReport,
  type DiagEvent,
} from "@creaton/core/launchpad/org-diag.ts";

/** A figure with a plain name, its value, and one line on what it means. */
function Figure({
  label,
  meaning,
  value,
}: {
  label: string;
  meaning: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-black/70 dark:text-white/70">
        <span className="font-medium">{label}:</span> {value}
      </p>
      <p className="text-black/60 dark:text-white/60">{meaning}</p>
    </div>
  );
}

function pct(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

const STATUS_TINT: Record<string, string> = {
  calm: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  watch: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  flag: "bg-red-500/15 text-red-800 dark:text-red-300",
  saturated: "bg-red-500/15 text-red-800 dark:text-red-300",
};

export function OrgDiagnosticCard() {
  const diag = useQuery({
    queryKey: ["org-diag", relayWsUrl()],
    queryFn: async (): Promise<DiagReport> => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [...DIAG_KINDS],
        limit: 500,
      });
      const rows: DiagEvent[] = [];
      for (const event of events) {
        const row = diagEventFromNostr(event);
        if (row) rows.push(row);
      }
      return diagnose(rows);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const report = diag.data;

  return (
    <Card className="m-4 mb-0 p-4" data-testid="org-diagnostic">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Team health check</h3>
        <span
          className="text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          {diag.isLoading
            ? "Reading the team's activity…"
            : report
              ? `${report.events} events counted · every figure can be recomputed from the saved activity`
              : "No activity loaded yet"}
        </span>
      </div>

      {!report ? null : (
        <div className="mt-3 space-y-3 text-xs">
          {/* Instrument 1 — Pentland's time signal (timing-only). */}
          <section aria-label="Activity rhythm">
            <h4 className="font-medium">Activity rhythm</h4>
            {report.timeSignal ? (
              <>
                <Figure
                  label="Work in rushes"
                  meaning="How uneven the activity is. Higher means short rushes with quiet gaps between."
                  value={pct(report.timeSignal.burstinessBp)}
                />
                <Figure
                  label="Work passed between people"
                  meaning="Share of actions that came within a minute of a different person's action."
                  value={pct(report.timeSignal.handoffRateBp)}
                />
                <Figure
                  label="Typical wait for the next person"
                  meaning="When work was passed on, how long the next person took to act."
                  value={`${report.timeSignal.handoffMedianLagS} seconds`}
                />
                <p className="text-black/60 dark:text-white/60">
                  Based on {report.timeSignal.events} events.{" "}
                  {readingCopy(report.timeSignal.reading)}
                </p>
              </>
            ) : (
              <p className="text-black/60 dark:text-white/60">
                Not enough activity yet (fewer than 20 events), so nothing is
                shown instead of a zero.
              </p>
            )}
          </section>

          {/* Instrument 2 — Tomasello's three layers. */}
          {report.tomasello ? (
            <section aria-label="How the team coordinates">
              <h4 className="font-medium">How the team coordinates</h4>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["Talking", "Messages", report.tomasello.communicate],
                    [
                      "Building trust",
                      "Contributions, access given or taken away",
                      report.tomasello.buildTrust,
                    ],
                    [
                      "Deciding",
                      "Proposals, votes and approvals",
                      report.tomasello.institutionalize,
                    ],
                  ] as const
                ).map(([label, meaning, layer]) => (
                  <div key={label}>
                    <p className="font-medium">{label}</p>
                    <p className="text-black/70 dark:text-white/70">
                      {layer.events} events · {pct(layer.shareBp)}
                    </p>
                    <p className="text-black/60 dark:text-white/60">
                      {meaning}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-black/60 dark:text-white/60">
                {readingCopy(report.tomasello.reading)}
              </p>
            </section>
          ) : null}

          {/* Instrument 3 — the WEF five failure modes. */}
          <section aria-label="Health checks">
            <h4 className="font-medium">Health checks</h4>
            <ul className="space-y-1">
              {report.wefModes.map((mode) => {
                const copy = modeCopy(mode.mode);
                return (
                  <li key={mode.mode}>
                    <span
                      className={`rounded-full px-2 py-0.5 ${STATUS_TINT[mode.status] ?? ""}`}
                    >
                      {copy.label}: {mode.signalEvents} events ·{" "}
                      {statusWord(mode.status)}
                    </span>
                    {copy.meaning ? (
                      <span className="ml-2 text-black/60 dark:text-white/60">
                        {copy.meaning}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Instrument 4 — Cursor's thrash-vs-work scoreboard. */}
          {report.thrash ? (
            <section aria-label="Rework and progress">
              <h4 className="font-medium">Rework and progress</h4>
              <Figure
                label="Edits"
                meaning="How many times items were changed, and how many different items that covers."
                value={`${report.thrash.revisions} edits across ${report.thrash.coordinates} items`}
              />
              <Figure
                label="Edits that redo earlier work"
                meaning="Share of edits that changed an item already edited before."
                value={pct(report.thrash.reworkRateBp)}
              />
              <Figure
                label="Items edited only once"
                meaning="Share of items written once and then left alone."
                value={pct(report.thrash.settledRateBp)}
              />
              <p className="text-black/60 dark:text-white/60">
                {readingCopy(report.thrash.reading)}
              </p>
            </section>
          ) : null}

          {/* Instrument 5 — drift probes (the AI Village shape). */}
          <section aria-label="Changes in behaviour">
            <h4 className="font-medium">Changes in behaviour</h4>
            {report.drift.length === 0 ? (
              <p className="text-black/60 dark:text-white/60">
                Nobody had at least 8 events in both halves of the period.
              </p>
            ) : (
              <p className="text-black/70 dark:text-white/70">
                {report.drift
                  .filter((p) => p.flagged)
                  .map(
                    (p) =>
                      `${p.actor.slice(0, 8)}… moved ${(p.driftBp / 100).toFixed(0)}%`,
                  )
                  .join(" · ") || "No one changed their behaviour much."}
                {" (this shows change only, never whether it is good or bad)"}
              </p>
            )}
          </section>

          {/* Instrument 6 — supervision saturation (the governor-agents risk). */}
          {report.supervision ? (
            <section aria-label="Supervision">
              <h4 className="font-medium">Supervision</h4>
              <Figure
                label="Approval requests"
                meaning="How many of the actions needed someone's approval."
                value={`${report.supervision.approvalRequests} of ${report.supervision.actions} actions`}
              />
              <Figure
                label="Share of actions waiting on approval"
                meaning="The higher this is, the more reviewers are asked to look at."
                value={pct(report.supervision.saturationBp)}
              />
              <Figure
                label="Share of approvals from one reviewer"
                meaning="How much of the approving falls on the busiest reviewer."
                value={pct(report.supervision.topApproverShareBp)}
              />
              <p>
                <span
                  className={`rounded-full px-2 py-0.5 ${STATUS_TINT[report.supervision.status] ?? ""}`}
                >
                  {statusWord(report.supervision.status)}
                </span>
              </p>
              <p className="text-black/60 dark:text-white/60">
                When most approvals come from one reviewer, or agents mostly
                approve other agents, oversight is thinner than it looks.
              </p>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
