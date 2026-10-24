import { markFirstStep } from "@/shared/lib/first-steps";
import type { SponsorIntent } from "../lib/sponsor";
import type { ChallengeIntent } from "../lib/challenge";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { useUserNames } from "@/features/profiles/use-profiles";
import { BackIdeaButton } from "./BackIdeaButton";
import { IdeaOverview } from "./IdeaOverview";
import { IdeaProgressCard } from "./IdeaProgressCard";
import { SaleProgressCard } from "./SaleProgressCard";
import { isSetupStage } from "../lib/sale-steps";
import { LaunchChatCard } from "./LaunchChatCard";
import { LaunchHero } from "./LaunchHero";
import { PriceChartCard } from "./PriceChartCard";
import { TradeCard } from "./TradeCard";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { KIND_LAUNCH_BID, KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import {
  useDeleteLaunch,
  useIsFounder,
  useLaunch,
  usePublishMirror,
} from "../use-launches";
import { effectiveStage, isEvmAddress, type Launch } from "../models";
import { effectiveFundingAt, isContributorProject } from "../lib/funding";
import { saleView } from "../lib/sale-action";
import { SaleActionButton } from "./SaleActionButton";
import { isIdea } from "../lib/idea";
import { useChainBlockHeight } from "@/features/feed/use-feed";
import { markSupportersSeen } from "../use-founder-activity";
import { useSupporters } from "../use-supporters";
import type { LaunchAction } from "../lib/deep-link";
import { TreasuryTab } from "./TreasuryTab";
import { LaunchDiscussion } from "@/features/feed/ui/LaunchDiscussion";
import { launchCoord } from "@/features/feed/ui/LaunchVoteCard";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";

type TabLaunch = Launch;

import { getRpcEndpoint } from "../chain";
import { useAuctionProgress, OwnershipOnlyNote } from "./widgets";
import { RecordBidDialog } from "./RecordBidDialog";
import { PostUpdateDialog } from "./PostUpdateDialog";
import { sandboxRecord } from "../lib/sandbox";
import { ManagePanel } from "./ManagePanel";
import { DecisionsTab } from "./DecisionsTab";
import { RecordTab } from "./RecordTab";
import { WorkTab } from "./WorkTab";
import { ContributionsTab } from "./ContributionsTab";
import { MilestonesTab } from "./MilestonesTab";
import { OverviewTab } from "./OverviewTab";
import { ProjectProgressFeed } from "@/features/feed/ui/ProjectProgressFeed";
import { ProjectAgents } from "@/features/fleet/ui/ProjectAgents";
import { ProjectDeliveryOverview } from "./ProjectDeliveryOverview";
import { ContributorStatusNote } from "./ContributorStatusNote";
import { DaoOverview } from "./DaoOverview";
import { MyBidsPanel } from "./MyBidsPanel";
import { ProposalCard } from "./ProposalCard";
import { WikiDraftComposer } from "./WikiDraftComposer";
import { launchCoordinate } from "../models";
import { resolveDaoBinding } from "../lib/org-money";
import { useOrgMoney } from "../use-launches";

type Tab =
  | "overview"
  | "milestones"
  | "discussion"
  | "updates"
  | "proposals"
  | "treasury"
  | "mybids"
  | "decisions"
  | "work"
  | "contributions"
  | "record"
  | "agents"
  | "manage";

/** The tabs a contributor project shows: its work, its votes, who earned what, and the talk around it. */
const CONTRIBUTOR_TABS: Tab[] = [
  "overview",
  "contributions",
  "decisions",
  "work",
  "discussion",
  "updates",
];

export function LaunchDetailPage({
  launchId,
  author,
  action,
  sandbox,
  initialTab,
  initialDecision,
  initialClaim,
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
  /** The tab to open on (`?tab=`), when the link names one. */
  initialTab?: Tab;
  /** One decision to highlight on the Decisions tab (`?decision=`). */
  initialDecision?: string;
  initialClaim?: { id: string; mandate: string };
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
  const supporterCoord = realLaunch ? launchCoord(realLaunch.record) : null;
  const supporterCounts = useSupporters(supporterCoord ? [supporterCoord] : []);
  // The chain head is what tells a declared stance apart from a live sale.
  const blockHeight = useChainBlockHeight();
  const auctionRead = useAuctionProgress(launch?.record).data;
  // A founder who opens their launch has seen its supporters.
  const seenCount = supporterCoord
    ? (supporterCounts.data?.get(supporterCoord) ?? null)
    : null;
  useEffect(() => {
    if (isFounder && supporterCoord && seenCount !== null) {
      markSupportersSeen(supporterCoord, seenCount);
    }
  }, [isFounder, supporterCoord, seenCount]);
  // Home's checklist asks a backer to look at a project: opening one counts, in this browser.
  const lookedAt = Boolean(launch) && !sandbox;
  useEffect(() => {
    if (lookedAt) markFirstStep(localStorage, "looked-at-project");
  }, [lookedAt]);
  const mirror = usePublishMirror();
  const remove = useDeleteLaunch();
  const [tab, setLocalTab] = useState<Tab>(
    initialTab ?? (initialDecision ? "decisions" : "overview"),
  );
  const [bidOpen, setBidOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [mybidsAutoAction, setMybidsAutoAction] = useState<
    "exit" | "claim" | null
  >(null);
  // A claim someone is on their way to doubt: the Decisions tab opens its form with that claim chosen, once.
  const [challenge, setChallenge] = useState<ChallengeIntent | null>(null);
  // A suggestion someone is putting to a vote: the Decisions tab opens "Approve a work area" filled in from it, once.
  const [sponsor, setSponsor] = useState<SponsorIntent | null>(null);
  useEffect(() => {
    if (tab !== "decisions") {
      setChallenge(null);
      setSponsor(null);
    }
  }, [tab]);
  const follows = useLaunchFollows();
  const navigate = useNavigate({ from: "/launchpad/$launchId" });
  const setTab = useCallback(
    (next: Tab) => {
      setLocalTab(next);
      void navigate({
        search: (previous) => ({ ...previous, tab: next }),
        replace: true,
      });
    },
    [navigate],
  );
  useEffect(() => {
    const next = initialTab ?? (initialDecision ? "decisions" : "overview");
    setLocalTab(next === "manage" && !isFounder ? "overview" : next);
  }, [initialTab, initialDecision, isFounder]);
  // Read before any early return: hooks keep their order. It resolves which DAO, if any, this launch belongs to.
  const orgMoney = useOrgMoney();

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
  }, [action, setTab]);

  if (isLoading || !launch) {
    return (
      <p className="mx-auto w-full max-w-5xl px-4 py-16 text-center text-sm text-black/60 dark:text-white/60">
        {isLoading ? "Loading launch…" : "Launch not found."}
      </p>
    );
  }

  const { stage, mainAction } = saleView(
    launch,
    effectiveStage(launch),
    blockHeight,
    auctionRead,
  );

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
      toast.success(
        "Bid noted here. The bid you made on the network is the one that counts.",
      );
      setBidOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Couldn't record the bid. Try again.",
      );
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
      toast.error(
        err instanceof Error
          ? err.message
          : "Couldn't publish the update. Try again.",
      );
    }
  };

  const daoBinding = resolveDaoBinding({
    receipts: launch.receipts,
    orgBindings: orgMoney.data?.bindings ?? [],
  });
  const idea = isIdea(launch.record);
  // A DAO made with no sale: its Shares are only ever earned for work, so who earned them leads, and no sale copy shows.
  const contributor = isContributorProject(launch.record);
  const coord = launchCoord(launch.record);
  const followed = follows.followed.has(coord);

  // The Work tab needs a DAO to read: the one this launch settled into, or the one its community bound.
  const workDao =
    isEvmAddress(launch.record.treasury ?? "") &&
    launch.record.tokenPlan?.mode === "dao"
      ? (launch.record.treasury as string)
      : (daoBinding?.dao ?? null);
  // What people come back for goes first. A DAO is run from Decisions and Work, so those lead; a raise that has not
  // become a DAO leads with its money and its bids. "Proposals" are the older, recorded kind: once a DAO's decisions
  // are read from the chain they are only worth a tab if there are some to look at, so an empty one stays out of the way.
  const proposalsTab = {
    id: "proposals" as const,
    label: `Proposals (${launch.proposals.length})`,
  };
  const contributionsTab = {
    id: "contributions" as const,
    label: "Contributions",
  };
  const tabs: Array<{ id: Tab; label: string; founderOnly?: boolean }> = [
    { id: "overview", label: "Overview" },
    ...(workDao && contributor ? [contributionsTab] : []),
    // The agreement a backer follows: shown for any project whose team tokens unlock against milestones, funded or not.
    ...(launch.record.unlocks?.mode === "milestones"
      ? [{ id: "milestones" as const, label: "Milestones" }]
      : []),
    ...(workDao ? [{ id: "decisions" as const, label: "Decisions" }] : []),
    ...(workDao ? [{ id: "work" as const, label: "Work" }] : []),
    ...(workDao && !contributor ? [contributionsTab] : []),
    { id: "agents", label: "People & agents" },
    ...(workDao ? [{ id: "record" as const, label: "Track record" }] : []),
    { id: "treasury", label: "Treasury" },
    // Onchain bids only exist when the launch has an auction linked.
    ...(launch.record.auction
      ? [{ id: "mybids" as const, label: "My bids" }]
      : []),
    // A simulated launch has no public discussion to join.
    ...(sandbox ? [] : [{ id: "discussion" as const, label: "Discussion" }]),
    { id: "updates", label: `Updates (${launch.updates.length})` },
    ...(workDao && launch.proposals.length === 0 ? [] : [proposalsTab]),
    { id: "manage", label: "Manage", founderOnly: true },
  ];
  // An idea has no money, proposals or treasury yet; showing those tabs empty
  // makes the page look broken rather than early.
  const visibleTabs = idea
    ? tabs.filter((t) =>
        ["overview", "agents", "discussion", "updates", "manage"].includes(
          t.id,
        ),
      )
    : contributor
      ? // No sale, no money and no team allocation: the tabs about those would be empty or say what is not true.
        tabs.filter((t) => CONTRIBUTOR_TABS.includes(t.id))
      : tabs;
  // A link to a tab this project does not show (an old `?tab=treasury`) opens the overview.
  const shown: Tab = visibleTabs.some(
    (t) => t.id === tab && (!t.founderOnly || isFounder),
  )
    ? tab
    : "overview";

  const raiseOverview = (
    <>
      {/* The TrustGraph surface: gate state, published roots, the graph. */}
      {contributor ? null : <PriceChartCard launch={launch} />}
      {workDao && !contributor ? (
        <TradeCard dao={workDao} launch={launch} />
      ) : null}
      <OverviewTab
        launch={launch}
        onOpenMilestones={() => setTab("milestones")}
      />
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <LaunchHero
        actions={
          <>
            {idea ? (
              <BackIdeaButton
                disabled={!follows.ready || follows.pending}
                followed={followed}
                onToggle={(onDone) => follows.toggle(coord, onDone)}
                supportersRoom={launch.record.chat.supporters}
              />
            ) : mainAction === null ? null : (
              <SaleActionButton
                action={mainAction}
                onBid={() => setBidOpen(true)}
                onOpenBids={(what) => {
                  setMybidsAutoAction(what);
                  setTab("mybids");
                }}
              />
            )}
            {isFounder ? (
              <Button onClick={() => setUpdateOpen(true)} variant="outline">
                Post update
              </Button>
            ) : null}
          </>
        }
        followDisabled={!follows.ready || follows.pending}
        followed={followed}
        funding={effectiveFundingAt(launch, stage, blockHeight)}
        idea={idea}
        supporters={
          supporterCoord
            ? (supporterCounts.data?.get(supporterCoord) ?? null)
            : null
        }
        note={
          contributor ? (
            <ContributorStatusNote
              chainId={launch.record.chainId ?? null}
              dao={workDao}
              shares={
                isEvmAddress(launch.record.token ?? "")
                  ? (launch.record.token as string)
                  : null
              }
            />
          ) : (
            /* §7 "Launch page copy": what a buyer acquires, said before the
               bid button — ownership only, never a yield. */
            <OwnershipOnlyNote className="max-w-60 text-right" />
          )
        }
        onToggleFollow={() => follows.toggle(coord)}
        record={launch.record}
        showFollow={!sandbox && !idea}
        stage={stage}
      />

      {!sandbox && isFounder && idea ? (
        <IdeaProgressCard launch={launch} />
      ) : null}

      {!sandbox && isFounder && !idea && isSetupStage(stage) ? (
        <SaleProgressCard
          launch={launch}
          onOpenManage={() => setTab("manage")}
          onPostUpdate={() => setUpdateOpen(true)}
        />
      ) : null}

      {sandbox || stage === "graduated" ? null : (
        <LaunchChatCard isFounder={isFounder} launch={launch} />
      )}

      <div
        className="flex gap-x-5 overflow-x-auto border-b border-border"
        role="tablist"
        aria-label="Launch sections"
      >
        {visibleTabs
          .filter((t) => !t.founderOnly || isFounder)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={shown === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px shrink-0 whitespace-nowrap border-b-[3px] px-1 pb-2 text-sm font-semibold transition-colors",
                shown === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              type="button"
            >
              {t.label}
            </button>
          ))}
      </div>

      {shown === "overview" && idea ? (
        <>
          <IdeaOverview record={launch.record} />
          <ProjectDeliveryOverview
            launch={launch}
            dao={workDao}
            onOpen={setTab}
          />
          <ProjectProgressFeed project={launch} compact />
        </>
      ) : null}
      {shown === "overview" && !idea ? (
        workDao && stage === "graduated" ? (
          <DaoOverview
            dao={workDao}
            launch={launch}
            onOpen={(target, claim) => {
              if (!claim) {
                setTab(target);
                return;
              }
              // Open the claim itself: the Work tab scrolls to it and focuses it.
              setLocalTab(target);
              void navigate({
                search: (previous) => ({
                  ...previous,
                  tab: target,
                  claim: claim.id,
                  mandate: claim.mandate,
                }),
                replace: true,
              });
            }}
          >
            {raiseOverview}
          </DaoOverview>
        ) : (
          raiseOverview
        )
      ) : null}
      {shown === "milestones" && !idea ? (
        <MilestonesTab
          dao={workDao}
          launch={launch}
          onOpenDecisions={() => setTab("decisions")}
          onOpenWork={() => setTab("work")}
        />
      ) : null}
      {shown === "discussion" && !sandbox ? (
        <>
          {stage === "graduated" ? (
            <LaunchChatCard isFounder={isFounder} launch={launch} />
          ) : null}
          <LaunchDiscussion record={launch.record} updates={launch.updates} />
        </>
      ) : null}
      {shown === "updates" ? <ProjectProgressFeed project={launch} /> : null}
      {shown === "agents" ? <ProjectAgents launch={launch} /> : null}
      {shown === "proposals" ? (
        <ProposalsTab launch={launch} onDissent={() => setTab("treasury")} />
      ) : null}
      {shown === "mybids" && launch.record.auction ? (
        <MyBidsPanel
          record={launch.record}
          rpcEndpoint={getRpcEndpoint()}
          autoAction={mybidsAutoAction}
        />
      ) : null}
      {shown === "treasury" ? (
        <TreasuryTab
          launch={launch}
          onOpenDecisions={() => setTab("decisions")}
        />
      ) : null}
      {shown === "decisions" && workDao ? (
        <DecisionsTab
          challenge={challenge}
          sponsor={sponsor}
          dao={workDao}
          focusDecision={initialDecision}
          launch={launch}
        />
      ) : null}
      {shown === "work" && workDao ? (
        <WorkTab
          dao={workDao}
          launch={launch}
          focusClaim={initialClaim}
          onChallenge={(intent) => {
            setChallenge(intent);
            setTab("decisions");
          }}
          onSponsor={(intent) => {
            setSponsor(intent);
            setTab("decisions");
          }}
          onOpenDecisions={() => setTab("decisions")}
        />
      ) : null}
      {shown === "contributions" && workDao ? (
        <ContributionsTab dao={workDao} launch={launch} />
      ) : null}
      {shown === "record" && workDao ? (
        <RecordTab dao={workDao} launch={launch} onOpen={(t) => setTab(t)} />
      ) : null}
      {shown === "manage" && isFounder ? (
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
                err instanceof Error
                  ? err.message
                  : "Couldn't delete the launch. Try again.",
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
          Once the raise completes, budget and treasury proposals are voted on
          here. Earlier suggestions live in the project's repos.
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
