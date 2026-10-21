/**
 * Who earned this project's Shares, how many, and for which accepted work: every award the DAO voted, read from the
 * chain (`lib/contributions.ts`), grouped by person. The same for everyone, with or without a wallet.
 */

import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { formatUnits } from "../lib/dao-actions";
import type { ContributionAward } from "../lib/contributions";
import { isContributorProject } from "../lib/funding";
import { testRecordsNotice } from "../lib/test-network";
import type { Launch } from "../models";
import { useContributions } from "../use-contributions";
import { useWalletLabels } from "../use-wallet-labels";
import { VoteControlNote } from "./VoteControlNote";

const shares = (value: bigint) => formatUnits(value, 18);

/** Basis points as a percent, one decimal at most. */
function percent(bps: number): string {
  const tenths = Math.round(bps / 10);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

function AwardLine({
  award,
  launch,
}: {
  award: ContributionAward;
  launch: Launch;
}) {
  return (
    <li className="text-sm" data-testid="contribution-award">
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
          in the project {award.project}
        </span>
      ) : null}
    </li>
  );
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

  const { totalShares, earned, notFromWork, people } = snapshot;
  return (
    <div
      className="flex max-w-3xl flex-col gap-4"
      data-testid="contributions-tab"
    >
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-base font-bold">Who earned the Shares</h2>
        <p className="text-sm text-muted-foreground">
          {contributor
            ? "This project cannot raise money. Its Shares are earned only for work the reviewers approved and the project then voted to award. "
            : ""}
          Every award below is read from the network, not from what anyone wrote
          about the work.
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
              Earned for accepted work
            </dt>
            <dd
              className="text-lg font-extrabold tabular-nums"
              data-testid="contributions-earned"
            >
              {shares(earned)}
              {totalShares && totalShares > 0n
                ? ` (${percent(Number((earned * 10_000n) / totalShares))} of all)`
                : ""}
            </dd>
          </div>
          <div className="rounded-lg bg-secondary/60 px-3 py-1.5">
            <dt className="text-xs font-semibold text-muted-foreground">
              Not from work (the starting Shares)
            </dt>
            <dd
              className="text-lg font-extrabold tabular-nums"
              data-testid="contributions-not-from-work"
            >
              {notFromWork === null ? "Unknown" : shares(notFromWork)}
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
          Nobody has earned Shares for work yet. Once the reviewers approve a
          claim and the project votes to award it, the person and the work show
          up here.
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
                    {shares(person.earned)} Shares
                    {person.bpsOfAll === null
                      ? ""
                      : `, ${percent(person.bpsOfAll)} of all`}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {person.awards.map((award) => (
                    <AwardLine
                      award={award}
                      key={`${award.budget}:${award.claimId}`}
                      launch={launch}
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
