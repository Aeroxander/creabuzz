import { MEANINGFUL_EVENT } from "@/features/notifications/lib/browser-notify";
import type { SponsorIntent } from "../lib/sponsor";
import type { ChallengeIntent } from "../lib/challenge";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { BackIdeaButton } from "./BackIdeaButton";
import { IdeaOverview } from "./IdeaOverview";
import { IdeaProgressCard } from "./IdeaProgressCard";
import { SaleProgressCard } from "./SaleProgressCard";
import { isSetupStage } from "../lib/sale-steps";
import { raisesOffered } from "../lib/raises-offered";
import { LaunchChatCard } from "./LaunchChatCard";
import { AGENT_NEEDS_PERSON, useViewerIsAgent } from "../use-account-agent";
import { ListingNote } from "./ListingNote";
import { MoreToSetUp } from "./MoreToSetUp";
import { LaunchTabRow } from "./LaunchTabRow";
import { ShareMenu } from "./ShareMenu";
import { ProjectRecordLine } from "./ProjectRecordLine";
import { SoloWinProvider } from "./SoloWinHost";
import { StartYours } from "./StartYours";
import { PostUpdateDialog } from "./PostUpdateDialog";
import { UpdatePosted } from "./UpdatePosted";
import { JoinAskButton } from "./JoinAskButton";
import { TeamPostUpdate } from "./ProjectTeamCard";
import { LaunchHero } from "./LaunchHero";
import { LaunchChoice } from "./LaunchChoice";
import { LaunchMissing } from "./LaunchMissing";
import { ProjectLoadError } from "./ProjectLoadError";
import { isInviteOnlyRefusal } from "../lib/refusal-copy";
import { restrictionOf } from "@/shared/lib/refusal-text";
import { Button } from "@/shared/ui/button";
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
  pageTabs,
  tabAlias,
  tabShown,
  type TabUse,
  updatesLabel,
} from "../lib/launch-tabs";
import { teamOf } from "../lib/help-request";
import { NOT_LISTED_LINE, notListedYet } from "../lib/listing";
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
import { ProjectGoalCard } from "./ProjectGoalCard";
import { ProjectOpenHelp } from "./ProjectOpenHelp";
import { AgentPostCard } from "./AgentPostCard";
import { AgentWorkNote } from "./AgentWorkNote";
import { FounderPostButton, ProjectNews } from "./FirstWeekCard";
import { SetUpCards } from "./ProjectSetUp";
import { StartedCard } from "./StartedCard";
import { isAiCategory } from "../lib/agent-post";
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
import { BackingBlock } from "./BackingBlock";
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
  started,
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
  /** `?started=1`: the project was just made from Start, so the page welcomes its founder. */
  started?: 1;
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
  const viewerIsAgent = useViewerIsAgent();
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
  const [updatePosted, setUpdatePosted] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);
  /** The server's reason for refusing the update, in plain words, when it gave one. */
  const [updateWhy, setUpdateWhy] = useState<string | null>(null);
  /** Where the update form puts the cursor: "help" for "Help needed" (the first-week card's "Ask for help"). */
  const [updateStart, setUpdateStart] = useState<"help" | undefined>(undefined);
  const setUpdateOpen = useCallback((open: boolean) => {
    setUpdateFailed(false);
    setUpdateStart(undefined);
    setUpdateOpenRaw(open);
  }, []);
  const askForHelp = useCallback(() => {
    setUpdateFailed(false);
    setUpdateStart("help");
    setUpdateOpenRaw(true);
  }, []);
  // A project just made from Start: its one live line, which can be put away.
  const [welcome, setWelcome] = useState(started === 1);
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
  // Consume the deep link once: `bid` opens the bid dialog (sender picker);
  // `exit`/`claim` land on the My-bids section and expand the matching bid's
  // action there.
  useEffect(() => {
    // `update` needs to know who is looking, so it waits for the effect below.
    if (!action || action === "update") return;
    if (action === "bid") {
      // A contributor-only build takes no bids, so a shared bid link opens nothing there.
      if (raisesOffered()) setBidOpen(true);
      return;
    }
    setMybidsAutoAction(action);
    setTab("mybids");
  }, [action, setTab]);

  // `?action=update` (the calendar reminder's link) opens the founder's update form once the page knows who is looking,
  // then leaves the address as a plain project address, so a reload does not open it again. Anyone else gets the page.
  const updateLinkUsed = useRef(false);
  useEffect(() => {
    if (action !== "update" || updateLinkUsed.current) return;
    if (!launch || !isFounder || viewerIsAgent) return;
    updateLinkUsed.current = true;
    setUpdateOpen(true);
    void navigate({
      search: (previous) => ({ ...previous, action: undefined }),
      replace: true,
    });
  }, [action, launch, isFounder, viewerIsAgent, setUpdateOpen, navigate]);

  // A link that names no author, to an id several people have a project under: the reader picks, nothing is guessed.
  if (!sandbox && !isLoading && !launch && several)
    return <LaunchChoice authors={several} launchId={launchId} />;
  if (!sandbox && !isLoading && !launch && isInviteOnlyRefusal(readError))
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <ProjectLoadError
          error={readError}
          onRetry={() => void refetch()}
          testId="launch-load-error"
        />
      </div>
    );
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
    const { content, tags } = updateEvent(draft, {
      promises: isFounder && !viewerIsAgent,
    });
    setUpdateFailed(false);
    try {
      await mirror.mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        extraTags: tags,
        content,
      });
      setUpdateOpen(false);
      setUpdatePosted(true);
      window.dispatchEvent(new Event(MEANINGFUL_EVENT));
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
  const tabs = pageTabs({
    workDao: Boolean(workDao),
    contributor,
    milestones: launch.record.unlocks?.mode === "milestones",
    auction: Boolean(launch.record.auction),
    sandbox: Boolean(sandbox),
    // Counted as the tab lists them, from this project's own records; no number while those are not read.
    // A read that was cut short found "at least" that many, so no number is stated.
    updatesLabel: sandbox
      ? updatesLabel(projectProgress([launch], []).length, true)
      : updatesLabel(tabState.updates, tabState.updatesComplete),
  });
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
  // The founder as a person: an agent account sets no goals and promises nothing, so it is not walked through a first week.
  const founderPerson = isFounder && !viewerIsAgent && !sandbox;
  const dismissWelcome = () => {
    setWelcome(false);
    // The address drops `?started=1`, so a reload or a shared copy of it is the plain page.
    void navigate({
      search: (previous) => ({ ...previous, started: undefined }),
      replace: true,
    });
  };

  const raiseOverview = (
    <>
      {contributor ? null : <SalePriceCard launch={launch} />}
      <OverviewTab
        launch={launch}
        onOpenMilestones={() => setTab("milestones")}
      />
    </>
  );

  // Someone on the project's team (the founder, or a person the founder added) has no one to follow it for.
  const me = existingUserPubkey();
  const onTeam = me !== null && teamOf(launch.record).has(me);
  const goalCard = sandbox ? null : (
    <ProjectGoalCard isFounder={isFounder && !viewerIsAgent} launch={launch} />
  );
  const news = sandbox ? null : (
    <ProjectNews
      firstWeek={founderPerson}
      isFounder={isFounder}
      launch={launch}
      onAskForHelp={askForHelp}
      onOpenUpdates={() => setTab("updates")}
      onPostUpdate={() => setUpdateOpen(true)}
      showCard={shown !== "updates"}
      workTab={hasWorkTab}
    />
  );
  const chatCard =
    sandbox || stage === "graduated" ? null : (
      <LaunchChatCard isFounder={isFounder} launch={launch} />
    );

  const page = (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-3">
        <LaunchHero
          actions={
            <>
              {idea ? (
                onTeam ? null : (
                  <BackIdeaButton
                    disabled={!follows.ready || follows.pending}
                    followed={followed}
                    onToggle={toggleFollow}
                    supportersRoom={launch.record.chat.supporters}
                  />
                )
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
                <FounderPostButton
                  firstWeek={founderPerson}
                  launch={launch}
                  onPost={() => setUpdateOpen(true)}
                />
              ) : sandbox ? null : (
                <TeamPostUpdate
                  launch={launch}
                  onOpen={() => setUpdateOpen(true)}
                />
              )}
              {isFounder || sandbox || onTeam ? null : (
                <JoinAskButton
                  project={launch.record}
                  quiet={idea || (mainAction !== null && raisesOffered())}
                />
              )}
              {sandbox ? null : (
                <ShareMenu isFounder={isFounder} launch={launch} />
              )}
            </>
          }
          belowName={
            sandbox ? null : (
              <div className="flex flex-col items-start gap-1">
                <ProjectRecordLine
                  launch={launch}
                  viewerIsFounder={isFounder}
                  withLink={!founderPerson}
                />
                <StartYours />
              </div>
            )
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
              <OwnershipOnlyNote className="max-w-60 text-right max-sm:max-w-none max-sm:text-left" />
            )
          }
          onToggleFollow={() => toggleFollow()}
          record={launch.record}
          followNote={!sandbox && !onTeam}
          showFollow={!sandbox && !idea && !onTeam}
          stage={stage}
        />
        {founderPerson && welcome ? (
          <StartedCard onDismiss={dismissWelcome} project={launch.record} />
        ) : null}
        {/* The listing choice itself is under "More to set up"; that the project is not listed is said here, always. */}
        {founderPerson && notListedYet(launch.record) ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="project-unlisted-note"
            role="status"
          >
            {NOT_LISTED_LINE}
          </p>
        ) : null}
      </div>

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
          {founderPerson ? null : (
            <ListingNote isFounder={isFounder} launch={launch} stage={stage} />
          )}
          {isFounder && viewerIsAgent ? (
            <p
              className="text-sm"
              data-testid="agent-founder-note"
              role="status"
            >
              {AGENT_NEEDS_PERSON}
            </p>
          ) : null}
        </>
      )}

      {updatePosted ? (
        <UpdatePosted
          onClose={() => setUpdatePosted(false)}
          project={launch.record}
        />
      ) : null}
      {/* A founder's first week is the next step, so it comes first. Everyone else reads what the project is for
          (its goal, and how everyone will know) before its news. The news is above the tabs; the Updates tab is the
          full list, so it is not repeated there. */}
      {founderPerson ? (
        <>
          {news}
          {goalCard}
        </>
      ) : (
        <>
          {goalCard}
          {news}
        </>
      )}

      {sandbox ? null : (
        <>
          <AgentWorkNote launch={launch} />
          {founderPerson && isAiCategory(launch.record.category) ? (
            <AgentPostCard project={launch.record} />
          ) : null}
          <ProjectOpenHelp launch={launch} workTab={hasWorkTab} />
          <SetUpCards isFounder={isFounder} launch={launch} />
          {/* Backing comes after the record, so the record is read first and the money second. It renders nothing unless
              the build turns investing on, and nothing for a project that cannot be backed. */}
          <BackingBlock isFounder={isFounder} launch={launch} variant="page" />
        </>
      )}

      {!sandbox && isFounder && idea && !founderPerson ? (
        <IdeaProgressCard launch={launch} />
      ) : null}

      {!sandbox && isFounder && !idea && isSetupStage(stage) ? (
        <SaleProgressCard
          launch={launch}
          onOpenManage={() => setTab("manage")}
          onPostUpdate={() => setUpdateOpen(true)}
        />
      ) : null}

      {founderPerson ? null : chatCard}

      <LaunchTabRow
        label={contributor ? "Project sections" : "Launch sections"}
        onPick={setTab}
        shown={shown}
        tabs={rowTabs}
      />

      {shown === "overview" && idea ? (
        <>
          <IdeaOverview onTeam={onTeam} record={launch.record} />
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
      founderSettings(kind) === "settings" ? (
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

      {/* The chat rooms, the announcement step and the listing choice: put away for a founder, nothing lost. */}
      {founderPerson ? (
        <MoreToSetUp>
          {chatCard}
          {idea ? <IdeaProgressCard launch={launch} /> : null}
          <ListingNote isFounder={isFounder} launch={launch} stage={stage} />
        </MoreToSetUp>
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
      {updateOpen && isFounder && !viewerIsAgent ? (
        <UpdateDialogWithPromises
          failed={updateFailed}
          failedWhy={updateWhy}
          isPublishing={mirror.isPending}
          onClose={() => setUpdateOpen(false)}
          onPublish={postUpdate}
          project={launch.record}
          startAt={updateStart}
        />
      ) : updateOpen ? (
        <PostUpdateDialog
          agent={viewerIsAgent}
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

  return founderPerson ? (
    <SoloWinProvider launch={launch}>{page}</SoloWinProvider>
  ) : (
    page
  );
}
