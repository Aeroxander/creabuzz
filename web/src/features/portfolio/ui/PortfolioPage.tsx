/**
 * Portfolio — what you backed, what you built, and your share of each.
 *
 * Two kinds of stake, side by side: money you put into raises (read from the
 * chain, per wallet you bid from) and work a reviewer accepted (read from the
 * server under the review rule). Neither decays: your points only grow, and
 * your share moves only because everyone else's does.
 */
import { Link } from "@tanstack/react-router";
import {
  Briefcase,
  CircleCheck,
  Clock,
  Hourglass,
  Lock,
  PieChart,
  Star,
} from "lucide-react";
import type { ReactNode } from "react";

import { recordSaleCurrency } from "@/features/launchpad/chain";
import {
  courtAddress,
  daoLaunchKit,
  defaultChainPreset,
} from "@/features/launchpad/chain-config";
import { formatAtomic, formatMoney } from "@/features/launchpad/lib/amounts";
import { effectiveStage, type Launch } from "@/features/launchpad/models";
import { useLaunches } from "@/features/launchpad/use-launches";
import { Figure } from "@/features/launchpad/ui/Figure";
import {
  ProgressBar,
  StageBadge,
  useAuctionProgress,
} from "@/features/launchpad/ui/widgets";
import { KIND_CONTRIBUTION_RECORD } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { MoreInfo } from "@/shared/ui/more-info";
import { PageHeader, SectionHeader } from "@/shared/ui/PageHeader";
import { errorMessage, QueryError } from "@/shared/ui/query-error";

import { describeAge } from "../lib/holdings";
import { formatShare, raiseShare } from "../lib/portfolio";
import {
  type BackedRaise,
  type HeldInDao,
  MAX_BIDS_PER_OWNER,
  MAX_RAISES_CHECKED,
  useBacking,
  useFollowedLaunches,
  useHoldings,
  useWorkStanding,
} from "../use-portfolio";
import { needAccountTo } from "@/features/identity/lib/account-copy";

/** AppToken supply is minted with 18 decimals. */
const TOKEN_DECIMALS = 18;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function Muted({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      className="text-sm text-black/60 dark:text-white/60"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3"
      data-testid={id}
    >
      <SectionHeader
        description={description}
        title={<span id={`${id}-heading`}>{title}</span>}
      />
      {children}
    </section>
  );
}

function LaunchLink({ launch }: { launch: Launch }) {
  return (
    <Link
      className="min-w-0 flex-1 truncate text-base font-semibold hover:underline"
      params={{ launchId: launch.record.id }}
      search={{ action: undefined, author: launch.record.author }}
      to="/launchpad/$launchId"
    >
      {launch.record.name}
    </Link>
  );
}

function WorkSection() {
  const me = existingUserPubkey();
  const work = useWorkStanding();
  let body: ReactNode;
  if (!me) {
    body = <Muted>{needAccountTo("start earning credit for your work")}</Muted>;
  } else if (work.isLoading) {
    body = <Muted>Adding up your work…</Muted>;
  } else if (work.error || !work.data) {
    body = (
      <QueryError
        description="The server did not answer, so your work can't be added up right now."
        error={work.error}
        kinds={[KIND_CONTRIBUTION_RECORD]}
        message={errorMessage(work.error)}
        onRetry={() => void work.refetch()}
        relayUrl={relayWsUrl()}
        testId="portfolio-work-error"
        title="Couldn't load your work"
      />
    );
  } else {
    const standing = work.data;
    const nothingYet = standing.accepted === 0 && standing.waiting === 0;
    body = (
      <Card className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure
            icon={Star}
            label="Points"
            testId="portfolio-work-points-tile"
            value={standing.points.toLocaleString()}
            valueTestId="portfolio-work-points"
          />
          <Figure
            icon={PieChart}
            label="Of all accepted work"
            testId="portfolio-work-share-tile"
            value={formatShare(standing.share)}
            valueTestId="portfolio-work-share"
          />
          <Figure
            icon={CircleCheck}
            label="Accepted"
            testId="portfolio-work-accepted"
            value={String(standing.accepted)}
          />
          <Figure
            icon={Hourglass}
            label="Waiting for review"
            testId="portfolio-work-waiting"
            value={String(standing.waiting)}
          />
        </div>
        {nothingYet ? (
          <Muted>
            Finish a task on your community's work board and claim it. Once a
            reviewer accepts it, it counts here.
          </Muted>
        ) : null}
        <MoreInfo label="How points work">
          Points never expire. Your share only shrinks when others keep
          contributing and you don't.
        </MoreInfo>
        {standing.partial ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Only the most recent records were counted, so older work may be
            missing from these totals.
          </p>
        ) : null}
      </Card>
    );
  }
  return (
    <Section
      description="Work a reviewer accepted, on this server."
      id="portfolio-work"
      title="Your share of the work"
    >
      {body}
    </Section>
  );
}

