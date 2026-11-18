import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { DEFAULT_SHARES_PER_RAW_DOLLAR } from "../money/calls";
import { OwnershipLine } from "../money/MoneyTab";
import {
  anyRoundUnclosed,
  dollarsText,
  type ProjectNumbers,
} from "../money/numbers";
import { describeProposal, type Proposal } from "./pair";
import { SendButton, SendSheet } from "./SendSheet";
import {
  LAUNCHER_READS,
  openAuctionData,
  openRoundData,
  pairCancelCall,
  pairConfirmCall,
  pairProposeCall,
} from "./team-calls";
import { type PairState, signsFor, usePairWaiting } from "./use-team";

/**
 * Team on the Money tab: who the two signers are, the calls waiting for the second signature (Confirm for the other
 * signer, Withdraw for the one who asked), and the raises that need both of them (a backing round up to 50,000 dollars,
 * then the auction). Shown only to the Pair's signers; everyone else sees the stage line and the numbers.
 */
export function PairCard({
  numbers,
  pair,
  me,
  nameOf,
}: {
  numbers: ProjectNumbers;
  pair: PairState;
  me: string;
  nameOf: (address: string) => string;
}) {
  const titleId = useId();
  const waiting = usePairWaiting(numbers, pair);
  const [sheet, setSheet] = useState<string | null>(null);
  const other = pair.first === me ? pair.second : pair.first;
  const treasury = numbers.contracts.treasury;
  const list = waiting.data?.waiting ?? [];
  const asked = (selector: string) =>
    list.some((p) => p.data.startsWith(selector));
  const roundData = openRoundData(numbers.key, DEFAULT_SHARES_PER_RAW_DOLLAR);
  const canRaise =
    !anyRoundUnclosed(numbers) &&
    numbers.raised.left > 0n &&
    !numbers.market.sale &&
    !asked(roundData.slice(0, 10));
  const canAuction =
    !anyRoundUnclosed(numbers) &&
    !numbers.market.sale &&
    !numbers.clock.woundDown;
  if (!signsFor(pair, me) || !treasury) return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="pair-card"
      role="region"
    >
      <div>
        <h2 className="headline text-xl" id={titleId}>
          Run by two
        </h2>
        <p className="mt-1 text-sm text-muted">
          You and {nameOf(other)} sign for this project. Either of you can check
          in and spend up to 500 dollars in any 7 days alone; everything else
          needs both of you.
        </p>
      </div>

      <div data-testid="pair-waiting">
        <h3 className="font-semibold">Waiting for both</h3>
        {waiting.isPending && waiting.fetchStatus !== "idle" ? (
          <p className="text-sm text-muted">Looking on the network…</p>
        ) : waiting.isError ? (
          <p className="text-sm text-muted">
            The waiting calls could not be read from your wallet's network.
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">
            {waiting.data?.complete === false
              ? "Nothing waiting in the last week of blocks."
              : "Nothing is waiting."}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {list.map((proposal) => (
              <WaitingCall
                key={proposal.id}
                me={me}
                nameOf={nameOf}
                numbers={numbers}
                pair={pair}
                proposal={proposal}
              />
            ))}
          </ul>
        )}
      </div>

      {canRaise ? (
        <div className="flex flex-col gap-2" data-testid="pair-round">
          <p className="text-sm">
            Open a backing round: 24 hours, 1 dollar buys 3,000 Shares, up to{" "}
            {dollarsText(numbers.raised.left)} dollars (what is left under the
            50,000 limit for a project run by two). It opens when{" "}
            {nameOf(other)} confirms.
          </p>
          <SendButton
            action={`pair-round:${numbers.chainId}:${pair.address}`}
            block
            build={() => [
              pairProposeCall(pair.address, numbers.launcher, roundData),
            ]}
            chainId={numbers.chainId}
            copy="open-round"
            done={`Asked. The round opens when ${nameOf(other)} confirms.`}
            label="Open backing"
            testId="pair-open-round"
            variant="secondary"
          />
        </div>
      ) : null}
      {canAuction ? (
        <Button
          block
          data-testid="pair-open-auction"
          onClick={() => setSheet("auction")}
          variant="secondary"
        >
          Open the auction
        </Button>
      ) : null}

      <AuctionSheet
        canAuction={canAuction}
        nameOf={nameOf}
        numbers={numbers}
        open={sheet === "auction"}
        other={other}
        pair={pair}
        setOpen={(open) => setSheet(open ? "auction" : null)}
      />
    </Card>
  );
}

