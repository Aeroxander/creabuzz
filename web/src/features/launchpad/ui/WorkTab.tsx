import type { PasskeyAccountKeys } from "@/features/identity/lib/passkey-account";
import { reportReadFailure } from "../chain";
import { type ChallengeIntent, challengeFor } from "../lib/challenge";
import { existingUserPubkey } from "@/shared/lib/identity";
import type { SponsorIntent } from "../lib/sponsor";
import { useContributions } from "../use-contributions";
import { SuggestedWork } from "./SuggestedWork";
import { UnreadableVotesNote } from "./UnreadableVotesNote";
import { PendingWordsNote } from "./PendingWordsNote";
import { WaysToHelp } from "./WaysToHelp";
import { useEffect, useMemo, useRef, useState } from "react";

import { CalendarClock, RefreshCw } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { formatAtomic } from "../lib/amounts";
import { isContributorProject } from "../lib/funding";
import {
  type EvidencePacket,
  evidenceFor,
  evidenceUpdateContent,
} from "../lib/evidence";
import {
  bondShortfall,
  canAcceptClaim,
  canExpire,
  claimStatusLabel,
  encodeBind,
  encodeBond,
  encodeCallId,
  encodeCurrencyApprove,
  idLabel,
  claimStep,
  SIGNATURES,
} from "@creaton/core/launchpad/work.ts";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import type { Launch } from "../models";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { usePublishMirror } from "../use-launches";
import {
  type OpenWorkArea,
  openWorkAreas,
  recordSources,
} from "../lib/ways-to-help";
import { useWorkProposals } from "../use-work-proposals";
import { useWalletSend } from "../use-wallet-send";
import { useMilestoneLock, useRecordEvents, useWork } from "../use-work";
import { claimKey, type RecordEvents } from "../lib/record-read";
import { PaidLine, statusTone } from "./ClaimPaidLine";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { mayOfferVote, openVoteFor } from "../lib/proposal-gate";
import { knownTitles, shortNameBeside, workTitle } from "../lib/work-titles";
import { managersFor } from "../lib/dao-overview";
import { FailureNote, WalletStrip } from "./account-widgets";
import { BondReturn } from "./BondReturn";
import { useEvidencePackets } from "../use-evidence";
import { lockKindOf, useChallengeLock } from "../use-challenge-lock";
import { useWalletLabels } from "../use-wallet-labels";
import { EvidenceBlock } from "./EvidenceBlock";
import { FileClaimCard } from "./FileClaimCard";
import { ChallengeLockedCard } from "./ChallengeLockedCard";
import { LockedSharesCard } from "./LockedSharesCard";
import { AllowanceNote } from "./AllowanceNote";
import type { WorkBounties } from "@creaton/core/launchpad/workBounty.ts";
import { useWorkBounties } from "../use-work-bounties";
import { WorkAreaBounties } from "./WorkAreaBounties";
import { HowItWorks } from "./HowItWorks";
import { BudgetWorkAreas } from "./BudgetWorkAreas";
import { BudgetFigures } from "./BudgetFigures";
import { ReviewActions } from "./ReviewActions";
import { ClaimReviewNote } from "./ClaimReviewNote";
import { type ClaimReview, useReviewReasons } from "../use-review-reasons";
import { nextMoment, refreshDelay } from "../lib/work-refresh";
import { ShortName } from "./ShortName";

const sameAddress = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();
const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/**
 * The work a project's DAO has set aside money or Shares for: its budgets, the projects inside them and the claims
 * people have filed. Each claim says what happens to it next and who does it, and the connected wallet gets the
 * button for the step that is theirs (review it, finish it, take the payout, take it on as a project manager).
 *
 * The DAO's own votes (a new budget, a project, an award) are made on the Decisions tab, and this page points there
 * wherever one is the next step.
 */
