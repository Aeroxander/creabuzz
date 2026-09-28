import { totalBidBudget } from "@/features/launchpad/lib/launchpadStatus";
import { milestoneChoices } from "@/features/launchpad/lib/claimChoices";
import { resolveDaoBinding } from "@/features/launchpad/lib/decisionRouting";
import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import { useEvmChainStatusQuery } from "@/features/launchpad/mintHooks";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import type { Launch } from "@/features/launchpad/launchpadModels";
import { RoyaltyStatementCard } from "@/features/launchpad/ui/RoyaltyStatementCard";
import { EnforcementCard } from "@/features/launchpad/ui/EnforcementCard";
import {
  DelegationCard,
  type DelegateOption,
} from "@/features/launchpad/ui/DelegationCard";

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
  // The contributor money surface (web parity): mounted only when the launch
  // carries its enforcer wiring — never a dead panel.
  const royalty = milestoneChoices(launch.record.unlocks, launch.receipts);
  // Env, derived like LaunchProposalsPanel (no prop threading).
  const rpcUrl = getRpcEndpoint(getCachedRelayOrigin());
  const chainQuery = useEvmChainStatusQuery(rpcUrl, true);
  const chainId = chainQuery.data?.chainId ?? 0;
  const relayOrigin = getCachedRelayOrigin();
  // The bound DAO (summon-receipt path — the treasury is org-level, so no
  // proposal's `onchain` binding leads).
  const daoBinding = resolveDaoBinding(
    { id: "org", onchain: null },
    launch.receipts,
  );
  // Delegate candidates = the DAO's equity map (summon-receipt holders —
  // where agent wallets appear): addresses, never npubs (the "no manual
  // ids" rule).
  const delegateMembers: DelegateOption[] = (() => {
    const summon = [...launch.receipts]
      .sort((a, b) => b.createdAt - a.createdAt)
      .find((r) => r.table === "summon");
    const holders = summon?.payload.holders;
    if (!Array.isArray(holders)) return [];
    return holders
      .filter(
        (h): h is string =>
          typeof h === "string" && /^0x[0-9a-fA-F]{40}$/.test(h),
      )
      .map((h) => ({ value: h, label: h }));
  })();
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3">
      {launch.record.distributor && launch.record.claimStake ? (
        <RoyaltyStatementCard
          claimStake={launch.record.claimStake}
          distributor={launch.record.distributor}
          scheduleIds={royalty.scheduleIds}
        />
      ) : null}
      <EnforcementCard
        dao={daoBinding?.dao ?? null}
        relayOrigin={relayOrigin}
        rpcUrl={rpcUrl}
      />
      <DelegationCard
        author={launch.record.author}
        chainId={String(chainId)}
        dao={daoBinding?.dao ?? null}
        launchId={launch.record.id}
        members={delegateMembers}
        rpcUrl={rpcUrl}
      />
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
