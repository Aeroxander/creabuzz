/**
 * The launch's "Treasury & flows" tab: the post-sale money story first
 * (`TreasuryFlowsPanel` — the fund-flow view), the exit surface
 * (`RagequitPanel` — the majeur ragequit with its claimable position), then
 * the founder-facing commitments the plan is priced on.
 */
import { useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Card } from "@/shared/ui/card";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { erc20BalanceOf, getRpcEndpoint } from "../chain";
import type { Launch } from "../models";
import { formatAtomic, formatMoney, toAtomic } from "../lib/amounts";
import { resolveDaoBinding } from "../lib/org-money";
import { useOrgMoney } from "../use-launches";
import { RagequitPanel } from "./RagequitPanel";
import { RoyaltyStatementCard } from "./RoyaltyStatementCard";
import { EnforcementCard } from "./EnforcementCard";
import { DelegationCard } from "./DelegationCard";
import { milestoneChoices } from "../lib/claim-choices";
import { TreasuryFlowsPanel } from "./TreasuryFlowsPanel";

export function TreasuryTab({
  launch,
  onProposeReturn,
}: {
  launch: Launch;
  onProposeReturn: (title: string) => void;
}) {
  const streams = launch.receipts.filter((r) => r.table === "stream");
  const { record } = launch;
  // The money story (post-sale fund flows) and the exit surface both resolve
  // their data here: the chain reads live in the panels, the DAO binding
  // comes from this launch's summon receipts or the community's bound org
  // root (`lib/org-money.ts` — sources are stated in the UI).
  const orgMoney = useOrgMoney();
  const daoBinding = resolveDaoBinding({
    receipts: launch.receipts,
    orgBindings: orgMoney.data?.bindings ?? [],
  });
  const chainId = Number(record.chainId ?? "") || 0;
  const [returnTitle, setReturnTitle] = useState("");
  const [proposed, setProposed] = useState(false);
  const [balance, setBalance] = useState<{
    state: "idle" | "loading" | "done";
    value: bigint | null;
  }>({ state: "idle", value: null });

  /**
   * What the raise splits into, from the terms the founder set.
   *
   * These are commitments, not a balance: the panel says which is which, because
   * a treasury screen that mixes planned figures with measured ones is how people
   * misread a treasury.
   */
  const plan = useMemo(() => {
    const floorPrice = toAtomic(record.floorPrice);
    const threshold = toAtomic(record.requiredRaised);
    if (floorPrice === null) return null;
    const saleTokens = toAtomic(launch.record.tokenPlan?.supply ?? null);
    if (saleTokens === null) return null;
    const saleTokensAtomic = saleTokens * 10n ** 18n;
    const floorRaise = (saleTokensAtomic * floorPrice) / (1n << 96n);
    return { floorRaise, threshold, saleTokensAtomic };
  }, [
    record.floorPrice,
    record.requiredRaised,
    launch.record.tokenPlan?.supply,
  ]);

  const readBalance = async () => {
    if (!record.token || !record.treasury) return;
    setBalance({ state: "loading", value: null });
    const value = await erc20BalanceOf(
      getRpcEndpoint(),
      record.token,
      record.treasury,
    );
    setBalance({ state: "done", value });
  };

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-4">
      <TreasuryFlowsPanel
        chainId={chainId}
        receipts={launch.receipts}
        record={record}
      />
      <RagequitPanel
        chainId={chainId}
        daoBinding={daoBinding}
        record={record}
      />
      {record.distributor && record.claimStake ? (
        <RoyaltyStatementCard
          claimStake={record.claimStake}
          distributor={record.distributor}
          scheduleIds={
            milestoneChoices(record.unlocks, launch.receipts).scheduleIds
          }
        />
      ) : null}
      {daoBinding ? <EnforcementCard dao={daoBinding.dao} /> : null}
      <DelegationCard
        author={launch.record.author}
        dao={daoBinding?.dao ?? null}
        launchId={launch.record.id}
        members={(() => {
          // Delegate candidates = the DAO's equity map (summon-receipt
          // holders — where agent wallets appear) — addresses, never npubs.
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
            .map((h) => ({ value: h, label: truncatePubkey(h) }));
        })()}
      />
      <Card className="p-4" data-testid="launch-treasury-plan">
        <h2 className="text-base font-semibold">Treasury plan</h2>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          From the published terms — commitments, not a measured balance.
        </p>
        <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
          {[
            [
              "Raise if it clears at the floor",
              plan ? formatMoney(plan.floorRaise) : "—",
            ],
            [
              "Graduation threshold",
              record.requiredRaised ? formatMoney(record.requiredRaised) : "—",
            ],
            ...(record.budget
              ? [["Monthly budget", formatMoney(record.budget)] as const]
              : []),
            [
              "Treasury",
              record.treasury ? truncatePubkey(record.treasury) : "Not set",
            ],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2 py-1.5">
              <dt className="text-black/60 dark:text-white/60">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-black/60 dark:text-white/60">
          Liquidity is seeded from the clearing price at graduation; the
          remainder is the treasury&apos;s. Allowances, streams and the
          wind-down path are agreed by proposal, not configured here.
        </p>
      </Card>
      <Card className="p-4" data-testid="launch-treasury-balance">
        <h2 className="text-base font-semibold">Token balance</h2>
        {!record.token || !record.treasury ? (
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            Link the token and treasury addresses to read a balance.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-black/60 dark:text-white/60">
              {balance.state === "idle"
                ? "Read the treasury's balance of the launch token over RPC."
                : balance.state === "loading"
                  ? "Reading…"
                  : balance.value === null
                    ? "The chain could not be read, so the balance is unknown."
                    : formatAtomic(balance.value, 18, { symbol: "tokens" })}
            </p>
            <Button
              className="mt-2"
              disabled={balance.state === "loading"}
              onClick={() => void readBalance()}
              size="sm"
              variant="outline"
            >
              Read balance
            </Button>
          </>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="text-base font-semibold">Funding streams</h2>
        {streams.length === 0 ? (
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            No streams yet. SubDAOs receive revocable streams against milestones
            — continuation, top-up, or cancel follows a budget vote.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {streams.map((s) => (
              <li key={s.id} className="font-mono text-xs">
                {s.tx.slice(0, 18)}…
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4" data-testid="treasury-return">
        <h2 className="text-base font-semibold">Exit</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          The credible threat of taking money back is what disciplines a
          treasury. Anyone can raise a proposal to return capital — before
          graduation this is a signal on Nostr (the onchain refund path is the
          auction contract itself); after graduation it is a real DAO decision.
        </p>
        <div className="mt-2 flex gap-2">
          <Input
            data-testid="return-title"
            onChange={(e) => setReturnTitle(e.target.value)}
            placeholder="e.g. Return the remaining treasury pro-rata"
            value={returnTitle}
          />
          <Button
            data-testid="propose-return"
            disabled={proposed || returnTitle.trim() === ""}
            onClick={() => {
              onProposeReturn(
                returnTitle.trim() || "Return the remaining treasury pro-rata",
              );
              setProposed(true);
            }}
            size="sm"
            variant="outline"
            type="button"
          >
            {proposed ? "Proposed" : "Propose capital return"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
