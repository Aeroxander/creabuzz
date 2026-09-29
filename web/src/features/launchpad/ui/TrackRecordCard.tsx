/**
 * "Track record" — the outcome half of the trust surface.
 *
 * The commitments card next to this one states what a launch *promises*; this
 * card states what the system actually *recorded*, aggregated in
 * `lib/trust-signals.ts`:
 *
 * - milestone verdicts and claims (kind 47005, closed `approve|reject`
 *   vocabulary, every mirror naming its settlement tx — `docs/nips/NIP-LP.md:268-284`),
 * - settlement receipts (47005 `sweep`/`lock`/`ragequit`) with their tx,
 * - the community's contribution reviews (kind 37013, canonical per action id)
 *   and approval outcomes (46030/46031) where those name a record.
 *
 * Presentation rules this card keeps (the plan's "no fabricated numbers",
 * `docs/next-gen-launchpad-plan.md` §B3):
 * - **No composite score.** The counts are shown as a record with their
 *   derivation — every figure renders from `trackRecordDerivation`, the same
 *   rows `trust-signals.test.mjs` binds to inputs recomputed from the raw
 *   mirrors, so the breakdown on screen *is* the computed input set.
 * - **No signal says "no signal"** (`EMPTY_TRACK_RECORD_COPY`), never a
 *   zero-filled history.
 * - **An unreadable read says so**: a failed contribution query is
 *   "unavailable, not empty", and unreadable mirrors are counted in the
 *   breakdown rather than vanishing.
 * - **Every tx keeps its source**: the explorer link comes from
 *   `explorerTxUrl`, which returns null for chains without a known explorer —
 *   the row then shows the raw hash and says there is no explorer, instead of
 *   fabricating a URL (the `fund-flow.ts` convention).
 */
import { useMemo } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Card } from "@/shared/ui/card";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";

import type { Launch } from "../models";
import { explorerTxUrl } from "../lib/fund-flow";
import {
  aggregateLaunchTrustSignals,
  communityDerivation,
  communityTrackState,
  EMPTY_COMMUNITY_COPY,
  EMPTY_TRACK_RECORD_COPY,
  trackRecordDerivation,
  trackRecordState,
  type DerivationRow,
} from "../lib/trust-signals";
import { useTrustSignals } from "../use-launches";

/**
 * The derived figures, with where each was counted from. The provenance is
 * audit detail, so it sits in one collapsed section rather than under every
 * number.
 */
