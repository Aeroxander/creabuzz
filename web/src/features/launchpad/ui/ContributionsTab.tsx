/**
 * Who earned this project's Shares, how many, and for which accepted work: every award the DAO voted, read from the
 * chain and checked against the Shares that actually arrived (`lib/contributions.ts`), grouped by person, with what each
 * holds now beside it. The same for everyone, with or without a wallet.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { ethBlockTimestamps, getRpcEndpoint } from "../chain";
import {
  type AwardStory,
  firstLink,
  shortEvidence,
  storyFor,
  storyKey,
} from "../lib/contribution-story";
import { formatUnits } from "../lib/dao-actions";
import type { ContributionAward } from "../lib/contributions";
import { isContributorProject } from "../lib/funding";
import { testRecordsNotice } from "../lib/test-network";
import type { Launch } from "../models";
import { useContributions } from "../use-contributions";
import { useEvidencePackets } from "../use-evidence";
import { useWalletLabels } from "../use-wallet-labels";
import { useWork } from "../use-work";
import { paidOn, TxLink } from "./TxLink";
import { VoteControlNote } from "./VoteControlNote";

const shares = (value: bigint) => formatUnits(value, 18);

/** Basis points as a percent, one decimal at most. */
function percent(bps: number): string {
  const tenths = Math.round(bps / 10);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

/** What the person delivered, when, how the review went, and the transaction: each said only as far as it is known. */
function AwardStoryLine({
  story,
  award,
  chainId,
  onRetryEvidence,
}: {
  story: AwardStory;
  award: ContributionAward;
  chainId: number;
  onRetryEvidence: () => void;
}) {
  const link = story.evidence ? firstLink(story.evidence) : null;
  return (
    <div
      className="mt-0.5 flex flex-col gap-0.5 text-xs text-muted-foreground"
      data-testid="contribution-award-story"
    >
      <span>
        {story.at === null ? "Date not read" : `Awarded ${paidOn(story.at)}`}
        {award.txHash ? (
          <>
            {" · "}
            <TxLink chainId={chainId} tx={award.txHash} />
          </>
        ) : null}
        {story.review
          ? ` · ${story.review.approvals} ${story.review.approvals === 1 ? "approval" : "approvals"}, ${story.review.quorum} needed`
          : ""}
      </span>
      {story.evidence ? (
        <span data-testid="contribution-award-evidence">
          In their words: “{shortEvidence(story.evidence)}”
          {link ? (
            <>
              {" "}
              <a
                className="break-all text-primary-ink underline-offset-4 hover:underline"
                href={link}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open what they delivered
              </a>
            </>
          ) : null}
        </span>
      ) : story.evidenceState === "mismatch" ? (
        <span>
          What was published for it is not what the claim committed to, so it is
          not shown as theirs.
        </span>
      ) : story.evidenceState === "missing" ? (
        <span>No evidence was published for it.</span>
      ) : story.evidenceState === "not-found" ? (
        <span>Its evidence was not found in the history this page read.</span>
      ) : story.evidenceState === "unreadable" ? (
        <span>
          Couldn&apos;t read its evidence just now.{" "}
          <button className="underline" onClick={onRetryEvidence} type="button">
            Try again
          </button>
        </span>
      ) : story.evidenceState === "reading" ? (
        <span>Reading its evidence…</span>
      ) : (
        <span>Its evidence is on the Work tab with the claim.</span>
      )}
    </div>
  );
}

function AwardLine({
  award,
  launch,
  story,
  onRetryEvidence,
}: {
  award: ContributionAward;
  launch: Launch;
  story: AwardStory | null;
  onRetryEvidence: () => void;
}) {
  return (
    <li className="text-sm" data-testid="contribution-award">
      <span data-testid="contribution-award-title">
        <span className="font-semibold tabular-nums">
          {shares(award.shares)} Shares
        </span>{" "}
        for{" "}
        <Link
          className="underline underline-offset-2"
          params={{ launchId: launch.record.id }}
          search={{
            author: launch.record.author,
            tab: "work",
            claim: award.claimId,
            mandate: award.budget,
          }}
          to="/launchpad/$launchId"
        >
          {award.claim}
        </Link>
        {award.project ? (
          <span className="text-muted-foreground">
            {" "}
            in the work area {award.project}
          </span>
        ) : null}
      </span>
      {award.receipt === "received" ? null : (
        <span
          className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="contribution-award-unconfirmed"
        >
          {award.receipt === "missing"
            ? "Award recorded; the Shares were not found reaching them"
            : "Award recorded; receipt not checked"}
        </span>
      )}
      {story ? (
        <AwardStoryLine
          award={award}
          chainId={Number(launch.record.chainId ?? "") || 0}
          onRetryEvidence={onRetryEvidence}
          story={story}
        />
      ) : null}
    </li>
  );
}

/**
 * The stories behind the awards: the claims and their evidence the Work tab reads (shared cache), and the times of the
 * blocks the awards ran in, read once for the blocks shown.
 */
function useAwardStories(
  dao: string,
  launch: Launch,
  awards: readonly ContributionAward[],
) {
  const work = useWork(dao, null);
  const evidence = useEvidencePackets(launch);
  const blocks = useMemo(
    () => [
      ...new Set(
        awards.flatMap((a) => (a.blockNumber === null ? [] : [a.blockNumber])),
      ),
    ],
    [awards],
  );
  const times = useQuery({
    queryKey: ["launchpad", "work", dao, "award-times", blocks],
    enabled: blocks.length > 0,
    queryFn: async () =>
      new Map(
        (await ethBlockTimestamps(getRpcEndpoint(), blocks)).map((s) => [
          s.block,
          s.timestampSeconds,
        ]),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const stories = useMemo(() => {
    const claims = new Map(
      (work.data?.mandates ?? []).flatMap((m) =>
        m.claims.map((c) => [storyKey(m.address, c.id), c] as const),
      ),
    );
    const stories = new Map<string, AwardStory>();
    for (const award of awards) {
      stories.set(
        storyKey(award.budget, award.claimId),
        storyFor(award, {
          times: times.data ?? new Map(),
          claims,
          packets: evidence.packets,
          read: {
            loading: evidence.loading,
            error: evidence.error,
            incomplete: evidence.incomplete,
          },
        }),
      );
    }
    return stories;
  }, [
    awards,
    work.data,
    times.data,
    evidence.packets,
    evidence.loading,
    evidence.error,
    evidence.incomplete,
  ]);
  return { stories, retryEvidence: evidence.refetch };
}

export function ContributionsTab({
  dao,
  launch,
}: {
  dao: string;
  launch: Launch;
}) {
  const contributions = useContributions(dao);
  const snapshot = contributions.data;
  const addresses = useMemo(
    () => snapshot?.people.map((p) => p.address) ?? [],
    [snapshot],
  );
  const label = useWalletLabels(addresses);
  const contributor = isContributorProject(launch.record);
  const testNotice = testRecordsNotice(launch.record.chainId);
  const allAwards = useMemo(
    () => snapshot?.people.flatMap((p) => p.awards) ?? [],
    [snapshot],
  );
  const { stories, retryEvidence } = useAwardStories(dao, launch, allAwards);

  if (contributions.isLoading) {
    return (
      <Card
        className="p-4 text-sm text-muted-foreground"
        data-testid="contributions-tab"
      >
        Reading the awards from the network…
      </Card>
    );
  }
  if (!snapshot) {
    return (
      <Card
        className="flex flex-wrap items-center gap-3 p-4 text-sm"
        data-testid="contributions-tab"
      >
        <span data-testid="contributions-failed" role="alert">
          Couldn't read who earned Shares from the network.
        </span>
        <Button
          onClick={() => void contributions.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </Card>
    );
  }

  const { totalShares, earned, unconfirmed, startingShares, people } = snapshot;
  return (
    <div
      className="flex max-w-3xl flex-col gap-4"
      data-testid="contributions-tab"
    >
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-base font-bold">Who earned the Shares</h2>
        <p className="text-sm text-muted-foreground">
          {contributor
            ? "This project started without a token sale. New Shares come only from awards: the reviewers approve the work, then Shareholders vote to award it. "
            : ""}
          Every award below is read from the network and checked against the
          Shares that reached the person, not taken from what anyone wrote about
          the work. Past awards can differ from what someone holds today.
        </p>
        {testNotice ? (
          <p
            className="text-sm font-medium"
            data-testid="contributions-test-records"
          >
            {testNotice}
          </p>
        ) : null}
        <dl className="mt-1 flex flex-wrap gap-3">
          <div className="rounded-lg bg-secondary/60 px-3 py-1.5">
            <dt className="text-xs font-semibold text-muted-foreground">
              Shares awarded over time
            </dt>
            <dd
              className="text-lg font-extrabold tabular-nums"
              data-testid="contributions-earned"
            >
              {shares(earned)}
            </dd>
          </div>
          {unconfirmed > 0n ? (
            <div className="rounded-lg bg-amber-50 px-3 py-1.5 dark:bg-amber-950">
              <dt className="text-xs font-semibold text-muted-foreground">
                Recorded, not confirmed
              </dt>
              <dd
                className="text-lg font-extrabold tabular-nums"
                data-testid="contributions-unconfirmed"
              >
                {shares(unconfirmed)}
              </dd>
            </div>
          ) : null}
          <div className="rounded-lg bg-secondary/60 px-3 py-1.5">
            <dt className="text-xs font-semibold text-muted-foreground">
              {contributor ? "Starting Shares" : "Issued other than for work"}
            </dt>
            <dd
              className="text-lg font-extrabold tabular-nums"
              data-testid="contributions-starting"
            >
              {startingShares === null ? "Unknown" : shares(startingShares)}
            </dd>
          </div>
          <div className="rounded-lg bg-secondary/60 px-3 py-1.5">
            <dt className="text-xs font-semibold text-muted-foreground">
              All Shares now
            </dt>
            <dd
              className="text-lg font-extrabold tabular-nums"
              data-testid="contributions-total"
            >
              {totalShares === null ? "Unknown" : shares(totalShares)}
            </dd>
          </div>
        </dl>
        {snapshot.receiptsUnread ? (
          <p
            className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="contributions-receipts-unread"
            role="status"
          >
            Couldn&apos;t check just now that each award&apos;s Shares reached
            the person, so the awards show as recorded, not confirmed.
            <button
              className="underline"
              onClick={() => void contributions.refetch()}
              type="button"
            >
              Try again
            </button>
          </p>
        ) : null}
        {snapshot.truncated ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            This DAO has more work budgets or awards than this page reads; the
            oldest are shown.
          </p>
        ) : null}
      </Card>

      <Card className="p-4" data-testid="contributions-control">
        <h2 className="text-base font-bold">Who decides right now</h2>
        <p className="text-sm text-muted-foreground">
          A project&apos;s decisions are votes of its Shares. Until awards
          spread the Shares, the founder&apos;s starting Shares can be enough to
          decide alone; this reads where that stands now.
        </p>
        <VoteControlNote
          dao={dao}
          kind={contributor ? "contributors" : "raise"}
        />
      </Card>

      {people.length === 0 ? (
        <Card
          className="p-4 text-sm text-muted-foreground"
          data-testid="contributions-empty"
        >
          No Share awards are shown yet. Reviewed work can become an award after
          a separate project vote; the person and the work then show up here.
        </Card>
      ) : (
        <ol className="flex flex-col gap-3">
          {people.map((person) => (
            <li key={person.address}>
              <Card className="p-4" data-testid="contribution-person">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span
                    className="min-w-0 break-all font-semibold"
                    data-testid="contribution-person-name"
                    title={person.address}
                  >
                    {label(person.address)}
                  </span>
                  <span
                    className="text-sm tabular-nums"
                    data-testid="contribution-person-earned"
                  >
                    {shares(person.earned)} Shares awarded
                    {person.unconfirmed > 0n
                      ? ` · ${shares(person.unconfirmed)} recorded, not confirmed`
                      : ""}
                  </span>
                </div>
                <p
                  className="mt-0.5 text-xs text-muted-foreground"
                  data-testid="contribution-person-held"
                >
                  {person.heldNow === null
                    ? "What they hold now could not be read."
                    : `Holds ${shares(person.heldNow)} now${person.bpsNow === null ? "" : ` (${percent(person.bpsNow)} of all Shares now)`}.`}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {person.awards.map((award) => (
                    <AwardLine
                      award={award}
                      key={`${award.budget}:${award.claimId}`}
                      launch={launch}
                      onRetryEvidence={retryEvidence}
                      story={
                        stories.get(storyKey(award.budget, award.claimId)) ??
                        null
                      }
                    />
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
