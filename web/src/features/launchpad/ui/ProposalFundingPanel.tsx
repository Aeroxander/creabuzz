/**
 * The backer-directed half of a raise (plan §4): the voucher vault, and the
 * funding proposals backers choose between — money goes where backers send it,
 * not where the team would have spent it.
 *
 * The arithmetic is `lib/proposal-funding.ts`, shared with the contract's
 * fixture tests so the figures shown here are the figures the chain settles.
 * Nothing in this panel invents a number.
 */

import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { FundingProposal } from "../lib/proposal-funding";
import {
  backingProgress,
  backingTax,
  isResolvable,
  missedMinimum,
  priceIsAllowed,
  remainingRoom,
  reserveAfterTax,
  tokensForReserve,
  toBig,
} from "../lib/proposal-funding";

/**
 * Historical escrow position for an existing voucher vault. Its legacy weight
 * is not used by the Shares ballot. These are the vault's own two O(1) reads,
 * so the panel never has to reconstruct a position list the chain does not
 * enumerate.
 */
export interface ProposalHolding {
  escrowed: string;
  weight: string;
}

export interface ProposalVaultActions {
  pledge(amount: string): void;
  refundVouchers(amount: string): void;
  back(proposalId: string, vouchers: string): void;
  claim(proposalId: string): void;
  refund(proposalId: string): void;
}

export interface ProposalFundingPanelProps {
  /** The launch's vault, once it is deployed. Null until then. */
  vault: string | null;
  /**
   * What each control does. Null until the vault is reachable — a control that
   * renders but cannot act is a dead end, so the panel shows none (the same
   * rule the rest of this surface follows for a pre-deploy launch).
   */
  actions: ProposalVaultActions | null;
  /** The tax on backing, in basis points. */
  taxBps: number;
  /** The maturation window, in blocks, for the weight a commitment earns. */
  /** The join price and the floor it may never fall below. */
  pricePerToken: string;
  floorPerToken: string;
  /** The backer's unspent vouchers. */
  vouchers: string;
  proposals: readonly FundingProposal[];
  /** Per proposal: what this backer has escrowed and the weight it buys. */
  own: Record<string, ProposalHolding>;
  /** Tokens still at risk behind unresolved proposals. */
  atRisk: string;
  currentBlock: number | null;
}

export function ProposalFundingPanel({
  vault,
  actions,
  taxBps,
  pricePerToken,
  floorPerToken,
  vouchers,
  proposals,
  own,
  atRisk,
  currentBlock,
}: ProposalFundingPanelProps) {
  const [amount, setAmount] = useState("");
  const [commitments, setCommitments] = useState<Record<string, string>>({});

  const priceAllowed = priceIsAllowed(pricePerToken, floorPerToken);

  if (!vault || !actions) {
    return (
      <Card className="p-4" data-testid="proposal-vault">
        <h2 className="text-base font-semibold">Where your money goes</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          Treasury decisions use the movable Shares allocations in Proposals.
          This project has no linked legacy escrow vault.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="proposal-vault">
      <div>
        <h2 className="text-base font-semibold">Where your money goes</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This is a legacy proposal escrow vault. Vouchers direct deposits and
          support claims or refunds; they grant no DAO voting power. Treasury
          governance uses the Shares ballot in Proposals.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-xl bg-secondary px-3 py-2 text-sm font-bold tabular-nums"
          data-testid="vault-vouchers"
        >
          {vouchers} vouchers
        </span>
        <span
          className="rounded-xl bg-secondary/70 px-3 py-2 text-sm tabular-nums"
          data-testid="vault-at-risk"
          title="Committed to proposals that have not resolved"
        >
          {atRisk.toString()} at risk
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="pledge-amount">
          Amount to pledge
        </label>
        <input
          className="w-36 rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm tabular-nums dark:border-white/15"
          data-testid="pledge-amount"
          id="pledge-amount"
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          value={amount}
        />
        <Button
          data-testid="pledge"
          disabled={amount.trim() === ""}
          onClick={() => actions.pledge(amount.trim())}
          size="sm"
        >
          Pledge
        </Button>
        <Button
          data-testid="refund-vouchers"
          disabled={toBig(vouchers) === 0n}
          onClick={() => actions.refundVouchers(vouchers)}
          size="sm"
          variant="outline"
        >
          Take unspent back
        </Button>
      </div>

      <ul className="flex flex-col gap-3">
        {proposals.length === 0 ? (
          <li className="text-sm text-black/60 dark:text-white/60">
            No proposals yet. When one opens, you decide whether it gets funded.
          </li>
        ) : null}
        {proposals.map((proposal) => (
          <ProposalRow
            actions={actions}
            commitment={commitments[proposal.id] ?? ""}
            currentBlock={currentBlock}
            key={proposal.id}
            onCommitment={(value) =>
              setCommitments((prev) => ({ ...prev, [proposal.id]: value }))
            }
            holding={own[proposal.id] ?? { escrowed: "0", weight: "0" }}
            pricePerToken={pricePerToken}
            proposal={proposal}
            taxBps={taxBps}
          />
        ))}
      </ul>

      {!priceAllowed ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          The price offered is below what the treasury says a token is worth, so
          nothing can be committed. That rule exists so buying and then leaving
          can never be free money.
        </p>
      ) : null}
    </Card>
  );
}