export function WorkTab({
  launch,
  dao,
  onOpenDecisions,
  onChallenge,
  onSponsor,
  onOpenDecision,
  focusClaim,
}: {
  launch: Launch;
  dao: string;
  focusClaim?: { id: string; mandate: string };
  /** Go to the Decisions tab, where the DAO's votes are opened. */
  onOpenDecisions?: () => void;
  /** Go to the Decisions tab with the form for doubting (or unwinding) one claim already filled in. */
  onChallenge?: (intent: ChallengeIntent) => void;
  /** Someone is putting a suggestion to a vote (D84): open "Approve a work area" filled in from it. */
  onSponsor?: (intent: SponsorIntent) => void;
  /** Open one decision on the Decisions tab (a suggestion's vote, once it is open). */
  onOpenDecision?: (decisionId: string) => void;
}) {
  const { wallet, gate, busy, failure, send, sendBatch } = useWalletSend(
    launch,
    dao,
  );
  const work = useWork(dao, wallet.address);
  // When and in which transaction each paid claim was paid out (the same read the Track record tab uses).
  const payouts = useRecordEvents(dao, work.data);
  const context = useDecisionContext(dao);
  // Who may open a vote, and the votes already open (a suggestion being voted on says so).
  const decisions = useDecisions(dao, wallet.address);
  // A freeze or unwind is offered only to a signed-in person with a wallet that may open a vote: never to a visitor.
  const offerVote = mayOfferVote(decisions.data, {
    signedIn: existingUserPubkey() !== null,
    wallet: wallet.address,
  });
  const lock = useMilestoneLock(dao, wallet.address, work.data);
  // Money people put behind work areas (N1), when this build names a bounty contract for the project's network.
  const bounties = useWorkBounties(
    launch.record.chainId ?? null,
    dao,
    wallet.address,
    work.data,
  );
  const challengeLock = useChallengeLock(dao);
  const lockKind = lockKindOf(dao, challengeLock);
  // What contributors published for their claims: the text a reviewer reads before judging.
  const evidence = useEvidencePackets(launch);
  // Names for the wallets on this page: people on this server who bound that wallet to their account.
  const people = useMemo(
    () =>
      (work.data?.mandates ?? []).flatMap((m) => [
        ...m.reviewers.map((r) => r.address),
        ...m.claims.map((c) => c.record.contributor),
        ...m.projects.map((p) => p.record.manager),
      ]),
    [work.data],
  );
  const labelOf = useWalletLabels(people);
  const contributions = useContributions(dao);
  const approvedProjects = useMemo(
    () =>
      (work.data?.mandates ?? []).flatMap((m) =>
        m.projects.map((p) => ({
          projectId: p.approved.projectId,
          checkHash: p.approved.checkHash,
        })),
      ),
    [work.data],
  );
  // Ways to help: the open work areas, each with its words when someone published words that hash to its check.
  const proposals = useWorkProposals(
    launch.record.chainId ?? null,
    dao,
    approvedProjects,
  );
  // A work area made from a suggestion reads by the suggestion's title.
  const titles = useMemo(
    () => knownTitles(proposals.rows, approvedProjects),
    [proposals.rows, approvedProjects],
  );
  const areas = useMemo(
    () =>
      work.data
        ? openWorkAreas(
            work.data,
            [
              ...recordSources(launch.record.workAreas),
              ...evidence.areaWords,
              ...proposals.rows.map((row) => ({
                text: row.check,
                id: row.projectId,
              })),
            ],
            titles,
          )
        : [],
    [
      work.data,
      launch.record.workAreas,
      evidence.areaWords,
      proposals.rows,
      titles,
    ],
  );
  // The work area someone chose to submit work for: the submit form opens on it, its words filled in.
  const [picked, setPicked] = useState<{
    area: OpenWorkArea;
    at: number;
  } | null>(null);
  const areaMoney = (area: OpenWorkArea) => {
    const mandate = work.data?.mandates.find(
      (m) => m.address.toLowerCase() === area.mandate,
    );
    const currency = mandate?.currency;
    return currency?.decimalsKnown
      ? `${formatAtomic(area.moneyLeft, currency.decimals, { maxFractionDigits: 2 })} ${currency.symbol}`.trim()
      : `${area.moneyLeft.toString()} raw units`;
  };
  // One card per work area: an open one's money and forecasts are on its Open work card, and its budget lists the rest.
  const openKeys = useMemo(
    () => new Set(areas.map((area) => `${area.mandate}:${area.id}`)),
    [areas],
  );
  const bountyFor = (area: OpenWorkArea) => {
    const mandate = work.data?.mandates.find(
      (m) => m.address.toLowerCase() === area.mandate,
    );
    const project = mandate?.projects.find(
      (p) => p.id.toLowerCase() === area.id,
    );
    if (!mandate || !project) return null;
    return (
      <WorkAreaBounties
        busy={busy}
        chainId={launch.record.chainId ?? null}
        chainTime={work.data?.chainTime ?? 0}
        gate={gate}
        labelOf={labelOf}
        mandate={mandate}
        onSend={send}
        project={project}
        read={bounties.data}
        wallet={wallet.address}
      />
    );
  };
  // Who reviewed each claim, and the reasons published for turning work down, checked against the chain.
  const reviews = useReviewReasons(evidence.reasons, payouts.data);
  // Everything the claims show, read again: the claims, what was published for them, and who reviewed them.
  const refreshAll = () => {
    void work.refetch();
    evidence.refetch();
    void payouts.refetch();
  };
  const refreshRef = useRef(refreshAll);
  refreshRef.current = refreshAll;
  // Coming back to the page (a phone woken, another tab left) reads it again: reviews and steps move while nobody looks.
  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < 15_000) return;
      last = Date.now();
      refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  // A claim whose challenge window ends, or whose deadline passes, changes by itself: read the page again just after.
  const nextChange = work.data ? nextMoment(work.data) : null;
  const chainTimeNow = work.data?.chainTime ?? 0;
  useEffect(() => {
    if (nextChange === null) return;
    const delay = refreshDelay(nextChange, chainTimeNow);
    if (delay === null) return;
    const timer = window.setTimeout(() => refreshRef.current(), delay);
    return () => window.clearTimeout(timer);
  }, [nextChange, chainTimeNow]);
  // A failed read is said in plain words on the page; the node's own text goes to the error report instead.
  useEffect(() => {
    if (work.error) reportReadFailure("work-read", work.error);
  }, [work.error]);
  const focusedClaim = useRef<string | null>(null);
  useEffect(() => {
    const focusKey = focusClaim
      ? `${focusClaim.mandate}:${focusClaim.id}`
      : null;
    if (!focusClaim || !work.data || focusedClaim.current === focusKey) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(
        `claim-${focusClaim.mandate}-${focusClaim.id}`,
      );
      element?.scrollIntoView({ block: "center" });
      element?.focus({ preventScroll: true });
      if (element) focusedClaim.current = focusKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusClaim, work.data]);

  return (
    <div className="flex flex-col gap-4" data-testid="work-tab">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">Work</h2>
          <Button
            data-testid="work-refresh"
            disabled={work.isFetching}
            onClick={refreshAll}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            {work.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {isContributorProject(launch.record) ? (
          <div className="mt-3">
            <HowItWorks />
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            Pick open work, do it, and submit it here.
          </p>
        )}
        <AllowanceNote
          awardsOnlyShown={isContributorProject(launch.record)}
          dao={dao}
          now={work.data?.chainTime ?? Math.floor(Date.now() / 1000)}
          shares={context.data?.shares ?? null}
        />
        {/* A wallet matters once someone has an account: a visitor is asked to make one first, further down. */}
        {existingUserPubkey() ? (
          <WalletStrip testIdPrefix="work" wallet={wallet} />
        ) : null}
        {gate && wallet.address ? (
          <p
            className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid="work-gate"
            role="status"
          >
            {gate}
          </p>
        ) : null}
      </Card>

      <PendingWordsNote launch={launch} />

      {work.data ? (
        <WaysToHelp
          areas={areas}
          extra={bountyFor}
          labelOf={labelOf}
          money={areaMoney}
          onPick={(area) => setPicked({ area, at: Date.now() })}
          launch={launch}
          truncated={work.data.truncated}
        />
      ) : null}

      <UnreadableVotesNote decisions={decisions.data?.decisions ?? []} />
      <SuggestedWork
        approved={approvedProjects}
        chainId={launch.record.chainId ?? null}
        dao={dao}
        onSeeVote={onOpenDecision}
        onSponsor={onSponsor}
        power={decisions.data}
        totalShares={contributions.data?.totalShares ?? null}
        voteFor={(row) => openVoteFor(decisions.data?.decisions ?? [], row)}
      />

      {lock.data && wallet.address ? (
        lockKind === "challenge" && challengeLock.data ? (
          <ChallengeLockedCard launch={launch} view={challengeLock.data} />
        ) : lockKind !== "panel" ? (
          // Not known yet, or could not be read: the team's claim flow belongs to a panel, so it is not offered until it is
          // known that this is one.
          <Card
            className="p-4 text-sm text-muted-foreground"
            data-testid="locked-shares-rule-unknown"
          >
            {lockKind === "unreadable"
              ? "Could not read how this project's milestones are judged just now, so your locked team Shares are not shown. Reload to try again."
              : "Reading how this project's milestones are judged…"}
          </Card>
        ) : (
          <LockedSharesCard
            busy={busy}
            gate={gate}
            launch={launch}
            lock={lock.data}
            work={work.data}
            onSend={send}
            wallet={wallet.address}
          />
        )
      ) : null}

      {work.isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Reading the work from the network…
        </Card>
      ) : work.isError ? (
        <Card className="p-4">
          <FailureNote
            message="Couldn't read the work from the project's network just now. Try again in a minute."
            testId="work-error"
          />
          <Button
            className="mt-2"
            onClick={() => void work.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </Card>
      ) : work.data && work.data.mandates.length === 0 ? (
        <Card className="p-4 text-sm" data-testid="work-empty">
          <p>
            Nothing has been set aside for work yet. A work budget is created by
            a vote of the DAO.
          </p>
          <DecisionHelp onOpenDecisions={onOpenDecisions} />
        </Card>
      ) : (
        <>
          {work.data?.truncated ? (
            <p className="text-sm text-muted-foreground" role="status">
              This DAO has more work than is shown here. The newest is listed.
            </p>
          ) : null}
          <FileClaimCard
            areas={areas}
            picked={picked}
            launch={launch}
            busy={busy}
            gate={gate}
            mandates={work.data?.mandates ?? []}
            onSendBatch={sendBatch}
            wallet={wallet.address}
          />
          {work.data?.mandates.map((mandate) => (
            <MandateCard
              bounties={bounties.data}
              busy={busy}
              chainTime={work.data?.chainTime ?? 0}
              dao={dao}
              gate={gate}
              key={mandate.address}
              launch={launch}
              mandate={mandate}
              onChallenge={onChallenge}
              onOpenDecisions={onOpenDecisions}
              evidence={evidence}
              labelOf={labelOf}
              onRefresh={refreshAll}
              reviewOf={reviews.reviewOf}
              onSend={send}
              onSendBatch={sendBatch}
              openKeys={openKeys}
              titles={titles}
              offerVote={offerVote}
              payouts={payouts.data}
              payoutsUnread={payouts.isError && !payouts.data}
              wallet={wallet.address}
              passkeyKeys={
                wallet.kind === "passkey" ? wallet.passkeyKeys : null
              }
            />
          ))}
          <DecisionHelp onOpenDecisions={onOpenDecisions} />
        </>
      )}
      {failure ? <FailureNote message={failure} testId="work-failure" /> : null}
    </div>
  );
}

