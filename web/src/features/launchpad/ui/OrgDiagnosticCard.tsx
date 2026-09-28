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
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  DIAG_KINDS,
  diagEventFromNostr,
  diagnose,
  type DiagReport,
  type DiagEvent,
} from "../lib/org-diag";

function pct(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

const STATUS_TINT: Record<string, string> = {
  calm: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  watch: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  flag: "bg-red-500/15 text-red-700 dark:text-red-300",
  saturated: "bg-red-500/15 text-red-700 dark:text-red-300",
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
        <h3 className="text-sm font-semibold">Org diagnostic</h3>
        <span
          className="text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          {diag.isLoading
            ? "reading the event graph…"
            : report
              ? `${report.events} events · recomputable — \`buzz diag\` renders the same numbers`
              : "no window loaded"}
        </span>
      </div>

      {!report ? null : (
        <div className="mt-3 space-y-3 text-xs">
          {/* Instrument 1 — Pentland's time signal (timing-only). */}
          <section aria-label="Time signal">
            <h4 className="font-medium">Time signal (Pentland)</h4>
            {report.timeSignal ? (
              <>
                <p className="text-black/70 dark:text-white/70">
                  burstiness {pct(report.timeSignal.burstinessBp)} · handoffs{" "}
                  {pct(report.timeSignal.handoffRateBp)} · median lag{" "}
                  {report.timeSignal.handoffMedianLagS}s ·{" "}
                  {report.timeSignal.events} events
                </p>
                <p className="text-black/60 dark:text-white/60">
                  {report.timeSignal.reading}
                </p>
              </>
            ) : (
              <p className="text-black/60 dark:text-white/60">
                insufficient data (&lt;20 events) — omitted, never zeroed
              </p>
            )}
          </section>

          {/* Instrument 2 — Tomasello's three layers. */}
          {report.tomasello ? (
            <section aria-label="Tomasello layers">
              <h4 className="font-medium">Three layers (Tomasello)</h4>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["communicate", report.tomasello.communicate],
                    ["build trust", report.tomasello.buildTrust],
                    ["institutionalize", report.tomasello.institutionalize],
                  ] as const
                ).map(([label, layer]) => (
                  <div key={label}>
                    <p className="font-medium">{label}</p>
                    <p className="text-black/70 dark:text-white/70">
                      {layer.events} · {pct(layer.shareBp)}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-black/60 dark:text-white/60">
                {report.tomasello.reading}
              </p>
            </section>
          ) : null}

          {/* Instrument 3 — the WEF five failure modes. */}
          <section aria-label="WEF failure modes">
            <h4 className="font-medium">Failure modes (WEF five)</h4>
            <div className="flex flex-wrap gap-2">
              {report.wefModes.map((mode) => (
                <span
                  className={`rounded-full px-2 py-0.5 ${STATUS_TINT[mode.status] ?? ""}`}
                  key={mode.mode}
                  title={mode.note}
                >
                  {mode.mode}: {mode.signalEvents} · {mode.status}
                </span>
              ))}
            </div>
          </section>

          {/* Instrument 4 — Cursor's thrash-vs-work scoreboard. */}
          {report.thrash ? (
            <section aria-label="Thrash scoreboard">
              <h4 className="font-medium">Thrash vs work (Cursor)</h4>
              <p className="text-black/70 dark:text-white/70">
                {report.thrash.revisions} revisions /{" "}
                {report.thrash.coordinates} coordinates · rework{" "}
                {pct(report.thrash.reworkRateBp)} · settled{" "}
                {pct(report.thrash.settledRateBp)}
              </p>
              <p className="text-black/60 dark:text-white/60">
                {report.thrash.reading}
              </p>
            </section>
          ) : null}

          {/* Instrument 5 — drift probes (the AI Village shape). */}
          <section aria-label="Drift probes">
            <h4 className="font-medium">Drift probes</h4>
            {report.drift.length === 0 ? (
              <p className="text-black/60 dark:text-white/60">
                no actor had ≥8 events in both halves of the window
              </p>
            ) : (
              <p className="text-black/70 dark:text-white/70">
                {report.drift
                  .filter((p) => p.flagged)
                  .map(
                    (p) =>
                      `${p.actor.slice(0, 8)}… moved ${(p.driftBp / 100).toFixed(0)}%`,
                  )
                  .join(" · ") || "no flagged drift — distributions held"}
                {" — movement only; “bad” is never inferred here"}
              </p>
            )}
          </section>

          {/* Instrument 6 — supervision saturation (the governor-agents risk). */}
          {report.supervision ? (
            <section aria-label="Supervision">
              <h4 className="font-medium">Supervision</h4>
              <p className="text-black/70 dark:text-white/70">
                {report.supervision.approvalRequests} approval requests /{" "}
                {report.supervision.actions} actions · saturation{" "}
                {pct(report.supervision.saturationBp)} · top approver{" "}
                {pct(report.supervision.topApproverShareBp)} ·{" "}
                <span
                  className={`rounded-full px-2 py-0.5 ${STATUS_TINT[report.supervision.status] ?? ""}`}
                >
                  {report.supervision.status}
                </span>
              </p>
              <p className="text-black/60 dark:text-white/60">
                approval concentration is the WEF's governor-agents risk
                (“overreliance on agents supervising other agents”)
              </p>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
