/**
 * "Who decides right now": the founder-control disclosure, read from the DAO (`lib/vote-control.ts`). In a raise it is
 * about the team, whose Shares vote from the first day while backers' vote only once claimed; in a contributor project
 * it is about the biggest holder, nearly always the founder until awards spread ownership. It says whether they can pass
 * decisions alone and what changes that, and says so plainly when it cannot be read.
 */

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";

import { ethCall, getRpcEndpoint } from "../chain";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  aloneUntil,
  controlOf,
  readVoteControl,
  voteControlLines,
} from "../lib/vote-control";
import { useDecisionContext } from "../use-decisions";
import { useWalletLabels } from "../use-wallet-labels";
import { useDaoHolders } from "../use-work";

const shares = (value: bigint) => formatUnits(value, 18);

export function VoteControlNote({
  dao,
  kind,
}: {
  dao: string;
  kind: "raise" | "contributors";
}) {
  const context = useDecisionContext(dao);
  const policy = context.data?.policy ?? null;
  const sharesToken = context.data?.shares ?? null;
  const control = useQuery({
    queryKey: ["launchpad", "work", dao, "vote-control", policy, sharesToken],
    enabled: policy !== null && sharesToken !== null,
    queryFn: () => {
      const endpoint = getRpcEndpoint();
      return readVoteControl(
        (to, data) => ethCall(endpoint, to, data),
        dao,
        policy as string,
        sharesToken as string,
      );
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const holders = useDaoHolders(dao);
  const left = new Set([dao.toLowerCase(), ...(control.data?.excluded ?? [])]);
  const voters = (holders.data?.holders ?? []).filter(
    (h) => !left.has(h.holder) && h.balance > 0n,
  );
  // In a raise the team is who the backers need to know about: the holders whose Shares are still behind milestones.
  const team = kind === "raise" ? voters.filter((h) => h.locked > 0n) : [];
  const biggest = voters[0];
  const label = useWalletLabels(
    [biggest?.holder, team[0]?.holder].filter((a): a is string => !!a),
  );

  const failed =
    (context.isError && !context.data) ||
    (control.isError && !control.data) ||
    (holders.isError && !holders.data);
  if (failed) {
    return (
      <div className="mt-2 text-sm" data-testid="vote-control-unread">
        <p>Couldn&apos;t read who holds the votes just now.</p>
        <Button
          className="mt-1"
          onClick={() => {
            void context.refetch();
            void control.refetch();
            void holders.refetch();
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!control.data || !holders.data) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Reading who holds the votes…
      </p>
    );
  }
  if (control.data.votingSupply === 0n) {
    return (
      <p className="mt-2 text-sm" data-testid="vote-control">
        Nobody holds votes that count yet.
      </p>
    );
  }
  if (holders.data.tooMany || !holders.data.accounted || !biggest) {
    return (
      <p className="mt-2 text-sm" data-testid="vote-control">
        This page cannot tell who holds the most votes: the Shares&apos; history
        is too long to add up here, or did not add up to the supply.
      </p>
    );
  }
  const groupWeight = team.reduce((sum, h) => sum + h.balance, 0n);
  const subject =
    team.length > 1
      ? {
          who: `The team (${team.length} members whose Shares are still behind milestones, together)`,
          weight: groupWeight,
        }
      : team.length === 1
        ? { who: label(team[0].holder), weight: team[0].balance }
        : { who: label(biggest.holder), weight: biggest.balance };
  const lines = voteControlLines({
    ...subject,
    control: control.data,
    kind,
    shares,
  });
  return (
    <div
      className="mt-2 flex flex-col gap-1 text-sm"
      data-control={controlOf(subject.weight, control.data)}
      data-testid="vote-control"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <UntilTable
        until={aloneUntil(subject.weight, control.data)}
        who={subject.who}
      />
    </div>
  );
}

/** Per kind of decision, how many more Shares others must hold before one holder stops passing it alone. */
function UntilTable({
  who,
  until,
}: {
  who: string;
  until: ReturnType<typeof aloneUntil>;
}) {
  if (until.full === null && until.bounded === null) return null;
  const rows = [
    { label: "Rule changes and spending", value: until.full },
    { label: "Awards and work areas", value: until.bounded },
  ];
  return (
    <table
      className="mt-1 w-full max-w-md text-sm"
      data-testid="vote-control-until"
    >
      <caption className="text-left text-xs text-muted-foreground">
        More Shares others must hold before {who} stops deciding alone
      </caption>
      <tbody>
        {rows.map((row) => (
          <tr className="border-t border-border/60" key={row.label}>
            <th className="py-1 pr-3 text-left font-normal" scope="row">
              {row.label}
            </th>
            <td className="py-1 text-right tabular-nums">
              {row.value === null
                ? "Already shared"
                : `${shares(row.value)} more`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The same before the DAO exists, from the plan's split: the team's Shares vote from the first day and backers' only once
 * claimed, so the team holds most of the votes until enough are claimed, and its share once all are.
 */
export function planVoteControlText(allocation: {
  sale: number;
  team: number;
}): string | null {
  const { sale, team } = allocation;
  if (!(team > 0) || !(sale > 0)) return null;
  const share = (team * 100) / (sale + team);
  const rounded = Math.round(share * 10) / 10;
  // The DAO starts with these bars (AllocationVoting.initialize): 20% must take part, 66% of votes cast in favour.
  const power =
    share >= 66
      ? "enough to pass any decision even if every backer votes against it"
      : share >= 20
        ? "enough to pass a decision no backer votes on, but not one backers vote against"
        : "not enough to pass a decision alone";
  return `The team's Shares vote from the first day; backers' Shares vote only once they are claimed from the sale, so until enough are claimed the team holds most of the votes that count and can pass decisions alone. Once every sale Share is claimed, the team holds ${rounded}% of the votes: ${power}.`;
}