function DecisionHelp({ onOpenDecisions }: { onOpenDecisions?: () => void }) {
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="work-help">
      New work budgets, work areas and awards are put to a vote
      {onOpenDecisions ? (
        <>
          {" "}
          on the{" "}
          <button
            className="underline"
            data-testid="work-open-decisions"
            onClick={onOpenDecisions}
            type="button"
          >
            Decisions tab
          </button>
        </>
      ) : null}
      .
    </p>
  );
}

function MandateCard({
  mandate,
  bounties,
  chainTime,
  wallet,
  gate,
  busy,
  onSend,
  onSendBatch,
  onOpenDecisions,
  onChallenge,
  launch,
  evidence,
  labelOf,
  onRefresh,
  payouts,
  payoutsUnread,
  openKeys,
  reviewOf,
  passkeyKeys,
  titles,
  offerVote,
}: {
  /** Titles published for work areas (a suggestion's), keyed by short name. */
  titles: ReadonlyMap<string, string>;
  /** The connected account is known to hold too few votes to open a decision: no "put it to a vote" links. */
  offerVote: boolean;
  /** The acting passkey account's public details, so a reviewer can link it to their name; null for a wallet. */
  passkeyKeys: PasskeyAccountKeys | null;
  /** Who reviewed a claim and why it was turned down, as far as that is known. */
  reviewOf: (mandate: string, claimId: string) => ClaimReview;
  /** The work areas Open work lists, as `budget:area`, lower case: the budget lists only the others. */
  openKeys: ReadonlySet<string>;
  /** How to write a wallet: the person's name with the short address, or just the address. */
  labelOf: (address: string) => string;
  /** When and in which transaction claims were paid out; undefined while it is read. */
  payouts: RecordEvents | undefined;
  payoutsUnread: boolean;
  launch: Launch;
  /** Read the DAO's work again (a read that failed, tried once more). */
  onRefresh: () => void;
  evidence: {
    packets: EvidencePacket[];
    error: boolean;
    incomplete: boolean;
    refetch: () => void;
  };
  mandate: MandateView;
  /** The bounties on this DAO's work areas; undefined while read, or when the build names no bounty contract. */
  bounties: WorkBounties | undefined;
  chainTime: number;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
  /** Sends several calls as one step (one passkey prompt); resolves true once they landed. */
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
  dao: string;
  onOpenDecisions?: () => void;
  onChallenge?: (intent: ChallengeIntent) => void;
}) {
  const sharesOnly = isContributorProject(launch.record);
  const decimals = mandate.currency?.decimals ?? 18;
  const unit = mandate.currency?.symbol ?? "";
  // A currency that did not say how many decimals it has is shown as the raw number: a guessed scale misstates it.
  const scaled = mandate.currency?.decimalsKnown ?? true;
  const money = (units: bigint) =>
    scaled
      ? `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${unit}`.trim()
      : `${units.toString()} raw units of ${unit}`;
  // The bond is paid in its own token: the claim currency unless the vote that made this budget named another.
  // When the bond's terms could not be read its token is unknown: show the raw number, never the claim currency's scale.
  const bondMoney = (units: bigint) =>
    mandate.bond
      ? mandate.bond.decimalsKnown
        ? `${formatAtomic(units, mandate.bond.decimals, { maxFractionDigits: 2 })} ${mandate.bond.symbol}`.trim()
        : `${units.toString()} raw units of ${mandate.bond.symbol}`
      : mandate.bondUnreadable
        ? `${units.toString()} raw units`
        : money(units);
  const publish = usePublishMirror();
  const republish = async (
    claimId: string,
    name: string,
    evidence: string,
    check: string,
  ) => {
    await publish.mutateAsync({
      kind: KIND_LAUNCH_UPDATE,
      author: launch.record.author,
      launchId: launch.record.id,
      content: evidenceUpdateContent({
        name,
        claimId,
        mandate: mandate.address,
        evidence,
        check,
      }),
    });
  };
  const myProjects = mandate.projects.filter((p) =>
    sameAddress(wallet, p.record.manager),
  );
  // A reviewer on a bonded panel cannot judge a claim until they hold the bond.
  const owes = mandate.walletIsReviewer
    ? bondShortfall(mandate.bond, mandate.walletStake)
    : 0n;
  const postBond = async () => {
    if (!mandate.bond) return;
    // The approval first (on the bond's own token), then the bond: one step, and with a wallet the bond only once the
    // approval went through.
    await onSendBatch(`bond-${mandate.address}`, [
      {
        to: mandate.bond.token,
        data: encodeCurrencyApprove(mandate.verifiersAddress, owes),
      },
      { to: mandate.verifiersAddress, data: encodeBond(owes) },
    ]);
  };
  return (
    <Card className="p-4" data-testid="work-mandate">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          <span title={mandate.address}>
            {mandate.isMilestonePanel ? "Milestone panel" : "Work budget"}
          </span>
        </h3>
        {mandate.closed ? (
          <Chip>Closed</Chip>
        ) : (
          <Chip icon={CalendarClock}>Open until {date(mandate.expiresAt)}</Chip>
        )}
      </div>
      {mandate.isMilestonePanel ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="work-milestone-panel"
        >
          Named when the project launched, and the only one that can unlock the
          team's Shares. It holds no money, and nobody can swap its reviewers.
        </p>
      ) : null}
      <BudgetFigures
        bondMoney={bondMoney}
        labelOf={labelOf}
        mandate={mandate}
        money={money}
      />
      {owes > 0n ? (
        <div
          className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="work-bond-owed"
        >
          <p>
            You are a reviewer here. Post a bond of {bondMoney(owes)} before you
            judge a claim. You can ask for it back later; it stays at risk for
            14 days after you do.
          </p>
          <Button
            className="mt-2"
            data-testid="work-post-bond"
            disabled={busy !== null || gate !== null}
            onClick={() => void postBond()}
            size="sm"
            type="button"
          >
            Post my bond
          </Button>
        </div>
      ) : null}
      <BondReturn
        blocked={busy !== null || gate !== null}
        chainTime={chainTime}
        mandate={mandate}
        money={bondMoney}
        onRetry={onRefresh}
        onSend={onSend}
      />

      <BudgetWorkAreas
        bounties={bounties}
        busy={busy}
        chainId={launch.record.chainId ?? null}
        chainTime={chainTime}
        gate={gate}
        labelOf={labelOf}
        mandate={mandate}
        money={money}
        onSend={onSend}
        open={openKeys}
        wallet={wallet}
      />

      <h4 className="mt-3 text-sm font-semibold">Submitted work</h4>
      {mandate.claims.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody has submitted work yet.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-2" data-testid="work-claims">
          {mandate.claims.map((claim) => {
            const step = claimStep(claim, mandate, chainTime);
            const mine = sameAddress(wallet, claim.record.contributor);
            // A reviewer's turn: the claim waits for them, they owe no bond, and it is not their own.
            const reviewerTurn =
              step.kind === "review" &&
              mandate.walletIsReviewer &&
              owes === 0n &&
              !mandate.walletAttested.includes(claim.id) &&
              !mine;
            // And they can read what they would be approving. Objecting never needs the evidence; approving always does.
            const standing = evidenceFor(
              claim,
              evidence.packets,
              mandate.address,
            );
            const canReview = reviewerTurn && standing.kind === "verified";
            const label = idLabel(claim.id);
            const title = workTitle(claim.id);
            const shortName = shortNameBeside(claim.id, title);
            // An approved claim can be frozen only until its challenge window ends (then it can be paid).
            const challengeKind = challengeFor(claim.record.status);
            const pastChallengeWindow =
              claim.record.status === "Approved" && step.kind === "payout";
            return (
              <li
                className="rounded-xl border border-border/60 p-3 text-sm"
                id={`claim-${mandate.address.toLowerCase()}-${claim.id.toLowerCase()}`}
                tabIndex={-1}
                data-testid="work-claim"
                key={claim.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* The short name the chain keys it by, quietly beside the title: it is what a submission names. */}
                  <span className="font-medium">
                    {title}
                    <ShortName name={shortName} />
                  </span>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="work-claim-status"
                  >
                    <Chip tone={statusTone(claim.record.status)}>
                      {claimStatusLabel(claim.record)}
                    </Chip>{" "}
                    · submitted by {labelOf(claim.record.contributor)}
                    {claim.record.amount > 0n
                      ? ` · asks for ${money(claim.record.amount)}`
                      : sharesOnly
                        ? null
                        : " · asks for Shares, not money"}
                  </span>
                </div>
                <p className="mt-1" data-testid="work-claim-next">
                  {waitingFor(step, claim, mandate, chainTime, labelOf)}
                  {step.kind === "stuck" && step.lapsesAt > 0
                    ? ` Its deadline is ${date(step.lapsesAt)}.`
                    : null}
                  {step.kind === "none" && step.readyAt !== undefined
                    ? ` The window ends on ${date(step.readyAt)}.`
                    : null}
                </p>
                <ClaimReviewNote
                  labelOf={labelOf}
                  review={reviewOf(mandate.address, claim.id)}
                />
                {claim.record.status === "Paid" ? (
                  <PaidLine
                    sharesOnly={sharesOnly}
                    money={claim.record.amount > 0n}
                    at={payouts?.paidAt.get(
                      claimKey(mandate.address, claim.id),
                    )}
                    chainId={Number(launch.record.chainId ?? "") || 0}
                    tx={payouts?.paidTx.get(
                      claimKey(mandate.address, claim.id),
                    )}
                    unread={payoutsUnread}
                    reading={payouts === undefined && !payoutsUnread}
                  />
                ) : null}
                <EvidenceBlock
                  busy={busy !== null}
                  claim={claim}
                  mine={mine}
                  onRepublish={(text, check) =>
                    republish(claim.id, label, text, check)
                  }
                  onRetry={evidence.refetch}
                  standing={standing}
                  incomplete={evidence.incomplete}
                  unreadable={evidence.error}
                />
                {claim.record.amount > 0n ? (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid="work-payment-recipient"
                  >
                    Payment recipient:{" "}
                    <code className="break-all">
                      {claim.record.contributor}
                    </code>
                    . This is the wallet that submitted the work; changing a
                    profile wallet cannot redirect it.
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {step.kind === "bind" && step.who === "manager"
                    ? myProjects
                        .filter((project) =>
                          // Only where the budget would take it: the same check `fundMilestone` makes.
                          canAcceptClaim({
                            wallet,
                            mandate,
                            project,
                            claim,
                            now: chainTime,
                          }),
                        )
                        .map((project) => (
                          <Button
                            data-testid="work-bind"
                            disabled={busy !== null || gate !== null}
                            key={project.id}
                            onClick={() =>
                              void onSend(
                                `bind-${claim.id}`,
                                mandate.address,
                                encodeBind(
                                  project.id,
                                  claim.id,
                                  claim.record.contributor,
                                ),
                              )
                            }
                            size="sm"
                            type="button"
                          >
                            Accept for review in {workTitle(project.id, titles)}
                          </Button>
                        ))
                    : null}
                  {reviewerTurn && wallet ? (
                    <ReviewActions
                      blocked={busy !== null || gate !== null}
                      canApprove={canReview}
                      claimId={claim.id}
                      label={label}
                      launch={launch}
                      mandate={mandate.address}
                      onSend={onSend}
                      passkeyKeys={passkeyKeys}
                      reviewer={wallet}
                      verifiers={mandate.verifiersAddress}
                    />
                  ) : null}
                  {step.kind === "settle" ? (
                    <Button
                      data-testid="work-settle"
                      disabled={busy !== null || gate !== null}
                      onClick={() =>
                        void onSend(
                          `settle-${claim.id}`,
                          mandate.claimsAddress,
                          encodeCallId(SIGNATURES.settle, claim.id),
                        )
                      }
                      size="sm"
                      type="button"
                    >
                      {step.verdict === "turned-down"
                        ? "Close it as turned down"
                        : "Finish the review"}
                    </Button>
                  ) : null}
                  {canExpire(claim.record, chainTime) &&
                  step.kind !== "settle" ? (
                    <Button
                      data-testid="work-expire"
                      disabled={busy !== null || gate !== null}
                      onClick={() =>
                        void onSend(
                          `expire-${claim.id}`,
                          mandate.claimsAddress,
                          encodeCallId(SIGNATURES.expire, claim.id),
                        )
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Close it as lapsed
                    </Button>
                  ) : null}
                  {step.kind === "payout" && mine ? (
                    <Button
                      data-testid="work-payout"
                      disabled={busy !== null || gate !== null}
                      onClick={() =>
                        void onSend(
                          `payout-${claim.id}`,
                          mandate.claimsAddress,
                          encodeCallId(SIGNATURES.payout, claim.id),
                        )
                      }
                      size="sm"
                      type="button"
                    >
                      {claim.record.amount > 0n
                        ? "Take payment"
                        : "Mark it finished"}
                    </Button>
                  ) : null}
                </div>
                {/* Not on one's own work, and only for someone who could open the vote (never a visitor). */}
                {onChallenge &&
                challengeKind &&
                !pastChallengeWindow &&
                !mine &&
                offerVote ? (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid="work-challenge-help"
                  >
                    {challengeKind === "freeze"
                      ? sharesOnly
                        ? "Doubt it? Shareholders can freeze it: while it is frozen, no Shares can be awarded for it."
                        : "Doubt it? Shareholders can freeze it: nothing is paid while it is frozen."
                      : sharesOnly
                        ? "A vote can reject it for good: nothing is awarded for it."
                        : "A vote can reject it for good: the money goes back to the budget and the deposit to the contributor."}{" "}
                    <button
                      className="underline"
                      data-testid="work-challenge"
                      onClick={() =>
                        onChallenge({
                          kind: challengeKind,
                          mandate: mandate.address,
                          claimId: claim.id,
                        })
                      }
                      type="button"
                    >
                      {challengeKind === "freeze"
                        ? "Put a freeze to a vote"
                        : "Put a rejection to a vote"}
                    </button>
                  </p>
                ) : null}
                {step.kind === "award" ? (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid="work-award-help"
                  >
                    Awarding Shares is a decision the DAO votes on.{" "}
                    {onOpenDecisions ? (
                      <button
                        className="underline"
                        data-testid="work-award-open"
                        onClick={onOpenDecisions}
                        type="button"
                      >
                        Open it on the Decisions tab
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * What a submission waits for, naming the person when one manager can accept it ("Waiting for Frida Lund to accept it
 * for review."), else the step as it is.
 */
function waitingFor(
  step: ReturnType<typeof claimStep>,
  claim: MandateView["claims"][number],
  mandate: MandateView,
  now: number,
  labelOf: (address: string) => string,
): string {
  if (step.kind !== "bind" || step.who !== "manager") return step.text;
  const managers = managersFor(claim, mandate, now);
  // A wallet nobody has put a name to would only be an address: the general words say more then.
  const name = managers.length === 1 ? labelOf(managers[0]) : null;
  return name && !name.startsWith("0x")
    ? `Waiting for ${name} to accept it for review.`
    : step.text;
}
