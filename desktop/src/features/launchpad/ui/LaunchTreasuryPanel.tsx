import { totalBidBudget } from "@/features/launchpad/lib/launchpadStatus";
import type { Launch } from "@/features/launchpad/launchpadModels";

export function LaunchTreasuryPanel({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const intent = totalBidBudget(launch);
  const streams = launch.receipts.filter((r) => r.table === "stream");
  const unlocks = launch.receipts.filter((r) => r.table === "unlock");
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3">
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Mirrored bid intent</h3>
        <p className="mt-1 text-lg font-semibold tabular-nums">
          {intent.toString()}
        </p>
        <p className="mt-1 text-2xs text-muted-foreground">
          Sum of mirrored budgets across {launch.bids.length} bids. Advisory —
          settlement happens onchain.
        </p>
      </section>
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Funding streams</h3>
        {streams.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No streams yet. SubDAOs receive revocable streams against milestones
            — continuation, top-up, or cancel follows a budget vote.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {streams.map((s) => (
              <li key={s.id} className="flex justify-between gap-2">
                <span className="font-mono text-2xs">{s.tx.slice(0, 18)}…</span>
                <span className="text-2xs text-muted-foreground">
                  {new Date(s.createdAt * 1000).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Milestone unlocks</h3>
        {unlocks.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Capital unlocks only against verifier-attested evidence. No
            milestone, no tranche.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {unlocks.map((u) => (
              <li key={u.id} className="flex justify-between gap-2">
                <span className="font-mono text-2xs">{u.tx.slice(0, 18)}…</span>
                <span className="text-2xs text-muted-foreground">
                  {new Date(u.createdAt * 1000).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {isFounder ? (
        <p className="text-2xs text-muted-foreground">
          Treasury doors: monthly allowance · governance disbursements ·
          wind-down pro-rata. Ragequit stays available to members after
          graduation.
        </p>
      ) : null}
    </div>
  );
}
