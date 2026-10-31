import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { ethCall, getRpcEndpoint } from "../chain";
import { encodeCastVote, encodeCastVoteFor } from "../lib/vote-tx";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import { useAllocationDelegators } from "../use-allocation-delegators";
import { useWalletLabels } from "../use-wallet-labels";
import {
  ALL_VOTING_SHARES,
  decodeVotingAllocation,
  encodeVotingAllocationFor,
  parseVotingShares,
  VOTING_OWNER_RE,
} from "@creaton/core/launchpad/voting-allocation.ts";

const shares = (wei: bigint) => formatUnits(wei, 18, 4);

/**
 * Back or oppose one decision with Shares. Backing is a position you can move or take back until the decision runs
 * (a holder splits their Shares between decisions); opposing never uses Shares up. Read fresh from the chain, so the
 * numbers shown are what the vote will actually do.
 */
export function DecisionVote({
  dao,
  id,
  account,
  busy,
  gate,
  onSend,
}: {
  dao: string;
  id: string;
  account: string | null;
  busy: string | null;
  gate: string | null;
  /** Sends one transaction; resolves true once it landed. */
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const field = useId();
  const [amount, setAmount] = useState("");
  const [onBehalf, setOnBehalf] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Whose vote this account may also cast: only people who handed it theirs, named, never typed in as an address.
  const delegators = useAllocationDelegators(dao, account);
  const nameOf = useWalletLabels(delegators);
  const forOther = delegators.includes(onBehalf);
  const owner = (forOther ? onBehalf : "") || account;
  const validOwner = owner !== null && VOTING_OWNER_RE.test(owner);
  const allocation = useQuery({
    queryKey: ["launchpad", "work", dao, "allocation", id, owner],
    enabled: validOwner,
    queryFn: async () =>
      decodeVotingAllocation(
        await ethCall(
          getRpcEndpoint(),
          dao,
          encodeVotingAllocationFor(id, owner as string),
        ),
      ),
    staleTime: 3_000,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 8_000,
    retry: 1,
  });
  const data = allocation.data;
  const sending = busy?.startsWith(`vote-${id}`) ?? false;

  /** The Shares this vote would use: what was typed, or everything that can be put behind this side. */
  function chosen(): bigint | null {
    if (!amount.trim()) return ALL_VOTING_SHARES;
    try {
      return parseVotingShares(amount);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "Enter a Shares amount.",
      );
      return null;
    }
  }

  async function vote(support: 0 | 1 | 2, withdraw = false) {
    setProblem(null);
    if (!data || !owner) return;
    const wei = withdraw ? 0n : chosen();
    if (wei === null) return;
    const cap = support === 0 ? data.opposable : data.eligible;
    if (!withdraw && wei !== ALL_VOTING_SHARES && wei > cap) {
      setProblem(
        support === 0
          ? "That is more Shares than you hold."
          : "That is more than you have free to back this with.",
      );
      return;
    }
    if (!withdraw && cap === 0n) {
      setProblem(
        support === 0
          ? "You hold no Shares that can oppose this."
          : "You have no Shares free to back this with. Take your vote back from another decision first, or the Shares reached you after this one opened.",
      );
      return;
    }
    const tx =
      forOther && owner
        ? encodeCastVoteFor(owner, id, support, wei)
        : encodeCastVote(id, support, wei);
    const landed = await onSend(
      `vote-${id}-${support}${withdraw ? "-withdraw" : ""}`,
      dao,
      tx,
    );
    if (landed) {
      setAmount("");
      await allocation.refetch();
    }
  }

  const sideWord =
    data?.side === 0
      ? "opposing"
      : data?.side === 2
        ? "abstaining with"
        : "backing this with";
  const disabled = busy !== null || gate !== null || !validOwner || !data;
  // Nothing to vote with: the buttons go, and voting for someone who gave you their vote (below) stays.
  const nothingToVote = data?.owned === 0n && !forOther;

  return (
    <section
      aria-label="Your vote"
      className="mt-3 space-y-2"
      data-testid="decision-vote"
    >
      <p className="text-sm" data-testid="decision-vote-summary" role="status">
        {!account && !forOther
          ? "Sign in with your passkey or connect a wallet to vote."
          : allocation.isError
            ? "Your Shares could not be read. Check the connection and try again."
            : !data
              ? "Reading your Shares…"
              : data.owned === 0n
                ? "You hold no Shares, so you cannot vote on this."
                : `You hold ${shares(data.owned)} Shares. ${shares(data.eligible)} can back this${
                    data.eligible === 0n
                      ? " (the rest are behind other decisions, or reached you after this one opened)"
                      : ""
                  }${data.amount > 0n ? `; you are ${sideWord} ${shares(data.amount)}` : ""}.`}
      </p>
      <div
        className={nothingToVote ? "hidden" : "flex flex-wrap items-end gap-2"}
      >
        <div>
          <label
            className="block text-xs text-muted-foreground"
            htmlFor={`${field}-amount`}
          >
            How many Shares (leave empty for all you can)
          </label>
          <input
            className="mt-1 w-44 rounded border bg-background px-2 py-1 text-sm"
            data-testid="decision-vote-amount"
            disabled={busy !== null}
            id={`${field}-amount`}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            placeholder="All"
            value={amount}
          />
        </div>
        <Button
          data-testid="decision-vote-for"
          disabled={disabled}
          onClick={() => void vote(1)}
          size="sm"
          type="button"
        >
          {sending ? "Voting…" : "Back it"}
        </Button>
        <Button
          data-testid="decision-vote-against"
          disabled={disabled}
          onClick={() => void vote(0)}
          size="sm"
          type="button"
          variant="outline"
        >
          Oppose
        </Button>
        <Button
          data-testid="decision-vote-abstain"
          disabled={disabled}
          onClick={() => void vote(2)}
          size="sm"
          type="button"
          variant="outline"
        >
          Neutral
        </Button>
        {data && data.amount > 0n ? (
          <Button
            data-testid="decision-vote-withdraw"
            disabled={disabled}
            onClick={() => void vote((data.side as 0 | 1 | 2) ?? 1, true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Take my vote back
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {problem}
        </p>
      ) : null}
      {delegators.length > 0 ? (
        <label
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="decision-vote-for"
          htmlFor={`${field}-owner`}
        >
          Whose vote
          <select
            className="rounded border bg-background px-2 py-1 text-sm text-foreground"
            id={`${field}-owner`}
            onChange={(e) => setOnBehalf(e.target.value)}
            value={forOther ? onBehalf : ""}
          >
            <option value="">Mine</option>
            {delegators.map((person) => (
              <option key={person} value={person}>
                {nameOf(person)}, who gave you their vote
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}
