import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/shared/ui/button";
import {
  ALL_VOTING_SHARES,
  VOTING_OWNER_RE,
  decodeVotingAllocation,
  encodeVotingAllocationFor,
  formatVotingShares,
  parseVotingShares,
} from "../lib/voting-allocation";

/** A movable Shares allocation for direct owners and delegates, with a fresh chain preview. */
export function VotingAllocationControls({
  account,
  dao,
  proposalId,
  rpcUrl,
  pending,
  read,
  onVote,
  onConnect,
}: {
  account: string | null;
  dao: string;
  proposalId: string;
  rpcUrl: string;
  pending: boolean;
  read: (data: string) => Promise<string>;
  onVote: (
    support: number,
    amount: bigint,
    sourceOwner?: string,
  ) => Promise<unknown>;
  onConnect?: () => Promise<unknown>;
}) {
  const id = useId();
  const [sendError, setSendError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("");
  const [activeSupport, setActiveSupport] = useState<number | null>(null);
  const owner = source.trim() || account;
  const validOwner = owner !== null && VOTING_OWNER_RE.test(owner);
  const allocation = useQuery({
    queryKey: ["voting-allocation", rpcUrl, dao, proposalId, owner],
    queryFn: async () =>
      decodeVotingAllocation(
        await read(encodeVotingAllocationFor(proposalId, owner as string)),
      ),
    enabled: validOwner,
    staleTime: 2_000,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 5_000,
    retry: 1,
  });
  let parsed = ALL_VOTING_SHARES;
  let validation: string | null = null;
  try {
    if (amount.trim()) parsed = parseVotingShares(amount);
    if (
      allocation.data &&
      parsed !== ALL_VOTING_SHARES &&
      parsed > allocation.data.eligible
    )
      validation = "That amount exceeds your eligible Shares on this proposal.";
  } catch (error) {
    validation =
      error instanceof Error ? error.message : "Invalid Shares amount.";
  }
  if (source.trim() && !validOwner)
    validation = "Enter a valid source owner address.";
  const disabled =
    pending ||
    !account ||
    !allocation.data ||
    allocation.isError ||
    (parsed === 0n
      ? allocation.data.amount === 0n
      : allocation.data.eligible === 0n) ||
    validation !== null;
  async function submit(support: number, withdraw = false) {
    if (
      withdraw
        ? pending ||
          !account ||
          !allocation.data ||
          allocation.isError ||
          allocation.data.amount === 0n
        : disabled
    )
      return;
    setActiveSupport(support);
    setSendError(null);
    try {
      await onVote(support, withdraw ? 0n : parsed, source.trim() || undefined);
      await allocation.refetch();
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "The vote could not be sent.",
      );
    } finally {
      setActiveSupport(null);
    }
  }
  return (
    <section
      aria-label="Voting allocation"
      className="my-2 space-y-2"
      data-testid="voting-allocation-controls"
    >
      <p className="text-xs text-muted-foreground">
        Allocate Shares across proposals. New support builds conviction with a
        12-hour half-life. Change or withdraw it anytime before execution. Loot
        does not vote.
      </p>
      <label className="block text-xs" htmlFor={`${id}-source`}>
        Vote on behalf of (optional)
      </label>
      <input
        id={`${id}-source`}
        className="w-full rounded border bg-background px-2 py-1 text-sm"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="Source owner address, if you are their delegate"
        aria-invalid={Boolean(source.trim()) && !validOwner}
        aria-describedby={
          source.trim() && !validOwner ? `${id}-error` : undefined
        }
        disabled={pending}
      />
      <p
        className="text-xs text-muted-foreground"
        role="status"
        data-testid="voting-allocation-balance"
      >
        {allocation.data && !allocation.isError
          ? `${formatVotingShares(allocation.data.available)} free / ${formatVotingShares(allocation.data.owned)} owned · ${formatVotingShares(allocation.data.amount)} allocated here · ${formatVotingShares(allocation.data.eligible)} eligible for this proposal`
          : !validOwner
            ? "Connect your wallet or enter a source owner to view your Shares."
            : allocation.isError
              ? "Voting allocation could not be read. Check the RPC and DAO deployment."
              : "Reading Shares allocations…"}
      </p>
      {allocation.isError ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={allocation.isFetching}
          onClick={() => void allocation.refetch()}
        >
          Retry Shares read
        </Button>
      ) : null}
      {!account && onConnect ? (
        <Button type="button" size="sm" onClick={() => void onConnect()}>
          Connect voting account
        </Button>
      ) : null}
      <label className="block text-xs" htmlFor={`${id}-amount`}>
        Shares to allocate
      </label>
      <input
        id={`${id}-amount`}
        data-testid="voting-allocation-amount"
        className="w-full rounded border bg-background px-2 py-1 text-sm"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="All eligible Shares"
        disabled={pending}
        aria-invalid={validation !== null}
        aria-describedby={validation ? `${id}-error` : undefined}
      />
      {validation ? (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {validation}
        </p>
      ) : null}
      {sendError ? (
        <p className="text-xs text-destructive" role="alert">
          {sendError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {[
          { support: 1, label: "For" },
          { support: 0, label: "Against" },
          { support: 2, label: "Abstain" },
        ].map(({ support, label }) => (
          <Button
            key={support}
            type="button"
            size="sm"
            variant={support === 1 ? "default" : "outline"}
            data-testid={`proposal-vote-${label.toLowerCase()}`}
            disabled={disabled || activeSupport !== null}
            onClick={() => void submit(support)}
          >
            {activeSupport === support ? "Voting…" : label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="proposal-vote-withdraw"
          disabled={
            pending ||
            !account ||
            !allocation.data ||
            allocation.isError ||
            allocation.data.amount === 0n ||
            activeSupport !== null
          }
          onClick={() => void submit(allocation.data?.side ?? 1, true)}
        >
          Withdraw support
        </Button>
      </div>
    </section>
  );
}
