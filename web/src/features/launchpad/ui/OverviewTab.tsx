/**
 * The launch's Overview tab for a sale: the terms, the token plan, what happens at the end, what can and cannot be
 * changed, and, folded away at the bottom, the technical record and checks.
 */
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { Launch } from "../models";
import {
  getRpcEndpoint,
  isContractDeployed,
  recordSaleCurrency,
  setRpcEndpoint,
} from "../chain";
import { priceFormat, sampleBudget } from "../lib/sale-currency";
import { useScoreRoots } from "../use-launches";
import { useAuctionProgress, ProgressBar } from "./widgets";
import { floorPricePerToken } from "../lib/launch-params";
import { allocationRows, impliedFdv, tokensForBudget } from "../lib/allocation";
import {
  SETTLEMENT_TERMS,
  toAtomic,
  formatAtomic,
  formatBlocks,
  formatMoney,
  formatQ96PerToken,
  percentOfGoal,
  remainingToGraduate,
} from "../lib/amounts";
import { IpRecordCard } from "./IpRecordCard";
import { RevenuePledgeCard } from "./RevenuePledgeCard";
import { AboutProjectCard } from "./AboutProjectCard";
import { MilestoneSummaryCard } from "./MilestoneSummaryCard";
import { PowersSection } from "./PowersCard";
import { LaunchContractsCard } from "./LaunchContractsCard";
import { TrackRecordCard } from "./TrackRecordCard";
import { TrustGateCard } from "./TrustGateCard";

type TabLaunch = Launch;