function AuctionSheet({
  numbers,
  pair,
  other,
  nameOf,
  open,
  setOpen,
  canAuction,
}: {
  numbers: ProjectNumbers;
  pair: PairState;
  other: string;
  nameOf: (address: string) => string;
  open: boolean;
  setOpen: (open: boolean) => void;
  canAuction: boolean;
}) {
  return (
    <SendSheet
      action={`pair-auction:${numbers.chainId}:${pair.address}`}
      build={async (wallet) => {
        // The lowest starting price, read from the Launcher: exactly the sale of a project that does not choose one.
        const answer = (
          await wallet.readCall(numbers.launcher, LAUNCHER_READS.salePrices())
        ).replace(/^0x/, "");
        if (!/^[0-9a-fA-F]{64}/.test(answer))
          throw new Error("The starting price could not be read.");
        const start = BigInt(`0x${answer.slice(0, 64)}`);
        return [
          pairProposeCall(
            pair.address,
            numbers.launcher,
            openAuctionData(numbers.key, start),
          ),
        ];
      }}
      chainId={numbers.chainId}
      confirmLabel="Ask to open it"
      copy="open-auction"
      disabled={!canAuction}
      done={`Asked. The auction opens when ${nameOf(other)} confirms.`}
      onOpenChange={setOpen}
      open={open}
      testId="pair-auction-sheet"
      title="Open the auction?"
    >
      <ul className="flex list-disc flex-col gap-1.5 pl-5">
        <li>
          250,000,000 Shares are offered for about a day, starting at 0.0004
          dollars a Share. Nobody can bid more than 4 times that.
        </li>
        <li>
          It must take at least 100,000 dollars in bids, or it refunds every bid
          in full by itself.
        </li>
        <li>
          If it does, a market opens: 22 of each 100 raised go into a pool for
          good, 15 to the project at once and 60 into the floor over 12 months.
          Held Shares start their 365-day release.
        </li>
        <li>No backing round can open while it runs.</li>
      </ul>
      <OwnershipLine />
    </SendSheet>
  );
}

function WaitingCall({
  numbers,
  pair,
  proposal,
  me,
  nameOf,
}: {
  numbers: ProjectNumbers;
  pair: PairState;
  proposal: Proposal;
  me: string;
  nameOf: (address: string) => string;
}) {
  const mine = proposal.by === me;
  const described = describeProposal(proposal.data, nameOf);
  // A call the app cannot name is never confirmed from here: only withdrawn by whoever asked.
  const known = described.kind !== "other";
  return (
    <li
      className="flex items-center justify-between gap-3 rounded-xl bg-white/6 px-3 py-2"
      data-testid="pair-waiting-call"
    >
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{described.words}</p>
        <p className="text-xs text-muted">
          {mine
            ? "You asked. It runs when your co-signer confirms."
            : `${nameOf(proposal.by)} asked. It runs when you confirm.`}
        </p>
      </div>
      {mine ? (
        <SendButton
          action={`pair-cancel:${numbers.chainId}:${pair.address}:${proposal.id}`}
          build={() => [pairCancelCall(pair.address, proposal.id)]}
          chainId={numbers.chainId}
          copy="withdraw"
          done="Withdrawn."
          label="Withdraw"
          testId="pair-withdraw"
          variant="ghost"
        />
      ) : known ? (
        <SendButton
          action={`pair-confirm:${numbers.chainId}:${pair.address}:${proposal.id}`}
          build={() => [
            pairConfirmCall(
              pair.address,
              proposal.target,
              proposal.data,
              proposal.nonce,
            ),
          ]}
          chainId={numbers.chainId}
          copy="confirm"
          done="Confirmed. It ran."
          label="Confirm"
          testId="pair-confirm"
        />
      ) : null}
    </li>
  );
}
