import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Star } from "lucide-react";
import { toast } from "sonner";

import { useUserNames } from "@/features/profiles/use-profiles";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  KIND_LAUNCH_BID,
  KIND_LAUNCH_PROPOSAL,
  KIND_LAUNCH_UPDATE,
} from "@/shared/constants/kinds";
import {
  useDeleteLaunch,
  useIsFounder,
  useLaunch,
  usePublishMirror,
} from "../use-launches";
import { effectiveStage, type Launch } from "../models";
import type { LaunchAction } from "../lib/deep-link";
import { TreasuryTab } from "./TreasuryTab";
import { LaunchDiscussion } from "@/features/feed/ui/LaunchDiscussion";
import { launchCoord } from "@/features/feed/ui/LaunchVoteCard";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";

type TabLaunch = Launch;

import {
  getRpcEndpoint,
  isContractDeployed,
  recordSaleCurrency,
  setRpcEndpoint,
} from "../chain";
import { priceFormat, sampleBudget } from "../lib/sale-currency";
import { useScoreRoots } from "../use-launches";
import {
  useAuctionProgress,
  OwnershipOnlyNote,
  ProgressBar,
  StageBadge,
} from "./widgets";
import { RecordBidDialog } from "./RecordBidDialog";
import { PostUpdateDialog } from "./PostUpdateDialog";
import { floorPricePerToken } from "../lib/launch-params";
import {
  ALLOCATION_LABELS,
  impliedFdv,
  tokensForBudget,
} from "../lib/allocation";
import { sandboxRecord } from "../lib/sandbox";
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
import { ManagePanel } from "./ManagePanel";
import { MyBidsPanel } from "./MyBidsPanel";
import { LaunchContractsCard } from "./LaunchContractsCard";
import { TrackRecordCard } from "./TrackRecordCard";
import { ProposalCard } from "./ProposalCard";
import { WikiDraftComposer } from "./WikiDraftComposer";
import { TrustGateCard } from "./TrustGateCard";
import { launchCoordinate } from "../models";
import { resolveDaoBinding } from "../lib/org-money";
import { useOrgMoney } from "../use-launches";

type Tab =
  | "overview"
  | "discussion"
  | "updates"
  | "proposals"
  | "treasury"
  | "mybids"
  | "manage";