function DerivationList({ rows }: { rows: DerivationRow[] }) {
  return (
    <>
      <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-baseline justify-between gap-3 py-1.5"
          >
            <dt className="min-w-0 text-black/60 dark:text-white/60">
              {row.label}
            </dt>
            <dd className="shrink-0 font-medium tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-1 text-2xs text-black/60 dark:text-white/60">
        <summary className="cursor-pointer select-none">
          Where these numbers come from
        </summary>
        <ul className="mt-1 space-y-0.5 break-words">
          {rows.map((row) => (
            <li key={row.key}>
              <span className="font-medium">{row.label}:</span> {row.source}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/**
 * A settlement tx, linked when the chain has a known explorer and shown raw
 * with a plain "no explorer" note when it does not — never a dead link.
 */
function TxRef({
  chainId,
  tx,
  txOk,
}: {
  chainId: number;
  tx: string;
  txOk: boolean;
}) {
  if (!txOk) {
    return (
      <span className="break-all text-amber-700 dark:text-amber-300">
        tx {truncatePubkey(tx)} — malformed, not linkable
      </span>
    );
  }
  const url = explorerTxUrl(chainId, tx);
  if (!url) {
    return (
      <span
        className="break-all text-black/60 dark:text-white/60"
        title="This chain has no known explorer — the raw hash is the source."
      >
        tx {truncatePubkey(tx)} (no explorer on this chain)
      </span>
    );
  }
  return (
    <a
      className="break-all text-sky-700 underline dark:text-sky-300"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      tx {truncatePubkey(tx)}
    </a>
  );
}

function VerdictBadge({ verdict }: { verdict: "approve" | "reject" }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-2xs font-medium ${
        verdict === "approve"
          ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
          : "bg-red-500/15 text-red-800 dark:text-red-300"
      }`}
    >
      {verdict}
    </span>
  );
}

export function TrackRecordCard({ launch }: { launch: Launch }) {
  // Per-launch outcomes come straight off the launch's 47005 mirrors — the
  // same bounded query every launch detail already loads (`useLaunches`).
  const record = useMemo(
    () => aggregateLaunchTrustSignals(launch.receipts),
    [launch.receipts],
  );
  const state = trackRecordState(record);
  const rows = trackRecordDerivation(record);
  const chainId = Number(launch.record.chainId ?? "") || 0;
  const actors = useMemo(
    () => [
      ...new Set([
        ...record.verdicts.map((v) => v.author),
        ...record.claims.map((c) => c.author),
        ...record.settlements.map((s) => s.author),
      ]),
    ],
    [record],
  );
  const names = useUserNames(actors);
  const community = useTrustSignals();
  const communityRows = community.data
    ? communityDerivation(community.data)
    : null;
  const communityState = community.data
    ? communityTrackState(community.data)
    : null;

  return (
    <Card className="p-4" data-testid="launch-track-record">
      <h2 className="text-base font-semibold">Track record</h2>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        What the feed has actually recorded: milestone verdicts and claims (kind
        47005, verdict word <code>approve</code>|<code>reject</code>),
        settlement receipts with their tx, and the community's contribution
        reviews. These are outcomes, not a rating — each figure can be traced to
        what it was counted from, and a check that cannot be made says so.
      </p>

      {state === "empty" ? (
        <div className="mt-3" data-testid="track-record-empty">
          <p className="text-sm">{EMPTY_TRACK_RECORD_COPY}</p>
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            Strengthen your proof line: record a milestone claim or a verdict
            from the launch's Manage tab and it appears here with its settlement
            tx. The chain remains the ledger — this card only repeats what the
            feed says.
          </p>
        </div>
      ) : (
        <section className="mt-3" aria-label="Outcome counts">
          <h3 className="text-sm font-semibold">Outcome counts</h3>
          <DerivationList rows={rows} />
        </section>
      )}

      <section className="mt-4" aria-label="Milestone timeline">
        <h3 className="text-sm font-semibold">Milestone timeline</h3>
        {record.timeline.length === 0 ? (
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            No milestone verdicts or claims on this launch.
          </p>
        ) : (
          <ol className="mt-2 flex flex-col gap-3">
            {record.timeline.map((entry) => (
              <li
                key={entry.claimId}
                className="rounded-lg border border-black/10 p-2.5 dark:border-white/10"
                data-testid="track-record-milestone"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-xs font-medium">
                    {entry.claimId}
                  </span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-2xs font-medium ${
                      entry.settled
                        ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                        : "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60"
                    }`}
                  >
                    {entry.settled
                      ? "settled on-chain"
                      : entry.verdicts.length > 0
                        ? "verdict recorded, not settled"
                        : "claim recorded, awaiting verdict"}
                  </span>
                </div>
                {entry.claim ? (
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-black/60 dark:text-white/60">
                    <span>
                      Claim by {names(entry.claim.author)} ·{" "}
                      {relativeTime(entry.claim.createdAt)}
                    </span>
                    <span className="break-all">
                      {entry.claim.evidenceOk && entry.claim.evidenceHash
                        ? `evidence ${entry.claim.evidenceHash.slice(0, 12)}…`
                        : "evidence hash missing or malformed"}
                    </span>
                    <TxRef
                      chainId={chainId}
                      tx={entry.claim.tx}
                      txOk={entry.claim.txOk}
                    />
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                    No claim mirror for this milestone — a verdict arrived
                    without one.
                  </p>
                )}
                {entry.verdicts.length > 0 ? (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {entry.verdicts.map((verdict) => (
                      <li
                        key={verdict.eventId}
                        className="flex flex-wrap items-center gap-2 text-xs"
                      >
                        <VerdictBadge verdict={verdict.verdict} />
                        <span className="text-black/70 dark:text-white/70">
                          {names(verdict.author)}
                        </span>
                        <span className="text-black/50 dark:text-white/50">
                          {relativeTime(verdict.createdAt)}
                        </span>
                        <TxRef
                          chainId={chainId}
                          tx={verdict.tx}
                          txOk={verdict.txOk}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-xs text-black/50 dark:text-white/50">
                    No verdicts yet on this milestone.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-4" aria-label="Community contributions">
        <h3 className="text-sm font-semibold">Community contributions</h3>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          Contribution records belong to the whole community, not one launch, so
          these counts cover everyone here. When a record is updated, the newer
          version replaces the older one instead of counting twice.
        </p>
        {community.isPending ? (
          <p className="mt-2 text-xs text-black/60 dark:text-white/60">
            Reading contribution records…
          </p>
        ) : community.isError ? (
          <p
            className="mt-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="track-record-contributions-unavailable"
          >
            The relay did not return contribution records — this section is
            unavailable, not empty.
          </p>
        ) : communityState === "empty" || !communityRows ? (
          <p className="mt-2 text-xs text-black/60 dark:text-white/60">
            {EMPTY_COMMUNITY_COPY}
          </p>
        ) : (
          <DerivationList rows={communityRows} />
        )}
      </section>
    </Card>
  );
}