export function OverviewTab({
  launch,
  onOpenMilestones,
}: {
  launch: TabLaunch;
  /** Open the Milestones tab: the summary card links to it. */
  onOpenMilestones?: () => void;
}) {
  const progress = useAuctionProgress(launch.record);
  const { record } = launch;
  const live = progress.data && progress.data.source !== "unavailable";
  const raised = live ? progress.data.raised : null;
  // The threshold is the *record's* figure: `requiredCurrencyRaised` has no
  // on-chain getter, so the chain can report what was raised but not the goal.
  const goal = record.requiredRaised;
  const remaining = remainingToGraduate(raised, goal);
  const percent = percentOfGoal(raised, goal);

  const cur = recordSaleCurrency(record);
  const rows: Array<[string, string]> = [
    // An unavailable read reports no amount at all: printing `0` would imply a
    // funded state of zero rather than an unknown one.
    ["Raised", live ? formatMoney(raised, cur) : "—"],
    [
      "Minimum raise",
      goal
        ? `${formatMoney(goal, cur)}${percent !== null ? ` · ${percent}% reached` : ""}`
        : "None set. The raise can complete at any amount.",
    ],
    [
      "Still to raise",
      remaining !== null
        ? formatMoney(remaining, cur)
        : live && goal
          ? "Threshold met"
          : "—",
    ],
    [
      "Floor price",
      record.floorPrice
        ? `${formatQ96PerToken(record.floorPrice, priceFormat(cur))} per token`
        : "—",
    ],
    [
      "Raise currency",
      cur.kind === "custom"
        ? `${truncatePubkey(cur.value)} (ERC-20)`
        : cur.symbol,
    ],
    [
      "Auction window",
      record.startBlock && record.endBlock
        ? `${formatBlocks(record.endBlock - record.startBlock)} (blocks ${record.startBlock} → ${record.endBlock})`
        : "Not set on this record",
    ],
    [
      "Claims open",
      record.claimBlock
        ? `Block ${record.claimBlock}${
            record.endBlock
              ? ` · ${formatBlocks(record.claimBlock - record.endBlock)} after the close`
              : ""
          }`
        : "Not set on this record",
    ],
    [
      "Bid access",
      record.admission === "community"
        ? "Open to the community"
        : "Curated list of bidders",
    ],
  ];
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <AboutProjectCard record={record} />
      {onOpenMilestones ? (
        <MilestoneSummaryCard
          onOpenMilestones={onOpenMilestones}
          record={record}
        />
      ) : null}
      <Card className="p-4">
        <h2 className="text-base font-semibold">Raise terms</h2>
        <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 py-1.5">
              <dt className="text-black/60 dark:text-white/60">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <ProgressBar record={record} />
        </div>
        {progress.data?.source === "preview" ? (
          <p className="mt-2 text-xs text-black/60 dark:text-white/60">
            Preview data for development builds only. These are not live
            figures.
          </p>
        ) : null}
        {progress.data?.source === "unavailable" ? (
          <div
            className="mt-2 text-xs text-black/60 dark:text-white/60"
            data-testid="launch-progress-unavailable"
          >
            <p>
              {progress.data.reason === "no auction contract linked"
                ? "This launch has no auction contract yet, so there are no live figures to show."
                : "We couldn't read the blockchain, so live figures are hidden."}
            </p>
            {progress.data.reason === "no auction contract linked" ? null : (
              // The old copy told the reader to set a reachable RPC endpoint,
              // but nothing in the app could set one: the setter existed and had
              // no caller, so this state was a dead end.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="launch-rpc-endpoint">
                  Chain RPC endpoint
                </label>
                <input
                  className="min-w-56 flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/15"
                  data-testid="launch-rpc-endpoint"
                  defaultValue={getRpcEndpoint()}
                  id="launch-rpc-endpoint"
                  placeholder="https://mainnet.base.org"
                />
                <Button
                  onClick={() => {
                    const input = document.getElementById(
                      "launch-rpc-endpoint",
                    ) as HTMLInputElement | null;
                    const value = input?.value.trim() ?? "";
                    if (!value) return;
                    setRpcEndpoint(value);
                    void progress.refetch();
                  }}
                  size="sm"
                  variant="outline"
                >
                  Use this endpoint
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Card>
      {/*
        The buyer's numbers. A launch page that shows only the sale price hides
        what the rest of the supply implies, which is the figure a bidder actually
        weighs.
      */}
      <Card className="p-4" data-testid="launch-tokenomics">
        <h2 className="text-base font-semibold">Token and supply</h2>
        {(() => {
          const cur = recordSaleCurrency(record);
          const sample = sampleBudget(cur);
          const pricePerToken = record.floorPrice
            ? floorPricePerToken(toAtomic(record.floorPrice) ?? 0n)
            : null;
          // The record carries the sale tranche in *whole* tokens (the wizard's
          // field says so); only the Q96 price is in smallest units.
          const saleTokens = toAtomic(record.tokenPlan?.supply);
          const saleShare = record.allocation.sale;
          // The record carries the tranche that is sold, not the total supply;
          // the allocation's sale share is what turns one into the other.
          const totalSupply =
            saleTokens !== null && saleShare > 0
              ? (saleTokens * 100n) / BigInt(saleShare)
              : null;
          const fdv =
            pricePerToken !== null && totalSupply !== null
              ? impliedFdv(pricePerToken, totalSupply)
              : null;
          const perThousand = tokensForBudget(sample.atomic, pricePerToken);
          return (
            <>
              <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
                {allocationRows(
                  record.allocation,
                  record.tokenPlan?.mode === "dao",
                  record.unlocks?.mode === "milestones",
                ).map(({ key, label, share }) => {
                  const tokens =
                    totalSupply !== null
                      ? (totalSupply * BigInt(Math.round(share))) / 100n
                      : null;
                  return (
                    <div
                      key={key}
                      className="flex justify-between gap-2 py-1.5"
                    >
                      <dt className="text-black/60 dark:text-white/60">
                        {label}
                      </dt>
                      <dd className="tabular-nums">
                        {share}%
                        {tokens !== null
                          ? ` · ${formatAtomic(tokens, 0)} tokens`
                          : ""}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p className="mt-2 text-sm">
                <span className="text-black/60 dark:text-white/60">
                  Valuation at the floor
                </span>{" "}
                <span className="font-medium tabular-nums">
                  {fdv !== null ? formatMoney(fdv, cur) : "—"}
                </span>
              </p>
              <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                {perThousand !== null
                  ? `${sample.label} buys about ${formatAtomic(perThousand, 0)} tokens at the floor price. Expect less if the sale clears higher.`
                  : "Set a floor price and a token plan to see what a budget buys."}{" "}
                Your bid fills over time at the auction&apos;s current clearing
                price, up to your price limit. Different parts of the sale can
                clear at different prices.
              </p>
            </>
          );
        })()}
      </Card>
      {/*
        What a bidder is agreeing to. The two outcomes decide whether money comes
        back, and they were nowhere on the page.
      */}
      <Card className="p-4" data-testid="launch-settlement-terms">
        <h2 className="text-base font-semibold">What happens at the end</h2>
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          {SETTLEMENT_TERMS.map((term) => (
            <div key={term.outcome}>
              <dt className="font-medium">{term.outcome}</dt>
              <dd className="text-black/60 dark:text-white/60">
                {term.detail}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      {record.tokenPlan?.mode === "dao" ? (
        <PowersSection record={record} />
      ) : null}
      <IpRecordCard launch={launch} />
      {record.tokenPlan?.mode === "dao" ? (
        <RevenuePledgeCard launch={launch} />
      ) : null}
      {/* Everything a person checks for themselves rather than reads: addresses, what the record promises against what the
          chain proves, the trust gate and the raw verdict and receipt counts. Folded away so the page leads with the terms. */}
      <details
        className="rounded-2xl border border-black/10 p-4 lg:col-span-2 dark:border-white/10"
        data-testid="launch-technical"
      >
        <summary
          className="cursor-pointer text-base font-semibold"
          data-testid="launch-technical-summary"
        >
          Technical details and checks
        </summary>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          For people who want to check the sale for themselves: the contract
          addresses, what the record promises and what the chain proves, and the
          raw counts behind the track record.
        </p>
        <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
          <div className="flex justify-between gap-2 py-1.5">
            <dt className="text-black/60 dark:text-white/60">
              Price steps (smallest price change a bid can make)
            </dt>
            <dd className="tabular-nums">
              {record.tickSpacing ? formatAtomic(record.tickSpacing, 0) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1.5">
            <dt className="text-black/60 dark:text-white/60">Chain</dt>
            <dd className="tabular-nums">{record.chainId ?? "Undeployed"}</dd>
          </div>
        </dl>
        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TrustGateCard launch={launch} />
          <LaunchContractsCard record={record} />
          <ProvenCommitmentsCard launch={launch} />
          <TrackRecordCard launch={launch} />
          <ScoreRootsCard />
        </div>
      </details>
    </div>
  );
}

/**
 * Every commitment the record makes, next to what currently proves it.
 *
 * The record is a signed promise; the chain is the ledger. This card is the
 * honest bridge: each address commitment is checked for deployed code over
 * RPC, and each non-address commitment states plainly that it lives on the
 * record. A missing or unreadable proof is said out loud — never rendered as
 * if it were verified, and never as a fabricated figure.
 */
function ProvenCommitmentsCard({ launch }: { launch: TabLaunch }) {
  const { record } = launch;
  const [chainState, setChainState] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const endpoint = getRpcEndpoint();
    const targets: Array<[string, string | null]> = [
      ["auction", record.auction],
      ["token", record.token],
      ["treasury", record.treasury],
    ];
    void (async () => {
      for (const [label, address] of targets) {
        if (!address) {
          if (alive) setChainState((s) => ({ ...s, [label]: "not set" }));
          continue;
        }
        try {
          const deployed = await isContractDeployed(endpoint, address);
          if (alive) {
            setChainState((s) => ({
              ...s,
              [label]: deployed ? "deployed" : "no code at this address",
            }));
          }
        } catch {
          if (alive) {
            setChainState((s) => ({ ...s, [label]: "unreadable" }));
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [record.auction, record.token, record.treasury]);

  const commitments: Array<[string, string]> = [
    ["Auction contract", chainState.auction ?? "checking…"],
    ["Token contract", chainState.token ?? "checking…"],
    ["Treasury contract", chainState.treasury ?? "checking…"],
    [
      "Monthly budget",
      record.budget
        ? formatMoney(record.budget, recordSaleCurrency(record))
        : "not set",
    ],
    [
      "Vesting package",
      record.vesting
        ? `${record.vesting.tranches.length} tranches from ${record.vesting.tranches[0].multiple}x`
        : "not set",
    ],
    [
      "Bound channels",
      record.channels.length > 0
        ? `${record.channels.length} bound`
        : "none bound",
    ],
    [
      "Chat rooms",
      record.chat.team || record.chat.supporters
        ? "team and supporters"
        : "none yet",
    ],
    [
      "Team keys",
      record.team.length > 0 ? `${record.team.length} listed` : "author only",
    ],
    [
      "Committed assets",
      record.ipList.length > 0
        ? `${record.ipList.length} listed`
        : "none listed",
    ],
    [
      "Parameter hash",
      record.paramsHash ? `${record.paramsHash.slice(0, 14)}…` : "not set",
    ],
  ];

  return (
    <Card className="p-4" data-testid="launch-commitments">
      <h2 className="text-base font-semibold">Proven commitments</h2>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        The record is a signed promise; the blockchain is the ledger. We check
        each address for a live contract through your RPC endpoint. Anything we
        can't read is labeled, never shown as verified.
      </p>
      <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
        {commitments.map(([label, state]) => (
          <div key={label} className="flex justify-between gap-2 py-1.5">
            <dt className="text-black/60 dark:text-white/60">{label}</dt>
            <dd
              className={
                state === "deployed"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : state === "unreadable" ||
                      state === "no code at this address"
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-black/60 dark:text-white/60"
              }
            >
              {state}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * The community's proven score roots (kind 37006), read as plain Nostr data.
 *
 * Shows the latest epoch's root, its program, and the indexer that serves
 * proofs. It does not claim a score for any member here — verification of an
 * individual claim happens against a specific leaf+proof
 * (`lib/trust-score.ts`), surfaced where a score is claimed.
 */
function ScoreRootsCard() {
  const roots = useScoreRoots();
  const latest = roots.data?.[0] ?? null;
  if (!latest) return null;
  return (
    <Card className="p-4" data-testid="launch-score-roots">
      <h2 className="text-base font-semibold">Community scores</h2>
      <dl className="mt-2 divide-y divide-black/10 text-sm dark:divide-white/10">
        <div className="flex justify-between gap-2 py-1.5">
          <dt className="text-black/60 dark:text-white/60">Program</dt>
          <dd className="tabular-nums">{latest.program}</dd>
        </div>
        <div className="flex justify-between gap-2 py-1.5">
          <dt className="text-black/60 dark:text-white/60">Epoch</dt>
          <dd className="tabular-nums">{latest.epoch}</dd>
        </div>
        <div className="flex justify-between gap-2 py-1.5">
          <dt className="text-black/60 dark:text-white/60">Root</dt>
          <dd className="font-mono text-xs tabular-nums">
            {latest.root.slice(0, 18)}…
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-black/60 dark:text-white/60">
        Scores are published as a signed list. A score shown on a profile is
        only marked proven after we check it against this list.
        {latest.anchorBlock !== null
          ? ` Recorded onchain in block ${latest.anchorBlock}.`
          : ""}
      </p>
      {latest.indexerUrl ? (
        <a
          className="mt-1 inline-block text-xs text-primary-ink underline"
          href={latest.indexerUrl}
          rel="noreferrer"
          target="_blank"
        >
          View proofs and scores
        </a>
      ) : null}
    </Card>
  );
}
