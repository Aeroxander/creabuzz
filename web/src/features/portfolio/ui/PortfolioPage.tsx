/**
 * Portfolio — what you backed, what you built, and your share of each.
 *
 * Two kinds of stake, side by side: money you put into raises (read from the
 * chain, per wallet you bid from) and work a reviewer accepted (read from the
 * server under the review rule). Neither decays: your points only grow, and
 * your share moves only because everyone else's does.
 */
import { Link } from "@tanstack/react-router";
import { Briefcase } from "lucide-react";
import type { ReactNode } from "react";

import { recordSaleCurrency } from "@/features/launchpad/chain";
import { formatAtomic, formatMoney } from "@/features/launchpad/lib/amounts";
import { effectiveStage, type Launch } from "@/features/launchpad/models";
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
import { PageHeader, SectionHeader } from "@/shared/ui/PageHeader";
import { errorMessage, QueryError } from "@/shared/ui/query-error";

import { formatShare, raiseShare } from "../lib/portfolio";
import {
  type BackedRaise,
  MAX_BIDS_PER_OWNER,
  MAX_RAISES_CHECKED,
  useBacking,
  useFollowedLaunches,
  useWorkStanding,
} from "../use-portfolio";

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
    body = (
      <Muted>
        Create your identity from the profile menu to start earning credit for
        your work.
      </Muted>
    );
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
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <p>
            <span
              className="text-2xl font-semibold tabular-nums"
              data-testid="portfolio-work-points"
            >
              {standing.points.toLocaleString()}
            </span>{" "}
            <span className="text-sm text-black/60 dark:text-white/60">
              points
            </span>
          </p>
          <p>
            <span
              className="text-2xl font-semibold tabular-nums"
              data-testid="portfolio-work-share"
            >
              {formatShare(standing.share)}
            </span>{" "}
            <span className="text-sm text-black/60 dark:text-white/60">
              of all accepted work
            </span>
          </p>
        </div>
        <p
          className="text-sm text-black/70 dark:text-white/70"
          data-testid="portfolio-work-counts"
        >
          {plural(standing.accepted, "piece")} accepted · {standing.waiting}{" "}
          waiting for review
        </p>
        {nothingYet ? (
          <Muted>
            Finish a task on your community's work board and claim it. Once a
            reviewer accepts it, it counts here.
          </Muted>
        ) : null}
        <p className="text-xs text-black/50 dark:text-white/50">
          Points never expire. Your share only shrinks when others keep
          contributing and you don't.
        </p>
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
      description="Work a reviewer accepted, across this server."
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
          <StageBadge stage={effectiveStage(launch)} />
        </div>
        <p className="text-sm">
          You put in{" "}
          <span className="font-semibold tabular-nums">
            {formatMoney(summary.committed, recordSaleCurrency(launch.record))}
          </span>
          {share !== null ? (
            <>
              {" "}
              — <span className="tabular-nums">{formatShare(share)}</span> of
              the raise
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
                <StageBadge stage={effectiveStage(launch)} />
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

export function PortfolioPage() {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8"
      data-testid="portfolio-page"
    >
      <PageHeader
        description="What you've backed, what you've built, and your share of each."
        title={
          <span className="flex items-center gap-2">
            <Briefcase aria-hidden className="h-5 w-5" /> Portfolio
          </span>
        }
      />
      <WorkSection />
      <BackingSection />
      <FollowingSection />
    </div>
  );
}
