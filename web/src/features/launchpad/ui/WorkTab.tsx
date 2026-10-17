import { type ChallengeIntent, challengeFor } from "../lib/challenge";
import { useMemo } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { formatAtomic } from "../lib/amounts";
import {
  type EvidencePacket,
  evidenceFor,
  evidenceUpdateContent,
} from "../lib/evidence";
import {
  bondShortfall,
  encodeAttest,
  encodeBind,
  encodeBond,
  encodeCallId,
  encodeCurrencyApprove,
  idLabel,
  nextStep,
  SIGNATURES,
} from "../lib/work";
import type { MandateView } from "../lib/work-read";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";
import { useWalletSend } from "../use-wallet-send";
import { useMilestoneLock, useWork } from "../use-work";
import { FailureNote, WalletStrip } from "./auction-widgets";
import { BondReturn } from "./BondReturn";
import { useEvidencePackets } from "../use-evidence";
import { useWalletLabels } from "../use-wallet-labels";
import { EvidenceBlock } from "./EvidenceBlock";
import { FileClaimCard } from "./FileClaimCard";
import { LockedSharesCard } from "./LockedSharesCard";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });
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
}: {
  launch: Launch;
  dao: string;
  /** Go to the Decisions tab, where the DAO's votes are opened. */
  onOpenDecisions?: () => void;
  /** Go to the Decisions tab with the form for doubting (or unwinding) one claim already filled in. */
  onChallenge?: (intent: ChallengeIntent) => void;
}) {
  const { wallet, gate, busy, failure, send } = useWalletSend(launch, dao);
  const work = useWork(dao, wallet.address);
  const lock = useMilestoneLock(dao, wallet.address, work.data);
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

  return (
    <div className="flex flex-col gap-4" data-testid="work-tab">
      <Card className="p-4">
        <h2 className="text-base font-bold">Work</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The DAO can set aside money, Shares or both for work. People file a
          claim for what they did. A manager accepts it into a project and the
          required reviewers approve it. Review is then finalized; after the
          challenge window, the contributor claims payment. Shares require a
          separate DAO decision.
        </p>
        <WalletStrip testIdPrefix="work" wallet={wallet} />
        <Button
          className="mt-2"
          disabled={work.isFetching}
          onClick={() => void work.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          {work.isFetching ? "Refreshing…" : "Refresh work status"}
        </Button>
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

      {lock.data && wallet.address ? (
        <LockedSharesCard
          busy={busy}
          gate={gate}
          launch={launch}
          lock={lock.data}
          work={work.data}
          onSend={send}
          wallet={wallet.address}
        />
      ) : null}

      {work.isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Reading the work from the network…
        </Card>
      ) : work.isError ? (
        <Card className="p-4">
          <FailureNote
            message={`Couldn't read the work from the network: ${work.error instanceof Error ? work.error.message : "unknown error"}`}
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
          <DecisionHelp dao={dao} onOpenDecisions={onOpenDecisions} />
        </Card>
      ) : (
        <>
          {work.data?.truncated ? (
            <p className="text-sm text-muted-foreground" role="status">
              This DAO has more work than is shown here. The newest is listed.
            </p>
          ) : null}
          <FileClaimCard
            launch={launch}
            busy={busy}
            gate={gate}
            mandates={work.data?.mandates ?? []}
            onSend={send}
            wallet={wallet.address}
          />
          {work.data?.mandates.map((mandate) => (
            <MandateCard
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
              onRefresh={() => void work.refetch()}
              onSend={send}
              wallet={wallet.address}
            />
          ))}
          <DecisionHelp dao={dao} onOpenDecisions={onOpenDecisions} />
        </>
      )}
      {failure ? <FailureNote message={failure} testId="work-failure" /> : null}
    </div>
  );
}

function DecisionHelp({
  dao,
  onOpenDecisions,
}: {
  dao: string;
  onOpenDecisions?: () => void;
}) {
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="work-help">
      A new budget, a project and an award are decisions the DAO votes on
      {onOpenDecisions ? (
        <>
          {" "}
          — open them on the{" "}
          <button
            className="underline"
            data-testid="work-open-decisions"
            onClick={onOpenDecisions}
            type="button"
          >
            Decisions tab
          </button>
        </>
      ) : null}{" "}
      (DAO <span className="font-mono">{truncatePubkey(dao)}</span>).
    </p>
  );
}

