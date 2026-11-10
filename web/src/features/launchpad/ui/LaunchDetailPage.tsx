import type { SponsorIntent } from "../lib/sponsor";
import type { ChallengeIntent } from "../lib/challenge";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { BackIdeaButton } from "./BackIdeaButton";
import { IdeaOverview } from "./IdeaOverview";
import { IdeaProgressCard } from "./IdeaProgressCard";
import { SaleProgressCard } from "./SaleProgressCard";
import { isSetupStage } from "../lib/sale-steps";
import { raisesOffered } from "../lib/raises-offered";
import { LaunchChatCard } from "./LaunchChatCard";
import { ListingNote } from "./ListingNote";
import { PostUpdateDialog } from "./PostUpdateDialog";
import { ProjectTeamCard, TeamPostUpdate } from "./ProjectTeamCard";
import { LaunchHero } from "./LaunchHero";
import { LaunchChoice } from "./LaunchChoice";
import { LaunchMissing } from "./LaunchMissing";
import { restrictionOf } from "@/shared/lib/refusal-text";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { KIND_LAUNCH_BID, KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import {
  useDeleteLaunch,
  useIsFounder,
  useLaunch,
  usePublishMirror,
} from "../use-launches";
import { effectiveStage, isEvmAddress } from "../models";
import { effectiveFundingAt, isContributorProject } from "../lib/funding";
import { saleView } from "../lib/sale-action";
import { SaleActionButton } from "./SaleActionButton";
import { isIdea } from "../lib/idea";
import {
  allowedTabs,
  founderSettings,
  ideaShowsTeamSurfaces,
  type LaunchTab,
  type PageKind,
  tabAlias,
  tabShown,
  type TabUse,
  updatesLabel,
} from "../lib/launch-tabs";
import { useChainBlockHeight } from "@/features/feed/use-feed";
import { markSupportersSeen } from "../use-founder-activity";
import { useSupporters } from "../use-supporters";
import type { LaunchAction } from "../lib/deep-link";
import { TreasuryTab } from "./TreasuryTab";
import { ContributorFundsTab } from "./ContributorFundsTab";
import { ContributorSettings } from "./ContributorSettings";
import { LaunchDiscussion } from "@/features/feed/ui/LaunchDiscussion";
import { launchCoord } from "@/features/feed/ui/LaunchVoteCard";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";

import { getRpcEndpoint } from "../chain";
import { useAuctionProgress, OwnershipOnlyNote } from "./widgets";
import { RecordBidDialog } from "./RecordBidDialog";
import { ProjectUpdateCard } from "./ProjectUpdateCard";
import { ProjectGoalCard } from "./ProjectGoalCard";
import { ProjectOpenHelp } from "./ProjectOpenHelp";
import { ProjectRecordCard } from "./ProjectRecordCard";
import { ProjectTasksCard } from "./ProjectTasksCard";
import { helpQueryKey } from "../use-help-requests";
import {
  ProjectUpdatesTab,
  TabUsesProbe,
  UpdateDialogWithPromises,
} from "./ProjectFrontParts";
import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type UpdateDraft, updateEvent } from "../lib/weekly-update";
import { sandboxRecord } from "../lib/sandbox";
import { ManagePanel } from "./ManagePanel";
import { DecisionsTab } from "./DecisionsTab";
import { RecordTab } from "./RecordTab";
import { WorkTab } from "./WorkTab";
import { ContributionsTab } from "./ContributionsTab";
import { MilestonesTab } from "./MilestonesTab";
import { OverviewTab } from "./OverviewTab";
import { ProjectBoardsTab } from "./ProjectBoardsTab";
import { SalePriceCard } from "./SalePriceCard";
import { ProjectProgressFeed } from "@/features/feed/ui/ProjectProgressFeed";
import { projectProgress } from "@/features/feed/lib/project-progress";
import { ProjectAgents } from "@/features/fleet/ui/ProjectAgents";
import { ProjectDeliveryOverview } from "./ProjectDeliveryOverview";
import { ContributorStatusNote } from "./ContributorStatusNote";
import { DaoOverview } from "./DaoOverview";
import { TradingCard } from "./TradingCard";
import { MyBidsPanel } from "./MyBidsPanel";
import { resolveDaoBinding } from "../lib/org-money";
import { useOrgMoney } from "../use-launches";