export function LaunchDetailPage({
  launchId,
  author,
  action,
  sandbox,
}: {
  launchId: string;
  author: string | undefined;
  /**
   * Desktop → web handoff (`?action=bid|exit|claim`): open the matching flow
   * on load. Unknown values were already dropped by the route's
   * `validateSearch`; opening a flow is never destructive on its own.
   */
  action?: LaunchAction | null;
  /** Render the deterministic sandbox launch instead of a relay launch. */
  sandbox?: boolean;
}) {
  const { launch: realLaunch, isLoading } = useLaunch(launchId, author);
  const launch = sandbox
    ? {
        record: sandboxRecord(),
        bids: [],
        updates: [],
        proposals: [],
        receipts: [],
      }
    : realLaunch;
  const isFounder = useIsFounder(launch);
  const mirror = usePublishMirror();
  const remove = useDeleteLaunch();
  const [tab, setTab] = useState<Tab>("overview");
  const [bidOpen, setBidOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [mybidsAutoAction, setMybidsAutoAction] = useState<
    "exit" | "claim" | null
  >(null);
  const follows = useLaunchFollows();
  const navigate = useNavigate();

  // Consume the deep link once: `bid` opens the bid dialog (sender picker);
  // `exit`/`claim` land on the My-bids section and expand the matching bid's
  // action there.
  useEffect(() => {
    if (!action) return;
    if (action === "bid") {
      setBidOpen(true);
      return;
    }
    setMybidsAutoAction(action);
    setTab("mybids");
  }, [action]);

  if (isLoading || !launch) {
    return (
      <p className="mx-auto w-full max-w-5xl px-4 py-16 text-center text-sm text-black/60 dark:text-white/60">
        {isLoading ? "Loading launch…" : "Launch not found."}
      </p>
    );
  }

  const stage = effectiveStage(launch);

  const recordBid = async (input: {
    bucket: string;
    budget: string;
    maxPrice: string;
    tx: string;
    asAgent?: boolean;
  }) => {
    try {
      await mirror.mutateAsync({
        kind: KIND_LAUNCH_BID,
        author: launch.record.author,
        launchId: launch.record.id,
        bucket: input.bucket,
        asAgent: input.asAgent,
        content: {
          budget: input.budget || undefined,
          maxPrice: input.maxPrice || undefined,
          tx: input.tx || undefined,
        },
      });
      toast.success("Bid recorded. The chain remains the source of truth.");
      setBidOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recording failed.");
    }
  };

  const postUpdate = async (input: { title: string; body: string }) => {
    try {
      await mirror.mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        content: { title: input.title, body: input.body },
      });
      toast.success("Update published.");
      setUpdateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Publishing failed.");
    }
  };

  const coord = launchCoord(launch.record);
  const followed = follows.followed.has(coord);

  const tabs: Array<{ id: Tab; label: string; founderOnly?: boolean }> = [
    { id: "overview", label: "Overview" },
    // A simulated launch has no public discussion to join.
    ...(sandbox ? [] : [{ id: "discussion" as const, label: "Discussion" }]),
    { id: "updates", label: `Updates (${launch.updates.length})` },
    { id: "proposals", label: `Proposals (${launch.proposals.length})` },
    { id: "treasury", label: "Treasury" },
    // Onchain bids only exist when the launch has an auction linked.
    ...(launch.record.auction
      ? [{ id: "mybids" as const, label: "My bids" }]
      : []),
    { id: "manage", label: "Manage", founderOnly: true },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <Link
        to="/launchpad"
        className="flex items-center gap-1 text-sm text-black/60 hover:underline dark:text-white/60"
      >
        <ArrowLeft className="h-4 w-4" /> Launchpad
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {launch.record.name} <StageBadge stage={stage} />
            {launch.record.agent ? (
              <span
                className="rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300"
                data-testid="launch-agent-badge-detail"
                title={`Run by agent ${launch.record.agent.slice(0, 8)}…`}
              >
                Agent-run
              </span>
            ) : null}
          </span>
        }
        description={launch.record.pitch || "No pitch yet."}
        action={
          <span className="flex flex-col items-end gap-2">
            {/* §7 "Launch page copy": what a buyer acquires, said before the
                bid button — ownership only, never a yield. */}
            <OwnershipOnlyNote className="max-w-60 text-right" />
            <span className="flex gap-2">
              {sandbox ? null : (
                <button
                  aria-label={followed ? "Unfollow launch" : "Follow launch"}
                  aria-pressed={followed}
                  data-testid="launch-follow"
                  disabled={!follows.ready || follows.pending}
                  onClick={() => follows.toggle(coord)}
                  className={cn(
                    "rounded-lg border p-2",
                    followed
                      ? "border-amber-500/50 text-amber-500"
                      : "border-black/15 dark:border-white/15",
                  )}
                  type="button"
                >
                  <Star
                    className="h-4 w-4"
                    fill={followed ? "currentColor" : "none"}
                  />
                </button>
              )}
              <Button onClick={() => setBidOpen(true)} size="sm">
                Back this launch
              </Button>
              {isFounder ? (
                <Button
                  onClick={() => setUpdateOpen(true)}
                  size="sm"
                  variant="outline"
                >
                  Post update
                </Button>
              ) : null}
            </span>
          </span>
        }
      />

      <div
        className="flex flex-wrap gap-1 border-b border-black/10 pb-2 dark:border-white/10"
        role="tablist"
        aria-label="Launch sections"
      >
        {tabs
          .filter((t) => !t.founderOnly || isFounder)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm",
                tab === t.id
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "text-black/60 hover:bg-black/5 dark:text-white/60",
              )}
              type="button"
            >
              {t.label}
            </button>
          ))}
      </div>

      {tab === "overview" ? (
        <>
          {/* The TrustGraph surface: gate state, published roots, the graph. */}
          <TrustGateCard launch={launch} />
          <OverviewTab launch={launch} />
        </>
      ) : null}
      {tab === "discussion" && !sandbox ? (
        <LaunchDiscussion record={launch.record} updates={launch.updates} />
      ) : null}
      {tab === "updates" ? <UpdatesTab launch={launch} /> : null}
      {tab === "proposals" ? (
        <ProposalsTab launch={launch} onDissent={() => setTab("treasury")} />
      ) : null}
      {tab === "mybids" && launch.record.auction ? (
        <MyBidsPanel
          record={launch.record}
          rpcEndpoint={getRpcEndpoint()}
          autoAction={mybidsAutoAction}
        />
      ) : null}
      {tab === "treasury" ? (
        <TreasuryTab
          launch={launch}
          onProposeReturn={(title) => {
            void mirror.mutateAsync({
              kind: KIND_LAUNCH_PROPOSAL,
              author: launch.record.author,
              launchId: launch.record.id,
              content: {
                kind: "return-capital",
                title,
                state: "open",
              },
            });
          }}
        />
      ) : null}
      {tab === "manage" && isFounder ? (
        <ManagePanel
          launchId={launch.record.id}
          author={launch.record.author}
          isDeleting={remove.isPending}
          onDelete={async () => {
            const target = launch;
            try {
              await remove.mutateAsync(target);
              toast.success("Launch removed from the directory.");
              void navigate({ to: "/launchpad" });
            } catch (err) {
              toast.error(
                err instanceof Error ? err.message : "Delete failed.",
              );
            }
          }}
        />
      ) : null}

      {bidOpen ? (
        <RecordBidDialog
          isPublishing={mirror.isPending}
          launchName={launch.record.name}
          record={launch.record}
          rpcEndpoint={getRpcEndpoint()}
          onClose={() => setBidOpen(false)}
          onPublish={recordBid}
        />
      ) : null}
      {updateOpen && isFounder ? (
        <PostUpdateDialog
          isPublishing={mirror.isPending}
          onClose={() => setUpdateOpen(false)}
          onPublish={postUpdate}
        />
      ) : null}
    </div>
  );
}