function MandateCard({
  mandate,
  chainTime,
  wallet,
  gate,
  busy,
  onSend,
  onOpenDecisions,
  onChallenge,
  launch,
  evidence,
  labelOf,
  onRefresh,
}: {
  /** How to write a wallet: the person's name with the short address, or just the address. */
  labelOf: (address: string) => string;
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
  chainTime: number;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
  dao: string;
  onOpenDecisions?: () => void;
  onChallenge?: (intent: ChallengeIntent) => void;
}) {
  const { created } = mandate;
  const decimals = mandate.currency?.decimals ?? 18;
  const unit = mandate.currency?.symbol ?? "";
  const money = (units: bigint) =>
    `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${unit}`.trim();
  // The bond is paid in its own token: the claim currency unless the vote that made this budget named another.
  // When the bond's terms could not be read its token is unknown: show the raw number, never the claim currency's scale.
  const bondMoney = (units: bigint) =>
    mandate.bond
      ? `${formatAtomic(units, mandate.bond.decimals, { maxFractionDigits: 2 })} ${mandate.bond.symbol}`.trim()
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
    // The approval first (on the bond's own token); the bond only if it went through.
    const approved = await onSend(
      `bond-approve-${mandate.address}`,
      mandate.bond.token,
      encodeCurrencyApprove(mandate.verifiersAddress, owes),
    );
    if (!approved) return;
    await onSend(
      `bond-${mandate.address}`,
      mandate.verifiersAddress,
      encodeBond(owes),
    );
  };
  return (
    <Card className="p-4" data-testid="work-mandate">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {mandate.isMilestonePanel ? "Milestone panel" : "Work budget"}{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {truncatePubkey(mandate.address)}
          </span>
        </h3>
        <span className="text-xs text-muted-foreground">
          {mandate.closed ? "Closed" : `Open until ${date(mandate.expiresAt)}`}
        </span>
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
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {created.shareBudget > 0n ? (
          <>
            <dt className="text-muted-foreground">Shares for work</dt>
            <dd data-testid="work-share-budget">
              {shares(mandate.sharesAllocated)} of {shares(created.shareBudget)}{" "}
              given to projects
            </dd>
          </>
        ) : null}
        {created.budget > 0n ? (
          <>
            <dt className="text-muted-foreground">Money for work</dt>
            <dd>{money(created.budget)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Reviewers</dt>
        <dd>
          {mandate.reviewers.length > 0
            ? `${mandate.quorum} of ${mandate.reviewers.length} must agree on a claim`
            : `${mandate.quorum} must agree on a claim`}
        </dd>
        <dt className="text-muted-foreground">Reviewer bond</dt>
        <dd data-testid="work-bond">
          {mandate.bond
            ? `${bondMoney(mandate.bond.minBond)} each, which the DAO can take after a disputed approval`
            : mandate.bondUnreadable
              ? "Could not be read. The network did not answer; this is not the same as no bond."
              : "None: a reviewer risks nothing by approving carelessly"}
        </dd>
      </dl>
      {mandate.reviewers.length > 0 ? (
        <ul
          className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground"
          data-testid="work-reviewers"
        >
          {mandate.reviewers.map((reviewer) => (
            <li data-testid="work-reviewer" key={reviewer.address}>
              <span className="font-mono">{labelOf(reviewer.address)}</span>
              {mandate.bond
                ? reviewer.stake === null
                  ? " · bond could not be read"
                  : reviewer.stake >= mandate.bond.minBond
                    ? " · bond posted"
                    : " · bond not posted yet"
                : ""}
              {reviewer.pending
                ? ` · ${bondMoney(reviewer.pending.amount)} waiting to be taken back`
                : ""}
              {reviewer.pendingUnreadable
                ? " · a bond waiting to be taken back could not be read"
                : ""}
            </li>
          ))}
        </ul>
      ) : null}
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

      <h4 className="mt-3 text-sm font-semibold">Projects</h4>
      {mandate.projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No project has been approved in this budget yet.
        </p>
      ) : (
        <ul
          className="mt-1 flex flex-col gap-1 text-sm"
          data-testid="work-projects"
        >
          {mandate.projects.map((project) => (
            <li key={project.id}>
              <span className="font-medium">{idLabel(project.id)}</span>
              <span className="text-muted-foreground">
                {" "}
                · managed by {labelOf(project.record.manager)}
                {project.record.shareBudget > 0n
                  ? ` · ${shares(project.record.sharesAwarded)} of ${shares(project.record.shareBudget)} Shares awarded`
                  : ""}
                {project.record.budget > 0n
                  ? ` · ${money(project.record.reserved)} of ${money(project.record.budget)} reserved`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-3 text-sm font-semibold">Claims</h4>
      {mandate.claims.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody has filed a claim yet.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-2" data-testid="work-claims">
          {mandate.claims.map((claim) => {
            const step = nextStep(
              claim,
              chainTime,
              mandate.challengeWindow,
              mandate.isMilestonePanel,
            );
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
            // An approved claim can be frozen only until its challenge window ends (then it can be paid).
            const challengeKind = challengeFor(claim.record.status);
            const pastChallengeWindow =
              claim.record.status === "Approved" && step.kind === "payout";
            return (
              <li
                className="rounded-lg border border-black/10 p-2 text-sm dark:border-white/10"
                data-testid="work-claim"
                key={claim.id}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{label}</span>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="work-claim-status"
                  >
                    {claim.record.status} · filed by{" "}
                    {labelOf(claim.record.contributor)}
                    {claim.record.amount > 0n
                      ? ` · asks for ${money(claim.record.amount)}`
                      : " · asks to be recognised, not paid"}
                  </span>
                </div>
                <p className="mt-1" data-testid="work-claim-next">
                  {step.text}
                </p>
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
                    . This is the wallet that filed the claim; changing a
                    profile wallet cannot redirect it.
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {step.kind === "bind" && myProjects.length > 0
                    ? myProjects.map((project) => (
                        <Button
                          data-testid="work-bind"
                          disabled={busy !== null || gate !== null}
                          key={project.id}
                          onClick={() =>
                            void onSend(
                              `bind-${claim.id}`,
                              mandate.address,
                              bindData(
                                project.id,
                                claim.id,
                                claim.record.contributor,
                              ),
                            )
                          }
                          size="sm"
                          type="button"
                        >
                          Take on in {idLabel(project.id)}
                        </Button>
                      ))
                    : null}
                  {reviewerTurn ? (
                    <>
                      {canReview ? (
                        <Button
                          data-testid="work-approve"
                          disabled={busy !== null || gate !== null}
                          onClick={() =>
                            void onSend(
                              `approve-${claim.id}`,
                              mandate.verifiersAddress,
                              encodeAttest(claim.id, true),
                            )
                          }
                          size="sm"
                          type="button"
                        >
                          Approve
                        </Button>
                      ) : null}
                      <Button
                        data-testid="work-object"
                        disabled={busy !== null || gate !== null}
                        onClick={() =>
                          void onSend(
                            `object-${claim.id}`,
                            mandate.verifiersAddress,
                            encodeAttest(claim.id, false),
                          )
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Object
                      </Button>
                    </>
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
                      Finalize review
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
                      Claim payment
                    </Button>
                  ) : null}
                </div>
                {onChallenge && challengeKind && !pastChallengeWindow ? (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid="work-challenge-help"
                  >
                    {challengeKind === "freeze"
                      ? "Doubt this claim? Holders can vote to freeze it: nothing is paid and no Shares unlock while it is frozen."
                      : "A vote to unwind it returns the money to the budget and the deposit to the contributor."}{" "}
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
                        : "Put an unwind to a vote"}
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

function bindData(projectId: string, claimId: string, contributor: string) {
  return encodeBind(projectId, claimId, contributor);
}