type Tab = LaunchTab;

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
  const {
    launch: realLaunch,
    isLoading,
    error: readError,
    refetch,
    several,
    cut: readCut,
  } = useLaunch(launchId, author);
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
  const mirror = usePublishMirror();
  const queryClient = useQueryClient();
  const remove = useDeleteLaunch();
  const [tab, setLocalTab] = useState<Tab>(
    initialTab ?? (initialDecision ? "decisions" : "overview"),
  );
  const [bidOpen, setBidOpen] = useState(false);
  const [updateOpen, setUpdateOpenRaw] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);
  /** The server's reason for refusing the update, in plain words, when it gave one. */
  const [updateWhy, setUpdateWhy] = useState<string | null>(null);
  const setUpdateOpen = useCallback((open: boolean) => {
    setUpdateFailed(false);
    setUpdateOpenRaw(open);
  }, []);
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
  // Which of the tabs shown only once used this project uses, and how many updates it has. Until that is read they are
  // taken as not used, so a tab appears when the answer comes instead of showing and then going; a read that fails
  // answers "unknown", which shows the tab. A pretend project reads nothing, so nothing of it is held back.
  const [tabState, setTabState] = useState<{
    uses: Partial<Record<Tab, TabUse>>;
    updates: number | null;
    updatesComplete: boolean;
  }>(() => ({
    uses: sandbox ? {} : { updates: "no", boards: "no", agents: "no" },
    updates: null,
    updatesComplete: false,
  }));
  const tabUses = tabState.uses;
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
  // On a narrow screen the tab row scrolls: the chosen tab is kept in view, and a fade says more tabs are off to a side.
  const tabRow = useRef<HTMLDivElement | null>(null);
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const measureTabs = useCallback(() => {
    const row = tabRow.current;
    if (!row) return;
    const left = row.scrollLeft > 2;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 2;
    setTabOverflow((was) =>
      was.left === left && was.right === right ? was : { left, right },
    );
  }, []);
  const loaded = Boolean(launch);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the tab changes or the row first appears
  useEffect(() => {
    const row = tabRow.current;
    const chosen = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    // Sideways only: scrolling the page to the tab row would move someone who is reading further down.
    if (row && chosen) {
      const start = chosen.offsetLeft;
      const end = start + chosen.offsetWidth;
      if (start < row.scrollLeft) row.scrollLeft = Math.max(0, start - 16);
      else if (end > row.scrollLeft + row.clientWidth)
        row.scrollLeft = end - row.clientWidth + 16;
    }
    measureTabs();
  }, [tab, loaded, measureTabs]);
  useEffect(() => {
    window.addEventListener("resize", measureTabs);
    return () => window.removeEventListener("resize", measureTabs);
  }, [measureTabs]);

  // Consume the deep link once: `bid` opens the bid dialog (sender picker);
  // `exit`/`claim` land on the My-bids section and expand the matching bid's
  // action there.
  useEffect(() => {
    if (!action) return;
    if (action === "bid") {
      // A contributor-only build takes no bids, so a shared bid link opens nothing there.
      if (raisesOffered()) setBidOpen(true);
      return;
    }
    setMybidsAutoAction(action);
    setTab("mybids");
  }, [action, setTab]);

  // A link that names no author, to an id several people have a project under: the reader picks, nothing is guessed.
  if (!sandbox && !isLoading && !launch && several)
    return <LaunchChoice authors={several} launchId={launchId} />;
  if (isLoading || !launch) {
    return (
      <LaunchMissing
        error={readError}
        loading={isLoading}
        onRetry={() => void refetch()}
      />
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

  const postUpdate = async (draft: UpdateDraft) => {
    // A team member's update makes no promises: the server takes those from the founder alone.
    const { content, tags } = updateEvent(draft, { promises: isFounder });
    setUpdateFailed(false);
    try {
      await mirror.mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        extraTags: tags,
        content,
      });
      toast.success("Update published.");
      setUpdateOpen(false);
      // The card at the top reads this project's updates on its own: read them again so it shows the new one.
      void queryClient.invalidateQueries({ queryKey: helpQueryKey });
    } catch (error) {
      // Said in the dialog, which stays open with what was written.
      setUpdateWhy(restrictionOf(error));
      setUpdateFailed(true);
    }
  };

  /** Take the project off the directory (Manage, or a contributor project's settings), then go back to Discover. */
  const removeFromDirectory = async () => {
    try {
      await remove.mutateAsync(launch);
      toast.success("Taken off the directory.");
      void navigate({ to: "/discover" });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't remove it. Try again.",
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
  // Signed out: the account dialog, then the person can come back to the same button.
  const toggleFollow = (onDone?: () => void) => {
    if (existingUserPubkey() === null) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    follows.toggle(coord, onDone);
  };

  // The Work tab needs a DAO to read: the one this launch settled into, or the one its community bound.
  const workDao =
    isEvmAddress(launch.record.treasury ?? "") &&
    launch.record.tokenPlan?.mode === "dao"
      ? (launch.record.treasury as string)
      : (daoBinding?.dao ?? null);
  // What people come back for goes first. A DAO is run from Decisions and Work, so those lead; a raise that has not
  // become a DAO leads with its money and its bids.
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
    { id: "treasury", label: contributor ? "Funds" : "Treasury" },
    // Onchain bids only exist when the launch has an auction linked.
    ...(launch.record.auction
      ? [{ id: "mybids" as const, label: "My bids" }]
      : []),
    // A simulated launch has no public discussion to join.
    ...(sandbox ? [] : [{ id: "discussion" as const, label: "Discussion" }]),
    // A simulated project has no boards on the server to list.
    ...(sandbox ? [] : [{ id: "boards" as const, label: "Boards" }]),
    {
      id: "updates",
      // Counted as the tab lists them, from this project's own records; no number while those are not read.
      // A read that was cut short found "at least" that many, so no number is stated.
      label: sandbox
        ? updatesLabel(projectProgress([launch], []).length, true)
        : updatesLabel(tabState.updates, tabState.updatesComplete),
    },
    { id: "manage", label: "Manage", founderOnly: true },
  ];
  const raises = raisesOffered();
  const kind: PageKind = idea ? "idea" : contributor ? "contributor" : "raise";
  const allowed = allowedTabs(kind, raises);
  const visibleTabs = (
    allowed ? tabs.filter((t) => allowed.has(t.id)) : tabs
  ).filter((t) => tabShown(t.id, { isFounder, uses: tabUses }));
  const rowTabs = visibleTabs.filter((t) => !t.founderOnly || isFounder);
  // A link to a tab this project does not show (an old `?tab=treasury`) opens the overview, or the tab with the same
  // things on it.
  const wanted = tabAlias(tab, kind);
  const shown: Tab = visibleTabs.some(
    (t) => t.id === wanted && (!t.founderOnly || isFounder),
  )
    ? wanted
    : "overview";

  const hasWorkTab = visibleTabs.some((t) => t.id === "work");

  const raiseOverview = (
    <>
      {contributor ? null : <SalePriceCard launch={launch} />}
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
                onToggle={toggleFollow}
                supportersRoom={launch.record.chat.supporters}
              />
            ) : mainAction === null || !raisesOffered() ? null : (
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
            ) : sandbox ? null : (
              <TeamPostUpdate
                launch={launch}
                onOpen={() => setUpdateOpen(true)}
              />
            )}
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
        chips={
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
          ) : null
        }
        note={
          contributor ? null : (
            /* §7 "Launch page copy": what a buyer acquires, said before the
               bid button — ownership only, never a yield. */
            <OwnershipOnlyNote className="max-w-60 text-right" />
          )
        }
        onToggleFollow={() => toggleFollow()}
        record={launch.record}
        followNote={!sandbox && !isFounder}
        showFollow={!sandbox && !idea}
        stage={stage}
      />

      {sandbox ? null : (
        <>
          <TabUsesProbe launch={launch} onUses={setTabState} />
          {readCut ? (
            <p className="text-sm" data-testid="launch-read-cut" role="status">
              This project has more recorded against it than could be read here,
              so some of it may be missing below.{" "}
              <Button
                onClick={() => void refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </p>
          ) : null}
          <ListingNote isFounder={isFounder} launch={launch} stage={stage} />
          {/* What the project is for comes first: its goal, and how everyone will know. */}
          <ProjectGoalCard isFounder={isFounder} launch={launch} />
        </>
      )}

      {/* The project's news, above the tabs; the Updates tab is the full list, so it is not repeated there. */}
      {!sandbox && shown !== "updates" ? (
        <ProjectUpdateCard
          isFounder={isFounder}
          launch={launch}
          onOpenUpdates={() => setTab("updates")}
          onPostUpdate={() => setUpdateOpen(true)}
          workTab={hasWorkTab}
        />
      ) : null}

      {sandbox ? null : (
        <>
          <ProjectOpenHelp launch={launch} workTab={hasWorkTab} />
          <ProjectTasksCard launch={launch} />
          <ProjectTeamCard isFounder={isFounder} launch={launch} />
          <ProjectRecordCard isFounder={isFounder} launch={launch} />
        </>
      )}

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

      {/* One tab is no choice: the row shows once there is a second one. */}
      <div className={cn("relative", rowTabs.length < 2 && "hidden")}>
        <div
          className="flex gap-x-5 overflow-x-auto border-b border-border [scrollbar-width:none]"
          onScroll={measureTabs}
          ref={tabRow}
          role="tablist"
          aria-label={contributor ? "Project sections" : "Launch sections"}
        >
          {rowTabs.map((t) => (
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
        {/* Decorative: the tabs themselves stay reachable by keyboard and screen reader whatever is scrolled. */}
        {tabOverflow.left ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center bg-gradient-to-r from-background to-transparent"
            data-testid="tabs-more-left"
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          </span>
        ) : null}
        {tabOverflow.right ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-background to-transparent"
            data-testid="tabs-more-right"
          >
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </span>
        ) : null}
      </div>

      {shown === "overview" && idea ? (
        <>
          <IdeaOverview record={launch.record} />
          {ideaShowsTeamSurfaces(raises) ? (
            <ProjectDeliveryOverview
              launch={launch}
              dao={workDao}
              onOpen={setTab}
            />
          ) : null}
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
        />
      ) : null}
      {shown === "discussion" && !sandbox ? (
        <>
          {stage === "graduated" ? (
            <LaunchChatCard isFounder={isFounder} launch={launch} />
          ) : null}
          <LaunchDiscussion
            launch={launch}
            // Pinned are the team's own updates: not submitted work, not a work area's words, not someone else's post.
            updates={launch.updates.filter(
              (u) =>
                !u.claim &&
                !u.workArea &&
                (u.author === launch.record.author ||
                  launch.record.team.some((t) => t.pubkey === u.author)),
            )}
          />
        </>
      ) : null}
      {shown === "boards" && !sandbox ? (
        <ProjectBoardsTab isFounder={isFounder} launch={launch} />
      ) : null}
      {shown === "updates" ? (
        sandbox ? (
          <ProjectProgressFeed project={launch} />
        ) : (
          <ProjectUpdatesTab launch={launch} />
        )
      ) : null}
      {shown === "agents" ? <ProjectAgents launch={launch} /> : null}
      {shown === "mybids" && launch.record.auction ? (
        <MyBidsPanel
          record={launch.record}
          rpcEndpoint={getRpcEndpoint()}
          autoAction={mybidsAutoAction}
        />
      ) : null}
      {shown === "treasury" && contributor && workDao ? (
        <>
          <ContributorFundsTab dao={workDao} launch={launch} />
          <div className="max-w-3xl">
            <TradingCard
              chainId={launch.record.chainId ?? null}
              dao={workDao}
              saleCurrency={launch.record.currency ?? null}
            />
          </div>
        </>
      ) : shown === "treasury" ? (
        <>
          <TreasuryTab
            launch={launch}
            onOpenDecisions={() => setTab("decisions")}
          />
          {workDao ? (
            <div className="max-w-3xl">
              <TradingCard
                chainId={launch.record.chainId ?? null}
                dao={workDao}
                saleCurrency={launch.record.currency ?? null}
              />
            </div>
          ) : null}
        </>
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
          onOpenDecision={(decision) => {
            setLocalTab("decisions");
            void navigate({
              search: (previous) => ({
                ...previous,
                tab: "decisions",
                decision,
              }),
              replace: true,
            });
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
      {shown === "manage" &&
      isFounder &&
      founderSettings(kind, raises) === "settings" ? (
        <ContributorSettings
          idea={idea}
          isDeleting={remove.isPending}
          launch={launch}
          onDelete={removeFromDirectory}
        />
      ) : shown === "manage" && isFounder ? (
        <ManagePanel
          launchId={launch.record.id}
          author={launch.record.author}
          isDeleting={remove.isPending}
          onDelete={removeFromDirectory}
        />
      ) : null}

      {bidOpen && raisesOffered() ? (
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
        <UpdateDialogWithPromises
          failed={updateFailed}
          failedWhy={updateWhy}
          isPublishing={mirror.isPending}
          onClose={() => setUpdateOpen(false)}
          onPublish={postUpdate}
          project={launch.record}
        />
      ) : updateOpen ? (
        <PostUpdateDialog
          asFounder={false}
          due={[]}
          failed={updateFailed}
          failedWhy={updateWhy}
          isPublishing={mirror.isPending}
          onClose={() => setUpdateOpen(false)}
          onPublish={postUpdate}
          onRetryDue={() => undefined}
        />
      ) : null}
    </div>
  );
}