function OverviewTab({ launch }: { launch: TabLaunch }) {
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
      "Graduation threshold",
      goal
        ? `${formatMoney(goal, cur)}${percent !== null ? ` · ${percent}% reached` : ""}`
        : "None set — the auction graduates at any raise",
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
      "Tick spacing",
      record.tickSpacing
        ? `${formatAtomic(record.tickSpacing, 0)} (price granularity)`
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
      "Admission",
      record.admission === "community" ? "Community track" : "Curated track",
    ],
    ["Chain", record.chainId ?? "Undeployed"],
  ];
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
            Preview fixture — development builds only, never live figures.
          </p>
        ) : null}
        {progress.data?.source === "unavailable" ? (
          <div
            className="mt-2 text-xs text-black/60 dark:text-white/60"
            data-testid="launch-progress-unavailable"
          >
            <p>
              {progress.data.reason === "no auction contract linked"
                ? "No auction contract is linked to this launch yet, so there is nothing to read from the chain."
                : "The chain could not be read, so no live figures are shown."}
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
                {ALLOCATION_LABELS.map(({ key, label }) => {
                  const share = record.allocation[key];
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
                  ? `${sample.label} buys about ${formatAtomic(perThousand, 0)} tokens at the floor price — less if the sale clears higher.`
                  : "Link a floor price and a token plan to see what a budget buys."}{" "}
                The sale clears at one uniform price; you pay that, not your
                maximum.
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
      <LaunchContractsCard record={record} />
      <ProvenCommitmentsCard launch={launch} />
      {/* The outcome half of the trust surface: verdicts, claims, receipts and
          contribution reviews, each figure shown with its derivation
          (`lib/trust-signals.ts`). */}
      <TrackRecordCard launch={launch} />
      <ScoreRootsCard />
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
        The record is a signed promise; the chain is the ledger. Addresses are
        checked for deployed code over your RPC endpoint — anything unreadable
        says so rather than showing a check.
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
        Scores are proven against this root; a claimed score on a profile is
        only shown as proven when its Merkle proof verifies client-side.
        {latest.anchorBlock !== null
          ? ` Anchored at block ${latest.anchorBlock}.`
          : ""}
      </p>
      {latest.indexerUrl ? (
        <a
          className="mt-1 inline-block text-xs text-primary underline"
          href={latest.indexerUrl}
          rel="noreferrer"
          target="_blank"
        >
          Proofs and score file
        </a>
      ) : null}
    </Card>
  );
}

function UpdatesTab({ launch }: { launch: TabLaunch }) {
  if (launch.updates.length === 0) {
    return (
      <p className="text-sm text-black/60 dark:text-white/60">
        No updates yet. Founders post signed updates here.
      </p>
    );
  }
  return (
    <ol className="flex max-w-2xl flex-col gap-3">
      {launch.updates.map((u) => (
        <li key={u.id}>
          <Card className="p-4">
            <h3 className="text-sm font-semibold">{u.title}</h3>
            <p className="mt-0.5 text-xs tabular-nums text-black/60 dark:text-white/60">
              {new Date(u.createdAt * 1000).toLocaleString()}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm">{u.body}</p>
          </Card>
        </li>
      ))}
    </ol>
  );
}

function ProposalsTab({
  launch,
  onDissent,
}: {
  launch: TabLaunch;
  /** D2: the dissent door — jump to the treasury tab's ragequit. */
  onDissent: () => void;
}) {
  // One batched lookup for every proposer this tab renders, rather than a query
  // per proposal row.
  const proposers = useMemo(
    () => [...new Set(launch.proposals.map((p) => p.author))],
    [launch.proposals],
  );
  const userNames = useUserNames(proposers);
  // The bound DAO for onchain actions (D8: record-only when unbound) — the
  // same resolution the treasury tab uses (`lib/org-money.ts`).
  const orgMoney = useOrgMoney();
  const daoBinding = resolveDaoBinding({
    receipts: launch.receipts,
    orgBindings: orgMoney.data?.bindings ?? [],
  });

  if (launch.proposals.length === 0) {
    return (
      <div className="text-sm text-black/60 dark:text-white/60">
        <p>No proposals yet.</p>
        <p className="mt-1">
          Signal proposals live as git issues; budget proposals go onchain after
          graduation. Futarchy resolves budget and subDAO allocation only.
        </p>
      </div>
    );
  }
  return (
    <>
      <WikiDraftComposer
        launchCoordinate={launchCoordinate(
          launch.record.author,
          launch.record.id,
        )}
        proposals={launch.proposals}
      />
      <ol className="flex max-w-2xl flex-col gap-2">
        {launch.proposals.map((p) => (
          <li key={p.id}>
            <ProposalCard
              proposal={p}
              dao={daoBinding?.dao ?? null}
              displayName={userNames(p.author)}
              onDissent={onDissent}
            />
          </li>
        ))}
      </ol>
    </>
  );
}