function RaiseRow({ raise }: { raise: BackedRaise }) {
  const { launch, summary } = raise;
  const progress = useAuctionProgress(launch.record);
  const live = progress.data?.source === "rpc" ? progress.data : null;
  const share = raiseShare(summary.committed, live ? live.raised : null);
  const symbol = launch.record.tokenPlan?.symbol ?? "tokens";
  return (
    <li>
      <Card className="flex flex-col gap-2 p-4" data-testid="portfolio-raise">
        <div className="flex items-start gap-2">
          <LaunchLink launch={launch} />
          <StageBadge record={launch.record} stage={effectiveStage(launch)} />
        </div>
        <p className="text-sm">
          You put in{" "}
          <span className="font-semibold tabular-nums">
            {formatMoney(summary.committed, recordSaleCurrency(launch.record))}
          </span>
          {share !== null ? (
            <>
              {" "}
              (<span className="tabular-nums">{formatShare(share)}</span> of the
              raise)
            </>
          ) : null}
        </p>
        <p className="text-xs text-black/60 dark:text-white/60">
          {summary.tokens > 0n
            ? `${formatAtomic(summary.tokens, TOKEN_DECIMALS, {
                symbol,
                maxFractionDigits: 2,
              })} received · `
            : ""}
          {[
            summary.open > 0
              ? `${plural(summary.open, "bid")} still in the sale`
              : null,
            summary.exited > 0
              ? `${plural(summary.exited, "bid")} settled`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {raise.partial ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Counts your first {MAX_BIDS_PER_OWNER} bids per wallet here; the
            launch page shows them all.
          </p>
        ) : null}
        <ProgressBar record={launch.record} />
      </Card>
    </li>
  );
}

function BackingSection() {
  const backing = useBacking();
  const { wallet } = backing;
  let body: ReactNode;
  if (backing.findingWallets) {
    body = <Muted>Looking for your wallets…</Muted>;
  } else if (backing.owners.length === 0) {
    body = (
      <Card className="flex flex-col items-start gap-2 p-4">
        <Muted testId="portfolio-backing-no-wallet">
          Raises you back are kept in your wallet. Connect it to see them here.
        </Muted>
        {wallet.hasProvider ? (
          <Button
            disabled={wallet.connecting}
            onClick={() => void wallet.connect()}
            size="sm"
          >
            {wallet.connecting ? "Connecting…" : "Connect wallet"}
          </Button>
        ) : (
          <Link className="text-sm underline" to="/launchpad">
            Browse launches
          </Link>
        )}
        {wallet.error ? (
          <p className="text-xs text-red-700 dark:text-red-300" role="alert">
            {wallet.error}
          </p>
        ) : null}
      </Card>
    );
  } else if (backing.error) {
    body = (
      <Card className="flex flex-col items-start gap-2 p-4">
        <p
          className="text-sm text-red-700 dark:text-red-300"
          data-testid="portfolio-backing-error"
          role="alert"
        >
          Couldn't check your bids right now.
        </p>
        <Button onClick={backing.retry} size="sm" variant="outline">
          Try again
        </Button>
      </Card>
    );
  } else if (!backing.data) {
    body = <Muted>Checking your bids…</Muted>;
  } else {
    const { raises, failed, unchecked } = backing.data;
    body = (
      <>
        {raises.length > 0 ? (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {raises.map((raise) => (
              <RaiseRow key={raise.launch.record.eventId} raise={raise} />
            ))}
          </ul>
        ) : failed.length === 0 ? (
          <Muted testId="portfolio-backing-empty">
            You haven't backed a raise from this wallet yet.{" "}
            <Link className="underline" to="/launchpad">
              Browse launches
            </Link>
          </Muted>
        ) : null}
        {failed.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
            data-testid="portfolio-backing-failed"
            role="status"
          >
            <span>
              Couldn't check your bids in{" "}
              {failed.map((l) => l.record.name).join(", ")}.
            </span>
            <Button onClick={backing.retry} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : null}
        {unchecked > 0 ? (
          <p className="text-xs text-black/50 dark:text-white/50">
            Only the {MAX_RAISES_CHECKED} newest raises were checked.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <Section
      description="Money you put into raises, and how much of each raise it is."
      id="portfolio-backing"
      title="Raises you backed"
    >
      {body}
      {backing.passkeyFailed && !backing.findingWallets ? (
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="portfolio-passkey-failed"
          role="status"
        >
          <span>
            Couldn't look up your passkey account, so raises you backed with it
            aren't shown.
          </span>
          <Button onClick={backing.retry} size="sm" variant="outline">
            Try again
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

function HoldingRow({ held }: { held: HeldInDao }) {
  const { launch } = held;
  const symbol = launch.record.tokenPlan?.symbol;
  const free = held.balance - held.locked;
  return (
    <li>
      <Card className="flex flex-col gap-2 p-4" data-testid="portfolio-holding">
        <div className="flex items-start gap-2">
          <LaunchLink launch={launch} />
        </div>
        <p
          className="text-2xl font-bold tabular-nums"
          data-testid="portfolio-holding-shares"
        >
          {formatAtomic(held.balance, TOKEN_DECIMALS, {
            symbol,
            maxFractionDigits: 0,
          })}
        </p>
        <p className="flex flex-wrap gap-1.5">
          <Chip icon={Clock}>
            Held for{" "}
            <span data-testid="portfolio-holding-age">
              {describeAge(held.age)}
            </span>
          </Chip>
        </p>
        {held.locked > 0n ? (
          <p
            className="flex gap-1.5 text-xs text-amber-800 dark:text-amber-300"
            data-testid="portfolio-holding-locked"
          >
            <Lock aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              {formatAtomic(held.locked, TOKEN_DECIMALS, {
                maxFractionDigits: 0,
              })}{" "}
              of them are locked until milestones are reached
              {free > 0n
                ? `; ${formatAtomic(free, TOKEN_DECIMALS, { maxFractionDigits: 0 })} are free`
                : ""}
              .
            </span>
          </p>
        ) : null}
      </Card>
    </li>
  );
}

function HoldingsSection() {
  const holdings = useHoldings();
  const { wallet } = holdings;
  let body: ReactNode;
  if (holdings.owners.length === 0) {
    body = (
      <Muted testId="portfolio-holdings-no-wallet">
        Shares are kept in your wallet. Connect it to see what you hold here.
      </Muted>
    );
  } else if (holdings.error) {
    body = (
      <Card className="flex flex-col items-start gap-2 p-4">
        <p
          className="text-sm text-red-700 dark:text-red-300"
          data-testid="portfolio-holdings-error"
          role="alert"
        >
          Couldn't check what you hold right now.
        </p>
        <Button onClick={holdings.retry} size="sm" variant="outline">
          Try again
        </Button>
      </Card>
    );
  } else if (!holdings.data) {
    body = <Muted>Checking what you hold…</Muted>;
  } else {
    const { held, failed, unchecked } = holdings.data;
    body = (
      <>
        {held.length > 0 ? (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {held.map((h) => (
              <HoldingRow held={h} key={`${h.dao}-${h.owner}`} />
            ))}
          </ul>
        ) : failed.length === 0 ? (
          <Muted testId="portfolio-holdings-empty">
            You don't hold Shares in any DAO from{" "}
            {holdings.owners.length === 1 ? "this wallet" : "these wallets"}{" "}
            yet.
          </Muted>
        ) : null}
        {failed.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
            data-testid="portfolio-holdings-failed"
            role="status"
          >
            <span>
              Couldn't check what you hold in{" "}
              {failed.map((l) => l.record.name).join(", ")}.
            </span>
            <Button onClick={holdings.retry} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : null}
        {unchecked > 0 ? (
          <p className="text-xs text-black/50 dark:text-white/50">
            Only the {MAX_RAISES_CHECKED} newest DAOs were checked.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <Section
      description="Shares you hold in each DAO. Time held counts from the day they reached this wallet."
      id="portfolio-holdings"
      title="What you hold"
    >
      {body}
      {wallet.error && holdings.owners.length === 0 ? (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {wallet.error}
        </p>
      ) : null}
    </Section>
  );
}

function FollowingSection() {
  const { followed, loading, error } = useFollowedLaunches();
  let body: ReactNode;
  if (loading) {
    body = <Muted>Loading the launches you follow…</Muted>;
  } else if (error) {
    body = (
      <p
        className="text-sm text-red-700 dark:text-red-300"
        data-testid="portfolio-following-error"
        role="alert"
      >
        Couldn't load launches right now.
      </p>
    );
  } else if (followed.length === 0) {
    body = (
      <Muted testId="portfolio-following-empty">
        Follow a launch to keep an eye on it here.{" "}
        <Link className="underline" to="/launchpad">
          Browse launches
        </Link>
      </Muted>
    );
  } else {
    body = (
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {followed.map((launch) => (
          <li key={launch.record.eventId}>
            <Card
              className="flex flex-col gap-2 p-4"
              data-testid="portfolio-followed"
            >
              <div className="flex items-start gap-2">
                <LaunchLink launch={launch} />
                <StageBadge
                  record={launch.record}
                  stage={effectiveStage(launch)}
                />
              </div>
              {launch.record.pitch ? (
                <p className="line-clamp-2 text-sm text-black/70 dark:text-white/70">
                  {launch.record.pitch}
                </p>
              ) : null}
              {launch.record.auction ? (
                <ProgressBar record={launch.record} />
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Section
      description="Launches you're keeping an eye on."
      id="portfolio-following"
      title="Following"
    >
      {body}
    </Section>
  );
}

/** Raises are shown where this server lists a sale, or this build offers one; a contributor-only server has neither. */
function useRaisesHere(): boolean {
  const launches = useLaunches();
  return (
    daoLaunchKit(defaultChainPreset().chainId) !== null ||
    (launches.data ?? []).some((launch) => Boolean(launch.record.auction))
  );
}

export function PortfolioPage() {
  const raises = useRaisesHere();
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8"
      data-testid="portfolio-page"
    >
      <PageHeader
        description={
          raises
            ? "What you've backed, what you've built, and your share of each."
            : "What you've built and what you hold."
        }
        title={
          <span className="flex items-center gap-2">
            <Briefcase aria-hidden className="h-5 w-5" /> Portfolio
          </span>
        }
      />
      <WorkSection />
      {raises ? <BackingSection /> : null}
      <HoldingsSection />
      <CourtSection />
      <FollowingSection />
    </div>
  );
}

/** The court (N7), where people stake CREATE to judge disputes about work: shown where this build names one. */
function CourtSection() {
  if (!courtAddress(defaultChainPreset().chainId)) return null;
  return (
    <section className="flex flex-col gap-3" data-testid="portfolio-court">
      <SectionHeader title="Judging" />
      <Card className="flex flex-col items-start gap-2 p-4">
        <p className="text-sm">
          Stake CREATE to be drawn as a juror on disputes about work. Jurors who
          vote with the final ruling are paid.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to="/court">Open the court</Link>
        </Button>
      </Card>
    </section>
  );
}