function ProposalRow({
  proposal,
  holding,
  commitment,
  taxBps,
  pricePerToken,
  currentBlock,
  actions,
  onCommitment,
}: {
  proposal: FundingProposal;
  holding: ProposalHolding;
  commitment: string;
  taxBps: number;
  pricePerToken: string;
  currentBlock: number | null;
  actions: ProposalVaultActions;
  onCommitment(value: string): void;
}) {
  const hasPosition = toBig(holding.escrowed) > 0n;
  const commit = commitment.trim();
  const reserve = commit === "" ? 0n : reserveAfterTax(commit, taxBps);
  const tokens = tokensForReserve(reserve, pricePerToken);
  const room = remainingRoom(proposal);
  const closed = proposal.state !== "open";
  const canBack = !closed && commit !== "" && reserve > 0n && reserve <= room;

  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-black/10 p-3 dark:border-white/10"
      data-testid="funding-proposal"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">
          {backingProgress(proposal)}
        </span>
        <span className="text-xs text-black/60 dark:text-white/60">
          {proposal.state === "open"
            ? "Open for backing"
            : proposal.state === "verified"
              ? "Milestone verified"
              : "Did not go ahead"}
        </span>
      </div>

      {closed ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`commit-${proposal.id}`}>
            Vouchers to spend on this proposal
          </label>
          <input
            className="w-32 rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm tabular-nums dark:border-white/15"
            data-testid="commit-amount"
            id={`commit-${proposal.id}`}
            inputMode="decimal"
            onChange={(e) => onCommitment(e.target.value)}
            placeholder="Vouchers"
            value={commitment}
          />
          <Button
            data-testid="back-proposal"
            disabled={!canBack}
            onClick={() => actions.back(proposal.id, commit)}
            size="sm"
          >
            Back this
          </Button>
          {commit === "" ? null : (
            <span
              className="text-xs tabular-nums text-black/60 dark:text-white/60"
              data-testid="commit-preview"
            >
              {reserve.toString()} to the reserve, {tokens.toString()} tokens
              escrowed
            </span>
          )}
        </div>
      )}

      {!hasPosition ? null : (
        <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-black/60 dark:text-white/60">
          <span data-testid="own-escrowed">
            Escrowed for you: {holding.escrowed}
          </span>
          {proposal.state === "verified" ? (
            <Button
              data-testid="claim-tokens"
              onClick={() => actions.claim(proposal.id)}
              size="sm"
              variant="outline"
            >
              Take your tokens
            </Button>
          ) : null}
          {proposal.state === "failed" ? (
            <Button
              data-testid="refund-position"
              onClick={() => actions.refund(proposal.id)}
              size="sm"
              variant="outline"
            >
              Take your money back
            </Button>
          ) : null}
        </div>
      )}

      {currentBlock !== null && missedMinimum(proposal, currentBlock) ? (
        <p className="text-xs text-black/60 dark:text-white/60">
          This did not reach its minimum in time. Everyone who backed it can
          take their money back.
        </p>
      ) : null}
      {currentBlock !== null && isResolvable(proposal, currentBlock) ? (
        <p className="text-xs text-black/60 dark:text-white/60">
          Ready to be judged against the check it was opened with.
        </p>
      ) : null}
    </li>
  );
}

/** Re-exported so callers can show the tax without importing the maths. */
export { backingTax };
